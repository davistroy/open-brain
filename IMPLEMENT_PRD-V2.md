# Implementation Plan — Open Brain v2

**Generated:** 2026-04-11 01:30:00
**Based On:** docs/PRD-V2.md (reviewed architecture with Claude subscription model, Deepgram STT, CF inbound email retention)
**Total Phases:** 6
**Estimated Total Effort:** ~6,500 LOC across ~90 files

---

## Executive Summary

Open Brain v2 expands the architecture in six directions: dual-client model routing (Claude SDK subscription + LiteLLM), parallel pipeline DAGs (BullMQ FlowProducer), an LLM-maintained wiki layer (Git-backed on Gitea), dashboard evolution (activity feed, wiki browser, system health), outbound email (Himalaya), and conversational voice (Pipecat + Deepgram). The implementation is phased so each delivery leaves the system in a working state, with foundation infrastructure (model routing, pipeline flows) built first and the highest-risk feature (voice) last.

Key architectural decisions from the PRD review:
- Claude Code subscription absorbs all Claude LLM costs ($0 marginal). LiteLLM proxy handles embeddings and local models with cost tracking.
- Cloudflare Email Worker stays for inbound email (push-based, already deployed). Himalaya added for outbound composition/sending only.
- Deepgram cloud STT for real-time voice (CPU hardware can't do local real-time). Phase 0 spike required before committing to voice implementation.
- Activity feed uses an insert-based table (not materialized view) for real-time SSE.

The codebase is well-structured for extension: 15 route modules, 18 services, 13 database tables, 8 MCP tools, SSE via pg-notify already implemented, and established patterns for adding pages, routes, workers, and skills.

---

## Plan Overview

The implementation follows a dependency-ordered sequence. Phase 1 (Foundation) delivers the model router and pipeline DAGs that every subsequent phase depends on. Phase 2 (Wiki) is the highest-value feature with moderate risk. Phases 3-5 build observability, intelligence skills, and email on top of the foundation. Phase 6 (Voice) is deferred to last as the highest-risk, most isolated feature requiring a Python service in a TypeScript monorepo.

### Phase Summary Table

| Phase | Focus Area | Key Deliverables | Est. Complexity | Dependencies |
|-------|------------|------------------|-----------------|--------------|
| 1 | Foundation | Dual-client model router, FlowProducer pipeline DAGs, system health strip | L (~15 files, ~1,200 LOC) | None |
| 2 | Wiki Layer | Gitea integration, wiki-ingest worker, wiki API/MCP, wiki browser UI | L (~18 files, ~1,500 LOC) | Phase 1 |
| 3 | Pipeline Hardening & Dashboard | Rate limiting, activity feed, MCP logging, enhanced System page | L (~20 files, ~1,400 LOC) | Phase 1 |
| 4 | Intelligence & Settings | Wiki-lint, wiki-synthesis, drift, connections, reflection skills, settings expansion | M (~15 files, ~1,000 LOC) | Phases 1, 2 |
| 5 | Outbound Email & Infra Skills | Himalaya outbound, email drafts, Slack commands, backup/cost/health skills | M (~18 files, ~900 LOC) | Phase 1 |
| 6 | Voice Conversations | Phase 0 Deepgram spike, Pipecat service, session management, voice UI | L (~15 files, ~1,200 LOC) | Phase 1 |

<!-- BEGIN PHASES -->

---

## Phase 1: Foundation

**Estimated Complexity:** L (~15 files, ~1,200 LOC)
**Dependencies:** None
**Parallelizable:** Yes — model router (1.1-1.3) and pipeline flows (1.4) are independent streams

### Goals

- Replace single OpenAI SDK client with dual-client routing: Claude SDK (subscription) + LiteLLM (embeddings/local)
- Implement `runAgent()` — the sole agent runtime for all LLM tool-use loops
- Restructure the ingest pipeline from sequential queue bridging to BullMQ FlowProducer DAGs
- Deliver system health API and dashboard health strip for real-time monitoring

### Work Items

#### 1.1 Add Anthropic SDK and create Claude client factory -- COMPLETE
<!-- Status values: PENDING, IN_PROGRESS, COMPLETE [YYYY-MM-DD] -->
**Status: COMPLETE [2026-04-11]**
**Requirement Refs:** PRD-V2 F4.1, F4.3
**Files Affected:**
- `package.json` (root + packages/shared, core-api, workers) (modify — add @anthropic-ai/sdk)
- `packages/shared/src/services/anthropic-client.ts` (create)
- `packages/shared/src/index.ts` (modify — export new client)
- `config/ai-routing.yaml` (modify — add client_preference per task type)

**Description:**
Add the Anthropic SDK as a dependency and create a `createAnthropicClient()` factory function mirroring the existing `createLiteLLMClient()` pattern. The factory reads `ANTHROPIC_API_KEY` from environment (sourced from Bitwarden), returns null if missing (graceful degradation). Update `ai-routing.yaml` to specify which client handles each task type: Claude SDK for fast/synthesis/governance/conversation/intent, LiteLLM for embedding/local.

**Tasks:**
1. [x] Add `@anthropic-ai/sdk` to root package.json and relevant workspace packages
2. [x] Create `packages/shared/src/services/anthropic-client.ts` with `createAnthropicClient()` factory
3. [x] Export from `packages/shared/src/index.ts`
4. [x] Update `config/ai-routing.yaml`: add `client` field per model alias (anthropic | litellm), add `conversation` and `local` task types, add per-model cost rates
5. [x] Update config types in `packages/shared/src/types/` to reflect new schema
6. [x] Run `pnpm install && pnpm build` to verify

**Acceptance Criteria:**
- [x] `createAnthropicClient()` returns an Anthropic SDK client when API key is set
- [x] Returns null when API key is empty (matches LiteLLM client pattern)
- [x] `ai-routing.yaml` defines client preference for all task types
- [x] Shared package builds and exports both client factories

**Notes:**
ANTHROPIC_API_KEY must be stored in Bitwarden. The Claude Code subscription provides API access — the key is the same Anthropic API key used with the subscription. Do NOT remove the existing OpenAI SDK or createLiteLLMClient — embeddings still flow through it.

---

#### 1.2 Refactor LLMGatewayService for dual-client routing ✅
<!-- Status values: PENDING, IN_PROGRESS, COMPLETE [YYYY-MM-DD] -->
**Status: COMPLETE [2026-04-11]**
**Requirement Refs:** PRD-V2 F4.1, F4.2, F4.4, F4.6, F4.7
**Files Affected:**
- `packages/core-api/src/services/llm-gateway.ts` (modify)
- `packages/core-api/src/index.ts` (modify — pass Anthropic client)
- `packages/workers/src/main.ts` (modify — init Anthropic client)
- `packages/shared/src/schema/core.ts` (modify — extend ai_audit_log with client_used + cost_usd)
- `packages/shared/drizzle/0013_ai_audit_log_client_tracking.sql` (create — migration)
- `packages/workers/src/jobs/extract-entities.ts` (modify — fix model alias resolution for new config format)
- `packages/workers/src/jobs/skill-execution.ts` (modify — fix model alias resolution for new config format)

**Description:**
Extend LLMGatewayService to accept both an Anthropic client and an OpenAI/LiteLLM client. Route LLM calls based on the `client` field in ai-routing.yaml: Claude SDK for inference tasks (fast, synthesis, governance, conversation, intent), LiteLLM for embeddings and local models. Update audit logging to record which client was used and mark Claude calls as cost=$0 (subscription-covered). Add fallback behavior: if primary client fails (429/500), try the other if configured.

**Tasks:**
1. [x] Extend LLMGatewayService constructor to accept optional Anthropic client
2. [x] Add routing logic: resolve task_type → client from config
3. [x] Implement Claude SDK call path (messages API with proper response mapping)
4. [x] Add `client_used` field to ai_audit_log entries
5. [x] Mark Claude calls with `cost_usd: 0` in audit log (subscription)
6. [x] Wire Anthropic client through dependency injection in core-api/index.ts and workers/main.ts

**Acceptance Criteria:**
- [x] LLM calls for `fast`, `synthesis`, `governance` route through Claude SDK
- [x] Embedding calls route through LiteLLM (unchanged)
- [x] Audit log records which client was used per call
- [x] Existing tests pass — no behavioral change for callers (1,638 tests, 0 failures)
- [x] Fallback to other client on 429/500 errors (configurable)

**Notes:**
The Claude SDK messages API uses a different format than OpenAI (no `model` in messages, different tool_use format). The gateway must translate between internal types and each SDK's native format. All existing skills pass `modelAlias` — they don't need to know which client handles it.

---

#### 1.3 Implement runAgent() function ✅
<!-- Status values: PENDING, IN_PROGRESS, COMPLETE [YYYY-MM-DD] -->
**Status: COMPLETE [2026-04-11]**
**Requirement Refs:** PRD-V2 F4.5
**Files Affected:**
- `packages/shared/src/services/run-agent.ts` (create)
- `packages/shared/src/index.ts` (modify — export)

**Description:**
Create a `runAgent(systemPrompt, tools, userMessage, options)` function that implements the Claude tool_use loop: send message → if tool_use blocks in response, execute the tool, append result, loop → return final text response. This is the sole agent runtime for the system — all agentic behaviors (wiki ingest, email composition, governance, reflection) use this function.

**Tasks:**
1. [ ] Create `packages/shared/src/services/run-agent.ts`
2. [ ] Implement the tool_use loop with configurable max iterations (default 10)
3. [ ] Accept a `tools` array with execute functions and Anthropic tool schemas
4. [ ] Handle tool errors gracefully (report to Claude, let it recover)
5. [ ] Return structured result: final text, tool calls made, token usage, duration
6. [ ] Write unit tests with mocked Anthropic client

**Acceptance Criteria:**
- [ ] Successfully executes a multi-turn tool_use conversation
- [ ] Respects max iteration limit (prevents infinite loops)
- [ ] Returns final text response after tool loop completes
- [ ] Reports total token usage across all turns
- [ ] Handles tool execution errors without crashing

**Notes:**
The existing governance engine and skills have their own ad-hoc LLM calling patterns. Those will be migrated to use runAgent() in later phases — this phase just creates the function.

---

#### 1.4 Restructure ingest pipeline to FlowProducer DAGs ✅
<!-- Status values: PENDING, IN_PROGRESS, COMPLETE [YYYY-MM-DD] -->
**Status: COMPLETE [2026-04-11]**
**Requirement Refs:** PRD-V2 F3.1, F3.2, F3.3
**Files Affected:**
- `packages/workers/src/flows/ingest-pipeline.ts` (create)
- `packages/workers/src/jobs/ingest-root.ts` (create)
- `packages/workers/src/main.ts` (modify — add FlowProducer + ingest-root worker)
- `packages/workers/src/jobs/ingestion-worker.ts` (modify — use FlowProducer when enabled)
- `packages/workers/src/jobs/embed-capture.ts` (modify — skip manual queue bridging for flow children)
- `packages/workers/src/index.ts` (modify — export new modules)

**Description:**
Replace the current manual queue bridging (ingestion enqueues embed, embed enqueues extract + triggers) with a BullMQ FlowProducer that defines the full pipeline as a DAG. Root job (`ingest-root`) has parallel children: `embed-capture` and `extract-entities`. Both must complete before `link-entities` proceeds. Post-linking: `check-triggers` and `notify` as parallel children. All existing behavior preserved: status flow, retry policy, daily auto-sweep. Feature flag `PIPELINE_USE_FLOWS=true` enables the new path; legacy queue bridging remains the default.

**Tasks:**
1. [x] Create `packages/workers/src/flows/ingest-pipeline.ts` with DAG definition function
2. [x] Create `packages/workers/src/jobs/ingest-root.ts` — post-pipeline enrichment worker (link-entities + check-triggers)
3. [x] Initialize FlowProducer in `main.ts` with Redis connection (feature-flagged)
4. [x] Update `ingestion-worker.ts`: use `flowProducer.add(dagDefinition)` when enabled, fallback to legacy `queue.add()`
5. [x] Update `embed-capture.ts`: detect flow child via `job.parent`, skip manual queue bridging
6. [x] Set `failParentOnFailure: true` on embed (critical), `removeDependencyOnFailure: true` on extract-entities (non-critical)
7. [x] Preserve idempotent jobId patterns (`embed_${captureId}`, `extract-entities_${captureId}`, `ingest-root_${captureId}`)
8. [x] Write unit tests for flow definition and ingest-root worker (16 new tests)

**Acceptance Criteria:**
- [x] Captures flow through the full DAG: ingest → (embed || extract) → ingest-root (link-entities + triggers)
- [x] Pipeline status still reaches 'complete' after embedding (unchanged in embed-capture)
- [x] Existing retry policy (patient backoff) preserved — attempts/backoff on flow children
- [x] embed failure fails the entire flow; extract failure does NOT (failParentOnFailure vs removeDependencyOnFailure)
- [x] All existing unit tests pass (1,654 tests, 0 failures)
- [x] Feature flag `PIPELINE_USE_FLOWS=true` enables gradual rollout; legacy path is default

**Notes:**
Implemented with a feature flag as recommended by the risk register. The `ingest-root` worker is always registered (even when flows are disabled) so it can drain any jobs if flows were previously enabled then disabled. Detection of flow children uses BullMQ's native `job.parent` property — no custom metadata needed.

---

#### 1.5 System health API endpoints ✅
<!-- Status values: PENDING, IN_PROGRESS, COMPLETE [YYYY-MM-DD] -->
**Status: COMPLETE [2026-04-11]**
**Requirement Refs:** PRD-V2 F6.6
**Files Affected:**
- `packages/core-api/src/services/system-health.ts` (create)
- `packages/core-api/src/routes/system-health.ts` (create)
- `packages/core-api/src/app.ts` (modify — register routes, add dependency)
- `packages/core-api/src/index.ts` (modify — instantiate service, pass to createApp)
- `packages/core-api/src/__tests__/system-health.test.ts` (create — 23 tests)

**Description:**
Create comprehensive system health API endpoints. `GET /api/v1/system/health` returns JSON with: queue depths per queue (waiting + active), last successful skill run, voice service status, Redis memory usage, LLM monthly spend vs budget, overall status (healthy/degraded/unhealthy). `GET /api/v1/system/health/stream` returns SSE stream updating every 10 seconds via the existing pg-notify infrastructure.

**Tasks:**
1. [x] Create `SystemHealthService` that aggregates: BullMQ queue stats, Redis INFO, ai_audit_log monthly spend, skills_log last runs
2. [x] Create `system-health.ts` route module with GET (snapshot) and GET /stream (SSE)
3. [x] Wire SSE to existing pg-notify `EventSource` pattern (events.ts is the template)
4. [x] Define warning/critical thresholds per PRD-V2 F6.3
5. [x] Register routes in index.ts

**Acceptance Criteria:**
- [x] `/api/v1/system/health` returns comprehensive JSON with all health metrics
- [x] `/api/v1/system/health/stream` delivers SSE events every 10 seconds
- [x] Overall status correctly reflects worst-case component status
- [x] Thresholds: queue >50 = yellow, >200 = red; spend >$7 = yellow, >$10 = red

**Notes:**
Extends the existing `/health` endpoint (which only checks postgres, redis, llm connectivity). The new endpoint provides operational metrics, not just liveness. The existing health endpoint stays for Docker healthchecks.

---

#### 1.6 Dashboard system health strip component
<!-- Status values: PENDING, IN_PROGRESS, COMPLETE [YYYY-MM-DD] -->
**Status: COMPLETE [2026-04-11]**
**Requirement Refs:** PRD-V2 F6.1-F6.5
**Files Affected:**
- `packages/web/src/components/StatusStrip.tsx` (create)
- `packages/web/src/components/Layout.tsx` (modify — add strip)
- `packages/web/src/lib/api.ts` (modify — add systemHealthApi)

**Description:**
Create a persistent, compact status bar displayed across the top of every dashboard page. Shows: queue depths, last skill run, voice status, LLM spend vs budget, overall status indicator. Data refreshed via SSE from the new health stream endpoint. Collapses to a single status dot on mobile. Clicking any indicator navigates to the relevant detail view.

**Tasks:**
1. [x] Create `StatusStrip.tsx` with indicator components for each metric
2. [x] Connect to `/api/v1/system/health/stream` SSE endpoint
3. [x] Implement color logic: green (normal), yellow (warning), red (critical)
4. [x] Add to `Layout.tsx` so it appears on every page
5. [x] Implement mobile collapse (single dot, expandable on tap)
6. [x] Add `systemHealthApi` to api.ts for the snapshot fallback

**Acceptance Criteria:**
- [x] Strip visible on all pages (persistent in Layout)
- [x] Real-time updates via SSE (falls back to 30s polling if SSE unavailable)
- [x] Correct color coding based on thresholds
- [x] Mobile responsive (collapses to dot)
- [x] Clicking indicators navigates to relevant page

**Notes:**
This is the first dashboard feature to use SSE. Wire it using the existing `sseClient` infrastructure in `packages/web/src/lib/sse.ts` (built but currently unused). This establishes the pattern for activity feed and other real-time features.

---

### Phase 1 Testing Requirements

- [ ] All existing 1,569 unit tests pass
- [ ] All 95 regression tests pass
- [ ] New tests for: Anthropic client factory, dual-client routing, runAgent(), FlowProducer DAG execution
- [ ] E2E: submit capture → verify complete pipeline via flow DAG
- [ ] Manual: health strip updates in real-time on dashboard

### Phase 1 Completion Checklist

- [ ] All work items complete
- [ ] All tests passing
- [ ] Claude SDK calls work via subscription API key
- [ ] Pipeline processes captures via FlowProducer DAGs
- [ ] Health strip visible on dashboard
- [ ] No regressions in existing capture/search/entity functionality
- [ ] Deployed to homeserver and verified

---

## Phase 2: Wiki Layer

**Estimated Complexity:** L (~18 files, ~1,500 LOC)
**Dependencies:** Phase 1 (model router for LLM calls, FlowProducer for wiki-ingest queue)
**Parallelizable:** Yes — backend (2.1-2.3) and frontend (2.5) can overlap once API is stubbed

### Goals

- Establish the Gitea-backed wiki repository with schema, index, and directory structure
- Build wiki-ingest worker that integrates captures into the wiki via LLM
- Deliver wiki API endpoints and MCP tools for reading/writing wiki pages
- Ship the wiki browser dashboard page

### Work Items

#### 2.1 Create Gitea wiki repository and Git operations utility
<!-- Status values: PENDING, IN_PROGRESS, COMPLETE [YYYY-MM-DD] -->
**Status: PENDING**
**Requirement Refs:** PRD-V2 F2.1-F2.5
**Files Affected:**
- `packages/shared/src/services/wiki-git.ts` (create)
- `packages/shared/package.json` (modify — add simple-git)

**Description:**
Set up the wiki repository at `gitea.k4jda.net/davistroy/open-brain-wiki` with initial structure: `WIKI_SCHEMA.md`, `index.md`, `log.md`, and directories (`wiki/entities/`, `wiki/concepts/`, `wiki/sources/`, `wiki/comparisons/`, `wiki/synthesis/`). Create a Git operations utility using `simple-git` npm package that handles: clone, pull, read file, write file with auto-commit, list files with frontmatter parsing, git log for recent changes.

**Tasks:**
1. [ ] Create wiki repo on Gitea with initial structure and WIKI_SCHEMA.md
2. [ ] Add `simple-git` dependency to shared package
3. [ ] Create `wiki-git.ts` with WikiGitService class: init(), pull(), readPage(), writePage(), listPages(), getRecentChanges(), commitAndPush()
4. [ ] Handle Git auth via SSH key or Personal Access Token (from Bitwarden)
5. [ ] Add YAML frontmatter parsing for wiki page metadata
6. [ ] Write unit tests with mocked Git operations

**Acceptance Criteria:**
- [ ] Wiki repo exists on Gitea with correct directory structure
- [ ] WikiGitService can clone, read, write, commit, and push
- [ ] YAML frontmatter correctly parsed from wiki pages
- [ ] Git operations are serializable (concurrency safety via queue, not code-level locks)

**Notes:**
The wiki repo clone path should be configurable (default: `/tmp/open-brain-wiki` in containers, local path for development). Git auth credentials stored in Bitwarden. Consider mounting as a Docker volume for persistence across container restarts.

---

#### 2.2 Wiki-ingest BullMQ worker
<!-- Status values: PENDING, IN_PROGRESS, COMPLETE [YYYY-MM-DD] -->
**Status: PENDING**
**Requirement Refs:** PRD-V2 F2.6, F3.4
**Files Affected:**
- `packages/workers/src/queues/wiki-ingest.ts` (create)
- `packages/workers/src/skills/wiki-ingest.ts` (create)
- `packages/workers/src/jobs/skill-execution.ts` (modify — add wiki-ingest case)
- `packages/workers/src/main.ts` (modify — register wiki-ingest worker)
- `config/prompts/wiki-ingest/` (create — prompt templates)

**Description:**
Create a wiki-ingest BullMQ worker triggered after entity linking in the pipeline flow. The worker uses `runAgent()` with wiki-specific tools: read capture content, read relevant wiki pages (via index.md), write/update wiki pages, update index.md. Rate-limited to 5 jobs/minute to control LLM cost. Concurrency=1 to serialize Git operations.

**Tasks:**
1. [ ] Create wiki-ingest queue with rate limiting (max 5/min) and concurrency=1
2. [ ] Create wiki-ingest skill that uses runAgent() with wiki tools
3. [ ] Define prompt template: "You are a wiki curator. Read this capture, identify which wiki pages need updating, and make the changes."
4. [ ] Implement wiki tools for runAgent(): read_wiki_page, write_wiki_page, list_wiki_pages, update_index
5. [ ] Wire into pipeline flow DAG (Phase 1.4) as non-critical post-link child
6. [ ] Log wiki operations to log.md (append-only)

**Acceptance Criteria:**
- [ ] New captures trigger wiki-ingest after entity linking
- [ ] Wiki pages are created/updated based on capture content
- [ ] index.md is updated after each ingest
- [ ] Rate limiting prevents more than 5 wiki ingests per minute
- [ ] Wiki-ingest failure does NOT fail the parent pipeline flow
- [ ] Git operations are serialized (no lock contention)

**Notes:**
The quality of wiki pages depends heavily on prompt engineering. Start conservative — better to under-write than over-write. The wiki-lint skill (Phase 4) will catch quality issues. All wiki LLM calls use the `synthesis` task type (Claude Opus via subscription — $0).

---

#### 2.3 Wiki API endpoints and MCP tools
<!-- Status values: PENDING, IN_PROGRESS, COMPLETE [YYYY-MM-DD] -->
**Status: PENDING**
**Requirement Refs:** PRD-V2 F2.10-F2.12
**Files Affected:**
- `packages/core-api/src/routes/wiki.ts` (create)
- `packages/core-api/src/services/wiki.ts` (create)
- `packages/core-api/src/mcp/tools/wiki-tools.ts` (create)
- `packages/core-api/src/index.ts` (modify — register wiki routes and MCP tools)

**Description:**
Add wiki routes to core-api: list pages, get page content, recent changes, lint report, search, manual ingest trigger, manual lint trigger. Add 4 MCP tools: search_wiki, read_wiki_page, write_wiki_page, list_wiki_pages. Wiki service wraps WikiGitService and handles markdown rendering, search, and BullMQ job triggering.

**Tasks:**
1. [ ] Create WikiService that wraps WikiGitService with caching and search
2. [ ] Create wiki.ts route module with all endpoints per PRD-V2 Section 8.1
3. [ ] Create wiki MCP tools following existing tool patterns (tools/ directory)
4. [ ] Register routes and MCP tools in index.ts
5. [ ] Implement wiki search (initially via index.md scanning; FTS when >200 pages)

**Acceptance Criteria:**
- [ ] All wiki API endpoints return correct data
- [ ] MCP tools work from Claude Code (search, read, write, list)
- [ ] Manual ingest trigger enqueues a wiki-ingest job
- [ ] Wiki search returns relevant pages with snippets

**Notes:**
The write_wiki_page MCP tool allows Claude Code to directly update the wiki during development sessions. This is powerful but should log all operations to log.md for audit trail.

---

#### 2.4 Dashboard wiki browser page
<!-- Status values: PENDING, IN_PROGRESS, COMPLETE [YYYY-MM-DD] -->
**Status: PENDING**
**Requirement Refs:** PRD-V2 F8.1-F8.8
**Files Affected:**
- `packages/web/src/pages/Wiki.tsx` (create)
- `packages/web/src/components/WikiNavTree.tsx` (create)
- `packages/web/src/components/WikiPageRenderer.tsx` (create)
- `packages/web/src/lib/api.ts` (modify — add wikiApi)
- `packages/web/src/components/Layout.tsx` (modify — add Wiki to nav)
- `packages/web/src/App.tsx` (modify — add /wiki route)

**Description:**
Two-panel wiki browser: navigation tree on the left (collapsible directory structure), rendered markdown on the right. Page metadata header (title, type badge, updated, source count, tags). Three tabs: Content, Recent Changes (git log), Health (lint report). Search box for full-text wiki search. Action buttons: "Run Lint Now", "Re-synthesize Page". Lazy-loaded route chunk.

**Tasks:**
1. [ ] Create WikiNavTree component with collapsible directory structure
2. [ ] Create WikiPageRenderer using existing react-markdown (same as Help page)
3. [ ] Create Wiki page with two-panel layout and tab navigation
4. [ ] Add wikiApi to api.ts (pages, page content, recent changes, lint, search)
5. [ ] Add /wiki route to App.tsx and Wiki to Layout navigation
6. [ ] Implement lazy loading for the wiki route chunk

**Acceptance Criteria:**
- [ ] Wiki pages render correctly with markdown formatting
- [ ] Navigation tree mirrors wiki directory structure
- [ ] Recent Changes tab shows git log entries
- [ ] Search returns relevant wiki pages
- [ ] "Run Lint Now" and "Re-synthesize" buttons trigger jobs with toast confirmation

**Notes:**
The existing Help page uses react-markdown — reuse the same rendering component and styling. Wiki page links should be clickable and navigate within the wiki browser (client-side routing, not full page reload).

---

### Phase 2 Testing Requirements

- [ ] Wiki-ingest worker creates/updates wiki pages from test captures
- [ ] All wiki API endpoints return correct data
- [ ] MCP wiki tools work from Claude Code
- [ ] Wiki browser renders pages correctly
- [ ] Git operations don't create lock conflicts under sequential access

### Phase 2 Completion Checklist

- [ ] All work items complete
- [ ] Wiki repository populated with initial structure
- [ ] At least 5 wiki pages created from existing captures (manual or automated)
- [ ] Wiki browser accessible in dashboard
- [ ] MCP tools verified from Claude Code
- [ ] Deployed to homeserver

---

## Phase 3: Pipeline Hardening & Dashboard

**Estimated Complexity:** L (~20 files, ~1,400 LOC)
**Dependencies:** Phase 1 (pipeline flows, health API)
**Parallelizable:** Yes — backend (3.1-3.3) and frontend (3.4-3.5) are independent

### Goals

- Add dynamic rate limiting and deduplication to the ingest pipeline
- Deliver the unified activity feed (table, API, SSE, dashboard)
- Add MCP activity logging for transparency
- Build the enhanced System page (queues, flows, skills views)

### Work Items

#### 3.1 Dynamic rate limiting and ingest deduplication
<!-- Status values: PENDING, IN_PROGRESS, COMPLETE [YYYY-MM-DD] -->
**Status: PENDING**
**Requirement Refs:** PRD-V2 F3.8, F3.9
**Files Affected:**
- `packages/workers/src/jobs/embed-capture.ts` (modify — add rate limiting)
- `packages/workers/src/jobs/ingestion-worker.ts` (modify — add dedup)
- `packages/workers/src/main.ts` (modify — rate limiter config)

**Description:**
Add dynamic rate limiting on the embed queue tied to non-Claude LLM spend (only embeddings cost money). When monthly spend exceeds $7 (soft limit), throttle embed jobs. At $10 (hard limit), pause the queue. Add content hash deduplication on ingest with 5-minute TTL in Redis to prevent duplicate voice captures from iOS Shortcut retries.

**Tasks:**
1. [ ] Implement spend-aware rate limiter that queries ai_audit_log monthly totals
2. [ ] Add BullMQ `worker.rateLimit()` calls based on spend thresholds
3. [ ] Add Redis-based content hash dedup on ingest queue (5-min TTL)
4. [ ] Configure thresholds via environment variables (BUDGET_SOFT_LIMIT, BUDGET_HARD_LIMIT)

**Acceptance Criteria:**
- [ ] Embed queue throttles when non-Claude monthly spend exceeds $7
- [ ] Embed queue pauses at $10 hard limit
- [ ] Duplicate captures (same content hash within 5 min) are silently dropped
- [ ] Rate limiter exempts Claude calls (subscription, $0 cost)

---

#### 3.2 Activity feed table and API
<!-- Status values: PENDING, IN_PROGRESS, COMPLETE [YYYY-MM-DD] -->
**Status: PENDING**
**Requirement Refs:** PRD-V2 F7.5, F7.6
**Files Affected:**
- `packages/shared/drizzle/0013_activity_feed.sql` (create)
- `packages/shared/src/schema/supporting.ts` (modify — add activity_feed)
- `packages/core-api/src/routes/activity.ts` (create)
- `packages/core-api/src/services/activity-feed.ts` (create)
- `packages/core-api/src/index.ts` (modify)

**Description:**
Create an `activity_feed` table with application-level inserts from all event sources. Add API endpoints: `GET /api/v1/activity/feed` (paginated, filterable by type/view/since) and `GET /api/v1/activity/feed/stream` (SSE for new items). Insert activity entries from: capture creation, skill completions, pipeline events, entity changes. Wiki and voice entries will be added in later phases.

**Tasks:**
1. [ ] Write migration 0013: activity_feed table (id UUID, type, subtype, timestamp, summary, view, detail JSONB, source_id UUID)
2. [ ] Add Drizzle schema definition
3. [ ] Create ActivityFeedService with insert helpers per event type
4. [ ] Wire inserts into: CaptureService.create(), skill completion handler, pipeline completion
5. [ ] Create activity.ts route module with feed endpoint + SSE stream
6. [ ] Add pg-notify trigger for new activity_feed inserts → SSE

**Acceptance Criteria:**
- [ ] New captures automatically appear in activity feed
- [ ] Skill completions appear in activity feed
- [ ] SSE stream pushes new items in real-time
- [ ] Filter by type, brain_view, and since parameters work correctly

---

#### 3.3 MCP activity logging
<!-- Status values: PENDING, IN_PROGRESS, COMPLETE [YYYY-MM-DD] -->
**Status: PENDING**
**Requirement Refs:** PRD-V2 F10.1-F10.3
**Files Affected:**
- `packages/shared/drizzle/0014_mcp_activity.sql` (create)
- `packages/shared/src/schema/supporting.ts` (modify — add mcp_activity)
- `packages/core-api/src/mcp/middleware/activity-logger.ts` (create)
- `packages/core-api/src/routes/mcp-activity.ts` (create)

**Description:**
Log all MCP tool calls to an `mcp_activity` table: timestamp, client_id, tool_name, parameters, result_summary (truncated), duration_ms. Add logging middleware to the MCP handler. Add API endpoint for dashboard: `GET /api/v1/mcp/activity` (paginated, filterable by tool name and client). Also insert MCP calls into the activity_feed table.

**Tasks:**
1. [ ] Write migration 0014: mcp_activity table
2. [ ] Add Drizzle schema
3. [ ] Create MCP activity logging middleware (wraps tool execution)
4. [ ] Create mcp-activity.ts route module
5. [ ] Wire MCP activity events into activity_feed inserts

**Acceptance Criteria:**
- [ ] All MCP tool calls are logged with parameters and duration
- [ ] MCP activity API returns paginated results
- [ ] MCP calls appear in the unified activity feed

---

#### 3.4 Dashboard unified activity feed page
<!-- Status values: PENDING, IN_PROGRESS, COMPLETE [YYYY-MM-DD] -->
**Status: PENDING**
**Requirement Refs:** PRD-V2 F7.1-F7.4
**Files Affected:**
- `packages/web/src/pages/Dashboard.tsx` (modify — rework as activity feed)
- `packages/web/src/components/ActivityFeedItem.tsx` (create)
- `packages/web/src/lib/api.ts` (modify — add activityApi)

**Description:**
Rework the dashboard Home page from current stats+timeline into a unified activity feed. Shows all system activity (captures, skill runs, MCP calls, pipeline events) in a single reverse-chronological view. Filter bar for type, brain view, date range. "Since you've been away" mode highlights items since last visit (localStorage timestamp). Real-time updates via SSE.

**Tasks:**
1. [ ] Create ActivityFeedItem component with type icon, title, summary, timestamp
2. [ ] Rework Dashboard.tsx to render activity feed (preserve stats cards at top)
3. [ ] Add filter bar with type, brain view, date range selectors
4. [ ] Implement "since you've been away" count badge using localStorage
5. [ ] Wire SSE for real-time feed updates (use existing sseClient)

**Acceptance Criteria:**
- [ ] Activity feed shows all event types in unified view
- [ ] Filters work correctly and persist in URL query params
- [ ] New items appear in real-time without page refresh
- [ ] "Since you've been away" badge shows correct count

---

#### 3.5 Dashboard enhanced System page
<!-- Status values: PENDING, IN_PROGRESS, COMPLETE [YYYY-MM-DD] -->
**Status: PENDING**
**Requirement Refs:** PRD-V2 F11.1-F11.7
**Files Affected:**
- `packages/web/src/pages/System.tsx` (create)
- `packages/web/src/components/QueueCard.tsx` (create)
- `packages/web/src/components/FlowTree.tsx` (create)
- `packages/web/src/lib/api.ts` (modify — add systemApi)
- `packages/web/src/components/Layout.tsx` (modify — add System nav)
- `packages/web/src/App.tsx` (modify — add /system route)

**Description:**
New System page with sub-tabs: Queues (card per queue with counts, pause/resume buttons), Skills (list with cron, last run, run-now button), MCP Activity (log view from 3.3). Flows view (flow tree DAG visualization) and Infrastructure view deferred to later phases when more data is available. Replaces the current BullBoard integration.

**Tasks:**
1. [ ] Create System page with tab navigation (Queues, Skills, MCP Activity)
2. [ ] Create QueueCard component showing waiting/active/completed/failed counts
3. [ ] Implement queue pause/resume via admin API
4. [ ] Reuse existing skill management from Settings page (cron editor, run-now)
5. [ ] Integrate MCP activity log view
6. [ ] Add /system route and System nav item

**Acceptance Criteria:**
- [ ] Queues tab shows all queues with real-time counts
- [ ] Skills tab shows all scheduled skills with last run and next fire time
- [ ] MCP Activity tab shows tool call log
- [ ] Pause/resume queue buttons work
- [ ] Run-now skill button triggers immediate execution

---

### Phase 3 Testing Requirements

- [ ] Rate limiting activates at correct thresholds
- [ ] Dedup prevents duplicate captures within TTL
- [ ] Activity feed populates from all event sources
- [ ] SSE streams deliver real-time updates
- [ ] MCP calls logged correctly
- [ ] System page shows accurate queue stats

### Phase 3 Completion Checklist

- [ ] All work items complete
- [ ] Activity feed is the new dashboard home experience
- [ ] System page operational with queues, skills, MCP views
- [ ] Pipeline hardened with rate limiting and dedup
- [ ] Deployed to homeserver

---

## Phase 4: Intelligence & Settings

**Estimated Complexity:** M (~15 files, ~1,000 LOC)
**Dependencies:** Phase 1 (model router), Phase 2 (wiki layer for wiki-lint and wiki-synthesis)
**Parallelizable:** Yes — skills (4.1-4.3) are independent of settings (4.4-4.5)

### Goals

- Deliver new intelligence skills: wiki-lint, wiki-synthesis, enhanced drift detection, daily connections, monthly reflection
- Expand dashboard Settings with AI routing, wiki, and integrations sections

### Work Items

#### 4.1 Wiki-lint and wiki-synthesis skills
<!-- Status values: PENDING, IN_PROGRESS, COMPLETE [YYYY-MM-DD] -->
**Status: PENDING**
**Requirement Refs:** PRD-V2 F5.1, F5.2
**Files Affected:**
- `packages/workers/src/skills/wiki-lint.ts` (create)
- `packages/workers/src/skills/wiki-synthesis.ts` (create)
- `packages/workers/src/scheduler.ts` (modify — register new skills)
- `packages/workers/src/jobs/skill-execution.ts` (modify — add cases)
- `config/prompts/wiki-lint/` (create)

**Description:**
Wiki-lint (weekly, Sundays 5 AM): Uses runAgent() to scan all wiki pages for contradictions, orphan pages, stale claims, missing cross-references. Writes `wiki/maintenance/lint-report.md`. Sends Pushover summary. Wiki-synthesis (daily, 6 AM): Identifies captures from last 24 hours not yet integrated into wiki, queues wiki-ingest jobs for each.

**Tasks:**
1. [ ] Create wiki-lint skill with runAgent() and wiki tools
2. [ ] Create wiki-synthesis skill that queries un-ingested captures and queues wiki-ingest jobs
3. [ ] Register both in scheduler.ts with cron schedules
4. [ ] Add cases in skill-execution.ts dispatcher
5. [ ] Write prompt templates for lint analysis

**Acceptance Criteria:**
- [ ] Wiki-lint produces a lint report in the wiki
- [ ] Wiki-synthesis queues wiki-ingest for un-integrated captures
- [ ] Both skills log to skills_log table
- [ ] Pushover notifications sent on completion

---

#### 4.2 Enhanced drift detection and daily connections skills
<!-- Status values: PENDING, IN_PROGRESS, COMPLETE [YYYY-MM-DD] -->
**Status: PENDING**
**Requirement Refs:** PRD-V2 F5.3, F5.4
**Files Affected:**
- `packages/workers/src/skills/drift-monitor.ts` (modify — enhance)
- `packages/workers/src/skills/daily-connections.ts` (modify — enhance and re-enable)
- `packages/workers/src/scheduler.ts` (modify — re-enable daily-connections)

**Description:**
Enhance drift-monitor to file results as wiki pages (in addition to Pushover). Re-enable daily-connections (currently disabled, cron set to Feb 29 only) with wiki integration — interesting cross-domain connections become wiki synthesis pages instead of just captures. Both skills use runAgent() for LLM analysis.

**Tasks:**
1. [ ] Enhance drift-monitor to write results to `wiki/operations/drift-reports/`
2. [ ] Re-enable daily-connections: change cron from `0 0 29 2 *` back to `0 7 * * *` (daily 7 AM)
3. [ ] Update daily-connections to create wiki synthesis pages for interesting connections
4. [ ] Migrate both skills to use runAgent() pattern
5. [ ] Update scheduler.ts JSDoc

**Acceptance Criteria:**
- [ ] Drift reports appear in wiki operations directory
- [ ] Daily connections produces wiki synthesis pages
- [ ] Both skills use runAgent() with proper tool definitions
- [ ] Pushover notifications include key findings

---

#### 4.3 Monthly reflection skill
<!-- Status values: PENDING, IN_PROGRESS, COMPLETE [YYYY-MM-DD] -->
**Status: PENDING**
**Requirement Refs:** PRD-V2 F5.5
**Files Affected:**
- `packages/workers/src/skills/monthly-reflection.ts` (create)
- `packages/workers/src/scheduler.ts` (modify)
- `packages/workers/src/jobs/skill-execution.ts` (modify)
- `config/prompts/monthly-reflection/` (create)

**Description:**
Monthly skill (1st of month, 9 AM) that generates a comprehensive "state of Troy" synthesis across all brain views: career momentum, active projects, technical exploration, personal patterns. Filed as a wiki synthesis page and sent as HTML email (via existing email service).

**Tasks:**
1. [ ] Create monthly-reflection skill using runAgent()
2. [ ] Query captures from last 30 days across all brain views
3. [ ] Generate structured reflection with wiki + email output
4. [ ] Register in scheduler with cron `0 9 1 * *`
5. [ ] Write prompt template for reflection analysis

**Acceptance Criteria:**
- [ ] Monthly reflection generates comprehensive synthesis
- [ ] Filed as wiki page under `wiki/synthesis/reflections/`
- [ ] Sent as HTML email
- [ ] Covers all five brain views

---

#### 4.4 Settings expansion — AI routing and wiki sections
<!-- Status values: PENDING, IN_PROGRESS, COMPLETE [YYYY-MM-DD] -->
**Status: PENDING**
**Requirement Refs:** PRD-V2 F12.1, F12.3
**Files Affected:**
- `packages/web/src/pages/Settings.tsx` (modify — add sections)
- `packages/web/src/lib/api.ts` (modify — add config endpoints)
- `packages/core-api/src/routes/settings.ts` (modify — add config read endpoints)

**Description:**
Add two new sections to the Settings page. AI Routing: displays current model routing table (task type → provider → model → client), monthly spend by model with progress bar, rate limit status. Wiki: Gitea repo URL (read-only), lint schedule (cron editor), auto-ingest toggle.

**Tasks:**
1. [ ] Create AI Routing settings section with model routing table
2. [ ] Add spend breakdown display (by model, with progress bars against budget)
3. [ ] Create Wiki settings section with lint schedule editor
4. [ ] Add backend endpoints for reading AI routing config and wiki settings
5. [ ] Add auto-ingest toggle that writes back to wiki config

**Acceptance Criteria:**
- [ ] AI routing table shows all task types with their routing
- [ ] Spend breakdown is accurate against ai_audit_log data
- [ ] Wiki lint schedule editable via cron editor
- [ ] Auto-ingest toggle persists correctly

---

#### 4.5 Settings expansion — Integrations section
<!-- Status values: PENDING, IN_PROGRESS, COMPLETE [YYYY-MM-DD] -->
**Status: PENDING**
**Requirement Refs:** PRD-V2 F12.4
**Files Affected:**
- `packages/web/src/pages/Settings.tsx` (modify — add integrations section)

**Description:**
Add an Integrations section to Settings showing read-only status for all connected services: MCP endpoint URL and status, Slack workspace info, Cloudflare tunnel status, Gitea connectivity, email channel status (CF worker for inbound, Himalaya for outbound when available). No configuration — secrets stay in Bitwarden.

**Tasks:**
1. [ ] Create Integrations section with status cards per service
2. [ ] Fetch status from /api/v1/system/health and /api/v1/settings
3. [ ] Show connectivity indicators (green/red dot + last check time)
4. [ ] Display key metadata per service (MCP endpoint URL, Slack workspace name, etc.)

**Acceptance Criteria:**
- [ ] All integration statuses display correctly
- [ ] Read-only — no editable fields
- [ ] Status indicators reflect real connectivity

---

### Phase 4 Testing Requirements

- [ ] All new skills execute correctly on schedule
- [ ] Wiki pages created by skills render in wiki browser
- [ ] Settings sections display correct data
- [ ] Config edits persist across page reloads

### Phase 4 Completion Checklist

- [ ] All work items complete
- [ ] 5 new/enhanced skills registered and running
- [ ] Settings page expanded with 3 new sections
- [ ] Deployed to homeserver

---

## Phase 5: Outbound Email & Infrastructure Skills

**Estimated Complexity:** M (~18 files, ~900 LOC)
**Dependencies:** Phase 1 (model router for email composition)
**Parallelizable:** Yes — email (5.1-5.3) and infra skills (5.4-5.5) are independent

### Goals

- Add outbound email composition and sending via Himalaya CLI
- Deliver Slack commands and MCP tools for email management
- Build infrastructure skills for automated backups, cost analysis, and health monitoring
- Add email view to dashboard

### Work Items

#### 5.1 Himalaya integration and email drafts table
<!-- Status values: PENDING, IN_PROGRESS, COMPLETE [YYYY-MM-DD] -->
**Status: PENDING**
**Requirement Refs:** PRD-V2 F13.1, F13.6
**Files Affected:**
- `Dockerfile` (modify — install himalaya binary)
- `packages/shared/drizzle/0015_email_drafts.sql` (create)
- `packages/shared/src/schema/supporting.ts` (modify)
- `packages/shared/src/services/himalaya.ts` (create)

**Description:**
Install the himalaya CLI binary in the workers Docker image (x86_64 Linux, static binary). Create the `email_drafts` table for storing draft emails. Create a Himalaya wrapper service that handles SMTP sending via `himalaya template send` (pipes email content via stdin). SMTP credentials from Bitwarden, injected at container start.

**Tasks:**
1. [ ] Add himalaya binary download to workers stage in Dockerfile
2. [ ] Create himalaya TOML config template (SMTP only, no IMAP)
3. [ ] Write migration 0015: email_drafts table
4. [ ] Add Drizzle schema for email_drafts
5. [ ] Create HimalayaService: send(to, subject, body), checkConnection()
6. [ ] Write unit tests with mocked himalaya execution

**Acceptance Criteria:**
- [ ] Himalaya binary available in workers container
- [ ] Email drafts table created with correct schema
- [ ] HimalayaService can send emails via SMTP
- [ ] Connection check verifies SMTP accessibility

---

#### 5.2 Outbound email composition and sending flow
<!-- Status values: PENDING, IN_PROGRESS, COMPLETE [YYYY-MM-DD] -->
**Status: PENDING**
**Requirement Refs:** PRD-V2 F13.6, F13.7
**Files Affected:**
- `packages/workers/src/skills/email-compose.ts` (create)
- `packages/core-api/src/routes/email.ts` (create)
- `packages/core-api/src/services/email-draft.ts` (create)

**Description:**
Implement email composition via runAgent() with email-specific tools: draft_email(to, subject, body), search_brain(query) for context, get_entity(name) for contact details. Draft stored in email_drafts table with status=draft. Two send modes: auto-send (immediately sent via Himalaya) and review-required (Pushover notification → user approves → then sent). Sent emails logged as captures with capture_type='email-outbound'.

**Tasks:**
1. [ ] Create EmailDraftService: create, list, get, approve, reject, send
2. [ ] Create email.ts route module with draft CRUD endpoints
3. [ ] Implement approve → send flow (updates status, calls HimalayaService, creates outbound capture)
4. [ ] Create email-compose skill for runAgent() with email tools
5. [ ] Add Pushover notification for review-required drafts

**Acceptance Criteria:**
- [ ] Email drafts can be created via API or LLM composition
- [ ] Review-required drafts send Pushover notification
- [ ] Approve triggers Himalaya send and creates outbound capture
- [ ] Reject discards the draft

---

#### 5.3 Email Slack commands, MCP tools, and dashboard view
<!-- Status values: PENDING, IN_PROGRESS, COMPLETE [YYYY-MM-DD] -->
**Status: PENDING**
**Requirement Refs:** PRD-V2 F13.8, F13.11, F15
**Files Affected:**
- `packages/slack-bot/src/handlers/email.ts` (create)
- `packages/core-api/src/mcp/tools/email-tools.ts` (create)
- `packages/web/src/pages/Email.tsx` (create)
- `packages/web/src/lib/api.ts` (modify)
- `packages/web/src/App.tsx` (modify)

**Description:**
Add Slack commands: /email send <to> <subject> (brain drafts email), /email drafts (list pending), /email approve <id>, /email reject <id>. Add MCP tools: draft_email, send_email, search_email_captures. Add dashboard Email page with inbound tab (email-type captures from CF worker) and drafts/outbox tab.

**Tasks:**
1. [ ] Create Slack email command handler with subcommands
2. [ ] Create email MCP tools (3 tools)
3. [ ] Create Email dashboard page with inbound + drafts tabs
4. [ ] Add /email route and nav item
5. [ ] Wire email events into activity_feed

**Acceptance Criteria:**
- [ ] Slack /email commands work end-to-end
- [ ] MCP email tools accessible from Claude Code
- [ ] Dashboard shows inbound emails and draft management
- [ ] Email events appear in activity feed

---

#### 5.4 Infrastructure skills — automated backups
<!-- Status values: PENDING, IN_PROGRESS, COMPLETE [YYYY-MM-DD] -->
**Status: PENDING**
**Requirement Refs:** PRD-V2 F14.1-F14.3
**Files Affected:**
- `packages/workers/src/skills/db-backup.ts` (create)
- `packages/workers/src/skills/wiki-backup.ts` (create)
- `packages/shared/drizzle/0016_backup_log.sql` (create)
- `packages/workers/src/scheduler.ts` (modify)

**Description:**
Create BullMQ-managed backup skills that run on the infrastructure queue. DB backup (daily 2 AM): wraps the existing backup.sh script logic, logs results to backup_log table, sends Pushover notification. Wiki backup (daily 2:15 AM): git bundle of wiki repo. Redis snapshot (daily 2:30 AM): trigger BGSAVE. All respect 7 daily / 4 weekly / 3 monthly retention policy.

**Tasks:**
1. [ ] Write migration 0016: backup_log table
2. [ ] Create db-backup skill (wraps pg_dump via Docker exec)
3. [ ] Create wiki-backup skill (git bundle to backup directory)
4. [ ] Register backup skills in scheduler
5. [ ] Log all backup results to backup_log table
6. [ ] Send Pushover notifications (success with size, alert on failure)

**Acceptance Criteria:**
- [ ] Database backup runs daily and produces valid dump
- [ ] Wiki backup creates git bundle
- [ ] All backups logged to backup_log table
- [ ] Retention policy enforced (old backups pruned)
- [ ] Pushover notifications on success and failure

**Notes:**
This replaces the standalone backup.sh crontab with a BullMQ-managed skill. The existing backup.sh stays as a manual fallback but the cron entry can be removed once the skill is validated.

---

#### 5.5 Infrastructure skills — monitoring and housekeeping
<!-- Status values: PENDING, IN_PROGRESS, COMPLETE [YYYY-MM-DD] -->
**Status: PENDING**
**Requirement Refs:** PRD-V2 F14.4-F14.9
**Files Affected:**
- `packages/workers/src/skills/cost-analysis.ts` (create)
- `packages/workers/src/skills/container-health.ts` (create)
- `packages/workers/src/skills/storage-audit.ts` (create)
- `packages/shared/drizzle/0017_container_health.sql` (create)

**Description:**
LLM cost analysis (daily 7 AM): query ai_audit_log, aggregate by model and task type, report to wiki and Pushover. Container health check (every 15 min): hit /health on each container, log to container_health table, alert after 3 consecutive failures. Storage audit (weekly Sundays 3 AM): report database size, Redis memory, backup storage, wiki repo size. Dedup sweep (weekly Saturdays 4 AM): scan for near-duplicate captures (cosine >0.95) not caught by real-time dedup.

**Tasks:**
1. [ ] Write migration 0017: container_health table
2. [ ] Create cost-analysis skill with daily/weekly/monthly report generation
3. [ ] Create container-health skill that checks all container /health endpoints
4. [ ] Create storage-audit skill
5. [ ] Enhance existing pipeline-health with dedup sweep capability
6. [ ] Register all in scheduler, add Infrastructure badge in System page

**Acceptance Criteria:**
- [ ] Cost reports generated accurately with breakdown by model
- [ ] Container health check detects failures within 3 cycles
- [ ] Storage audit reports correct sizes
- [ ] All infra skills visible in System → Skills with "infrastructure" badge

---

### Phase 5 Testing Requirements

- [ ] Email draft → approve → send lifecycle works end-to-end
- [ ] Slack /email commands work
- [ ] Backup skills produce valid dumps with correct retention
- [ ] Container health detects intentionally stopped container
- [ ] Cost analysis matches ai_audit_log aggregation

### Phase 5 Completion Checklist

- [ ] All work items complete
- [ ] Email composition and sending operational
- [ ] Infrastructure skills running on schedule
- [ ] Dashboard email view accessible
- [ ] Deployed to homeserver

---

## Phase 6: Voice Conversations

**Estimated Complexity:** L (~15 files, ~1,200 LOC)
**Dependencies:** Phase 1 (model router for conversation LLM)
**Parallelizable:** Partially — Phase 0 spike must complete before 6.2-6.5

### Goals

- Validate Deepgram real-time STT latency (Phase 0 spike)
- Build Pipecat voice service with Deepgram STT + Kokoro TTS + Claude conversation
- Implement session management with capture extraction
- Deliver voice conversations dashboard view
- Update iOS Shortcut for WebSocket connection

### Work Items

#### 6.1 Phase 0 spike: Deepgram latency validation
<!-- Status values: PENDING, IN_PROGRESS, COMPLETE [YYYY-MM-DD] -->
**Status: PENDING**
**Requirement Refs:** PRD-V2 Risk Register (Pipecat latency)
**Files Affected:**
- `scripts/deepgram-spike.py` (create — throwaway test script)

**Description:**
Before committing to the full Pipecat implementation, validate Deepgram cloud STT latency with realistic audio. Test: send 5-10 second audio clips via Deepgram's streaming API, measure time-to-first-word and total transcription latency. Target: <500ms time-to-first-word for real-time conversation feasibility. Also test Kokoro TTS latency locally.

**Tasks:**
1. [ ] Create Python test script using Deepgram SDK
2. [ ] Test with 5 representative audio clips (different lengths, noise levels)
3. [ ] Measure and record: time-to-first-word, total transcription time, accuracy
4. [ ] Test Kokoro TTS synthesis latency for 1-3 sentence responses
5. [ ] Document results and go/no-go decision
6. [ ] Store DEEPGRAM_API_KEY in Bitwarden

**Acceptance Criteria:**
- [ ] Deepgram time-to-first-word consistently <500ms
- [ ] Total round-trip (STT + LLM + TTS) estimated <2s
- [ ] Go/no-go decision documented before proceeding to 6.2

**Notes:**
If Deepgram latency exceeds targets, consider: Deepgram's Nova-2 model (optimized for speed), reducing audio chunk size, or accepting higher latency with a "thinking" indicator. This spike is a hard gate — do not proceed to 6.2 without a positive result.

---

#### 6.2 Pipecat voice service foundation
<!-- Status values: PENDING, IN_PROGRESS, COMPLETE [YYYY-MM-DD] -->
**Status: PENDING**
**Requirement Refs:** PRD-V2 F1.1-F1.2, F1.8, F1.9
**Files Affected:**
- `packages/voice-pipecat/` (create — new Python package)
- `packages/voice-pipecat/Dockerfile` (create)
- `packages/voice-pipecat/requirements.txt` (create)
- `packages/voice-pipecat/src/pipeline.py` (create)
- `packages/voice-pipecat/src/health.py` (create)
- `docker-compose.yml` (modify — add voice-pipecat service, remove voice-capture + faster-whisper)

**Description:**
Create a new Python-based Pipecat voice service. Pipeline: VAD (Silero) → STT (Deepgram cloud) → LLM (Claude SDK via conversation task type) → TTS (Kokoro local or ElevenLabs cloud). Session state stored in Redis with configurable TTL. Health endpoint at /health reporting model status, active sessions, TTS availability. Interrupt handling: user speech cancels current TTS.

**Tasks:**
1. [ ] Create packages/voice-pipecat/ with Python project structure
2. [ ] Write Dockerfile (Python 3.11 + Pipecat + Deepgram SDK + Kokoro)
3. [ ] Implement Pipecat pipeline definition (VAD → STT → LLM → TTS)
4. [ ] Implement Redis session state management
5. [ ] Implement health endpoint (FastAPI or similar)
6. [ ] Add to docker-compose.yml (replace voice-capture + faster-whisper entries)
7. [ ] Configure voice.yaml with Deepgram as primary STT

**Acceptance Criteria:**
- [ ] Pipecat service starts and reports healthy
- [ ] WebSocket endpoint accepts audio streams
- [ ] STT transcription works via Deepgram
- [ ] LLM responds via Claude SDK
- [ ] TTS generates audio response
- [ ] Session state persisted in Redis

**Notes:**
This is a Python service in a TypeScript monorepo. It communicates with the rest of the system via HTTP (core-api endpoints) and Redis (session state). No shared TypeScript code — clean service boundary. The existing voice-capture and faster-whisper containers are NOT removed until this service is validated.

---

#### 6.3 Session management and capture extraction
<!-- Status values: PENDING, IN_PROGRESS, COMPLETE [YYYY-MM-DD] -->
**Status: PENDING**
**Requirement Refs:** PRD-V2 F1.5, F1.6, F1.7
**Files Affected:**
- `packages/voice-pipecat/src/session.py` (create)
- `packages/voice-pipecat/src/capture_extractor.py` (create)
- `packages/voice-pipecat/src/tools.py` (create)

**Description:**
Implement session lifecycle: start (create Redis session), during (accumulate transcript turns), end (extract captures, store transcript). At conversation end (silence timeout or user says "done"), use Claude to extract one or more captures from the conversation, each POSTed to core-api for standard pipeline processing. LLM has access to Open Brain search and entity lookup as tools during conversation.

**Tasks:**
1. [ ] Implement session start/end lifecycle with Redis state
2. [ ] Create transcript accumulator (JSONB array of turns with timestamps)
3. [ ] Implement capture extraction at session end via Claude
4. [ ] Create Open Brain tools for in-conversation use (search_brain, get_entity)
5. [ ] POST extracted captures to core-api

**Acceptance Criteria:**
- [ ] Conversations produce captures routed through standard pipeline
- [ ] Full transcript stored as JSONB
- [ ] In-conversation search ("what did I say about X?") works
- [ ] Session cleanup on timeout

---

#### 6.4 Voice sessions table and API
<!-- Status values: PENDING, IN_PROGRESS, COMPLETE [YYYY-MM-DD] -->
**Status: PENDING**
**Requirement Refs:** PRD-V2 F1.6, F9
**Files Affected:**
- `packages/shared/drizzle/0018_voice_sessions.sql` (create)
- `packages/shared/src/schema/supporting.ts` (modify)
- `packages/core-api/src/routes/voice-sessions.ts` (create)
- `packages/core-api/src/services/voice-session.ts` (create)

**Description:**
Create voice_sessions table (UUID PK, session_key, started_at, ended_at, duration_seconds, turn_count, transcript JSONB, summary, captures_created UUID[], metadata JSONB). Add API endpoints: list sessions, get session with transcript, get active sessions. Pipecat service writes session data via core-api POST endpoint.

**Tasks:**
1. [ ] Write migration 0018: voice_sessions table with UUID PK
2. [ ] Add Drizzle schema
3. [ ] Create VoiceSessionService with CRUD operations
4. [ ] Create voice-sessions.ts route module
5. [ ] Add POST endpoint for Pipecat to write completed sessions
6. [ ] Wire voice session events into activity_feed

**Acceptance Criteria:**
- [ ] Voice sessions stored with full transcript
- [ ] API returns session list and individual transcripts
- [ ] Active session status available via API
- [ ] Voice sessions appear in activity feed

---

#### 6.5 Dashboard voice conversations view and iOS Shortcut
<!-- Status values: PENDING, IN_PROGRESS, COMPLETE [YYYY-MM-DD] -->
**Status: PENDING**
**Requirement Refs:** PRD-V2 F9.1-F9.5, F1.3
**Files Affected:**
- `packages/web/src/pages/VoiceConversations.tsx` (create)
- `packages/web/src/components/TranscriptViewer.tsx` (create)
- `packages/web/src/lib/api.ts` (modify)
- `packages/web/src/App.tsx` (modify)

**Description:**
Voice conversations dashboard page: list view (date, duration, turn count, captures, summary) and detail view (chat-style transcript with user/assistant turns). Active session indicator with real-time updates. Linked captures sidebar. Update existing iOS Shortcut to connect to Pipecat WebSocket endpoint with fallback to one-shot transcription if Pipecat is unavailable.

**Tasks:**
1. [ ] Create VoiceConversations page with list and detail views
2. [ ] Create TranscriptViewer component (chat-style layout)
3. [ ] Add active session indicator with SSE updates
4. [ ] Add linked captures sidebar in detail view
5. [ ] Update iOS Shortcut for WebSocket connection to Pipecat
6. [ ] Add fallback logic in Shortcut (try WebSocket, fall back to HTTP POST)

**Acceptance Criteria:**
- [ ] Voice conversation list shows all past sessions
- [ ] Transcript renders in chat-style layout
- [ ] Active session shows pulsing indicator with live turn count
- [ ] iOS Shortcut connects to Pipecat for voice conversations
- [ ] Fallback to one-shot transcription works when Pipecat is down

---

### Phase 6 Testing Requirements

- [ ] Phase 0 spike validates <2s round-trip latency
- [ ] Pipecat service starts and processes voice conversations
- [ ] Captures extracted from conversations flow through standard pipeline
- [ ] Dashboard shows conversation history and transcripts
- [ ] iOS Shortcut works with both Pipecat (WebSocket) and fallback (HTTP)

### Phase 6 Completion Checklist

- [ ] All work items complete (contingent on Phase 0 spike pass)
- [ ] Voice conversations operational end-to-end
- [ ] Old voice-capture + faster-whisper containers decommissioned
- [ ] Container count: 8 (down from 9)
- [ ] Deployed to homeserver

<!-- END PHASES -->

---

<!-- BEGIN TABLES -->

## Parallel Work Opportunities

| Work Item | Can Run With | Notes |
|-----------|--------------|-------|
| 1.1-1.3 (Model router) | 1.4 (Pipeline flows) | Independent code paths — shared package vs workers |
| 1.5 (Health API) | 1.6 (Health strip) | API first, then UI — but can stub API |
| 2.1-2.3 (Wiki backend) | 2.4 (Wiki browser) | Backend first, but UI work can start with mock data |
| 3.1 (Rate limiting) | 3.2-3.3 (Activity + MCP) | Independent subsystems |
| 3.4 (Activity feed UI) | 3.5 (System page) | Independent dashboard pages |
| 4.1-4.3 (Skills) | 4.4-4.5 (Settings) | Skills are workers, settings are web |
| 5.1-5.3 (Email) | 5.4-5.5 (Infra skills) | Independent feature sets |
| Phase 4 | Phase 5 | Minimal dependency overlap — can interleave |

---

## Risk Mitigation

| Risk | Likelihood | Impact | Mitigation Strategy |
|------|------------|--------|---------------------|
| FlowProducer migration breaks pipeline | Medium | High | Feature flag for gradual rollout. Run old + new in parallel during validation. Rollback: revert to sequential queue bridging. |
| Claude SDK response format differs from OpenAI | Medium | Medium | Gateway translates between formats. Comprehensive test coverage for both paths. |
| Wiki-ingest Git lock contention | Medium | Medium | Concurrency=1 on wiki workers. Prepare content in memory, then single atomic commit. |
| Wiki quality degrades without prompt tuning | Medium | Medium | Conservative prompts initially. Manual review first 2 weeks. Wiki-lint catches issues. |
| Himalaya binary unavailable for Alpine | Low | Medium | Pre-built static binaries for x86_64 Linux. Fallback: keep nodemailer for sending. |
| Pipecat Python service in TS monorepo | Medium | Low | Clean service boundary via HTTP + Redis. Separate Dockerfile. No shared TS code. |
| Deepgram latency exceeds 2s budget | Low | High | Phase 0 spike validates before committing. Fallback: accept higher latency with "thinking" indicator. |
| Dashboard navigation overcrowded (15+ items) | Medium | Low | Use collapsible groups (Intelligence, System). Mobile: tab redesign. |
| Migration ordering conflicts | Low | Medium | Numbered migrations (0013-0018) with clear dependencies. Apply sequentially. |

---

## Success Metrics

- [ ] All 6 phases completed
- [ ] All acceptance criteria met
- [ ] Claude SDK calls route through subscription ($0 cost)
- [ ] Non-Claude monthly spend under $10 (embeddings + Deepgram)
- [ ] Wiki contains 50+ synthesized pages within 60 days
- [ ] Voice round-trip latency <2s (Deepgram + Claude + TTS)
- [ ] Dashboard activity feed loads in <3s
- [ ] System runs autonomously for 7+ days
- [ ] All existing 1,569 unit tests + 95 regression tests pass
- [ ] Container count: 8 (down from 9)

---

## Appendix: Requirement Traceability

| Requirement | Source | Phase | Work Item |
|-------------|--------|-------|-----------|
| Dual-client model routing | PRD-V2 F4 | 1 | 1.1, 1.2 |
| runAgent() tool_use loop | PRD-V2 F4.5 | 1 | 1.3 |
| Pipeline FlowProducer DAGs | PRD-V2 F3.1-F3.3 | 1 | 1.4 |
| System health API + SSE | PRD-V2 F6.6 | 1 | 1.5 |
| Dashboard health strip | PRD-V2 F6.1-F6.5 | 1 | 1.6 |
| Wiki Gitea integration | PRD-V2 F2.1-F2.5 | 2 | 2.1 |
| Wiki-ingest worker | PRD-V2 F2.6 | 2 | 2.2 |
| Wiki API + MCP tools | PRD-V2 F2.10-F2.12 | 2 | 2.3 |
| Wiki browser UI | PRD-V2 F8 | 2 | 2.4 |
| Dynamic rate limiting + dedup | PRD-V2 F3.8-F3.9 | 3 | 3.1 |
| Activity feed | PRD-V2 F7 | 3 | 3.2, 3.4 |
| MCP activity logging | PRD-V2 F10 | 3 | 3.3 |
| Enhanced System page | PRD-V2 F11 | 3 | 3.5 |
| Wiki-lint + wiki-synthesis | PRD-V2 F5.1-F5.2 | 4 | 4.1 |
| Drift detection + daily connections | PRD-V2 F5.3-F5.4 | 4 | 4.2 |
| Monthly reflection | PRD-V2 F5.5 | 4 | 4.3 |
| Settings — AI routing + wiki | PRD-V2 F12.1, F12.3 | 4 | 4.4 |
| Settings — integrations | PRD-V2 F12.4 | 4 | 4.5 |
| Himalaya outbound email | PRD-V2 F13.1, F13.6-F13.7 | 5 | 5.1, 5.2 |
| Email Slack + MCP + dashboard | PRD-V2 F13.8, F13.11, F15 | 5 | 5.3 |
| Infrastructure — backups | PRD-V2 F14.1-F14.3 | 5 | 5.4 |
| Infrastructure — monitoring | PRD-V2 F14.4-F14.9 | 5 | 5.5 |
| Deepgram STT validation | PRD-V2 Risk Register | 6 | 6.1 |
| Pipecat voice service | PRD-V2 F1.1-F1.2 | 6 | 6.2 |
| Voice session management | PRD-V2 F1.5-F1.7 | 6 | 6.3 |
| Voice sessions table + API | PRD-V2 F1.6, F9 | 6 | 6.4 |
| Voice dashboard + iOS | PRD-V2 F9, F1.3 | 6 | 6.5 |

<!-- END TABLES -->

---

*Implementation plan generated by Claude on 2026-04-11 01:30:00*
*Source: /create-plan command (via /ultra-plan analysis of docs/PRD-V2.md)*
