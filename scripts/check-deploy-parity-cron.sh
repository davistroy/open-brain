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
#   0  parity        → silent (log only)
#   1  DRIFT         → priority-1 Pushover; production is stale, reconcile
#   2  cannot run    → priority-1 Pushover; a check that can't compare must NOT
#                      look like it passed (#303's lesson), so alarm on it too
#
# Pushover creds come from the environment. Cron env is bare, so the cron LINE
# must source .env.secrets (see deploy/cron/unraid-parity-check.cron). PARITY_HOST
# / PARITY_APP_DIR are honored by the underlying gate.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/pushover-notify.sh
source "${SCRIPT_DIR}/lib/pushover-notify.sh"

echo "=== compose parity check: $(date +%Y-%m-%dT%H:%M:%S%z) ==="
OUT="$(bash "${SCRIPT_DIR}/check-deploy-parity.sh" 2>&1)"
RC=$?
printf '%s\n' "$OUT"

case "$RC" in
  0)
    echo "  parity OK — no alert."
    ;;
  1)
    PUSHOVER_TITLE="Open Brain: compose DRIFT" PUSHOVER_PRIORITY=1 \
      notify_pushover_mismatch "Production is NOT running main's docker-compose.yml (#302). A compose change is undeployed — run the reconciliation window (see deploy.md / the check-deploy-parity output in /var/log/open-brain-parity.log)." || true
    ;;
  *)
    PUSHOVER_TITLE="Open Brain: compose parity check could NOT run" PUSHOVER_PRIORITY=1 \
      notify_pushover_mismatch "check-deploy-parity.sh exited ${RC} — it could not compare (unreachable host / bad ref / empty file). Do NOT assume parity; investigate." || true
    ;;
esac

exit "$RC"
