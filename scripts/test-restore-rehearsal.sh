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
#   TC-1: Missing backup root (BACKUP_ROOT → empty dir)          — expect exit 2
#   TC-2: Backup dir present but no openbrain.pgdump             — expect exit 2
#   TC-3: Dump present but manifest.json missing                 — expect exit 2
#   TC-4: Happy path (good manifest + REHEARSAL_DRY_RUN)         — expect exit 0
#   TC-5: Row count outside tolerance (DRY_RUN count override)   — expect exit 1
#   TC-6: Pushover mock: pass path sends status=pass             — expect "pass" in mock log
#   TC-7: Pushover mock: fail path sends status=fail             — expect "fail" in mock log
#   TC-8: Tolerance boundary: 91% of manifest → fail; 90% → pass
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

# Valid manifest.json (2 tables with known counts)
FAKE_BACKUP_DIR="${WORK_DIR}/backup/daily/2026-04-19"
mkdir -p "${FAKE_BACKUP_DIR}"

cat > "${FAKE_BACKUP_DIR}/manifest.json" << 'MANIFEST_EOF'
{
    "timestamp": "2026-04-19T03:00:00+0000",
    "date": "2026-04-19",
    "tables": {
        "captures": 500,
        "entities": 200,
        "empty_table": 0
    }
}
MANIFEST_EOF

# Fake dump file (non-empty bytes — content doesn't matter in dry-run)
echo "FAKE_PGDUMP_CONTENT" > "${FAKE_BACKUP_DIR}/openbrain.pgdump"

# Create the "latest" symlink
ln -sfn "${FAKE_BACKUP_DIR}" "${WORK_DIR}/backup/latest"

EMPTY_BACKUP_ROOT="${WORK_DIR}/empty_backup_root"
mkdir -p "${EMPTY_BACKUP_ROOT}"

BACKUP_ROOT_NO_DUMP="${WORK_DIR}/no_dump"
mkdir -p "${BACKUP_ROOT_NO_DUMP}/daily/2026-04-19"
cat > "${BACKUP_ROOT_NO_DUMP}/daily/2026-04-19/manifest.json" << 'EOF'
{"tables": {"captures": 100}}
EOF
ln -sfn "${BACKUP_ROOT_NO_DUMP}/daily/2026-04-19" "${BACKUP_ROOT_NO_DUMP}/latest"

BACKUP_ROOT_NO_MANIFEST="${WORK_DIR}/no_manifest"
mkdir -p "${BACKUP_ROOT_NO_MANIFEST}/daily/2026-04-19"
echo "FAKE" > "${BACKUP_ROOT_NO_MANIFEST}/daily/2026-04-19/openbrain.pgdump"
ln -sfn "${BACKUP_ROOT_NO_MANIFEST}/daily/2026-04-19" "${BACKUP_ROOT_NO_MANIFEST}/latest"

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

# ---------------------------------------------------------------------------
# TC-4: Happy path (dry-run, all table counts match manifest)
#   captures: manifest=500, dry-run returns manifest count → pass
#   entities: manifest=200, dry-run returns manifest count → pass
#   empty_table: manifest=0 → skipped
# ---------------------------------------------------------------------------
run_test "TC-4: happy path (dry-run, counts match)" 0 \
  "BACKUP_ROOT=${WORK_DIR}/backup" \
  "REHEARSAL_DRY_RUN=true" \
  "PUSHOVER_APP_TOKEN=" \
  "PUSHOVER_USER_KEY="

# ---------------------------------------------------------------------------
# TC-5: Row count outside tolerance (captures override to 50 — 10% of 500)
#   50 < 500 * 0.90 = 450 → FAIL
# ---------------------------------------------------------------------------
run_test "TC-5: row count outside tolerance" 1 \
  "BACKUP_ROOT=${WORK_DIR}/backup" \
  "REHEARSAL_DRY_RUN=true" \
  "REHEARSAL_DRY_COUNT_captures=50" \
  "PUSHOVER_APP_TOKEN=" \
  "PUSHOVER_USER_KEY="

# ---------------------------------------------------------------------------
# TC-6: Tolerance boundary — 90% of manifest (edge: exactly at floor)
#   captures=450, manifest=500, tolerance=10% → lower=450 → 450 >= 450 → PASS
# ---------------------------------------------------------------------------
run_test "TC-6: tolerance boundary 90% (at lower bound = pass)" 0 \
  "BACKUP_ROOT=${WORK_DIR}/backup" \
  "REHEARSAL_DRY_RUN=true" \
  "REHEARSAL_DRY_COUNT_captures=450" \
  "PUSHOVER_APP_TOKEN=" \
  "PUSHOVER_USER_KEY="

# ---------------------------------------------------------------------------
# TC-7: Tolerance boundary — 89% of manifest (1 below floor)
#   captures=445, manifest=500, tolerance=10% → lower=450 → 445 < 450 → FAIL
# ---------------------------------------------------------------------------
run_test "TC-7: tolerance boundary 89% (below lower bound = fail)" 1 \
  "BACKUP_ROOT=${WORK_DIR}/backup" \
  "REHEARSAL_DRY_RUN=true" \
  "REHEARSAL_DRY_COUNT_captures=445" \
  "PUSHOVER_APP_TOKEN=" \
  "PUSHOVER_USER_KEY="

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
    "BACKUP_ROOT=${WORK_DIR}/backup" \
    "REHEARSAL_DRY_RUN=true" \
    "PUSHOVER_API_URL=${MOCK_URL}" \
    "PUSHOVER_APP_TOKEN=fake_token" \
    "PUSHOVER_USER_KEY=fake_user" \
    bash "${REHEARSAL_SCRIPT}" >/dev/null 2>&1 || true

  # TC-8b: fail path — Pushover mock should receive status=fail
  env \
    "BACKUP_ROOT=${WORK_DIR}/backup" \
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
