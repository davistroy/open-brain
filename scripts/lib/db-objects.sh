# shellcheck shell=bash
# db-objects.sh — the ONE place that counts database objects for the backup manifest
# (scripts/backup.sh, item 6.4) and for the restore rehearsal (scripts/restore-rehearsal.sh,
# item 6.3). Both sides call db_objects_json, so the two numbers are counted identically.
#
# Source it; sourcing defines functions and has no other effect.
#   db_objects_json <container> [db-user] [db-name]
#
# Prints one JSON object on one line (schema `public` only):
#   {"indexes": N, "foreign_keys": N, "triggers": N, "functions": N, "ledger_max": "<version>"}
#   indexes       pg_indexes rows
#   foreign_keys  pg_constraint contype 'f'
#   triggers      pg_trigger NOT tgisinternal, on tables of schema public
#   functions     pg_proc of schema public, excluding extension members (pg_depend deptype 'e')
#   ledger_max    max(schema_migrations.version); "" when the table is absent or empty
# Returns non-zero (prints nothing) when a query fails. Uses `docker exec … psql` only.

_db_objects_psql() {
  docker exec "$1" psql -X -v ON_ERROR_STOP=1 -U "$2" -d "$3" -tAq -c "$4"
}

db_objects_json() {
  local container="${1:-}" user="${2:-${RESTORE_DB_USER:-openbrain}}" db="${3:-${RESTORE_DB_NAME:-openbrain}}"
  [[ -n "$container" ]] || { echo "db_objects_json: container required" >&2; return 2; }
  local counts ledger has
  counts="$(_db_objects_psql "$container" "$user" "$db" "SELECT
    (SELECT count(*) FROM pg_indexes WHERE schemaname = 'public') || ' ' ||
    (SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
       WHERE n.nspname = 'public' AND c.contype = 'f') || ' ' ||
    (SELECT count(*) FROM pg_trigger t JOIN pg_class r ON r.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = r.relnamespace
       WHERE n.nspname = 'public' AND NOT t.tgisinternal) || ' ' ||
    (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND NOT EXISTS (SELECT 1 FROM pg_depend d
         WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e'))")" || return 1
  has="$(_db_objects_psql "$container" "$user" "$db" "SELECT to_regclass('public.schema_migrations') IS NOT NULL")" || return 1
  ledger=""
  if [[ "$has" == "t" ]]; then
    ledger="$(_db_objects_psql "$container" "$user" "$db" "SELECT coalesce(max(version), '') FROM public.schema_migrations")" || return 1
  fi
  local idx fk trg fn
  read -r idx fk trg fn <<<"$counts"
  [[ "$idx$fk$trg$fn" =~ ^[0-9]+$ ]] || return 1
  # Versions are migration file names (no quote/backslash); strip them defensively anyway.
  ledger="${ledger//[\"\\]/}"
  printf '{"indexes": %s, "foreign_keys": %s, "triggers": %s, "functions": %s, "ledger_max": "%s"}\n' \
    "$idx" "$fk" "$trg" "$fn" "$ledger"
}
