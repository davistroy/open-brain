#!/usr/bin/env bash
# test-restore-e2e.sh — item 7.2: a REAL backup and a REAL restore, end to end.
#
#   1. starts pgvector/pgvector:pg16 as `open-brain-postgres` (the name backup.sh looks
#      for) with the PRODUCTION config/postgres/postgresql.conf (shared_buffers lowered
#      for a CI runner; maintenance_work_mem stays 512MB, which is what sizes the ~509 MB
#      parallel-HNSW DSM segment) and Docker's DEFAULT 64 MB /dev/shm;
#   2. loads scripts/init-schema.sql, then migrate-manual.sh --baseline <latest>;
#   3. seeds ~5,000 captures (scripts/test-fixtures/dr-seed.sql);
#   4. runs the real scripts/backup.sh (BACKUP_ROOT scratch, APP_DIR = this repo; the
#      wiki / Redis / sidecar legs warn and continue: those containers do not exist);
#   5. runs the real scripts/restore-rehearsal.sh against that backup.
#
# If restore_into drops PGOPTIONS='-c max_parallel_maintenance_workers=0', the HNSW build
# in the rehearsal container needs ~509 MB of /dev/shm, fails, pg_restore exits non-zero,
# and this script exits 1.
#
# Refuses to run if a container named open-brain-postgres (or the rehearsal container)
# already exists; it never touches a container it did not create. Removes both on exit.
# Requires: docker, jq. Exit 0 = pass, non-zero = fail.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${E2E_PG_IMAGE:-pgvector/pgvector:pg16}"
DB_CONTAINER="open-brain-postgres"            # backup.sh DB_CONTAINER (hard-coded there)
REHEARSAL_CONTAINER="open-brain-rehearsal-e2e-pg"
PG_PASSWORD="e2e-throwaway"
SHARED_BUFFERS="${E2E_SHARED_BUFFERS:-256MB}"
START_TS=$SECONDS

# This VM/dev box may hold real credentials; none may reach a script or a container here.
unset BWS_ACCESS_TOKEN PUSHOVER_APP_TOKEN PUSHOVER_USER_KEY PUSHOVER_TOKEN PUSHOVER_USER \
      REDIS_PASSWORD POSTGRES_URL

for c in "$DB_CONTAINER" "$REHEARSAL_CONTAINER"; do
  if docker inspect "$c" >/dev/null 2>&1; then
    echo "REFUSED: a container named '${c}' already exists; this test never touches an existing container." >&2
    exit 2
  fi
done

SCRATCH="$(mktemp -d)"
CREATED_DB=0
# shellcheck disable=SC2317  # invoked via trap
cleanup() {
  local rc=$?
  docker rm -f "$REHEARSAL_CONTAINER" >/dev/null 2>&1 || true
  if [[ "$CREATED_DB" == 1 ]]; then docker rm -f "$DB_CONTAINER" >/dev/null 2>&1 || true; fi
  rm -rf "$SCRATCH" >/dev/null 2>&1 || true
  exit "$rc"
}
trap cleanup EXIT

die() { echo "FAIL: $*" >&2; exit 1; }
step() { echo; echo "=== [e2e +$((SECONDS - START_TS))s] $* ==="; }
q() { docker exec "$DB_CONTAINER" psql -X -v ON_ERROR_STOP=1 -U openbrain -d openbrain -tAq -c "$1"; }
# A parallel HNSW build in a 64 MB /dev/shm container fails; the seed/load session builds serially.
SERIAL_ENV=(-e PGOPTIONS='-c max_parallel_maintenance_workers=0')

step "start ${DB_CONTAINER} (production postgresql.conf, default /dev/shm)"
docker run -d --name "$DB_CONTAINER" \
  -e POSTGRES_USER=openbrain -e POSTGRES_DB=openbrain -e POSTGRES_PASSWORD="$PG_PASSWORD" \
  -v "${REPO_ROOT}/config/postgres/postgresql.conf:/etc/postgresql/postgresql.conf:ro" \
  "$IMAGE" postgres -c config_file=/etc/postgresql/postgresql.conf -c "shared_buffers=${SHARED_BUFFERS}" \
  >/dev/null || die "could not start ${DB_CONTAINER}"
CREATED_DB=1

ready=0
for _ in $(seq 1 90); do
  # TCP probe, twice: the image restarts postgres once after initdb.
  if docker exec "$DB_CONTAINER" pg_isready -h 127.0.0.1 -U openbrain -d openbrain -q 2>/dev/null; then
    sleep 2
    docker exec "$DB_CONTAINER" pg_isready -h 127.0.0.1 -U openbrain -d openbrain -q 2>/dev/null && { ready=1; break; }
  fi
  sleep 1
done
[[ "$ready" == 1 ]] || { docker logs "$DB_CONTAINER" 2>&1 | tail -20; die "postgres not ready"; }

shm_kb="$(docker exec "$DB_CONTAINER" df -k /dev/shm | awk 'NR==2 {print $2}')"
[[ "$shm_kb" == "65536" ]] || die "/dev/shm is ${shm_kb} kB, expected the Docker default 65536 (64 MB)"
mwm="$(q 'SHOW maintenance_work_mem')"
[[ "$mwm" == "512MB" ]] || die "maintenance_work_mem is '${mwm}', expected 512MB from the production conf"
echo "  /dev/shm=64 MB, maintenance_work_mem=${mwm}, shared_buffers=$(q 'SHOW shared_buffers')"

step "load init-schema.sql"
docker exec -i "${SERIAL_ENV[@]}" "$DB_CONTAINER" \
  psql -X -q -v ON_ERROR_STOP=1 -U openbrain -d openbrain \
  < "${REPO_ROOT}/scripts/init-schema.sql" >/dev/null || die "init-schema.sql failed"

step "migrate-manual.sh --baseline <latest>"
LATEST=""
for f in "${REPO_ROOT}"/packages/shared/drizzle/0*.sql; do
  LATEST="$(basename "$f" | cut -c1-4)"
done
[[ -n "$LATEST" ]] || die "no migration files found"
# Throwaway container sharing the DB container's network namespace (no host psql, no
# published port); the password goes in by NAME only.
export POSTGRES_URL="postgresql://openbrain:${PG_PASSWORD}@127.0.0.1:5432/openbrain"
docker run --rm --network "container:${DB_CONTAINER}" \
  -v "${REPO_ROOT}:/app:ro" -w /app -e POSTGRES_URL "${SERIAL_ENV[@]}" \
  "$IMAGE" bash scripts/migrate-manual.sh --baseline "$LATEST" >/dev/null \
  || die "migrate-manual.sh --baseline ${LATEST} failed"
unset POSTGRES_URL
ledger_max="$(q 'SELECT max(version) FROM schema_migrations')"
echo "  baseline ${LATEST}; ledger max = ${ledger_max}"
[[ "$ledger_max" == "$LATEST"* ]] || die "ledger max '${ledger_max}' does not match baseline ${LATEST}"

step "seed ~5,000 captures"
docker exec -i "${SERIAL_ENV[@]}" "$DB_CONTAINER" \
  psql -X -q -v ON_ERROR_STOP=1 -U openbrain -d openbrain \
  < "${REPO_ROOT}/scripts/test-fixtures/dr-seed.sql" >/dev/null || die "seed failed"
rows="$(q 'SELECT count(*) FROM captures')"
heap_bytes="$(q "SELECT pg_relation_size('captures')")"
echo "  captures rows=${rows} heap=$((heap_bytes / 1024)) kB"
[[ "$rows" -ge 5000 ]] || die "seed produced ${rows} rows, expected >= 5000"
# Below min_parallel_table_scan_size (8 MB) Postgres never plans a parallel HNSW build and the
# regression this job guards would be invisible.
[[ "$heap_bytes" -gt 8388608 ]] || die "captures heap ${heap_bytes} B <= 8 MB: seed too small to plan a parallel HNSW build"

step "real scripts/backup.sh"
BACKUP_ROOT="${SCRATCH}/backup"
mkdir -p "$BACKUP_ROOT"
# BACKUP_LOCK_FILE: backup.sh takes a flock; /var/lock is not writable by a CI user.
# CUSTOM_CRON_SRC: point at a missing file (warn-and-continue) instead of the host's.
# Redis/wiki/sidecar containers do not exist here; those legs warn and continue.
BACKUP_ROOT="$BACKUP_ROOT" APP_DIR="$REPO_ROOT" \
  BACKUP_LOCK_FILE="${SCRATCH}/backup.lock" \
  CUSTOM_CRON_SRC="${SCRATCH}/no-custom.cron" \
  REDIS_WAIT_SECS=2 \
  bash "${REPO_ROOT}/scripts/backup.sh" || die "scripts/backup.sh failed (exit $?)"
[[ -s "${BACKUP_ROOT}/latest/openbrain.pgdump" ]] || die "backup produced no openbrain.pgdump"
[[ -s "${BACKUP_ROOT}/latest/manifest.json" ]] || die "backup produced no manifest.json"
jq -e '.objects.indexes > 0 and (.tables.captures | tonumber) >= 5000' "${BACKUP_ROOT}/latest/manifest.json" >/dev/null \
  || die "manifest.json lacks object counts or the seeded captures count"
echo "  manifest: $(jq -c '{git_sha, captures: .tables.captures, objects}' "${BACKUP_ROOT}/latest/manifest.json")"

step "real scripts/restore-rehearsal.sh"
# No Pushover credentials are set (unset above): notifications are skipped, never sent.
BACKUP_ROOT="$BACKUP_ROOT" REHEARSAL_CONTAINER="$REHEARSAL_CONTAINER" \
  bash "${REPO_ROOT}/scripts/restore-rehearsal.sh" \
  || die "scripts/restore-rehearsal.sh failed (exit $?)"
[[ -f "${BACKUP_ROOT}/.rehearsal-last-success" ]] || die "rehearsal passed but wrote no .rehearsal-last-success"

echo
echo "PASS: real backup + real restore of ${rows} seeded captures in $((SECONDS - START_TS))s"
