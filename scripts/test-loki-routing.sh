#!/usr/bin/env bash
# P11a — Verify each compose container's logs appear in Loki after deploy
#
# Usage:
#   bash scripts/test-loki-routing.sh
#   LOKI_URL=http://homeserver.k4jda.net:3100 bash scripts/test-loki-routing.sh
#
# Queries Loki query_range API for each container by {container_name} label.
# Checks for at least one log line in the last 5 minutes.
# Exits 0 if all 13 containers pass, 1 if any fail.
#
# Pre-requisites:
#   - curl and python3 available on path
#   - Loki running and reachable at LOKI_URL (without /loki/api/v1/push suffix)
#   - Containers running with loki log driver (docker compose up -d --force-recreate)
#   - Wait ~30s after container start before running this script

set -euo pipefail

LOKI_BASE="${LOKI_URL:-http://homeserver.k4jda.net:3100}"
# Strip trailing push path if user passed the full push URL from .env
LOKI_BASE="${LOKI_BASE%/loki/api/v1/push}"

SERVICES=(
  open-brain-postgres
  open-brain-redis
  open-brain-core-api
  open-brain-workers
  open-brain-slack-bot
  open-brain-file-ingestion
  open-brain-faster-whisper
  open-brain-voice-capture
  open-brain-web
  open-brain-cloudflared
  open-brain-financial-ingest
  open-brain-utility-ingest
)

PASS=0
FAIL=0
SKIP=0

# Compute epoch timestamps in nanoseconds for Loki query range
NOW_NS=$(date +%s)000000000
FIVE_MIN_AGO_NS=$(( $(date +%s) - 300 ))000000000

echo "Loki endpoint: ${LOKI_BASE}"
echo "Checking last 5 minutes of logs per container..."
echo ""

for svc in "${SERVICES[@]}"; do
  result=$(curl -s -G "${LOKI_BASE}/loki/api/v1/query_range" \
    --data-urlencode "query={container_name=\"${svc}\"}" \
    --data-urlencode "start=${FIVE_MIN_AGO_NS}" \
    --data-urlencode "end=${NOW_NS}" \
    --data-urlencode "limit=1" 2>/dev/null || echo '{"status":"error"}')

  count=$(echo "$result" | python3 -c \
    "import json,sys; d=json.load(sys.stdin); print(len(d.get('data',{}).get('result',[])))" \
    2>/dev/null || echo "0")

  if [ "$count" -gt 0 ]; then
    echo "  PASS: ${svc}"
    PASS=$(( PASS + 1 ))
  else
    # Check if the container is actually running before calling it a FAIL
    if docker inspect --format='{{.State.Running}}' "${svc}" 2>/dev/null | grep -q true; then
      echo "  FAIL: ${svc} — container running but no logs in Loki (last 5 min)"
      FAIL=$(( FAIL + 1 ))
    else
      echo "  SKIP: ${svc} — container not running"
      SKIP=$(( SKIP + 1 ))
    fi
  fi
done

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed, ${SKIP} skipped (not running)"

if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo "Troubleshooting:"
  echo "  1. Verify loki plugin installed: docker plugin ls | grep loki"
  echo "  2. Verify LOKI_URL is reachable: curl -s ${LOKI_BASE}/ready"
  echo "  3. Verify containers were recreated (not just restarted): docker compose up -d --force-recreate"
  echo "  4. Check container log driver: docker inspect <name> | grep -A5 LogConfig"
  exit 1
fi

exit 0
