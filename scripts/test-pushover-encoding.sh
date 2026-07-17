#!/usr/bin/env bash
# test-pushover-encoding.sh — regression guard for OA-16 / Entry 227.
#
# The DR restore-rehearsal PASSES but its success Pushover failed with
# `curl exit 22` on EVERY run since 2026-06, because
# scripts/lib/pushover-notify.sh sent the body with `curl -d "message=..."`,
# which does NOT URL-encode. The rehearsal message contains "±0% tolerance";
# the bare `%` is an invalid application/x-www-form-urlencoded percent-escape,
# so Pushover rejected the whole body with HTTP 400.
#
# This test points PUSHOVER_API_URL at a strict local sink that mimics
# Pushover's percent-validation (400 on a bare `%`) and asserts BOTH notify
# functions deliver a `%`-containing message decoded byte-for-byte intact.
# It goes RED on the old `-d` code and GREEN once the fields are
# `--data-urlencode`d.
#
# CI-friendly: no real network. Skips cleanly if python3 is unavailable.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v python3 >/dev/null 2>&1; then
  echo "SKIP: python3 not available"
  exit 0
fi

WORK_DIR="$(mktemp -d)"
OUT="${WORK_DIR}/received-message.txt"
SINK_PY="${WORK_DIR}/sink.py"
SINK_PID=""

cleanup() {
  [[ -n "${SINK_PID}" ]] && kill "${SINK_PID}" 2>/dev/null
  rm -rf "${WORK_DIR}"
}
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

# A strict x-www-form-urlencoded sink, like Pushover: a `%` not followed by two
# hex digits => HTTP 400 (nothing recorded). Otherwise decode and record the
# `message` field, respond 200.
cat > "${SINK_PY}" <<'PY'
import http.server, os, re, sys, urllib.parse

OUT = os.environ["SINK_OUT"]

class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(n).decode("latin-1")
        if re.search(r"%(?![0-9A-Fa-f]{2})", raw):        # bare/invalid percent-escape
            self.send_response(400); self.end_headers()
            self.wfile.write(b'{"status":0,"errors":["bad encoding"]}')
            return
        msg = urllib.parse.parse_qs(raw).get("message", [""])[0]
        with open(OUT, "w", encoding="utf-8") as f:
            f.write(msg)
        self.send_response(200); self.end_headers()
        self.wfile.write(b'{"status":1}')

    def log_message(self, *a):  # silence
        pass

http.server.HTTPServer(("127.0.0.1", int(sys.argv[1])), Handler).serve_forever()
PY

PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"
SINK_OUT="${OUT}" python3 "${SINK_PY}" "${PORT}" &
SINK_PID=$!

# Wait for the sink to accept connections.
for _ in $(seq 1 50); do
  curl -s -o /dev/null "http://127.0.0.1:${PORT}/" && break
  sleep 0.1
done

export PUSHOVER_API_URL="http://127.0.0.1:${PORT}/1/messages.json"
export PUSHOVER_APP_TOKEN="dummy-app-token"
export PUSHOVER_USER_KEY="dummy-user-key"

# The exact shape of a real rehearsal/backup message: contains '%' and non-ASCII.
MSG="DR rehearsal PASSED: 21/21 table(s) within ±0% tolerance. 10 skipped."

# shellcheck source=lib/pushover-notify.sh
source "${SCRIPT_DIR}/lib/pushover-notify.sh"

assert_delivered_intact() {
  local label="$1"
  local got
  [[ -s "${OUT}" ]] || fail "${label}: message not delivered (sink returned 400 — body was not URL-encoded)"
  got="$(cat "${OUT}")"
  [[ "${got}" == "${MSG}" ]] || fail "${label}: message corrupted in transit: got [${got}] want [${MSG}]"
  echo "ok: ${label} delivered the message decoded intact"
}

# Case 1: notify_pushover_rehearsal (the observed OA-16 failure).
: > "${OUT}"
notify_pushover_rehearsal "pass" "${MSG}"
assert_delivered_intact "notify_pushover_rehearsal"

# Case 2: notify_pushover_mismatch (same helper, same bug class).
: > "${OUT}"
notify_pushover_mismatch "${MSG}"
assert_delivered_intact "notify_pushover_mismatch"

echo "PASS: pushover-notify.sh URL-encodes message/title — '%'-containing payloads are delivered"
exit 0
