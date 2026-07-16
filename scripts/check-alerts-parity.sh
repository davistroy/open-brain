#!/usr/bin/env bash
# check-alerts-parity.sh — are open-brain's Prometheus alert rules actually deployed? (#292)
#
# Sibling to check-deploy-parity.sh (#302), for the OTHER copied-not-deployed
# surface. open-brain's alert rules live in this repo's config/prometheus/alerts/,
# but the running Prometheus reads the standalone observability project's dir
# (/mnt/user/appdata/observability/config/prometheus/alerts) — a separate,
# non-git-managed location under ADR-0004. Nothing syncs them, and until now
# nothing compared them: backup.yml (the #294 dead-man's switch) sat repo-only
# and unseen while its metric flowed with no rule to evaluate it.
#
# This is Entry 207's #292 recommendation realised: "comparison is the fix;
# relocation is cosmetics." Make the drift visible; deploy is still a manual
# root copy + reload (the deployed dir is root-owned).
#
# ── What it compares ───────────────────────────────────────────────────────────
# For every open-brain-owned rule file (config/prometheus/alerts/*.yml), compare
# the RULE BODY — comments and blank lines stripped — against the deployed copy:
#   MISSING    : repo file has no deployed counterpart (a functional gap)
#   DRIFTED    : rule bodies differ (a functional gap; comment-only diffs are IGNORED)
#   in-sync    : rule bodies identical
# Deployed-only files (cron-jobs/host-resources/probes/target-down) are the
# observability project's / Unraid's own — NOT open-brain's — and are ignored.
#
# ── Exit codes ─────────────────────────────────────────────────────────────────
#   0  every open-brain rule is deployed with an identical body
#   1  a rule is missing or functionally drifted
#   2  could not perform the check (never a false pass — the #303 lesson)
set -uo pipefail

HOST="${ALERTS_HOST:-homeserver.k4jda.net}"
USER_="${ALERTS_USER:-claude}"
DEPLOYED_DIR="${ALERTS_DEPLOYED_DIR:-/mnt/user/appdata/observability/config/prometheus/alerts}"
SSH_KEY="${ALERTS_SSH_KEY:-$HOME/.ssh/id_claude_code}"

die() { echo "ERROR: $*" >&2; exit 2; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${SCRIPT_DIR}/../config/prometheus/alerts"
[ -d "$REPO_DIR" ] || die "repo alerts dir not found: $REPO_DIR"

# Rule body only: drop comments + blank lines so a comment-only diff is not drift.
strip() { grep -vE '^[[:space:]]*(#|$)'; }

echo "== alert parity: config/prometheus/alerts/  vs  ${USER_}@${HOST}:${DEPLOYED_DIR} =="

missing=0 drifted=0 insync=0
for f in "$REPO_DIR"/*.yml; do
  b="$(basename "$f")"
  dep="$(ssh -i "$SSH_KEY" -o ConnectTimeout=20 -o BatchMode=yes "${USER_}@${HOST}" \
          "cat ${DEPLOYED_DIR}/${b} 2>/dev/null")"
  rc=$?
  # A non-zero ssh (network/auth) is unknowable, not "missing" — fail closed.
  [ $rc -le 1 ] || die "ssh failed reading ${b} (host down? key?)"

  if [ -z "$dep" ]; then
    echo "  MISSING (repo-only, NOT deployed): $b"
    missing=$((missing + 1))
    continue
  fi
  if [ "$(strip < "$f" | sha256sum)" = "$(printf '%s' "$dep" | strip | sha256sum)" ]; then
    insync=$((insync + 1))
  else
    echo "  DRIFTED (rule bodies differ): $b"
    diff <(printf '%s' "$dep" | strip) <(strip < "$f") \
      | grep -E '^[<>]' | grep -iE 'alert:|record:|expr:|for:|severity:' | head -6 | sed 's/^/      /'
    drifted=$((drifted + 1))
  fi
done

echo "  ---"
echo "  in-sync: ${insync}   missing: ${missing}   drifted: ${drifted}"
if [ $((missing + drifted)) -eq 0 ]; then
  echo "  OK — every open-brain alert rule is deployed with an identical body."
  exit 0
fi
echo
echo "  Deploy is a manual root copy (the deployed dir is root-owned), then reload:"
echo "    scp/cat the file(s) to ${DEPLOYED_DIR}/ as root, then"
echo "    curl -s -X POST http://prometheus:9090/-/reload   (from the observability network)"
echo "  There is no automated sync — that is #292's root gap. This gate makes it visible."
exit 1
