#!/usr/bin/env bash
# migrate-manual.sh — apply drizzle migrations idempotently and record them in a
# manual `schema_migrations` ledger (DA-M1 / ADR-scope D-3).
#
# WHY MANUAL: this repo deliberately runs NO auto-migration on startup, and
# drizzle/meta/ is intentionally empty (drizzle-kit's journal was never adopted —
# drizzle/0000 is an empty stub, base DDL lives in scripts/init-schema.sql). This
# script is the supported way to apply incremental migrations on the homeserver
# after a deploy, and to know which have been applied.
#
# CANONICAL BOOTSTRAP / DEPLOY ORDER:
#   1. psql "$POSTGRES_URL" -f scripts/init-schema.sql   # complete snapshot (= chain so far)
#   2. bash scripts/migrate-manual.sh --baseline <latest>  # record the snapshot's migrations
#   3. bash scripts/migrate-manual.sh                       # apply any NEWER 0*.sql + record
# Thereafter, every deploy is just step 3.
#
# MODES:
#   (default / apply)   run each drizzle 0*.sql NOT yet in the ledger, in order.
#                       Each file + its ledger INSERT run in ONE transaction
#                       (psql -1 -v ON_ERROR_STOP=1): a failure leaves no partial
#                       objects and no ledger row. A file whose first lines contain
#                       `-- migrate:no-transaction` runs WITHOUT -1 (for statements such
#                       as CREATE INDEX CONCURRENTLY); its ledger row is written in a
#                       second call, so a mid-file failure there is NOT rolled back.
#   --baseline <NNNN>   record every migration with version prefix <= NNNN as applied
#                       WITHOUT running it (use right after applying init-schema.sql,
#                       which already contains those migrations' effects).
#   --status            print applied vs pending; warn when an applied file's sha256
#                       differs from the stored checksum; make no changes.
#   --dry-run           print what apply mode WOULD run; make no changes.
#
# ENV:
#   POSTGRES_URL    target DB (default: dev localhost). Its password is moved to
#                   PGPASSWORD; psql gets the URL without it, and every printed URL is masked.
#   MIGRATIONS_DIR  directory of 0*.sql files (default: packages/shared/drizzle).
#
# Requires: psql on PATH.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DRIZZLE_DIR="${MIGRATIONS_DIR:-${REPO_ROOT}/packages/shared/drizzle}"
POSTGRES_URL="${POSTGRES_URL:-postgresql://openbrain:openbrain_dev@localhost:5432/openbrain}"

# The password never reaches a psql argv (visible in `ps`) or the output: it moves to
# PGPASSWORD (percent-decoded, as libpq would) and psql gets the URL without it.
# mask_url prints a URL with its password replaced by ***.
mask_url() { printf '%s\n' "$1" | sed -E 's#(://[^:/@]+):[^@]*@#\1:***@#'; }
_url_pw="$(printf '%s\n' "${POSTGRES_URL}" | sed -nE 's#^[A-Za-z][A-Za-z0-9+.-]*://[^:/@]+:([^@]*)@.*#\1#p')"
if [[ -n "${_url_pw}" ]]; then
  _url_pw="${_url_pw//\\/\\\\}"                 # keep literal backslashes literal for %b
  PGPASSWORD="$(printf '%b' "${_url_pw//%/\\x}")"
  export PGPASSWORD
  PSQL_URL="$(printf '%s\n' "${POSTGRES_URL}" | sed -E 's#(://[^:/@]+):[^@]*@#\1@#')"
else
  PSQL_URL="${POSTGRES_URL}"
fi
unset _url_pw

# psql invocation as an array (no eval — robust against quotes inside SQL).
PSQL=(psql "${PSQL_URL}" -v ON_ERROR_STOP=1)
run_psql() { "${PSQL[@]}" -q "$@"; }
query()    { "${PSQL[@]}" -tAq -c "$1"; }

ensure_ledger() {
  run_psql -c "SET client_min_messages = warning;
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version    TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    checksum   TEXT
  );" >/dev/null
}

is_recorded() {  # $1 = version; echoes "1" if present
  query "SELECT 1 FROM schema_migrations WHERE version = '$1' LIMIT 1"
}

record() {  # $1 = version, $2 = checksum
  run_psql -c "INSERT INTO schema_migrations (version, checksum)
               VALUES ('$1', '$2') ON CONFLICT (version) DO NOTHING;" >/dev/null
}

migration_files() { ls -1 "${DRIZZLE_DIR}"/0*.sql 2>/dev/null | sort; }
version_of()      { basename "$1" .sql; }            # 0033_index_correctness
prefix_of()       { local b; b="$(basename "$1")"; echo "${b:0:4}"; }   # 0033
checksum_of()     { sha256sum "$1" | cut -d' ' -f1; }
stored_checksum() { query "SELECT coalesce(checksum, '') FROM schema_migrations WHERE version = '$1'"; }
# True when the file opts out of the wrapping transaction (marker in its first 5 lines).
no_transaction()  { head -n 5 "$1" | grep -q '^--[[:space:]]*migrate:no-transaction'; }

MODE="apply"
BASELINE=""
case "${1:-}" in
  --baseline) MODE="baseline"; BASELINE="${2:-}"; [[ -z "${BASELINE}" ]] && { echo "ERROR: --baseline needs a version prefix, e.g. --baseline 0033" >&2; exit 2; } ;;
  --status)   MODE="status" ;;
  --dry-run)  MODE="dryrun" ;;
  "")         MODE="apply" ;;
  *)          echo "ERROR: unknown argument '$1'" >&2; exit 2 ;;
esac

ensure_ledger

case "${MODE}" in
  status)
    echo "Migration ledger status (target: $(mask_url "${POSTGRES_URL}")):"
    for f in $(migration_files); do
      v="$(version_of "$f")"
      if [[ "$(is_recorded "$v")" == "1" ]]; then
        echo "  [applied] $v"
        stored="$(stored_checksum "$v")"
        if [[ -n "$stored" && "$stored" != "$(checksum_of "$f")" ]]; then
          echo "  WARNING: checksum mismatch for $v (file changed since it was applied)"
        fi
      else
        echo "  [pending] $v"
      fi
    done
    ;;

  baseline)
    echo "Baselining migrations up to and including prefix ${BASELINE} (recording, NOT running)..."
    for f in $(migration_files); do
      v="$(version_of "$f")"; p="$(prefix_of "$f")"
      if (( 10#$p <= 10#$BASELINE )); then
        record "$v" "$(checksum_of "$f")"
        echo "  baselined $v"
      fi
    done
    ;;

  dryrun)
    echo "Would apply (pending migrations):"
    any=0
    for f in $(migration_files); do
      v="$(version_of "$f")"
      [[ "$(is_recorded "$v")" == "1" ]] || { echo "  $v"; any=1; }
    done
    [[ "$any" == "0" ]] && echo "  (none — ledger is up to date)"
    ;;

  apply)
    applied=0
    for f in $(migration_files); do
      v="$(version_of "$f")"
      if [[ "$(is_recorded "$v")" == "1" ]]; then continue; fi
      echo "Applying ${v}..."
      sum="$(checksum_of "$f")"
      ins="INSERT INTO schema_migrations (version, checksum) VALUES ('${v}', '${sum}') ON CONFLICT (version) DO NOTHING;"
      if no_transaction "$f"; then
        echo "  NOTICE: ${v} is marked migrate:no-transaction — running WITHOUT a transaction; ledger row written separately."
        run_psql -f "$f" >/dev/null
        run_psql -c "$ins" >/dev/null
      else
        run_psql -1 -f "$f" -c "$ins" >/dev/null
      fi
      applied=$((applied + 1))
    done
    if (( applied == 0 )); then
      echo "Ledger up to date — nothing to apply."
    else
      echo "Applied ${applied} migration(s)."
    fi
    ;;
esac
