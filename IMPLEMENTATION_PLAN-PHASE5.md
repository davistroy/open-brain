# Implementation Plan — Phase 5: Proactive Intelligence + URL Capture

**Generated:** 2026-03-11 16:30:00
**Based On:** docs/PRD.md (v0.7), docs/TDD.md (v0.7)
**Total Phases:** 3 (Phase 17–19, continuing from IMPLEMENTATION_PLAN-PHASE2.md Phase 16)
**Estimated Total Effort:** ~1,800 LOC across ~25 files

---

## Executive Summary

This plan implements three features that were deferred from the original 16-phase build: daily connection/pattern detection (F21), drift monitoring (F22), and URL/bookmark capture (F24). These features extend the existing skills framework and capture pipeline — no new infrastructure or schema migrations are required.

F21 and F22 are intelligence skills that follow the proven WeeklyBriefSkill pattern: class-based skill with BullMQ execution, prompt template, LLM synthesis, Pushover delivery, and skills_log audit. F24 adds a new input channel (web URLs) using lightweight content extraction that feeds into the existing capture pipeline.

F27 (screenshot/image capture) is documented in the PRD and TDD but intentionally excluded from this plan — it requires vision model infrastructure not yet available on LiteLLM.

---

## Plan Overview

Phases are ordered by dependency and architectural similarity:

- **Phase 17** (F21) builds the daily connections skill — the most complex new skill, establishing patterns that Phase 18 reuses.
- **Phase 18** (F22) builds the drift monitor skill — architecturally similar to Phase 17 but with different data queries (bets, governance commitments, entity frequency).
- **Phase 19** (F24) is independent of Phases 17-18 and adds URL/bookmark capture across all entry points (Slack, web UI, API).

### Phase Summary Table

| Phase | Focus Area | Key Deliverables | Est. Complexity | Dependencies |
|-------|------------|------------------|-----------------|--------------|
| 17 | Daily Connections Skill (F21) | Skill class, prompt template, scheduling, Slack command, tests | M (~8 files, ~650 LOC) | None (builds on existing skills framework) |
| 18 | Drift Monitor Skill (F22) | Skill class, prompt template, scheduling, Slack command, tests | M (~8 files, ~600 LOC) | Phase 17 (shared patterns) |
| 19 | URL/Bookmark Capture (F24) | URL extractor service, API integration, Slack command, web UI, tests | M (~10 files, ~550 LOC) | None (builds on existing capture pipeline) |

<!-- BEGIN PHASES -->

---

## Phase 17: Daily Connections Skill (F21)

**Estimated Complexity:** M (~8 files, ~650 LOC)
**Dependencies:** None — builds on existing skills framework (WeeklyBriefSkill pattern)
**Parallelizable:** Yes — work items 17.1 and 17.3 can start concurrently

### Goals

- Implement a daily skill that surfaces non-obvious cross-domain connections across recent captures
- Deliver insights via Pushover and save as searchable capture
- Support manual trigger via Slack `!connections` command and API

### Work Items

#### 17.1 Prompt Template + Skill Class ✅ Completed 2026-03-11
**Status: COMPLETE [2026-03-11]**
**Requirement Refs:** PRD F21, TDD §12.2c
**Files Affected:**
- `config/prompts/daily_connections_v1.txt` (create)
- `packages/workers/src/skills/daily-connections.ts` (create)
- `packages/workers/src/skills/daily-connections-query.ts` (create)

**Description:**
Create the daily connections skill following the WeeklyBriefSkill pattern. The skill queries captures from the last N days, builds entity co-occurrence data, groups captures by embedding similarity, then uses LLM synthesis to identify cross-domain patterns.

The prompt template instructs the LLM to find non-obvious connections — not just topic summaries, but cross-domain insights (e.g., a pattern from `technical` that relates to `client` work). Output is structured JSON matching `DailyConnectionsOutput`.

The query module handles data assembly: capture retrieval by date range, entity co-occurrence matrix via `entity_links` joins, and context assembly within token budget (same truncation pattern as weekly-brief).

**Tasks:**
1. [ ] Create `daily_connections_v1.txt` prompt template with system/user sections, JSON output schema, and anti-fluff rules (mirror weekly_brief_v1.txt style)
2. [ ] Create `DailyConnectionsSkill` class with constructor accepting `db`, `litellmUrl`, `litellmApiKey`, `promptsDir`, `coreApiUrl`
3. [ ] Implement `execute(options)` method: query captures → build entity co-occurrence → assemble context → call LLM → parse output → deliver Pushover → save capture → log to skills_log
4. [ ] Create `daily-connections-query.ts` with `queryRecentCaptures(db, windowDays)` and `buildEntityCoOccurrence(db, captureIds)` functions
5. [ ] Implement token-budget-aware context assembly (reuse `assembleContext` pattern from weekly-brief)
6. [ ] Export top-level `executeDailyConnections(db, options)` function for worker dispatcher

**Acceptance Criteria:**
- [ ] Skill queries captures from configurable day window (default: 7)
- [ ] Entity co-occurrence data included in LLM context
- [ ] LLM output parsed into `DailyConnectionsOutput` (connections array with theme, captures, insight, confidence)
- [ ] Output saved as capture with `capture_type: 'reflection'`, `source: 'system'`, tags: `['connections', 'skill-output']`
- [ ] Pushover notification sent with top 3 connections summary
- [ ] Execution logged to `skills_log` with structured `result` JSONB
- [ ] Handles empty capture sets gracefully (no LLM call, logs "no captures in window")

**Notes:**
- Entity co-occurrence: query `entity_links` joined on `captures` to find entities that appear together across different captures. Group by entity pair, count co-occurrences, include top 10 pairs in context.
- Embedding similarity clustering is optional for v1 — entity co-occurrence provides sufficient signal. Can add clustering in a future iteration.
- Token budget default: 30K (lower than weekly-brief's 50K since connections analysis needs less raw content).

---

#### 17.2 Worker Integration + Scheduling ✅ Completed 2026-03-11
**Status: COMPLETE [2026-03-11]**
**Requirement Refs:** PRD F21, TDD §12.2c, §12.4
**Files Affected:**
- `packages/workers/src/jobs/skill-execution.ts` (modify)
- `packages/core-api/src/routes/skills.ts` (modify — KNOWN_SKILLS)
- `packages/workers/src/scheduler.ts` (modify)

**Description:**
Register the daily-connections skill in the worker dispatcher, add to KNOWN_SKILLS constant, and set up BullMQ repeatable job for daily 9 PM execution.

**Tasks:**
1. [ ] Add `'daily-connections'` case to the switch statement in `createSkillExecutionWorker` — call `executeDailyConnections(db, { windowDays, tokenBudget, modelAlias })` with type-coerced input
2. [ ] Add `'daily-connections'` entry to `KNOWN_SKILLS` in `packages/core-api/src/routes/skills.ts` with schedule `'0 21 * * *'` and description
3. [ ] Add repeatable job in `scheduler.ts`: `skillQueue.add('daily-connections', {}, { repeat: { pattern: '0 21 * * *' }, jobId: 'scheduled_daily-connections' })`

**Acceptance Criteria:**
- [ ] `POST /api/v1/skills/daily-connections/trigger` queues the skill and returns 202
- [ ] Skill appears in `GET /api/v1/skills` with schedule and last run info
- [ ] Scheduled execution runs at 9 PM daily (verified via BullMQ repeatable job registration)
- [ ] Unknown skill fallback still throws `UnrecoverableError`

**Notes:**
- The scheduler uses stable jobIds so startup calls are upserts (idempotent).

---

#### 17.3 Slack `!connections` Command ✅ Completed 2026-03-11
**Status: COMPLETE [2026-03-11]**
**Requirement Refs:** PRD F21
**Files Affected:**
- `packages/slack-bot/src/handlers/command.ts` (modify)
- `packages/slack-bot/src/intent/router.ts` (modify — add to known commands)
- `packages/slack-bot/src/lib/core-api-client.ts` (modify — add trigger method if missing)

**Description:**
Add `!connections` (and `!connections <days>`) to the Slack bot command handler. Triggers the daily-connections skill via the Core API and replies with a confirmation message.

**Tasks:**
1. [ ] Add `'connections'` to the `KNOWN_COMMANDS` set in `router.ts`
2. [ ] Add `connections` case in `handleCommand` — parse optional day count from args, call `POST /api/v1/skills/daily-connections/trigger` with `{ windowDays }` body
3. [ ] Reply in thread with "Running daily connections analysis (last N days)..." confirmation
4. [ ] Ensure `core-api-client.ts` has a generic `triggerSkill(name, input)` method (may already exist)

**Acceptance Criteria:**
- [ ] `!connections` triggers the skill with default 7-day window
- [ ] `!connections 14` triggers with 14-day window
- [ ] Bot replies with confirmation message in thread
- [ ] Invalid arguments (e.g., `!connections abc`) return helpful error

**Notes:**
- The skill runs asynchronously — the Slack response is just "queued", not the actual results. Results arrive via Pushover when the skill completes.

---

#### 17.4 Unit Tests ✅ Completed 2026-03-11
**Status: COMPLETE [2026-03-11]**
**Requirement Refs:** PRD F21
**Files Affected:**
- `packages/workers/src/__tests__/daily-connections.test.ts` (create)
- `packages/slack-bot/src/__tests__/connections-command.test.ts` (create)

**Description:**
Unit tests for the daily connections skill covering data queries, LLM output parsing, delivery, error handling, and the Slack command handler.

**Tasks:**
1. [ ] Test `queryRecentCaptures` — returns captures within window, excludes deleted, respects limit
2. [ ] Test `buildEntityCoOccurrence` — correctly counts entity pairs, returns top N
3. [ ] Test `DailyConnectionsSkill.execute()` — mock LLM, verify context assembly, output parsing, capture save, skills_log entry
4. [ ] Test empty capture set — skill skips LLM call, logs "no captures"
5. [ ] Test LLM parse failure — skill handles malformed JSON gracefully (logs warning, saves raw text)
6. [ ] Test `!connections` command handler — verify API call with correct args, reply formatting

**Acceptance Criteria:**
- [ ] >80% coverage on `daily-connections.ts` and `daily-connections-query.ts`
- [ ] Edge cases covered: empty window, single capture, LLM timeout, malformed output
- [ ] Slack command tests verify argument parsing and error responses
- [ ] All tests pass in CI (vitest)

---

### Phase 17 Testing Requirements

- [ ] `pnpm --filter @open-brain/workers test` passes with new daily-connections tests
- [ ] `pnpm --filter @open-brain/slack-bot test` passes with new connections-command tests
- [ ] Manual trigger via `POST /api/v1/skills/daily-connections/trigger` works on homeserver
- [ ] Pushover notification received with connections summary
- [ ] Saved capture visible in web UI timeline and searchable

### Phase 17 Completion Checklist

- [ ] All work items complete
- [ ] All tests passing
- [ ] Skill registered in KNOWN_SKILLS and worker dispatcher
- [ ] Scheduled job registered in scheduler.ts
- [ ] Slack command functional
- [ ] No regressions in existing tests

---

## Phase 18: Drift Monitor Skill (F22)

**Estimated Complexity:** M (~8 files, ~600 LOC)
**Dependencies:** Phase 17 (shared skill patterns established)
**Parallelizable:** Yes — work items 18.1 and 18.3 can start concurrently

### Goals

- Implement a daily skill that detects when tracked commitments, bets, or projects go silent
- Alert via Pushover only when drift items with severity >= medium exist
- Support manual trigger via Slack `!drift` command and API

### Work Items

#### 18.1 Prompt Template + Skill Class
**Status: PENDING**
**Requirement Refs:** PRD F22, TDD §12.2d
**Files Affected:**
- `config/prompts/drift_monitor_v1.txt` (create)
- `packages/workers/src/skills/drift-monitor.ts` (create)
- `packages/workers/src/skills/drift-monitor-query.ts` (create)

**Description:**
Create the drift monitor skill following the same pattern as daily-connections. The skill queries pending bets, recent governance session outputs, and entity mention frequency, then uses LLM synthesis to assess drift severity and suggest actions.

The key difference from daily-connections is the data sources: this skill reads from `bets` table (pending items), `sessions`/`session_messages` (governance commitments), and `entity_links` joined with `captures` (mention frequency over rolling windows).

**Tasks:**
1. [ ] Create `drift_monitor_v1.txt` prompt template — instruct LLM to assess each item's drift severity (high/medium/low), explain why it's drifting, and suggest a specific action
2. [ ] Create `DriftMonitorSkill` class with same constructor pattern as `DailyConnectionsSkill`
3. [ ] Implement `execute(options)` method: query bets → query governance commitments → query entity frequency → assemble context → call LLM → parse output → conditional Pushover → save capture → log
4. [ ] Create `drift-monitor-query.ts` with:
   - `queryPendingBets(db)` — all bets with resolution = 'pending'
   - `queryBetActivity(db, betId, days)` — captures related to a bet's statement/entities
   - `queryEntityFrequency(db, windowDays)` — mention counts current vs. previous period
   - `queryGovernanceCommitments(db, days)` — recent session outputs with commitments
5. [ ] Implement severity classification logic before LLM call (pre-filter obvious items)
6. [ ] Conditional Pushover delivery — only send if any items have severity >= medium

**Acceptance Criteria:**
- [ ] Skill queries pending bets and checks for related capture activity
- [ ] Entity mention frequency compared across rolling 7-day windows (current vs. previous)
- [ ] Governance commitments extracted from session outputs (last 30 days)
- [ ] LLM output parsed into `DriftMonitorOutput` (drift_items array with severity, suggested_action)
- [ ] Pushover notification sent ONLY when drift items with severity >= medium exist
- [ ] Output saved as capture with tags: `['drift', 'skill-output']`
- [ ] Handles no-drift gracefully (saves "all clear" capture, no Pushover)

**Notes:**
- Bet activity check: use `hybrid_search()` with the bet's statement as query, filtered to last N days. If zero results, the bet has gone silent.
- Governance commitments: parse session output text for action items (look for bullet points, "commit to", "will do", "action:" patterns). This is heuristic, not perfect — LLM synthesis compensates.
- Entity frequency: `SELECT entity_id, COUNT(*) FROM entity_links JOIN captures ON ... WHERE created_at > (now - 7 days) GROUP BY entity_id` vs. same query for previous 7 days. Flag >50% decline.

---

#### 18.2 Worker Integration + Scheduling
**Status: PENDING**
**Requirement Refs:** PRD F22, TDD §12.2d, §12.4
**Files Affected:**
- `packages/workers/src/jobs/skill-execution.ts` (modify)
- `packages/core-api/src/routes/skills.ts` (modify — KNOWN_SKILLS)
- `packages/workers/src/scheduler.ts` (modify)

**Description:**
Register the drift-monitor skill in the worker dispatcher, add to KNOWN_SKILLS, and set up BullMQ repeatable job for daily 8 AM execution.

**Tasks:**
1. [ ] Add `'drift-monitor'` case to the switch statement in `createSkillExecutionWorker`
2. [ ] Add `'drift-monitor'` entry to `KNOWN_SKILLS` with schedule `'0 8 * * *'` and description
3. [ ] Add repeatable job in `scheduler.ts`: `skillQueue.add('drift-monitor', {}, { repeat: { pattern: '0 8 * * *' }, jobId: 'scheduled_drift-monitor' })`

**Acceptance Criteria:**
- [ ] `POST /api/v1/skills/drift-monitor/trigger` queues the skill and returns 202
- [ ] Skill appears in `GET /api/v1/skills` with schedule and last run info
- [ ] Scheduled execution registered at 8 AM daily

---

#### 18.3 Slack `!drift` Command
**Status: PENDING**
**Requirement Refs:** PRD F22
**Files Affected:**
- `packages/slack-bot/src/handlers/command.ts` (modify)
- `packages/slack-bot/src/intent/router.ts` (modify — add to known commands)

**Description:**
Add `!drift` to the Slack bot command handler. Triggers the drift-monitor skill via the Core API.

**Tasks:**
1. [ ] Add `'drift'` to the `KNOWN_COMMANDS` set in `router.ts`
2. [ ] Add `drift` case in `handleCommand` — call `POST /api/v1/skills/drift-monitor/trigger`
3. [ ] Reply in thread with "Running drift analysis..." confirmation

**Acceptance Criteria:**
- [ ] `!drift` triggers the skill and bot confirms in thread
- [ ] Skill runs asynchronously, results delivered via Pushover

---

#### 18.4 Unit Tests
**Status: PENDING**
**Requirement Refs:** PRD F22
**Files Affected:**
- `packages/workers/src/__tests__/drift-monitor.test.ts` (create)
- `packages/slack-bot/src/__tests__/drift-command.test.ts` (create)

**Description:**
Unit tests for the drift monitor skill covering bet queries, entity frequency analysis, governance commitment extraction, severity classification, conditional delivery, and the Slack command handler.

**Tasks:**
1. [ ] Test `queryPendingBets` — returns only pending bets, excludes resolved
2. [ ] Test `queryBetActivity` — correctly identifies bets with/without recent captures
3. [ ] Test `queryEntityFrequency` — calculates week-over-week frequency change
4. [ ] Test `DriftMonitorSkill.execute()` — mock LLM, verify context assembly, severity filtering, conditional Pushover
5. [ ] Test no-drift scenario — no Pushover sent, "all clear" capture saved
6. [ ] Test `!drift` command handler

**Acceptance Criteria:**
- [ ] >80% coverage on `drift-monitor.ts` and `drift-monitor-query.ts`
- [ ] Edge cases: no pending bets, no governance sessions, all entities stable
- [ ] Conditional Pushover logic verified (severity threshold)
- [ ] All tests pass in CI

---

### Phase 18 Testing Requirements

- [ ] `pnpm --filter @open-brain/workers test` passes with new drift-monitor tests
- [ ] `pnpm --filter @open-brain/slack-bot test` passes with new drift-command tests
- [ ] Manual trigger via API works on homeserver
- [ ] Pushover notification received (if drift items exist)
- [ ] Saved capture visible in timeline

### Phase 18 Completion Checklist

- [ ] All work items complete
- [ ] All tests passing
- [ ] Skill registered in KNOWN_SKILLS and worker dispatcher
- [ ] Scheduled job registered in scheduler.ts
- [ ] Slack command functional
- [ ] No regressions in existing tests

---

## Phase 19: URL/Bookmark Capture (F24)

**Estimated Complexity:** M (~10 files, ~550 LOC)
**Dependencies:** None — builds on existing capture pipeline
**Parallelizable:** Yes — work items 19.1, 19.3, and 19.4 can start concurrently after 19.2

### Goals

- Enable capturing web page content by URL from Slack, web UI, and API
- Extract readable content using Mozilla Readability (no headless browser)
- Process through standard pipeline (embed, extract entities, check triggers)

### Work Items

#### 19.1 URL Extractor Service
**Status: PENDING**
**Requirement Refs:** PRD F24, TDD §12.2e
**Files Affected:**
- `packages/shared/src/services/url-extractor.ts` (create)
- `packages/shared/package.json` (modify — add dependencies)

**Description:**
Create a lightweight URL content extraction service using `@mozilla/readability` and `linkedom`. The service fetches a web page, parses it into a DOM, extracts readable content, and returns structured metadata.

**Tasks:**
1. [ ] Add `@mozilla/readability` and `linkedom` to `@open-brain/shared` dependencies
2. [ ] Create `UrlExtractorService` class with `extract(url: string): Promise<UrlExtractionResult>` method
3. [ ] Implement fetch with 10-second timeout, `User-Agent: OpenBrain/1.0` header, and redirect following
4. [ ] Parse HTML with `linkedom.parseHTML()`, extract with `new Readability(doc).parse()`
5. [ ] Implement fallback: if Readability returns null, strip HTML tags and use raw text
6. [ ] Truncate content to 50,000 characters
7. [ ] Return `{ title, content, excerpt, siteName, byline, url, fetchedAt }` — excerpt is first 200 chars of content
8. [ ] Handle error cases: network timeout, non-HTML content type, HTTP errors (4xx/5xx)

**Acceptance Criteria:**
- [ ] Extracts readable content from news articles, blog posts, and documentation pages
- [ ] Excludes navigation, footer, sidebar, and ad content (Readability's job)
- [ ] Fallback to stripped HTML when Readability fails (e.g., SPAs with minimal server HTML)
- [ ] Returns clear error for non-HTML responses (PDF, image URLs)
- [ ] Timeout at 10 seconds for slow/unresponsive servers
- [ ] Content truncated to 50K chars (prevents extremely long pages from bloating captures)

**Notes:**
- `linkedom` is a lightweight DOM implementation — no headless browser, no Puppeteer, no Playwright. Runs in Node.js without external dependencies.
- `@mozilla/readability` is the same library behind Firefox Reader View — well-tested on real-world web pages.
- Don't try to handle JavaScript-rendered SPAs — if Readability can't parse it, the fallback stripped HTML is sufficient. Users can always paste content manually.

---

#### 19.2 API Integration
**Status: PENDING**
**Requirement Refs:** PRD F24, TDD §12.2e
**Files Affected:**
- `packages/core-api/src/schemas/capture.ts` (modify — add 'bookmark' source)
- `packages/core-api/src/routes/captures.ts` (modify — URL extraction on bookmark source)
- `packages/shared/src/types/capture.ts` (modify — add 'bookmark' to CaptureSource)

**Description:**
Extend the capture creation flow to support `source: 'bookmark'`. When a capture is created with `source: 'bookmark'` and `source_metadata.url` is present, the API calls `UrlExtractorService.extract(url)` to populate the content before pipeline processing. If content is already provided (pre-extracted by the caller), skip extraction.

**Tasks:**
1. [ ] Add `'bookmark'` to the `CAPTURE_SOURCES` enum/validation in `capture.ts` schemas
2. [ ] Add `'bookmark'` to the `CaptureSource` type in shared types
3. [ ] In `POST /api/v1/captures` handler: if `source === 'bookmark'` and `source_metadata?.url` exists and `content` is empty/whitespace, call `UrlExtractorService.extract(url)` and populate `content` + `source_metadata` fields
4. [ ] Set default `tags: ['bookmark']` and add domain tag (extract hostname from URL, e.g., `nytimes.com`)
5. [ ] Handle extraction failure: return 422 with error message ("Could not extract content from URL")
6. [ ] Rebuild `@open-brain/shared` package after type changes

**Acceptance Criteria:**
- [ ] `POST /api/v1/captures { source: 'bookmark', source_metadata: { url: '...' } }` extracts and creates capture
- [ ] Pre-provided content is not overwritten by extraction
- [ ] `tags` includes `['bookmark', '<domain>']`
- [ ] Extraction failure returns 422 with descriptive error
- [ ] Created capture flows through normal pipeline (embed, entities, triggers)
- [ ] Duplicate URL detection via content_hash (same content = same hash = dedup)

**Notes:**
- The URL extraction happens synchronously in the API request — this is acceptable because the 10-second extraction timeout is within normal API response times, and URL captures are low-volume.
- Don't add URL extraction to the pipeline (async) — the user expects immediate confirmation that the URL was captured.

---

#### 19.3 Slack `!bookmark` Command
**Status: PENDING**
**Requirement Refs:** PRD F24
**Files Affected:**
- `packages/slack-bot/src/handlers/command.ts` (modify)
- `packages/slack-bot/src/intent/router.ts` (modify — add to known commands)
- `packages/slack-bot/src/lib/core-api-client.ts` (modify — if capture create doesn't support bookmark source)

**Description:**
Add `!bookmark <url>` command to the Slack bot. Parses the URL from the message, calls the Core API to create a bookmark capture, and replies with the page title and excerpt.

**Tasks:**
1. [ ] Add `'bookmark'` to the `KNOWN_COMMANDS` set in `router.ts`
2. [ ] Add `bookmark` case in `handleCommand`:
   - Parse URL from args (handle Slack's auto-linking: `<https://example.com|example.com>` → extract raw URL)
   - Optionally parse hashtags from args for additional tags
   - Call `POST /api/v1/captures` with `{ source: 'bookmark', capture_type: 'observation', brain_view: 'technical', source_metadata: { url }, tags }`
3. [ ] Reply in thread with: page title, excerpt (first 200 chars), and capture ID
4. [ ] Handle errors: no URL provided, extraction failure (422), network error

**Acceptance Criteria:**
- [ ] `!bookmark https://example.com` creates capture and replies with title + excerpt
- [ ] `!bookmark https://example.com #research #ai` adds custom tags
- [ ] Slack-formatted URLs (angle brackets, pipe) parsed correctly
- [ ] Missing URL returns helpful error: "Usage: `!bookmark <url>` — capture a web page"
- [ ] Extraction failure relayed to user: "Could not extract content from that URL"

**Notes:**
- Slack auto-links URLs in messages, wrapping them in `<url|display>` format. The handler must extract the raw URL from this format.
- Default `brain_view: 'technical'` — the pipeline's classify stage may reclassify based on content.

---

#### 19.4 Web UI URL Input
**Status: PENDING**
**Requirement Refs:** PRD F24
**Files Affected:**
- `packages/web/src/pages/Dashboard.tsx` (modify — add URL capture mode)
- `packages/web/src/lib/api.ts` (modify — if capture create doesn't support bookmark source)

**Description:**
Add a URL capture mode to the Dashboard's Quick Capture form. Users toggle between "Text" and "URL" mode. In URL mode, the input accepts a URL, and submission creates a bookmark capture via the API.

**Tasks:**
1. [ ] Add a toggle (tab or segmented control) to the Quick Capture form: "Text" | "URL"
2. [ ] In URL mode: change input placeholder to "Paste a URL to capture...", add URL validation
3. [ ] On submit in URL mode: call `capturesApi.create({ content: '', source: 'bookmark', capture_type: 'observation', brain_view: selectedBrainView, source_metadata: { url } })` — note content is empty, API will extract
4. [ ] Show loading state during extraction (may take up to 10 seconds)
5. [ ] On success: show title and excerpt in confirmation toast
6. [ ] On failure: show error message from API

**Acceptance Criteria:**
- [ ] Toggle between Text and URL capture modes works
- [ ] URL validation prevents submission of non-URL text
- [ ] Loading state shown during extraction
- [ ] Success shows page title in confirmation
- [ ] Error messages from API displayed clearly
- [ ] Brain view selector works in both modes

**Notes:**
- Keep the UI simple — this is a single input field with a mode toggle, not a full bookmark manager.
- The `capturesApi.create` call in `api.ts` may need the `source` and `source_metadata` fields added if not already supported.

---

#### 19.5 Tests
**Status: PENDING**
**Requirement Refs:** PRD F24
**Files Affected:**
- `packages/shared/src/__tests__/url-extractor.test.ts` (create)
- `packages/slack-bot/src/__tests__/bookmark-command.test.ts` (create)
- `scripts/regression-test.mjs` (modify — add bookmark capture test)

**Description:**
Unit tests for URL extraction and Slack command, plus regression test update for the live API.

**Tasks:**
1. [ ] Test `UrlExtractorService.extract()` — mock fetch, verify Readability output, fallback behavior, timeout handling, non-HTML rejection
2. [ ] Test Slack URL parsing — handle raw URLs, Slack-formatted `<url|display>`, missing URL, hashtag parsing
3. [ ] Test `!bookmark` command handler — verify API call, reply formatting, error handling
4. [ ] Add bookmark capture test to `regression-test.mjs`:
   - `POST /api/v1/captures` with `source: 'bookmark'` and a known URL
   - Verify capture created with extracted content
   - Verify capture has `bookmark` tag
   - Clean up test capture
5. [ ] Rebuild shared package before running dependent package tests

**Acceptance Criteria:**
- [ ] >80% coverage on `url-extractor.ts`
- [ ] Slack command tests cover URL parsing edge cases
- [ ] Regression test passes on homeserver
- [ ] All existing tests still pass (no regressions)

---

### Phase 19 Testing Requirements

- [ ] `pnpm --filter @open-brain/shared test` passes with new url-extractor tests
- [ ] `pnpm --filter @open-brain/slack-bot test` passes with new bookmark-command tests
- [ ] `pnpm test` passes (all packages, no regressions)
- [ ] Regression test on homeserver includes bookmark capture scenario
- [ ] Manual test: `!bookmark <url>` in Slack creates searchable capture
- [ ] Manual test: Dashboard URL capture mode works

### Phase 19 Completion Checklist

- [ ] All work items complete
- [ ] All tests passing
- [ ] `bookmark` source type accepted by API
- [ ] Slack command functional
- [ ] Web UI URL input functional
- [ ] Regression test updated and passing
- [ ] No regressions in existing tests

<!-- END PHASES -->

---

<!-- BEGIN TABLES -->

## Parallel Work Opportunities

| Work Item | Can Run With | Notes |
|-----------|--------------|-------|
| 17.1 | 17.3 | Skill class and Slack command are independent until integration |
| 18.1 | 18.3 | Same pattern as Phase 17 |
| 19.1 | 19.3, 19.4 | URL extractor, Slack command, and web UI can develop in parallel |
| Phase 17 | Phase 19 | F21 and F24 have no shared dependencies |
| Phase 18 | Phase 19 | F22 and F24 have no shared dependencies |

---

## Risk Mitigation

| Risk | Likelihood | Impact | Mitigation Strategy |
|------|------------|--------|---------------------|
| LLM output parsing failure (F21/F22) | Medium | Low | Fallback: save raw LLM text as capture content if JSON parsing fails. Log warning. |
| Readability fails on target URLs (F24) | Medium | Low | Fallback: strip HTML tags and use raw text. Clear error message to user. |
| Entity co-occurrence queries slow (F21) | Low | Medium | Limit to top 10 entity pairs. Add index on `entity_links(capture_id)` if needed. |
| Token budget exceeded (F21/F22) | Low | Low | Same truncation strategy as weekly-brief. Captures sorted by recency, truncated at budget. |
| Slack URL parsing edge cases (F24) | Medium | Low | Comprehensive test coverage for Slack URL formats. Regex handles `<url\|display>` pattern. |

---

## Success Metrics

- [ ] All 3 phases completed with tests passing
- [ ] Daily connections skill produces meaningful cross-domain insights (not just topic summaries)
- [ ] Drift monitor correctly identifies silent bets and declining entity activity
- [ ] URL capture works end-to-end from Slack, web UI, and API
- [ ] All skill outputs are searchable via semantic search
- [ ] No increase in pipeline failures or error rates
- [ ] Regression test suite updated and passing

---

## Appendix: Requirement Traceability

| Requirement | Source | Phase | Work Item |
|-------------|--------|-------|-----------|
| F21: Daily connection/pattern detection | PRD §5.2, TDD §12.2c | 17 | 17.1, 17.2, 17.3, 17.4 |
| F21: Daily schedule (9 PM) | PRD F21, TDD §12.4 | 17 | 17.2 |
| F21: Slack `!connections` command | PRD F21 | 17 | 17.3 |
| F22: Drift monitor skill | PRD §5.2, TDD §12.2d | 18 | 18.1, 18.2, 18.3, 18.4 |
| F22: Daily schedule (8 AM) | PRD F22, TDD §12.4 | 18 | 18.2 |
| F22: Conditional Pushover (severity >= medium) | PRD F22, TDD §12.2d | 18 | 18.1 |
| F22: Slack `!drift` command | PRD F22 | 18 | 18.3 |
| F24: URL/bookmark capture | PRD §5.2, TDD §12.2e | 19 | 19.1, 19.2, 19.3, 19.4, 19.5 |
| F24: Readability extraction | PRD F24, TDD §12.2e | 19 | 19.1 |
| F24: Slack `!bookmark` command | PRD F24 | 19 | 19.3 |
| F24: Web UI URL input | PRD F24 | 19 | 19.4 |
| F24: Regression test update | PRD F24 | 19 | 19.5 |

<!-- END TABLES -->

---

*Implementation plan generated by Claude on 2026-03-11 16:30:00*
*Source: /create-plan command*
