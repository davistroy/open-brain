#!/usr/bin/env bash
# check-deploy-parity-cron.sh — the SCHEDULED drift alarm for #302.
#
# check-deploy-parity.sh answers "is production running main's compose?" but
# nothing ran it, so drift stayed silent BETWEEN deploys — which is exactly how
# PR #244's /backup-latest mount (and thus the #294 dead-man's switch) sat
# undeployed for a month. A deploy-time gate cannot catch drift that accumulates
# because nobody deploys. This wrapper closes that: run it from cron and it turns
# drift into a Pushover.
#
# Exit-code handling mirrors the gate:
#   0  parity        → silent (log only); one "back in parity" notice after a bad run
#   1  DRIFT         → priority-1 Pushover; production is stale, reconcile
#   2  cannot run    → priority-1 Pushover; a check that can't compare must NOT
#                      look like it passed (#303's lesson), so alarm on it too
#
# Notify-on-change (Phase 4 / item 4.1): the check reports the same drift every day
# until the first clean deploy, so a daily push would train the owner to ignore it.
# The wrapper fingerprints each result (exit code + the sorted finding lines — the
# STALE/TREE/ALERT/FILE/IMAGE/NOTRUNNING/ERROR lines, never the chatter) and keeps
#   <sha256> <exit code> <epoch of last notification>
# in PARITY_STATE_FILE (default /var/log/open-brain-parity.state, beside the log).
# It notifies when the fingerprint changes and again once 7 days have passed since the
# last notification. /var/log is RAM on Unraid: a reboot clears the state and the next
# run notifies once. Exit code 2 follows the same rule — never silenced, only throttled.
#
# Pushover creds come from the environment. Cron env is bare, so the cron LINE
# must source .env.secrets (see deploy/cron/unraid-parity-check.cron). PARITY_HOST
# / PARITY_APP_DIR are honored by the underlying gate.
#
# Test hooks (scripts/test-check-deploy-parity.sh): PARITY_CHECK_SCRIPT, PARITY_NOTIFY_LIB,
# PARITY_STATE_FILE, PARITY_NOW (epoch seconds).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECK="${PARITY_CHECK_SCRIPT:-${SCRIPT_DIR}/check-deploy-parity.sh}"
STATE_FILE="${PARITY_STATE_FILE:-/var/log/open-brain-parity.state}"
RENOTIFY_SECS=$((7 * 86400))
NOW="${PARITY_NOW:-$(date +%s)}"
# shellcheck source=lib/pushover-notify.sh disable=SC1091
source "${PARITY_NOTIFY_LIB:-${SCRIPT_DIR}/lib/pushover-notify.sh}"

echo "=== compose parity check: $(date +%Y-%m-%dT%H:%M:%S%z) ==="
OUT="$(bash "$CHECK" 2>&1)"
RC=$?
printf '%s\n' "$OUT"

FINDINGS="$(printf '%s\n' "$OUT" | grep -E '^(STALE|NOTRUNNING|IMAGE|TREE|ALERT|FILE|ERROR)[ :]' | LC_ALL=C sort -u || true)"
SHA="$(printf 'rc=%s\n%s\n' "$RC" "$FINDINGS" | sha256sum | awk '{print $1}')"

PREV_SHA="" PREV_RC="" PREV_T=""
if [ -r "$STATE_FILE" ]; then
  read -r PREV_SHA PREV_RC PREV_T < "$STATE_FILE" || true
fi
case "$PREV_T" in ''|*[!0-9]*) PREV_SHA="" PREV_RC="" PREV_T="" ;; esac

NOTIFY=0
if [ "$RC" -ne 0 ]; then
  if [ "$SHA" != "$PREV_SHA" ]; then
    NOTIFY=1
  elif [ $((NOW - PREV_T)) -ge "$RENOTIFY_SECS" ]; then
    NOTIFY=1
  fi
elif [ -n "$PREV_RC" ] && [ "$PREV_RC" != "0" ]; then
  NOTIFY=1   # recovered
fi

SUMMARY="$(printf '%s\n' "$FINDINGS" | head -8 | tr '\n' ';')"
if [ "$NOTIFY" = 1 ]; then
  case "$RC" in
    0)
      PUSHOVER_TITLE="Open Brain: compose parity restored" PUSHOVER_PRIORITY=0 \
        notify_pushover_mismatch "Deploy parity check is clean again (all layers)." || true
      ;;
    1)
      PUSHOVER_TITLE="Open Brain: deploy DRIFT" PUSHOVER_PRIORITY=1 \
        notify_pushover_mismatch "Production is NOT running main (#302). Findings: ${SUMMARY} See /var/log/open-brain-parity.log." || true
      ;;
    *)
      PUSHOVER_TITLE="Open Brain: deploy parity check could NOT run" PUSHOVER_PRIORITY=1 \
        notify_pushover_mismatch "check-deploy-parity.sh exited ${RC} - a layer could not compare. Do NOT assume parity. ${SUMMARY}" || true
      ;;
  esac
  echo "  notified (rc=${RC})."
  STATE_T="$NOW"
else
  echo "  no notification (rc=${RC}, fingerprint unchanged or parity steady)."
  STATE_T="${PREV_T:-$NOW}"
fi
if ! printf '%s %s %s\n' "$SHA" "$RC" "$STATE_T" > "$STATE_FILE" 2>/dev/null; then
  echo "WARN: cannot write ${STATE_FILE}; the next run will notify again" >&2
fi

exit "$RC"
