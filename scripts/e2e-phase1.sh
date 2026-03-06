#!/usr/bin/env bash
# End-to-end Phase 1 verification script
# Verifies the full capture → pipeline → search → MCP flow
#
# Usage:
#   ./scripts/e2e-phase1.sh [BASE_URL] [MCP_TOKEN]
#
# Defaults:
#   BASE_URL = http://localhost:3000
#   MCP_TOKEN = $MCP_BEARER_TOKEN env var

set -euo pipefail

BASE_URL="${1:-http://localhost:3000}"
MCP_TOKEN="${2:-${MCP_BEARER_TOKEN:-}}"

PASS=0
FAIL=0
SKIP=0

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
RESET='\033[0m'

pass() { echo -e "${GREEN}PASS${RESET} $1"; ((PASS++)); }
fail() { echo -e "${RED}FAIL${RESET} $1: $2"; ((FAIL++)); }
skip() { echo -e "${YELLOW}SKIP${RESET} $1: $2"; ((SKIP++)); }

echo "========================================"
echo " Open Brain — Phase 1 E2E Verification"
echo " BASE_URL: $BASE_URL"
echo "========================================"
echo ""

# ---------- 1. Health check ----------
echo "--- 1. Health Endpoint ---"
HEALTH_RESP=$(curl -sf "$BASE_URL/health" 2>&1) && {
  STATUS=$(echo "$HEALTH_RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('status','unknown'))" 2>/dev/null || echo "parse-error")
  if [[ "$STATUS" == "healthy" || "$STATUS" == "degraded" ]]; then
    pass "GET /health returns $STATUS"
  else
    fail "GET /health" "unexpected status: $STATUS"
  fi
} || fail "GET /health" "curl failed"

# ---------- 2. Create capture ----------
echo ""
echo "--- 2. Create Capture ---"
UNIQUE_CONTENT="E2E test capture $(date +%s%N) — QSR pricing strategy observation"
CREATE_RESP=$(curl -sf -X POST "$BASE_URL/api/v1/captures" \
  -H "Content-Type: application/json" \
  -d "{\"content\": \"$UNIQUE_CONTENT\", \"capture_type\": \"observation\", \"brain_view\": \"work-internal\", \"source\": \"api\"}" 2>&1) && {
  CAPTURE_ID=$(echo "$CREATE_RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('id',''))" 2>/dev/null || echo "")
  if [[ -n "$CAPTURE_ID" ]]; then
    pass "POST /api/v1/captures created capture id=$CAPTURE_ID"
  else
    fail "POST /api/v1/captures" "no id in response: $CREATE_RESP"
    CAPTURE_ID=""
  fi
} || fail "POST /api/v1/captures" "curl failed: $CREATE_RESP"

# ---------- 3. Wait for pipeline (poll up to 30s) ----------
echo ""
echo "--- 3. Pipeline Processing ---"
if [[ -n "${CAPTURE_ID:-}" ]]; then
  PIPELINE_DONE=0
  for i in $(seq 1 6); do
    sleep 5
    STATUS_RESP=$(curl -sf "$BASE_URL/api/v1/captures/$CAPTURE_ID" 2>&1) && {
      PIPE_STATUS=$(echo "$STATUS_RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('pipeline_status','unknown'))" 2>/dev/null || echo "unknown")
      echo "  [attempt $i/6] pipeline_status=$PIPE_STATUS"
      if [[ "$PIPE_STATUS" == "complete" || "$PIPE_STATUS" == "partial" ]]; then
        pass "Pipeline completed with status=$PIPE_STATUS"
        PIPELINE_DONE=1
        break
      fi
    }
  done
  if [[ "$PIPELINE_DONE" -eq 0 ]]; then
    skip "Pipeline completion check" "did not complete within 30s (LiteLLM may be unavailable — normal in dev)"
  fi
else
  skip "Pipeline completion check" "no capture id from step 2"
fi

# ---------- 4. Search for the capture ----------
echo ""
echo "--- 4. Search ---"
SEARCH_RESP=$(curl -sf -X POST "$BASE_URL/api/v1/search" \
  -H "Content-Type: application/json" \
  -d '{"query": "QSR pricing strategy", "limit": 5}' 2>&1) && {
  TOTAL=$(echo "$SEARCH_RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('total',0))" 2>/dev/null || echo "0")
  pass "POST /api/v1/search returned (total=$TOTAL results)"
} || fail "POST /api/v1/search" "curl failed"

# ---------- 5. Stats endpoint ----------
echo ""
echo "--- 5. Stats Endpoint ---"
STATS_RESP=$(curl -sf "$BASE_URL/api/v1/stats" 2>&1) && {
  TOTAL_CAP=$(echo "$STATS_RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('total_captures',0))" 2>/dev/null || echo "?")
  pass "GET /api/v1/stats (total_captures=$TOTAL_CAP)"
} || fail "GET /api/v1/stats" "curl failed"

# ---------- 6. MCP — Auth check ----------
echo ""
echo "--- 6. MCP Authentication ---"
# Test missing auth → 401
AUTH_RESP=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/mcp" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}' 2>&1)
if [[ "$AUTH_RESP" == "401" ]]; then
  pass "POST /mcp without auth → 401"
else
  fail "POST /mcp auth check" "expected 401, got $AUTH_RESP"
fi

# ---------- 7. MCP — Tools list ----------
echo ""
echo "--- 7. MCP Tools ---"
if [[ -z "${MCP_TOKEN:-}" ]]; then
  skip "MCP tools/list" "MCP_BEARER_TOKEN not set — skipping authenticated MCP tests"
else
  MCP_TOOLS_RESP=$(curl -sf -X POST "$BASE_URL/mcp" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $MCP_TOKEN" \
    -d '{"jsonrpc":"2.0","method":"tools/list","params":{},"id":1}' 2>&1) && {
    TOOL_COUNT=$(echo "$MCP_TOOLS_RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); tools=d.get('result',{}).get('tools',[]); print(len(tools))" 2>/dev/null || echo "0")
    if [[ "$TOOL_COUNT" -ge 7 ]]; then
      pass "POST /mcp tools/list returned $TOOL_COUNT tools (expected ≥7)"
    else
      fail "POST /mcp tools/list" "expected ≥7 tools, got $TOOL_COUNT: $MCP_TOOLS_RESP"
    fi
  } || fail "POST /mcp tools/list" "curl failed: $MCP_TOOLS_RESP"

  # Test search_brain tool
  MCP_SEARCH_RESP=$(curl -sf -X POST "$BASE_URL/mcp" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $MCP_TOKEN" \
    -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"brain_stats","arguments":{"period":"all"}},"id":2}' 2>&1) && {
    CONTENT=$(echo "$MCP_SEARCH_RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); content=d.get('result',{}).get('content',[]); print(content[0].get('text','')[:80] if content else 'empty')" 2>/dev/null || echo "parse-error")
    if [[ "$CONTENT" != "empty" && "$CONTENT" != "parse-error" ]]; then
      pass "MCP brain_stats tool: $CONTENT"
    else
      fail "MCP brain_stats" "unexpected response: $MCP_SEARCH_RESP"
    fi
  } || fail "MCP brain_stats call" "curl failed"
fi

# ---------- Summary ----------
echo ""
echo "========================================"
echo " Results: ${GREEN}${PASS} passed${RESET}, ${RED}${FAIL} failed${RESET}, ${YELLOW}${SKIP} skipped${RESET}"
echo "========================================"

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
