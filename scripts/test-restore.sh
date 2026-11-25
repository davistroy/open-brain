#!/usr/bin/env bash
# test-restore.sh — regression harness for scripts/restore.sh + scripts/lib/restore-core.sh
# (item 6.2). Runs against ONE throwaway pgvector container that keeps Docker's DEFAULT
# 64 MB /dev/shm (no shm_size) and runs the PRODUCTION config/postgres/postgresql.conf
# (maintenance_work_mem 512MB). The container holds a source database `src` and the
# restore target `openbrain`.
#
#   Case 1: target holds one table -> restore.sh refuses (exit 3), the table is still
#           there and nothing else was added (no extra table, no vector extension).
#   Case 2: source DB with a vector column + HNSW index, a GIN index, a FK, a CHECK, a
#           UNIQUE, a trigger and functions, big enough (> min_parallel_table_scan_size)
#           that the HNSW build is planned parallel and would need a ~509 MB DSM segment
#           -> pg_dump -Fc -> restore.sh into the empty target -> exit 0 and every index,
#           constraint, trigger and function of the source exists in the target, all
#           indexes valid, row counts equal.
#   Case 3: --apply-pending runs migrate-manual.sh from a throwaway container on a
#           scratch network (ledger pre-filled, so nothing is applied); URL never printed.
#   Case 4: restore_into / restore.sh argument checks (missing dump -> 2, bad flag -> 2).
#   Case 5: --apply-pending refuses (exit 2, nothing restored) unless the repo HEAD equals
#           DEPLOYED.json's commit, or --allow-ref <sha> = HEAD when DEPLOYED.json is absent.
#   Case 6: --apply-pending refuses a POSTGRES_URL whose host is not the target.
#
# Requires: docker. No psql on the host needed. Exit 0 = all pass, 1 = any failure.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RESTORE="${REPO_ROOT}/scripts/restore.sh"
IMAGE="pgvector/pgvector:pg16"
C="ob-restore-test-$$-${RANDOM}"
NET="${C}-net"
TMP="$(mktemp -d)"
FAILS=0

# shellcheck disable=SC2317  # invoked via trap
cleanup() {
  docker rm -f "$C" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -rf "$TMP" >/dev/null 2>&1 || true
}
trap cleanup EXIT

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAILS=$((FAILS + 1)); }
check() { if [[ "$2" == "$3" ]]; then pass "$1"; else fail "$1 (expected '$2', got '$3')"; fi; }
q() { docker exec "$C" psql -X -v ON_ERROR_STOP=1 -U openbrain -d "$1" -tAq -c "$2"; }

# Default /dev/shm (64 MB): deliberately NO --shm-size.
docker run -d --name "$C" \
  -e POSTGRES_USER=openbrain -e POSTGRES_DB=openbrain -e POSTGRES_PASSWORD=restoretest \
  -v "${REPO_ROOT}/config/postgres/postgresql.conf:/etc/postgresql/postgresql.conf:ro" \
  "$IMAGE" postgres -c config_file=/etc/postgresql/postgresql.conf >/dev/null \
  || { echo "FAIL: could not start container"; exit 1; }

ready=0
for _ in $(seq 1 60); do
  # TCP probe, twice: the image restarts postgres once after initdb.
  if docker exec "$C" pg_isready -h 127.0.0.1 -U openbrain -d openbrain -q 2>/dev/null; then
    sleep 2
    docker exec "$C" pg_isready -h 127.0.0.1 -U openbrain -d openbrain -q 2>/dev/null && { ready=1; break; }
  fi
  sleep 1
done
[[ "$ready" == 1 ]] || { echo "FAIL: postgres not ready"; docker logs "$C" 2>&1 | tail -20; exit 1; }

check "scratch container keeps the default 64 MB /dev/shm" "65536" \
  "$(docker exec "$C" df -k /dev/shm | awk 'NR==2 {print $2}')"
check "scratch container runs maintenance_work_mem 512MB" "512MB" "$(q openbrain 'SHOW maintenance_work_mem')"

# --- Source database ---------------------------------------------------------
q openbrain "CREATE DATABASE src" >/dev/null
# Source build itself must not need DSM: build with 0 maintenance workers.
docker exec -i -e PGOPTIONS='-c max_parallel_maintenance_workers=0' "$C" \
  psql -X -q -v ON_ERROR_STOP=1 -U openbrain -d src >/dev/null <<'SQL' || { echo "FAIL: source schema build"; exit 1; }
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE parent (id serial PRIMARY KEY, name text NOT NULL UNIQUE);
CREATE TABLE items (
  id         serial PRIMARY KEY,
  parent_id  int NOT NULL REFERENCES parent(id) ON DELETE CASCADE,
  content    text NOT NULL CHECK (length(content) > 0),
  tags       text[] NOT NULL DEFAULT '{}',
  pad        text,
  embedding  vector(64),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO parent (name) SELECT 'p' || g FROM generate_series(1, 10) g;
-- ~1.7 KB inline tuples (under the TOAST threshold) x 7000 rows ~= 12 MB heap: above
-- min_parallel_table_scan_size (8 MB), so the HNSW build is planned with workers.
INSERT INTO items (parent_id, content, tags, pad, embedding)
SELECT 1 + g % 10, 'item ' || g, ARRAY['t' || (g % 7), 'u' || (g % 3)],
       repeat(md5(g::text), 48),
       (SELECT array_agg(random() + i * 0 + g * 0)::vector FROM generate_series(1, 64) i)
FROM generate_series(1, 7000) g;
CREATE INDEX items_embedding_hnsw_idx ON items USING hnsw (embedding vector_cosine_ops);
CREATE INDEX items_tags_gin_idx ON items USING gin (tags);
CREATE INDEX items_parent_idx ON items (parent_id);
CREATE FUNCTION touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS
  $$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$;
CREATE TRIGGER items_touch BEFORE UPDATE ON items FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE FUNCTION items_for(p int) RETURNS bigint LANGUAGE sql STABLE AS
  $$ SELECT count(*) FROM items WHERE parent_id = p $$;
CREATE TABLE schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now(), checksum text);
SQL
# Ledger = every repo migration (as on a real backup), so case 3 finds nothing pending.
LAST_VERSION=""
for f in "${REPO_ROOT}"/packages/shared/drizzle/0*.sql; do
  LAST_VERSION="$(basename "$f" .sql)"
  q src "INSERT INTO schema_migrations (version) VALUES ('${LAST_VERSION}')" >/dev/null
done

heap_kb="$(q src "SELECT pg_relation_size('items') / 1024")"
echo "  source items heap: ${heap_kb} kB"
mkdir -p "${TMP}/backup"
docker exec "$C" pg_dump -U openbrain -d src --format=custom --compress=6 --no-owner --no-privileges \
  > "${TMP}/backup/openbrain.pgdump" || { echo "FAIL: pg_dump of source"; exit 1; }
echo '{"timestamp":"test","tables":{"items":7000,"parent":10}}' > "${TMP}/backup/manifest.json"
# --apply-pending runs migrations from THIS tree, so the backup must name its HEAD as deployed.
HEAD_SHA="$(git -c safe.directory="${REPO_ROOT}" -C "${REPO_ROOT}" rev-parse HEAD)"
printf '{\n  "commit": "%s",\n  "previous_commit": "%s"\n}\n' "$HEAD_SHA" "0000000000000000000000000000000000000000" \
  > "${TMP}/backup/DEPLOYED.json"
# The same backup without DEPLOYED.json, and one whose DEPLOYED.json names another commit.
mkdir -p "${TMP}/nodeployed" "${TMP}/otherdeployed"
cp "${TMP}/backup/openbrain.pgdump" "${TMP}/backup/manifest.json" "${TMP}/nodeployed/"
cp "${TMP}/backup/openbrain.pgdump" "${TMP}/backup/manifest.json" "${TMP}/otherdeployed/"
echo '{"commit": "1111111111111111111111111111111111111111"}' > "${TMP}/otherdeployed/DEPLOYED.json"
# The migrate step uses the local image (the script's default is digest-pinned).
export RESTORE_MIGRATE_IMAGE="$IMAGE"

# Object-name inventories (extension members excluded).
declare -A INV
INV[INDEXES]="SELECT tablename || '.' || indexname FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1"
INV[CONSTRAINTS]="SELECT conrelid::regclass || '.' || conname || ':' || contype::text FROM pg_constraint c
  JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = 'public' ORDER BY 1"
INV[TRIGGERS]="SELECT tgrelid::regclass || '.' || tgname FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1"
INV[FUNCTIONS]="SELECT p.oid::regprocedure::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND NOT EXISTS (SELECT 1 FROM pg_depend d
    WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e') ORDER BY 1"

# --- Case 1: non-empty target -> refusal, no change --------------------------
q openbrain "CREATE TABLE intruder (id int); INSERT INTO intruder VALUES (42)" >/dev/null
out="$(bash "$RESTORE" --backup-dir "${TMP}/backup" --target "$C" 2>&1)"; rc=$?
check "case 1: restore.sh refuses a non-empty target (exit 3)" "3" "$rc"
if [[ "$out" == *REFUSED* ]]; then pass "case 1: refusal message printed"; else fail "case 1: refusal message printed"; fi
check "case 1: the existing table is still there with its row" "42" "$(q openbrain 'SELECT id FROM intruder')"
check "case 1: no other table added" "intruder" \
  "$(q openbrain "SELECT string_agg(tablename, ',') FROM pg_tables WHERE schemaname = 'public'")"
check "case 1: vector extension not created" "0" "$(q openbrain "SELECT count(*) FROM pg_extension WHERE extname = 'vector'")"
q openbrain "DROP TABLE IF EXISTS intruder" >/dev/null

# --- Case 2: empty target + dump -> full restore -----------------------------
# Start from a clean target even if case 1 regressed and restored into it.
q src "DROP DATABASE IF EXISTS openbrain WITH (FORCE)" >/dev/null
q src "CREATE DATABASE openbrain" >/dev/null
out="$(bash "$RESTORE" --backup-dir "${TMP}/backup" --target "$C" 2>&1)"; rc=$?
check "case 2: restore.sh exits 0 under a 64 MB /dev/shm" "0" "$rc"
[[ "$rc" == 0 ]] || printf '%s\n' "$out" | sed 's/^/    /'
if [[ "$out" == *"tables 3 indexes"* ]]; then pass "case 2: object counts printed"; else fail "case 2: object counts printed"; fi
for inv in INDEXES CONSTRAINTS TRIGGERS FUNCTIONS; do
  want="$(q src "${INV[$inv]}")"; got="$(q openbrain "${INV[$inv]}")"
  n="$(printf '%s\n' "$want" | grep -c .)"
  if [[ -n "$want" && "$want" == "$got" ]]; then
    pass "case 2: ${inv} identical to source (${n})"
  else
    fail "case 2: ${inv} differ from source"
    diff <(printf '%s\n' "$want") <(printf '%s\n' "$got") | sed 's/^/    /'
  fi
done
check "case 2: HNSW index present" "items_embedding_hnsw_idx" "$(q openbrain "SELECT to_regclass('items_embedding_hnsw_idx')")"
check "case 2: GIN index present" "items_tags_gin_idx" "$(q openbrain "SELECT to_regclass('items_tags_gin_idx')")"
check "case 2: no invalid index" "0" "$(q openbrain 'SELECT count(*) FROM pg_index WHERE NOT indisvalid')"
check "case 2: items row count equal" "$(q src 'SELECT count(*) FROM items')" "$(q openbrain 'SELECT count(*) FROM items')"
check "case 2: ledger restored" "${LAST_VERSION}" "$(q openbrain 'SELECT max(version) FROM schema_migrations')"
check "case 2: copied dump removed from the container" "" \
  "$(docker exec "$C" sh -c 'ls /tmp/restore-*.pgdump 2>/dev/null')"

# --- Case 3: --apply-pending path (network, repo mount, URL by name) ---------
# The dump's ledger already lists every repo migration, so migrate-manual.sh has nothing
# to apply: this proves the throwaway-container plumbing without running real migrations.
if docker network create "$NET" >/dev/null && docker network connect "$NET" "$C"; then
  q src "CREATE DATABASE ob4" >/dev/null
  out="$(POSTGRES_URL="postgresql://openbrain:restoretest@${C}:5432/ob4" RESTORE_NETWORK="$NET" \
    RESTORE_DB_NAME=ob4 bash "$RESTORE" --backup-dir "${TMP}/backup" --target "$C" --apply-pending 2>&1)"; rc=$?
  check "case 3: restore --apply-pending exits 0" "0" "$rc"
  if [[ "$out" == *"up to date"* ]]; then pass "case 3: migrate-manual.sh ran in the throwaway container"
  else fail "case 3: migrate-manual.sh ran in the throwaway container"; printf '%s\n' "$out" | tail -15 | sed 's/^/    /'; fi
  if [[ "$out" != *restoretest* ]]; then pass "case 3: password never printed"; else fail "case 3: password never printed"; fi
else
  fail "case 3: scratch network setup"
fi

# --- Case 4: restore_into argument checks ------------------------------------
# shellcheck source=lib/restore-core.sh
source "${REPO_ROOT}/scripts/lib/restore-core.sh"
restore_into "$C" "${TMP}/no-such.pgdump" 2>/dev/null; rc=$?
check "case 4: restore_into with a missing dump returns 2" "2" "$rc"
out="$(bash "$RESTORE" --bogus 2>&1)"; rc=$?
check "case 4: restore.sh rejects an unknown argument (exit 2)" "2" "$rc"
q src "CREATE DATABASE ob6" >/dev/null
env -u POSTGRES_URL RESTORE_DB_NAME=ob6 bash "$RESTORE" --backup-dir "${TMP}/backup" --target "$C" \
  --apply-pending >/dev/null 2>&1; rc=$?
check "case 4: --apply-pending on a non-default target without POSTGRES_URL refuses (exit 2)" "2" "$rc"
check "case 4: ... and restores nothing" "0" "$(q ob6 "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")"
if bash "$RESTORE" --help | grep -q -- '--apply-pending'; then pass "case 4: --help documents --apply-pending"
else fail "case 4: --help documents --apply-pending"; fi

# --- Case 5: --apply-pending only from the deployed tree (refusals restore nothing) --
# apply_case <name> <expected rc> <backup dir> <url host> [extra args...]
apply_case() {
  local name="$1" want="$2" dir="$3" host="$4"; shift 4
  local db="ob$((RANDOM % 90000 + 10000))"
  q src "CREATE DATABASE ${db}" >/dev/null
  out="$(POSTGRES_URL="postgresql://openbrain:restoretest@${host}:5432/${db}" RESTORE_NETWORK="$NET" \
    RESTORE_DB_NAME="$db" bash "$RESTORE" --backup-dir "$dir" --target "$C" --apply-pending "$@" 2>&1)"; rc=$?
  check "${name} (exit ${want})" "$want" "$rc"
  if [[ "$want" != 0 ]]; then
    check "${name}: nothing restored" "0" "$(q "$db" "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")"
  fi
  if [[ "$out" != *restoretest* ]]; then pass "${name}: password never printed"; else fail "${name}: password never printed"; fi
}
apply_case "case 5a: no DEPLOYED.json -> refused" 2 "${TMP}/nodeployed" "$C"
if [[ "$out" == *--allow-ref* ]]; then pass "case 5a: refusal names --allow-ref"; else fail "case 5a: refusal names --allow-ref"; fi
apply_case "case 5b: DEPLOYED.json names another commit -> refused" 2 "${TMP}/otherdeployed" "$C"
apply_case "case 5c: no DEPLOYED.json, --allow-ref <wrong sha> -> refused" 2 "${TMP}/nodeployed" "$C" \
  --allow-ref 1111111111111111111111111111111111111111
apply_case "case 5d: no DEPLOYED.json, --allow-ref HEAD -> restored + migrated" 0 "${TMP}/nodeployed" "$C" \
  --allow-ref "$HEAD_SHA"

# --- Case 6: the migration URL must point at the restored target ---------------
# An exported production URL (host postgres / open-brain-postgres) with a scratch target.
apply_case "case 6a: URL host open-brain-postgres, other target -> refused" 2 "${TMP}/backup" open-brain-postgres
apply_case "case 6b: URL host postgres, other target -> refused" 2 "${TMP}/backup" postgres
apply_case "case 6c: URL host = target -> accepted" 0 "${TMP}/backup" "$C"

echo
if (( FAILS == 0 )); then echo "test-restore: ALL PASSED"; exit 0; fi
echo "test-restore: ${FAILS} FAILED"; exit 1
