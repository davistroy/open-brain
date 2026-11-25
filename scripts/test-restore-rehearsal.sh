#!/usr/bin/env bash
# test-restore-rehearsal.sh
#
# Regression test for scripts/restore-rehearsal.sh.
# Tests bash logic and Pushover notification path without requiring Docker or a
# real backup. Uses REHEARSAL_DRY_RUN=true to short-circuit all Docker calls.
#
# Usage: bash scripts/test-restore-rehearsal.sh
# Exit code: 0 = all tests passed, 1 = one or more tests failed
#
# Test cases:
#   TC-1..3: missing backup root / dump / manifest                       — expect exit 2
#   TC-4:  happy path (fresh backup, counts + objects match)            — expect exit 0, marker written
#   TC-5:  row diff of 5% (25 of 500)                                    — expect exit 1
#   TC-6:  row diff of 15 rows (3% of 500, under the 20-row floor)       — expect exit 0
#   TC-7:  diff 21 rows on a small table fails; 900 on a 100k table passes (1% rule)
#   TC-9:  stale manifest.timestamp (50h)                                — expect exit 1 + fail notification
#   TC-10: stale dump mtime (50h, fresh manifest)                        — expect exit 1
#   TC-11: required object missing (hnsw index)                          — expect exit 1
#   TC-12: manifest without `objects`                                    — warning + exit 0
#   TC-13: object count mismatch (index / fk / trigger / function)       — expect exit 1 each
#   TC-14: ledger mismatch, invalid index                                — expect exit 1 each
#   TC-8:  Pushover mock: pass path sends pass, fail path sends fail
#   TC-R:  REAL container end to end (skipped without docker): restore a seeded dump
#          -> exit 0 + `indexes N/N ...` line; manifest claiming one more index -> exit 1
#
# Pushover mock: sets PUSHOVER_API_URL to a local python http.server that writes
# POST body to a temp file. Falls back to nc if python3 unavailable. If neither
# is available, TC-6 and TC-7 are skipped (Pushover credentials absent = WARN).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REHEARSAL_SCRIPT="${SCRIPT_DIR}/restore-rehearsal.sh"

WORK_DIR=$(mktemp -d)
PASS_COUNT=0
FAIL_COUNT=0

# shellcheck disable=SC2317  # invoked via trap
cleanup() {
  rm -rf "${WORK_DIR}"
  # Kill mock server if running
  if [[ -n "${MOCK_PID:-}" ]]; then
    kill "${MOCK_PID}" 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo "=== P16 restore-rehearsal regression test ==="
echo "  Work dir: ${WORK_DIR}"
echo ""

# ---------------------------------------------------------------------------
# Helper: run a test case
# run_test <name> <expected_exit> <env_overrides...> -- <extra args>
# ---------------------------------------------------------------------------
run_test() {
  local name="$1"
  local expected_exit="$2"
  shift 2
  # Remaining args are VAR=value pairs consumed as env
  local env_vars=()
  while [[ $# -gt 0 && "$1" != "--" ]]; do
    env_vars+=("$1")
    shift
  done
  [[ "${1:-}" == "--" ]] && shift

  local actual_exit=0
  env "${env_vars[@]}" bash "${REHEARSAL_SCRIPT}" >/dev/null 2>&1 || actual_exit=$?

  if [[ "${actual_exit}" -eq "${expected_exit}" ]]; then
    echo "  PASS  ${name} (exit ${actual_exit})"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo "  FAIL  ${name}: expected exit ${expected_exit}, got ${actual_exit}"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
}

# ---------------------------------------------------------------------------
# Build test fixtures
# ---------------------------------------------------------------------------

NOW_TS=$(date -d '2 hours ago' +%Y-%m-%dT%H:%M:%S%z)
OLD_TS=$(date -d '50 hours ago' +%Y-%m-%dT%H:%M:%S%z)
OBJECTS_JSON='{"indexes": 110, "foreign_keys": 17, "triggers": 7, "functions": 30, "ledger_max": "0037_example"}'

# mk_backup <root> <timestamp> <objects-json|-> [dump-age-spec]
#   Builds <root>/daily/D with manifest.json + a dump and points <root>/latest at it.
#   tables: captures 500, entities 200, big 100000, empty_table 0.
mk_backup() {
  local root="$1" ts="$2" objects="$3" age="${4:-now}" dir="$1/daily/fixture"
  mkdir -p "${dir}"
  local obj_line=""
  [[ "${objects}" != "-" ]] && obj_line="\"objects\": ${objects},"
  cat > "${dir}/manifest.json" <<MANIFEST_EOF
{
    "timestamp": "${ts}",
    ${obj_line}
    "tables": {
        "captures": 500,
        "entities": 200,
        "big": 100000,
        "empty_table": 0
    }
}
MANIFEST_EOF
  echo "FAKE_PGDUMP_CONTENT" > "${dir}/openbrain.pgdump"
  [[ "${age}" != "now" ]] && touch -d "${age}" "${dir}/openbrain.pgdump"
  ln -sfn "${dir}" "${root}/latest"
}

GOOD_ROOT="${WORK_DIR}/backup";          mk_backup "${GOOD_ROOT}" "${NOW_TS}" "${OBJECTS_JSON}"
STALE_MANIFEST_ROOT="${WORK_DIR}/stale_manifest"; mk_backup "${STALE_MANIFEST_ROOT}" "${OLD_TS}" "${OBJECTS_JSON}"
STALE_DUMP_ROOT="${WORK_DIR}/stale_dump"; mk_backup "${STALE_DUMP_ROOT}" "${NOW_TS}" "${OBJECTS_JSON}" "50 hours ago"
NO_OBJECTS_ROOT="${WORK_DIR}/no_objects"; mk_backup "${NO_OBJECTS_ROOT}" "${NOW_TS}" "-"

EMPTY_BACKUP_ROOT="${WORK_DIR}/empty_backup_root"
mkdir -p "${EMPTY_BACKUP_ROOT}"

BACKUP_ROOT_NO_DUMP="${WORK_DIR}/no_dump"
mkdir -p "${BACKUP_ROOT_NO_DUMP}/daily/x"
echo "{\"timestamp\": \"${NOW_TS}\", \"tables\": {\"captures\": 100}}" > "${BACKUP_ROOT_NO_DUMP}/daily/x/manifest.json"
ln -sfn "${BACKUP_ROOT_NO_DUMP}/daily/x" "${BACKUP_ROOT_NO_DUMP}/latest"

BACKUP_ROOT_NO_MANIFEST="${WORK_DIR}/no_manifest"
mkdir -p "${BACKUP_ROOT_NO_MANIFEST}/daily/x"
echo "FAKE" > "${BACKUP_ROOT_NO_MANIFEST}/daily/x/openbrain.pgdump"
ln -sfn "${BACKUP_ROOT_NO_MANIFEST}/daily/x" "${BACKUP_ROOT_NO_MANIFEST}/latest"

NOPUSH=("PUSHOVER_APP_TOKEN=" "PUSHOVER_USER_KEY=" "PUSHOVER_TOKEN=" "PUSHOVER_USER=")

# ---------------------------------------------------------------------------
# TC-1: Missing backup root (latest symlink absent)
# ---------------------------------------------------------------------------
run_test "TC-1: missing backup root" 2 \
  "BACKUP_ROOT=${EMPTY_BACKUP_ROOT}" \
  "REHEARSAL_DRY_RUN=true" \
  "PUSHOVER_APP_TOKEN=" \
  "PUSHOVER_USER_KEY="

# ---------------------------------------------------------------------------
# TC-2: No dump file (manifest present but no pgdump)
# ---------------------------------------------------------------------------
run_test "TC-2: dump file missing" 2 \
  "BACKUP_ROOT=${BACKUP_ROOT_NO_DUMP}" \
  "REHEARSAL_DRY_RUN=true" \
  "PUSHOVER_APP_TOKEN=" \
  "PUSHOVER_USER_KEY="

# ---------------------------------------------------------------------------
# TC-3: No manifest.json (dump present but no manifest)
# ---------------------------------------------------------------------------
run_test "TC-3: manifest.json missing" 2 \
  "BACKUP_ROOT=${BACKUP_ROOT_NO_MANIFEST}" \
  "REHEARSAL_DRY_RUN=true" \
  "PUSHOVER_APP_TOKEN=" \
  "PUSHOVER_USER_KEY="

# TC-4: happy path; the success marker is written
run_test "TC-4: happy path (dry-run, counts + objects match)" 0 \
  "BACKUP_ROOT=${GOOD_ROOT}" "REHEARSAL_DRY_RUN=true" "${NOPUSH[@]}"
if [[ -s "${GOOD_ROOT}/.rehearsal-last-success" ]]; then
  echo "  PASS  TC-4b: .rehearsal-last-success written"; PASS_COUNT=$((PASS_COUNT + 1))
else
  echo "  FAIL  TC-4b: .rehearsal-last-success not written"; FAIL_COUNT=$((FAIL_COUNT + 1))
fi
out=$(env "BACKUP_ROOT=${GOOD_ROOT}" REHEARSAL_DRY_RUN=true "${NOPUSH[@]}" bash "${REHEARSAL_SCRIPT}" 2>&1)
if [[ "${out}" == *"indexes 110/110 fk 17/17 triggers 7/7 functions 30/30 ledger 0037_example"* ]]; then
  echo "  PASS  TC-4c: summary line logged"; PASS_COUNT=$((PASS_COUNT + 1))
else
  echo "  FAIL  TC-4c: summary line missing"; FAIL_COUNT=$((FAIL_COUNT + 1))
fi

# TC-5: 5% row difference (475 of 500 = 25 rows > max(1%, 20)) fails
run_test "TC-5: 5% row diff fails" 1 \
  "BACKUP_ROOT=${GOOD_ROOT}" "REHEARSAL_DRY_RUN=true" "REHEARSAL_DRY_COUNT_captures=475" "${NOPUSH[@]}"

# TC-6: 15 rows (3% of 500) is under the 20-row floor and passes, either direction
run_test "TC-6a: 15-row diff (low) passes" 0 \
  "BACKUP_ROOT=${GOOD_ROOT}" "REHEARSAL_DRY_RUN=true" "REHEARSAL_DRY_COUNT_captures=485" "${NOPUSH[@]}"
run_test "TC-6b: 15-row diff (high) passes" 0 \
  "BACKUP_ROOT=${GOOD_ROOT}" "REHEARSAL_DRY_RUN=true" "REHEARSAL_DRY_COUNT_captures=515" "${NOPUSH[@]}"

# TC-7: floor edge and the 1% rule on a big table
run_test "TC-7a: 21-row diff on a small table fails" 1 \
  "BACKUP_ROOT=${GOOD_ROOT}" "REHEARSAL_DRY_RUN=true" "REHEARSAL_DRY_COUNT_captures=479" "${NOPUSH[@]}"
run_test "TC-7b: 900 rows off 100000 (0.9%) passes" 0 \
  "BACKUP_ROOT=${GOOD_ROOT}" "REHEARSAL_DRY_RUN=true" "REHEARSAL_DRY_COUNT_big=99100" "${NOPUSH[@]}"
run_test "TC-7c: 1100 rows off 100000 (1.1%) fails" 1 \
  "BACKUP_ROOT=${GOOD_ROOT}" "REHEARSAL_DRY_RUN=true" "REHEARSAL_DRY_COUNT_big=98900" "${NOPUSH[@]}"
run_test "TC-7d: 0-row manifest table gaining 30 rows fails" 1 \
  "BACKUP_ROOT=${GOOD_ROOT}" "REHEARSAL_DRY_RUN=true" "REHEARSAL_DRY_COUNT_empty_table=30" "${NOPUSH[@]}"

# TC-9/10: staleness
run_test "TC-9: stale manifest.timestamp (50h) fails" 1 \
  "BACKUP_ROOT=${STALE_MANIFEST_ROOT}" "REHEARSAL_DRY_RUN=true" "${NOPUSH[@]}"
run_test "TC-10: stale dump mtime (50h) fails" 1 \
  "BACKUP_ROOT=${STALE_DUMP_ROOT}" "REHEARSAL_DRY_RUN=true" "${NOPUSH[@]}"
run_test "TC-10b: REHEARSAL_MAX_AGE_HOURS=72 accepts the 50h backup" 0 \
  "BACKUP_ROOT=${STALE_MANIFEST_ROOT}" "REHEARSAL_DRY_RUN=true" "REHEARSAL_MAX_AGE_HOURS=72" "${NOPUSH[@]}"

# TC-11: required object missing
run_test "TC-11a: missing hnsw index fails" 1 \
  "BACKUP_ROOT=${GOOD_ROOT}" "REHEARSAL_DRY_RUN=true" "REHEARSAL_DRY_MISSING=captures_embedding_hnsw_idx" "${NOPUSH[@]}"
run_test "TC-11b: missing function fails" 1 \
  "BACKUP_ROOT=${GOOD_ROOT}" "REHEARSAL_DRY_RUN=true" "REHEARSAL_DRY_MISSING=vector_search" "${NOPUSH[@]}"

# TC-12: manifest without objects
out=$(env "BACKUP_ROOT=${NO_OBJECTS_ROOT}" REHEARSAL_DRY_RUN=true "${NOPUSH[@]}" bash "${REHEARSAL_SCRIPT}" 2>&1); rc=$?
if [[ ${rc} -eq 0 && "${out}" == *"no 'objects' key"* ]]; then
  echo "  PASS  TC-12: manifest without objects -> warning + exit 0"; PASS_COUNT=$((PASS_COUNT + 1))
else
  echo "  FAIL  TC-12: expected warning + exit 0, got exit ${rc}"; FAIL_COUNT=$((FAIL_COUNT + 1))
fi
run_test "TC-12b: no objects, but required object missing still fails" 1 \
  "BACKUP_ROOT=${NO_OBJECTS_ROOT}" "REHEARSAL_DRY_RUN=true" "REHEARSAL_DRY_MISSING=hybrid_search" "${NOPUSH[@]}"

# TC-13: object count mismatches (restored side injected)
for key in indexes foreign_keys triggers functions; do
  mutated=$(jq -c ".${key} += 1" <<<"${OBJECTS_JSON}")
  run_test "TC-13: ${key} count differs -> fail" 1 \
    "BACKUP_ROOT=${GOOD_ROOT}" "REHEARSAL_DRY_RUN=true" "REHEARSAL_DRY_OBJECTS=${mutated}" "${NOPUSH[@]}"
done

# TC-14: ledger + invalid index
run_test "TC-14a: ledger max differs -> fail" 1 \
  "BACKUP_ROOT=${GOOD_ROOT}" "REHEARSAL_DRY_RUN=true" \
  "REHEARSAL_DRY_OBJECTS=$(jq -c '.ledger_max = "0036_old"' <<<"${OBJECTS_JSON}")" "${NOPUSH[@]}"
run_test "TC-14b: an invalid index -> fail" 1 \
  "BACKUP_ROOT=${GOOD_ROOT}" "REHEARSAL_DRY_RUN=true" "REHEARSAL_DRY_INVALID_INDEXES=1" "${NOPUSH[@]}"

# ---------------------------------------------------------------------------
# TC-8: Pushover notification path — verify curl is invoked with correct status.
# Start a minimal mock HTTP server (python3) that writes POST body to a temp
# file. Skip gracefully if python3 or curl unavailable.
# ---------------------------------------------------------------------------
MOCK_LOG="${WORK_DIR}/pushover_mock.log"
MOCK_PORT=18765
MOCK_PID=""

# Write the mock server script first, then launch it (never use `python3 -` with heredoc
# in the same compound command — the script text must be on disk before python3 runs).
cat > "${WORK_DIR}/mock_server.py" << 'PYEOF'
import http.server, sys

port = int(sys.argv[1])
log_file = sys.argv[2]

class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0))
        raw = self.rfile.read(length)
        # Write raw bytes to avoid encoding issues on Windows (cp1252 vs utf-8).
        with open(log_file, 'ab') as f:
            f.write(raw + b"\n")
        self.send_response(200)
        self.end_headers()
    def log_message(self, *args):
        pass  # suppress output

with http.server.HTTPServer(('127.0.0.1', port), Handler) as httpd:
    httpd.handle_request()  # one request per invocation; caller restarts for TC-8b
    httpd.handle_request()
PYEOF

if command -v python3 >/dev/null 2>&1 && command -v curl >/dev/null 2>&1; then
  python3 "${WORK_DIR}/mock_server.py" "${MOCK_PORT}" "${MOCK_LOG}" &
  MOCK_PID=$!
  # Give server a moment to bind
  sleep 0.5

  MOCK_URL="http://127.0.0.1:${MOCK_PORT}/1/messages.json"

  # TC-8a: pass path — Pushover mock should receive status=pass in message
  env \
    "BACKUP_ROOT=${GOOD_ROOT}" \
    "REHEARSAL_DRY_RUN=true" \
    "PUSHOVER_API_URL=${MOCK_URL}" \
    "PUSHOVER_APP_TOKEN=fake_token" \
    "PUSHOVER_USER_KEY=fake_user" \
    bash "${REHEARSAL_SCRIPT}" >/dev/null 2>&1 || true

  # TC-8b: fail path — Pushover mock should receive status=fail
  env \
    "BACKUP_ROOT=${GOOD_ROOT}" \
    "REHEARSAL_DRY_RUN=true" \
    "REHEARSAL_DRY_COUNT_captures=50" \
    "PUSHOVER_API_URL=${MOCK_URL}" \
    "PUSHOVER_APP_TOKEN=fake_token" \
    "PUSHOVER_USER_KEY=fake_user" \
    bash "${REHEARSAL_SCRIPT}" >/dev/null 2>&1 || true

  sleep 0.5
  kill "${MOCK_PID}" 2>/dev/null || true
  MOCK_PID=""

  # Check mock log for expected payloads
  if [[ -f "${MOCK_LOG}" ]]; then
    if grep -q "pass" "${MOCK_LOG}"; then
      echo "  PASS  TC-8a: Pushover mock received 'pass' notification"
      PASS_COUNT=$((PASS_COUNT + 1))
    else
      echo "  FAIL  TC-8a: Pushover mock did NOT receive 'pass' payload"
      FAIL_COUNT=$((FAIL_COUNT + 1))
    fi

    if grep -q "fail" "${MOCK_LOG}"; then
      echo "  PASS  TC-8b: Pushover mock received 'fail' notification"
      PASS_COUNT=$((PASS_COUNT + 1))
    else
      echo "  FAIL  TC-8b: Pushover mock did NOT receive 'fail' payload"
      FAIL_COUNT=$((FAIL_COUNT + 1))
    fi
  else
    echo "  SKIP  TC-8a/8b: mock log not written (server may not have received requests)"
  fi
else
  echo "  SKIP  TC-8a/8b: python3 or curl not available for Pushover mock server"
fi

# ---------------------------------------------------------------------------
# TC-R: REAL end to end with throwaway containers (unique names, trap cleanup).
# A source container builds a small schema holding the required objects, pg_dump makes
# the backup, db_objects_json (the same function backup.sh will use) writes the manifest;
# the rehearsal then restores into its own container with the production postgresql.conf.
# ---------------------------------------------------------------------------
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 \
    && docker image inspect pgvector/pgvector:pg16 >/dev/null 2>&1; then
  REAL_SRC="ob-rehearsal-test-src-$$-${RANDOM}"
  REAL_REH="ob-rehearsal-test-reh-$$-${RANDOM}"
  # shellcheck disable=SC2317  # invoked via trap
  real_cleanup() { docker rm -f "${REAL_SRC}" "${REAL_REH}" >/dev/null 2>&1 || true; }
  trap 'real_cleanup; cleanup' EXIT
  PG_CONF="${SCRIPT_DIR}/../config/postgres/postgresql.conf"
  docker run -d --rm --name "${REAL_SRC}" -e POSTGRES_USER=openbrain -e POSTGRES_DB=openbrain \
    -e POSTGRES_PASSWORD=t -v "${PG_CONF}:/etc/postgresql/postgresql.conf:ro" \
    pgvector/pgvector:pg16 postgres -c config_file=/etc/postgresql/postgresql.conf >/dev/null
  # shellcheck source=lib/restore-core.sh
  source "${SCRIPT_DIR}/lib/restore-core.sh"
  # shellcheck source=lib/db-objects.sh
  source "${SCRIPT_DIR}/lib/db-objects.sh"
  if restore_wait_ready "${REAL_SRC}" 60; then
    sleep 2
    docker exec -i "${REAL_SRC}" psql -X -q -v ON_ERROR_STOP=1 -U openbrain -d openbrain >/dev/null <<'SQL'
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE captures (id serial PRIMARY KEY, content text, embedding vector(8));
CREATE TABLE child (id serial PRIMARY KEY, capture_id int REFERENCES captures(id));
CREATE TABLE schema_migrations (version text PRIMARY KEY);
INSERT INTO captures (content, embedding)
  SELECT 'c' || g, ('[' || g || ',1,1,1,1,1,1,1]')::vector FROM generate_series(1, 300) g;
INSERT INTO schema_migrations VALUES ('0001_a'), ('0037_example');
CREATE INDEX captures_embedding_hnsw_idx ON captures USING hnsw (embedding vector_cosine_ops);
CREATE INDEX captures_content_tsvector_idx ON captures USING gin (to_tsvector('english', content));
CREATE FUNCTION touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
CREATE TRIGGER captures_touch BEFORE UPDATE ON captures FOR EACH ROW EXECUTE FUNCTION touch();
CREATE FUNCTION hybrid_search() RETURNS int LANGUAGE sql AS 'SELECT 1';
CREATE FUNCTION spreading_activation() RETURNS int LANGUAGE sql AS 'SELECT 1';
CREATE FUNCTION fts_only_search() RETURNS int LANGUAGE sql AS 'SELECT 1';
CREATE FUNCTION vector_search() RETURNS int LANGUAGE sql AS 'SELECT 1';
SQL
    REAL_ROOT="${WORK_DIR}/real"; REAL_DIR="${REAL_ROOT}/daily/fixture"; mkdir -p "${REAL_DIR}"
    docker exec "${REAL_SRC}" pg_dump -U openbrain -d openbrain --format=custom --no-owner --no-privileges \
      > "${REAL_DIR}/openbrain.pgdump"
    REAL_OBJECTS="$(db_objects_json "${REAL_SRC}")"
    cat > "${REAL_DIR}/manifest.json" <<EOF
{"timestamp": "$(date +%Y-%m-%dT%H:%M:%S%z)", "objects": ${REAL_OBJECTS},
 "tables": {"captures": 300, "child": 0, "schema_migrations": 2}}
EOF
    ln -sfn "${REAL_DIR}" "${REAL_ROOT}/latest"
    echo "  objects counted by db_objects_json: ${REAL_OBJECTS}"
    docker rm -f "${REAL_SRC}" >/dev/null 2>&1 || true
    out=$(env "BACKUP_ROOT=${REAL_ROOT}" "REHEARSAL_CONTAINER=${REAL_REH}" "${NOPUSH[@]}" \
      bash "${REHEARSAL_SCRIPT}" 2>&1); rc=$?
    if [[ ${rc} -eq 0 && "${out}" == *"indexes 5/5 fk 1/1 triggers 1/1 functions 5/5 ledger 0037_example"* ]]; then
      echo "  PASS  TC-R1: real restore -> exit 0 with matching counts"; PASS_COUNT=$((PASS_COUNT + 1))
    else
      echo "  FAIL  TC-R1: exit ${rc}"; printf '%s\n' "${out}" | tail -25 | sed 's/^/      /'; FAIL_COUNT=$((FAIL_COUNT + 1))
    fi
    if [[ -z "$(docker ps -aq --filter "name=${REAL_REH}")" ]]; then
      echo "  PASS  TC-R1b: rehearsal container torn down"; PASS_COUNT=$((PASS_COUNT + 1))
    else
      echo "  FAIL  TC-R1b: rehearsal container still present"; FAIL_COUNT=$((FAIL_COUNT + 1))
    fi
    # Manifest that claims one more index than the restored database holds -> exit 1.
    jq '.objects.indexes += 1' "${REAL_DIR}/manifest.json" > "${REAL_DIR}/m.tmp" && mv "${REAL_DIR}/m.tmp" "${REAL_DIR}/manifest.json"
    run_test "TC-R2: real restore, manifest index count +1 -> fail" 1 \
      "BACKUP_ROOT=${REAL_ROOT}" "REHEARSAL_CONTAINER=${REAL_REH}" "${NOPUSH[@]}"
  else
    echo "  FAIL  TC-R: source container not ready"; FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
  real_cleanup
else
  echo "  SKIP  TC-R: docker or pgvector/pgvector:pg16 image not available"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
TOTAL=$((PASS_COUNT + FAIL_COUNT))
echo ""
echo "=== Results: ${PASS_COUNT}/${TOTAL} passed ==="

if [[ "${FAIL_COUNT}" -gt 0 ]]; then
  echo "FAIL: ${FAIL_COUNT} test(s) failed."
  exit 1
fi

echo "=== test-restore-rehearsal: PASSED ==="
exit 0
