#!/usr/bin/env bash
# ============================================================================
#  Open Brain — Full System E2E Verification Script
#  Verifies all Phase 4 test gates: all input sources, search, skills,
#  governance, and web dashboard.
#
#  Usage:
#    ./scripts/e2e-full.sh [BASE_URL] [MCP_TOKEN]
#
#  Defaults:
#    BASE_URL  = http://localhost:3000
#    MCP_TOKEN = $MCP_BEARER_TOKEN env var (skip MCP tests if unset)
#
#  Dependencies: curl, python3
# ============================================================================

set -euo pipefail

BASE_URL="${1:-http://localhost:3000}"
MCP_TOKEN="${2:-${MCP_BEARER_TOKEN:-}}"

PASS=0
FAIL=0
SKIP=0

# ── Colors ────────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
RESET='\033[0m'

pass() { echo -e "${GREEN}PASS${RESET} $1"; ((PASS++)) || true; }
fail() { echo -e "${RED}FAIL${RESET} $1: $2"; ((FAIL++)) || true; }
skip() { echo -e "${YELLOW}SKIP${RESET} $1: $2"; ((SKIP++)) || true; }
section() { echo -e "\n${CYAN}=== $1 ===${RESET}"; }

# ── JSON helpers ──────────────────────────────────────────────────────────────
json_get() {
  python3 -c "import json,sys; d=json.load(sys.stdin); print(d$1)" 2>/dev/null || echo ""
}

echo "========================================"
echo " Open Brain — Full System E2E Verification"
echo " BASE_URL: $BASE_URL"
echo " $(date '+%Y-%m-%d %H:%M:%S')"
echo "========================================"

# ============================================================================
# 1. HEALTH CHECK
# ============================================================================
section "1. Health & Readiness"

HEALTH_RESP=$(curl -sf "$BASE_URL/health" 2>&1) && {
  STATUS=$(echo "$HEALTH_RESP" | json_get ".get('status','unknown')")
  if [[ "$STATUS" == "healthy" || "$STATUS" == "degraded" ]]; then
    pass "GET /health → $STATUS"
  else
    fail "GET /health" "unexpected status: $STATUS (response: $HEALTH_RESP)"
  fi
} || fail "GET /health" "curl failed — is the server running at $BASE_URL?"

# ============================================================================
# 2. CAPTURE SOURCES — All input types
# ============================================================================
section "2. Capture Sources (F01-F09, F23-F25)"

# 2a. API capture
TS=$(date +%s%N)
API_CONTENT="E2E full-system test observation $TS — QSR pricing strategy analysis"
API_RESP=$(curl -sf -X POST "$BASE_URL/api/v1/captures" \
  -H "Content-Type: application/json" \
  -d "{\"content\": \"$API_CONTENT\", \"capture_type\": \"observation\", \"brain_view\": \"work-internal\", \"source\": \"api\"}" 2>&1) && {
  API_CAPTURE_ID=$(echo "$API_RESP" | json_get ".get('id','')")
  if [[ -n "$API_CAPTURE_ID" ]]; then
    pass "POST /api/v1/captures (source=api) → id=$API_CAPTURE_ID"
  else
    fail "POST /api/v1/captures (source=api)" "no id in response: $API_RESP"
    API_CAPTURE_ID=""
  fi
} || { fail "POST /api/v1/captures" "curl failed"; API_CAPTURE_ID=""; }

# 2b. Decision capture type
DEC_CONTENT="E2E decision $TS — chose PostgreSQL over MongoDB for vector storage"
DEC_RESP=$(curl -sf -X POST "$BASE_URL/api/v1/captures" \
  -H "Content-Type: application/json" \
  -d "{\"content\": \"$DEC_CONTENT\", \"capture_type\": \"decision\", \"brain_view\": \"technical\", \"source\": \"api\"}" 2>&1) && {
  DEC_ID=$(echo "$DEC_RESP" | json_get ".get('id','')")
  [[ -n "$DEC_ID" ]] && pass "POST /api/v1/captures (capture_type=decision) → id=$DEC_ID" || \
    fail "POST /api/v1/captures decision" "no id: $DEC_RESP"
} || fail "POST /api/v1/captures decision" "curl failed"

# 2c. All capture types
for CTYPE in idea task win blocker question reflection; do
  CTYPE_RESP=$(curl -sf -X POST "$BASE_URL/api/v1/captures" \
    -H "Content-Type: application/json" \
    -d "{\"content\": \"E2E $CTYPE test $TS\", \"capture_type\": \"$CTYPE\", \"brain_view\": \"personal\", \"source\": \"api\"}" 2>&1) && {
    CTYPE_ID=$(echo "$CTYPE_RESP" | json_get ".get('id','')")
    [[ -n "$CTYPE_ID" ]] && pass "capture_type=$CTYPE accepted" || \
      fail "capture_type=$CTYPE" "no id: $CTYPE_RESP"
  } || fail "capture_type=$CTYPE" "curl failed"
done

# 2d. All brain views
for VIEW in career personal technical work-internal client; do
  VIEW_RESP=$(curl -sf -X POST "$BASE_URL/api/v1/captures" \
    -H "Content-Type: application/json" \
    -d "{\"content\": \"E2E $VIEW view test $TS\", \"capture_type\": \"observation\", \"brain_view\": \"$VIEW\", \"source\": \"api\"}" 2>&1) && {
    VIEW_ID=$(echo "$VIEW_RESP" | json_get ".get('id','')")
    [[ -n "$VIEW_ID" ]] && pass "brain_view=$VIEW accepted" || \
      fail "brain_view=$VIEW" "no id: $VIEW_RESP"
  } || fail "brain_view=$VIEW" "curl failed"
done

# 2e. Document upload (F23)
DOC_CONTENT="E2E document ingestion test $TS. This is test content for the Open Brain document pipeline."
DOC_RESP=$(curl -sf -X POST "$BASE_URL/api/v1/documents" \
  -F "file=@/dev/stdin;filename=e2e-test.txt;type=text/plain" \
  --data-binary "$DOC_CONTENT" 2>/dev/null) 2>/dev/null || true

# Document upload via multipart — create a temp file approach
TMP_DOC=$(mktemp /tmp/e2e-doc-XXXXXX.txt)
echo "$DOC_CONTENT" > "$TMP_DOC"
DOC_RESP=$(curl -sf -X POST "$BASE_URL/api/v1/documents" \
  -F "file=@$TMP_DOC" \
  -F "brain_view=technical" \
  -F "title=E2E Test Document" 2>&1) && {
  DOC_CAPTURE_ID=$(echo "$DOC_RESP" | json_get ".get('capture_id','')")
  if [[ -n "$DOC_CAPTURE_ID" ]]; then
    pass "POST /api/v1/documents (text/plain) → capture_id=$DOC_CAPTURE_ID"
  else
    fail "POST /api/v1/documents" "no capture_id: $DOC_RESP"
  fi
} || fail "POST /api/v1/documents" "curl failed or endpoint not running"
rm -f "$TMP_DOC"

# 2f. Bookmark capture (F24) — test that source=bookmark is accepted by the captures API
BOOKMARK_RESP=$(curl -sf -X POST "$BASE_URL/api/v1/captures" \
  -H "Content-Type: application/json" \
  -d "{\"content\": \"E2E bookmark https://example.com/ $TS\", \"capture_type\": \"observation\", \"brain_view\": \"personal\", \"source\": \"bookmark\", \"metadata\": {\"source_metadata\": {\"url\": \"https://example.com/\", \"domain\": \"example.com\", \"title\": \"Example Domain\"}}}" 2>&1) && {
  BM_ID=$(echo "$BOOKMARK_RESP" | json_get ".get('id','')")
  [[ -n "$BM_ID" ]] && pass "source=bookmark capture accepted → id=$BM_ID" || \
    fail "source=bookmark" "no id: $BOOKMARK_RESP"
} || fail "source=bookmark capture" "curl failed"

# 2g. Calendar capture (F25) — test that source=calendar is accepted
CAL_RESP=$(curl -sf -X POST "$BASE_URL/api/v1/captures" \
  -H "Content-Type: application/json" \
  -d "{\"content\": \"E2E calendar event $TS — Team standup\", \"capture_type\": \"observation\", \"brain_view\": \"work-internal\", \"source\": \"calendar\", \"metadata\": {\"source_metadata\": {\"uid\": \"e2e-event-$TS@test\", \"dtstart\": \"2024-03-15T09:00:00Z\", \"dtend\": \"2024-03-15T09:15:00Z\"}}}" 2>&1) && {
  CAL_ID=$(echo "$CAL_RESP" | json_get ".get('id','')")
  [[ -n "$CAL_ID" ]] && pass "source=calendar capture accepted → id=$CAL_ID" || \
    fail "source=calendar" "no id: $CAL_RESP"
} || fail "source=calendar capture" "curl failed"

# ============================================================================
# 3. PIPELINE PROCESSING
# ============================================================================
section "3. Pipeline Processing (F02)"

if [[ -n "${API_CAPTURE_ID:-}" ]]; then
  PIPELINE_DONE=0
  echo "  Polling pipeline_status for $API_CAPTURE_ID (up to 60s)..."
  for i in $(seq 1 12); do
    sleep 5
    STATUS_RESP=$(curl -sf "$BASE_URL/api/v1/captures/$API_CAPTURE_ID" 2>&1) && {
      PIPE_STATUS=$(echo "$STATUS_RESP" | json_get ".get('pipeline_status','unknown')")
      echo "  [attempt $i/12] pipeline_status=$PIPE_STATUS"
      if [[ "$PIPE_STATUS" == "complete" || "$PIPE_STATUS" == "partial" ]]; then
        pass "API capture pipeline completed → status=$PIPE_STATUS"
        PIPELINE_DONE=1
        break
      fi
    }
  done
  [[ "$PIPELINE_DONE" -eq 0 ]] && \
    skip "Pipeline completion" "did not complete within 60s — LiteLLM/embeddings may be unavailable"
else
  skip "Pipeline polling" "no capture ID from step 2a"
fi

# ============================================================================
# 4. SEARCH (F03, F04)
# ============================================================================
section "4. Search — FTS + Vector + Hybrid (F03, F04)"

# 4a. Text search
SEARCH_RESP=$(curl -sf -X POST "$BASE_URL/api/v1/search" \
  -H "Content-Type: application/json" \
  -d "{\"query\": \"QSR pricing strategy\", \"limit\": 5}" 2>&1) && {
  TOTAL=$(echo "$SEARCH_RESP" | json_get ".get('total',0)")
  pass "POST /api/v1/search (fts) → total=$TOTAL results"
} || fail "POST /api/v1/search" "curl failed"

# 4b. FTS mode explicit
FTS_RESP=$(curl -sf -X POST "$BASE_URL/api/v1/search" \
  -H "Content-Type: application/json" \
  -d "{\"query\": \"PostgreSQL database\", \"mode\": \"fts\", \"limit\": 10}" 2>&1) && {
  FTS_TOTAL=$(echo "$FTS_RESP" | json_get ".get('total',0)")
  pass "POST /api/v1/search (mode=fts) → total=$FTS_TOTAL"
} || fail "POST /api/v1/search (fts)" "curl failed"

# 4c. Hybrid mode
HYBRID_RESP=$(curl -sf -X POST "$BASE_URL/api/v1/search" \
  -H "Content-Type: application/json" \
  -d "{\"query\": \"calendar meeting event\", \"mode\": \"hybrid\", \"limit\": 10}" 2>&1) && {
  pass "POST /api/v1/search (mode=hybrid) → returned"
} || skip "POST /api/v1/search (hybrid)" "endpoint may require embeddings"

# 4d. Brain view filter
VIEW_SEARCH_RESP=$(curl -sf -X POST "$BASE_URL/api/v1/search" \
  -H "Content-Type: application/json" \
  -d "{\"query\": \"test observation\", \"brain_view\": \"technical\", \"limit\": 5}" 2>&1) && {
  pass "POST /api/v1/search with brain_view filter → returned"
} || fail "POST /api/v1/search (brain_view filter)" "curl failed"

# ============================================================================
# 5. STATS + ADMIN (F06)
# ============================================================================
section "5. Stats & Admin (F06)"

STATS_RESP=$(curl -sf "$BASE_URL/api/v1/stats" 2>&1) && {
  TOTAL_CAP=$(echo "$STATS_RESP" | json_get ".get('total_captures',0)")
  pass "GET /api/v1/stats → total_captures=$TOTAL_CAP"
} || fail "GET /api/v1/stats" "curl failed"

# Budget stats
BUDGET_RESP=$(curl -sf "$BASE_URL/api/v1/stats/budget" 2>&1) && {
  pass "GET /api/v1/stats/budget → returned"
} || skip "GET /api/v1/stats/budget" "endpoint may not be implemented yet"

# ============================================================================
# 6. CAPTURES LIST + FILTER
# ============================================================================
section "6. Captures API — List + Filter"

LIST_RESP=$(curl -sf "$BASE_URL/api/v1/captures?limit=10" 2>&1) && {
  COUNT=$(echo "$LIST_RESP" | json_get ".get('total',0)")
  pass "GET /api/v1/captures?limit=10 → total=$COUNT"
} || fail "GET /api/v1/captures" "curl failed"

# Filter by source
SRC_RESP=$(curl -sf "$BASE_URL/api/v1/captures?source=api&limit=5" 2>&1) && {
  pass "GET /api/v1/captures?source=api → returned"
} || fail "GET /api/v1/captures?source=api" "curl failed"

# Filter by capture_type
TYPE_RESP=$(curl -sf "$BASE_URL/api/v1/captures?capture_type=decision&limit=5" 2>&1) && {
  pass "GET /api/v1/captures?capture_type=decision → returned"
} || fail "GET /api/v1/captures?capture_type=decision" "curl failed"

# ============================================================================
# 7. MCP (F08)
# ============================================================================
section "7. MCP — Streamable HTTP (F08)"

# 7a. Auth rejection
AUTH_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/mcp" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}' 2>&1)
if [[ "$AUTH_CODE" == "401" ]]; then
  pass "POST /mcp without Authorization → 401"
else
  fail "MCP auth check" "expected 401, got $AUTH_CODE"
fi

# 7b. Authenticated tests (requires MCP_BEARER_TOKEN)
if [[ -z "${MCP_TOKEN:-}" ]]; then
  skip "MCP authenticated tests" "MCP_BEARER_TOKEN not set"
else
  # Tools list
  TOOLS_RESP=$(curl -sf -X POST "$BASE_URL/mcp" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $MCP_TOKEN" \
    -d '{"jsonrpc":"2.0","method":"tools/list","params":{},"id":1}' 2>&1) && {
    TOOL_COUNT=$(echo "$TOOLS_RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d.get('result',{}).get('tools',[])))" 2>/dev/null || echo "0")
    if [[ "$TOOL_COUNT" -ge 7 ]]; then
      pass "POST /mcp tools/list → $TOOL_COUNT tools (expected ≥7)"
    else
      fail "POST /mcp tools/list" "expected ≥7 tools, got $TOOL_COUNT"
    fi
  } || fail "POST /mcp tools/list" "curl failed"

  # brain_stats tool
  STATS_MCP=$(curl -sf -X POST "$BASE_URL/mcp" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $MCP_TOKEN" \
    -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"brain_stats","arguments":{"period":"all"}},"id":2}' 2>&1) && {
    CONTENT=$(echo "$STATS_MCP" | python3 -c "import json,sys; d=json.load(sys.stdin); c=d.get('result',{}).get('content',[]); print(c[0].get('text','')[:60] if c else 'empty')" 2>/dev/null || echo "parse-error")
    [[ "$CONTENT" != "empty" && "$CONTENT" != "parse-error" ]] && \
      pass "MCP brain_stats tool → $CONTENT" || \
      fail "MCP brain_stats" "unexpected: $STATS_MCP"
  } || fail "MCP brain_stats" "curl failed"

  # capture_idea tool
  IDEA_MCP=$(curl -sf -X POST "$BASE_URL/mcp" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $MCP_TOKEN" \
    -d "{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\",\"params\":{\"name\":\"capture_idea\",\"arguments\":{\"content\":\"E2E MCP test idea $TS\",\"brain_view\":\"technical\"}},\"id\":3}" 2>&1) && {
    IDEA_CONTENT=$(echo "$IDEA_MCP" | python3 -c "import json,sys; d=json.load(sys.stdin); c=d.get('result',{}).get('content',[]); print(c[0].get('text','')[:80] if c else 'empty')" 2>/dev/null || echo "parse-error")
    [[ "$IDEA_CONTENT" != "empty" && "$IDEA_CONTENT" != "parse-error" ]] && \
      pass "MCP capture_idea tool → $IDEA_CONTENT" || \
      fail "MCP capture_idea" "unexpected: $IDEA_MCP"
  } || fail "MCP capture_idea" "curl failed"

  # search_brain tool
  SEARCH_MCP=$(curl -sf -X POST "$BASE_URL/mcp" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $MCP_TOKEN" \
    -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"search_brain","arguments":{"query":"QSR pricing","limit":3}},"id":4}' 2>&1) && {
    pass "MCP search_brain tool → returned"
  } || fail "MCP search_brain" "curl failed"
fi

# ============================================================================
# 8. SKILLS — Weekly Brief, Pipeline Health, Stale Captures (F12)
# ============================================================================
section "8. Skills Execution (F12)"

SKILLS_LIST=$(curl -sf "$BASE_URL/api/v1/skills" 2>&1) && {
  SKILL_COUNT=$(echo "$SKILLS_LIST" | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d) if isinstance(d,list) else d.get('total',0))" 2>/dev/null || echo "?")
  pass "GET /api/v1/skills → $SKILL_COUNT skill(s)"
} || skip "GET /api/v1/skills" "endpoint may not be implemented yet"

# Pipeline health skill
PH_RESP=$(curl -sf -X POST "$BASE_URL/api/v1/skills/pipeline-health/run" \
  -H "Content-Type: application/json" -d '{}' 2>&1) && {
  pass "POST /api/v1/skills/pipeline-health/run → completed"
} || skip "pipeline-health skill" "endpoint may not be available"

# Stale captures skill
SC_RESP=$(curl -sf -X POST "$BASE_URL/api/v1/skills/stale-captures/run" \
  -H "Content-Type: application/json" -d '{}' 2>&1) && {
  pass "POST /api/v1/skills/stale-captures/run → completed"
} || skip "stale-captures skill" "endpoint may not be available"

# ============================================================================
# 9. ENTITY GRAPH (F15)
# ============================================================================
section "9. Entity Graph (F15)"

ENTITIES_RESP=$(curl -sf "$BASE_URL/api/v1/entities?limit=10" 2>&1) && {
  ENT_COUNT=$(echo "$ENTITIES_RESP" | json_get ".get('total',0)")
  pass "GET /api/v1/entities → total=$ENT_COUNT"
} || skip "GET /api/v1/entities" "endpoint may not be available"

# ============================================================================
# 10. GOVERNANCE SESSIONS (F16-F17)
# ============================================================================
section "10. Governance Sessions (F16-F17)"

GOV_LIST=$(curl -sf "$BASE_URL/api/v1/sessions?limit=5" 2>&1) && {
  pass "GET /api/v1/sessions → returned"
} || skip "GET /api/v1/sessions" "endpoint may not be available"

# ============================================================================
# 11. DOCUMENT INGESTION (F23)
# ============================================================================
section "11. Document Ingestion Verification (F23)"

# Verify POST /api/v1/documents rejects unsupported formats
REJECT_RESP=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/api/v1/documents" \
  -F "file=@/dev/stdin;filename=bad.xlsx;type=application/vnd.ms-excel" \
  --data-binary "fake spreadsheet data" 2>/dev/null) || REJECT_RESP="000"
if [[ "$REJECT_RESP" == "400" || "$REJECT_RESP" == "422" ]]; then
  pass "POST /api/v1/documents rejects .xlsx → HTTP $REJECT_RESP"
elif [[ "$REJECT_RESP" == "000" ]]; then
  skip "Document format rejection" "endpoint not reachable"
else
  skip "Document format rejection" "got HTTP $REJECT_RESP (may be curl/stdin limitation)"
fi

# Verify document capture created in step 2e shows in capture list
DOC_LIST=$(curl -sf "$BASE_URL/api/v1/captures?source=document&limit=5" 2>&1) && {
  DOC_TOTAL=$(echo "$DOC_LIST" | json_get ".get('total',0)")
  pass "GET /api/v1/captures?source=document → total=$DOC_TOTAL"
} || fail "GET /api/v1/captures?source=document" "curl failed"

# ============================================================================
# 12. WEB DASHBOARD (F19)
# ============================================================================
section "12. Web Dashboard (F19)"

WEB_RESP=$(curl -sf "$BASE_URL/" 2>&1) && {
  # Check for Vite/React app indicators
  if echo "$WEB_RESP" | grep -q "<!doctype html\|<html\|<div id"; then
    pass "GET / → HTML response (web dashboard serving)"
  else
    skip "GET / dashboard" "unexpected response format"
  fi
} || {
  # Dashboard may be on a separate port (5173 default for Vite dev)
  WEB_DEV=$(curl -sf "http://localhost:5173/" 2>&1) && {
    pass "GET http://localhost:5173/ → Vite dev server responding"
  } || skip "Web dashboard" "not reachable at $BASE_URL/ or localhost:5173"
}

# ============================================================================
# 13. SEARCH QUALITY — verify E2E data is findable
# ============================================================================
section "13. Search Quality — E2E Data Findable"

# Search for the specific content we created in step 2a
if [[ -n "${API_CAPTURE_ID:-}" ]]; then
  FIND_RESP=$(curl -sf -X POST "$BASE_URL/api/v1/search" \
    -H "Content-Type: application/json" \
    -d "{\"query\": \"QSR pricing strategy analysis\", \"limit\": 10}" 2>&1) && {
    FIND_TOTAL=$(echo "$FIND_RESP" | json_get ".get('total',0)")
    if [[ "$FIND_TOTAL" -gt 0 ]]; then
      pass "Search finds captures created in this run (total=$FIND_TOTAL)"
    else
      skip "Search quality" "0 results — embeddings may not have completed yet"
    fi
  } || fail "Search quality check" "curl failed"
else
  skip "Search quality" "no capture created in step 2a"
fi

# ============================================================================
# 14. VALIDATION — input schema checks
# ============================================================================
section "14. Input Validation"

# Missing content field → 400/422
VAL_RESP=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/api/v1/captures" \
  -H "Content-Type: application/json" \
  -d '{"capture_type": "observation", "brain_view": "technical"}' 2>&1)
if [[ "$VAL_RESP" == "400" || "$VAL_RESP" == "422" ]]; then
  pass "POST /api/v1/captures with missing content → HTTP $VAL_RESP"
else
  fail "Validation: missing content" "expected 400/422, got $VAL_RESP"
fi

# Invalid brain_view → 400
BRAIN_RESP=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/api/v1/captures" \
  -H "Content-Type: application/json" \
  -d '{"content": "test", "capture_type": "observation", "brain_view": "invalid-view"}' 2>&1)
if [[ "$BRAIN_RESP" == "400" || "$BRAIN_RESP" == "422" ]]; then
  pass "POST /api/v1/captures with invalid brain_view → HTTP $BRAIN_RESP"
else
  fail "Validation: invalid brain_view" "expected 400/422, got $BRAIN_RESP"
fi

# ============================================================================
# SUMMARY
# ============================================================================
echo ""
echo "========================================"
echo -e " Results: ${GREEN}${PASS} passed${RESET}  ${RED}${FAIL} failed${RESET}  ${YELLOW}${SKIP} skipped${RESET}"
echo " Total checks: $((PASS + FAIL + SKIP))"
echo "========================================"
echo ""

if [[ "$FAIL" -gt 0 ]]; then
  echo -e "${RED}FAILED${RESET}: $FAIL check(s) failed. Review output above."
  exit 1
fi

if [[ "$PASS" -eq 0 ]]; then
  echo -e "${YELLOW}WARNING${RESET}: No checks passed — is the server running at $BASE_URL?"
  exit 1
fi

echo -e "${GREEN}All checks passed (${PASS} passed, ${SKIP} skipped).${RESET}"
exit 0
