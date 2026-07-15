#!/usr/bin/env bash
# test-secrets-roundtrip.sh — End-to-end fixture for P08 secret delivery.
#
# Mirrors scripts/test-backup-secrets-redaction.sh (P04b) patterns: ephemeral
# mktemp work dir, trap cleanup, fake fixtures, deterministic grep assertions,
# pass/fail counters, exit 0 only on full pass.
#
# Coverage (5 cases, per IMPLEMENT_PHASE-P08.md item 6):
#   6.1 Happy path: --target-dir writes 13 required + present optionals,
#       chmod 0600, .sha256 exists, --verify-hash exits 0.
#   6.2 Drift detection: hand-edit .env.secrets, --verify-hash exits 4 and
#       Pushover sink received POST.
#   6.3 Missing required: mock BWS omits POSTGRES_PASSWORD, exit 2,
#       no .env.secrets written.
#   6.4 Refuse clobber: load-secrets.sh against existing => exit 3;
#       --force => exit 0.
#   6.5 verify-secrets.sh table: drop a key, confirm DRIFT row appears.
#
# CI-friendly: NO real BWS or Pushover calls. Mocks via:
#   - fake bws shell script in $WORK_DIR/bin/ exposed via BWS_BIN env.
#   - Pushover sink: a small bash listener using `nc -l` (or python http.server
#     fallback) bound to a free localhost port; PUSHOVER_API_URL points at it.
#
# Secrets policy: NEVER prints fake-secret values. After every test the script
# greps stdout/stderr capture for known fake values and FAILS if any leaked
# (mirrors P04b discipline).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# -----------------------------------------------------------------------------
# Test infra
# -----------------------------------------------------------------------------
PASS=0
FAIL=0
declare -a FAILED_TESTS=()

WORK_DIR="$(mktemp -d)"
APP_DIR="${WORK_DIR}/app"
BIN_DIR="${WORK_DIR}/bin"
SINK_LOG="${WORK_DIR}/pushover-sink.log"
SINK_PID=""

mkdir -p "${APP_DIR}" "${BIN_DIR}"

cleanup() {
  if [[ -n "${SINK_PID}" ]] && kill -0 "${SINK_PID}" 2>/dev/null; then
    kill "${SINK_PID}" 2>/dev/null || true
    wait "${SINK_PID}" 2>/dev/null || true
  fi
  rm -rf "${WORK_DIR}"
}
trap cleanup EXIT

echo "=== test-secrets-roundtrip ==="
echo "  Work dir: ${WORK_DIR}"

# -----------------------------------------------------------------------------
# Build mock bws — emits canned JSON for `bws secret list --output json`.
# Reads desired keyset from $MOCK_BWS_KEYSET (file with one BWS-name per line)
# and emits {key, value} entries with fake values.
# -----------------------------------------------------------------------------
cat > "${BIN_DIR}/bws" <<'MOCK_BWS'
#!/usr/bin/env bash
# Mock bws: ignores BWS_ACCESS_TOKEN, reads $MOCK_BWS_KEYSET, emits JSON.
set -uo pipefail

# We accept any subcommand chain; we only honor "secret list".
case "${1:-}" in
  secret)
    case "${2:-}" in
      list)
        if [[ ! -f "${MOCK_BWS_KEYSET:-}" ]]; then
          echo "[]"
          exit 0
        fi
        # Build JSON array. Use python3 if available for safe escaping;
        # fall back to manual.
        if command -v python3 >/dev/null 2>&1; then
          python3 - <<PY
import json, os
keyset = os.environ["MOCK_BWS_KEYSET"]
with open(keyset) as f:
    keys = [k.strip() for k in f if k.strip() and not k.startswith("#")]
out = [{"id": f"id-{i}", "key": k, "value": f"FAKEVAL_{k}", "note": "", "projectId": "p", "organizationId": "o", "creationDate": "2026-01-01T00:00:00Z", "revisionDate": "2026-01-01T00:00:00Z"} for i, k in enumerate(keys)]
print(json.dumps(out))
PY
        else
          echo "ERROR: python3 required for mock bws JSON encoding" >&2
          exit 1
        fi
        ;;
      *)
        echo "[mock-bws] unsupported: secret $2" >&2
        exit 1
        ;;
    esac
    ;;
  *)
    echo "[mock-bws] unsupported: $*" >&2
    exit 1
    ;;
esac
MOCK_BWS
chmod +x "${BIN_DIR}/bws"

export BWS_BIN="${BIN_DIR}/bws"
export BWS_ACCESS_TOKEN="mock-token-not-used"

# -----------------------------------------------------------------------------
# Build initial keyset = ALL required + 2 optional (DEEPGRAM, ANTHROPIC).
# This is the source of truth for what mock BWS exposes per test case.
# -----------------------------------------------------------------------------
KEYSET_FILE="${WORK_DIR}/bws-keyset.txt"

# Derive the mock's REQUIRED keyset FROM secrets-map.sh instead of duplicating it.
#
# This list used to be a hardcoded literal, which made it a second source of
# truth that rots silently: #278 corrected 11 BWS names and every test here
# broke, because the fixture still asserted the old ones.
#
# IMPORTANT — what this fixture can and cannot prove. Deriving the keyset means
# the mock now agrees with the map BY CONSTRUCTION, so these tests verify the
# MECHANISM (parse, write, 0600, hash sidecar, clobber rules) and never the
# NAMES. They are structurally incapable of catching drift between the map and
# the REAL Bitwarden store — which is exactly how #278 hid: a fully green suite
# asserted nothing about the thing that was broken. Catching that needs a
# recorded real-BWS key inventory (names only, no values), which is the
# remaining #278 DoD item. Do not mistake this file's green for "DR works".
# shellcheck source=lib/secrets-map.sh
source "${REPO_ROOT}/scripts/lib/secrets-map.sh"
{
  printf '%s\n' "${!REQUIRED_SECRETS[@]}"
  # Two optional keys the fixture exercises; the rest are intentionally absent
  # so the "optional missing is silently skipped" path stays covered.
  printf '%s\n' "OPENCLAW_DEEPGRAM_API_KEY" "OPENCLAW_ANTHROPIC_API_KEY"
} > "${KEYSET_FILE}"

export MOCK_BWS_KEYSET="${KEYSET_FILE}"

# -----------------------------------------------------------------------------
# Pushover sink: tiny python http server logging POSTs to a file.
# (More portable than `nc -l` across msys/Linux variants.)
# -----------------------------------------------------------------------------
start_pushover_sink() {
  if ! command -v python3 >/dev/null 2>&1; then
    echo "ERROR: python3 required for Pushover sink" >&2
    exit 99
  fi
  # Find a free port by binding ephemerally.
  local port
  port="$(python3 - <<'PY'
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PY
)"
  python3 - "$port" "${SINK_LOG}" >/dev/null 2>&1 &
  SINK_PID=$!
  PUSHOVER_PORT="$port"
  export PUSHOVER_API_URL="http://127.0.0.1:${port}/messages.json"
  # Wait up to 2s for sink to be ready.
  for _ in $(seq 1 20); do
    if curl -sf "http://127.0.0.1:${port}/__healthz" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

# Inline python sink server (writes one line per POST to SINK_LOG).
cat > "${WORK_DIR}/sink.py" <<'PY'
import sys, socketserver, http.server, urllib.parse
PORT = int(sys.argv[1])
LOG  = sys.argv[2]

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_a, **_kw): pass
    def do_GET(self):
        if self.path == "/__healthz":
            self.send_response(200); self.end_headers(); self.wfile.write(b"ok")
            return
        self.send_response(404); self.end_headers()
    def do_POST(self):
        ln = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(ln).decode("utf-8", "replace")
        with open(LOG, "a") as f:
            f.write(self.path + "\t" + body + "\n")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"status":1}')

# Allow port reuse so kill+restart is cheap.
socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(("127.0.0.1", PORT), Handler) as srv:
    srv.serve_forever()
PY

# Override the sink launcher to use our written script (heredoc + bg).
start_pushover_sink() {
  if ! command -v python3 >/dev/null 2>&1; then
    echo "ERROR: python3 required for Pushover sink" >&2
    exit 99
  fi
  local port
  port="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"
  python3 "${WORK_DIR}/sink.py" "$port" "${SINK_LOG}" &
  SINK_PID=$!
  export PUSHOVER_API_URL="http://127.0.0.1:${port}/messages.json"
  for _ in $(seq 1 30); do
    if curl -sf "http://127.0.0.1:${port}/__healthz" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

if ! start_pushover_sink; then
  echo "ERROR: Pushover sink failed to start" >&2
  exit 99
fi
echo "  Pushover sink: ${PUSHOVER_API_URL} (log: ${SINK_LOG})"

# Pushover creds (used for hash-mismatch alert). Fake values.
export PUSHOVER_APP_TOKEN="fake_app_token_for_test"
export PUSHOVER_USER_KEY="fake_user_key_for_test"

# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------
ok()   { PASS=$((PASS+1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL+1)); FAILED_TESTS+=("$1"); echo "  FAIL: $1"; }

# Run a load-secrets / verify-secrets command capturing stdout+stderr+exit.
# Captures into a per-test scratch file we can grep, but never leaks values
# to test stdout. Sets RC, OUT_FILE for caller.
run_capture() {
  local label="$1"; shift
  OUT_FILE="${WORK_DIR}/${label}.out"
  if "$@" > "${OUT_FILE}" 2>&1; then
    RC=0
  else
    RC=$?
  fi
}

# Fail if any FAKEVAL_* string leaked into the captured output.
assert_no_secret_leak() {
  local out_file="$1" label="$2"
  if grep -qE 'FAKEVAL_[A-Za-z0-9/_-]+' "${out_file}"; then
    fail "${label}: FAKEVAL_* string leaked into output (${out_file})"
    return 1
  fi
  return 0
}

reset_app_dir() {
  rm -rf "${APP_DIR}"
  mkdir -p "${APP_DIR}"
}

# -----------------------------------------------------------------------------
# Test 6.1 — Happy path: full reconcile + verify-hash
# -----------------------------------------------------------------------------
echo ""
echo "[6.1] Happy path: full reconcile writes .env.secrets + sha sidecar"
reset_app_dir
run_capture 6.1-load bash "${REPO_ROOT}/scripts/load-secrets.sh" --target-dir "${APP_DIR}"

if (( RC != 0 )); then
  fail "6.1: load-secrets.sh exited ${RC} (expected 0)"
elif [[ ! -f "${APP_DIR}/.env.secrets" ]]; then
  fail "6.1: .env.secrets not created"
elif [[ ! -f "${APP_DIR}/.env.secrets.sha256" ]]; then
  fail "6.1: .env.secrets.sha256 not created"
else
  mode="$(stat -c '%a' "${APP_DIR}/.env.secrets" 2>/dev/null || stat -f '%Mp%Lp' "${APP_DIR}/.env.secrets")"
  # On msys/cygwin/Windows the filesystem can't honor POSIX 0600; chmod is a no-op
  # there. Skip the strict check in that case (Linux/Unraid CI enforces it).
  is_windows_fs="false"
  case "$(uname -s 2>/dev/null)" in
    MINGW*|MSYS*|CYGWIN*) is_windows_fs="true" ;;
  esac
  if [[ "$mode" != "600" && "$is_windows_fs" != "true" ]]; then
    fail "6.1: .env.secrets mode is ${mode} (expected 600)"
  else
    # Count required + optional lines (KEY= prefix).
    line_count=$(grep -cE '^[A-Z_][A-Z0-9_]*=' "${APP_DIR}/.env.secrets")
    if (( line_count < 13 )); then
      fail "6.1: only ${line_count} KEY= lines (expected >= 13)"
    else
      assert_no_secret_leak "${OUT_FILE}" "6.1-stdout" && \
        ok "6.1: load-secrets wrote ${line_count} keys, mode 600, sha sidecar present"
    fi
  fi
fi

# Verify-hash on the freshly written file should pass.
run_capture 6.1-verify bash "${REPO_ROOT}/scripts/load-secrets.sh" --verify-hash --target-dir "${APP_DIR}"
if (( RC != 0 )); then
  fail "6.1-verify: --verify-hash on fresh file exited ${RC} (expected 0)"
else
  assert_no_secret_leak "${OUT_FILE}" "6.1-verify-stdout" && \
    ok "6.1-verify: --verify-hash matches"
fi

# -----------------------------------------------------------------------------
# Test 6.2 — Drift detection: tamper, --verify-hash exits 4, Pushover received POST
# -----------------------------------------------------------------------------
echo ""
echo "[6.2] Drift detection: tamper + --verify-hash exits 4 + Pushover fires"
# Truncate the sink log so we can assert a NEW post arrived.
: > "${SINK_LOG}"

# Append a comment line to perturb sha (harmless to content, fatal to hash).
echo "# tampered-by-test" >> "${APP_DIR}/.env.secrets"

run_capture 6.2-verify bash "${REPO_ROOT}/scripts/load-secrets.sh" --verify-hash --target-dir "${APP_DIR}"
if (( RC != 4 )); then
  fail "6.2: --verify-hash after tamper exited ${RC} (expected 4)"
else
  # Give the sink a brief moment to flush.
  sleep 0.2
  if [[ ! -s "${SINK_LOG}" ]]; then
    fail "6.2: Pushover sink received nothing"
  elif ! grep -q "title=" "${SINK_LOG}"; then
    fail "6.2: Pushover sink log missing title= field"
  elif ! grep -q "priority=1" "${SINK_LOG}"; then
    fail "6.2: Pushover sink log missing priority=1 field"
  else
    assert_no_secret_leak "${OUT_FILE}" "6.2-stdout" && \
      ok "6.2: drift -> exit 4 + Pushover POST received"
  fi
fi

# -----------------------------------------------------------------------------
# Test 6.3 — Missing required: mock BWS omits POSTGRES_PASSWORD => exit 2, no file
# -----------------------------------------------------------------------------
echo ""
echo "[6.3] Missing required key: exit 2, refuse partial write"
reset_app_dir

# Build keyset MINUS POSTGRES_PASSWORD.
SHORT_KEYSET="${WORK_DIR}/bws-keyset-short.txt"
grep -v '^open-brain-postgres-password$' "${KEYSET_FILE}" > "${SHORT_KEYSET}"
export MOCK_BWS_KEYSET="${SHORT_KEYSET}"

run_capture 6.3-load bash "${REPO_ROOT}/scripts/load-secrets.sh" --target-dir "${APP_DIR}"
if (( RC != 2 )); then
  fail "6.3: exit ${RC} (expected 2)"
elif [[ -f "${APP_DIR}/.env.secrets" ]]; then
  fail "6.3: partial .env.secrets was written (should not exist)"
elif ! grep -q "POSTGRES_PASSWORD" "${OUT_FILE}"; then
  fail "6.3: stderr does not mention missing POSTGRES_PASSWORD"
else
  assert_no_secret_leak "${OUT_FILE}" "6.3-stdout" && \
    ok "6.3: missing required => exit 2, no file, listed in stderr"
fi

# Restore full keyset.
export MOCK_BWS_KEYSET="${KEYSET_FILE}"

# -----------------------------------------------------------------------------
# Test 6.4 — Refuse clobber without --force; --force succeeds.
# -----------------------------------------------------------------------------
echo ""
echo "[6.4] Refuse clobber without --force; --force overwrites"
reset_app_dir

# First write — should succeed.
run_capture 6.4a bash "${REPO_ROOT}/scripts/load-secrets.sh" --target-dir "${APP_DIR}"
if (( RC != 0 )); then
  fail "6.4a: initial write exited ${RC} (expected 0)"
fi

# Second write without --force — should refuse with exit 3.
run_capture 6.4b bash "${REPO_ROOT}/scripts/load-secrets.sh" --target-dir "${APP_DIR}"
if (( RC != 3 )); then
  fail "6.4b: second write without --force exited ${RC} (expected 3)"
elif ! grep -q -- "--force" "${OUT_FILE}"; then
  fail "6.4b: stderr does not mention --force"
fi

# Third write with --force — should succeed.
run_capture 6.4c bash "${REPO_ROOT}/scripts/load-secrets.sh" --force --target-dir "${APP_DIR}"
if (( RC != 0 )); then
  fail "6.4c: --force exited ${RC} (expected 0)"
else
  assert_no_secret_leak "${OUT_FILE}" "6.4c-stdout" && \
    ok "6.4: refuse clobber without --force; --force succeeds"
fi

# -----------------------------------------------------------------------------
# Test 6.5 — verify-secrets.sh table reports DRIFT for missing key.
# -----------------------------------------------------------------------------
echo ""
echo "[6.5] verify-secrets.sh: DRIFT row appears for missing required key"

# Hand-edit .env.secrets to remove SLACK_BOT_TOKEN line.
grep -v '^SLACK_BOT_TOKEN=' "${APP_DIR}/.env.secrets" > "${APP_DIR}/.env.secrets.edited"
mv "${APP_DIR}/.env.secrets.edited" "${APP_DIR}/.env.secrets"
chmod 0600 "${APP_DIR}/.env.secrets"

run_capture 6.5 bash "${REPO_ROOT}/scripts/verify-secrets.sh" --target-dir "${APP_DIR}"
if (( RC != 1 )); then
  fail "6.5: verify-secrets.sh exited ${RC} (expected 1 — drift)"
elif ! grep -E '\| SLACK_BOT_TOKEN \|.*\| DRIFT \|' "${OUT_FILE}" >/dev/null; then
  fail "6.5: DRIFT row for SLACK_BOT_TOKEN not found in table"
else
  assert_no_secret_leak "${OUT_FILE}" "6.5-stdout" && \
    ok "6.5: verify-secrets reports DRIFT row + exit 1"
fi

echo ""
echo "[6.6] Bootstrap BWS_ACCESS_TOKEN line preserved across --force rewrite (OA-4b)"
reset_app_dir
run_capture 6.6a bash "${REPO_ROOT}/scripts/load-secrets.sh" --target-dir "${APP_DIR}"
if (( RC != 0 )); then
  fail "6.6a: initial write exited ${RC} (expected 0)"
fi
BOOTSTRAP_SENTINEL="bootstrap-preserve-me-0123"
printf 'BWS_ACCESS_TOKEN=%s\n' "${BOOTSTRAP_SENTINEL}" >> "${APP_DIR}/.env.secrets"
run_capture 6.6b bash "${REPO_ROOT}/scripts/load-secrets.sh" --force --target-dir "${APP_DIR}"
if (( RC != 0 )); then
  fail "6.6b: --force exited ${RC} (expected 0)"
elif ! grep -q "^BWS_ACCESS_TOKEN=${BOOTSTRAP_SENTINEL}\$" "${APP_DIR}/.env.secrets"; then
  fail "6.6b: bootstrap BWS_ACCESS_TOKEN line not preserved after --force"
else
  n=$(grep -cE '^BWS_ACCESS_TOKEN=' "${APP_DIR}/.env.secrets" || true)
  if (( n != 1 )); then
    fail "6.6b: expected exactly 1 BWS_ACCESS_TOKEN line, found ${n}"
  else
    assert_no_secret_leak "${OUT_FILE}" "6.6b-stdout" && \
      ok "6.6: bootstrap token preserved exactly once across --force rewrite"
  fi
fi

# -----------------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------------
echo ""
TOTAL=$((PASS + FAIL))
if (( FAIL == 0 )); then
  echo "=== test-secrets-roundtrip: PASSED (${PASS}/${TOTAL}) ==="
  exit 0
fi

echo "=== test-secrets-roundtrip: FAILED (${PASS}/${TOTAL}) ==="
echo "Failures:"
for t in "${FAILED_TESTS[@]}"; do
  echo "  - $t"
done
exit 1
