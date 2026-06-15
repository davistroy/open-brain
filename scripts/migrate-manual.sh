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
#   (default / apply)   run each drizzle 0*.sql NOT yet in the ledger, in order
#                       (ON_ERROR_STOP=1), then record it.
#   --baseline <NNNN>   record every migration with version prefix <= NNNN as applied
#                       WITHOUT running it (use right after applying init-schema.sql,
#                       which already contains those migrations' effects).
#   --status            print applied vs pending; make no changes.
#   --dry-run           print what apply mode WOULD run; make no changes.
#
# ENV:
#   POSTGRES_URL  target DB (default: dev localhost).
#
# Requires: psql on PATH.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DRIZZLE_DIR="${REPO_ROOT}/packages/shared/drizzle"
POSTGRES_URL="${POSTGRES_URL:-postgresql://openbrain:openbrain_dev@localhost:5432/openbrain}"

# psql invocation as an array (no eval — robust against quotes inside SQL).
PSQL=(psql "${POSTGRES_URL}" -v ON_ERROR_STOP=1)
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
    echo "Migration ledger status (target: ${POSTGRES_URL%%@*}@***):"
    for f in $(migration_files); do
      v="$(version_of "$f")"
      if [[ "$(is_recorded "$v")" == "1" ]]; then echo "  [applied] $v"; else echo "  [pending] $v"; fi
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
      run_psql -f "$f" >/dev/null
      record "$v" "$(checksum_of "$f")"
      applied=$((applied + 1))
    done
    if (( applied == 0 )); then
      echo "Ledger up to date — nothing to apply."
    else
      echo "Applied ${applied} migration(s)."
    fi
    ;;
esac
