#!/usr/bin/env bash
# restore.sh — restore an Open Brain backup into an EMPTY Postgres (real recovery, item 6.2).
#
# Usage:
#   bash scripts/restore.sh [--backup-dir <dir>] [--target <container>] [--apply-pending]
#
#   --backup-dir <dir>   backup directory holding openbrain.pgdump
#                        (default: /mnt/user/backup/openbrain/latest)
#   --target <container> Postgres container to restore into (default: open-brain-postgres)
#   --apply-pending      after the restore, apply migrations newer than the dump's ledger:
#                        runs scripts/migrate-manual.sh from a throwaway
#                        pgvector/pgvector:pg16 container on the stack network
#                        (RESTORE_NETWORK, default open-brain_open-brain), repo bind-mounted.
#   -h, --help           print this help
#
# The restore runs through restore_into (scripts/lib/restore-core.sh), the same function
# the weekly rehearsal uses: it refuses a target whose schema public holds any table, and
# runs pg_restore --exit-on-error with max_parallel_maintenance_workers=0, so indexes and
# constraints survive a container with a small /dev/shm. init-schema.sql is NOT applied
# first: the dump is a complete snapshot, schema_migrations ledger included.
#
# --apply-pending takes POSTGRES_URL from, in order: the environment; `docker exec
# open-brain-core-api printenv POSTGRES_URL`; the POSTGRES_URL line of the repo's
# .env.secrets (during a recovery core-api is not running yet). The URL is passed to the
# migrate container by name only (-e POSTGRES_URL) and never printed. With a --target
# other than open-brain-postgres, POSTGRES_URL must come from the environment: the two
# fallbacks name the production database.
#
# Env: RESTORE_DB_USER / RESTORE_DB_NAME (default openbrain), RESTORE_NETWORK,
#      RESTORE_MIGRATE_IMAGE (default pgvector/pgvector:pg16), POSTGRES_URL.
#
# Exit codes: 0 restored (and migrations applied, when asked); 1 restore or migration
# failed; 2 bad arguments or missing input; 3 target not empty (refused, nothing changed).
#
# Host constraints: bash, docker, jq optional; no psql on the host (SQL via docker exec).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
# shellcheck source=lib/restore-core.sh
source "${SCRIPT_DIR}/lib/restore-core.sh"

BACKUP_DIR="/mnt/user/backup/openbrain/latest"
TARGET="open-brain-postgres"
APPLY_PENDING=0
NETWORK="${RESTORE_NETWORK:-open-brain_open-brain}"
MIGRATE_IMAGE="${RESTORE_MIGRATE_IMAGE:-pgvector/pgvector:pg16}"

usage() { sed -n '2,35p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --backup-dir)    [[ -n "${2:-}" ]] || { echo "ERROR: --backup-dir needs a directory" >&2; exit 2; }
                     BACKUP_DIR="$2"; shift 2 ;;
    --target)        [[ -n "${2:-}" ]] || { echo "ERROR: --target needs a container name" >&2; exit 2; }
                     TARGET="$2"; shift 2 ;;
    --apply-pending) APPLY_PENDING=1; shift ;;
    -h|--help)       usage; exit 0 ;;
    *)               echo "ERROR: unknown argument: $1 (see --help)" >&2; exit 2 ;;
  esac
done

DUMP="${BACKUP_DIR%/}/openbrain.pgdump"
MANIFEST="${BACKUP_DIR%/}/manifest.json"
[[ -f "$DUMP" ]] || { echo "ERROR: no dump at ${DUMP}" >&2; exit 2; }
docker inspect "$TARGET" >/dev/null 2>&1 || { echo "ERROR: container ${TARGET} not found" >&2; exit 2; }

# Resolve the migration URL BEFORE restoring, so a missing URL never leaves a restored
# database with its migrations unapplied.
if [[ "$APPLY_PENDING" == 1 ]]; then
  if [[ -z "${POSTGRES_URL:-}" && "$TARGET" != "open-brain-postgres" ]]; then
    echo "ERROR: --apply-pending with --target ${TARGET} needs POSTGRES_URL in the environment" >&2
    echo "       (the fallbacks point at the production database)." >&2
    exit 2
  fi
  if [[ -z "${POSTGRES_URL:-}" ]]; then
    POSTGRES_URL="$(docker exec open-brain-core-api printenv POSTGRES_URL 2>/dev/null)" || POSTGRES_URL=""
  fi
  if [[ -z "${POSTGRES_URL:-}" && -r "${REPO}/.env.secrets" ]]; then
    POSTGRES_URL="$(sed -n 's/^POSTGRES_URL=//p' "${REPO}/.env.secrets" | tail -n 1)"
    POSTGRES_URL="${POSTGRES_URL%\"}"; POSTGRES_URL="${POSTGRES_URL#\"}"
    POSTGRES_URL="${POSTGRES_URL%\'}"; POSTGRES_URL="${POSTGRES_URL#\'}"
  fi
  if [[ -z "${POSTGRES_URL:-}" ]]; then
    echo "ERROR: no POSTGRES_URL (env, open-brain-core-api, or ${REPO}/.env.secrets)." >&2
    exit 2
  fi
fi

echo "=== Open Brain restore: $(date +%Y-%m-%dT%H:%M:%S%z) ==="
echo "  backup dir: ${BACKUP_DIR}"
echo "  dump:       ${DUMP} ($(du -h "$DUMP" | cut -f1), modified $(date -r "$DUMP" +%Y-%m-%dT%H:%M:%S%z))"
if [[ -f "$MANIFEST" ]] && command -v jq >/dev/null 2>&1; then
  echo "  manifest:   timestamp $(jq -r '.timestamp // "unknown"' "$MANIFEST"), $(jq -r '(.tables // {}) | length' "$MANIFEST") table(s)"
fi
echo "  target:     ${TARGET} (database ${RESTORE_DB_NAME:-openbrain})"

echo "[1/3] Restoring through restore_into..."
restore_into "$TARGET" "$DUMP"
rc=$?
case "$rc" in
  0) echo "  restore completed." ;;
  3) exit 3 ;;
  2) exit 2 ;;
  *) echo "ERROR: restore failed (restore_into returned ${rc})." >&2; exit 1 ;;
esac

if [[ "$APPLY_PENDING" == 1 ]]; then
  echo "[2/3] Applying pending migrations (throwaway ${MIGRATE_IMAGE} on ${NETWORK})..."
  export POSTGRES_URL
  if ! docker run --rm --network "$NETWORK" \
      -v "${REPO}:/app" -w /app \
      -e POSTGRES_URL \
      -e PGOPTIONS='-c max_parallel_maintenance_workers=0' \
      "$MIGRATE_IMAGE" bash scripts/migrate-manual.sh; then
    echo "ERROR: migrate-manual.sh failed; the restored data is intact, the failed migration rolled back." >&2
    exit 1
  fi
else
  echo "[2/3] Pending migrations not applied (pass --apply-pending to apply them)."
fi

echo "[3/3] Object counts in schema public:"
if counts="$(restore_object_counts "$TARGET")"; then
  echo "  ${counts}"
else
  echo "ERROR: could not read object counts from ${TARGET}" >&2
  exit 1
fi
if [[ -f "$MANIFEST" ]] && command -v jq >/dev/null 2>&1 && jq -e '.objects' "$MANIFEST" >/dev/null 2>&1; then
  echo "  manifest objects: $(jq -c '.objects' "$MANIFEST")"
fi
echo "=== restore done ==="
