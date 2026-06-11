# Software Engineer Findings

**Reviewer:** Senior Software Engineer
**Date:** 2026-06-10
**Target:** /home/davistroy/dev/personal/open-brain (main @ ac42938)
**Confidence:** High

*(Supersedes the 2026-04-18 review at this path. Prior findings were remediated via PRs #180–#189; closures verified where touched — e.g., `BYPASS_CALLERS` is module-scope hoisted, `X-Open-Brain-Caller` discipline is consistent, validation hardening from A113/A114 is present in `lib/validation.ts`. None of the findings below duplicate the known-open baseline items A130/A128/A116/A117/A106/A120 or the init-schema.sql gap.)*

---

## Codebase Metrics

| Metric | Value |
|--------|-------|
| Total lines (TS/TSX/PY, incl. tests) | 175,022 |
| Non-test source lines | 108,072 |
| Source files | 527 .ts / 237 .tsx / 60 .py / 11 .js+.mjs |
| Primary languages | TypeScript (Node 22), Python (batch pipelines + sidecar) |
| Debt markers (TODO/FIXME/HACK, real) | 2 (`scripts/utility-pipeline.py:650`, `packages/core-api/src/routes/ingest.ts:117`) |
| Largest non-test files | `scripts/financial-pipeline.py` 3,442 · `scripts/insurance-policy-extract.py` 1,189 · `scripts/utility-pipeline.py` 1,017 · `workers/src/skills/monthly-reflection.ts` 988 · `shared/src/services/llm-gateway.ts` 908 |
| console.* in backend packages | 2 (one doc comment, one interactive MSAL device-code prompt) — clean |
| Static analysis tools | cloc/eslint/pylint/flake8/radon/lizard all unavailable on this host; analysis done by direct code reading + grep |

## Complexity and Coupling Analysis

**Hot zones:**

1. **`scripts/financial-pipeline.py` (3,442 lines, single file)** — the largest unit in the repo by 3x. Parses many brokerage CSV/PDF formats with regex (`XXX\d+` filename patterns, balance-preamble regexes at lines 2281, 2479, 2722). Format drift in any one institution silently breaks a parser buried mid-file. No module decomposition, tested only via fixtures. Primary technical-debt concentration point.
2. **`packages/workers/src/skills/` (38 skill files)** — well-factored via `BaseSkill` template method; the large skills (monthly-reflection 988, morning-brief 877) are mostly prompt assembly + formatting, low cyclomatic risk.
3. **`packages/shared/src/services/llm-gateway.ts` (908 lines)** — dense but disciplined: single `completeByTask()` entry, bounded fallback recursion (`MAX_FALLBACK_HOPS`), per-provider client resolution, fail-fast `maxRetries: 0` delegating retry to the tier chain. Heavy test coverage (`run-agent.test.ts` 875 lines). Acceptable as-is.
4. **Cross-package queue coupling** is by-name (Redis queue strings), per the documented P06 convention. `core-api/services/pipeline.ts` correctly mirrors `CapturePipelineJobData` locally with a comment explaining the circular-dep avoidance. Coupling is intentional and documented — but it is exactly where the SE-1/SE-2 bugs below hide, because the two packages disagree on status-string semantics with no compile-time check.

## Critical Path Walkthrough

### Path 1: Capture ingestion — `POST /api/v1/captures` → BullMQ pipeline

- **Entry point:** `packages/core-api/src/routes/captures.ts:19`
- **Layers traversed:** zod schema (`schemas/capture.ts`) → `CaptureService.create()` (`services/capture.ts:46`) → `PipelineService.enqueue()` (`services/pipeline.ts:50`) → workers `processIngestionJob()` (`jobs/ingestion-worker.ts:69`) → `buildIngestFlow()` FlowProducer DAG (`flows/ingest-pipeline.ts:44`) → `embed-capture` (`jobs/embed-capture.ts:43`) → `ingest-root` → link-entities/check-triggers.
- **Findings:**
  - **SE-1 (Critical):** Both stuck-capture sweepers filter on `pipeline_status IN ('received', 'processing')` — `jobs/daily-sweep.ts:39` and `skills/stale-captures.ts:165`. **`'received'` is not a valid `captures.pipeline_status`** (8 valid values per migration 0024 and `schemas/capture.ts:10`; `received` is a `pipeline_events.stage` value). Consequences: (a) captures stuck in **`'pending'`** — the exact state `capture.ts:111` promises the sweep will recover when the initial enqueue fails — are never re-enqueued; (b) captures stuck in **`'extracted'`** after embed-job retry exhaustion (the "NO embedding fallback — queue and retry" architecture, and the failure mode `flows/ingest-pipeline.ts:24-25` explicitly says "daily sweep re-enqueues") are never re-enqueued. The `'processing'` window the sweep does match is the briefest state in the flow (ingestion-worker marks `extracted` within the same job). Net: the designated recovery safety net recovers almost nothing; an OpenAI outage longer than the 2h retry window strands captures un-embedded permanently (FTS-only searchable, silent quality loss). `pipeline-health` alerts on BullMQ failed counts, so detection exists — but no automated recovery, and the manual recovery path is also broken (SE-2). Fix: filter `IN ('pending', 'processing', 'extracted')` in both files; add a code-level test pinning the filter to the canonical `PIPELINE_STATUSES` union.
  - **SE-2 (High):** `POST /api/v1/captures/:id/retry` (`routes/captures.ts:105-126`) is a **silent no-op for `pipeline_status='failed'` captures**: it enqueues with `forceRetry`, but `jobs/ingestion-worker.ts:100` treats `'failed'` as terminal and returns success. The route still responds 200 with `retried_at`. `'failed'` is set by `jobs/document-pipeline.ts:162`, so failed document captures cannot be retried through the endpoint that exists to retry them. Fix: allow `'failed'` through when the job carries a retry marker (e.g., pass `forceRetry` in job data), or reset status to `'pending'` in the route before enqueueing.
  - **SE-4 (Medium):** `IngestDedup.isDuplicate()` (`lib/ingest-dedup.ts:47-63`, called at `jobs/ingestion-worker.ts:115-124`) uses `SET NX EX 300` at **process time**, so a BullMQ retry of the *same capture* within the 5-min TTL sees its own key, is classified a duplicate, and returns success — converting a retryable failure (e.g., `flowProducer.add` Redis blip) into a false success that cancels the remaining patient-backoff attempts (30s and 2m retries both fall inside the TTL). Same for a user-initiated `/retry` within 5 min. The capture strands in `'processing'` until the 3 AM sweep (which does cover `'processing'`). Fix: include `captureId` in the dedup key, or perform the dedup check at enqueue time in core-api rather than at process time.
  - **SE-15 (Low):** Unique-violation detection in `CaptureService.create()` (`services/capture.ts:96-101`) classifies errors by substring-matching `'content_hash'`/`'23505'` against `err.message`. Fragile against driver message changes and matches any 23505 on the insert. Prefer inspecting the pg error `code` property on the cause chain.

### Path 2: Hybrid search — `GET|POST /api/v1/search` → SearchService → `hybrid_search()`

- **Entry point:** `packages/core-api/src/routes/search.ts:42` (GET), `:91` (POST)
- **Layers traversed:** zod query schema → `SearchService.search()`/`searchWithRelated()` (`services/search.ts:179,386`) → `EmbeddingService.embed()` → `SET hnsw.ef_search` → `hybrid_search()` SQL (migration 0027) → capture fetch → ACT-R decay in-memory → fire-and-forget `access-stats` enqueue.
- **Findings:**
  - **SE-3 (High):** **POST search pagination is broken for any `offset > 0`.** `SearchService.search()` returns at most `limit` results (`search.ts:303` — `results.slice(0, limit)`), then the route applies `results.slice(body.offset, body.offset + body.limit)` (`routes/search.ts:128`, also `:109` for the include_related branch). With `limit=10, offset=10` the service returns 10 rows and the slice returns 0 — page 2 onward is always empty, while `total` reports the page-1 count. Fix: fetch `offset + limit` from the service (or push offset into SQL) and slice afterward.
  - **SE-7 (Medium):** **Hebbian read-side boost is dead code.** `SearchOptions.recentCaptureIds` (`services/search.ts:17`) gates `lookupAssociationBoosts()` (`:128-177`, `:285-298`), but no caller — neither HTTP route, POST route, nor MCP `search_brain` — ever supplies it (repo-wide grep: zero call sites outside the service and its tests). The write side (access-stats jobs, `capture_associations` upserts, weekly pruning) runs on every search; the scoring benefit it exists to feed never activates. Either wire `recentCaptureIds` from the access-stats recency data or stop documenting Hebbian boost as part of live search scoring.
  - **SE-6 (Medium):** **Soft-deleted captures leak into related results.** `spreading_activation()` (`packages/shared/drizzle/0012_spreading_activation.sql`) never joins `captures` and has no `deleted_at` filter (confirmed: zero matches in 0011/0012; `hybrid_search` in 0027 does filter at lines 63/85), and the follow-up fetch in `findRelatedCaptures()` (`services/search.ts:350-354`) also lacks `deleted_at IS NULL`. Memory-consolidation soft-deletes merged originals but leaves their `entity_links` intact, so consolidated-away duplicates resurface as `related_results` — and MCP `search_brain` defaults `include_related: true`, feeding deleted content into agent context by default. Fix: add `JOIN captures c ON c.id = el.capture_id AND c.deleted_at IS NULL` in the SQL function (new migration) and/or filter in the TS fetch.
  - **SE-10 (Low):** `search_mode='vector'` is accepted (`routes/search.ts:20`) but behaves identically to `'hybrid'` — the service only special-cases `'fts'` (`services/search.ts:202-242`); vector mode still runs `hybrid_search()` with the default `fts_weight=0.5`. The enum implies behavior that doesn't exist.
  - **SE-9 (Low):** GET route defaults `temporal_weight: 0.1` (`routes/search.ts:17`) while CLAUDE.md/PRD document the default as 0.0 (cold-start safe). Doc/code drift — pick one.
  - **SE-11 (Low):** `brainViews`/`captureTypes` are interpolated into Postgres array literals via `` `{${arr.join(',')}}` `` (`services/search.ts:193-196`). Parameterized (no injection), but a value containing `,`, `}`, or `"` produces a malformed literal → pg parse error → 500. Validate against configured views or escape per array-literal rules.
  - Fire-and-forget `access-stats` enqueues at all 5 sites correctly `.catch()` to debug-level log — matches the documented P06 pattern. No issue.

### Path 3: Voice capture — iOS Shortcut → voice-capture → core-api

- **Entry point:** `packages/voice-capture/src/server.ts:53` (`POST /api/capture`)
- **Layers traversed:** multipart parse → format/location validation → `TranscriptionService.transcribe()` → `ClassificationService.classify()` → `IngestService.ingest()` (with retry) → `NotificationService` (non-fatal).
- **Findings:**
  - Error handling is exemplary: each stage has its own try/catch with a distinct error code (TRANSCRIPTION_ERROR 502, EMPTY_TRANSCRIPT 422, CLASSIFICATION_ERROR 502, INGEST_ERROR 502); location validation (lines 87-137) is thorough.
  - **SE-13 (Low):** `brain_view` from the form (`server.ts:75`) is not validated against configured views before the expensive stages run. An invalid view sails through transcription + LLM classification (paid work), then core-api rejects it and the client gets a misleading `502 INGEST_ERROR` for what is a 400-class input error. Validate up front.
  - **SE-14 (Low):** No durable spooling of the uploaded audio — on any stage failure the audio is gone; recovery depends entirely on the iOS client retrying. Acceptable for a synchronous single-user flow (the Shortcut surfaces the error), but worth a one-line note in the runbook that a failed voice capture is unrecoverable server-side.

### Path 4: Skill execution — scheduler → `BaseSkill.execute()` → `run()`

- **Entry point:** `packages/workers/src/scheduler.ts` (repeatable jobs) → `jobs/skill-execution.ts` → `skills/base-skill.ts:77`
- **Findings:**
  - Autonomy gate is correctly implemented as a template method; `fetchAutonomyLevel()` fails closed to `observe` with a 5-min cache. Skill-log and Pushover helpers never throw. Good.
  - **SE-16 (Low):** `fetchAutonomyLevel` falls back to `coreApiUrl = 'http://localhost:3000'` (`base-skill.ts:82`) when `OPEN_BRAIN_API_URL` is unset — wrong inside the workers container (core-api is `core-api:3000`). Failure mode is safe (everything gates to `observe`) but **silent**: all proactive skills would quietly stop acting after a compose env regression, with only INFO-level "gated" logs. Log at WARN when the fetch fails and the default kicks in, or fail loudly at startup if the env var is missing.
  - **SE-12 (Low):** Scheduler same-minute collisions violate the documented "no two repeatable jobs on same minute" rule: `0 3 * * *` daily-sweep collides with `0 3 * * 0` storage-audit on Sundays, and `0 5 * * *` email-classify collides with `0 5 * * 0` wiki-lint on Sundays (`scheduler.ts` JSDoc lines 21-42 + cron declarations). Also cosmetic JSDoc/code notation drift (`0 0,6,12,18` vs `'0 */6 * * *'`; `0,15,30,45` vs `'*/15 * * * *'`). Shift the Sunday-only jobs or the daily jobs by 5 minutes.

### Path 5: Embed stage + budget circuit breaker

- **Entry point:** `packages/workers/src/jobs/embed-capture.ts:43`
- **Findings:**
  - Embed correctly throws on all failures (per the "no fallback" decision), records `pipeline_events` on every outcome, and uses the atomic `update_capture_embedding()` SQL function. Idempotency guard at `:98-108` is right.
  - **SE-5 (Medium / requires investigation):** The budget hard-stop path `throw new DelayedError(...)` (`embed-capture.ts:66`) misuses the BullMQ 5.x API. `DelayedError` is a control-flow signal to be thrown **after** `job.moveToDelayed(timestamp, token)`; `processEmbedCaptureJob` receives only `job.data`, so it cannot call `moveToDelayed`. Thrown bare, the job is not actually delayed — it surfaces as a failed/stalled job (exact behavior is BullMQ-version dependent; verify against the pinned 5.x), consuming retry attempts. After 5 attempts during a sustained budget pause, the job dead-letters and the capture strands at `'extracted'` — unrecoverable per SE-1. `PAUSE_DELAY_MS` (`:41`) is dead code, confirming the 10-minute-delay intent was never wired. Fix: pass the `job` + token into the processor and use `moveToDelayed(Date.now() + PAUSE_DELAY_MS, token)` before throwing `DelayedError`, or use BullMQ's `rateLimit()`/pause APIs on the worker.

### Path 6 (spot check): MCP `search_brain`

- **Entry point:** `packages/core-api/src/mcp/tools/search-brain.ts:47`
- **Findings:**
  - Prompt-injection sanitization via `SafePromptBuilder.sanitizeInline` on capture content (`:33`) — good defense-in-depth at the agent boundary.
  - **SE-8 (Medium):** The tool schema advertises `tag_filter: z.array(z.string()).optional()` (`:17`) but the implementation **never reads it** — `threshold` and `source_filter` are applied post-search (`:74-81`); `tag_filter` is silently ignored. An agent filtering by tags receives unfiltered results with no error. Implement it (post-filter like `source_filter`) or remove it from the schema; a dead parameter in a tool contract actively misleads the calling LLM.
  - Note: `threshold`/`source_filter` post-filtering after `limit` means filtered queries return fewer than `limit` results rather than the next-best matches. Known trade-off, acceptable; document in the tool description if agents complain.

## Error Handling Audit

| Location | Pattern | Assessment |
|----------|---------|------------|
| `core-api/src/middleware/error-handler.ts` | AppError→typed JSON+warn, unknown→500+error log | Correct; no stack leakage to clients |
| `services/capture.ts:106-115` | Pipeline enqueue failure swallowed (warn) relying on daily sweep | **Recovery promise broken by SE-1** — the swallow is only safe once the sweep filter is fixed |
| `routes/search.ts` ×4 + `mcp/tools/search-brain.ts` | access-stats fire-and-forget, `.catch` → debug log | Deliberate, documented (P06), adequate visibility |
| `jobs/ingestion-worker.ts:164-176` | extract failure → event row + pipeline_error + rethrow | Correct, but retry is then neutered by SE-4 dedup |
| `jobs/embed-capture.ts:125-151` | embed failure → event row + rethrow, no fallback | Correct per architecture |
| `jobs/embed-capture.ts:66` | bare `throw new DelayedError` | **SE-5** — not a real delay |
| `skills/base-skill.ts` | logResult/sendNotification never throw | Correct for non-critical side channels |
| `lib/ingest-dedup.ts:64-71` | Redis failure → allow through | Correct fail-open for a fast-path optimization |
| Python scripts | 3× `except Exception: pass` (`email-pipeline.py:544`, `dedup-and-archive.py:82`, `cleanup-onedrive-junk.py:30`) | **SE-17 (Low)** — all in best-effort cleanup loops in batch/one-off scripts; tolerable but should at least log |
| `voice-capture/server.ts` | per-stage catch with typed codes | Exemplary |

## Technical Debt Register

| ID | Type | Description | File | Business Impact | Remediation Cost |
|----|------|-------------|------|----------------|-----------------|
| TD-1 | Design | 3,442-line monolithic financial parser; per-institution regexes break silently on format drift | `scripts/financial-pipeline.py` | Monthly financial briefings silently lose accounts | 1-2 days (split per-institution modules + parser-coverage check) |
| TD-2 | Design | Cross-package status-string contract (`pipeline_status`) has no shared compile-time enforcement at the sweep call sites — root cause of SE-1 | `workers/jobs/daily-sweep.ts`, `workers/skills/stale-captures.ts` | Invalid status strings compile fine | 2h (use `PIPELINE_STATUSES` const + test) |
| TD-3 | Documentation | CLAUDE.md says "SET LOCAL hnsw.ef_search per-query"; code uses session-scoped `SET` with a comment explaining why (`services/search.ts:221-225`). Also temporal_weight default drift (SE-9), and CLAUDE.md still references vitest 1.6 forks-pool behavior while packages are on vitest ^2.0.0 | CLAUDE.md vs code | Future maintainer "fixes" code to match stale docs | 15 min |
| TD-4 | Design | `PAUSE_DELAY_MS` dead constant; budget-pause intent unimplemented (SE-5) | `workers/jobs/embed-capture.ts:41` | Budget hard-stop burns retry attempts | covered by SE-5 fix |
| TD-5 | Performance | Utility pipeline CSV aggregation unimplemented (`TODO` at line 650) | `scripts/utility-pipeline.py:650` | Power-usage data never lands in `power_readings` | unknown — scope first |
| TD-6 | Design | `routes/ingest.ts:117` TODO — inline path placeholder for the real BullMQ ingest-process worker | `core-api/src/routes/ingest.ts` | Documented, low risk | tracked |

## Code Quality Assessment

| Dimension | Score (1–5) | Evidence |
|-----------|-------------|----------|
| Naming and readability | 5 | Consistent route/service/job/skill conventions; intent comments explain *why* (e.g., `pipeline.ts:5-8` circular-dep note, `search.ts:221-225` SET vs SET LOCAL) |
| Layering discipline | 5 | Routes → services → DB clean throughout; shared utilities genuinely shared; no cross-package imports between core-api and workers |
| Error handling | 3 | Patterns are excellent in-line, but the recovery *system* has three broken links (SE-1, SE-2, SE-4) that compound: no working path re-runs a stuck capture except the narrow `'processing'` case |
| Logging quality | 5 | pino structured logging everywhere; trace_id propagation across pipeline stages; 2 console.* repo-wide; fire-and-forget failures logged at appropriate levels |
| Documentation | 4 | Outstanding operational docs (CLAUDE.md, LAB_NOTEBOOK); minor doc/code drift (TD-3, SE-9, scheduler JSDoc) |
| Testability | 4 | DI everywhere, ~2,000 TS tests, coverage gate on workers; but the SE-1/SE-2/SE-3 class of bugs (cross-component contract errors) shows unit tests pass while integrated behavior is wrong — no test exercises sweep-against-real-statuses or paginated POST search |

## Security-Relevant Code Findings

(Code-level only; perimeter/threat model belongs to the Security Architect.)

| File | Line | Issue | Severity | Remediation |
|------|------|-------|----------|-------------|
| `core-api/src/middleware/mobile-auth.ts` | 28-75 | None — fail-closed on missing key, timing-safe compare with length pre-check, token-hash-only logging | — | Exemplary; use as the reference pattern |
| `core-api/src/services/search.ts` | 193-196, 225 | Array-literal interpolation (robustness, not injection — parameterized) and `sql.raw` of zod-clamped config int | Low | Covered by SE-11; no injection vector found |
| `core-api/src/mcp/tools/search-brain.ts` | 33 | `sanitizeInline` on returned content — prompt-injection mitigation present | — | Keep |
| `services/search.ts` + migration 0012 | — | Soft-deleted (consolidated/user-deleted) content resurfaces to MCP agents by default | Medium | SE-6 fix (deleted_at filter) — data-exposure correctness, not auth |

## Dependency Audit

Network-restricted host — best-effort from lockfile/package.json (no `npm outdated` run).

- Counts (deps/devDeps): shared 17/7, core-api 20/7, workers 11/9, slack-bot 4/6, voice-capture 4/6, web-next 8/18, mobile 21/7 — lean for the feature surface.
- Pins consistent with documented constraints: `@types/node ^22` everywhere (PR #182), Node 22 LTS engines, `bullmq ^5.0.0` aligned across core-api/workers, `drizzle-orm ^0.45.1`, `hono ^4.12.5`, `zod ^3.23`, `openai ^4.98`, `vitest ^2.x`.
- `openai ^4.98.0`: 4.x SDK line is superseded by 5.x; no urgency (4.x maintained), flag for the next dependency pass alongside A130 (ESLint 9, known-open, not re-reported).
- No abandoned packages spotted in direct dependencies.

## Findings Summary

| Severity | Count |
|----------|-------|
| Critical | 1 |
| High | 2 |
| Medium | 5 |
| Low | 9 |
| Requires investigation | 1 |
| **Total** | **18** |

**Critical:** SE-1 (sweep status filter wrong — recovery safety net inert).
**High:** SE-2 (retry endpoint no-op for failed captures), SE-3 (POST search pagination broken).
**Medium:** SE-4 (dedup suppresses same-capture retries), SE-5 (DelayedError misuse / dead budget-pause — also the requires-investigation item for exact BullMQ 5.x runtime behavior), SE-6 (soft-deleted captures leak via spreading activation), SE-7 (Hebbian boost dead code), SE-8 (MCP tag_filter advertised but ignored).
**Low:** SE-9 through SE-17 as detailed above.

**Recommended fix order:** SE-1 first (2-hour fix, restores the entire recovery architecture), then SE-2 + SE-4 together (they share the ingestion-worker retry semantics), then SE-6 (one migration), then SE-3, SE-5, SE-8.
