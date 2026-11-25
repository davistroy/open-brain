#!/usr/bin/env bash
# test-migrate-manual.sh — regression harness for scripts/migrate-manual.sh (item 6.1).
# Runs the script against a throwaway pgvector container and a temp migrations dir.
# Requires: docker, psql on PATH. Exit 0 = all cases pass, 1 = any failure.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="${REPO_ROOT}/scripts/migrate-manual.sh"
IMAGE="pgvector/pgvector:pg16"
CONTAINER="ob-migrate-test-$$"
DB_USER="mig"; DB_NAME="mig"; DB_PASS="fakePw7Qx9zz"   # throwaway test credentials (distinctive: grepped for)
TMP="$(mktemp -d)"
FAILS=0

cleanup() {
  docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
  rm -rf "${TMP}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker run -d --name "${CONTAINER}" \
  -e POSTGRES_DB="${DB_NAME}" -e POSTGRES_USER="${DB_USER}" -e POSTGRES_PASSWORD="${DB_PASS}" \
  -p 127.0.0.1::5432 "${IMAGE}" >/dev/null || { echo "FAIL: could not start container"; exit 1; }
PORT="$(docker port "${CONTAINER}" 5432/tcp | head -n1 | sed 's/.*://')"
export POSTGRES_URL="postgresql://${DB_USER}:${DB_PASS}@127.0.0.1:${PORT}/${DB_NAME}"

ready=0
for _ in $(seq 1 60); do
  # Two consecutive successes over TCP: the image restarts postgres once after init.
  if psql "${POSTGRES_URL}" -tAc 'SELECT 1' >/dev/null 2>&1; then
    sleep 2
    psql "${POSTGRES_URL}" -tAc 'SELECT 1' >/dev/null 2>&1 && { ready=1; break; }
  fi
  sleep 1
done
[[ "$ready" == 1 ]] || { echo "FAIL: postgres not ready"; exit 1; }

q() { psql "${POSTGRES_URL}" -tAq -c "$1"; }
pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAILS=$((FAILS + 1)); }
check() { # $1 = name, $2 = expected, $3 = actual
  if [[ "$2" == "$3" ]]; then pass "$1"; else fail "$1 (expected '$2', got '$3')"; fi
}

export MIGRATIONS_DIR="${TMP}/migrations"
mkdir -p "${MIGRATIONS_DIR}"

# --- Case 1: --dry-run lists pending, changes nothing -------------------------
cat > "${MIGRATIONS_DIR}/0001_ok.sql" <<'SQL'
CREATE TABLE t_ok (id int);
SQL
out="$(bash "$SCRIPT" --dry-run 2>&1)"
[[ "$out" == *0001_ok* ]] && pass "dry-run lists pending migration" || fail "dry-run lists pending migration"
check "dry-run creates no object" "" "$(q "SELECT to_regclass('t_ok')")"

# --- Case 2: successful apply writes object + ledger row ----------------------
bash "$SCRIPT" >/dev/null 2>&1
check "apply creates object" "t_ok" "$(q "SELECT to_regclass('t_ok')")"
check "apply writes ledger row" "1" "$(q "SELECT count(*) FROM schema_migrations WHERE version='0001_ok'")"
want="$(sha256sum "${MIGRATIONS_DIR}/0001_ok.sql" | cut -d' ' -f1)"
check "ledger checksum is file sha256" "$want" "$(q "SELECT checksum FROM schema_migrations WHERE version='0001_ok'")"

# --- Case 3: failing second statement => atomic rollback ----------------------
cat > "${MIGRATIONS_DIR}/0002_bad.sql" <<'SQL'
CREATE TABLE t_partial (id int);
INSERT INTO table_that_does_not_exist VALUES (1);
SQL
if bash "$SCRIPT" >/dev/null 2>&1; then fail "failing migration exits non-zero"; else pass "failing migration exits non-zero"; fi
check "failed migration leaves no object from statement 1" "" "$(q "SELECT to_regclass('t_partial')")"
check "failed migration leaves no ledger row" "0" "$(q "SELECT count(*) FROM schema_migrations WHERE version='0002_bad'")"
rm -f "${MIGRATIONS_DIR}/0002_bad.sql"

# --- Case 4: no-transaction marker applies + ledger row + notice --------------
cat > "${MIGRATIONS_DIR}/0003_notx.sql" <<'SQL'
-- migrate:no-transaction
CREATE TABLE t_notx (id int);
CREATE INDEX CONCURRENTLY t_notx_idx ON t_notx (id);
SQL
out="$(bash "$SCRIPT" 2>&1)"; rc=$?
check "no-transaction migration exits 0" "0" "$rc"
check "no-transaction migration applied" "t_notx_idx" "$(q "SELECT to_regclass('t_notx_idx')")"
check "no-transaction migration ledger row" "1" "$(q "SELECT count(*) FROM schema_migrations WHERE version='0003_notx'")"
[[ "$out" == *no-transaction* ]] && pass "no-transaction notice printed" || fail "no-transaction notice printed"

# --- Case 5: --status, incl. checksum mismatch warning ------------------------
out="$(bash "$SCRIPT" --status 2>&1)"
[[ "$out" == *"[applied] 0001_ok"* ]] && pass "status shows applied" || fail "status shows applied"
[[ "$out" != *"checksum mismatch"* ]] && pass "status: no warning when checksums match" || fail "status: no warning when checksums match"
echo "-- edited after apply" >> "${MIGRATIONS_DIR}/0001_ok.sql"
out="$(bash "$SCRIPT" --status 2>&1)"
[[ "$out" == *"checksum mismatch for 0001_ok"* ]] && pass "status warns on checksum mismatch" || fail "status warns on checksum mismatch"
[[ "$out" != *"checksum mismatch for 0003_notx"* ]] && pass "status: no warning for unchanged file" || fail "status: no warning for unchanged file"

# --- Case 6: --baseline records without running -------------------------------
cat > "${MIGRATIONS_DIR}/0004_base.sql" <<'SQL'
CREATE TABLE t_base (id int);
SQL
bash "$SCRIPT" --baseline 0004 >/dev/null 2>&1
check "baseline records ledger row" "1" "$(q "SELECT count(*) FROM schema_migrations WHERE version='0004_base'")"
check "baseline does not run the file" "" "$(q "SELECT to_regclass('t_base')")"
out="$(bash "$SCRIPT" --dry-run 2>&1)"
[[ "$out" == *"nothing"* || "$out" == *"up to date"* ]] && pass "dry-run after baseline: none pending" || fail "dry-run after baseline: none pending"

# --- Case 7: the password is never printed (--status, --dry-run, apply) -------
out="$(bash "$SCRIPT" --status 2>&1; bash "$SCRIPT" --dry-run 2>&1; bash "$SCRIPT" 2>&1)"
[[ "$out" != *"${DB_PASS}"* ]] && pass "password absent from all output" || fail "password absent from all output"
[[ "$out" == *"${DB_USER}:***@"* ]] && pass "status prints the masked URL (user:***@)" || fail "status prints the masked URL (user:***@)"

# --- Case 8: the password never reaches a psql argv (visible in ps) ------------
REAL_PSQL="$(command -v psql)"
mkdir -p "${TMP}/bin"
cat > "${TMP}/bin/psql" <<SH
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "${TMP}/psql-argv.log"
exec "${REAL_PSQL}" "\$@"
SH
chmod +x "${TMP}/bin/psql"
: > "${TMP}/psql-argv.log"
cat > "${MIGRATIONS_DIR}/0005_argv.sql" <<'SQL'
CREATE TABLE t_argv (id int);
SQL
PATH="${TMP}/bin:${PATH}" bash "$SCRIPT" --status >/dev/null 2>&1
PATH="${TMP}/bin:${PATH}" bash "$SCRIPT" >/dev/null 2>&1
check "apply through the shim still works" "t_argv" "$(q "SELECT to_regclass('t_argv')")"
[[ -s "${TMP}/psql-argv.log" ]] && pass "psql shim was called" || fail "psql shim was called"
if grep -q -- "${DB_PASS}" "${TMP}/psql-argv.log"; then fail "password absent from psql argv"; else pass "password absent from psql argv"; fi

echo
if (( FAILS == 0 )); then echo "test-migrate-manual: ALL PASSED"; exit 0; fi
echo "test-migrate-manual: ${FAILS} FAILED"; exit 1
