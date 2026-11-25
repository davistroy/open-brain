#!/usr/bin/env bash
# restore.sh — restore an Open Brain backup into an EMPTY Postgres (real recovery, item 6.2).
#
# Usage:
#   bash scripts/restore.sh [--backup-dir <dir>] [--target <container>]
#                           [--apply-pending [--allow-ref <sha>]]
#
#   --backup-dir <dir>   backup directory holding openbrain.pgdump
#                        (default: /mnt/user/backup/openbrain/latest)
#   --target <container> Postgres container to restore into (default: open-brain-postgres)
#   --apply-pending      after the restore, apply migrations newer than the dump's ledger:
#                        runs scripts/migrate-manual.sh from a throwaway
#                        pgvector/pgvector:pg16 container on the stack network
#                        (RESTORE_NETWORK, default open-brain_open-brain), repo bind-mounted.
#                        The migrations come from THIS tree, so it refuses (exit 2, before
#                        anything is restored) unless the repo HEAD equals the `commit` of
#                        <backup-dir>/DEPLOYED.json: a tree at a newer main would apply
#                        migrations that were merged but never deployed.
#   --allow-ref <sha>    only when the backup has no DEPLOYED.json: the commit you know was
#                        deployed; the repo HEAD must equal it. Ignored when DEPLOYED.json exists.
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
# fallbacks name the production database. Whatever its source, the URL's host must be the
# target container's name or its compose service name (`postgres` for open-brain-postgres);
# otherwise it refuses before the restore (an exported production URL would migrate the
# wrong database).
#
# Env: RESTORE_DB_USER / RESTORE_DB_NAME (default openbrain), RESTORE_NETWORK,
#      RESTORE_MIGRATE_IMAGE (default: the digest-pinned pgvector image of docker-compose.yml),
#      POSTGRES_URL.
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
MIGRATE_IMAGE="${RESTORE_MIGRATE_IMAGE:-pgvector/pgvector:pg16@sha256:1d533553fefe4f12e5d80c7b80622ba0c382abb5758856f52983d8789179f0fb}"
ALLOW_REF=""

# url_host_of <url>: the host of a postgres:// URL, or empty (prints nothing else).
url_host_of() {
  local u="$1" rest auth hp
  [[ "$u" == *://* ]] || return 0
  rest="${u#*://}"; auth="${rest%%[/?]*}"; hp="${auth##*@}"
  printf '%s' "${hp%%:*}"
}

usage() { sed -n '2,46p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --backup-dir)    [[ -n "${2:-}" ]] || { echo "ERROR: --backup-dir needs a directory" >&2; exit 2; }
                     BACKUP_DIR="$2"; shift 2 ;;
    --target)        [[ -n "${2:-}" ]] || { echo "ERROR: --target needs a container name" >&2; exit 2; }
                     TARGET="$2"; shift 2 ;;
    --apply-pending) APPLY_PENDING=1; shift ;;
    --allow-ref)     [[ -n "${2:-}" ]] || { echo "ERROR: --allow-ref needs a commit sha" >&2; exit 2; }
                     ALLOW_REF="$2"; shift 2 ;;
    -h|--help)       usage; exit 0 ;;
    *)               echo "ERROR: unknown argument: $1 (see --help)" >&2; exit 2 ;;
  esac
done

DUMP="${BACKUP_DIR%/}/openbrain.pgdump"
MANIFEST="${BACKUP_DIR%/}/manifest.json"
DEPLOYED="${BACKUP_DIR%/}/DEPLOYED.json"
[[ -z "$ALLOW_REF" || "$APPLY_PENDING" == 1 ]] || { echo "ERROR: --allow-ref only goes with --apply-pending" >&2; exit 2; }
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

  # The URL must name the restored target (never print the URL: it holds the password).
  url_host="$(url_host_of "$POSTGRES_URL")"
  service="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$TARGET" 2>/dev/null || true)"
  allowed=("$TARGET")
  [[ -n "$service" && "$service" != "<no value>" ]] && allowed+=("$service")
  [[ "$TARGET" == "open-brain-postgres" ]] && allowed+=("postgres")
  host_ok=0
  for h in "${allowed[@]}"; do [[ -n "$url_host" && "$url_host" == "$h" ]] && host_ok=1; done
  if [[ "$host_ok" != 1 ]]; then
    echo "ERROR: POSTGRES_URL points at host '${url_host:-<unparseable>}', not the restore target ${TARGET}" >&2
    echo "       (accepted hosts: ${allowed[*]}). An exported production URL would migrate the" >&2
    echo "       wrong database. Unset it or point it at ${TARGET}. Nothing was restored." >&2
    exit 2
  fi

  # The migrations come from this tree: it must be the deployed commit.
  head="$(git -c safe.directory="$REPO" -C "$REPO" rev-parse HEAD 2>/dev/null)" || head=""
  [[ -n "$head" ]] || { echo "ERROR: cannot read the HEAD of ${REPO} (not a git checkout?). Nothing was restored." >&2; exit 2; }
  if [[ -f "$DEPLOYED" ]]; then
    if command -v jq >/dev/null 2>&1; then
      want="$(jq -r '.commit // empty' "$DEPLOYED" 2>/dev/null)" || want=""
    else
      want="$(sed -nE 's/.*"commit"[[:space:]]*:[[:space:]]*"([0-9a-fA-F]+)".*/\1/p' "$DEPLOYED" | head -n 1)"
    fi
    src="${DEPLOYED} (commit)"
  elif [[ -n "$ALLOW_REF" ]]; then
    want="$(git -c safe.directory="$REPO" -C "$REPO" rev-parse --verify --quiet "${ALLOW_REF}^{commit}" 2>/dev/null)" || want="$ALLOW_REF"
    src="--allow-ref"
  else
    echo "ERROR: --apply-pending runs migrations from ${REPO}, and ${DEPLOYED} is missing, so" >&2
    echo "       nothing says which commit was deployed. Check out the deployed commit and pass" >&2
    echo "       --allow-ref <that sha>, or restore without --apply-pending. Nothing was restored." >&2
    exit 2
  fi
  if [[ ! "$want" =~ ^[0-9a-fA-F]{7,40}$ || "$head" != "$want"* ]]; then
    echo "ERROR: ${REPO} is at ${head:0:12}, but ${src} names '${want:0:40}'." >&2
    echo "       Its migrations may include ones that were never deployed. Run:" >&2
    echo "         git -c safe.directory=${REPO} -C ${REPO} checkout --detach ${want:-<deployed sha>}" >&2
    echo "       then rerun. Nothing was restored." >&2
    exit 2
  fi
  echo "  tree:       ${REPO} at ${head:0:12} = ${src}"
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
