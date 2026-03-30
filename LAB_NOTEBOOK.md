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

## Action Items

### Open
| # | Action | Created | Source | Priority |
|---|--------|---------|--------|----------|
| A1 | ~~Deploy Phase 7 consolidated code to homeserver~~ | 2026-03-30 | IMPL_PLAN_PHASE7 | DONE — deployed, verified via test suite |
| A2 | Verify pg-notify reconnection works under real disconnect | 2026-03-30 | Phase 7 | MEDIUM |
| A3 | Deferred features: F21 voice transcription history, F22 entity merge UI, F24 multi-user | 2026-03 | PRD | LOW — Could Have / Won't Have |

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
| Version | v1.2.0 + Phase 7 + OpenAI migration | 42 commits on main |
| Containers | 9 in docker-compose.yml | core-api, workers, slack-bot, voice-capture, faster-whisper, web, postgres, redis, cloudflared |
| Tests | 1,407 unit + 95 regression | All passing (CI green) |
| LLM backend | OpenAI API | gpt-5.4 (all aliases), text-embedding-3-large (768d) |
| Database | Postgres 16 + pgvector | vector(768) schema |
| External access | brain.troy-davis.com | Cloudflare Tunnel |
| Deployment | Fully deployed | All code on homeserver, 100% regression pass rate |
| Maintenance | Automated | Homeserver cron (1st/month) + GitHub Action (monthly-audit.yml) |

---

## Experiment Log

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

*Entries continue below.*
