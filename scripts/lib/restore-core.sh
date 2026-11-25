# shellcheck shell=bash
# restore-core.sh — the one restore function used by scripts/restore.sh (a real recovery)
# and scripts/restore-rehearsal.sh (the weekly rehearsal). Item 6.2.
#
# Source it; sourcing defines functions and has no other effect:
#   source "${SCRIPT_DIR}/lib/restore-core.sh"
#   restore_into <container> <dump-file-on-host>
#
# restore_into:
#   0. waits (RESTORE_READY_TIMEOUT s, default 60) for `pg_isready -h 127.0.0.1`. The TCP
#      probe matters: during first-start initdb the image runs a socket-only temporary
#      server, and a restore over the socket could land in it just before the restart;
#   1. refuses (returns 3) unless schema `public` of the target database holds no table
#      (pg_tables). The dump is a complete snapshot: it restores into an EMPTY database,
#      and init-schema.sql is never applied first (a pre-existing object makes
#      `pg_restore --exit-on-error` abort on the first CREATE and restore zero rows);
#   2. CREATE EXTENSION IF NOT EXISTS vector (the dump's own CREATE EXTENSION is
#      IF NOT EXISTS, so this is harmless and fails early on a non-pgvector image);
#   3. docker cp's the dump into the container;
#   4. pg_restore --exit-on-error --no-owner --no-privileges in ONE session with
#      PGOPTIONS='-c max_parallel_maintenance_workers=0'. A parallel HNSW build sizes a
#      /dev/shm segment from maintenance_work_mem (~509 MB at 512 MB); in a container with
#      Docker's 64 MB /dev/shm that CREATE INDEX fails and the restore loses the index.
#      With 0 workers the build uses private memory, so a correct restore does not depend
#      on the container's /dev/shm size. A non-zero worker count does NOT avoid the segment;
#   5. removes the copied dump from the container (also on failure).
#
# Returns 0 on success; non-zero on any error (pg_restore output goes to stderr).
#   2 = bad arguments / dump missing / container not reachable
#   3 = target database not empty (refused, nothing changed)
#   4 = CREATE EXTENSION or docker cp failed
#   5 = pg_restore failed
#
# Env (defaults match the production container and the rehearsal container):
#   RESTORE_DB_USER  default openbrain
#   RESTORE_DB_NAME  default openbrain
#   RESTORE_READY_TIMEOUT  default 60 (seconds)
#
# Every SQL call goes through `docker exec … psql` (the Unraid host has no psql).

# _restore_psql <container> <sql>: one value, tuples-only, unaligned.
_restore_psql() {
  docker exec "$1" psql -X -v ON_ERROR_STOP=1 \
    -U "${RESTORE_DB_USER:-openbrain}" -d "${RESTORE_DB_NAME:-openbrain}" \
    -tAq -c "$2"
}

# restore_wait_ready <container> [seconds]: 0 once Postgres answers over TCP, 1 on timeout.
restore_wait_ready() {
  local container="$1" secs="${2:-${RESTORE_READY_TIMEOUT:-60}}" i
  for ((i = 0; i < secs; i++)); do
    if docker exec "$container" pg_isready -h 127.0.0.1 \
        -U "${RESTORE_DB_USER:-openbrain}" -d "${RESTORE_DB_NAME:-openbrain}" -q 2>/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}

# restore_public_table_count <container>: number of tables in schema public (empty on error).
restore_public_table_count() {
  _restore_psql "$1" "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'"
}

# restore_object_counts <container>: prints "tables N indexes N constraints N" for schema public.
restore_object_counts() {
  _restore_psql "$1" "SELECT 'tables ' || (SELECT count(*) FROM pg_tables WHERE schemaname = 'public')
    || ' indexes ' || (SELECT count(*) FROM pg_indexes WHERE schemaname = 'public')
    || ' constraints ' || (SELECT count(*) FROM pg_constraint c JOIN pg_namespace n
                             ON n.oid = c.connamespace WHERE n.nspname = 'public')"
}

restore_into() {
  local container="${1:-}" dump="${2:-}"
  local user="${RESTORE_DB_USER:-openbrain}" db="${RESTORE_DB_NAME:-openbrain}"
  if [[ -z "$container" || -z "$dump" ]]; then
    echo "restore_into: usage: restore_into <container> <dump>" >&2
    return 2
  fi
  if [[ ! -f "$dump" ]]; then
    echo "restore_into: dump not found: ${dump}" >&2
    return 2
  fi

  if ! restore_wait_ready "$container"; then
    echo "restore_into: ${container} does not accept TCP connections (pg_isready -h 127.0.0.1)" >&2
    return 2
  fi

  local tables
  if ! tables="$(restore_public_table_count "$container")" || [[ ! "$tables" =~ ^[0-9]+$ ]]; then
    echo "restore_into: cannot query ${container} (database ${db}, user ${user})" >&2
    return 2
  fi
  if [[ "$tables" != "0" ]]; then
    echo "restore_into: REFUSED — schema public in ${container}/${db} already holds ${tables} table(s)." >&2
    echo "restore_into: the dump restores into an EMPTY database only; nothing was changed." >&2
    return 3
  fi

  if ! _restore_psql "$container" "CREATE EXTENSION IF NOT EXISTS vector" >/dev/null; then
    echo "restore_into: CREATE EXTENSION vector failed in ${container} (not a pgvector image?)" >&2
    return 4
  fi

  local in_container="/tmp/restore-$$-${RANDOM}.pgdump"
  if ! docker cp "$dump" "${container}:${in_container}" >/dev/null; then
    echo "restore_into: docker cp of the dump into ${container} failed" >&2
    return 4
  fi

  local out rc=0
  out="$(docker exec -e PGOPTIONS='-c max_parallel_maintenance_workers=0' "$container" \
    pg_restore --exit-on-error --no-owner --no-privileges \
    -U "$user" -d "$db" "$in_container" 2>&1)" || rc=$?

  docker exec "$container" rm -f "$in_container" >/dev/null 2>&1 || true

  if [[ "$rc" -ne 0 ]]; then
    echo "restore_into: pg_restore exited ${rc}. First lines of its output:" >&2
    printf '%s\n' "$out" | head -50 | sed 's/^/    /' >&2
    return 5
  fi
  return 0
}
