#!/usr/bin/env bash
# restore-rehearsal.sh — Weekly DR restore rehearsal for Open Brain.
#
# Locates the most recent daily backup, spins up an ephemeral pgvector/pgvector:pg16
# container, runs pg_restore, validates row counts against manifest.json, tears down,
# and sends a Pushover notification (pass = normal priority, fail = high priority).
#
# Usage:
#   bash scripts/restore-rehearsal.sh
#
# Env overrides (test-harness friendly — same pattern as backup.sh):
#   BACKUP_ROOT          default: /mnt/user/backup/openbrain
#   REHEARSAL_CONTAINER  default: open-brain-rehearsal-pg
#   PUSHOVER_API_URL     default: https://api.pushover.net/1/messages.json (mock-able)
#   ROW_COUNT_TOLERANCE  default: 0.10  (±10%)
#   REHEARSAL_DRY_RUN    set to "true" to skip all Docker calls (bash-logic test only)
#
# Exit codes:
#   0 — restore successful, all row counts within tolerance
#   1 — restore failed (pg_restore error OR row count validation failure)
#   2 — precondition failure (no backup, manifest missing, container start failed)
#
# Cron: 30 5 * * 0  (Sunday 05:30 — staggered after wiki-lint at 0 5 * * 0)
# Log:  /var/log/open-brain-restore-rehearsal.log

set -uo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
BACKUP_ROOT="${BACKUP_ROOT:-/mnt/user/backup/openbrain}"
REHEARSAL_CONTAINER="${REHEARSAL_CONTAINER:-open-brain-rehearsal-pg}"
ROW_COUNT_TOLERANCE="${ROW_COUNT_TOLERANCE:-0.10}"
REHEARSAL_DRY_RUN="${REHEARSAL_DRY_RUN:-false}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/pushover-notify.sh
source "${SCRIPT_DIR}/lib/pushover-notify.sh"

TIMESTAMP=$(date +%Y-%m-%dT%H:%M:%S%z)
echo "=== Open Brain DR Restore Rehearsal: ${TIMESTAMP} ==="

# ---------------------------------------------------------------------------
# Helper: emit result and send Pushover, then exit with given code.
# Usage: finish <exit_code> <status_word> <message>
# ---------------------------------------------------------------------------
finish() {
  local code="$1"
  local status="$2"
  local msg="$3"
  echo ""
  if [[ "$code" -eq 0 ]]; then
    echo "=== REHEARSAL RESULT: PASS ==="
  else
    echo "=== REHEARSAL RESULT: FAIL (exit ${code}) ===" >&2
  fi
  echo "  ${msg}"
  echo "  Timestamp: ${TIMESTAMP}"
  notify_pushover_rehearsal "${status}" "${msg}" || true
  exit "$code"
}

# ---------------------------------------------------------------------------
# Helper: tear down ephemeral container (idempotent — ignores errors)
# ---------------------------------------------------------------------------
teardown_container() {
  if [[ "${REHEARSAL_DRY_RUN}" == "true" ]]; then
    echo "[teardown] DRY_RUN — skipping docker stop"
    return 0
  fi
  echo "[teardown] Stopping and removing ephemeral container..."
  docker stop "${REHEARSAL_CONTAINER}" >/dev/null 2>&1 || true
}

# ---------------------------------------------------------------------------
# Precondition 1: locate backup directory via "latest" symlink
# ---------------------------------------------------------------------------
LATEST_LINK="${BACKUP_ROOT}/latest"

# In both real and dry-run mode, resolve the backup dir the same way.
# Dry-run only short-circuits Docker operations (steps 4-6); precondition
# checks and manifest parsing still run against the real fixture.
if [[ ! -L "${LATEST_LINK}" && ! -d "${LATEST_LINK}" ]]; then
  finish 2 "fail" "Precondition failed: ${LATEST_LINK} does not exist. Has backup.sh run at least once?"
fi

BACKUP_DIR="$(realpath "${LATEST_LINK}" 2>/dev/null || readlink -f "${LATEST_LINK}")"

if [[ ! -d "${BACKUP_DIR}" ]]; then
  finish 2 "fail" "Precondition failed: backup dir ${BACKUP_DIR} resolved from symlink does not exist."
fi

if [[ "${REHEARSAL_DRY_RUN}" == "true" ]]; then
  echo "[1/7] DRY_RUN — backup dir: ${BACKUP_DIR}"
else
  echo "[1/7] Backup dir: ${BACKUP_DIR}"
fi

# ---------------------------------------------------------------------------
# Precondition 2: verify dump file
# ---------------------------------------------------------------------------
DUMP_FILE="${BACKUP_DIR}/openbrain.pgdump"
if [[ ! -f "${DUMP_FILE}" ]]; then
  finish 2 "fail" "Precondition failed: dump file not found at ${DUMP_FILE}"
fi
DUMP_SIZE=$(du -h "${DUMP_FILE}" | cut -f1)
echo "[2/7] Dump file: ${DUMP_FILE} (${DUMP_SIZE})"

# ---------------------------------------------------------------------------
# Precondition 3: read manifest.json and extract table counts
# ---------------------------------------------------------------------------
MANIFEST_FILE="${BACKUP_DIR}/manifest.json"
if [[ ! -f "${MANIFEST_FILE}" ]]; then
  finish 2 "fail" "Precondition failed: manifest.json not found at ${MANIFEST_FILE}"
fi

# Parse the "tables" object from manifest.json.
# Prefer jq (canonical), fall back to python3.
# tr -d '\r' normalizes CRLF line endings (manifest.json is produced on Linux
# homeserver but test fixtures may be created on Windows).
if command -v jq >/dev/null 2>&1; then
  # Emit "table_name COUNT" lines.
  MANIFEST_TABLE_LINES=$(jq -r '.tables | to_entries[] | "\(.key) \(.value)"' "${MANIFEST_FILE}" 2>/dev/null | tr -d '\r')
else
  MANIFEST_TABLE_LINES=$(python3 -c '
import json, sys
data = json.load(open(sys.argv[1]))
tables = data.get("tables", {})
for k, v in tables.items():
    print(f"{k} {v}")
' "${MANIFEST_FILE}" 2>/dev/null | tr -d '\r')
fi

if [[ -z "${MANIFEST_TABLE_LINES}" ]]; then
  finish 2 "fail" "Precondition failed: could not parse tables from ${MANIFEST_FILE}. Is jq or python3 available?"
fi

TABLE_COUNT=$(echo "${MANIFEST_TABLE_LINES}" | wc -l | tr -d ' ')
echo "[3/7] Manifest: ${TABLE_COUNT} tables parsed from ${MANIFEST_FILE}"

# ---------------------------------------------------------------------------
# Step 4: spin up ephemeral pgvector container
# ---------------------------------------------------------------------------
echo "[4/7] Starting ephemeral pgvector container (${REHEARSAL_CONTAINER})..."

if [[ "${REHEARSAL_DRY_RUN}" == "true" ]]; then
  echo "  DRY_RUN — skipping docker run"
else
  # Remove stale container if it somehow survived a prior interrupted run.
  docker rm -f "${REHEARSAL_CONTAINER}" >/dev/null 2>&1 || true

  if ! docker run --rm -d \
      --name "${REHEARSAL_CONTAINER}" \
      -e POSTGRES_PASSWORD=rehearsal \
      -e POSTGRES_USER=openbrain \
      -e POSTGRES_DB=openbrain \
      pgvector/pgvector:pg16 >/dev/null; then
    finish 2 "fail" "Container start failed: could not start ${REHEARSAL_CONTAINER}. Is Docker daemon running?"
  fi

  # Register teardown on exit so it always fires even on error.
  trap teardown_container EXIT

  # Poll pg_isready (max 30s)
  echo "  Waiting for Postgres to be ready..."
  READY=0
  for i in $(seq 1 30); do
    if docker exec "${REHEARSAL_CONTAINER}" pg_isready -U openbrain -d openbrain -q 2>/dev/null; then
      READY=1
      echo "  Ready after ${i}s"
      break
    fi
    sleep 1
  done

  if [[ "${READY}" -eq 0 ]]; then
    finish 2 "fail" "Container did not become ready within 30s. Check Docker logs: docker logs ${REHEARSAL_CONTAINER}"
  fi

  # Install pgvector extension (required for vector columns in pg_restore).
  echo "  Installing pgvector extension..."
  if ! docker exec "${REHEARSAL_CONTAINER}" psql -U openbrain -d openbrain -q \
      -c "CREATE EXTENSION IF NOT EXISTS vector;" 2>&1; then
    finish 2 "fail" "Failed to install pgvector extension. Is the pgvector/pgvector:pg16 image being used?"
  fi
fi

# ---------------------------------------------------------------------------
# Step 5: copy dump into container and run pg_restore
# ---------------------------------------------------------------------------
echo "[5/7] Running pg_restore..."

if [[ "${REHEARSAL_DRY_RUN}" == "true" ]]; then
  echo "  DRY_RUN — skipping docker cp + pg_restore"
  RESTORE_EXIT=0
else
  # Copy dump into container.
  if ! docker cp "${DUMP_FILE}" "${REHEARSAL_CONTAINER}:/tmp/restore.pgdump" 2>&1; then
    finish 1 "fail" "pg_restore failed: could not docker cp dump file into container."
  fi

  # Run pg_restore. --exit-on-error surfaces schema drift that would otherwise
  # silently produce exit 0 with missing objects.
  RESTORE_OUTPUT=$(docker exec "${REHEARSAL_CONTAINER}" pg_restore \
    -U openbrain \
    -d openbrain \
    --no-owner \
    --no-privileges \
    --exit-on-error \
    /tmp/restore.pgdump 2>&1) || RESTORE_EXIT=$?

  RESTORE_EXIT="${RESTORE_EXIT:-0}"

  if [[ "${RESTORE_EXIT}" -ne 0 ]]; then
    echo "  pg_restore output:" >&2
    echo "${RESTORE_OUTPUT}" | head -50 | sed 's/^/    /' >&2
    finish 1 "fail" "pg_restore exited ${RESTORE_EXIT}. Check log for schema errors."
  fi

  echo "  pg_restore completed successfully."
fi

# ---------------------------------------------------------------------------
# Step 6: validate row counts against manifest
# ---------------------------------------------------------------------------
echo "[6/7] Validating row counts (tolerance: ±$(echo "${ROW_COUNT_TOLERANCE} * 100" | awk '{printf "%.0f", $1}')%)..."

FAIL_COUNT=0
PASS_COUNT=0
SKIP_COUNT=0
VALIDATION_DETAIL=""

while IFS=' ' read -r table manifest_count; do
  # Strip carriage returns (Windows-created manifest.json may have CRLF).
  table="${table%$'\r'}"
  manifest_count="${manifest_count%$'\r'}"
  [[ -z "$table" ]] && continue

  # Tables with 0 rows in manifest are skipped — nothing to validate (system tables
  # may be 0 rows; we only care about data presence when manifest says there should be data).
  if [[ "${manifest_count}" -eq 0 ]]; then
    SKIP_COUNT=$((SKIP_COUNT + 1))
    continue
  fi

  if [[ "${REHEARSAL_DRY_RUN}" == "true" ]]; then
    # In dry-run, the caller injects REHEARSAL_DRY_RUN_COUNTS as "table:count table:count ..."
    # For pure bash-logic tests, default to matching manifest count exactly.
    actual_count="${manifest_count}"
    # Allow override via DRY_RUN_COUNTS associative-array style env var
    override_var="REHEARSAL_DRY_COUNT_${table}"
    if [[ -n "${!override_var:-}" ]]; then
      actual_count="${!override_var}"
    fi
  else
    actual_count=$(docker exec "${REHEARSAL_CONTAINER}" psql \
      -U openbrain -d openbrain -t -A \
      -c "SELECT COUNT(*) FROM \"${table}\";" 2>/dev/null || echo "0")
    actual_count="${actual_count:-0}"
  fi

  # Compute tolerance bounds using awk (bash can't do float arithmetic).
  lower=$(awk -v n="${manifest_count}" -v t="${ROW_COUNT_TOLERANCE}" 'BEGIN { printf "%d", n * (1 - t) }')
  upper=$(awk -v n="${manifest_count}" -v t="${ROW_COUNT_TOLERANCE}" 'BEGIN { printf "%d", n * (1 + t) }')

  if [[ "${actual_count}" -ge "${lower}" && "${actual_count}" -le "${upper}" ]]; then
    PASS_COUNT=$((PASS_COUNT + 1))
    VALIDATION_DETAIL="${VALIDATION_DETAIL}  PASS  ${table}: actual=${actual_count} manifest=${manifest_count}\n"
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    if [[ "${actual_count}" -eq 0 && "${manifest_count}" -gt 0 ]]; then
      VALIDATION_DETAIL="${VALIDATION_DETAIL}  FAIL  ${table}: actual=0 manifest=${manifest_count} (BLANK RESTORE — catastrophic)\n"
    else
      VALIDATION_DETAIL="${VALIDATION_DETAIL}  FAIL  ${table}: actual=${actual_count} manifest=${manifest_count} (outside ±${ROW_COUNT_TOLERANCE})\n"
    fi
  fi
done <<< "${MANIFEST_TABLE_LINES}"

echo ""
printf "%b" "${VALIDATION_DETAIL}"
echo ""
echo "  Tables: ${PASS_COUNT} passed, ${FAIL_COUNT} failed, ${SKIP_COUNT} skipped (0-row manifest)"

# ---------------------------------------------------------------------------
# Step 7: tear down + final result
# ---------------------------------------------------------------------------
echo "[7/7] Tearing down ephemeral container..."
if [[ "${REHEARSAL_DRY_RUN}" != "true" ]]; then
  teardown_container
  # Disable the EXIT trap (already done manually).
  trap - EXIT
fi

CHECKED=$((PASS_COUNT + FAIL_COUNT))
if [[ "${FAIL_COUNT}" -gt 0 ]]; then
  finish 1 "fail" "DR rehearsal FAILED: ${FAIL_COUNT}/${CHECKED} table(s) out of tolerance. See log for details."
else
  finish 0 "pass" "DR rehearsal PASSED: ${PASS_COUNT}/${CHECKED} table(s) within ±$(echo "${ROW_COUNT_TOLERANCE} * 100" | awk '{printf "%.0f", $1}')% tolerance. ${SKIP_COUNT} skipped."
fi
