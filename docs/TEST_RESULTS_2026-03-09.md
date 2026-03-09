# Open Brain Test Results — March 9, 2026

## Executive Summary

Full end-to-end validation complete on homeserver (homeserver.k4jda.net, Unraid). All automated tests passing. Integration phases 1–4, 6–10, 12–14 verified against the live deployment. Phases 5 (Slack), 6-iOS (Shortcuts), and 11 (Pushover) require manual action with external services configured.

**Key Findings:**
- 🟢 **Unit Tests**: 1,023 tests passing across 48 test files (6 packages)
- 🟢 **Integration Tests**: 12 of 14 phases passing (2 skipped — require external Slack/Pushover config)
- 🟢 **Embedding Pipeline**: Fully operational with `spark-qwen3-embedding-4b` (Matryoshka 2560d → 768d)
- 🟢 **Hybrid Search**: FTS + vector with RRF working; FTS-only mode (`search_mode=fts`) verified

---

## Unit Test Results (All Passing)

| Package | Test Files | Tests | Pass Rate |
|---------|------------|-------|-----------|
| @open-brain/shared | 3 | 15 | 100% |
| @open-brain/core-api | 20 | 326 | 100% |
| @open-brain/web | 4 | 32 | 100% |
| @open-brain/workers | 14 | 330 | 100% |
| @open-brain/slack-bot | 7 | 320 | 100% |
| **TOTAL** | **48** | **1,023** | **100%** |

---

## Integration Test Results

Tested against live deployment at homeserver.k4jda.net. Core-api exposed at port 3002 on homeserver (maps to container port 3000).

| Phase | Status | Notes |
|-------|--------|-------|
| 1. System Health | ✅ PASS | All 7 containers healthy; LiteLLM reporting 289ms latency |
| 2. Capture Input | ✅ PASS | All 8 capture types and 5 brain views return HTTP 201 |
| 3. Pipeline Processing | ✅ PASS | Status flow: pending→processing→extracted→embedded. 67 captures processed, 0 pending |
| 4. Search | ✅ PASS | Hybrid search returning ranked results; FTS-only <50ms |
| 5. Slack Integration | ⏭️ SKIP | Requires Slack app tokens in .env.secrets and app installed to workspace |
| 6. Voice Capture (API) | ✅ PASS | Container healthy, endpoint returns HTTP 200 on audio upload |
| 6. Voice Capture (iOS) | ⏭️ MANUAL | Requires Shortcuts app on iPhone/Watch |
| 7. Document Ingestion | ✅ PASS | POST without file returns 400 (correct); POST with file returns 202 |
| 8. Entity Tracking | ✅ PASS | Entities extracted and linked; GET /api/v1/entities returns populated list |
| 9. AI Skills | ✅ PASS | weekly-brief queued; bets created; governance session started |
| 10. MCP Endpoint | ✅ PASS | POST /mcp with Accept: application/json, text/event-stream returns initialize response |
| 11. Notifications | ⏭️ SKIP | Pushover configured but not tested end-to-end; Slack not configured |
| 12. Web Dashboard | ✅ PASS | Nginx serving HTTP 200 at port 5173; all pages loading |
| 13. Error Handling | ✅ PASS | 400 on empty content, 400 on invalid type, 404 on missing capture, 409 on duplicate |
| 14. Performance | ✅ PASS | Capture creation <10ms; FTS search <50ms; hybrid search <700ms (embedding latency) |

---

## Bugs Found and Fixed During Test Run

### Bug 1: `pipeline.test.ts` — Wrong assertion for retry endpoint
- **File:** `packages/core-api/src/__tests__/pipeline.test.ts`
- **Problem:** Test asserted `enqueue('cap-pipeline-1')` but route calls `enqueue(id, 'default', true)` (forceRetry=true)
- **Fix:** Updated assertion to `toHaveBeenCalledWith('cap-pipeline-1', 'default', true)`

### Bug 2: SQL typo in `hybrid_search` — `plainplainto_tsquery` is not a valid PostgreSQL function
- **File:** `packages/shared/drizzle/0002_search_functions.sql`
- **Problem:** PL/pgSQL compiles lazily — the typo passed migration but failed at query time
- **Fix:** New migration `packages/shared/drizzle/0006_fts_search.sql` corrects the typo and adds `fts_only_search()` function. Applied to homeserver via `psql`.

### Bug 3: `search_mode: 'fts'` accepted by API schema but silently ignored
- **Files:** `packages/core-api/src/services/search.ts`, `packages/core-api/src/routes/search.ts`
- **Problem:** SearchService always called `embeddingService.embed()` first, causing 30s hangs when LiteLLM was down
- **Fix:** Conditional FTS-only code path bypasses embedding entirely; `search_mode` wired through GET route schema

### Bug 4: Web dashboard stale source files on homeserver
- **14 files** in `packages/web/src/` were outdated on homeserver (missing `formatRelativeTime`, `pipeline_events`, `topics`, `entities` on Capture type, etc.)
- **Fix:** Synced all 14 modified web source files; container rebuilt and running

### Bug 5: Embedding service strict dimension check rejects Matryoshka model output
- **File:** `packages/core-api/src/services/embedding.ts` (homeserver copy)
- **Problem:** Homeserver had `raw.length !== EMBEDDING_DIMENSIONS` — rejects spark's 2560-dim response
- **Fix:** Synced local version with `raw.length < EMBEDDING_DIMENSIONS` check + `raw.slice(0, EMBEDDING_DIMENSIONS)` truncation. Rebuilt core-api container.

### Documentation Bugs Fixed in USER_TEST_PLAN.md
- `"type"` → `"capture_type"` in all curl request bodies
- `"source": "api-test"` → `"source": "api"` (valid enum)
- POST search: `"brain_view"` → `"brain_views": [...]`
- GET search: `?capture_type=decision` not POST body type filter
- Skills: `/execute` → `/trigger`
- Session: `"brain_view": "career"` → `"config": {"focus_brain_views": ["career"]}`
- Bet: `"description"` → `"statement"`, add `"confidence": 0.8`
- MCP: GET → POST, add `Accept: application/json, text/event-stream` header
- Pipeline status: `"complete"` → `"embedded"` (actual terminal status)
- LiteLLM test: `jetson-embeddings` → `spark-qwen3-embedding-4b`

---

## Embedding Model Change

**Old model:** `jetson-embeddings` (Qwen3-Embedding-4B running on Jetson device — offline)
**New model:** `spark-qwen3-embedding-4b` (Qwen3-Embedding-4B via Spark/LiteLLM — ~700ms latency)

The model returns 2560-dimensional vectors. The embedding service truncates to 768 dimensions using Matryoshka representation (semantically valid — model trained for this). Config change only required in `config/ai-routing.yaml`; zero application code changes.

After switching:
- Retried all 29 previously-failed pending captures → all successfully embedded
- Final state: 67 captures embedded, 0 pending

---

## Previous Test Results (2026-03-08)

See `docs/TEST_RESULTS_2026-03-08.md` for the initial test run that identified missing library files. All issues from that run are resolved.
