#!/usr/bin/env bash
# restore-rehearsal.sh — Weekly DR restore rehearsal for Open Brain.
#
# Locates the most recent daily backup, FAILS if it is stale, spins up an ephemeral
# pgvector/pgvector:pg16 container running the production postgresql.conf (default 64 MB
# /dev/shm), restores through restore_into (scripts/lib/restore-core.sh), then asserts
# against manifest.json: row counts (max(1%, 20 rows) per table), object counts
# (indexes / foreign keys / triggers / functions, from manifest key `objects`), no invalid
# index, the required-object list (scripts/lib/dr-required-objects.txt), and the ledger
# maximum. Tears down and sends a Pushover notification (pass = normal, fail = high).
#
# Usage:
#   bash scripts/restore-rehearsal.sh
#
# Env overrides (test-harness friendly — same pattern as backup.sh):
#   BACKUP_ROOT          default: /mnt/user/backup/openbrain
#   REHEARSAL_CONTAINER  default: open-brain-rehearsal-pg (must contain "rehearsal", else exit 2)
#   PUSHOVER_API_URL     default: https://api.pushover.net/1/messages.json (mock-able)
#   ROW_COUNT_TOLERANCE  default: 0.01  (1% of the manifest count ...)
#   ROW_COUNT_MIN_ABS    default: 20    (... or this many rows, whichever is larger)
#   REHEARSAL_MAX_AGE_HOURS  default: 36 (dump + manifest.timestamp older than this = FAIL)
#   REHEARSAL_PG_CONF    default: <repo>/config/postgres/postgresql.conf (mounted into the container)
#   REHEARSAL_DRY_RUN    set to "true" to skip all Docker calls (bash-logic test only).
#                        Dry-run test hooks: REHEARSAL_DRY_COUNT_<table>, REHEARSAL_DRY_OBJECTS
#                        (JSON like manifest `objects`), REHEARSAL_DRY_MISSING ("name name"),
#                        REHEARSAL_DRY_INVALID_INDEXES.
#
# Exit codes:
#   0 — restore successful, every assertion held
#   1 — stale backup, restore failed, or an assertion failed (rows, objects, ledger)
#   2 — precondition failure (no backup, manifest missing, container start failed)
#
# Cron: 30 5 * * 0  (Sunday 05:30 — staggered after wiki-lint at 0 5 * * 0)
# Log:  /var/log/open-brain-restore-rehearsal.log
# On PASS the current timestamp is written to ${BACKUP_ROOT}/.rehearsal-last-success (read by 7.3).

set -uo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
BACKUP_ROOT="${BACKUP_ROOT:-/mnt/user/backup/openbrain}"
REHEARSAL_CONTAINER="${REHEARSAL_CONTAINER:-open-brain-rehearsal-pg}"
ROW_COUNT_TOLERANCE="${ROW_COUNT_TOLERANCE:-0.01}"
ROW_COUNT_MIN_ABS="${ROW_COUNT_MIN_ABS:-20}"
REHEARSAL_MAX_AGE_HOURS="${REHEARSAL_MAX_AGE_HOURS:-36}"
REHEARSAL_DRY_RUN="${REHEARSAL_DRY_RUN:-false}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REHEARSAL_PG_CONF="${REHEARSAL_PG_CONF:-${SCRIPT_DIR}/../config/postgres/postgresql.conf}"
REQUIRED_OBJECTS_FILE="${REQUIRED_OBJECTS_FILE:-${SCRIPT_DIR}/lib/dr-required-objects.txt}"
# shellcheck source=lib/pushover-notify.sh
source "${SCRIPT_DIR}/lib/pushover-notify.sh"
# shellcheck source=lib/restore-core.sh
source "${SCRIPT_DIR}/lib/restore-core.sh"
# shellcheck source=lib/db-objects.sh
source "${SCRIPT_DIR}/lib/db-objects.sh"

TIMESTAMP=$(date +%Y-%m-%dT%H:%M:%S%z)
echo "=== Open Brain DR Restore Rehearsal: ${TIMESTAMP} ==="

# The script runs `docker rm -f "${REHEARSAL_CONTAINER}"`: a name without "rehearsal"
# (open-brain-postgres, say) is refused before any docker call.
if [[ "${REHEARSAL_CONTAINER}" != *rehearsal* ]]; then
  echo "=== REHEARSAL RESULT: FAIL (exit 2) ===" >&2
  echo "  REFUSED: REHEARSAL_CONTAINER='${REHEARSAL_CONTAINER}' does not contain 'rehearsal'." >&2
  echo "  The rehearsal force-removes that container; it must never name a production one." >&2
  notify_pushover_rehearsal "fail" "DR rehearsal refused: REHEARSAL_CONTAINER '${REHEARSAL_CONTAINER}' lacks 'rehearsal'" || true
  exit 2
fi

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
  # --rm removes the container asynchronously after the stop; wait so a follow-up run
  # with the same name never races the removal.
  local _i
  for _i in 1 2 3 4 5 6 7 8 9 10; do
    docker inspect "${REHEARSAL_CONTAINER}" >/dev/null 2>&1 || return 0
    sleep 1
  done
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
# Step 3b: freshness. A rehearsal of a stale dump proves nothing (it passed against a
# 76-day-old dump). manifest.timestamp AND the dump's mtime must both be younger than
# REHEARSAL_MAX_AGE_HOURS; an unparseable timestamp cannot be proven fresh = FAIL.
# ---------------------------------------------------------------------------
if ! command -v jq >/dev/null 2>&1; then
  finish 2 "fail" "Precondition failed: jq is required for the freshness and object assertions."
fi
jget() { # jget <jq-filter> <file>  -> value or empty
  jq -r "$1 // empty" "$2" 2>/dev/null | tr -d '\r'
}

NOW_EPOCH=$(date +%s)
MAX_AGE_SECS=$((REHEARSAL_MAX_AGE_HOURS * 3600))
MANIFEST_TS="$(jget '.timestamp' "${MANIFEST_FILE}")"
MANIFEST_EPOCH=""
[[ -n "${MANIFEST_TS}" ]] && MANIFEST_EPOCH=$(date -d "${MANIFEST_TS}" +%s 2>/dev/null || true)
DUMP_EPOCH=$(stat -c %Y "${DUMP_FILE}" 2>/dev/null || echo "")

if [[ ! "${MANIFEST_EPOCH}" =~ ^[0-9]+$ ]]; then
  finish 1 "fail" "Backup is not provably fresh: manifest.timestamp '${MANIFEST_TS}' is missing or unparseable."
fi
if [[ ! "${DUMP_EPOCH}" =~ ^[0-9]+$ ]]; then
  finish 1 "fail" "Backup is not provably fresh: cannot read the modification time of ${DUMP_FILE}."
fi
MANIFEST_AGE_H=$(( (NOW_EPOCH - MANIFEST_EPOCH) / 3600 ))
DUMP_AGE_H=$(( (NOW_EPOCH - DUMP_EPOCH) / 3600 ))
if (( NOW_EPOCH - MANIFEST_EPOCH > MAX_AGE_SECS )); then
  finish 1 "fail" "STALE BACKUP: manifest.timestamp ${MANIFEST_TS} is ${MANIFEST_AGE_H}h old (limit ${REHEARSAL_MAX_AGE_HOURS}h). Has backup.sh run?"
fi
if (( NOW_EPOCH - DUMP_EPOCH > MAX_AGE_SECS )); then
  finish 1 "fail" "STALE BACKUP: ${DUMP_FILE} is ${DUMP_AGE_H}h old (limit ${REHEARSAL_MAX_AGE_HOURS}h). Has backup.sh run?"
fi
echo "[3/7] Fresh: manifest ${MANIFEST_AGE_H}h old, dump ${DUMP_AGE_H}h old (limit ${REHEARSAL_MAX_AGE_HOURS}h)"

MANIFEST_HAS_OBJECTS="false"
if [[ -n "$(jget '.objects.indexes' "${MANIFEST_FILE}")" ]]; then
  MANIFEST_HAS_OBJECTS="true"
else
  echo "  WARNING: manifest has no 'objects' key (backup predates item 6.4) — object-count assertions SKIPPED." >&2
fi

# ---------------------------------------------------------------------------
# Step 4: spin up ephemeral pgvector container with the PRODUCTION postgresql.conf
# and Docker's default 64 MB /dev/shm (no --shm-size): a correct restore must not
# depend on a bigger /dev/shm than the real container has.
# ---------------------------------------------------------------------------
echo "[4/7] Starting ephemeral pgvector container (${REHEARSAL_CONTAINER})..."

if [[ "${REHEARSAL_DRY_RUN}" == "true" ]]; then
  echo "  DRY_RUN — skipping docker run"
else
  if [[ ! -f "${REHEARSAL_PG_CONF}" ]]; then
    finish 2 "fail" "Precondition failed: postgresql.conf not found at ${REHEARSAL_PG_CONF}"
  fi
  # Remove stale container if it somehow survived a prior interrupted run.
  docker rm -f "${REHEARSAL_CONTAINER}" >/dev/null 2>&1 || true

  if ! docker run --rm -d \
      --name "${REHEARSAL_CONTAINER}" \
      -e POSTGRES_PASSWORD=rehearsal \
      -e POSTGRES_USER=openbrain \
      -e POSTGRES_DB=openbrain \
      -v "${REHEARSAL_PG_CONF}:/etc/postgresql/postgresql.conf:ro" \
      pgvector/pgvector:pg16 postgres -c config_file=/etc/postgresql/postgresql.conf >/dev/null; then
    finish 2 "fail" "Container start failed: could not start ${REHEARSAL_CONTAINER}. Is Docker daemon running?"
  fi

  # Register teardown on exit so it always fires even on error.
  trap teardown_container EXIT
fi

# ---------------------------------------------------------------------------
# Step 5: restore through restore_into (waits for TCP readiness, refuses a non-empty
# database, CREATE EXTENSION vector, pg_restore --exit-on-error, 0 maintenance workers)
# ---------------------------------------------------------------------------
echo "[5/7] Restoring via restore_into..."

if [[ "${REHEARSAL_DRY_RUN}" == "true" ]]; then
  echo "  DRY_RUN — skipping restore_into"
else
  RESTORE_RC=0
  restore_into "${REHEARSAL_CONTAINER}" "${DUMP_FILE}" || RESTORE_RC=$?
  if [[ "${RESTORE_RC}" -eq 2 ]]; then
    finish 2 "fail" "Container not usable: restore_into could not reach ${REHEARSAL_CONTAINER} over TCP (rc 2)."
  elif [[ "${RESTORE_RC}" -ne 0 ]]; then
    finish 1 "fail" "Restore failed: restore_into exited ${RESTORE_RC}. Check log for pg_restore errors."
  fi
  echo "  restore_into completed successfully."
fi

# ---------------------------------------------------------------------------
# Step 6: assertions. Every failure is accumulated and reported; a failed query is a
# failure (never "0 rows").
# ---------------------------------------------------------------------------
FAIL_COUNT=0
PASS_COUNT=0
DETAIL=""
add_fail() { FAIL_COUNT=$((FAIL_COUNT + 1)); DETAIL="${DETAIL}  FAIL  $1\n"; }
add_pass() { DETAIL="${DETAIL}  PASS  $1\n"; }

# --- 6a. row counts: |actual-manifest| <= max(1%, 20 rows), 0-row tables included -----
echo "[6/7] Validating row counts (tolerance: max(${ROW_COUNT_TOLERANCE} x rows, ${ROW_COUNT_MIN_ABS} rows))..."

while IFS=' ' read -r table manifest_count; do
  table="${table%$'\r'}"
  manifest_count="${manifest_count%$'\r'}"
  [[ -z "$table" ]] && continue
  if [[ ! "${manifest_count}" =~ ^[0-9]+$ ]]; then
    add_fail "${table}: manifest count '${manifest_count}' is not a number"
    continue
  fi

  if [[ "${REHEARSAL_DRY_RUN}" == "true" ]]; then
    actual_count="${manifest_count}"
    override_var="REHEARSAL_DRY_COUNT_${table}"
    if [[ -n "${!override_var:-}" ]]; then
      actual_count="${!override_var}"
    fi
  else
    if ! actual_count=$(docker exec "${REHEARSAL_CONTAINER}" psql -X -v ON_ERROR_STOP=1 \
        -U openbrain -d openbrain -tAq -c "SELECT COUNT(*) FROM public.\"${table}\";" 2>&1) \
        || [[ ! "${actual_count}" =~ ^[0-9]+$ ]]; then
      add_fail "${table}: count query FAILED (${actual_count:0:120})"
      continue
    fi
  fi

  allowed=$(awk -v n="${manifest_count}" -v t="${ROW_COUNT_TOLERANCE}" -v a="${ROW_COUNT_MIN_ABS}" \
    'BEGIN { x = n * t; if (x < a) x = a; printf "%d", x }')
  diff=$(( actual_count > manifest_count ? actual_count - manifest_count : manifest_count - actual_count ))

  if (( diff <= allowed )); then
    PASS_COUNT=$((PASS_COUNT + 1))
    add_pass "${table}: actual=${actual_count} manifest=${manifest_count}"
  elif [[ "${actual_count}" -eq 0 && "${manifest_count}" -gt 0 ]]; then
    add_fail "${table}: actual=0 manifest=${manifest_count} (BLANK RESTORE — catastrophic)"
  else
    add_fail "${table}: actual=${actual_count} manifest=${manifest_count} (diff ${diff} > allowed ${allowed})"
  fi
done <<< "${MANIFEST_TABLE_LINES}"
TABLES_FAILED_ROWS=${FAIL_COUNT}

# --- 6b. object counts vs manifest `objects`, ledger, invalid indexes, required objects ---
echo "  Validating objects (counts, ledger, validity, required list)..."

if [[ "${REHEARSAL_DRY_RUN}" == "true" ]]; then
  if [[ -n "${REHEARSAL_DRY_OBJECTS:-}" ]]; then
    ACTUAL_OBJECTS="${REHEARSAL_DRY_OBJECTS}"
  elif [[ "${MANIFEST_HAS_OBJECTS}" == "true" ]]; then
    ACTUAL_OBJECTS="$(jq -c '.objects' "${MANIFEST_FILE}" 2>/dev/null || true)"
  else
    ACTUAL_OBJECTS='{"indexes":0,"foreign_keys":0,"triggers":0,"functions":0,"ledger_max":""}'
  fi
  INVALID_INDEXES="${REHEARSAL_DRY_INVALID_INDEXES:-0}"
else
  ACTUAL_OBJECTS="$(db_objects_json "${REHEARSAL_CONTAINER}" openbrain openbrain 2>/dev/null || true)"
  INVALID_INDEXES="$(docker exec "${REHEARSAL_CONTAINER}" psql -X -v ON_ERROR_STOP=1 -U openbrain -d openbrain \
    -tAq -c "SELECT count(*) FROM pg_index WHERE NOT indisvalid" 2>/dev/null || true)"
fi

OBJ_SUMMARY=""
if [[ -z "${ACTUAL_OBJECTS}" ]] || ! printf '%s' "${ACTUAL_OBJECTS}" | jq -e . >/dev/null 2>&1; then
  add_fail "object counts: query on the restored database FAILED"
else
  act() { printf '%s' "${ACTUAL_OBJECTS}" | jq -r ".$1 // empty"; }
  man() { jq -r ".objects.$1 // empty" "${MANIFEST_FILE}" | tr -d '\r'; }
  for pair in "indexes:indexes" "foreign_keys:fk" "triggers:triggers" "functions:functions"; do
    key="${pair%%:*}"; label="${pair##*:}"
    a="$(act "${key}")"
    if [[ "${MANIFEST_HAS_OBJECTS}" == "true" ]]; then
      m="$(man "${key}")"
      OBJ_SUMMARY="${OBJ_SUMMARY}${label} ${a}/${m} "
      if [[ "${a}" == "${m}" && -n "${a}" ]]; then
        add_pass "${label}: restored=${a} manifest=${m}"
      else
        add_fail "${label}: restored=${a:-?} manifest=${m:-?} (object count mismatch)"
      fi
    else
      OBJ_SUMMARY="${OBJ_SUMMARY}${label} ${a}/- "
    fi
  done
  a_ledger="$(act ledger_max)"
  if [[ "${MANIFEST_HAS_OBJECTS}" == "true" ]]; then
    m_ledger="$(man ledger_max)"
    OBJ_SUMMARY="${OBJ_SUMMARY}ledger ${a_ledger}"
    if [[ "${a_ledger}" == "${m_ledger}" ]]; then
      add_pass "ledger: restored=${a_ledger} manifest=${m_ledger}"
    else
      add_fail "ledger: restored max(version)='${a_ledger}' manifest='${m_ledger}'"
    fi
  else
    OBJ_SUMMARY="${OBJ_SUMMARY}ledger ${a_ledger}"
  fi
fi

if [[ "${INVALID_INDEXES}" == "0" ]]; then
  add_pass "no invalid index"
else
  add_fail "invalid indexes: '${INVALID_INDEXES:-query failed}' (pg_index.indisvalid = false)"
fi

if [[ ! -f "${REQUIRED_OBJECTS_FILE}" ]]; then
  add_fail "required-object list ${REQUIRED_OBJECTS_FILE} not found"
else
  while IFS= read -r name || [[ -n "${name}" ]]; do
    name="${name%$'\r'}"
    [[ -z "${name}" || "${name}" == \#* ]] && continue
    if [[ ! "${name}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
      add_fail "required object '${name}': invalid name in ${REQUIRED_OBJECTS_FILE}"
      continue
    fi
    if [[ "${REHEARSAL_DRY_RUN}" == "true" ]]; then
      if [[ " ${REHEARSAL_DRY_MISSING:-} " == *" ${name} "* ]]; then found="f"; else found="t"; fi
    else
      found="$(docker exec "${REHEARSAL_CONTAINER}" psql -X -v ON_ERROR_STOP=1 -U openbrain -d openbrain -tAq \
        -c "SELECT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND c.relname = '${name}')
            OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = '${name}')" 2>/dev/null || echo "error")"
    fi
    case "${found}" in
      t) add_pass "required object ${name} exists" ;;
      f) add_fail "required object ${name} is MISSING after restore" ;;
      *) add_fail "required object ${name}: existence query FAILED" ;;
    esac
  done < "${REQUIRED_OBJECTS_FILE}"
fi

echo ""
printf "%b" "${DETAIL}"
echo ""
echo "  Row-count failures: ${TABLES_FAILED_ROWS}; total failed assertions: ${FAIL_COUNT}; rows passed: ${PASS_COUNT} table(s)"

# ---------------------------------------------------------------------------
# Step 7: tear down + final result
# ---------------------------------------------------------------------------
echo "[7/7] Tearing down ephemeral container..."
if [[ "${REHEARSAL_DRY_RUN}" != "true" ]]; then
  teardown_container
  # Disable the EXIT trap (already done manually).
  trap - EXIT
fi

if [[ "${FAIL_COUNT}" -gt 0 ]]; then
  finish 1 "fail" "DR rehearsal FAILED: ${FAIL_COUNT} assertion(s) failed (${TABLES_FAILED_ROWS} row-count). See log for details."
else
  echo "  ${OBJ_SUMMARY}"
  if ! date -u +%Y-%m-%dT%H:%M:%SZ > "${BACKUP_ROOT}/.rehearsal-last-success" 2>/dev/null; then
    echo "  WARNING: could not write ${BACKUP_ROOT}/.rehearsal-last-success" >&2
  fi
  finish 0 "pass" "DR rehearsal PASSED: ${PASS_COUNT} table(s) within tolerance; ${OBJ_SUMMARY}"
fi
