#!/usr/bin/env bash
# pushover-notify.sh — Pure-curl Pushover notifier for ops scripts.
#
# Sourced by scripts/load-secrets.sh and scripts/verify-secrets.sh.
# Do NOT set -euo pipefail here; consumers control strictness.
#
# Why pure curl? P08 disaster-recovery scenario: a freshly rebuilt homeserver
# may not have Node yet. The official PushoverService (TS, in @open-brain/shared)
# is unusable until containers are rebuilt and `.env.secrets` is hydrated —
# which is exactly what this script is helping to do. Curl is universally
# available on Unraid/Ubuntu/Alpine.
#
# Mock-friendly:
#   PUSHOVER_API_URL overrides the destination (default: api.pushover.net).
#   Tests point this at a local listener (nc / python http.server).
#
# Credentials:
#   PUSHOVER_APP_TOKEN + PUSHOVER_USER_KEY (workers) preferred.
#   Falls back to PUSHOVER_TOKEN + PUSHOVER_USER (legacy voice-capture aliases).
#   Missing both pairs -> emit warning to stderr, return 0 (NEVER fail caller).

# notify_pushover_mismatch <message>
#   Sends a priority-1 Pushover alert. Returns 0 on success, 0 on missing-creds
#   (with stderr warning), non-zero only on curl transport failure.
notify_pushover_mismatch() {
  local message="${1:-Open Brain: secrets drift detected}"
  local title="${PUSHOVER_TITLE:-Open Brain: secrets drift}"
  local priority="${PUSHOVER_PRIORITY:-1}"
  local url="${PUSHOVER_API_URL:-https://api.pushover.net/1/messages.json}"

  local token="${PUSHOVER_APP_TOKEN:-${PUSHOVER_TOKEN:-}}"
  local user="${PUSHOVER_USER_KEY:-${PUSHOVER_USER:-}}"

  if [[ -z "$token" || -z "$user" ]]; then
    echo "WARN: Pushover credentials missing (PUSHOVER_APP_TOKEN+PUSHOVER_USER_KEY or PUSHOVER_TOKEN+PUSHOVER_USER) — alert skipped" >&2
    return 0
  fi

  # -sf: silent + fail on HTTP >= 400. --max-time keeps us from blocking
  # an interactive operator if Pushover (or the mock sink) hangs.
  if ! curl -sf --max-time 10 -X POST "$url" \
      -d "token=${token}" \
      -d "user=${user}" \
      -d "title=${title}" \
      -d "message=${message}" \
      -d "priority=${priority}" >/dev/null 2>&1; then
    echo "WARN: Pushover POST to ${url} failed (curl exit $?)" >&2
    return 1
  fi
  return 0
}
