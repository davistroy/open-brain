# Open Brain — Lab Notebook

**Project:** Self-hosted personal AI knowledge infrastructure — voice memos, Slack, documents → Postgres+pgvector → semantic search, AI synthesis, weekly briefs, governance sessions, entity tracking
**Started:** 2026-03-30
**Systems:** Homeserver (Unraid, Docker Compose — 9 containers), OpenAI API (gpt-5.4 + text-embedding-3-large), laptop (development)

---

## Decision Log

| # | Decision | Date | Status | Entry | Alternatives Considered |
|---|----------|------|--------|-------|------------------------|
| D1 | Hono + Drizzle ORM (not Express + Prisma) | 2026-02 | ACTIVE | PRD/TDD | Express: heavier; Prisma: less control over pgvector queries |
| D2 | ~~LiteLLM proxy for ALL AI~~ | 2026-02 | SUPERSEDED by D10 | Architecture | Replaced by direct OpenAI API calls (2026-03-30) |
| D3 | ~~Matryoshka truncation 2560→768~~ | 2026-03 | SUPERSEDED by D10 | CLAUDE.md | OpenAI text-embedding-3-large uses `dimensions: 768` API param (trained MRL) |
| D4 | Socket Mode for Slack (not HTTP webhooks) | 2026-02 | ACTIVE | Architecture | HTTP webhooks: need signing secret, public endpoint, more config |
| D5 | BullMQ pipeline (not synchronous processing) | 2026-02 | ACTIVE | TDD | Synchronous: blocks API, no retry, no observability |
| D6 | Node 22 LTS (upgraded from Node 20) | 2026-03-30 | ACTIVE | CHANGELOG | Node 20: EOL April 2026 |
| D7 | Shared utilities in @open-brain/shared (Phase 7) | 2026-03-30 | ACTIVE | IMPL_PLAN_PHASE7 | Per-package duplication: 3x logger, 2x Pushover, 7x LLM client |
| D8 | Healthchecks use 127.0.0.1 (not localhost) | 2026-03 | ACTIVE | CLAUDE.md | localhost: Alpine resolves to ::1 (IPv6), wget fails silently |
| D9 | No auto-migration on startup — manual schema apply required | 2026-03-30 | ACTIVE | Entry 002 | Auto-migrate: risk of data loss if wrong migration runs; Docker entrypoint scripts are brittle |
| D10 | Switch to OpenAI API (gpt-5.4 + text-embedding-3-large) | 2026-03-30 | ACTIVE | Entry 003 | Claude: no embeddings, 3-4x more expensive; Qwen local: free but lower quality, requires Spark |
| D11 | Web UI exempt from rate limiting via nginx header | 2026-03-30 | ACTIVE | Entry 005 | Higher rate limit: still hits under rapid browsing; no bypass: blocks owner from own dashboard |
| D12 | Monthly maintenance: homeserver cron + GitHub Action split | 2026-03-30 | ACTIVE | Entry 006 | All-in-one script: pnpm/gh not on homeserver; all-GitHub: can't docker compose |
| D13 | CI actions v5 (Node 24-compatible) | 2026-03-30 | ACTIVE | Entry 006 | pnpm/action-setup still v4 — no v5 available yet, but works under Node 24 |
| D14 | Email capture via Cloudflare Email Worker | 2026-03-31 | ACTIVE | Entry 009 | Direct SMTP (requires server), Zapier/Make (third-party dependency, cost) |
| D15 | Dashboard-managed sender allowlist (app_settings table) | 2026-03-31 | ACTIVE | Entry 009 | Config file (no UI, requires redeploy), env var (same) |
| D16 | Web synthesis answers on search page | 2026-03-31 | ACTIVE | Entry 011 | Separate synthesis page (fragmented UX), Slack-only synthesis (no web access) |
| D17 | Model aliases resolved at init from ai-routing.yaml, never raw to OpenAI | 2026-04-01 | ACTIVE | Entry 012 | Pass-through to proxy (LiteLLM removed), hardcode model names (fragile) |
| D18 | Slack-bot: lightweight ai-routing.yaml load, not full ConfigService | 2026-04-01 | ACTIVE | Entry 012 | Full ConfigService requires all 4 YAML files; slack-bot only needs intent model |
| D19 | Autonomy levels (observe/assist/advise/partner) gate all proactive features | 2026-04-02 | ACTIVE | Entry 013 | Per-feature toggles (too granular), env var (not dashboard-configurable) |
| D20 | Auto-response is async fire-and-forget; autonomy cached 5 min | 2026-04-02 | ACTIVE | Entry 013 | Sync (blocks message routing), no cache (hammers settings API per message) |
| D21 | Pipeline-health parses REDIS_URL with fallback to REDIS_HOST | 2026-04-02 | ACTIVE | Entry 013 | Docker sets REDIS_URL not REDIS_HOST; skill created queues against localhost |
| D22 | Health endpoint service key renamed from `litellm` to `llm` | 2026-04-02 | ACTIVE | Entry 013 | LiteLLM proxy removed; OpenAI direct — label should be generic |

## Action Items

### Open
| # | Action | Created | Source | Priority |
|---|--------|---------|--------|----------|
| A1 | ~~Deploy Phase 7 consolidated code to homeserver~~ | 2026-03-30 | IMPL_PLAN_PHASE7 | DONE — deployed, verified via test suite |
| A2 | Verify pg-notify reconnection works under real disconnect | 2026-03-30 | Phase 7 | MEDIUM |
| A3 | Deferred features: F21 voice transcription history, F22 entity merge UI, F24 multi-user | 2026-03 | PRD | LOW — Could Have / Won't Have |
| A4 | ~~Unify three CaptureCard implementations~~ | 2026-03-31 | Entry 009 | DONE — PR #37 (8c31728) |

### Completed
| # | Action | Created | Completed | Source |
|---|--------|---------|-----------|--------|
| A0a | Phase 5: Intelligence features (connections, drift monitor, dashboard) | 2026-03 | 2026-03-11 | IMPL_PLAN_PHASE5 |
| A0b | Phase 6: UX polish, admin tools, Slack channel cleanup | 2026-03 | 2026-03-12 | IMPL_PLAN_PHASE6 |
| A0c | Phase 7: Architectural consolidation (shared utils, decomposition) | 2026-03 | 2026-03-30 | IMPL_PLAN_PHASE7 |
| A0d | DGX Spark LLM throughput optimization (13→49 tok/s) | 2026-03-29 | 2026-03-30 | (See ../spark/LAB_NOTEBOOK.md) |
| A0e | Run prod test suite, fix issues | 2026-03-30 | 2026-03-30 | Entry 002 |
| A0f | Switch to OpenAI API (gpt-5.4 + text-embedding-3-large) | 2026-03-30 | 2026-03-30 | Entry 003 |
| A0g | Dashboard UI review — search fix, rate-limit bypass | 2026-03-30 | 2026-03-30 | Entry 004-005 |
| A0h | Monthly maintenance script + GitHub Action | 2026-03-30 | 2026-03-30 | Entry 006 |
| A0i | Repo cleanup: archive plans, update README + CHANGELOG | 2026-03-30 | 2026-03-30 | Entry 007 |
| A0j | Email-to-capture pipeline (PR #34) | 2026-03-31 | 2026-03-31 | Entry 009 |
| A0k | Search page crash fix (PR #35) | 2026-03-31 | 2026-03-31 | Entry 010 |
| A0l | Web synthesis answers (PR #36) | 2026-03-31 | 2026-03-31 | Entry 011 |

---

## Prior Work Summary

### Project Arc

Open Brain is a mature personal AI system at v1.2.0. Development progressed through three implementation plan cycles:

**Phases 1-16: Core infrastructure** (~11,100 LOC, shipped 2026-03-05). Built the full stack: Hono API, Drizzle ORM + Postgres/pgvector, BullMQ pipeline, Slack bot (Socket Mode), voice capture via iOS Shortcut, web dashboard (Vite + React + shadcn/ui), MCP endpoint, semantic search with hybrid retrieval (FTS + vector + RRF + ACT-R temporal decay). 1,407 unit tests.

**Phases 17-20: Intelligence features** (shipped 2026-03-11). DailyConnectionsSkill (entity co-occurrence patterns), DriftMonitorSkill (silent bets, declining entities), intelligence dashboard tab, Slack commands.

**Phases 21-25: UX polish and admin** (shipped 2026-03-12). Queue management UI, skill schedule editing, in-app help, Slack channel cleanup, dark mode, settings reorganization. 95 regression tests.

**Phase 7: Architectural consolidation** (shipped 2026-03-30). Response to `/review-arch` audit that found 14 findings across 6 dimensions. After investigation, 4 root causes identified and addressed: shared utilities consolidation (eliminating 3x logger, 2x Pushover, 7x LLM client duplication), async TemplateCache (replacing synchronous readFileSync), skills route decomposition, entity resolver consolidation. See IMPLEMENTATION_PLAN-PHASE7.md for details.

### Deployment State (March 2026)

Deployed to homeserver via Docker Compose (9 containers on single `open-brain` network). External access via Cloudflare Tunnel at brain.troy-davis.com. LLM inference routed through LiteLLM proxy at llm.k4jda.net, backed by DGX Spark (now at 48.6 tok/s after SM121 kernel optimization).

### Operational Learnings

The CLAUDE.md contains 24 verified operational rules covering Docker healthchecks, Postgres configuration, Slack routing, Drizzle ORM quirks, integration testing, PWA caching, and embedding pipeline behavior. These represent hard-won debugging knowledge — each rule prevented a repeat failure.

## Current Baseline

| Component | Status | Details |
|-----------|--------|---------|
| Version | v1.4.0 + proactive intelligence | ~55 commits on main |
| Containers | 9 in docker-compose.yml + Cloudflare Email Worker | core-api, workers, slack-bot, voice-capture, faster-whisper, web, postgres, redis, cloudflared; email worker on Cloudflare edge |
| Tests | 1,504 unit + 95 regression | All passing (CI green) |
| LLM backend | OpenAI API | gpt-5.4 (all aliases), text-embedding-3-large (768d) |
| Database | Postgres 16 + pgvector | vector(768) schema, migration 0010 (app_settings) |
| External access | brain.troy-davis.com | Cloudflare Tunnel + Email Routing (brain@troy-davis.com) |
| Deployment | Fully deployed | All code on homeserver, 100% regression pass rate |
| Maintenance | Automated | Homeserver cron (1st/month) + GitHub Action (monthly-audit.yml) |
| Email capture | Deployed | Cloudflare Email Worker → core-api, 5 sender allowlist addresses |

---

## Experiment Log

--- New session: 2026-04-01 — Investigating failed skill-execution queue job + model alias audit ---

### Entry 012 — Fix unresolved model aliases across codebase [debug] [deploy] [api]
**Date:** 2026-04-01
**Duration:** ~45 min
**Environment:** Laptop (development) + Homeserver (investigation)
**Tags:** `[debug]` `[api]` `[config]` `[workers]` `[slack]` `[web]`

**Objective:** Investigate failed `daily-connections` skill execution job (1 failed in Bull Board) and audit entire codebase for similar issues.

**Hypothesis:** The failed job is likely related to the LiteLLM→OpenAI API migration (Decision D10). Model aliases were previously resolved by the LiteLLM proxy; now with direct OpenAI calls, unresolved aliases will cause 404 errors. Expect to find multiple call sites passing alias strings instead of resolved model names.

**Rollback Plan:** `git revert` — all changes are code-only, no infrastructure impact.

#### Investigation

1. **Failed job data from Redis** — `bull:skill-execution:failed` contained one job:
   - Job: `daily-connections` (scheduled, cron `0 21 * * *`)
   - Error: `404 The model 'synthesis' does not exist or you do not have access to it.`
   - Stacktrace: `DailyConnectionsSkill.callLLM → OpenAI.makeRequest`
   - Retried 3 times (exponential backoff), all failed identically
   - Timestamp: ~2026-03-29 21:00 UTC (first run after LiteLLM migration)

2. **Root cause:** All three skills (`weekly-brief`, `daily-connections`, `drift-monitor`) pass `modelAlias = 'synthesis'` directly to `client.chat.completions.create({ model: modelAlias })`. OpenAI rejects unknown model names with 404.

3. **Correct pattern already exists:** `extract-entities.ts:218` does `const synthesisModel = aiConfig.models['synthesis']` and `llm-gateway.ts:84` has `resolveModel()`. Skills bypassed both.

4. **Comprehensive audit found 4 affected call sites:**

| File | Model Value | Status |
|------|------------|--------|
| `workers/src/skills/daily-connections.ts:151` | `'synthesis'` alias | BROKEN — fixed |
| `workers/src/skills/weekly-brief.ts:91` | `'synthesis'` alias | BROKEN — fixed |
| `workers/src/skills/drift-monitor.ts:172` | `'synthesis'` alias | BROKEN — fixed |
| `slack-bot/src/server.ts:29` | `'intent'` alias | BROKEN — fixed |
| `voice-capture/src/services/classification.ts:6` | `'gpt-5.4'` (hardcoded) | SAFE (actual model name, not alias) |
| `core-api/src/services/llm-gateway.ts:184` | `resolveModel()` | CORRECT |
| `workers/src/jobs/extract-entities.ts:122` | `aiConfig.models['synthesis']` | CORRECT |

5. **Additional CI fix:** Web package test `searchApi.search` was failing — test mock returned `{ captures: [] }` but `api.ts:79` expects `{ results: [...] }` (API format change from PR #35). This was the root cause of the 4 failed CI runs on main.

#### Changes Made

1. **`packages/workers/src/jobs/skill-execution.ts`** — Added `configService: ConfigService` to opts, resolve `synthesisModel` from `aiConfig.models['synthesis']`, pass resolved model to all three skill dispatches instead of letting them default to alias string.

2. **`packages/workers/src/main.ts`** — Pass `configService` to `createSkillExecutionWorker`.

3. **`packages/slack-bot/src/server.ts`** — Added ConfigService, load ai-routing.yaml, resolve `intent` alias before passing to IntentRouter constructor.

4. **`packages/web/src/lib/__tests__/api.test.ts`** — Fixed mock to return `{ results: [], total: 0, query: 'hello' }` matching actual API response format.

5. **`CLAUDE.md`** — Added operational rule about model alias resolution.

#### What Worked
- The `extract-entities.ts` pattern of resolving at worker init time is clean and efficient — replicated for skills.
- Passing resolved model name through options (not requiring skill classes to know about ConfigService) kept the change minimal.

#### Results
- All 1,426 tests pass (68 test files across 6 packages)
- Type-checks clean across all packages
- CI web test failure resolved

#### Deployment Issue — Slack-bot ConfigService crash
First deploy attempt crashed slack-bot: `ConfigService.load()` requires ALL config files (pipeline.yaml, ai-routing.yaml, brain-views.yaml, notifications.yaml) but slack-bot container didn't mount `./config` volume. Workers container has the mount; slack-bot didn't.

**Fix:** Two changes:
1. Replaced full `ConfigService` in slack-bot with lightweight YAML load of only `ai-routing.yaml` + safe fallback to `gpt-5.4`
2. Added `./config:/app/config:ro` volume mount to slack-bot in docker-compose.yml
3. Added `js-yaml` + `@types/js-yaml` as slack-bot dependencies

**Root cause:** `ConfigService.load()` is all-or-nothing — no partial load. Slack-bot only needs one model name. The lightweight approach is more appropriate for a container that historically doesn't use config files.

#### Decision
- **D17:** All model alias resolution must happen at service/worker init time from `ai-routing.yaml`, never passed raw to OpenAI API. Pattern: `configService.get('ai').models[alias]`.
- **D18:** Slack-bot loads only `ai-routing.yaml` directly (not full ConfigService) — lighter dependency, graceful fallback if config missing.

### Entry 001 — Lab notebook initialized [init] [documentation]
**Date:** 2026-03-30
**Duration:** —
**Environment:** Laptop (development)
**Status:** COMPLETED

**Objective:** Initialize lab notebook for Open Brain, synthesizing prior work from 3 implementation plans, CHANGELOG, CLAUDE.md (24 operational rules), and 15 git commits.

**Hypothesis:** N/A — documentation entry.

**Rollback Plan:** N/A — additive only.

**Actions & Results:**
- Read CLAUDE.md (24 operational rules, architecture decisions, conventions)
- Read README.md, CHANGELOG.md, IMPLEMENTATION_PLAN-PHASE7.md
- Reviewed git log (15 recent commits, main branch only)
- Synthesized 4 development phases into narrative
- Populated Decision Log with 8 architectural decisions
- Populated Action Items: 3 open (Phase 7 deploy, pg-notify verification, deferred features), 4 completed milestones

**What Worked:** The CLAUDE.md is exceptionally well-structured — operational rules, architecture decisions, and conventions are clearly separated. This made decision extraction efficient.

**Decision:** Lab notebook established. Future experimental work (deployments, Docker operations, pipeline debugging, performance tuning, feature experiments) will be logged here.

---

--- New session: 2026-03-30 — Production test run against homeserver ---

### Entry 002 — Production test suite run [deploy] [api] [debug]
**Date:** 2026-03-30
**Duration:** ~25 minutes
**Environment:** Laptop → Homeserver (Tailscale), all 9 containers
**Status:** COMPLETED

**Objective:** Run all three test scripts (e2e-phase1.sh, e2e-full.sh, regression-test.mjs) against the production deployment on homeserver to verify system health and identify issues.

**Hypothesis:** All core API endpoints, pipeline processing, search, MCP auth, and skills execution should be functional. Some skill outputs (weekly-brief, daily-connections, drift-monitor) may return "no captures" if LiteLLM/embedding pipeline hasn't processed enough data. Session endpoints may time out if LLM inference is slow. Success criteria: ≥90% pass rate on regression suite, zero FAIL on core CRUD operations.

**Rollback Plan:** N/A — read-only test operations. Test creates captures/sessions/bets but cleans them up. Only risk is polluting prod data if cleanup fails — can manually delete via admin API.

**Actions & Results:**

1. **Connectivity check** — All 9 containers healthy. Core-api on port 3002 returns 200 on /health. Phase 7 commit `26020b0` deployed. Postgres up 3 days, app containers restarted ~12 min ago.

2. **e2e-phase1.sh run** — Fixed bash arithmetic bug (`((PASS++))` when PASS=0 returns exit code 1, breaks `set -e`; added `|| true` matching e2e-full.sh pattern). After fix: health PASS, all API endpoints return **500 Internal Server Error**.

3. **Root cause investigation** — Container logs show: `relation "captures" does not exist`. Database `openbrain` exists (~7.6MB system tables) but has **zero user tables**. Postgres volume created 2026-03-27. No `docker-entrypoint-initdb.d` scripts mounted. Migrations were never applied after volume recreation.

4. **Fix: Running init-schema.sql** — Applied full schema via `scripts/init-schema.sql` + all 10 Drizzle migrations (0000-0009). All tables created successfully. Trigger CREATE errors from migration 0001 were benign (init-schema.sql already created them).

5. **e2e-phase1.sh — first run** — 6/8 pass, 2 fail. MCP authenticated tests fail with HTTP 406 "Not Acceptable". Root cause: MCP Streamable HTTP requires `Accept: application/json, text/event-stream` header. Also, MCP responses use SSE framing (`event: message\ndata: {json}`) which the raw JSON parser can't parse.

6. **Script fixes applied:**
   - `e2e-phase1.sh`: Fixed bash arithmetic `((PASS++))` exit code 1 when PASS=0 (added `|| true` matching e2e-full.sh); added `Accept` header and SSE JSON parsing for MCP calls; added rate-limit bypass via curl wrapper function
   - `e2e-full.sh`: Added curl wrapper with `X-Open-Brain-Caller: integration-test` header for rate-limit bypass; added `sse_json_get()` helper; fixed MCP Accept header; fixed web dashboard port check (API on 3002, web on 5173); fixed document upload title uniqueness (content_hash collision on `[Document] E2E Test Document`); changed bookmark/calendar source tests to SKIP (Zod schema only allows `slack|voice|api|document`)
   - `regression-test.mjs`: Added `X-Open-Brain-Caller: integration-test` header to all requests; fixed TC-API-011 to accept fast pipeline processing (pipeline completes before GET fires)

7. **e2e-phase1.sh — final run: 8/8 PASS**

8. **e2e-full.sh — final run: 37/43 (37 pass, 0 fail, 6 skip)**
   - All skips are expected: budget endpoint not implemented, bookmark/calendar sources not in schema, document format rejection stdin limitation, skill-specific run endpoints unavailable

9. **regression-test.mjs — final run: 87/95 (87 pass, 0 bug, 1 fail, 7 skip) — 99% pass rate**
   - Single failure: TC-API-011 — pipeline processes so fast (<1s) that status is already `extracted` by time of GET. Fixed in test to accept fast processing.
   - All 7 skips are expected: pipeline/status by design, entity /captures sub-route by design, skill logs empty on fresh DB (3 skips), Slack bot tests skipped (no `--slack` flag), 503 message check N/A when token configured

**Root Causes Found:**
1. **Empty database** — Postgres volume recreated 2026-03-27 but `init-schema.sql` was never re-run. No automated migration on container startup.
2. **MCP SSE format** — e2e test scripts assumed plain JSON response; MCP Streamable HTTP returns SSE framing
3. **Rate limiting** — test scripts fired rapid requests without bypass header, exhausting the 20 req/min strict tier
4. **Document title collision** — document upload hashes `[Document] {title}`, not file content; fixed title needs unique component

**What Worked:**
- Pipeline processing is blazing fast — captures go from pending to complete in <5 seconds (with LiteLLM embedding + entity extraction)
- All CRUD endpoints work correctly after schema fix
- MCP tools (7 total) all functional with correct auth
- Session/governance engine works — creates sessions, responds with AI, completes cleanly
- Entity extraction, merge, and filtering all work
- Semantic triggers with embedding all work
- Skill scheduling (CRUD, cron validation) all work
- Search (FTS, hybrid, vector) all working with proper results
- Web dashboard serves correctly on port 5173

**Decision:** D9 — Test scripts need automated DB migration check. Currently no init-on-startup mechanism; schema must be applied manually after any Postgres volume recreation.

---

### Entry 003 — Switch from local Qwen to OpenAI API [config] [deploy] [decision]
**Date:** 2026-03-30
**Duration:** In progress
**Environment:** Laptop → Homeserver (Tailscale)
**Status:** IN PROGRESS

**Objective:** Migrate Open Brain from local Qwen3.5-35B / Qwen3-Embedding-4B (on DGX Spark via LiteLLM) to OpenAI API: gpt-5.4 for all LLM tasks, text-embedding-3-large with dimensions=768 for embeddings. Full premium configuration.

**Hypothesis:** Switching to OpenAI API will provide higher quality outputs for synthesis, governance, and entity extraction while maintaining the same API contract (OpenAI SDK format). The embedding service's `dimensions` parameter will produce 768-dim vectors matching the existing schema. Cost estimate: ~$2-3/month. Success: all containers healthy, regression test passes, embeddings generate correctly.

**Rollback Plan:** Revert ai-routing.yaml model names to `spark-*`, restore LITELLM_URL to `https://llm.k4jda.net`, restore LITELLM_API_KEY to LiteLLM virtual key, rebuild containers. Git revert for code changes.

**Actions & Results:**

1. **API key stored in Bitwarden** — `open-brain-openai-api-key`, project ID `5022ea9c`
2. **Test data wiped** — `POST /admin/reset-data` cleared all 10 tables, preserved triggers (empty) and schema
3. **Code changes — Round 1:** Updated ai-routing.yaml (all aliases → gpt-5.4, embedding → text-embedding-3-large), embedding.ts (dimensions=768 API param, removed Matryoshka truncation), docker-compose.yml (LITELLM_URL → api.openai.com/v1). Deployed. Pipeline completed, 768-dim embeddings generated successfully.

4. **Synthesis 503 — extra_body rejection:** OpenAI API rejected `extra_body: { chat_template_kwargs: { enable_thinking: false } }` — a Qwen/vLLM-specific parameter. Removed from all 5 call sites. Rebuilt/deployed.

5. **Synthesis 503 — max_tokens rejection:** OpenAI gpt-5.4 requires `max_completion_tokens` instead of deprecated `max_tokens`. Updated all 7 LLM call sites. Rebuilt/deployed.

6. **Health check 404:** `checkLiteLLM()` built URL `${baseUrl}/v1/models` — with `baseUrl=https://api.openai.com/v1`, this doubled to `/v1/v1/models`. Fixed with suffix detection. Renamed to `checkLLMProvider()`.

7. **Final verification:** Health check: healthy (470ms to api.openai.com). Pipeline: captures process to complete with 768-dim embeddings. Synthesis: gpt-5.4 returns high-quality responses. Search: hybrid search works.

8. **Regression test: 88 PASS, 0 FAIL, 0 BUG, 7 SKIP — 100% pass rate**

**What Worked:**
- The OpenAI SDK client was already used internally — changing the base URL and API key was enough for basic connectivity
- text-embedding-3-large with `dimensions: 768` parameter works perfectly — no schema changes needed
- gpt-5.4 synthesis quality is noticeably better than Qwen3.5-35B (more structured, concise responses)

**Root Causes of Issues:**
1. `extra_body` param — Qwen/vLLM-specific, OpenAI rejects with 400
2. `max_tokens` → `max_completion_tokens` — OpenAI renamed this for newer models
3. Health check URL construction — double `/v1/` prefix

**Decision:** D10 — Switched to OpenAI API (gpt-5.4 + text-embedding-3-large). Estimated cost: $2-3/month. Rationale: higher quality outputs for synthesis/governance, managed embedding service, no dependency on DGX Spark uptime. Alternatives considered: Claude (no embedding model, 3-4x more expensive), keep Qwen (free but lower quality).

---

### Entry 004 — Dashboard UI review [web] [debug]
**Date:** 2026-03-30
**Duration:** ~30 minutes
**Environment:** Chrome → brain.troy-davis.com (Cloudflare Tunnel) → homeserver
**Status:** COMPLETED

**Objective:** Systematically review every page and function of the web dashboard after OpenAI migration.

**Hypothesis:** All 10 pages should render correctly. Some may have issues from the migration or stale cached JS.

**Rollback Plan:** N/A — read-only review + targeted fixes.

**Actions & Results:**

1. **Dashboard page** — initially showed "Failed to load dashboard data" (502). Root cause: Cloudflare tunnel's DNS cache was stale after container recreation. Fixed by restarting cloudflared. Deeper root cause: nginx also had stale cached IP for core-api. Fixed with `resolver 127.0.0.11` + variable upstream in nginx.conf.

2. **Search page** — 400 error: `query` field undefined. Root cause: `SearchFilters` type used `q` but API expects `query`. Fixed in types.ts, Search.tsx, and api.test.ts.

3. **All other pages reviewed** (Timeline, Entities, Briefs, Board, Intelligence, Voice, Help, Settings, Slack Cleanup) — all functional, no errors.

4. **PWA caching** — Service worker aggressively cached old JS bundles. Required manual SW unregistration + cache clearing to pick up new code. Confirmed new Search chunk (`Search-CCZ_4BM7.js`) contains `query:` not `q:`.

**What Worked:** All 10 pages render correctly. Dashboard stats, capture creation, entity listing, governance sessions all functional through the tunnel.

---

### Entry 005 — Web UI rate-limit bypass [api] [config]
**Date:** 2026-03-30
**Duration:** ~10 minutes
**Environment:** Homeserver
**Status:** COMPLETED

**Objective:** Fix 429 rate limiting when browsing the dashboard normally.

**Hypothesis:** Rapid page navigation (each page makes 1-2 API calls) exhausts the 20 req/min strict tier. The web UI is a first-party client and should be exempt.

**Rollback Plan:** Revert nginx.conf and rate-limit.ts changes.

**Actions & Results:**
- Added `proxy_set_header X-Open-Brain-Caller "web-ui"` to nginx's `/api/` and `/api/v1/events` locations
- Added `internal:web-ui` to rate limiter bypass list alongside `internal:integration-test`
- Deployed and verified — Settings page "Clear" buttons work without 429

**Decision:** D11 — Web UI exempt from rate limiting. Safe because the header is injected by nginx inside the Docker network; external API callers without the header are still rate-limited.

---

### Entry 006 — Monthly maintenance system [deploy] [config]
**Date:** 2026-03-30
**Duration:** ~30 minutes
**Environment:** Homeserver + GitHub Actions
**Status:** COMPLETED

**Objective:** Create automated monthly maintenance with reporting to Slack and dashboard.

**Actions & Results:**

1. **Admin banner API** — `POST/GET/DELETE /api/v1/admin/banner`, Redis-backed with 30-day TTL. Dashboard.tsx fetches and renders above queue health banner. Hit ioredis import type issue — fixed with named import + `unknown` cast.

2. **Maintenance script** (`scripts/monthly-maintenance.sh`) — 5 checks: docker rebuild, dependency count, GitHub alerts, error log scan, health check. Posts to Slack + banner. Handles missing tools (pnpm, gh) gracefully.

3. **Homeserver cron** — Installed on `claude` user: `0 6 1 * *` (1st of month, 6 AM ET). Runs docker rebuild, error logs, health. Log at `/tmp/open-brain-maintenance.log`.

4. **GitHub Action** (`monthly-audit.yml`) — Scheduled `0 10 1 * *` (1st of month, 10 AM UTC). Runs `pnpm outdated` + Dependabot alert check, posts to Slack. Hit GITHUB_OUTPUT format issue and Dependabot API permission issue — both fixed with graceful fallbacks.

5. **CI fixes** — 3 test failures from the session's changes: api.test.ts `q→query`, intent-router.test.ts `max_tokens→max_completion_tokens`, Dashboard.test.tsx missing `adminApi` mock. All fixed. CI green.

6. **CI actions bumped** — checkout v4→v5, setup-node v4→v5, cache v4→v5 (Node 24-compatible). pnpm/action-setup v4 has no v5 yet — their problem, deadline June 2026.

**Decision:** D12 — Split maintenance between homeserver (docker/logs/health) and GitHub (deps/security). D13 — CI actions v5.

---

### Entry 007 — Repository cleanup [documentation]
**Date:** 2026-03-30
**Duration:** ~10 minutes
**Environment:** Laptop
**Status:** COMPLETED

**Objective:** Clean up repository structure and sync documentation after today's session.

**Actions & Results:**
- Archived 4 completed docs to `docs/archived/`: IMPLEMENTATION_PLAN-PHASE5/6/7.md, TEST_RESULTS_2026-03-09.md
- Updated README.md: LiteLLM/Qwen references → OpenAI API; added regression-test.mjs and monthly-maintenance.sh to scripts listing
- Updated CHANGELOG.md [Unreleased]: 3 Added, 3 Changed, 6 Fixed
- No artifacts found (no temp files, no OS artifacts)
- No stale branches, .gitignore comprehensive

---

### Entry 008 — Voice capture location feature [api] [web] [config]
**Date:** 2026-03-30
**Duration:** ~25 minutes
**Environment:** Laptop (development)
**Status:** COMPLETED

**Objective:** Add optional GPS location (latitude, longitude, location_name, location_accuracy) to voice captures from iOS Shortcut. Display in CaptureDetail. No schema migration — stored in existing source_metadata JSONB.

**Hypothesis:** Adding 4 optional form fields to the voice-capture endpoint and nesting them under `source_metadata.location` will flow transparently through core-api, pipeline, search, and UI without any changes to those systems. The only display change needed is CaptureDetail.tsx (replace raw JSON dump with structured metadata rendering). Success criteria: voice capture with location shows pin + name in CaptureDetail, voice capture without location works identically to current behavior.

**Rollback Plan:** `git revert` — all changes are additive. No migration, no data cleanup.

**Plan:** IMPLEMENTATION_PLAN.md — 4 phases, 16 items. Phase 1 (endpoint) + Phase 3 (docs) run in parallel. Phase 2 (display) + Phase 4 (tests) run after Phase 1.

**Actions & Results:**

1. **Phase 1 (endpoint) + Phase 3 (docs) — parallel execution.** Both agents completed successfully.
   - `server.ts`: parses latitude, longitude, location_name, location_accuracy from form fields; validates ranges + both-or-neither; nests under `source_metadata.location`
   - `ios-shortcut.md`: added Get Current Location action, 3 new form fields, updated reference table, optional note
   - Classification test updated: model name `'fast'` → `'gpt-5.4'` (pre-existing debt from OpenAI migration)
   - All 1,407 tests pass

2. **Phase 2 (display) + Phase 4 (tests) — parallel execution.** Both agents completed successfully.
   - `CaptureDetail.tsx`: new `SourceMetadataDisplay` component — structured rendering of device (icon), duration (Xm Ys), language, location (MapPin + Google Maps link). Unknown keys fall back to formatted key-value pairs. Light/dark mode compatible.
   - `server.test.ts`: 5 new tests in "location fields" describe block — valid coords, no location (backward compat), partial coords (400), out-of-range (400), non-numeric (400). Total voice-capture tests: 82.
   - All 1,412 tests pass (1,407 existing + 5 new)

---

--- New session: 2026-03-31 — Email pipeline, search fix, web synthesis ---

### Entry 009 — Email-to-capture pipeline [deploy] [api] [web] [config]
**Date:** 2026-03-31
**Duration:** ~2 hours
**Environment:** Laptop (development) + Homeserver (deployment) + Cloudflare (Email Worker)
**Status:** COMPLETED

**Objective:** Build email-to-capture pipeline: Cloudflare Email Worker receives mail at brain@troy-davis.com, extracts subject+body, POSTs to core-api as a capture with source='email'. Sender allowlist managed via dashboard Settings page. Also fix Slack bot synthesis routing and add 'email'+'mcp' source types.

**Hypothesis:** Cloudflare Email Routing + Workers can receive email at a custom address and forward structured content to the API without running an SMTP server. Dashboard-managed allowlist via a generic `app_settings` table will be more maintainable than environment variables. Success: email from allowlisted sender creates a capture; email from non-allowlisted sender is silently dropped.

**Rollback Plan:** Remove Cloudflare Email Route + Worker via dashboard. `git revert` PR #34 commits. Drop `app_settings` table if needed (migration 0010).

**Actions & Results:**

1. **Cloudflare Email Worker** — Created `email-worker/` at repo root with `wrangler.toml` and `src/index.ts`. Worker parses email (postal-mime), extracts subject+body, checks sender against allowlist fetched from core-api settings endpoint, POSTs to `/api/v1/captures` with `source: 'email'`, `source_metadata: { from, subject, date, messageId }`. Set `workers_dev = false` (no HTTP routes needed for email-only worker).

2. **Cloudflare Email Routing setup** — Configured `brain@troy-davis.com` catch-all → Email Worker via Cloudflare dashboard. Required domain already on Cloudflare (troy-davis.com). MX/TXT records auto-configured.

3. **API token** — Created "Edit Cloudflare Workers" API token (template provides all needed permissions: Workers Scripts, Workers Routes, Account Settings). Stored in Bitwarden for `wrangler deploy`.

4. **Migration 0010 — `app_settings` table** — Generic key-value store (`key TEXT PK, value JSONB, updated_at TIMESTAMPTZ`). Seeded with `email_allowlist` containing 5 initial addresses.

5. **Settings API** — `GET/PUT /api/v1/settings/:key` with `VALID_SETTINGS_KEYS` whitelist Set to prevent unbounded key creation. Rate limiter bypass added for `email-worker` caller.

6. **Settings UI** — New "Email Allowlist" card on Settings page. Inline add/remove with tag-style display. Fetches from settings API.

7. **Synthesis routing fix** — Slack bot's `!brain ask` was 404ing because the intent router sent requests to a non-existent synthesis endpoint path. Fixed routing.

8. **Source types** — Added `email` and `mcp` to the Zod source type enum in shared schema. SearchFilters type updated to include all source types.

9. **Slack Cleanup removed from nav** — Feature was vestigial; removed nav entry.

10. **Testing** — Email from allowlisted sender creates capture with correct metadata. Non-allowlisted sender gets 403 from worker. Python urllib test got 403 from Cloudflare (user-agent blocking) — switched to curl. Dashboard allowlist management works (add, remove, display).

**Root Causes of Issues:**
- `workers_dev = true` (default) creates unnecessary `*.workers.dev` HTTP endpoint for email-only workers
- Python urllib default user-agent blocked by Cloudflare WAF
- Email worker allowlist URL: needed regex `replace(/\/captures\/?$/, '')` instead of string replace to handle trailing slash variations

**What Worked:**
- Cloudflare Email Routing + Workers is remarkably simple — zero infrastructure, sub-second delivery
- Generic `app_settings` table design means future dashboard-managed settings need only a UI card + key whitelist entry
- postal-mime parses email cleanly including multipart/alternative (HTML+text)

**Decision:** D14 — Email capture via Cloudflare Email Worker (vs. running SMTP server or using third-party automation). D15 — Dashboard-managed sender allowlist via `app_settings` (vs. config file or env var).

---

### Entry 010 — Search page crash fix [web] [debug]
**Date:** 2026-03-31
**Duration:** ~10 minutes
**Environment:** Laptop (development)
**Status:** COMPLETED

**Objective:** Fix search page crash — API returns `{ results: [{ capture, score }] }` but frontend `SearchResult` type expected `{ captures: Capture[] }`.

**Hypothesis:** Pre-existing type mismatch between API response shape and frontend type definition. The search API was updated (hybrid search returns scored results) but the frontend type was never updated. Surface-level fix: update `searchApi.search()` to map `results` array correctly.

**Rollback Plan:** `git revert` — single-file change.

**Actions & Results:**
- Updated `searchApi.search()` to correctly destructure `{ results }` from API response and map each `{ capture, score }` to the frontend `SearchResult` type
- Root cause: API evolved to return scored results during hybrid search implementation, but frontend mapping was never updated. Bug was latent until search was actually tested with real data.

**What Worked:** Clean fix, no collateral damage.

---

### Entry 011 — Web synthesis answers [web] [api]
**Date:** 2026-03-31
**Duration:** ~20 minutes
**Environment:** Laptop (development)
**Status:** COMPLETED

**Objective:** Add LLM-synthesized answer cards to the search page. When the user's query looks like a question, show an AI-generated answer above the search results.

**Hypothesis:** Reusing the existing `POST /api/v1/synthesize` endpoint from the search page will provide a seamless "answer + supporting captures" experience. Questions are detected client-side (starts with question word or ends with `?`). Success: question queries show a synthesis card; non-question queries show results only.

**Rollback Plan:** `git revert` — additive UI change only.

**Actions & Results:**
- Added question detection logic in Search.tsx
- On question-type queries, fires parallel requests: search + synthesize
- Synthesis answer card renders above results with a distinct visual treatment
- Non-question queries behave identically to before (search only)
- Synthesis failures are non-blocking — search results still display

**What Worked:** The existing synthesize endpoint required zero changes. The parallel fetch pattern keeps perceived latency low — search results appear immediately while synthesis streams in.

**Decision:** D16 — Web synthesis on search page (vs. separate page or Slack-only).

---

--- New session: 2026-04-02 — Proactive Intelligence feature set (P1-P4, P6-P9) ---

### Entry 013 — Proactive Intelligence: autonomy levels, daily sweep, MCP context, heartbeat, Slack auto-response [feature] [api] [web] [slack] [workers] [mcp]
**Date:** 2026-04-02
**Duration:** TBD
**Environment:** Laptop (development)
**Tags:** `[feature]` `[api]` `[web]` `[slack]` `[workers]` `[mcp]`

**Objective:** Implement 8 features across 7 change sets to transform Open Brain from passive store to active thinking partner:
- CS1: Configurable autonomy levels (observe/assist/advise/partner) — gates all proactive features
- CS2: Daily sweep skill + unresolved questions tracker + dashboard widget
- CS3: MCP context bootstrap resource (`open_brain://context`)
- CS4: Heartbeat integration monitor (complete pipeline-health skill, schedule every 30 min)
- CS5: Slack auto-response shadow mode (classify channel questions, log draft responses)
- CS6: Slack DM-to-you mode (send Pushover/DM when confidence exceeds threshold)
- CS7: Slack threaded replies (autonomous responses with attribution at `advise` level)

**Hypothesis:** These features can be built incrementally following existing patterns (skill system, settings API, MCP tools, Slack handlers). CS1-CS4 are independent and can be implemented in parallel. CS5→CS6→CS7 are sequential (each extends the previous). P5 (CaptureCard unification) is already done (PR #37). Success: all unit tests pass, new features work in isolation, documentation updated.

**Rollback Plan:** `git revert` — all changes are additive. Autonomy level defaults to `observe` (most restrictive). Auto-response handler is async/fire-and-forget — disabling it has zero impact on existing bot behavior.

**Discovery:** P5 (Unify CaptureCard) already completed in PR #37 (`8c31728`). Only one CaptureCard implementation exists. Updated action item A4 to DONE.

**Actions & Results:**

**CS1 — Autonomy Levels:**
- Created `packages/shared/src/lib/autonomy.ts` — `AutonomyLevel` type, `meetsAutonomyLevel()` ordinal comparison, `AUTONOMY_DESCRIPTIONS`
- Added `autonomy_level`, `auto_response_threshold`, `auto_response_staleness_days` to `VALID_SETTINGS_KEYS` in settings.ts
- Added Autonomy Level section to Settings page with radio buttons and descriptions
- 6 unit tests pass

**CS2 — Daily Intelligence (P1 + P4):**
- Created `config/prompts/daily_sweep_v1.txt` — structured JSON output template
- Created `packages/workers/src/skills/daily-sweep-skill.ts` — full skill: query today's captures, unresolved questions (entity overlap heuristic), new entities; LLM synthesis; Pushover + save-to-brain
- Added `GET /api/v1/intelligence/unresolved-questions` endpoint with configurable window_days and limit
- Added Open Questions widget to Dashboard (fetches unresolved questions, shows count + excerpts)
- Wired into skill-execution worker and scheduler (8 PM daily)
- 38 unit tests pass

**CS3 — MCP Context Resource:**
- Created `packages/core-api/src/mcp/resources/context.ts` — generates markdown summary: focus areas, key entities, open questions, recent decisions, capture type distribution
- Registered as MCP resource at `open_brain://context` in server.ts
- 7 unit tests pass

**CS4 — Heartbeat Monitor:**
- Wired existing `pipeline-health` skill into skill-execution worker (was "not yet implemented" stub)
- Added capture flow check: alerts if no captures in 6 hours during active hours (7am-midnight)
- Scheduled every 30 minutes
- Updated `PipelineHealthResult` interface with `captureFlowStale` field
- 6 new unit tests pass, 24 existing pass (30 total)

**CS5-CS7 — Slack Auto-Response Pipeline:**
- Created `packages/slack-bot/src/services/confidence-scorer.ts` — composite score (50% search, 30% coverage, 20% recency)
- Created `packages/slack-bot/src/services/attribution-formatter.ts` — Slack mrkdwn with source citations
- Created `packages/slack-bot/src/handlers/auto-response.ts` — three modes gated by autonomy level:
  - observe: shadow log (always)
  - assist: Pushover notification with draft
  - advise: threaded reply with attribution, corroboration, staleness checks
- Integrated into server.ts as async fire-and-forget after normal routing
- Added `getAutonomyLevel()` with 5-minute cache
- 26 unit tests pass across auto-response and confidence-scorer test files

**Test Results:**
- shared: 40, core-api: 423, workers: 498, slack-bot: 384, web: 77, voice-capture: 82
- **Total: 1,504 tests, 0 failures** (up from 1,412 unit + 95 regression)
- All packages build cleanly (tsup/vite)

**Deployment (2026-04-02):**
- Built and deployed core-api, workers, slack-bot, web containers
- All 9 containers healthy
- **Bug found:** pipeline-health skill created internal Queue instances using `REDIS_HOST` (not set) instead of parsing `REDIS_URL=redis://redis:6379`. Fixed by adding `REDIS_URL` parsing fallback. Committed directly to main (10509b0).
- **pipeline-health trigger:** Executed in 324ms, correctly detected `captureFlowStale:true` (last capture 12h ago)
- **daily-sweep-skill trigger:** Executed in 2,742ms. Processed today's captures, generated headline ("A productive day ended with coworker catch-up and a date night with Ashley"), detected 2 new entities, sent Pushover notification, saved as capture.
- Skills list shows all 5 skills with correct schedules
- Unresolved questions endpoint returns 0 (correct — no unanswered questions yet)
- Web dashboard healthy

**What Worked:** All new features work in production. Skill execution framework handled the new skills without any issues. Pushover delivery confirmed. The daily-sweep-skill produced a relevant, actionable summary.

**What Failed:** Pipeline-health Redis connection — pre-existing bug surfaced by first-ever execution. Fixed in 5 minutes.

**Decision:** D19 — Autonomy levels gating proactive features (observe/assist/advise/partner). Default `observe`. See entry 013.
**Decision:** D20 — Auto-response uses fire-and-forget async; never blocks normal Slack message handling. Autonomy level cached 5 minutes.
**Decision:** D21 — Pipeline-health uses REDIS_URL parsing with fallback to REDIS_HOST. Docker containers set REDIS_URL.
**Decision:** D22 — Rename health endpoint `litellm` service key to `llm`. LiteLLM proxy removed; system calls OpenAI directly.

**Post-deploy UI walkthrough (2026-04-02):**
- Dashboard: 16 captures, pipeline healthy, daily sweep capture visible
- Search: Hybrid search + synthesis answer card working (tested "What happened with the Stratfield coworkers?")
- Timeline: 16 captures grouped by date, brain view color dots
- Entities: 240 entities, correct type badges and mention counts
- Intelligence: Daily connections (4 cross-domain patterns), drift monitor
- Settings: Autonomy Level section with 4 radio buttons (Observe active), all 5 skills with last-run times
- **Found & fixed:** "Litellm" label in Service Health → renamed to "LLM" (health endpoint key + Settings page display override). Committed 735108e, deployed.
- PWA cache required Ctrl+Shift+R to pick up new bundles (known issue, documented in CLAUDE.md)

--- New session: 2026-04-03 — Run Brief configuration panel ---

### Entry 014 — Run Brief configuration panel: configurable time window for weekly brief [feature] [web]
**Date:** 2026-04-03
**Duration:** ~30 min
**Environment:** Laptop (development)
**Tags:** `[feature]` `[web]`

**Objective:** Replace the instant-fire "Run Now" button on the Briefs page with an inline configuration panel that lets the user choose a time window before triggering a weekly brief. Default 7 days, with presets and custom input.

**Hypothesis:** The backend already accepts `windowDays` through the full chain (skills route → BullMQ job → skill-execution worker → WeeklyBriefSkill.execute). Only the frontend needs changes: update `skillsApi.trigger()` to accept overrides, and build an inline panel component. Success: panel opens on "Run Now" click, all 6 presets compute correct day counts, custom input validates, trigger sends correct `windowDays` in POST body, TypeScript compiles cleanly.

**Rollback Plan:** `git revert` — pure frontend addition, no backend/DB changes.

**Investigation:**
- Traced full data path: `skillsApi.trigger()` → `POST /skills/:name/trigger` (skills.ts:88-130) → body parsed as `overrides` → BullMQ job `input` → `skill-execution.ts:50` extracts `windowDays` → `weekly-brief.ts:47` uses it with `DEFAULT_WINDOW_DAYS = 7` fallback
- Backend already handles `windowDays` — confirmed in `skill-execution.ts:50` (`typeof input?.windowDays === 'number'`)
- Frontend `skillsApi.trigger()` was hardcoded to send `JSON.stringify({})` — no mechanism for overrides
- Existing Briefs page uses expand/collapse cards (BriefCard) — inline panel matches this pattern

**Design Decisions:**
- Inline expanding panel (not modal) — consistent with BriefCard expand/collapse pattern on the page
- 6 presets: This Week (Sunday→today), This Month (1st→today), 7d, 14d, 30d, 60d
- Custom numeric input with validation (1-365 days, integer only)
- Live date range preview (e.g., "Mar 27 — Apr 3, 2026 (7 days)")
- Warning for 90+ day windows (AI token cost)
- Uses existing shadcn components only (Button, Input, Separator) — no new deps

**Changes:**
1. `packages/web/src/lib/api.ts` — Added optional `overrides?: Record<string, unknown>` param to `skillsApi.trigger()`, passed as POST body
2. `packages/web/src/pages/Briefs.tsx` — Added:
   - `computePresetDays()` — date math for This Week (getDay → days since Sunday) and This Month (getDate)
   - `formatDateRange()` — human-readable "from — to (N days)" label
   - `PRESETS` constant (6 presets with fixed days or 'compute' marker)
   - `RunBriefPanel` component — preset buttons, custom input, validation, date preview, action buttons
   - `showPanel` state, "Run Now" toggles panel instead of triggering directly
   - `handleTrigger(windowDays)` passes `{ windowDays }` to `skillsApi.trigger()`

**Verification:**
- TypeScript: `pnpm --filter @open-brain/web exec tsc --noEmit` — zero errors
- No backend changes needed — API contract unchanged
- No new dependencies

**What Worked:** Backend plumbing for `windowDays` was already complete from the original weekly-brief implementation. This was a pure frontend feature — minimal blast radius.

*Entries continue below.*
