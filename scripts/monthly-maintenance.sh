#!/usr/bin/env bash
# ============================================================================
#  Open Brain — Monthly Maintenance Script
#
#  Runs on the homeserver. Performs 5 checks, posts results to Slack and
#  the dashboard admin banner.
#
#  Usage:
#    ssh claude@homeserver.k4jda.net "cd /mnt/user/appdata/open-brain && bash scripts/monthly-maintenance.sh"
#
#  Or schedule via cron (1st of each month at 6 AM):
#    0 6 1 * * cd /mnt/user/appdata/open-brain && bash scripts/monthly-maintenance.sh >> /tmp/open-brain-maintenance.log 2>&1
#
#  Requires: docker, curl, gh (GitHub CLI), jq
#  Env: SLACK_BOT_TOKEN, SLACK_CHANNEL (defaults to C0AJ2P8R31C)
# ============================================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

# ── Configuration ────────────────────────────────────────────────────────────
CORE_API_URL="http://localhost:3002"
SLACK_CHANNEL="${SLACK_CHANNEL:-C0AJ2P8R31C}"
SLACK_TOKEN="${SLACK_BOT_TOKEN:-}"
GH_REPO="davistroy/open-brain"
DATE=$(date '+%Y-%m-%d')
START_TIME=$(date +%s)

# ── Results accumulator ──────────────────────────────────────────────────────
PASS=0
WARN=0
FAIL=0
SUMMARY_LINES=()
DETAIL_LINES=()

record() {
  local status="$1" emoji="$2" msg="$3"
  case "$status" in
    pass) ((PASS++)) || true; SUMMARY_LINES+=("$emoji $msg") ;;
    warn) ((WARN++)) || true; SUMMARY_LINES+=("$emoji $msg") ;;
    fail) ((FAIL++)) || true; SUMMARY_LINES+=("$emoji $msg") ;;
  esac
}

detail() { DETAIL_LINES+=("$1"); }

echo "========================================"
echo " Open Brain — Monthly Maintenance"
echo " Date: $DATE"
echo "========================================"

# ============================================================================
# 1. Docker: pull fresh base images and rebuild
# ============================================================================
echo -e "\n--- 1. Docker pull & rebuild ---"

PULL_OUTPUT=$(docker compose pull 2>&1)
UPDATED=$(echo "$PULL_OUTPUT" | grep -c "Pull complete" || true)
echo "  Pulled images ($UPDATED layers updated)"

BUILD_OUTPUT=$(docker compose build --no-cache 2>&1)
BUILD_OK=$?
if [[ $BUILD_OK -eq 0 ]]; then
  record pass "✅" "Docker rebuild successful"
  detail "Docker: rebuilt all images with fresh base layers ($UPDATED layers pulled)"
else
  record fail "❌" "Docker rebuild failed"
  detail "Docker build error: $(echo "$BUILD_OUTPUT" | tail -3)"
fi

# Restart containers
docker compose up -d 2>&1
echo "  Containers restarted"

# Wait for health
sleep 15

# ============================================================================
# 2. Dependency check (report only, no update)
# ============================================================================
echo -e "\n--- 2. Dependency check ---"

# Check outdated packages (if pnpm is available)
if command -v pnpm &>/dev/null; then
  OUTDATED_OUTPUT=$(pnpm outdated --no-color 2>&1 || true)
  OUTDATED_COUNT=$(echo "$OUTDATED_OUTPUT" | grep -cE '^\S' || true)
  # Subtract header lines
  OUTDATED_COUNT=$((OUTDATED_COUNT > 2 ? OUTDATED_COUNT - 2 : 0))

  if [[ $OUTDATED_COUNT -eq 0 ]]; then
    record pass "✅" "All dependencies up to date"
    detail "Dependencies: all current"
  else
    record warn "⚠️" "$OUTDATED_COUNT packages outdated"
    detail "Dependencies: $OUTDATED_COUNT outdated — run \`pnpm update\` to upgrade"
  fi
else
  record warn "⚠️" "pnpm not available — skipped dependency check"
  detail "Dependencies: pnpm not installed on this machine"
fi

# ============================================================================
# 3. GitHub security alerts
# ============================================================================
echo -e "\n--- 3. GitHub security alerts ---"

if command -v gh &>/dev/null; then
  ALERTS=$(gh api "repos/$GH_REPO/dependabot/alerts?state=open&per_page=100" 2>/dev/null || echo "[]")
  ALERT_COUNT=$(echo "$ALERTS" | jq 'length' 2>/dev/null || echo "?")

  if [[ "$ALERT_COUNT" == "0" ]]; then
    record pass "✅" "No open Dependabot alerts"
    detail "GitHub: 0 open security alerts"
  elif [[ "$ALERT_COUNT" == "?" ]]; then
    record warn "⚠️" "Could not check Dependabot alerts"
    detail "GitHub: API call failed (check gh auth status)"
  else
    # Get severity breakdown
    CRITICAL=$(echo "$ALERTS" | jq '[.[] | select(.security_vulnerability.severity == "critical")] | length' 2>/dev/null || echo "0")
    HIGH=$(echo "$ALERTS" | jq '[.[] | select(.security_vulnerability.severity == "high")] | length' 2>/dev/null || echo "0")
    record warn "⚠️" "$ALERT_COUNT Dependabot alerts ($CRITICAL critical, $HIGH high)"
    detail "GitHub: $ALERT_COUNT open alerts — review at github.com/$GH_REPO/security/dependabot"
  fi
else
  record warn "⚠️" "gh CLI not available — skipped security check"
  detail "GitHub: gh not installed"
fi

# ============================================================================
# 4. Error log scan (last 30 days)
# ============================================================================
echo -e "\n--- 4. Error log scan ---"

ERRORS=$(docker logs --since 720h open-brain-core-api 2>&1 | grep -i '"level":50' | sort -u || true)
ERROR_COUNT=$(echo "$ERRORS" | grep -c . || true)

if [[ $ERROR_COUNT -eq 0 ]]; then
  record pass "✅" "No errors in last 30 days"
  detail "Logs: clean — 0 unique errors in core-api"
else
  # Get the 3 most common error messages
  TOP_ERRORS=$(docker logs --since 720h open-brain-core-api 2>&1 | grep -i '"level":50' | \
    grep -oP '"msg":"[^"]*"' | sort | uniq -c | sort -rn | head -3 | \
    sed 's/^ *//' || true)
  record warn "⚠️" "$ERROR_COUNT unique error(s) in last 30 days"
  detail "Logs: $ERROR_COUNT unique errors. Top: $(echo "$TOP_ERRORS" | head -1)"
fi

# ============================================================================
# 5. Health check
# ============================================================================
echo -e "\n--- 5. Health check ---"

HEALTH=$(curl -sf "$CORE_API_URL/health" 2>&1 || echo '{"status":"unreachable"}')
STATUS=$(echo "$HEALTH" | jq -r '.status' 2>/dev/null || echo "unknown")
PG_STATUS=$(echo "$HEALTH" | jq -r '.services.postgres.status' 2>/dev/null || echo "?")
REDIS_STATUS=$(echo "$HEALTH" | jq -r '.services.redis.status' 2>/dev/null || echo "?")
LLM_STATUS=$(echo "$HEALTH" | jq -r '.services.litellm.status' 2>/dev/null || echo "?")

if [[ "$STATUS" == "healthy" ]]; then
  record pass "✅" "All services healthy (pg=$PG_STATUS redis=$REDIS_STATUS llm=$LLM_STATUS)"
  detail "Health: all green — Postgres ${PG_STATUS}, Redis ${REDIS_STATUS}, OpenAI ${LLM_STATUS}"
elif [[ "$STATUS" == "degraded" ]]; then
  record warn "⚠️" "System degraded (pg=$PG_STATUS redis=$REDIS_STATUS llm=$LLM_STATUS)"
  detail "Health: degraded — investigate failing service"
else
  record fail "❌" "System unhealthy or unreachable (status=$STATUS)"
  detail "Health: CRITICAL — status=$STATUS"
fi

# ============================================================================
# Build report
# ============================================================================
DURATION=$(( $(date +%s) - START_TIME ))

# Overall status
if [[ $FAIL -gt 0 ]]; then
  OVERALL="❌ NEEDS ATTENTION"
  BANNER_LEVEL="warning"
elif [[ $WARN -gt 0 ]]; then
  OVERALL="⚠️ OK with warnings"
  BANNER_LEVEL="info"
else
  OVERALL="✅ All clear"
  BANNER_LEVEL="success"
fi

BANNER_MSG="Maintenance $DATE: $PASS passed, $WARN warnings, $FAIL failures (${DURATION}s)"

echo ""
echo "========================================"
echo " $OVERALL"
echo " $BANNER_MSG"
echo "========================================"
printf '  %s\n' "${SUMMARY_LINES[@]}"

# ============================================================================
# Post to dashboard banner
# ============================================================================
echo -e "\n--- Posting dashboard banner ---"

curl -sf -X POST "$CORE_API_URL/api/v1/admin/banner" \
  -H "Content-Type: application/json" \
  -H "X-Open-Brain-Caller: integration-test" \
  -d "$(jq -n --arg msg "$BANNER_MSG" --arg lvl "$BANNER_LEVEL" \
    '{message: $msg, level: $lvl}')" \
  >/dev/null 2>&1 && echo "  Banner posted" || echo "  Banner post failed"

# ============================================================================
# Post to Slack
# ============================================================================
echo -e "\n--- Posting to Slack ---"

if [[ -z "$SLACK_TOKEN" ]]; then
  echo "  SLACK_BOT_TOKEN not set — skipping Slack notification"
else
  # Build Slack blocks
  BLOCKS=$(jq -n \
    --arg title "🧠 Open Brain Monthly Maintenance — $DATE" \
    --arg overall "$OVERALL — $PASS passed, $WARN warnings, $FAIL failures" \
    --arg checks "$(printf '%s\n' "${SUMMARY_LINES[@]}")" \
    --arg details "$(printf '%s\n' "${DETAIL_LINES[@]}")" \
    --arg duration "Completed in ${DURATION}s" \
    '[
      {"type":"header","text":{"type":"plain_text","text":$title}},
      {"type":"section","text":{"type":"mrkdwn","text":$overall}},
      {"type":"divider"},
      {"type":"section","text":{"type":"mrkdwn","text":$checks}},
      {"type":"divider"},
      {"type":"section","text":{"type":"mrkdwn","text":("*Details:*\n" + $details)}},
      {"type":"context","elements":[{"type":"mrkdwn","text":$duration}]}
    ]')

  SLACK_RESP=$(curl -sf -X POST "https://slack.com/api/chat.postMessage" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $SLACK_TOKEN" \
    -d "$(jq -n --arg ch "$SLACK_CHANNEL" --argjson blocks "$BLOCKS" \
      '{channel: $ch, text: ("Monthly maintenance: " + $ch), blocks: $blocks}')" 2>&1)

  if echo "$SLACK_RESP" | jq -e '.ok' >/dev/null 2>&1; then
    echo "  Slack message posted to #$(echo "$SLACK_RESP" | jq -r '.channel' 2>/dev/null)"
  else
    echo "  Slack post failed: $(echo "$SLACK_RESP" | jq -r '.error' 2>/dev/null || echo "$SLACK_RESP")"
  fi
fi

echo -e "\nDone."
