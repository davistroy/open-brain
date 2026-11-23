# Implementation Plan — Arch-Review v7 Remediation, Part 2 of 2 (Phases 9–16)

**Generated:** 2026-11-22 14:13:23
**Based On:** `arch-review/reports/remediation-analysis-2026-11-22.md` (the approved analysis), `arch-review/reports/executive-summary.md` (arch-review v7, including the Review Lead Live Verification table), `arch-review/plan-investigation/03-pipeline-queues-search.md`, `arch-review/plan-investigation/04-silent-inert-jobs.md`, `arch-review/plan-investigation/05-llm-gateway-integrations.md`, `arch-review/plan-investigation/06-alerting-monitoring-ci.md`. The `arch-review/` paths are local-only (gitignored).
**Total Phases:** 8 (Phases 9–16; Part 2 of 2)
**Estimated Total Effort:** ~9,100 LOC across ~160 files

---

## Executive Summary

Part 2 covers Phases 9–16. The phase numbers continue from Part 1 (Phases 1–8, a separate file: stabilize the live system, alert core, pipeline, source, and tier watchers, deploy foundation in two phases, backup and restore in two phases, stateful window), so a reference such as "Part 1 item 2.6" and a reference such as "item 9.3" cannot collide. Part 2 fixes the code paths that finish without doing their work: capture recovery, upload handling, search recall, memory consolidation, the LLM gateway, the public-path edges, and the dependency patch pipeline. Scope is functionality, performance, and stable operations.

The decisions are made and this plan encodes them. A failed embed is re-driven by removing only the retained `ingest-root_<id>` and `embed_<id>` jobs and adding an embed-only flow. Job retention lands after the re-drive and after the stuck-capture gauge from Part 1. Memory consolidation ships whole or not at all. The co-access boost is wired, not removed. `config/ai-routing.yaml` is the single source of the budget thresholds, paid tiers are identified by their cost fields, and the gateway work runs in the order classifier, budget guard, circuit breaker. Filtered search uses `hnsw.iterative_scan`, and migration `0038` changes only the full-text arm of `hybrid_search()`.

Findings that share a root cause are fixed by one mechanism. Retained BullMQ job IDs that act as a permanent dedup key are fixed by items 9.1, 9.2, and 9.3. SQL that is tested only through mocks is fixed by tests against a real database in items 11.3, 11.5, and 11.6. Fallback that is decided per call with no memory is fixed by items 12.1, 12.3, and 12.4. A budget limit decided by client name, with six copies of the thresholds, is fixed by item 12.2 and items 13.1 through 13.5. The plan has 40 work items: the 34 approved items, plus 6 items that hold the part of an approved item that exceeded the eight-file limit.

---

## Plan Overview

Phases 9, 10, 11, 15, and 16 and the chain 12 → 13 → 14 are independent of each other once Part 1 Phase 5 (deploy foundation) is done. Phase 15 touches GitHub only and can start at any time. The order of items is fixed by these chains: 9.1 and 9.2 → 9.3 (the re-drive and its two callers must exist before completed job IDs are pruned); 11.4 and 11.5 → 11.6 (readers and the real-database harness before the destructive skill); 12.1 → 12.2 → 12.3 (a circuit breaker without the budget guard sends all traffic to paid tiers with no ceiling); 12.2 → Phase 13 (the budget guard before the callers that use the guard); 12.3 → 14.2 (the breaker removes the 120-second wait, which is longer than the public path allows); 13.1 and 13.2 → 14.5 (every `runAgent` caller passes a resolver before the default model is removed); 15.1 and 15.2 → 15.4 (deterministic checks and a resolvable lockfile before unattended merges).

The analysis used its own phase numbers. Analysis Phase 6 is Phases 9, 10, and 16 here, analysis Phase 7 is Phase 11, analysis Phase 8 is Phases 12, 13, and 14, and analysis Phase 9 is Phase 15.

**Item numbers.** The 34 approved items keep their titles. Item numbers follow the eight phases of this file, so that no phase holds more than six items. Items 9.2, 13.2, 13.4, 13.5, 14.5, and 16.2 each hold the part of another item that did not fit in eight files: item 9.2 continues item 9.1, item 13.2 continues item 13.1, items 13.4 and 13.5 continue item 13.3, item 14.5 continues item 14.1, and item 16.2 continues item 10.6. Each of the six is a separate numbered item and not a letter suffix, because `/implement-plan` reads an item ID as the first `N.M` on a heading line: `13.1a` and `13.1b` would both be stored as `13.1`.

**Conventions used in every item.**
- File and line references are at commit `f341ca6`. Part 1 edits several of the same files, so locate a change by the quoted symbol, not by the line number.
- `Depends On` lists items in this file only. A prerequisite in Part 1 appears in the phase `Dependencies` field and in the item's Notes as "Cross-plan prerequisite".
- A task that starts with "Host (owner)", "GitHub (owner)", or "Owner" needs the owner. The implementer finishes the repository tasks and leaves those tasks unchecked.
- Every host deploy goes through `scripts/deploy.sh <sha>` (Part 1 item 5.2). The Cloudflare workers under `cloudflare/` are deployed by the owner with `wrangler deploy` and are outside the host deploy.
- Targeted test commands use `pnpm --filter <package> exec vitest run <file>`. The `test` scripts of `core-api` and `workers` run with `--coverage`, and a partial run fails the package thresholds.

**Part 1 items this plan references.**

| Part 1 reference | What the reference provides | Used by |
|---|---|---|
| Item 1.2 | Re-embed of the 359 stranded captures | 11.6 (watermark reset happens after) |
| Item 1.5 | Dated test fixtures made relative; first merge to `main` since July | 15.1, 15.5 |
| Phase 2 | Alert state in `app_settings` keys `alert_state:*`; the alert helper; the shared queue-name registry | 10.3, 13.1, 14.4, 14.5 |
| Phase 3 | The per-source heartbeat helper; the failure report of the Actual sidecar | 11.6, 14.3 |
| Item 2.6 | Stuck-capture gauge | 9.3 |
| Phase 5, item 5.2 | `scripts/deploy.sh <sha>` | every host deploy |
| Item 5.4 | pgvector image pin | 11.1 |
| Item 8.1 | Migration `0037` applied on the host | 11.2 |

**Time-boxed dates.**
- About 2026-12-23: GitHub is likely to disable the scheduled workflows, 60 days after the last repository activity. Any merge to `main` resets the clock. Relevant to Phase 15 (items 15.3 and 15.5).
- 2027-01-06: reported shutdown date of the `tts-1` model. Item 14.1 must be deployed before that date. If Phases 12 and 13 are still open in mid-December, run item 14.1 ahead of them.
- January 2027: Actual Budget server 27.x. Item 14.3 must be merged before the server is upgraded.

All three dates come from vendor pages that were not re-read for this plan. Each item that depends on one starts with a task to re-read the vendor page.

### Phase Summary Table

| Phase | Focus Area | Key Deliverables | Est. Complexity | Dependencies | Execution Mode |
|-------|------------|------------------|-----------------|--------------|----------------|
| 9 | Capture pipeline: recovery, retention, uploads, process safety | Embed re-drive with a real-Redis proof; sweep and retry route on the re-drive; age-based job retention; upload route that cannot exit the process; error listeners; pool timeouts | L (~35 files, ~1,510 LOC) | Part 1 Phase 2 (item 2.6), Part 1 Phase 3 (item 3.1), Part 1 Phase 5 | Sequential |
| 10 | Small paths that lose data or do nothing | Entity upsert; extractor caps; voice dead-letter directory; wiki lint on the right queue; email worker status rules; derived wipe list; gated-skill completion | M (~22 files, ~920 LOC) | Part 1 Phase 5 | Parallel |
| 11 | Search and memory | Iterative HNSW scan; migration `0038`; co-access boost read path; soft-delete filters; workers SQL in CI; atomic memory consolidation | L (~30 files, ~1,770 LOC) | Part 1 Phase 5; Part 1 item 8.1 before 11.2; Part 1 item 1.2 before 11.6 | Sequential |
| 12 | LLM gateway core | One error classifier; tier timeouts on Anthropic calls; budget guard by cost fields; per-tier circuit breaker; JSON instruction on fallback | M (~14 files, ~1,280 LOC) | Part 1 Phase 5 | Sequential |
| 13 | Budget follow-through | Guarded and recorded agent loops; embed job and TTS route on the guard; one threshold source for the budget job, the health page, the schema, the alert rule, and the documents | M (~30 files, ~1,320 LOC) | Phase 12 (item 12.2) | Sequential |
| 14 | Edges: model IDs, public timeouts, Actual pin, external watchdog | TTS model from config; proxy timeout and async voice upload; exact Actual SDK pin; heartbeat route and off-host monitor with backoff; model-presence check | M (~38 files, ~1,520 LOC) | Phase 12 (14.2 after 12.3); Phase 13 (14.5 after 13.1 and 13.2); Part 1 Phase 2 (14.4 reads open alerts) | Sequential |
| 15 | Patch pipeline and CI | Deterministic required checks; resolvable root lockfile; weekly image rebuild; patch auto-merge; audit that fails closed; scheduled CI; pins file | M (~17 files, ~620 LOC) | None (GitHub-side; may start at any time) | Sequential |
| 16 | Mechanical hardening: fetch timeouts and silent catches | A timeout on seven outbound `fetch` calls; a log line at each listed silent catch | S (~14 files, ~150 LOC) | Part 1 Phase 5 | Parallel |

### Execution Hints

| Phase | Model Tier | Context Budget | Notes |
|-------|------------|----------------|-------|
| All (default) | `sonnet` | Standard | Per-item `Model Tier` fields take priority. |
| Phase 9 | `sonnet` | Extended | Item 9.1 is `opus`: BullMQ parent and child job semantics decide correctness, and the proof is a real-Redis test. Run in document order; `core-api/src/index.ts` is edited by 9.3, 9.5, and 9.6. |
| Phase 10 | `sonnet` | Standard | Parallel: no two items share a file. Item 10.1 writes the phase's `LAB_NOTEBOOK.md` entry; no Phase 10 commit lands before that entry. |
| Phase 11 | `sonnet` | Extended | Item 11.6 is `opus`: the skill is destructive and ships whole or not at all. Run in document order. |
| Phase 12 | `sonnet` | Extended | Item 12.2 is `opus`. All four items edit `llm-gateway.ts`: run in document order, one item per batch. |
| Phase 13 | `sonnet` | Extended | `workers/src/main.ts`, `core-api/src/index.ts`, and `skill-execution.ts` are each edited by several items: run in document order, one item per batch. The `LAB_NOTEBOOK.md` entry opened in item 12.1 covers this phase. |
| Phase 14 | `sonnet` | Standard | Items 14.1 and 14.3 carry calendar dates and can run ahead of Phases 12 and 13. Item 14.5 waits for items 13.1 and 13.2. |
| Phase 15 | `sonnet` | Minimal | Workflow YAML and manifests. Items 15.4 and 15.5 include GitHub settings the owner sets. |
| Phase 16 | `haiku` | Minimal | Parallel: the two items share no file. Item 16.1 writes the phase's `LAB_NOTEBOOK.md` entry; no Phase 16 commit lands before that entry. |

### Milestones

| Milestone | Phases | Description |
|-----------|--------|-------------|
| Captures recover and are found | 9–11 | A failed embed is retried by the sweep; job history is pruned by age; uploads reach a sidecar; filtered and keyword search return full results; consolidation merges atomically. |
| LLM cost and tier behaviour are bounded | 12–14 | Paid calls stop at the hard limit and free calls never do; a dead tier is skipped; model IDs come from config; the public path and the off-host monitor behave on slow and failing calls. |
| Patches flow without the owner | 15 | Dependabot resolves the root lockfile, patch updates merge on green checks, images rebuild weekly, and the audit fails when a check cannot run. |
| Part 2 complete | 9–16 | All 40 work items done, including the two mechanical items of Phase 16; with Part 1, the remediation analysis is fully implemented. |

<!-- BEGIN PHASES -->

---

## Phase 9: Capture pipeline: recovery, retention, uploads, process safety

**Estimated Complexity:** L (~35 files, ~1,510 LOC)
**Dependencies:** Part 1 Phase 2 (item 2.6), Part 1 Phase 3 (item 3.1), Part 1 Phase 5
**Execution Mode:** Sequential

### Goals

- A capture whose embed failed is embedded by the next sweep or retry, and enrichment runs once per capture.
- Redis job history is pruned by age without removing the guard against duplicate enrichment.
- A failed upload write returns a 5xx instead of ending the core-api process, and an upload lands in the directory a sidecar reads.
- Worker, queue, and pool errors reach the structured log, and a hung core-api statement is cancelled.

### Work Items

#### 9.1 Sweep and retry that re-run the embed
**Status: PENDING**
**Model Tier: opus**
**Requirement Refs:** SE7-01, PE-012 (investigation 03, item CAP-1)
**Files Affected:**
- `LAB_NOTEBOOK.md` (modify)
- `packages/workers/src/flows/redrive.ts` (create)
- `packages/workers/src/flows/ingest-pipeline.ts` (modify)
- `packages/workers/src/jobs/ingestion-worker.ts` (modify)
- `packages/workers/src/queues/capture-pipeline.ts` (modify)
- `packages/workers/src/jobs/embed-capture.ts` (modify)
- `packages/workers/src/__tests__/integration/flow-redrive.test.ts` (create)
- `packages/workers/src/__tests__/ingest-pipeline.test.ts` (modify)

**Description:**
`buildIngestFlow` gives every flow job a fixed ID (`ingest-root_<id>`, `embed_<id>`), and BullMQ returns early when a job with that ID
already exists, so a failed embed job blocks every later re-add. This item adds `flows/redrive.ts`, which removes the retained
`ingest-root_<id>` job (with `removeChildren: false`) and the `embed_<id>` job and adds an embed-only flow. `processIngestionJob` calls
the re-drive for any capture that arrives at `extracted` or already has a root or embed job. Enrichment re-runs only when the job
carries `stage: 'all'`. Item 9.2 connects the nightly sweep and the retry route to this re-drive.

**Tasks:**
1. [ ] Add a `LAB_NOTEBOOK.md` entry for Phase 9 before the first commit. Objective: failed embeds recover, job history is pruned, uploads cannot end the process, errors are logged. Hypothesis: the real-Redis test shows the embed processor called twice and each enrichment processor called once. Rollback: `git revert` the phase commits and redeploy the previous commit with `scripts/deploy.sh <previous sha>`.
2. [ ] Create `packages/workers/src/flows/redrive.ts` exporting `getFlowState(connection, captureId)`, which returns `'none' | 'in-flight' | 'finished'`, and `redriveCapture({ connection, flowProducer }, captureId, opts)` with `opts = { stage: 'embed' | 'all'; includeWikiIngest: boolean; traceId?: string }`. Both functions look up `ingest-root_<id>` in queue `ingest-root` and `embed_<id>` in queue `embed-capture` with `Queue.getJob` and `job.getState()`.
3. [ ] A flow is in flight when the root job or the embed job is `waiting`, `active`, `delayed`, `prioritized`, or `waiting-children`. In `redriveCapture`, check again: when the flow is in flight, add nothing, log `[redrive] in flight`, and return `{ action: 'skipped', reason: 'in-flight' }`.
4. [ ] When the root job or the embed job is `failed` or `completed`, remove the root job with `job.remove({ removeChildren: false })` and remove `embed_<id>` by ID from `embed-capture`. For `stage: 'embed'`, leave `extract-entities_<id>`, `extract-commitments_<id>`, and `wiki-ingest_<id>` untouched, then add `buildIngestFlow(captureId, { embedOnly: true, traceId })`.
5. [ ] For `stage: 'all'`, look up each enrichment child by its fixed ID in its own queue (`extract-entities`, `extract-commitments`, `wiki-ingest`). Skip the re-drive when any child is in flight. Remove each finished child by ID, then add the full flow. Never use `removeChildren` to remove the enrichment children.
6. [ ] In `flows/ingest-pipeline.ts`, add `embedOnly?: boolean` to the options of `buildIngestFlow`. With `embedOnly: true` the function returns the root job and the `embed` child only. Update the JSDoc block that describes the DAG.
7. [ ] In `queues/capture-pipeline.ts`, add `stage?: 'all'` to `CapturePipelineJobData`.
8. [ ] In `jobs/ingestion-worker.ts`, give `processIngestionJob` an optional fifth parameter `redrive` (`{ getFlowState, redriveCapture }`). `createIngestionWorker` always passes the real implementation built from its `connection`. Call `getFlowState` before any status update. State `in-flight`: log and return without changing the capture. State `none`, a status other than `extracted`, and no `stage: 'all'`: call `flowProducer.add(buildIngestFlow(...))` as today. Every other case: once the status reaches `extracted`, call `redriveCapture` in place of the flow add.
9. [ ] In `jobs/ingestion-worker.ts`, skip the `ingestDedup.isDuplicate` check when `data.forceRetry` is true. The dedup key is `<hash>:<captureId>` with a 5-minute TTL, so today a second job for the same capture inside 5 minutes is dropped as a duplicate.
10. [ ] In `jobs/embed-capture.ts`, set `pipeline_error: null` in the `UPDATE` that sets `pipeline_status = 'complete'`. Add no code path that sets `pipeline_status = 'failed'` when the embed job exhausts its attempts.
11. [ ] Create `__tests__/integration/flow-redrive.test.ts` on the helpers in `__tests__/integration/setup.ts`. Register counting stub processors on `embed-capture`, `extract-entities`, `extract-commitments`, `wiki-ingest`, and `ingest-root`. Cases: (a) the embed processor always fails, then `redriveCapture` runs with a working embed processor: embed calls = 2, each enrichment processor calls = 1, root calls = 1; (b) `redriveCapture` while the embed job is `delayed` adds no job; (c) a failed enrichment child plus an embed-only re-drive: the new root job reaches `completed`; (d) `stage: 'all'`: each enrichment processor calls = 2.
12. [ ] Update `__tests__/ingest-pipeline.test.ts` for the `embedOnly` flow shape and the `forceRetry` dedup bypass. `src/flows/ingest-pipeline.ts` has a per-file 100% coverage lock; cover both branches.

**Acceptance Criteria:**
- [ ] WHEN the embed job of a capture has failed all attempts and a later `capture-pipeline` job runs for the same capture THEN `processIngestionJob` SHALL remove `ingest-root_<id>` and `embed_<id>`, add an embed-only flow, and the embed processor SHALL run again.
- [ ] WHEN a re-drive runs without `stage: 'all'` THEN the `extract-entities`, `extract-commitments`, and `wiki-ingest` processors SHALL NOT run again for that capture.
- [ ] WHEN the root job or the embed job is in flight THEN `redriveCapture` SHALL add no job and SHALL return `action: 'skipped'`.
- [ ] WHEN a capture has a failed enrichment child and an embed-only re-drive runs THEN the new `ingest-root_<id>` job SHALL reach `completed`.
- [ ] WHEN the job carries `stage: 'all'` THEN `redriveCapture` SHALL remove each finished enrichment child by ID and each enrichment processor SHALL run exactly once more.
- [ ] WHEN the embed succeeds THEN `captures.pipeline_error` SHALL be NULL.
- [ ] `docker compose -f docker-compose.test.yml up -d --wait && pnpm --filter @open-brain/workers exec vitest run --config vitest.config.integration.ts src/__tests__/integration/flow-redrive.test.ts` exits 0.
- [ ] `pnpm --filter @open-brain/workers exec vitest run src/__tests__/ingest-pipeline.test.ts` exits 0.

**Notes:**
Three approaches from the review reports are rejected as unsafe. Suffixing child job IDs with an attempt number duplicates commitments (`extract-commitments.ts` inserts rows with no dedup) and runs a paid `wiki_ingest` call (tier `t1_fast`) on every sweep. Removing the whole flow tree misses a failed enrichment child: a child marked `removeDependencyOnFailure` is recorded nowhere on the parent, `removeChildren` does not find the child, and on re-add the child re-attaches to the new root job, which then waits forever. Marking the capture `failed` when the embed gives up strands the capture: `failed` is not in `SWEEPABLE_STATUSES` and the embed worker skips `failed`. Enrichment re-runs only through the retry route with `?stage=all` (item 9.2). The dedup key rule in task 9 also drops a BullMQ retry of the ingestion job inside 5 minutes; the sweep picks those captures up the next night, and a wider change to `lib/ingest-dedup.ts` is outside this item. Host fact: the `triggers` table has 0 rows, so the root job's `check-triggers` step sends nothing during recovery. BullMQ version is 5.70.4.

---

#### 9.2 Sweep and retry route reach the re-drive
**Status: PENDING**
**Model Tier: sonnet**
**Requirement Refs:** SE7-01, PE-012 (investigation 03, item CAP-1 and disagreement 7)
**Depends On:** 9.1
**Files Affected:**
- `packages/workers/src/jobs/daily-sweep.ts` (modify)
- `packages/workers/src/skills/stale-captures.ts` (modify)
- `packages/core-api/src/services/pipeline.ts` (modify)
- `packages/core-api/src/routes/captures.ts` (modify)
- `packages/workers/src/__tests__/daily-sweep.test.ts` (modify)
- `packages/workers/src/__tests__/stale-captures.test.ts` (modify)
- `packages/core-api/src/__tests__/pipeline.test.ts` (modify)
- `packages/core-api/src/__tests__/captures-routes.test.ts` (modify)

**Description:**
The nightly sweep adds a `capture-pipeline` job with `jobId = <captureId>`. The previous sweep job with that ID is still retained,
so BullMQ drops the add, the ingestion worker never runs, and the sweep counts the capture as re-queued. The retry route reads
`?stage=` and ignores the value. This item gives each sweep job a per-day ID (`sweep_<id>_<yyyymmdd>`), filters soft-deleted
captures out of the sweep, and passes `stage: 'all'` from the retry route to the ingestion worker.

**Tasks:**
1. [ ] In `jobs/daily-sweep.ts`, export `sweepJobId(captureId, date)` returning `sweep_<captureId>_<yyyymmdd>` (UTC date of the run) and use the function as the job ID. Add `isNull(captures.deleted_at)` to the `WHERE` clause. Update the JSDoc that says the job ID equals the capture ID.
2. [ ] In `skills/stale-captures.ts`, use `sweepJobId` and add the same `deleted_at IS NULL` filter. The skill has no dispatcher case; the edit keeps the two sweepers identical.
3. [ ] In `packages/core-api/src/services/pipeline.ts`, change `enqueue` to `enqueue(captureId, pipelineName = 'default', forceRetry = false, stage?: 'all')` and include `stage` in the job data. Update the local `CapturePipelineJobData` mirror.
4. [ ] In `packages/core-api/src/routes/captures.ts` (`POST /api/v1/captures/:id/retry`), accept `stage=all` only; any other value returns 400 through `ValidationError`. Pass the value to `pipelineService.enqueue(id, 'default', true, stage)`. Add `redrive: 'all' | 'embed'` to the response.
5. [ ] Update the four test files: sweep job ID format and the `deleted_at` predicate in the rendered SQL (the existing `PgDialect.sqlToQuery()` pattern); `enqueue` passes `stage`; the retry route with `?stage=all`, with `?stage=bogus`, and with no stage.
6. [ ] Host (owner), on the morning after the first 03:00 sweep following the deploy: `SELECT count(*) FROM captures WHERE embedding IS NULL AND deleted_at IS NULL AND created_at < now() - interval '1 day';` returns 0.

**Acceptance Criteria:**
- [ ] WHEN the nightly sweep finds a capture at a sweepable status older than 1 hour THEN the sweep SHALL add a `capture-pipeline` job with ID `sweep_<captureId>_<yyyymmdd>`, and the ingestion worker SHALL run for that capture.
- [ ] WHEN a capture has `deleted_at` set THEN the sweep SHALL NOT enqueue the capture.
- [ ] WHEN `POST /api/v1/captures/:id/retry` is called without `stage` THEN the ingestion worker SHALL re-run the embed only.
- [ ] WHEN `POST /api/v1/captures/:id/retry?stage=all` is called THEN the ingestion worker SHALL re-run the embed and each enrichment stage once.
- [ ] `pnpm --filter @open-brain/workers exec vitest run src/__tests__/daily-sweep.test.ts src/__tests__/ingest-pipeline.test.ts src/__tests__/stale-captures.test.ts` exits 0.
- [ ] `pnpm --filter @open-brain/core-api exec vitest run src/__tests__/pipeline.test.ts src/__tests__/captures-routes.test.ts` exits 0.

**Notes:**
This item holds the part of item 9.1 that did not fit in eight files: item 9.1 is the worker-side re-drive, and this item is the two callers. `SWEEPABLE_STATUSES` is unchanged. The retry route is the only caller that sends `stage: 'all'`. `wiki_ingest` routes to the paid `t1_fast` tier, so `stage=all` is for one capture at a time and never for a loop over captures.

---

#### 9.3 Job retention for flow jobs and core-api queues
**Status: PENDING**
**Model Tier: sonnet**
**Requirement Refs:** PE-004 (investigation 03, item CAP-2)
**Depends On:** 9.1, 9.2
**Files Affected:**
- `packages/workers/src/flows/ingest-pipeline.ts` (modify)
- `packages/workers/src/jobs/ingestion-worker.ts` (modify)
- `packages/workers/src/flows/redrive.ts` (modify — created by item 9.1)
- `packages/core-api/src/lib/queue-job-options.ts` (create)
- `packages/core-api/src/index.ts` (modify)
- `packages/core-api/src/__tests__/queue-job-options.test.ts` (create)
- `packages/workers/src/__tests__/integration/flow-redrive.test.ts` (modify — created by item 9.1)
- `scripts/clean-completed-flow-jobs.mjs` (create)

**Description:**
`FlowProducer.add` ignores each queue's `defaultJobOptions`; BullMQ reads defaults for flow nodes only from the `queuesOptions`
argument, so the five flow queues keep every completed and failed job. core-api builds `capture-pipeline`, `skill-execution`,
`document-pipeline`, `ingest-process`, and `wiki-ingest` with no options. Redis runs `noeviction` at 400 MB. This item passes
`queuesOptions` with `removeOnComplete: { age: 7 days }` and `removeOnFail: { age: 14 days }` on every flow add and gives core-api's
queues the same defaults as the workers-side queue factories.

**Tasks:**
1. [ ] Export `INGEST_FLOW_QUEUES_OPTIONS` from `flows/ingest-pipeline.ts`: a `FlowQueuesOpts` map for `ingest-root`, `embed-capture`, `extract-entities`, `extract-commitments`, and `wiki-ingest`, each `{ defaultJobOptions: { removeOnComplete: { age: 604800 }, removeOnFail: { age: 1209600 } } }`.
2. [ ] Pass `{ queuesOptions: INGEST_FLOW_QUEUES_OPTIONS }` as the second argument of every `flowProducer.add` call in `jobs/ingestion-worker.ts` and `flows/redrive.ts`.
3. [ ] Create `packages/core-api/src/lib/queue-job-options.ts` with one exported options object per queue, copying the values of the workers-side factories in `packages/workers/src/queues/` (`capture-pipeline.ts`, `skill-execution.ts`, `document-pipeline.ts`, `ingest-process.ts`, `wiki-ingest.ts`).
4. [ ] In `packages/core-api/src/index.ts`, pass each object as `defaultJobOptions` where the five queues are constructed.
5. [ ] Add `__tests__/queue-job-options.test.ts`: each object carries an age-bounded `removeOnFail` and a bounded `removeOnComplete`. Inline the expected values; core-api does not import `@open-brain/workers`.
6. [ ] Extend `flow-redrive.test.ts`: run a flow with the retention age overridden to 1 second, wait past the age, complete a second job, and assert the first job is gone from `bull:embed-capture:completed`.
7. [ ] Create `scripts/clean-completed-flow-jobs.mjs` on the pattern of `scripts/enqueue-email-classify.mjs`: for the five flow queues call `queue.clean(0, 100000, 'completed')` and print the removed count per queue; `--dry-run` prints `getJobCounts()` and removes nothing.
8. [ ] Host (owner), after the deploy: record `used_memory_human` from `redis-cli INFO memory`; copy the script into `open-brain-workers:/tmp/` and run the script with `--dry-run`, then without; record `INFO memory` again in `LAB_NOTEBOOK.md`.

**Acceptance Criteria:**
- [ ] WHEN a flow job completes THEN BullMQ SHALL remove completed jobs older than 7 days and failed jobs older than 14 days from the five flow queues.
- [ ] WHEN core-api adds a job to `capture-pipeline`, `skill-execution`, `document-pipeline`, `ingest-process`, or `wiki-ingest` THEN the job SHALL carry `removeOnComplete` and `removeOnFail`.
- [ ] Part 1 items 2.6 and 3.1 are deployed before this item merges.
- [ ] `docker compose -f docker-compose.test.yml up -d --wait && pnpm --filter @open-brain/workers exec vitest run --config vitest.config.integration.ts src/__tests__/integration/flow-redrive.test.ts` exits 0.
- [ ] `pnpm --filter @open-brain/core-api exec vitest run src/__tests__/queue-job-options.test.ts` exits 0.
- [ ] `INFO memory` before and after the one-time clean is recorded in `LAB_NOTEBOOK.md`.

**Notes:**
Cross-plan prerequisite: Part 1 item 2.6 (the queue registry) and Part 1 item 3.1 (the `pipeline-health` gauges and the embed-stall alert). This item lands after items 9.1 and 9.2 and after Part 1 item 3.1 for two reasons. Completed enrichment-child job IDs are today the only guard against duplicate enrichment on a full re-add, and item 9.1 removes the need for that guard. The stuck-capture gauge from Part 1 item 3.1 reads the `captures` table, so an embed outage stays visible after failed jobs are pruned; without the gauge the pruning hides the outage. `removeOnFail: true` is not used. Manual wiki re-ingest (`WikiService.triggerIngest`, job ID `wiki-ingest_<id>`) is a no-op today while the flow child with the same ID is retained; age-based retention ends that collision after 7 days. If Part 1 already set `removeOnFail` on the flow children, keep one definition: the `queuesOptions` map from this item.

---

#### 9.4 Uploads cannot crash the API and land where a sidecar reads
**Status: PENDING**
**Model Tier: sonnet**
**Requirement Refs:** QA-001, SE7-24, SE7-28 (stream half), QA-005 (investigation 03, items UPL-1 and UPL-2)
**Files Affected:**
- `packages/core-api/src/routes/ingest.ts` (modify)
- `packages/core-api/src/__tests__/ingest-routes.test.ts` (modify)
- `docker-compose.yml` (modify)
- `.github/workflows/ci.yml` (modify)
- `packages/web-next/tests/smoke/quick-capture.spec.ts` (modify)

**Description:**
`streamBodyToFile` creates the file `WriteStream` outside `pipeline()` with no `error` listener, so a failed open or write (EACCES,
ENOSPC) is an uncaught exception that ends the core-api process; the `catch` also leaves the partial file on disk. In production
`open-brain-core-api` has no inbox mount, so an uploaded file lands where no sidecar reads. The only multi-service e2e job hides
both defects behind `continue-on-error`. This item puts the write stream inside `pipeline()`, mounts the two host inbox directories
into core-api, and makes the e2e job able to fail.

**Tasks:**
1. [ ] In `routes/ingest.ts` (`streamBodyToFile`, `:128-152`), replace the hand-written `Writable` with a byte-counting `Transform` and call `streamPipeline(Readable.fromWeb(body), counter, sink)`, so an `error` on the file stream rejects the promise. Keep the size rule: a chunk that pushes the total past `maxBytes` fails with `ValidationError`.
2. [ ] In the `catch` around `streamBodyToFile` (`:337-343`), run `await unlink(destPath).catch(() => {})` before rethrowing.
3. [ ] Add two tests to `ingest-routes.test.ts`: a mocked `createWriteStream` whose stream emits `error` with code `EACCES` yields HTTP 500 with code `INGEST_WRITE_FAILED` and a call to `unlink` with the destination path; an upload over the size limit yields the validation error and removes the partial file.
4. [ ] In `docker-compose.yml`, add two long-syntax binds (`type: bind`, `bind.create_host_path: false`, read-write) to `core-api.volumes`: the host source that `financial-ingest` mounts at `/inbox` to `/app/inbox-volumes/financial`, and the host source that `utility-ingest` mounts at `/inbox` to `/app/inbox-volumes/utility`.
5. [ ] In `.github/workflows/ci.yml` job `validate-compose-dr`, add a step that renders `docker compose config --format json` and asserts with `jq -e` that each `core-api` inbox bind source equals the `/inbox` bind source of the matching sidecar.
6. [ ] In job `full-stack-e2e`, in the step that pre-seeds the AMEX inbox file, run `chown -R 1000:1000 /inbox-root` after the directory is created. Remove `continue-on-error: true` from the steps `Run ingest e2e`, `Install Playwright chromium`, and `Run web smoke`. Delete the job comment that calls those steps tolerant.
7. [ ] In `packages/web-next/tests/smoke/quick-capture.spec.ts`, fail the test when `process.env.CI === 'true'` and core-api is unreachable, instead of calling `test.skip`.
8. [ ] Host (owner), before the deploy: `chown 1000:1000` the two host inbox directories. Run the deploy; the config gate in `scripts/deploy.sh` must show the two new `core-api` binds as the only render difference. Recreate `core-api` only.
9. [ ] GitHub (owner): after three consecutive green runs of `Full-stack e2e (ingest + web smoke)` on `main`, add the check to the required status checks: `gh api -X POST repos/davistroy/open-brain/branches/main/protection/required_status_checks/contexts --input - <<< '{"contexts":["Full-stack e2e (ingest + web smoke)"]}'`.

**Acceptance Criteria:**
- [ ] WHEN the file write stream emits `error` during an upload THEN `POST /api/v1/ingest/upload` SHALL return HTTP 500 with code `INGEST_WRITE_FAILED` and the core-api process SHALL keep running.
- [ ] WHEN an upload fails after bytes were written THEN the route SHALL delete the partial file.
- [ ] WHEN `docker compose config` renders THEN `core-api` SHALL mount the same host inbox directories as `financial-ingest` and `utility-ingest`.
- [ ] WHEN the ingest e2e test or the web smoke fails THEN the `full-stack-e2e` job SHALL fail.
- [ ] `pnpm --filter @open-brain/core-api exec vitest run src/__tests__/ingest-routes.test.ts` exits 0.
- [ ] `grep -n 'continue-on-error: true' .github/workflows/ci.yml` prints nothing.
- [ ] Host: `docker inspect open-brain-core-api --format '{{json .Mounts}}'` lists both inbox binds, and one upload through the web UI reaches `file_uploads` status `parsed`.
- [ ] `Full-stack e2e (ingest + web smoke)` is a required status check on `main`.

**Notes:**
Merge the stream fix before the mount reaches the host: with the mount and wrong directory ownership, the old code ends the process on EACCES. core-api runs as uid 1000; the sidecars run as root and can read files owned by uid 1000. The sidecar ignores the uploaded file path and runs `--process-inbox`, so the mount target must be the sidecar's inbox directory. The 100 MiB cap and the `ValidationError` pass-through stay. Whether the e2e job has ever been green is unknown (U12); the three-run gate in task 9 keeps a flaky job from blocking every merge.

---

#### 9.5 Error listeners and a rejection handler
**Status: PENDING**
**Model Tier: sonnet**
**Requirement Refs:** SE7-22 (investigation 03, item PROC-1)
**Files Affected:**
- `packages/shared/src/lib/process-safety.ts` (create)
- `packages/shared/src/lib/index.ts` (modify)
- `packages/shared/src/lib/__tests__/process-safety.test.ts` (create)
- `packages/workers/src/main.ts` (modify)
- `packages/core-api/src/index.ts` (modify)

**Description:**
No `Worker`, `Queue`, or `FlowProducer` registers an `error` listener, so BullMQ prints Redis connection errors with `console.error`,
outside the pino log. Neither `workers/src/main.ts` nor `core-api/src/index.ts` registers `unhandledRejection`. This item adds one
helper that attaches `error` listeners and one process handler that logs at `fatal` and exits with code 1.

**Tasks:**
1. [ ] Create `packages/shared/src/lib/process-safety.ts` with `attachErrorListeners(emitters, log)`, where each emitter is typed structurally as `{ name?: string; on(event: 'error', listener: (err: Error) => void): unknown }`, and each listener calls `log.error({ err, queue: emitter.name }, 'bullmq error')`. `@open-brain/shared` gains no `bullmq` dependency.
2. [ ] In the same file add `installUnhandledRejectionHandler(log, exit = process.exit)`: the handler logs the reason at `fatal` and calls `exit(1)`.
3. [ ] Export both functions from `packages/shared/src/lib/index.ts`.
4. [ ] Add `process-safety.test.ts`: the listener logs the queue name; attaching the same emitter twice registers one listener; the rejection handler logs once at `fatal` and calls the injected `exit` with 1.
5. [ ] In `packages/workers/src/main.ts`, call `installUnhandledRejectionHandler(logger)` at the start of `main()`, and after `registerScheduledJobs` call `attachErrorListeners` with every worker, every queue in `queues`, every queue in `scheduledQueues`, and the `FlowProducer`.
6. [ ] In `packages/core-api/src/index.ts`, install the rejection handler before the server starts and attach listeners to `capturePipelineQueue`, `skillQueue`, `documentPipelineQueue`, `ingestProcessQueue`, `accessStatsQueue`, and the wiki queues when present.

**Acceptance Criteria:**
- [ ] WHEN a `Worker`, a `Queue`, or the `FlowProducer` emits `error` THEN the process SHALL write one pino `error` line that names the queue.
- [ ] WHEN a promise rejection is unhandled in `workers` or `core-api` THEN the process SHALL log at `fatal` and exit with code 1.
- [ ] `pnpm --filter @open-brain/shared test -- process-safety` exits 0.
- [ ] `pnpm -r test` exits 0.

**Notes:**
The restart policy and the crash-exit behaviour are unchanged: the handler logs and exits, and Docker restarts the container. The handler must not swallow the rejection and continue. The investigation record's command `pnpm -r exec vitest run` fails in `packages/mobile`, which uses jest; use `pnpm -r test`.

---

#### 9.6 Database pool safety
**Status: PENDING**
**Model Tier: sonnet**
**Requirement Refs:** DA7-20, PE-016 (investigation 03, item DB-1)
**Files Affected:**
- `packages/shared/src/db/client.ts` (modify)
- `packages/shared/src/db/__tests__/client.test.ts` (create)
- `packages/core-api/src/index.ts` (modify)
- `packages/core-api/src/app.ts` (modify)
- `packages/core-api/src/routes/health.ts` (modify)
- `packages/core-api/src/__tests__/health.test.ts` (modify)
- `config/postgres/postgresql.conf` (modify)

**Description:**
`createDb` builds a `pg.Pool` with no `error` listener and no statement timeout, so an error on an idle client is an uncaught
exception and a hung statement holds a connection until the container restarts. `routes/health.ts` builds and closes a new `Pool`
on every probe. `postgresql.conf` sets no limit on idle transactions. This item adds `pool.on('error')`, a 60-second
`statement_timeout` on the core-api pool only, `idle_in_transaction_session_timeout = 5min`, and a health probe on the main pool.

**Tasks:**
1. [ ] In `packages/shared/src/db/client.ts`, change the signature to `createDb(connectionString, opts?: { statementTimeoutMs?: number })`. Register `pool.on('error', (err) => logger.error({ err }, '[db] idle client error'))`. When `statementTimeoutMs` is set, pass `statement_timeout` in the `Pool` config.
2. [ ] Add `packages/shared/src/db/__tests__/client.test.ts` with `pg` mocked: an `error` event on the pool logs and does not throw; `statementTimeoutMs: 60000` reaches the `Pool` options; with no option the config has no `statement_timeout`.
3. [ ] In `packages/core-api/src/index.ts`, call `createDb(postgresUrl, { statementTimeoutMs: 60_000 })`. Leave `packages/workers/src/main.ts` unchanged.
4. [ ] In `packages/core-api/src/routes/health.ts`, change `registerHealthRoutes(app)` to `registerHealthRoutes(app, db?)`. `checkPostgres` runs `SELECT 1` through `db` with a 3-second bound when `db` is passed, and builds a one-off pool only when `db` is absent. In `packages/core-api/src/app.ts`, pass `db` at the `registerHealthRoutes` call.
5. [ ] In `config/postgres/postgresql.conf`, add `idle_in_transaction_session_timeout = 5min` with a comment that names the reason. Add no global `statement_timeout`.
6. [ ] Update `packages/core-api/src/__tests__/health.test.ts` for the injected `db`.
7. [ ] Host (owner), after the deploy: `docker exec open-brain-postgres psql -U openbrain -d openbrain -c "SELECT pg_reload_conf();" -c "SHOW idle_in_transaction_session_timeout;"`. Expected value: `5min`.

**Acceptance Criteria:**
- [ ] WHEN an idle pooled client emits an error THEN the process SHALL log the error and keep running.
- [ ] WHEN a core-api statement runs longer than 60 seconds THEN Postgres SHALL cancel the statement, and statements from `workers` SHALL have no statement timeout.
- [ ] WHEN `/health` is probed THEN `checkPostgres` SHALL use the main pool and SHALL create no new `Pool`.
- [ ] WHEN a session stays idle inside a transaction for 5 minutes THEN Postgres SHALL end the session.
- [ ] `pnpm --filter @open-brain/shared exec vitest run` exits 0.
- [ ] `pnpm --filter @open-brain/core-api exec vitest run src/__tests__/health.test.ts` exits 0.

**Notes:**
`workers` runs consolidation, retention, and re-embed statements that exceed 60 seconds, and `pg_dump` must not be cut; that is why the statement timeout is a pool option on core-api and not a server setting. Pool sizing (PE-003) is out of scope. `postgresql.conf` is a single-file bind mount. If `SHOW` still returns `0` after the reload, the container holds the file's previous inode; the setting then takes effect when Postgres is next recreated in the Part 1 stateful window. Do not recreate Postgres for this item.

---

### Phase 9 Testing Requirements

- [ ] The real-Redis test `flow-redrive.test.ts` asserts processor call counts for the four cases in item 9.1 and the retention trim in item 9.3.
- [ ] The upload route has a unit test in which the write stream emits `error`.
- [ ] `src/flows/ingest-pipeline.ts` keeps 100% line and function coverage (per-file lock in `packages/workers/vitest.config.ts`).
- [ ] New code has more than 80% test coverage.
- [ ] Core-api and workers integration tests pass.

### Phase 9 Completion Checklist

- [ ] All work items complete
- [ ] All tests passing
- [ ] Coverage gates still green (thresholds never lowered)
- [ ] `LAB_NOTEBOOK.md` entry holds the results; Decision Log and Action Items updated
- [ ] CLAUDE.md and memory updated with any non-trivial learning (re-drive rule, flow retention through `queuesOptions`, core-api inbox mounts, statement-timeout scope)
- [ ] Deployed through `scripts/deploy.sh` (core-api, workers) and verified in the running container (grep a marker, for example `docker exec open-brain-workers sh -c 'grep -rlF "[redrive] in flight" /app | head -1'`)
- [ ] Host tasks of items 9.2, 9.3, 9.4, and 9.6 done and recorded
- [ ] No regressions introduced

### Definition of Done (Runnable)
<!-- BEGIN DOD -->

| Check | Command | Pass Criteria |
|-------|---------|---------------|
| Tests and coverage gates | `pnpm -r test` | Exit code 0 |
| Lint and types | `pnpm -r lint` | Exit code 0 |
| Core-api integration | `pnpm test:integration` | Exit code 0 |
| Workers integration (includes `flow-redrive.test.ts`) | `docker compose -f docker-compose.test.yml up -d --wait && pnpm --filter @open-brain/workers test:integration; rc=$?; docker compose -f docker-compose.test.yml down -v; exit $rc` | Exit code 0 |
| Upload route | `pnpm --filter @open-brain/core-api exec vitest run src/__tests__/ingest-routes.test.ts` | Exit code 0 |
| No tolerated e2e step | `! grep -n 'continue-on-error: true' .github/workflows/ci.yml` | Exit code 0 |

<!-- END DOD -->

---

## Phase 10: Small paths that lose data or do nothing

**Estimated Complexity:** M (~22 files, ~920 LOC)
**Dependencies:** Part 1 Phase 5
**Execution Mode:** Parallel

### Goals

- Concurrent entity creation and oversized office files stop failing jobs.
- A voice memo that outlives the retry window stays on disk.
- Manual wiki lint runs, and inbound email is retried on 429 and accepted on 409.
- "WIPE ALL DATA" reports the tables it truncated.
- A gated skill completes without a retry, and a failed autonomy lookup leaves a log line.

### Work Items

#### 10.1 Entity creation race; office-extractor bounds
**Status: PENDING**
**Model Tier: sonnet**
**Requirement Refs:** SE7-13, SE7-14, SE7-23 (investigation 03, items ENT-1 and EXT-1)
**Files Affected:**
- `LAB_NOTEBOOK.md` (modify)
- `packages/workers/src/lib/entity-resolver.ts` (modify)
- `packages/workers/src/__tests__/entity-resolver.test.ts` (create)
- `packages/file-ingestion/src/extract.py` (modify)
- `packages/file-ingestion/tests/test_extract.py` (modify)

**Description:**
`resolveOrCreateEntity` selects and then inserts with no conflict clause, so two jobs that create the same `(name, entity_type)`
race and the loser fails on the unique index `entities_name_type_idx`. The docx, pptx, and xlsx extractors in `extract.py` have no
text cap, and the HTML section walk calls `find_next_siblings()` once per heading. This item adds `onConflictDoNothing` with a
re-select, adds the existing 50 MB cap to the three office extractors, and makes the sibling walk linear.

**Tasks:**
1. [ ] Add a `LAB_NOTEBOOK.md` entry for Phase 10 before the first commit of any Phase 10 item. Objective: seven small paths stop losing data or doing nothing. Hypothesis: each item's named test fails before the change and passes after. Rollback: `git revert` per item; redeploy the previous commit with `scripts/deploy.sh <previous sha>`; `wrangler rollback` for the email worker.
2. [ ] In `packages/workers/src/lib/entity-resolver.ts` (the insert at `:109`), add `.onConflictDoNothing({ target: [entities.name, entities.entity_type] })` before `.returning(...)`. When the insert returns no row, run the tier-1 select again and return that ID. Throw only when the re-select also finds nothing.
3. [ ] Create `packages/workers/src/__tests__/entity-resolver.test.ts`: an insert that returns `[]` followed by a select that returns the existing row yields the existing ID; the conflict target is `(name, entity_type)`.
4. [ ] In `packages/file-ingestion/src/extract.py`, track `total_chars` in `_extract_docx` (`:135`), `_extract_pptx` (`:202`), and `_extract_xlsx` (`:249`); stop reading when `total_chars > MAX_TEXT_SIZE` and set `metadata["truncated"] = True`, the same rule `_extract_pdf` uses at `:116`.
5. [ ] At `extract.py:401`, iterate `heading.next_siblings`, keep `Tag` instances only, and break at the next heading.
6. [ ] In `packages/file-ingestion/tests/test_extract.py`, add one test per office format with `MAX_TEXT_SIZE` patched to a small value, and one HTML test with 2,000 headings that asserts the same sections as the current implementation.

**Acceptance Criteria:**
- [ ] WHEN two jobs create the same `(name, entity_type)` at the same time THEN `resolveOrCreateEntity` SHALL return the existing row's ID in both jobs and neither job SHALL fail.
- [ ] WHEN a docx, pptx, or xlsx file yields more than `MAX_TEXT_SIZE` characters THEN the extractor SHALL stop reading and mark the result truncated.
- [ ] WHEN an HTML file has N headings THEN the section walk SHALL visit each sibling once.
- [ ] `pnpm --filter @open-brain/workers exec vitest run src/__tests__/entity-resolver.test.ts` exits 0.
- [ ] `cd packages/file-ingestion && pytest tests/test_extract.py` exits 0.

**Notes:**
The conflict target matches the unique index on `(name, entity_type)` (`scripts/init-schema.sql:1453`). Lookups stay case-insensitive; the case-sensitive index (SE7-27) is out of scope. Section output is unchanged: only `Tag` siblings, break at the next heading. Deploy: `workers` and `file-ingestion`.

---

#### 10.2 Voice dead-letter keeps the memo
**Status: PENDING**
**Model Tier: sonnet**
**Requirement Refs:** SE7-09 (investigation 04, item M10)
**Files Affected:**
- `packages/voice-capture/src/lib/transcript-spool.ts` (modify)
- `packages/voice-capture/src/__tests__/transcript-spool.test.ts` (modify)

**Description:**
`retrySpooledTranscripts` calls `removeSpooled`, an `unlink`, for a transcript older than `VOICE_SPOOL_MAX_AGE_MS` and for a file
that cannot be parsed, so the path named "dead-letter" deletes the only copy of the memo. This item renames both kinds of file
into a `dead-letter/` subdirectory of the spool. No outcome of the alert deletes the file.

**Tasks:**
1. [ ] In `transcript-spool.ts`, add `deadLetter(file)`: `mkdir(join(spoolDir(), 'dead-letter'), { recursive: true })`, then `rename(file, join(deadLetterDir, basename(file)))`.
2. [ ] In the age branch (`:125-135`), replace `removeSpooled(file)` with `deadLetter(file)`. Change the alert text from "was discarded without ingest" to "was moved to dead-letter/ without ingest".
3. [ ] In the unparseable-file branch (`:114-117`), replace `removeSpooled(file)` with `deadLetter(file)` and update the log message.
4. [ ] Keep `removeSpooled` for one case only: the ingest succeeded (including HTTP 409).
5. [ ] Update `transcript-spool.test.ts`: an aged file exists under `dead-letter/` with identical bytes and is absent from `listSpooled()`; an unparseable file is moved the same way; when the alert rejects, the file still exists under `dead-letter/`; a second sweep does not read `dead-letter/`.
6. [ ] Update the doc comment above `retrySpooledTranscripts` and the `deadLettered` field comment.

**Acceptance Criteria:**
- [ ] WHEN a spooled transcript is older than `VOICE_SPOOL_MAX_AGE_MS` THEN `retrySpooledTranscripts` SHALL move the file into `dead-letter/` and SHALL NOT delete the file.
- [ ] WHEN a spooled file cannot be parsed THEN `retrySpooledTranscripts` SHALL move the file into `dead-letter/`.
- [ ] WHEN the Pushover alert fails THEN the transcript file SHALL still exist on disk.
- [ ] WHEN the retry sweep runs THEN the sweep SHALL read `*.json` in the spool root only.
- [ ] `pnpm --filter @open-brain/voice-capture exec vitest run src/__tests__/transcript-spool.test.ts` exits 0.

**Notes:**
`listSpooled` reads `*.json` in the spool root, so a file in `dead-letter/` is never re-ingested. `dead-letter/` sits on the `voice_spool_data` volume (`VOICE_SPOOL_DIR`, default `/data/voice-spool`). A 409 from ingest stays terminal success. CLAUDE.md already says dead-lettered files are "moved aside"; this item makes that sentence true. Deploy: `voice-capture`.

---

#### 10.3 Manual wiki lint reaches a worker
**Status: PENDING**
**Model Tier: sonnet**
**Requirement Refs:** SE7-16 (investigation 04, item M11)
**Files Affected:**
- `packages/core-api/src/services/wiki.ts` (modify)
- `packages/core-api/src/index.ts` (modify)
- `packages/core-api/src/__tests__/wiki-service.test.ts` (modify)
- `packages/core-api/src/__tests__/wiki-routes.test.ts` (modify)
- `packages/shared/src/queue-names.ts` (modify — created by Part 1 item 2.6; absent at `f341ca6`)

**Description:**
`WikiService.triggerLint` adds a job to the `wiki-lint` queue. No `Worker` consumes that queue, so `POST /api/v1/wiki/lint`
returns a job ID and nothing runs. The scheduled lint runs through the `skill-execution` queue (`case 'wiki-lint'`). This item
makes `triggerLint` add `{ skillName: 'wiki-lint', input: {} }` to `skill-execution` and deletes the `wiki-lint` queue from core-api.

**Tasks:**
1. [ ] In `packages/core-api/src/services/wiki.ts`, replace the `wikiLintQueue` option with `skillQueue`. `triggerLint()` adds job name `wiki-lint`, data `{ skillName: 'wiki-lint', input: {} }`, options `{ priority: 2, jobId: 'manual_wiki-lint_<timestamp>' }`, the pattern at `routes/skills.ts:107`.
2. [ ] In `packages/core-api/src/index.ts`, pass `skillQueue` to `WikiService` and delete `wikiLintQueue`: the declaration, the `new Queue('wiki-lint', ...)`, and the `close()` in the shutdown handler.
3. [ ] Update `wiki-service.test.ts` and `wiki-routes.test.ts`: `triggerLint` adds to the injected skill queue with `skillName: 'wiki-lint'`; the route still returns the job ID.
4. [ ] If `packages/shared/src/queue-names.ts` lists `wiki-lint`, remove the entry and update the registry's invariant test in the same commit.
5. [ ] Host (owner, optional, after the deploy): list the orphan keys with `redis-cli --scan --pattern 'bull:wiki-lint:*'` and delete them.

**Acceptance Criteria:**
- [ ] WHEN `POST /api/v1/wiki/lint` is called THEN `WikiService.triggerLint` SHALL add a `skill-execution` job with `skillName: 'wiki-lint'`, and the `skill-execution` worker SHALL run `WikiLintSkill`.
- [ ] WHEN core-api starts THEN core-api SHALL create no `wiki-lint` queue.
- [ ] `pnpm --filter @open-brain/core-api exec vitest run src/__tests__/wiki-service.test.ts src/__tests__/wiki-routes.test.ts` exits 0.
- [ ] `grep -n "'wiki-lint'" packages/core-api/src/index.ts` prints nothing.

**Notes:**
`triggerResynthesize` adds to `wiki-ingest` and is unchanged; the finding named that method as a precedent for `skill-execution`, which was wrong. `wiki_lint` routes to the paid `t1_fast` tier; a manual trigger is one run started by a person. Deploy: `core-api`.

---

#### 10.4 Email worker retries instead of bouncing
**Status: PENDING**
**Model Tier: sonnet**
**Requirement Refs:** INT-002 (investigation 05, item EW1)
**Files Affected:**
- `cloudflare/email-worker/src/index.ts` (modify)
- `cloudflare/email-worker/src/index.test.ts` (modify)

**Description:**
`isTransientStatus` treats only `status >= 500` as retryable, so a 409 (duplicate capture) and a 429 (rate limit) from core-api
both reach `message.setReject`, which bounces the mail permanently. The two `fetch` calls have no timeout. This item treats 409 as
success and 429 as transient, and adds 15-second timeouts.

**Tasks:**
1. [ ] In `cloudflare/email-worker/src/index.ts`, change `isTransientStatus(status)` to `status === 429 || status >= 500`.
2. [ ] In the capture POST branch, on 409 log `duplicate capture — accepted` and return without calling `setReject`.
3. [ ] Add `signal: AbortSignal.timeout(15_000)` to the allowlist `fetch` (`:111`) and to the capture POST (`:207`). A timeout throws, and Cloudflare retries the delivery.
4. [ ] Update `index.test.ts`: 409 neither rejects nor throws; 429 throws; 400 calls `setReject`; a timeout throws.
5. [ ] Owner: `cd cloudflare/email-worker && npx wrangler deploy`.

**Acceptance Criteria:**
- [ ] WHEN core-api answers the capture POST with 409 THEN the worker SHALL accept the message without rejecting.
- [ ] WHEN core-api answers with 429 or a 5xx status THEN the worker SHALL throw so that Cloudflare retries the delivery.
- [ ] WHEN core-api answers with any other 4xx status THEN the worker SHALL call `message.setReject`.
- [ ] WHEN either request exceeds 15 seconds THEN the worker SHALL throw.
- [ ] `cd cloudflare/email-worker && npm ci && npm run typecheck && npm test` exits 0.

**Notes:**
The worker is a standalone npm project outside the pnpm workspace and outside the host deploy. A 400 must stay permanent: retrying a malformed request loops forever. The sender-not-allowed reject is unchanged. Giving the worker its own caller identity is out of scope.

---

#### 10.5 "WIPE ALL DATA" derives its table list
**Status: PENDING**
**Model Tier: sonnet**
**Requirement Refs:** DA7-14 (investigation 04, item M12)
**Files Affected:**
- `packages/core-api/src/services/admin.service.ts` (modify)
- `packages/core-api/src/__tests__/admin-service.test.ts` (modify)
- `packages/core-api/src/__tests__/admin-reset-two-step.test.ts` (modify)
- `packages/core-api/src/__tests__/integration/admin-reset-tables.test.ts` (create)

**Description:**
`truncateUserData` truncates a hardcoded list of 10 tables with `CASCADE` and returns that same list. The response omits the
tables `CASCADE` also empties (`briefs`, `capture_associations`, `commitments`, `email_drafts`) and never names a table added by a
later migration. This item derives the wipe list from `pg_tables` minus a keep-list and returns the tables actually truncated.

**Tasks:**
1. [ ] Resolve unknown U10 with the owner before coding and record the answer in `LAB_NOTEBOOK.md`: whether `lab_results`, `insurance_policies`, `email_classifications`, `email_corrections`, and `email_daily_summaries` are wiped or kept. Show the owner the six tables the derived rule wipes for the first time (see Notes).
2. [ ] In `packages/core-api/src/services/admin.service.ts`, replace `TRUNCATE_TABLES` with `KEEP_TABLES`: `admin_audit`, `app_settings`, `schema_migrations`, `__drizzle_migrations`, `triggers`, plus each table the owner keeps in task 1. With no answer from the owner, keep the five undecided tables; the current list does not truncate them.
3. [ ] In `truncateUserData`, read `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`, subtract `KEEP_TABLES`, check each name against `^[a-z_][a-z0-9_]*$`, and run one `TRUNCATE <list> CASCADE`. Return the list.
4. [ ] Before the `TRUNCATE`, query `pg_constraint` for a foreign key from a kept table to a wiped table. When one exists, throw an error that names both tables and truncate nothing; `CASCADE` would otherwise empty the kept table.
5. [ ] Update the two unit test files: `admin_audit` is in `KEEP_TABLES`, asserted on the exported constant and on the source text, as the current invariant tests do.
6. [ ] Create `integration/admin-reset-tables.test.ts` against the real schema: every table in `pg_tables` is either wiped or in `KEEP_TABLES`; after a wipe, `admin_audit` keeps its rows; the returned list equals the set of tables whose row count went to 0; a kept table with a foreign key to a wiped table makes `truncateUserData` throw before any `TRUNCATE`.

**Acceptance Criteria:**
- [ ] WHEN `truncateUserData` runs THEN the function SHALL truncate every public table that is not in `KEEP_TABLES` and SHALL return exactly those table names.
- [ ] WHEN a migration adds a table THEN the next wipe SHALL include the table with no code change.
- [ ] WHEN a kept table has a foreign key to a wiped table THEN `truncateUserData` SHALL throw before truncating.
- [ ] WHEN a wipe runs THEN `admin_audit`, `app_settings`, `schema_migrations`, and `triggers` SHALL keep their rows.
- [ ] `pnpm --filter @open-brain/core-api exec vitest run src/__tests__/admin-service.test.ts src/__tests__/admin-reset-two-step.test.ts` exits 0.
- [ ] `pnpm test:integration` exits 0.

**Notes:**
The derived rule wipes six tables that the hardcoded list leaves alone: `activity_feed`, `backup_log`, `container_health`, `file_uploads`, `mcp_activity`, and `retention_audit`. The two-step token, the origin check, the pre-wipe `pg_dump`, and the `admin_audit` rows are unchanged. The CLAUDE.md invariant "`admin_audit` is excluded from the TRUNCATE list, asserted by a code-level test" stays true through `KEEP_TABLES`. The schema at `f341ca6` has 28 public tables. Deploy: `core-api`.

---

#### 10.6 Gated skills complete cleanly; silent catches log
**Status: PENDING**
**Model Tier: sonnet**
**Requirement Refs:** SE7-06, SE7-20 (investigation 04, items M9 and M13)
**Files Affected:**
- `packages/workers/src/jobs/skill-execution.ts` (modify)
- `packages/workers/src/skills/base-skill.ts` (modify)
- `packages/workers/src/__tests__/skill-execution.test.ts` (modify)
- `packages/workers/src/__tests__/base-skill-autonomy.test.ts` (modify)

**Description:**
Below a skill's minimum autonomy level, `BaseSkill.execute` returns `{ status: 'gated' }` cast to the skill's result type. The
dispatcher then reads `result.output.headline` on that stub and throws, so the job fails and retries. `fetchAutonomyLevel`
discards a lookup failure with no log line and caches the `observe` fallback for 5 minutes. This item makes a gated run throw a
`SkillGated` sentinel that the processor logs once and completes, and makes the lookup log at warn and cache the fallback for 30
seconds. Item 16.2 adds log lines at the other silent catches of SE7-20.

**Tasks:**
1. [ ] In `packages/workers/src/jobs/skill-execution.ts`, define `class SkillGated extends Error` with `skillName`, `currentLevel`, and `requiredLevel`. In `runSkill` (`:49-56`), throw `SkillGated` when the result of `skill.execute(input)` has `status === 'gated'`.
2. [ ] Wrap the dispatcher `switch` in `try/catch`. On `SkillGated`: write one `info` log line, insert one `skills_log` row (`skill_name`, `output_summary: 'gated: <current> < <required>'`), and return, so BullMQ marks the job completed with no retry. Rethrow every other error.
3. [ ] In `packages/workers/src/skills/base-skill.ts` (`fetchAutonomyLevel`, `:11-33`), log `logger.warn` in the `catch` and in the non-OK branch. Cache the `observe` fallback for 30 seconds (new constant `AUTONOMY_FALLBACK_TTL`); keep 5 minutes for a successful lookup.
4. [ ] Confirm the lookup passes `signal: AbortSignal.timeout(5_000)` (added by item 16.1). Add the signal here when item 16.1 has not merged.
5. [ ] In `skill-execution.test.ts`, add a dispatcher test with the autonomy lookup mocked to `observe` for `daily-sweep-skill`, `monthly-reflection`, `memory-consolidation`, and `email-compose`: the processor resolves, one `skills_log` row is inserted, and no skill `run` executes.
6. [ ] In `base-skill-autonomy.test.ts`: a failed lookup logs at warn; a second `execute` 31 seconds later calls `fetch` again; a successful lookup is still cached for 5 minutes. `src/skills/base-skill.ts` has a per-file 100% coverage lock.

**Acceptance Criteria:**
- [ ] WHEN the current autonomy level is below a skill's `minimum_autonomy` THEN the `skill-execution` processor SHALL log the gate once, write one `skills_log` row, and complete the job without a retry.
- [ ] WHEN the autonomy lookup fails THEN `fetchAutonomyLevel` SHALL log at warn, return `observe`, and repeat the lookup after 30 seconds.
- [ ] WHEN the autonomy lookup succeeds THEN the level SHALL be cached for 5 minutes.
- [ ] `pnpm --filter @open-brain/workers exec vitest run src/__tests__/skill-execution.test.ts src/__tests__/base-skill-autonomy.test.ts` exits 0.

**Notes:**
The fail-closed default stays `observe`, and no subclass overrides `execute()`. Host fact: the live autonomy level is `assist`, so the dispatcher throw is latent today. A core-api outage makes the throw live, because the lookup then falls back to `observe`. Deploy: `workers`.

---

### Phase 10 Testing Requirements

- [ ] Each item has a test that fails before the change: the entity race, the three extractor caps, the dead-letter move, the wiki lint queue, the four email worker status cases, the derived wipe list, and the gated dispatcher.
- [ ] The wipe list has a real-database test in `packages/core-api/src/__tests__/integration/`.
- [ ] `src/skills/base-skill.ts` keeps 100% line and function coverage.
- [ ] New code has more than 80% test coverage.
- [ ] Core-api integration tests pass.

### Phase 10 Completion Checklist

- [ ] All work items complete
- [ ] All tests passing
- [ ] Coverage gates still green (thresholds never lowered)
- [ ] `LAB_NOTEBOOK.md` entry holds the results; Decision Log and Action Items updated
- [ ] CLAUDE.md and memory updated with any non-trivial learning (email worker 409 and 429 rules, `KEEP_TABLES`, `SkillGated`, dead-letter directory)
- [ ] Deployed through `scripts/deploy.sh` (core-api, workers, voice-capture, file-ingestion) and verified in the running container (grep a marker, for example `docker exec open-brain-voice-capture sh -c 'grep -rlF "dead-letter" /app | head -1'`)
- [ ] Email worker deployed by the owner with `wrangler deploy`
- [ ] No regressions introduced

### Definition of Done (Runnable)
<!-- BEGIN DOD -->

| Check | Command | Pass Criteria |
|-------|---------|---------------|
| Tests and coverage gates | `pnpm -r test` | Exit code 0 |
| Lint and types | `pnpm -r lint` | Exit code 0 |
| Python lint and types | `ruff check . && ruff format --check . && pyright` | Exit code 0 |
| Core-api integration | `pnpm test:integration` | Exit code 0 |
| Extractor tests | `cd packages/file-ingestion && pytest tests/test_extract.py` | Exit code 0 |
| Email worker | `cd cloudflare/email-worker && npm ci && npm run typecheck && npm test` | Exit code 0 |
| Voice spool | `pnpm --filter @open-brain/voice-capture exec vitest run src/__tests__/transcript-spool.test.ts` | Exit code 0 |

<!-- END DOD -->

---

## Phase 11: Search and memory

**Estimated Complexity:** L (~30 files, ~1,770 LOC)
**Dependencies:** Part 1 Phase 5; Part 1 item 8.1 (migration 0037) before 11.2; Part 1 item 1.2 (re-embed) before 11.6
**Execution Mode:** Sequential

### Goals

- A filtered search returns `limit` rows on every connection.
- Keyword search returns captures that have no embedding.
- The co-access boost changes ranking, and idle pairs are pruned.
- Every workers SQL statement runs against Postgres in CI.
- Memory consolidation merges atomically or changes nothing.

### Work Items

#### 11.1 Filtered search returns full results
**Status: PENDING**
**Model Tier: sonnet**
**Requirement Refs:** PE-001, PE-011, QA-011 (investigation 03, item SRCH-1)
**Files Affected:**
- `LAB_NOTEBOOK.md` (modify)
- `packages/core-api/src/services/search.ts` (modify)
- `packages/shared/src/types/config.ts` (modify)
- `config/pipeline.yaml` (modify)
- `packages/core-api/src/index.ts` (modify)
- `packages/core-api/src/__tests__/search-service.test.ts` (modify)
- `packages/core-api/src/__tests__/integration/search.test.ts` (modify)
- `scripts/benchmark-search.mjs` (modify)

**Description:**
With a filter, the HNSW scan in the vector arm of `hybrid_search()` returns at most `ef_search` (60) candidates before the filter
runs, so a 30-day filter returns about 3 of 10 rows, and the plan-cache flip after the sixth execution on a connection changes the
count again. `SearchService.search` also cuts to `limit` before temporal decay re-ranks. This item adds
`SET LOCAL hnsw.iterative_scan = relaxed_order` beside the existing `SET LOCAL hnsw.ef_search`, inside the same transaction, and
fetches `limit × 3` candidates when `temporalWeight > 0`.

**Tasks:**
1. [ ] Add a `LAB_NOTEBOOK.md` entry for Phase 11 before the first commit. Objective: filtered and keyword search return full results; the co-access boost is read; workers SQL runs in CI; consolidation is atomic. Hypothesis: a filtered search returns 10 of 10 rows on eight consecutive runs on one connection; the consolidation real-database test passes. Rollback: `git revert`; set `search.hnsw_iterative_scan: false`; re-create the previous `hybrid_search()` from migration 0034; disable the consolidation cron.
2. [ ] In `packages/shared/src/types/config.ts` (`PipelineConfigSchema.search`, `:27`), add `hnsw_iterative_scan: z.boolean().default(true)`. In `config/pipeline.yaml`, add `hnsw_iterative_scan: true` under `search:`.
3. [ ] In `packages/core-api/src/index.ts` (`:106-107`), read `search.hnsw_iterative_scan` and pass the value as the fourth constructor argument of `SearchService`.
4. [ ] In `packages/core-api/src/services/search.ts` (`:257`), inside the existing `this.db.transaction`, after `SET LOCAL hnsw.ef_search`, run `SET LOCAL hnsw.iterative_scan = relaxed_order` when the flag is true. Use `sql.raw` with the constant string. Run no `SET` outside the transaction.
5. [ ] In the same method, when `temporalWeight > 0`, call `hybrid_search` with `limit * 3`, apply decay, sort, and then `slice(0, limit)`. With `temporalWeight = 0`, request `limit` rows as today.
6. [ ] In `search-service.test.ts`, update the call-count assertions for the transaction (one more `execute` call with the flag on, unchanged with the flag off) and add a test: `temporalWeight: 0.3` with `limit: 5` requests 15 rows.
7. [ ] In `integration/search.test.ts`, seed about 2,000 captures with random 768-dimension vectors, where about 5% match one `brain_view`. Run the filtered search 8 times on one pooled connection and assert 10 rows on every run.
8. [ ] Run the same test once with the flag off and record the row counts in `LAB_NOTEBOOK.md`. Do not assert the flag-off count in the test: the plan choice depends on table statistics.
9. [ ] In `scripts/benchmark-search.mjs`, add a filtered scenario (a date filter that matches about 5% of rows, with the GUC on and off) and print rows returned beside latency.

**Acceptance Criteria:**
- [ ] WHEN a hybrid or vector search runs with a filter and at least `limit` captures match THEN `SearchService.search` SHALL return `limit` rows.
- [ ] WHEN the same filtered search runs 8 times on one connection THEN each run SHALL return the same number of rows.
- [ ] WHEN `temporalWeight > 0` THEN the service SHALL fetch `limit × 3` candidates before decay and SHALL return `limit` rows.
- [ ] WHEN `search.hnsw_iterative_scan` is false THEN the service SHALL NOT set the GUC.
- [ ] `pnpm --filter @open-brain/core-api exec vitest run src/__tests__/search-service.test.ts` exits 0.
- [ ] `pnpm test:integration` exits 0.

**Notes:**
Cross-plan prerequisite: Part 1 item 5.4 pins the pgvector image; the pin must stay at 0.8 or later. Production pgvector is 0.8.5 (live check L12), so the GUC exists; on a pgvector older than 0.8 the `SET` raises an error. The `SET LOCAL` stays inside the transaction (CLAUDE.md, the PE-M1 rule). The `LIMIT match_count * 4` push-down inside `hybrid_search()` is unchanged. Deploy: `core-api`.

---

#### 11.2 Keyword search finds captures without an embedding
**Status: PENDING**
**Model Tier: sonnet**
**Requirement Refs:** DA7-19 (investigation 03, item SRCH-2)
**Files Affected:**
- `packages/shared/drizzle/0038_hybrid_search_fts_unembedded.sql` (create)
- `scripts/init-schema.sql` (modify)
- `packages/core-api/src/__tests__/integration/search.test.ts` (modify)

**Description:**
The full-text arm of `hybrid_search()` filters on `c.embedding IS NOT NULL`, so a capture whose embed failed is invisible to
keyword search as well as to vector search. Migration `0038` replaces `hybrid_search()` with a copy whose `fts_ranked` CTE drops
that predicate; the `vector_ranked` CTE keeps the predicate. `scripts/init-schema.sql` is generated: this item rebuilds the file
with `scripts/regenerate-init-schema.sh` and does not edit the file by hand.

**Tasks:**
1. [ ] Create `packages/shared/drizzle/0038_hybrid_search_fts_unembedded.sql`: `CREATE OR REPLACE FUNCTION hybrid_search(...)` with the current body (`scripts/init-schema.sql:133-200`), the same signature, and the same `LIMIT match_count * 4` in both CTEs. Remove `c.embedding IS NOT NULL` from `fts_ranked` only. Header comment: purpose, and the reverse (re-apply the definition from `0034_content_tsvector.sql`).
2. [ ] Run `bash scripts/regenerate-init-schema.sh`. Commit the migration and the regenerated `scripts/init-schema.sql` together.
3. [ ] Run `bash scripts/validate-init-schema.sh`.
4. [ ] In `integration/search.test.ts`, insert a capture with `embedding = NULL` and a unique term. A hybrid search for the term returns the capture with `vector_score = 0`. `fts_only_search` returns the capture as before.
5. [ ] Host (owner), after Part 1 item 8.1 has applied migration 0037: take a backup, then run `bash scripts/migrate-manual.sh` from the throwaway pgvector container described in CLAUDE.md (homeserver deploy mechanics). Do not paste `--status` output into the notebook; the output prints the connection string.

**Acceptance Criteria:**
- [ ] WHEN a capture has `embedding IS NULL` and its content matches the query text THEN `hybrid_search()` SHALL return the capture from the full-text arm.
- [ ] WHEN `hybrid_search()` runs THEN the vector arm SHALL still exclude captures with `embedding IS NULL`.
- [ ] `bash scripts/validate-init-schema.sh` exits 0.
- [ ] `pnpm test:integration` exits 0.
- [ ] Host: `SELECT max(version) FROM schema_migrations;` returns `0038`.

**Notes:**
Cross-plan prerequisite: Part 1 item 8.1. `migrate-manual.sh` applies files in order, so `0037` must be in the ledger first. The migration changes one function and no table, so the migration needs no table rewrite and no shared-memory workaround. `fts_only_search` is unchanged.

---

#### 11.3 Wire the co-access boost
**Status: PENDING**
**Model Tier: sonnet**
**Requirement Refs:** SE7-12, DA7-15, SE7-26, PE-014 (investigation 04, item M3)
**Files Affected:**
- `packages/core-api/src/services/search.ts` (modify)
- `packages/workers/src/jobs/update-access-stats.ts` (modify)
- `CLAUDE.md` (modify)
- `packages/core-api/src/__tests__/search-service.test.ts` (modify)
- `packages/core-api/src/__tests__/integration/search.test.ts` (modify)
- `packages/workers/src/__tests__/update-access-stats.test.ts` (modify)
- `packages/workers/src/__tests__/prune-associations.test.ts` (modify)
- `packages/workers/src/__tests__/integration/access-stats-e2e.test.ts` (modify)

**Description:**
Every search writes up to 45 `capture_associations` pairs and nothing reads the table: the boost in `SearchService.search` runs
only when `options.recentCaptureIds` is set, and no caller sets the option. A new pair gets weight 1.0 while the prune requires
`weight < 0.1`, so a pair seen once is never pruned; a job that arrives out of order makes the decay interval negative and raises
the weight. This item reads the recently accessed captures when the option is absent, clamps the interval at zero, and prunes on
idle time alone.

**Tasks:**
1. [ ] In `packages/core-api/src/services/search.ts` (`:320-323`), when `options.recentCaptureIds` is undefined, run `SELECT id FROM captures WHERE last_accessed_at > now() - interval '30 minutes' AND deleted_at IS NULL ORDER BY last_accessed_at DESC LIMIT 20` inside `try/catch`. On an error, log at debug and skip the boost. Callers are unchanged.
2. [ ] In `packages/workers/src/jobs/update-access-stats.ts` (`:57-62`), in the `ON CONFLICT … DO UPDATE`, use `GREATEST(EXCLUDED.last_co_access - capture_associations.last_co_access, interval '0')` as the decay interval and `last_co_access = GREATEST(capture_associations.last_co_access, EXCLUDED.last_co_access)`. Keep one `db.execute` call for all pairs.
3. [ ] In `pruneStaleAssociations` (`:189-196`), delete on `last_co_access < now() - <staleDays> days` alone, in batches of 5,000 rows, and return the summed row count instead of `.returning`. Remove the `weightThreshold` option.
4. [ ] In `CLAUDE.md`, in the Batch-UPSERT invariant bullet, replace the weight formula with the clamped form, state that `last_co_access` never moves backwards, and state the idle-only prune rule.
5. [ ] Update the unit tests: the rendered UPSERT contains `GREATEST` and is one `execute` call for 45 pairs; the prune ignores weight.
6. [ ] Extend `integration/access-stats-e2e.test.ts`: an out-of-order job leaves `weight <= co_access_count` and does not move `last_co_access` backwards; a pair idle for more than 90 days with weight 1.0 is pruned.
7. [ ] Extend `integration/search.test.ts`: with an association between capture A (accessed 1 minute ago) and capture B, a search that returns B gives B a higher score than the same search with no association.

**Acceptance Criteria:**
- [ ] WHEN a search runs without `recentCaptureIds` THEN `SearchService.search` SHALL read up to 20 captures accessed in the last 30 minutes and SHALL raise the score of associated results by at most 10%.
- [ ] WHEN the recent-capture query fails THEN the search SHALL return results without the boost.
- [ ] WHEN an `access-stats` job carries an `accessedAt` older than the stored `last_co_access` THEN the weight SHALL NOT exceed the new `co_access_count` and `last_co_access` SHALL NOT move backwards.
- [ ] WHEN a pair has been idle for more than 90 days THEN the weekly prune SHALL delete the pair at any weight.
- [ ] `upsertCoAccessAssociations` issues exactly one `db.execute` call for any pair count.
- [ ] `pnpm test:integration` exits 0.
- [ ] `docker compose -f docker-compose.test.yml up -d --wait && pnpm --filter @open-brain/workers exec vitest run --config vitest.config.integration.ts src/__tests__/integration/access-stats-e2e.test.ts` exits 0.

**Notes:**
The decision is to wire the boost, not to remove the feature: removal touches the scheduler slot registry, the worker registration, the consolidation repoint, and more than ten files, and contradicts the documented search signals. The five fire-and-forget producers and the top-10 slice are unchanged. The multiplier stays `1 + 0.1 × normalizedWeight`. The first prune after the deploy deletes every pair that has been idle for 90 days; the batches keep each statement short. Deploy: `core-api` and `workers`.

---

#### 11.4 Soft-delete readers
**Status: PENDING**
**Model Tier: haiku**
**Requirement Refs:** DA7-16 (investigation 03, item DEL-1)
**Files Affected:**
- `packages/workers/src/skills/weekly-brief-query.ts` (modify)
- `packages/core-api/src/services/trigger.ts` (modify)
- `packages/workers/src/__tests__/weekly-brief-query.test.ts` (modify)
- `packages/core-api/src/__tests__/trigger-service.test.ts` (modify)

**Description:**
Soft delete is stored two ways: `CaptureService.softDelete` sets `deleted_at` and `pipeline_status = 'deleted'`, while memory
consolidation sets `deleted_at` only. The weekly-brief capture query and the trigger test query filter on `pipeline_status`
alone, so both would show captures that consolidation soft-deleted. This item adds `AND deleted_at IS NULL` to both queries.

**Tasks:**
1. [ ] `packages/workers/src/skills/weekly-brief-query.ts:87`: add `AND deleted_at IS NULL` to the capture query.
2. [ ] `packages/core-api/src/services/trigger.ts:199`: add `AND deleted_at IS NULL` to the similarity query.
3. [ ] In each test file, render the SQL and assert the predicate is present.

**Acceptance Criteria:**
- [ ] WHEN a capture has `deleted_at` set and `pipeline_status = 'complete'` THEN the weekly-brief query and the trigger test query SHALL exclude the capture.
- [ ] `pnpm --filter @open-brain/workers exec vitest run src/__tests__/weekly-brief-query.test.ts` exits 0.
- [ ] `pnpm --filter @open-brain/core-api exec vitest run src/__tests__/trigger-service.test.ts` exits 0.

**Notes:**
This item merges before item 11.6. The `'deleted'` status value stays; no migration. The sweep's `deleted_at` filter is item 9.2. Tier `haiku`: two one-line predicates and two assertions.

---

#### 11.5 Workers SQL runs against Postgres in CI
**Status: PENDING**
**Model Tier: sonnet**
**Requirement Refs:** QA-002 (investigation 04, item M2)
**Files Affected:**
- `packages/workers/src/__tests__/integration/sql-smoke.test.ts` (create)
- `packages/workers/src/__tests__/uuid-array-guard.test.ts` (create)
- `packages/workers/src/__tests__/integration/retention-prune-effect.test.ts` (create)
- `packages/workers/src/__tests__/integration/dedup-sweep-effect.test.ts` (create)
- `packages/workers/src/__tests__/integration/helpers.ts` (modify)

**Description:**
Workers SQL is tested only through a mocked `db.execute`, so a statement that Postgres rejects, such as the
`ANY(($1, $2)::uuid[])` form in `memory-consolidation.ts`, passes a green suite. This item adds an integration test that runs each
workers SQL module once against the CI Postgres, a static test that fails on a raw `${ident}::uuid[]` interpolation, and seeded
effect tests for the retention prune and the dedup sweep.

**Tasks:**
1. [ ] Create `integration/sql-smoke.test.ts` with one test per workers module that calls `.execute(` (29 files at `f341ca6`; list them with `grep -rlE "db\.execute\(|\.execute<|tx\.execute" packages/workers/src --include=*.ts | grep -v __tests__`). For a `*-query.ts` module, call each exported function once with minimal valid arguments on the empty schema. For a module whose SQL sits inside a skill or job class, run the class once with the LLM, Pushover, and HTTP dependencies stubbed. Assert each call resolves.
2. [ ] In the same file, keep a `COVERED_MODULES` array and a test that compares the array with the file list from task 1, so a new SQL module fails the suite until the module has a smoke call. Mark `skills/memory-consolidation.ts` as covered by the integration test of item 11.6.
3. [ ] Create `uuid-array-guard.test.ts` (unit test, no database): scan non-test `.ts` files under `packages/workers/src`, `packages/core-api/src`, and `packages/shared/src`, and fail on `${ident}::uuid[]` unless `ident` starts with `pg`. Skip comment lines; `lib/pg-uuid-array.ts:7` shows the bad pattern inside a comment.
4. [ ] In the guard, add one temporary exemption for `packages/workers/src/skills/memory-consolidation.ts` that asserts exactly 8 raw interpolations in that file. Item 11.6 deletes the exemption.
5. [ ] Create `integration/retention-prune-effect.test.ts`: seed rows older and newer than each `RETENTION_POLICY` window, run the prune, and assert the old rows are gone, the new rows remain, `retention_audit` has one row per table, and `admin_audit` is unchanged.
6. [ ] Create `integration/dedup-sweep-effect.test.ts`: seed two `complete` captures with identical embeddings; the sweep reports one pair and writes the `capture_dedup_last_scan_at` watermark; a second run reports no new pair.
7. [ ] Add the seed helpers the three integration tests share to `integration/helpers.ts`.
8. [ ] Confirm the workers step of the `integration-test` CI job runs the new files and stays inside the job timeout.

**Acceptance Criteria:**
- [ ] WHEN a workers query contains SQL that Postgres rejects THEN `sql-smoke.test.ts` SHALL fail in the required `integration-test` job.
- [ ] WHEN a file interpolates `${ident}::uuid[]` with an identifier that does not start with `pg` THEN `uuid-array-guard.test.ts` SHALL fail.
- [ ] WHEN a new workers module calls `.execute(` without a smoke entry THEN the suite SHALL fail.
- [ ] `docker compose -f docker-compose.test.yml up -d --wait && pnpm --filter @open-brain/workers exec vitest run --config vitest.config.integration.ts` exits 0.
- [ ] `pnpm --filter @open-brain/workers exec vitest run src/__tests__/uuid-array-guard.test.ts` exits 0.

**Notes:**
At `f341ca6` the guard matches exactly the eight interpolations on seven lines of `memory-consolidation.ts`; every other site passes a `pg`-prefixed string literal. `vitest.config.integration.ts` runs one fork with `bail: 1`; keep the new tests free of time-of-day and ordering dependence. No test calls an LLM. The static guard runs in the unit suite, so the guard is part of the `build-and-test` required check.

---

#### 11.6 Memory consolidation merges atomically or does nothing
**Status: PENDING**
**Model Tier: opus**
**Requirement Refs:** SE7-03, DA7-06, SA7-07 (investigation 04, item M1)
**Depends On:** 11.4, 11.5
**Files Affected:**
- `packages/workers/src/skills/memory-consolidation.ts` (modify)
- `packages/workers/src/lib/hnsw-similarity.ts` (modify)
- `packages/workers/src/skills/memory-consolidation-query.ts` (modify)
- `packages/workers/src/jobs/skill-execution.ts` (modify)
- `packages/workers/src/__tests__/integration/memory-consolidation.test.ts` (create)
- `packages/workers/src/__tests__/memory-consolidation.test.ts` (modify)
- `packages/workers/src/__tests__/uuid-array-guard.test.ts` (modify — created by item 11.5)
- `CLAUDE.md` (modify)

**Description:**
`memory-consolidation.ts` interpolates JavaScript arrays as `::uuid[]` at eight sites. Postgres rejects each statement, three
`catch` blocks return 0, and the skill creates a merged capture while leaving the originals in place. `repointAssociations` also
fails with "ON CONFLICT DO UPDATE command cannot affect row a second time" when two merged originals share a neighbour, and the
watermark advances before the clusters are processed. This item fixes all of these in one change: the skill is destructive and
runs at the live autonomy level `assist`.

**Tasks:**
1. [ ] Replace the eight raw interpolations (`:305`, `:534` twice, `:547`, `:549`, `:579`, `:581`, `:624`) with `pgUuidArray(...)`. Both `= ANY(...)` and `!= ALL(...)` accept the helper's output.
2. [ ] In `repointAssociations`, in both passes, group the rows to write by the new canonical pair `(new_a, new_b)` with `SUM(co_access_count)`, `MAX(weight)`, and `MAX(last_co_access)` before the `INSERT … ON CONFLICT`. Delete the pairs that join two originals.
3. [ ] Delete the three `catch` blocks that return 0 (`:508`, `:606`, `:633`). Run the entity-link move, the association rewrite, and the soft-delete of the originals inside one `this.db.transaction`. Throw unless the soft-delete row count equals the number of originals loaded.
4. [ ] The merged capture is created over HTTP before the transaction and cannot join the transaction. When the transaction throws, soft-delete the merged capture with `DELETE /api/v1/captures/:id` (same `X-Open-Brain-Caller: memory-consolidation` header as the POST) and count the cluster as an error.
5. [ ] Soft-delete the originals with `deleted_at` and `pipeline_status = 'deleted'`, the pair `CaptureService.softDelete` writes.
6. [ ] Move `writeScanWatermark` to the end of `run`. Advance the watermark only when every cluster finished without an error and `totalClustersFound <= maxClusters`.
7. [ ] In `packages/workers/src/lib/hnsw-similarity.ts` (`:142-144`), change the candidate filter to `COALESCE(pipeline_completed_at, created_at) > since`.
8. [ ] Add `dryRun?: boolean` to the skill input. A dry run finds clusters, asks the LLM for each merge decision, writes the planned merges to `skills_log`, and writes nothing else: no capture, no link move, no soft-delete, no watermark. Pass `input.dryRun` through the `memory-consolidation` case in `packages/workers/src/jobs/skill-execution.ts`.
9. [ ] Replace the bare `catch` at `:670` with `this.sendNotification(...)` where the direct Pushover send still exists.
10. [ ] At the end of `run`, report `ok = (totalErrors === 0)` for source `memory-consolidation` through the Part 1 Phase 3 heartbeat helper, unless the skill already reports.
11. [ ] Correct the comment at `memory-consolidation-query.ts:155-157`: `findSimilarPairs` propagates errors.
12. [ ] Create the real-database test `integration/memory-consolidation.test.ts`. Seed three `complete` captures o1, o2, o3 with identical embeddings, captures X and Y, `entity_links` on the originals, and associations `(o1,o2)`, `(o1,X)`, `(o2,X)`, `(Y,o3)`. Stub the LLM to return `should_merge: true`. Stub `fetch` so the POST inserts a real `captures` row and the DELETE soft-deletes the row.
13. [ ] Assert in that test: exactly one `source = 'consolidation'` capture exists; all three originals have `deleted_at` set; the entity links are on the new capture; no association references an original and `(o1,o2)` is gone; `(new,X)` has the summed count and the maximum weight, and `(Y,new)` exists; `totalMerged = 1`, `totalErrors = 0`, and the watermark advanced. With a failure injected into the transaction: no original is deleted, no association changes, the merged capture is soft-deleted, and the watermark did not advance. A second run creates nothing. A capture created before the watermark and completed after the watermark is a candidate. A `dryRun` writes only a `skills_log` row.
14. [ ] Update the mocked unit test for `db.transaction` and the removed `catch` blocks. Delete the temporary exemption from `uuid-array-guard.test.ts`.
15. [ ] In `CLAUDE.md`, update the `pgUuidArray` bullet (the helper now covers every site in `memory-consolidation.ts`) and add the grouped-rewrite rule, the watermark rule, and `dryRun`.
16. [ ] Host (owner), after the deploy and after Part 1 item 1.2 has finished: take a backup; trigger one run with `{"dryRun": true}` through `POST /api/v1/skills/memory-consolidation/trigger` and read the planned merges in `skills_log`; then delete the keys `memory_consolidation_last_scan_at` and `capture_dedup_last_scan_at` from `app_settings` once, so the re-embedded captures become candidates.

**Acceptance Criteria:**
- [ ] WHEN a cluster is merged THEN the skill SHALL create one `source = 'consolidation'` capture, move the entity links, rewrite the associations, and soft-delete every original inside one transaction.
- [ ] WHEN any statement in the merge transaction fails THEN no original SHALL be soft-deleted, no association SHALL change, the merged capture SHALL be soft-deleted, and the watermark SHALL NOT advance.
- [ ] WHEN two merged originals share a neighbour X THEN the pair `(merged, X)` SHALL hold the summed `co_access_count` and the maximum `weight`.
- [ ] WHEN the skill runs with `dryRun: true` THEN the skill SHALL write a `skills_log` row and nothing else.
- [ ] WHEN a capture was created before the watermark and embedded after the watermark THEN the capture SHALL be a candidate.
- [ ] WHEN the skill runs a second time on the merged result THEN the skill SHALL create nothing.
- [ ] `docker compose -f docker-compose.test.yml up -d --wait && pnpm --filter @open-brain/workers exec vitest run --config vitest.config.integration.ts src/__tests__/integration/memory-consolidation.test.ts` exits 0.
- [ ] `grep -nE '\$\{(captureIds|originalIds)\}::uuid' packages/workers/src/skills/memory-consolidation.ts` prints nothing.
- [ ] The first production run used `dryRun`, and both watermark keys were reset once after Part 1 item 1.2.

**Notes:**
Cross-plan prerequisite: Part 1 item 1.2 before the watermark reset. This item ships whole or not at all. Fixing only the first cast makes the skill create merged captures without deleting the originals, which is one duplicate per cluster per week. If the item cannot ship whole, disable the cron instead (`memoryConsolidationCron` in `packages/workers/src/scheduler.ts`, slot `0 4 * * 0`, with the JSDoc block and `scheduler-slots.test.ts` updated) and merge nothing from this item. Preserved: canonical `a < b` pair ordering, `source = 'consolidation'`, the gate at `assist`, `maxClusters = 5`, and the ADR-0003 probe. Originals are soft-deleted and recoverable. Host fact: no capture has been embedded since 2026-07-31, so the candidate set stays empty until Part 1 item 1.2 re-embeds; with the old `created_at` filter those captures would never become candidates. The dedup sweep shares the candidate filter, which is why both watermark keys are reset.

---

### Phase 11 Testing Requirements

- [ ] The filtered-recall test runs the same search 8 times on one connection and asserts 10 rows each time.
- [ ] Migration `0038` passes the two-database parity check (`scripts/validate-init-schema.sh`).
- [ ] The co-access boost has a real-database test on the read path and on the out-of-order write.
- [ ] Every workers module that calls `.execute(` has a smoke call against Postgres.
- [ ] The consolidation real-database test holds every assertion listed in item 11.6, including the injected failure.
- [ ] New code has more than 80% test coverage.
- [ ] Core-api and workers integration tests pass.

### Phase 11 Completion Checklist

- [ ] All work items complete
- [ ] All tests passing
- [ ] Coverage gates still green (thresholds never lowered)
- [ ] `LAB_NOTEBOOK.md` entry holds the results; Decision Log and Action Items updated
- [ ] CLAUDE.md and memory updated with any non-trivial learning (`hnsw.iterative_scan`, the co-access weight formula, the consolidation rules, the uuid-array guard)
- [ ] Deployed through `scripts/deploy.sh` (core-api, workers) and verified in the running container (grep a marker, for example `docker exec open-brain-core-api sh -c 'grep -rlF "hnsw.iterative_scan" /app | head -1'`)
- [ ] Migration `0038` applied on the host after `0037`; `scripts/init-schema.sql` regenerated, never hand-edited
- [ ] First consolidation run on the host was a dry run; both watermark keys reset once
- [ ] No regressions introduced

### Definition of Done (Runnable)
<!-- BEGIN DOD -->

| Check | Command | Pass Criteria |
|-------|---------|---------------|
| Tests and coverage gates | `pnpm -r test` | Exit code 0 |
| Lint and types | `pnpm -r lint` | Exit code 0 |
| Schema parity | `bash scripts/validate-init-schema.sh` | Exit code 0 |
| Core-api integration | `pnpm test:integration` | Exit code 0 |
| Workers integration (SQL smoke, effect tests, consolidation) | `docker compose -f docker-compose.test.yml up -d --wait && pnpm --filter @open-brain/workers test:integration; rc=$?; docker compose -f docker-compose.test.yml down -v; exit $rc` | Exit code 0 |
| No raw uuid-array cast in consolidation | `! grep -nF -e '${captureIds}::uuid' -e '${originalIds}::uuid' packages/workers/src/skills/memory-consolidation.ts` | Exit code 0 |

<!-- END DOD -->

---

## Phase 12: LLM gateway core

**Estimated Complexity:** M (~14 files, ~1,280 LOC)
**Dependencies:** Part 1 Phase 5
**Execution Mode:** Sequential

### Goals

- One classifier decides which errors fall back, and Anthropic calls honour the tier timeout.
- At the hard limit the gateway blocks every paid tier and never blocks a free tier.
- A dead tier is skipped after two failures instead of costing a full timeout on every call.
- A fallback keeps JSON mode, and `t2_quality` degrades to `t1_fast` instead of failing.

### Work Items

#### 12.1 One error classifier; honest timeouts
**Status: PENDING**
**Model Tier: sonnet**
**Requirement Refs:** SE7-10, SE7-19, INT-012 (404 part) (investigation 05, item FB1)
**Files Affected:**
- `LAB_NOTEBOOK.md` (modify)
- `packages/shared/src/services/llm-errors.ts` (create)
- `packages/shared/src/services/__tests__/llm-errors.test.ts` (create)
- `packages/shared/src/services/llm-gateway.ts` (modify)
- `packages/shared/src/services/run-agent.ts` (modify)
- `config/ai-routing.yaml` (modify)
- `packages/shared/src/services/__tests__/llm-gateway.test.ts` (modify)
- `packages/shared/src/services/__tests__/run-agent.test.ts` (modify)

**Description:**
`shouldAttemptFallback` (`llm-gateway.ts:766`) and `isTransientAgentError` (`run-agent.ts:26`) are two hand-written regex
classifiers. The bare pattern `429|50\d` matches digits inside a model name such as `20250929`, `run-agent` misses
`APIConnectionError` and status 500, and a 404 for a retired model never falls back. `completeViaAnthropic` and the two
`messages.create` calls in `runAgent` pass no timeout, so the tier's `timeout_ms` is ignored. This item adds one classifier used
at both call sites and passes the tier timeout to Anthropic, after raising the two Anthropic tier values.

**Tasks:**
1. [ ] Add a `LAB_NOTEBOOK.md` entry for Phases 12 and 13 before the first commit. Objective: one classifier, a budget limit that blocks paid calls only, one threshold source, a circuit breaker, constraint-preserving fallback. Hypothesis: at $999 of recorded spend a paid tier makes zero calls and a cost-0 tier proceeds; two timeouts on a tier skip the tier for 10 minutes. Rollback: `git revert` per item; raise `failure_threshold` in `config/ai-routing.yaml` to switch the breaker off; redeploy the previous commit with `scripts/deploy.sh <previous sha>`.
2. [ ] Create `packages/shared/src/services/llm-errors.ts` with `classifyLlmError(err, opts?: { abortSignal?: AbortSignal })` returning `'transient' | 'model_unavailable' | 'client'`. Decide in this order: the caller's signal is aborted or the error is `APIUserAbortError` → `client`; `instanceof` the Anthropic or OpenAI `APIConnectionError` or `APIConnectionTimeoutError` → `transient`; `status` 408, 429, or 500 and above (including 529) → `transient`; status 404 that names a model (Anthropic error type `not_found_error`, OpenAI error code `model_not_found`) → `model_unavailable`; `err.cause.code` in `ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `ENOTFOUND`, `EAI_AGAIN` → `transient`; last, a `\b`-anchored regex on the message (`rate limit`, `overloaded`, `timed out`, `timeout`, `connection error`, `socket hang up`, `fetch failed`) → `transient`; everything else, including 400 and 401, → `client`.
3. [ ] In the same module add `setModelUnavailableHandler(fn)` and `reportModelUnavailable({ model, tierKey })`. `reportModelUnavailable` writes one `error` log line per model per process and calls the registered handler once per model per process.
4. [ ] In `llm-gateway.ts`, make `shouldAttemptFallback` return `classifyLlmError(err) !== 'client'` and delete the regex. Call `reportModelUnavailable` when the class is `model_unavailable`.
5. [ ] In `run-agent.ts`, replace `isTransientAgentError` with the classifier. A `model_unavailable` error swaps to `resolution.fallback()` the same way a `transient` error does and calls `reportModelUnavailable`.
6. [ ] In `config/ai-routing.yaml`, set `t1_fast.timeout_ms: 60000` and `t2_quality.timeout_ms: 180000`. Do this before task 7.
7. [ ] Pass `{ timeout: timeoutMs }` in the request options of `anthropic.messages.create`: in `completeViaAnthropic` (add a `timeoutMs` parameter fed from the resolved tier) and at `run-agent.ts:337` and `:382` (from `resolution.timeoutMs` when a resolver is present), beside the existing `signal`.
8. [ ] Create `llm-errors.test.ts` with a table of real SDK error objects: `APIConnectionError`, `APIConnectionTimeoutError`, status 500, status 529, a 404 with a model `not_found_error`, a 400 whose message contains "429", a 401 whose message contains "5042", and a caller abort.
9. [ ] Extend the gateway and `runAgent` tests: a 404 for a model falls back and reports once; a 400 does not fall back; the Anthropic request carries the tier timeout.

**Acceptance Criteria:**
- [ ] WHEN an LLM call fails with a connection error, a timeout, or status 408, 429, or 500 and above THEN the gateway and `runAgent` SHALL fall back to the next tier.
- [ ] WHEN an LLM call fails with status 400 or 401 THEN neither the gateway nor `runAgent` SHALL fall back, also when the message text contains digits such as "429" or "5042".
- [ ] WHEN a 404 names a model that does not exist THEN the gateway SHALL fall back and SHALL report `model_unavailable` once per model per process.
- [ ] WHEN the gateway or `runAgent` calls Anthropic through a resolved tier THEN the request SHALL carry that tier's `timeout_ms`.
- [ ] `config/ai-routing.yaml` sets `t1_fast.timeout_ms: 60000` and `t2_quality.timeout_ms: 180000`.
- [ ] `pnpm --filter @open-brain/shared test -- llm-errors llm-gateway run-agent` exits 0.

**Notes:**
The configured Anthropic tier timeouts are 20 seconds (`t1_fast`) and 30 seconds (`t2_quality`). Passing those values would cut long agent loops: monthly-reflection needed more than 60 seconds (LAB_NOTEBOOK Entry 180). Raise first, then pass. The client-level settings stay: `workers` uses `maxRetries: 0`, core-api uses `maxRetries: 2`. Both installed SDKs (`@anthropic-ai/sdk` 0.39.0, `openai` 4.104.0) export `APIConnectionError`, `APIConnectionTimeoutError`, and `APIUserAbortError`. Item 12.2 exports the new module from `services/index.ts`; item 13.1 registers the handler in `workers`. The circuit breaker in item 12.3 uses the same classifier.

---

#### 12.2 Budget guard in the gateway
**Status: PENDING**
**Model Tier: opus**
**Requirement Refs:** SA7-01, SE7-02, INT-011 (investigation 05, item B1)
**Depends On:** 12.1
**Files Affected:**
- `packages/shared/src/services/budget-guard.ts` (create)
- `packages/shared/src/services/__tests__/budget-guard.test.ts` (create)
- `packages/shared/src/services/llm-gateway.ts` (modify)
- `packages/shared/src/services/index.ts` (modify)
- `packages/shared/src/services/__tests__/llm-gateway.test.ts` (modify)
- `packages/core-api/src/__tests__/llm-gateway.test.ts` (modify)

**Description:**
`checkBudget` returns early for the `anthropic` and `ollama` clients, so the hard limit blocks only the cost-0 `openai_compat`
tiers (Jetson, Spark) and never a paid Anthropic call. A spend-query error is read as $0, and the check runs before the `try`,
so a blocked free tier cannot fall back. This item adds `budget-guard.ts`, which identifies a paid tier by its cost fields, and
runs the check on every fallback hop.

**Tasks:**
1. [ ] Create `packages/shared/src/services/budget-guard.ts`. `isPaidTier(tier)` is true when `cost_per_1k_input > 0` or `cost_per_1k_output > 0`. Do not use `PAID_PROVIDERS`: that set contains `openai_compat`.
2. [ ] In the same module, `getMonthlySpend(db)` returns `SUM(cost_usd)` from `ai_audit_log` where `error IS NULL` and `created_at` is on or after the first day of the month. The function throws on a query error.
3. [ ] In the same module, `createBudgetGuard({ db, getLimits })` returns `check()` (`{ monthlySpend, action: 'normal' | 'throttled' | 'paused' }`) and `assertPaidAllowed()`. Cache the spend for 60 seconds in the process. When the spend query throws, `assertPaidAllowed` throws `LLMBudgetExceededError` and `check` returns `paused`.
4. [ ] Export `budget-guard.ts` and `llm-errors.ts` from `packages/shared/src/services/index.ts`.
5. [ ] In `llm-gateway.ts`, change `checkBudget` to take the tier: return at once when `!isPaidTier(tier)`, otherwise call `assertPaidAllowed()`. Run the check for each hop inside `completeWithTierFallback`, so a blocked paid hop ends the chain with `LLMBudgetExceededError` and a free hop is never blocked. The limits come from `configService.get('ai').monthly_budget`.
6. [ ] Add `async prepareAgentRun(taskName)` to the gateway: resolve the task's tier, run the budget check for that tier, and return `resolveAgentClient(taskName)`.
7. [ ] Keep the gateway's public `getMonthlySpend()` (the `LLM_SPEND_URL` path) for reporting callers. The guard reads `ai_audit_log` only.
8. [ ] Add tests to the shared `llm-gateway.test.ts` and update the core-api copy for the new rule: "paid anthropic tier throws at spend ≥ hard"; "cost-0 openai_compat tier proceeds at $999"; "free tier fails → paid hop blocked, zero anthropic calls"; "spend query error: paid fails closed, free proceeds".
9. [ ] Add `budget-guard.test.ts`: the 60-second cache, the month boundary, and `isPaidTier` for a cost-0 `openai_compat` tier, a tier with undefined costs, and a paid tier.

**Acceptance Criteria:**
- [ ] WHEN recorded monthly spend is at or above `hard_limit_usd` THEN the gateway SHALL throw `LLMBudgetExceededError` for every tier with a non-zero cost field and SHALL make no call to that tier.
- [ ] WHEN both cost fields of a tier are 0 or absent THEN the gateway SHALL call the tier at any spend level.
- [ ] WHEN a free tier fails and the next hop is a paid tier at the hard limit THEN the gateway SHALL make zero paid calls.
- [ ] WHEN the spend query fails THEN paid calls SHALL be blocked and free calls SHALL proceed.
- [ ] WHEN free-tier calls run back to back THEN the guard SHALL issue no spend query for them.
- [ ] `pnpm --filter @open-brain/shared test -- budget-guard llm-gateway` exits 0.
- [ ] `pnpm --filter @open-brain/core-api exec vitest run src/__tests__/llm-gateway.test.ts` exits 0.

**Notes:**
`config/ai-routing.yaml` ($20 soft, $35 hard) is the single source of the thresholds. Free tiers are never blocked. A spend-query error fails closed for paid calls only. Audit writes never throw. Live paid spend through the gateway is $0.44 to $0.61 per month with Spark down, so the realistic loss today is small; the defect is that the limit blocks the wrong tiers. Items 13.1, 13.2, and 13.3 put the remaining paid callers behind the guard.

---

#### 12.3 Skip a dead tier instead of waiting for its timeout
**Status: PENDING**
**Model Tier: sonnet**
**Requirement Refs:** Live finding L6 (investigation 05, item TH2)
**Depends On:** 12.1, 12.2
**Files Affected:**
- `packages/shared/src/services/llm-gateway.ts` (modify)
- `packages/shared/src/types/config.ts` (modify)
- `config/ai-routing.yaml` (modify)
- `packages/shared/src/services/__tests__/llm-gateway.test.ts` (modify)
- `packages/shared/src/types/__tests__/config-tiers.test.ts` (modify)

**Description:**
The gateway decides fallback per call and keeps no memory of tier state. Spark's `timeout_ms` is 120 000 and every Spark call
timed out in November, so each capture's entity extraction and commitment extraction waited 120 seconds before falling back, and
interactive synthesis waited 120 seconds behind a 30-second proxy. This item adds a per-tier circuit breaker inside the process:
after 2 transient failures the gateway skips the tier for 10 minutes, then lets one call through.

**Tasks:**
1. [ ] In `packages/shared/src/types/config.ts` (`ModelTierEntrySchema`), add optional `circuit_breaker: { failure_threshold: z.number().int().min(1), cooldown_ms: z.number().int().min(1000) }`.
2. [ ] In `config/ai-routing.yaml`, add `circuit_breaker: { failure_threshold: 2, cooldown_ms: 600000 }` to `t1_spark`. Leave `t1_spark.timeout_ms` at 120000. A tier without the block has no breaker.
3. [ ] In `llm-gateway.ts`, keep a `Map` from tier key to `{ failures, openedAt }`. In `completeWithTierFallback`, when the breaker of the tier is open and inside the cooldown, write one audit row with error `circuit_open` and go to `tier.fallback` without calling the tier. The budget check of item 12.2 still runs for the fallback hop.
4. [ ] Count a failure only when `classifyLlmError` returns `transient` and `isModelLoadingError` is false. A success resets the count. After `cooldown_ms`, send one call to the tier (half-open): a success closes the breaker, and a failure opens the breaker for another cooldown.
5. [ ] Read `failure_threshold` and `cooldown_ms` from the current config on each call, so `ConfigService.reload()` changes the values without a restart.
6. [ ] Add tests with fake timers: "2 timeouts → tier skipped for cooldown" (the third call sends no request to the tier and writes one `circuit_open` row); "half-open after cooldown"; "loading-model 503 doesn't trip"; an open breaker whose fallback is a paid tier at the hard limit makes zero paid calls.
7. [ ] Add a `config-tiers.test.ts` case for the new schema entry.

**Acceptance Criteria:**
- [ ] WHEN a tier with `circuit_breaker` configured returns 2 consecutive transient errors THEN the gateway SHALL skip that tier for `cooldown_ms` and SHALL call the tier's fallback directly.
- [ ] WHEN the cooldown has elapsed THEN the gateway SHALL send one call to the tier; a success SHALL close the breaker and a failure SHALL reopen the breaker.
- [ ] WHEN a tier answers with a model-loading error THEN the breaker count SHALL NOT change.
- [ ] WHEN the breaker is open and the fallback is a paid tier at the hard limit THEN the gateway SHALL make no paid call.
- [ ] WHEN a tier is skipped THEN `ai_audit_log` SHALL get one row with error `circuit_open`.
- [ ] `pnpm --filter @open-brain/shared test -- llm-gateway config-tiers` exits 0.

**Notes:**
This item comes after items 12.1 and 12.2: a breaker without the budget guard sends all Spark traffic to paid tiers with no ceiling. Cost after the change: at most 2 × 120 seconds per process per 10 minutes, instead of 120 seconds per call. The breaker state is per process; `workers` and core-api each keep their own. To switch the breaker off, raise `failure_threshold` in the YAML. Jetson's same-tier retry for "Loading model" errors is unchanged, and `t1_jetson` gets no breaker in this item: its timeout is 5 seconds, so a dead Jetson costs 5 seconds per call. Host fact: Spark is down and Jetson works. Whether Spark returns is unknown U4; the breaker makes the answer irrelevant to latency.

---

#### 12.4 Fallback keeps the task's constraints
**Status: PENDING**
**Model Tier: sonnet**
**Requirement Refs:** SA7-06, SA7-16 (investigation 05, item FB2)
**Depends On:** 12.1, 12.2
**Files Affected:**
- `packages/shared/src/services/llm-gateway.ts` (modify)
- `config/ai-routing.yaml` (modify)
- `packages/shared/src/services/__tests__/llm-gateway.test.ts` (modify)

**Description:**
`completeViaAnthropic` drops `jsonMode`, so a JSON-mode task that falls back from Spark to Haiku gets prose; the parsers strip
code fences, and the result is a silent empty extraction. `t2_quality` has `fallback: null`, so the weekly brief and governance
fail when Sonnet is unavailable. This item adds a JSON-only system instruction on the Anthropic path and gives `t2_quality` a
`t1_fast` fallback with a cycle guard.

**Tasks:**
1. [ ] In `completeViaAnthropic`, when `options.jsonMode` is true, add a `system` instruction: respond with exactly one JSON object and no other text.
2. [ ] In `config/ai-routing.yaml`, set `t2_quality.fallback: t1_fast`. Rewrite the JSON-mode comment block (`:187-197`): an Anthropic tier receives a JSON-only instruction on fallback. Remove the "No fallback" sentence from the `t2_quality` comment.
3. [ ] In `completeWithTierFallback`, carry a `Set` of visited tier keys through the recursion and stop when the next tier is already in the set.
4. [ ] Add tests: "jsonMode on anthropic adds instruction"; "no t2↔t1 cycle" (`t2_quality` fails, `t1_fast` is tried once, and no third call follows).

**Acceptance Criteria:**
- [ ] WHEN a `jsonMode` task runs on an Anthropic tier THEN the request SHALL carry the JSON-only system instruction.
- [ ] WHEN `t2_quality` fails with a transient error THEN the gateway SHALL try `t1_fast` once and SHALL NOT return to `t2_quality`.
- [ ] `pnpm --filter @open-brain/shared test -- llm-gateway` exits 0.

**Notes:**
`t1_fast → t2_quality → t1_fast` is a cycle in the config; `MAX_FALLBACK_HOPS` (2) and the visited set bound the walk, and `computeFallbackChain` already has a visited set. Agent-loop fallback stays inside one provider (`resolveAgentClient`). Do not force JSON with an assistant prefill: `claude-sonnet-4-6`, the `t2_quality` model, rejects a prefilled last assistant turn with a 400. Both hops are paid tiers, so the budget check of item 12.2 runs for each.

---

### Phase 12 Testing Requirements

- [ ] The classifier has a table test built from real SDK error objects, including a 400 and a 401 whose text contains digits.
- [ ] The gateway tests drive spend past the hard limit in both directions: a paid tier makes zero calls, and a cost-0 tier proceeds at $999.
- [ ] The breaker tests use fake timers for open, cooldown, and half-open, and prove a model-loading error does not count.
- [ ] New code has more than 80% test coverage.
- [ ] Integration tests pass.

### Phase 12 Completion Checklist

- [ ] All work items complete
- [ ] All tests passing
- [ ] Coverage gates still green (thresholds never lowered)
- [ ] `LAB_NOTEBOOK.md` entry holds the results; Decision Log and Action Items updated
- [ ] CLAUDE.md and memory updated with any non-trivial learning (the classifier, paid tiers by cost fields, the circuit breaker, the raised Anthropic tier timeouts)
- [ ] Deployed through `scripts/deploy.sh` (core-api, workers) and verified in the running container (grep a marker, for example `docker exec open-brain-workers sh -c 'grep -rlF "circuit_open" /app | head -1'`)
- [ ] No regressions introduced

### Definition of Done (Runnable)
<!-- BEGIN DOD -->

| Check | Command | Pass Criteria |
|-------|---------|---------------|
| Tests and coverage gates | `pnpm -r test` | Exit code 0 |
| Lint and types | `pnpm -r lint` | Exit code 0 |
| Core-api integration | `pnpm test:integration` | Exit code 0 |
| Gateway, classifier, guard | `pnpm --filter @open-brain/shared test -- llm-errors budget-guard llm-gateway run-agent config-tiers` | Exit code 0 |

<!-- END DOD -->

---

## Phase 13: Budget follow-through

**Estimated Complexity:** M (~30 files, ~1,320 LOC)
**Dependencies:** Phase 12 (item 12.2)
**Execution Mode:** Sequential

### Goals

- Every agent-loop caller checks the budget before its first call and records its spend.
- The embed job and the TTS route obey the same guard: the embed job is delayed, and the TTS route answers 503.
- `config/ai-routing.yaml` is the only place that holds the budget thresholds.

### Work Items

#### 13.1 Agent-loop callers are guarded and recorded
**Status: PENDING**
**Model Tier: sonnet**
**Requirement Refs:** SE7-04, PE-015 (investigation 05, item B1)
**Depends On:** 12.2
**Files Affected:**
- `packages/workers/src/skills/wiki-ingest.ts` (modify)
- `packages/workers/src/jobs/wiki-ingest-worker.ts` (modify)
- `packages/workers/src/jobs/skill-execution.ts` (modify)
- `packages/workers/src/main.ts` (modify)
- `packages/workers/src/__tests__/wiki-ingest.test.ts` (modify)
- `packages/core-api/src/services/email-compose-assist.ts` (modify)
- `packages/core-api/src/index.ts` (modify)
- `packages/core-api/src/__tests__/email-compose-assist.test.ts` (modify)

**Description:**
Four of the five `runAgent` callers pass a direct Anthropic client and a model string, so those calls skip the budget check and
write no `ai_audit_log` row; `wiki_ingest` runs once per capture on the paid `t1_fast` tier. This item moves `WikiIngestSkill`
and core-api's `EmailComposeAssistService` to `llmGateway.prepareAgentRun(task)` plus `recordAgentCompletion`. Both callers receive
the gateway through a factory. Item 13.2 moves `wiki-lint` and `monthly-reflection`.

**Tasks:**
1. [ ] In `packages/workers/src/skills/wiki-ingest.ts`, accept `llmGateway` in the options. In `run`, call `const resolution = await this.llmGateway.prepareAgentRun('wiki_ingest')` and pass `clientResolver: () => resolution` to `runAgent` in place of `client` and `model`.
2. [ ] After the loop, call `recordAgentCompletion('wiki_ingest', resolution.tierKey, { iterations, tokenUsage, latencyMs }, agentResult.finalTierKey)`.
3. [ ] When `prepareAgentRun` throws `LLMBudgetExceededError`, throw BullMQ `UnrecoverableError` from the wiki-ingest job.
4. [ ] Pass `llmGateway` through `createWikiIngestWorker` (`packages/workers/src/jobs/wiki-ingest-worker.ts`), through the `wiki-ingest` case of `packages/workers/src/jobs/skill-execution.ts`, and from `packages/workers/src/main.ts` where `createWikiIngestWorker` is called.
5. [ ] In `packages/core-api/src/services/email-compose-assist.ts`, take `llmGateway` in the constructor. `compose` uses `prepareAgentRun('email_compose')` and `recordAgentCompletion`. At the hard limit, throw `ServiceUnavailableError`, which the route already maps to 503. In `packages/core-api/src/index.ts`, construct the service after `llmGateway` and pass `llmGateway`.
6. [ ] In `packages/workers/src/main.ts`, call `setModelUnavailableHandler` (item 12.1) once at startup. The handler raises one warning alert per model with key `model-unavailable:<model>` through the Part 1 Phase 2 alert-state helper.
7. [ ] Add to `wiki-ingest.test.ts`: "hard limit: messages.create never called" and "records agent spend" (one audit row with a non-zero cost). Add to `email-compose-assist.test.ts`: the resolver path and the 503 at the hard limit.

**Acceptance Criteria:**
- [ ] WHEN monthly spend is at the hard limit THEN `WikiIngestSkill` and `EmailComposeAssistService` SHALL make no Anthropic call.
- [ ] WHEN an agent loop finishes THEN one `ai_audit_log` row SHALL record the loop's tokens and cost for the task.
- [ ] WHEN the wiki-ingest job is blocked by the budget THEN the job SHALL fail as unrecoverable and the capture's `ingest-root` job SHALL still run.
- [ ] WHEN a retired model is reported in `workers` THEN `workers` SHALL raise one alert for that model.
- [ ] `pnpm --filter @open-brain/workers exec vitest run src/__tests__/wiki-ingest.test.ts` exits 0.
- [ ] `pnpm --filter @open-brain/core-api exec vitest run src/__tests__/email-compose-assist.test.ts` exits 0.

**Notes:**
The fifth caller, `email-compose` in `workers`, already uses the resolver. The resolver path also gives both callers the fallback rules of item 12.1; agent fallback stays inside one provider. The wiki-ingest flow child is `removeDependencyOnFailure`, so an unrecoverable failure does not block the root job. `wiki_ingest` stays one paid call per capture; this item makes that spend visible and bounded, and does not change the per-capture design. core-api registers no handler and keeps the default error log; every tier core-api calls is also called from `workers`.

---

#### 13.2 Agent-loop skills dispatched by skill-execution are guarded and recorded
**Status: PENDING**
**Model Tier: sonnet**
**Requirement Refs:** SE7-04, PE-015 (investigation 05, item B1)
**Depends On:** 12.2, 13.1
**Files Affected:**
- `packages/workers/src/skills/wiki-lint.ts` (modify)
- `packages/workers/src/skills/monthly-reflection.ts` (modify)
- `packages/workers/src/jobs/skill-execution.ts` (modify)
- `packages/workers/src/__tests__/wiki-lint.test.ts` (modify)
- `packages/workers/src/__tests__/monthly-reflection.test.ts` (modify)

**Description:**
`WikiLintSkill` and `MonthlyReflectionSkill` call `runAgent` with a direct Anthropic client, so both skip the budget check and
record no spend. The `skill-execution` dispatcher already holds `opts.llmGateway`. This item passes the gateway to both skills
and moves both to `prepareAgentRun` plus `recordAgentCompletion`, the pattern item 13.1 uses for `WikiIngestSkill`.

**Tasks:**
1. [ ] In `packages/workers/src/skills/wiki-lint.ts` (`runAgent` call at `:145`), use `prepareAgentRun('wiki_lint')` as the `clientResolver` and call `recordAgentCompletion` after the loop.
2. [ ] In `packages/workers/src/skills/monthly-reflection.ts` (`runAgent` call at `:369`), do the same with `'monthly_reflection'`.
3. [ ] In `packages/workers/src/jobs/skill-execution.ts`, pass `llmGateway: opts.llmGateway` in the `wiki-lint` and `monthly-reflection` cases.
4. [ ] At the hard limit, both skills throw `UnrecoverableError`.
5. [ ] Add to each test file: "hard limit: messages.create never called" and "records agent spend".

**Acceptance Criteria:**
- [ ] WHEN monthly spend is at the hard limit THEN `wiki-lint` and `monthly-reflection` SHALL make no Anthropic call and the job SHALL fail as unrecoverable.
- [ ] WHEN either skill finishes THEN one `ai_audit_log` row SHALL record the loop's tokens and cost.
- [ ] `grep -rnE "client: .*anthropicClient" packages/workers/src/skills packages/core-api/src/services` prints nothing.
- [ ] `pnpm --filter @open-brain/workers exec vitest run src/__tests__/wiki-lint.test.ts src/__tests__/monthly-reflection.test.ts` exits 0.

**Notes:**
This item holds the part of item 13.1 that did not fit in eight files: item 13.1 covers the two callers that receive the gateway through a factory, and this item covers the two callers the dispatcher constructs. Both tasks route to Anthropic tiers (`wiki_lint: t1_fast`, `monthly_reflection: t2_quality`). The `assist` gate of monthly-reflection is unchanged.

---

#### 13.3 Embeddings and TTS obey the guard; one threshold source
**Status: PENDING**
**Model Tier: sonnet**
**Requirement Refs:** SE7-05, SA7-01 (investigation 05, item B1)
**Depends On:** 12.2
**Files Affected:**
- `packages/workers/src/jobs/embed-capture.ts` (modify)
- `packages/workers/src/lib/spend-tracker.ts` (modify)
- `packages/workers/src/main.ts` (modify)
- `packages/workers/src/__tests__/embed-rate-limit.test.ts` (modify)
- `packages/workers/src/__tests__/spend-tracker.test.ts` (modify)
- `packages/core-api/src/routes/briefs.ts` (modify)
- `packages/core-api/src/index.ts` (modify)
- `packages/core-api/src/__tests__/brief-tts.test.ts` (modify)

**Description:**
The budget thresholds exist in six copies: `config/ai-routing.yaml` ($20/$35), the zod defaults ($30/$50), the `budget-check`
env defaults ($30/$50), `SpendTracker` ($7/$10, with Anthropic spend excluded), `system-health` ($7/$10), and the Prometheus rule
($24/$50). The embed job and the TTS route do not use the gateway check. This item makes the embed job and the TTS route read the
guard from item 12.2 with the config thresholds. Items 13.4 and 13.5 remove the remaining copies.

**Tasks:**
1. [ ] In `packages/workers/src/lib/spend-tracker.ts`, delete `DEFAULT_SOFT_LIMIT`, `DEFAULT_HARD_LIMIT`, the `BUDGET_*_NON_CLAUDE` env reads, the token-based estimate, and the `client_used != 'anthropic'` filter. `SpendTracker.check()` returns the result of the shared guard's `check()`.
2. [ ] In `packages/workers/src/main.ts`, construct `SpendTracker` after `configService` and give `SpendTracker` a guard built with `getLimits: () => configService.get('ai').monthly_budget`.
3. [ ] In `packages/workers/src/jobs/embed-capture.ts`, keep `job.moveToDelayed` followed by `DelayedError` for the `paused` action. No budget block throws a plain error. Update the log text to "paid spend at hard limit".
4. [ ] In `packages/core-api/src/routes/briefs.ts` (audio route), call the guard before the TTS `fetch`. At the hard limit, return HTTP 503 with code `BUDGET_EXCEEDED`. Serve cached audio without the check. Write the spend row through `recordSpend` in place of the direct `ai_audit_log` insert.
5. [ ] In `packages/core-api/src/index.ts`, add the guard to `ttsDeps`.
6. [ ] Update the three test files: "hard limit → moveToDelayed, not failed"; the thresholds come from config, Anthropic spend counts, and a query error returns `paused`; "TTS 503 at hard limit" with cached audio still served.

**Acceptance Criteria:**
- [ ] WHEN monthly spend is at or above the hard limit THEN the embed job SHALL move to delayed and SHALL NOT fail.
- [ ] WHEN monthly spend is at or above the hard limit THEN `POST /api/v1/briefs/:id/audio` SHALL return 503 with code `BUDGET_EXCEEDED`, unless the audio is cached.
- [ ] WHEN `SpendTracker` computes spend THEN Anthropic rows SHALL be included and the limits SHALL equal `monthly_budget` in `config/ai-routing.yaml`.
- [ ] WHEN the spend query fails THEN the embed job SHALL be delayed.
- [ ] `pnpm --filter @open-brain/workers exec vitest run src/__tests__/embed-rate-limit.test.ts src/__tests__/spend-tracker.test.ts` exits 0.
- [ ] `pnpm --filter @open-brain/core-api exec vitest run src/__tests__/brief-tts.test.ts` exits 0.
- [ ] `pnpm --filter @open-brain/workers test` exits 0.

**Notes:**
The embed job is delayed and never failed: the embed child is `failParentOnFailure`, so a failed embed fails the whole flow. Query-time embedding (the query vector for a search) stays exempt, because hybrid search throws without the vector. The soft limit keeps the 30-second throttle between embed jobs. `src/lib/spend-tracker.ts` has a per-file 100% coverage lock; the last acceptance command runs the gate. Voice classification and slack-bot intent spend are not recorded today; both are low-volume calls started by a person, and recording them is outside this plan.

---

#### 13.4 Budget job, health page, and schema read the config thresholds
**Status: PENDING**
**Model Tier: sonnet**
**Requirement Refs:** SE7-05, SA7-01 (investigation 05, item B1)
**Depends On:** 12.2, 13.3
**Files Affected:**
- `packages/workers/src/jobs/budget-check.ts` (modify)
- `packages/workers/src/main.ts` (modify)
- `packages/workers/src/__tests__/budget-check.test.ts` (modify)
- `packages/core-api/src/services/system-health.ts` (modify)
- `packages/core-api/src/index.ts` (modify)
- `packages/core-api/src/__tests__/system-health.test.ts` (modify)
- `packages/shared/src/types/config.ts` (modify)
- `packages/shared/src/types/__tests__/config-tiers.test.ts` (modify)

**Description:**
`budget-check` alerts at env defaults of $30 and $50 and estimates spend at $1 per million tokens. `system-health` reports spend
against $7 and $10 constants. The zod schema fills a missing `monthly_budget` with $30 and $50. This item makes the budget job and
the health service read `monthly_budget` from `config/ai-routing.yaml` and the shared `getMonthlySpend`, and makes both schema
fields required.

**Tasks:**
1. [ ] In `packages/workers/src/jobs/budget-check.ts`, delete `DEFAULT_SOFT_LIMIT`, `DEFAULT_HARD_LIMIT`, and the `BUDGET_SOFT_LIMIT` and `BUDGET_HARD_LIMIT` env reads. Require `softLimit` and `hardLimit` in the worker options. Replace the token estimate (`:261`) with the shared `getMonthlySpend(db)`. Build the alert text (`:305-306`) from the configured values.
2. [ ] In `packages/workers/src/main.ts`, pass `softLimit` and `hardLimit` from `configService.get('ai').monthly_budget` to `createBudgetCheckWorker`.
3. [ ] In `packages/core-api/src/services/system-health.ts` (`:137-138`), delete `SPEND_WARNING` and `SPEND_CRITICAL`. `getMonthlySpend()` sets the status by comparing total paid spend with the configured soft and hard limits. Keep the response fields. In `packages/core-api/src/index.ts`, pass the limits to `SystemHealthService`.
4. [ ] In `packages/shared/src/types/config.ts`, change `monthly_budget` to `soft_limit_usd: z.number()` and `hard_limit_usd: z.number()` with no defaults.
5. [ ] Update the three test files: "uses cost_usd and ai-routing thresholds"; the health status changes at the configured limits; a config without `monthly_budget` is rejected.

**Acceptance Criteria:**
- [ ] WHEN `budget-check` runs THEN the job SHALL compare `SUM(cost_usd)` with `monthly_budget.soft_limit_usd` and `monthly_budget.hard_limit_usd` from `config/ai-routing.yaml`.
- [ ] WHEN `GET /api/v1/system/health` runs THEN the spend status SHALL use the same two limits.
- [ ] WHEN `ai-routing.yaml` has no `monthly_budget` block THEN `ConfigService.load()` SHALL throw.
- [ ] `grep -rnE "DEFAULT_(SOFT|HARD)_LIMIT|SPEND_(WARNING|CRITICAL)|BUDGET_(SOFT|HARD)_LIMIT" packages/workers/src packages/core-api/src packages/shared/src --include=*.ts | grep -v __tests__` prints nothing.
- [ ] `pnpm --filter @open-brain/workers exec vitest run src/__tests__/budget-check.test.ts` exits 0.
- [ ] `pnpm --filter @open-brain/core-api exec vitest run src/__tests__/system-health.test.ts` exits 0.
- [ ] `pnpm --filter @open-brain/shared test -- config-tiers` exits 0.

**Notes:**
This item holds the part of item 13.3 that did not fit in eight files: the two readers and the schema default. Part 1 Phase 2 moves the budget alert onto alert state; this item changes only where the two numbers come from. The optional `LLM_SPEND_URL` source of the budget job stays. Two test files build an AI config with tiers and no `monthly_budget` (`email-compose.test.ts`, `email-compose-fault-injection.test.ts`); both pass plain objects and do not parse the schema.

---

#### 13.5 Budget alert rule and documents state the config values
**Status: PENDING**
**Model Tier: sonnet**
**Requirement Refs:** SE7-05 (investigation 05, item B1)
**Depends On:** 13.4
**Files Affected:**
- `config/prometheus/alerts/budget.yml` (modify)
- `packages/core-api/src/__tests__/budget-rule-parity.test.ts` (create)
- `README.md` (modify)
- `CLAUDE.md` (modify)
- `config/ai-routing.yaml` (modify)
- `docs/runbooks/budget-alert.md` (modify)

**Description:**
The Prometheus rules fire at $24 and $50 and name a "$30 soft limit". `README.md:115` and `CLAUDE.md:364` state $30 and $50. The
comment block in `config/ai-routing.yaml` (`:265-279`) describes the old rule. The enforced values are $20 soft and $35 hard.
This item sets the rule thresholds to 16 (80% of soft) and 35, adds a parity test between the rule file and `monthly_budget`, and
corrects the three documents.

**Tasks:**
1. [ ] In `config/prometheus/alerts/budget.yml`, set `BudgetAt80Percent` to `openbrain_budget_spent_usd >= 16` with summary text "$20 soft limit", and `BudgetHardCap` to `>= 35` with description text "$35 hard limit".
2. [ ] Create `packages/core-api/src/__tests__/budget-rule-parity.test.ts`: parse `config/ai-routing.yaml` and `config/prometheus/alerts/budget.yml` with `js-yaml`; assert the `BudgetAt80Percent` threshold equals `0.8 × soft_limit_usd` and the `BudgetHardCap` threshold equals `hard_limit_usd`. The test is named "budget.yml exprs equal monthly_budget".
3. [ ] `README.md:115`: soft $20 per month (alert), hard $35 (paid tiers blocked).
4. [ ] `CLAUDE.md:364`: soft $20 alert, hard $35 limit on paid tiers; free tiers are never blocked.
5. [ ] `config/ai-routing.yaml` (`:265-279`): rewrite the comment. A paid tier is a tier with a non-zero cost field; a free tier is never blocked; a failed spend query blocks paid calls.
6. [ ] `docs/runbooks/budget-alert.md`: the two thresholds, and the procedure to lift the block (raise `hard_limit_usd`, then reload or restart).
7. [ ] Host (owner): the running Prometheus reads `/mnt/user/appdata/observability/config/prometheus/alerts`, which belongs to a separate project. Back up the deployed `budget.yml`, copy the new file, reload Prometheus, and confirm through the rules API that `BudgetHardCap` shows `>= 35`.

**Acceptance Criteria:**
- [ ] WHEN `monthly_budget` changes in `config/ai-routing.yaml` and the rule file does not THEN the parity test SHALL fail.
- [ ] `grep -nE '\$30|\$50' README.md CLAUDE.md config/prometheus/alerts/budget.yml docs/runbooks/budget-alert.md` prints nothing.
- [ ] `bash scripts/validate-alert-rules.sh` exits 0.
- [ ] `pnpm --filter @open-brain/core-api exec vitest run src/__tests__/budget-rule-parity.test.ts` exits 0.
- [ ] Host: the Prometheus rules API shows both new thresholds.

**Notes:**
This item holds the part of item 13.3 that did not fit in eight files: the rule and the documents. Rules under `config/prometheus/alerts/` are not deployed from this repository (see the header comment of `budget.yml`), so the host copy in task 7 is required. After items 13.3, 13.4, and 13.5 the six threshold copies are one.

---

### Phase 13 Testing Requirements

- [ ] Each of the four moved agent-loop callers has a "hard limit: no Anthropic call" test and a "records agent spend" test.
- [ ] The embed job has a test in which the hard limit delays the job and does not fail the job, and the audio route has a test for the 503 at the hard limit.
- [ ] `src/lib/spend-tracker.ts` keeps 100% line and function coverage.
- [ ] A parity test compares the thresholds in `config/prometheus/alerts/budget.yml` with `monthly_budget`.
- [ ] New code has more than 80% test coverage.
- [ ] Integration tests pass.

### Phase 13 Completion Checklist

- [ ] All work items complete
- [ ] All tests passing
- [ ] Coverage gates still green (thresholds never lowered)
- [ ] The `LAB_NOTEBOOK.md` entry opened in item 12.1 covers Phases 12 and 13 and holds the Phase 13 results; Decision Log and Action Items updated
- [ ] CLAUDE.md and memory updated with any non-trivial learning (agent loops through `prepareAgentRun`, the single threshold source, the $20 and $35 values)
- [ ] Deployed through `scripts/deploy.sh` (core-api, workers) and verified in the running container (grep a marker, for example `docker exec open-brain-core-api sh -c 'grep -rlF "BUDGET_EXCEEDED" /app | head -1'`)
- [ ] Prometheus `budget.yml` copied to the observability project by the owner and reloaded
- [ ] No regressions introduced

### Definition of Done (Runnable)
<!-- BEGIN DOD -->

| Check | Command | Pass Criteria |
|-------|---------|---------------|
| Tests and coverage gates | `pnpm -r test` | Exit code 0 |
| Lint and types | `pnpm -r lint` | Exit code 0 |
| Core-api integration | `pnpm test:integration` | Exit code 0 |
| Budget rule parity | `pnpm --filter @open-brain/core-api exec vitest run src/__tests__/budget-rule-parity.test.ts` | Exit code 0 |
| Alert rules | `bash scripts/validate-alert-rules.sh` | Exit code 0 |
| No direct-client agent caller | `! grep -rnE "client: .*anthropicClient" packages/workers/src/skills packages/core-api/src/services` | Exit code 0 |

<!-- END DOD -->

---

## Phase 14: Edges: model IDs, public timeouts, Actual pin, external watchdog

**Estimated Complexity:** M (~38 files, ~1,520 LOC)
**Dependencies:** Phase 12 (14.2 after 12.3); Phase 13 (14.5 after 13.1 and 13.2); Part 1 Phase 2 (14.4 reads open alerts)
**Execution Mode:** Sequential

### Goals

- Every model ID comes from `config/ai-routing.yaml`, and a missing value fails at load.
- Each outer hop on the public path waits longer than the hop behind it, and long voice uploads run asynchronously.
- The Actual Budget SDK version cannot move without the server version.
- A check that runs outside the host notices when `workers` stops, without flooding the alert channel.

### Work Items

#### 14.1 Model IDs come from config
**Status: PENDING**
**Model Tier: sonnet**
**Requirement Refs:** SE7-18, INT-012 (investigation 05, item MC1)
**Files Affected:**
- `LAB_NOTEBOOK.md` (modify)
- `packages/shared/src/types/config.ts` (modify)
- `config/ai-routing.yaml` (modify)
- `packages/core-api/src/routes/briefs.ts` (modify)
- `packages/core-api/src/index.ts` (modify)
- `packages/core-api/src/__tests__/brief-tts.test.ts` (modify)
- `packages/shared/src/config/__tests__/loader.test.ts` (modify)
- `packages/shared/src/types/__tests__/config-tiers.test.ts` (modify)

**Description:**
`routes/briefs.ts` hardcodes `model: 'tts-1'` at lines 244 and 292. `AIConfigSchema` has no `tts` key, so zod strips the `tts:`
block that `config/ai-routing.yaml` already declares. The vendor shutdown of `tts-1` is reported for 2027-01-06. This item adds
`tts` to the schema and makes the audio route read the model, the voice, and the price from config. Item 14.5 removes the other
model literals and fallbacks.

**Tasks:**
1. [ ] Add a `LAB_NOTEBOOK.md` entry for Phase 14 before the first commit. Objective: model IDs from config, public timeouts in order, an exact Actual SDK pin, an off-host watchdog. Hypothesis: brief audio is generated with the configured model; a 60-second request through the web-next proxy returns 200; the monitor alerts once for a stopped `workers` and then backs off. Rollback: `git revert` per item; redeploy the previous commit with `scripts/deploy.sh <previous sha>`; `wrangler rollback` for the monitor.
2. [ ] Re-read the vendor's model deprecation page and pricing page before coding. Record in `LAB_NOTEBOOK.md`: the shutdown date of `tts-1`, the successor model, and the successor's price per 1,000 characters.
3. [ ] In `packages/shared/src/types/config.ts` (`AIConfigSchema`), add `tts: z.object({ provider: z.string(), model: z.string(), voice: z.string(), cost_per_1k_chars: z.number() })`.
4. [ ] In `config/ai-routing.yaml` (`tts:` block), set `model` to the value recorded in task 2, add `cost_per_1k_chars`, and update the comment block above.
5. [ ] In `packages/core-api/src/index.ts`, add `model`, `defaultVoice`, and `costPer1kChars` from `configService.get('ai').tts` to `ttsDeps`. In `packages/core-api/src/routes/briefs.ts`, use those values in the request body (`:244`), in the audit row (`:292`), and in the cost calculation, and delete `TTS_COST_PER_1K_CHARS`.
6. [ ] Update `brief-tts.test.ts`: the request and the audit row carry the configured model. Update `loader.test.ts` and `config-tiers.test.ts`: the `tts` block survives `ConfigService.load()`, and a config without `tts.model` is rejected.

**Acceptance Criteria:**
- [ ] WHEN `POST /api/v1/briefs/:id/audio` generates audio THEN the request model, the audit-row model, and the cost SHALL come from `tts` in `config/ai-routing.yaml`.
- [ ] WHEN `ai-routing.yaml` has no `tts.model` THEN `ConfigService.load()` SHALL throw.
- [ ] `grep -n "tts-1" packages/core-api/src/routes/briefs.ts` prints comment lines only.
- [ ] The change is deployed before the shutdown date recorded in task 2.
- [ ] `pnpm --filter @open-brain/core-api exec vitest run src/__tests__/brief-tts.test.ts` exits 0.
- [ ] `pnpm --filter @open-brain/shared test -- loader config-tiers` exits 0.

**Notes:**
The 2027-01-06 date is unverified until task 2 (unknown U5). This item has a calendar deadline: if Phases 12 and 13 are still open in mid-December, run this item ahead of them and rebase. The item shares `routes/briefs.ts` with items 13.3 and 16.1, and `types/config.ts`, `config/ai-routing.yaml`, `core-api/src/index.ts`, and two test files with items of Phases 12 and 13. A different TTS model changes the cost and the voice. The Redis audio cache key stays `tts:{brief_id}:{voice}`; audio cached from the old model expires within 24 hours. Deploy: `core-api`.

---

#### 14.2 Public path timeouts in the right order; remove the dead rewrite
**Status: PENDING**
**Model Tier: sonnet**
**Requirement Refs:** INT-013, INT-016 (investigation 05, items PX1 and PX2)
**Files Affected:**
- `packages/web-next/next.config.ts` (modify)
- `packages/core-api/src/routes/events.ts` (modify)
- `packages/web-next/components/voice/FileDropZone.tsx` (modify)
- `packages/web-next/app/(shell)/voice-upload/page.tsx` (modify)
- `packages/core-api/src/routes/voice-captures.ts` (modify)
- `packages/core-api/src/__tests__/voice-captures-routes.test.ts` (create)
- `packages/web-next/lib/api/voice-captures.ts` (modify)
- `packages/web-next/lib/__tests__/voice-captures.test.ts` (create)

**Description:**
The Next.js rewrite proxy cuts a request at its 30-second default while the hops behind the proxy allow 120 to 180 seconds, so
long synthesis and long voice uploads fail on the public path only. `components/voice/FileDropZone.tsx` posts to
`/voice-api/upload`, a rewrite whose target defaults to web-next's own port. This item sets `experimental.proxyTimeout`, lowers
the SSE heartbeat to 15 seconds, makes the voice upload answer 202 with polling when the client asks, and deletes the
`/voice-api` rewrite.

**Tasks:**
1. [ ] Re-read the edge proxy vendor's documentation for the origin response limit (about 100 seconds reported) before coding. Set the web-next proxy timeout 5 seconds below the confirmed value.
2. [ ] In `packages/web-next/next.config.ts`, add `experimental: { proxyTimeout: 95_000 }` (adjusted per task 1) and delete the `/voice-api/:path*` rewrite.
3. [ ] In `packages/core-api/src/routes/events.ts` (`:58`), change the heartbeat interval to `15_000`.
4. [ ] In `packages/web-next/components/voice/FileDropZone.tsx` (`:106`), call `voiceCapturesApi.upload(file, opts)` from `lib/api/voice-captures.ts` and delete the `fetch('/voice-api/upload', ...)` call. Correct the two comments that name the `/voice-api` rewrite: `FileDropZone.tsx:92` and `app/(shell)/voice-upload/page.tsx:8`.
5. [ ] In `packages/core-api/src/routes/voice-captures.ts`, when the request carries the header `Prefer: respond-async`: buffer the form, answer `202 { upload_id, status_url }`, run the upstream call in the background, and keep `{ status: 'pending' | 'complete' | 'failed', response?, error? }` for 10 minutes in a map inside the process. Add `GET /api/v1/voice-captures/:id`, which returns that record or 404; validate `:id` with `parseUUIDParam`. Without the header the route behaves as today.
6. [ ] In `packages/web-next/lib/api/voice-captures.ts`, send `Prefer: respond-async`. On 202, poll `status_url` every 3 seconds until `complete` or `failed`, for at most 4 minutes, and resolve with the same `VoiceCaptureResponse` shape. `useVoiceCapture` and its callers are unchanged.
7. [ ] Create `voice-captures-routes.test.ts`: the 202 and the status transitions; 413 before buffering; the synchronous path unchanged; an unknown ID returns 404. Create `lib/__tests__/voice-captures.test.ts`: the helper polls and resolves.
8. [ ] Local check: start web-next with `API_URL` pointed at a stub that sleeps 60 seconds, then run `curl -s -o /dev/null -w '%{http_code} %{time_total}\n' http://localhost:<port>/api/v1/health` against the port web-next listens on (3003 for the compose service). Expected: `200` after about 60 seconds.

**Acceptance Criteria:**
- [ ] WHEN a request through the web-next proxy takes longer than 30 seconds and less than the configured proxy timeout THEN the proxy SHALL return the origin's response.
- [ ] WHEN a voice upload carries `Prefer: respond-async` THEN core-api SHALL answer 202 and the client SHALL receive the capture result by polling.
- [ ] WHEN a voice upload carries no `Prefer` header THEN the route SHALL return the upstream response as today.
- [ ] WHEN an SSE client is connected to `/api/v1/events` THEN core-api SHALL send a heartbeat every 15 seconds.
- [ ] `grep -n "15_000" packages/core-api/src/routes/events.ts` prints the heartbeat interval.
- [ ] `grep -rn "voice-api" packages/web-next/app packages/web-next/components packages/web-next/lib packages/web-next/next.config.ts` prints nothing.
- [ ] `pnpm --filter @open-brain/web-next test` exits 0.
- [ ] `pnpm --filter @open-brain/core-api exec vitest run src/__tests__/voice-captures-routes.test.ts src/__tests__/events-routes.test.ts` exits 0 (the existing events test is unchanged and still passes).

**Notes:**
Run this item after item 12.3: the circuit breaker removes the 120-second Spark wait, which no proxy timeout below the edge limit can cover. After Phase 12 the inner budgets are 60 seconds for `t1_fast` and 180 seconds for `t2_quality`; a call that needs longer than the proxy timeout still fails on the public path. The async upload is opt-in so the mobile app's route contract and the iOS Shortcut path stay as they are. The status map lives in the core-api process: after a restart the client gets 404 and reports a failed upload. A 3-second poll is 20 requests per minute against a default tier of 100 per minute. `routes/activity.ts:71` and `routes/system-health.ts:77` also send a 30-second heartbeat; both sit below the new proxy timeout and are unchanged. Next.js 16.2.9 defaults the rewrite proxy timeout to 30 000 ms. Deploy: `web-next` and `core-api`.

---

#### 14.3 Actual Budget SDK cannot drift from the server
**Status: PENDING**
**Model Tier: sonnet**
**Requirement Refs:** INT-004 (investigation 05, item ACT1)
**Files Affected:**
- `scripts/actual/package.json` (modify)
- `scripts/actual/package-lock.json` (modify)
- `.github/dependabot.yml` (modify)
- `scripts/actual/actual-daily.mjs` (modify)
- `scripts/actual/lib/sdk-version.mjs` (create)
- `scripts/actual/test/sdk-version.test.mjs` (create)

**Description:**
`scripts/actual/package.json` declares `@actual-app/api` as `^26.7.0`. The SDK version must match the Actual server, and a
mismatch fails `downloadBudget` with `out-of-sync-migrations`. Dependabot opens PRs that bump the SDK alone, and no
`/scripts/actual` entry exists to hold an ignore rule. This item pins the exact version, adds the Dependabot entry with an ignore
for the SDK, and makes a version mismatch produce an alert that names the fix.

**Tasks:**
1. [ ] Re-read the Actual Budget release page before coding (server 27.x is expected in January 2027). Read the running server version on the host without changing anything: the image tag from `docker inspect actualbudget --format '{{.Config.Image}}'`, or the version on the Actual settings page when the tag is `latest`.
2. [ ] In `scripts/actual/package.json`, pin `@actual-app/api` to the exact server version (the lock file holds 26.7.0 today). Run `npm install --package-lock-only` in `scripts/actual`.
3. [ ] In `.github/dependabot.yml`, add an `npm` entry for directory `/scripts/actual` with `ignore: [{ dependency-name: "@actual-app/api" }]`.
4. [ ] Create `scripts/actual/lib/sdk-version.mjs` with `isOutOfSyncMigrations(err)` and `buildVersionMismatchMessage({ sdkVersion })`. The message names the installed SDK version and the fix: pin `@actual-app/api` to the server's version and rebuild `actual-ingest`.
5. [ ] In `scripts/actual/actual-daily.mjs`, in the fatal path, send that message when `isOutOfSyncMigrations(err)` is true. Confirm the generic fatal path already reports a failed run (Part 1 Phase 3); add a Pushover send there only when the path still exits silently.
6. [ ] Create `scripts/actual/test/sdk-version.test.mjs`: the detector matches an `out-of-sync-migrations` error and ignores other errors; the message names the version.
7. [ ] GitHub (owner): close the open Dependabot PRs that bump `@actual-app/api` alone.

**Acceptance Criteria:**
- [ ] WHEN Dependabot scans `/scripts/actual` THEN Dependabot SHALL open no PR for `@actual-app/api`.
- [ ] WHEN `downloadBudget` fails with `out-of-sync-migrations` THEN the daily run SHALL send one alert that names the installed SDK version and the fix.
- [ ] `scripts/actual/package.json` pins `@actual-app/api` to one exact version equal to the running server version.
- [ ] `cd scripts/actual && npm ci && npm test` exits 0.

**Notes:**
The sidecar is a standalone npm project outside the pnpm workspace. A server upgrade and the SDK bump ship together (CLAUDE.md, actual-ingest rule a). No balance, payee name, or sync ID appears in a tracked file or in alert text. The release date of server 27.x is unverified (unknown U11). Item 15.6 lists this pin in `config/pins.yaml`. Deploy: rebuild `actual-ingest` and deploy through `scripts/deploy.sh`.

---

#### 14.4 Something outside `workers` watches `workers`
**Status: PENDING**
**Model Tier: sonnet**
**Requirement Refs:** SA7-08, QA-007, INT-014 (investigation 06, item AL-4; investigation 05, item MON1)
**Files Affected:**
- `packages/core-api/src/services/system-health.ts` (modify)
- `packages/core-api/src/routes/system-health.ts` (modify)
- `packages/core-api/src/__tests__/system-health.test.ts` (modify)
- `cloudflare/synthetic-monitor/src/index.ts` (modify)
- `cloudflare/synthetic-monitor/src/index.test.ts` (create)
- `cloudflare/synthetic-monitor/package.json` (modify)
- `cloudflare/synthetic-monitor/package-lock.json` (modify)
- `.github/workflows/ci.yml` (modify)

**Description:**
The only check that runs off the host reads `/api/v1/health`, which knows nothing about `workers`, treats `degraded` as down, and
sends a priority-1 push every 5 minutes with no backoff. This item adds `GET /api/v1/system/heartbeat` to core-api and makes the
Cloudflare monitor read the route. The monitor alerts when the last `container-health` run is older than 45 minutes or the backup
is older than 30 hours, sends a priority-1 page only on `unhealthy` or a transport failure, and backs off using KV.

**Tasks:**
1. [ ] In `packages/core-api/src/services/system-health.ts`, add `getHeartbeat()` returning `container_health_last_at` (the newest `skills_log` row for `container-health`, through `getSkillLastRuns()`), `backup_age_s` (`backupAgeSeconds` from the newest `pipeline-health` row in `skills_log.result` plus the seconds since that row, or null), `newest_embedding_at` (`MAX(pipeline_completed_at)` over captures with an embedding), and `open_alerts` (the `app_settings` keys that start with `alert_state:` and whose status is not ok).
2. [ ] In `packages/core-api/src/routes/system-health.ts`, add `GET /api/v1/system/heartbeat` returning that object. The response holds timestamps, counts, and alert keys only.
3. [ ] In `cloudflare/synthetic-monitor/src/index.ts`, derive the heartbeat URL from `HEALTH_URL` (replace `/api/v1/health` with `/api/v1/system/heartbeat`) and send the same Access service-token headers.
4. [ ] Replace the alert rule in the monitor. A transport failure or `status === 'unhealthy'` sends a priority-1 page. `degraded` sends one priority-0 message per episode. A `container_health_last_at` older than 45 minutes sends the priority-0 alert "workers heartbeat lost". A `backup_age_s` above 108000 sends the priority-0 alert "backup older than 30 hours".
5. [ ] Keep per-condition state in the existing `HEALTH_STATE` KV namespace: `{ level, first_seen, last_alert_at, alerts_sent }`. Send at first detection, then after 10 minutes, 1 hour, and 6 hours, then once per day. When the condition clears, send one recovery message and delete the key.
6. [ ] In `cloudflare/synthetic-monitor/package.json`, add `vitest` and `typescript` as dev dependencies and the scripts `typecheck` (`tsc --noEmit`) and `test` (`vitest run`). Update `package-lock.json`.
7. [ ] Create `src/index.test.ts` with a fake KV and a fake `fetch`: "degraded does not page"; "unhealthy pages once, then backs off"; "heartbeat 46 minutes old alerts at priority 0"; "backup 31 hours old alerts at priority 0"; "recovery sends one message and clears state"; "a failed Pushover send is retried on the next run".
8. [ ] In `.github/workflows/ci.yml`, add the job `synthetic-monitor tests (Cloudflare Worker)` on the pattern of `email-worker-test`: `actions/setup-node` with `package-manager-cache: false`, `npm ci`, typecheck, test.
9. [ ] Update `packages/core-api/src/__tests__/system-health.test.ts` for `getHeartbeat()` and the route.
10. [ ] Owner, after core-api with the heartbeat route is deployed: `cd cloudflare/synthetic-monitor && npx wrangler deploy`.

**Acceptance Criteria:**
- [ ] WHEN `workers` has produced no `container-health` run for more than 45 minutes THEN the monitor SHALL send the alert "workers heartbeat lost" on its next run.
- [ ] WHEN core-api reports `unhealthy` or the request fails THEN the monitor SHALL send a priority-1 page.
- [ ] WHEN core-api reports `degraded` THEN the monitor SHALL NOT send a priority-1 push.
- [ ] WHEN a condition stays bad THEN the monitor SHALL send at most 4 messages in the first 6 hours and at most 1 message per day after that.
- [ ] WHEN the condition clears THEN the monitor SHALL send one recovery message.
- [ ] WHEN the backup is older than 30 hours THEN the monitor SHALL send an alert.
- [ ] `cd cloudflare/synthetic-monitor && npm ci && npx tsc --noEmit && npx vitest run` exits 0.
- [ ] `pnpm --filter @open-brain/core-api exec vitest run src/__tests__/system-health.test.ts` exits 0.

**Notes:**
Cross-plan prerequisite: Part 1 Phase 2 writes the `alert_state:*` keys that `open_alerts` reads. `container-health` runs every 15 minutes, so a 45-minute gap means `workers` is not running. Priority 1 is reserved for `unhealthy` and a transport failure; the stale-heartbeat and stale-backup alerts go out at priority 0 with the same backoff. `open_alerts` is carried in the heartbeat for the digest and is not an alert condition in the monitor; escalation of open alerts belongs to Part 1. The heartbeat route is reached on the public hostname through the web-next proxy, with the Access service token the monitor already uses. The monitor is outside the host deploy. The in-host watchdog (the `PushgatewayStale` and `WorkersMetricsAbsent` rules of the observability project) is unchanged. Item 15.4 makes the new CI job a required check before `cloudflare/synthetic-monitor` updates can auto-merge.

---

#### 14.5 Model literals and fallbacks are removed; a monthly model-presence check runs
**Status: PENDING**
**Model Tier: sonnet**
**Requirement Refs:** SE7-18, INT-012 (investigation 05, item MC1)
**Depends On:** 14.1
**Files Affected:**
- `packages/workers/src/jobs/skill-execution.ts` (modify)
- `packages/shared/src/services/run-agent.ts` (modify)
- `packages/workers/src/jobs/extract-entities.ts` (modify)
- `packages/workers/src/skills/llm-skill.ts` (modify)
- `packages/workers/src/skills/secret-rotation.ts` (modify)
- `packages/workers/src/__tests__/skill-execution.test.ts` (modify)
- `packages/shared/src/services/__tests__/run-agent.test.ts` (modify)
- `packages/workers/src/__tests__/secret-rotation.test.ts` (modify)

**Description:**
Literals and fallbacks shadow `config/ai-routing.yaml`: `skill-execution.ts` overrides the wiki-ingest model with a Haiku ID,
`runAgent` defaults to a dated Sonnet ID, `extract-entities.ts` falls back to `gpt-5.4`, and `llm-skill.ts` falls back to a
localhost URL. A retired model is noticed only when a call fails. This item removes the four fallbacks and adds a model-presence
check to the monthly `secret-rotation` skill.

**Tasks:**
1. [ ] In `packages/workers/src/jobs/skill-execution.ts`, delete `wikiAgentModel` (`:92`) and the `model: wikiAgentModel` option (`:450`). `WikiIngestSkill` resolves the model from the `wiki_ingest` task.
2. [ ] In `packages/shared/src/services/run-agent.ts` (`:268`), throw `Error('runAgent requires options.model or options.clientResolver')` when neither is given. Update the JSDoc at `:117`.
3. [ ] In `packages/workers/src/jobs/extract-entities.ts` (`:278`), replace `aiConfig.models['synthesis']?.model ?? 'gpt-5.4'` with `resolveTaskModel(aiConfig, 'entity_extraction').model`, which throws `ModelResolverError` when the routing entry is missing.
4. [ ] In `packages/workers/src/skills/llm-skill.ts` (`:53`), replace the `'http://localhost:3000'` fallback with `requireCoreApiUrl()`.
5. [ ] In `packages/workers/src/skills/secret-rotation.ts`, add a model-presence step. For each distinct model in `model_tiers`, `models.embedding`, `models.intent`, and `tts.model`: an `anthropic` tier calls `client.models.retrieve(model)` on the Anthropic SDK; an OpenAI-hosted model calls `client.models.retrieve(model)` on the OpenAI SDK; an `openai_compat` tier calls `client.models.list()` on the tier's `base_url` and checks the configured model is listed. A `NotFoundError` raises a warning alert with key `model-unavailable:<model>`; a found model clears the alert. Pass `configService` and the clients to the skill from `skill-execution.ts`.
6. [ ] Update `skill-execution.test.ts` (the test that expects the default wiki-agent model), `run-agent.test.ts` (the test "uses default model when not specified" now expects the throw), and `secret-rotation.test.ts` (a 404 raises the alert; a listed model does not; an unreachable local tier is reported as unreachable and not as a missing model).

**Acceptance Criteria:**
- [ ] WHEN `runAgent` is called with neither `model` nor `clientResolver` THEN `runAgent` SHALL throw before any API call.
- [ ] WHEN `task_routing.entity_extraction` is missing THEN `createExtractEntitiesWorker` SHALL throw `ModelResolverError` at construction.
- [ ] WHEN the monthly skill finds a configured model that the provider no longer serves THEN the skill SHALL raise one warning alert that names the model.
- [ ] `grep -rnE "claude-(haiku|sonnet|opus)-|gpt-5|tts-1" packages/*/src --include=*.ts | grep -v -e __tests__ -e '\.test\.'` prints comment lines, plus the two documented fallbacks in `packages/slack-bot/src/server.ts` and `packages/voice-capture/src/lib/classification-model.ts`.
- [ ] `pnpm --filter @open-brain/workers exec vitest run src/__tests__/skill-execution.test.ts src/__tests__/secret-rotation.test.ts` exits 0.
- [ ] `pnpm --filter @open-brain/shared test -- run-agent` exits 0.

**Notes:**
This item holds the part of item 14.1 that did not fit in eight files: item 14.1 is the dated TTS change, and this item is the remaining literals plus the monthly check. slack-bot and voice-capture read `models.intent` through a lightweight YAML load and keep a `gpt-5.4` fallback by design; the investigation's grep lists both, so the acceptance criterion names them. The model-presence calls read model metadata and spend no tokens. `secret-rotation` is the monthly operations skill (`0 10 1 * *`); the check adds no cron slot. After items 13.1 and 13.2 every `runAgent` caller passes a resolver, so the removed default has no caller, and the unverified retirement date of the dated Sonnet default (unknown U5) sets no deadline for this item. Deploy: `workers`.

---

### Phase 14 Testing Requirements

- [ ] The audio route test proves the configured TTS model reaches the request and the audit row.
- [ ] The voice route has tests for the 202 path, the status record, and the unchanged synchronous path.
- [ ] The monitor has tests for `degraded`, `unhealthy`, a stale heartbeat, a stale backup, backoff, and recovery, run by a new CI job.
- [ ] The Actual sidecar has a test for the version-mismatch detector.
- [ ] New code has more than 80% test coverage.
- [ ] Integration tests pass.

### Phase 14 Completion Checklist

- [ ] All work items complete
- [ ] All tests passing
- [ ] Coverage gates still green (thresholds never lowered)
- [ ] `LAB_NOTEBOOK.md` entry holds the results, including the three vendor facts re-read in items 14.1, 14.2, and 14.3
- [ ] CLAUDE.md and memory updated with any non-trivial learning (the `tts` config key, the proxy timeout, the async voice upload, the heartbeat route, the monitor's backoff)
- [ ] Deployed through `scripts/deploy.sh` (core-api, workers, web-next, actual-ingest) and verified in the running container (grep a marker, for example `docker exec open-brain-core-api sh -c 'grep -rlF "system/heartbeat" /app | head -1'`)
- [ ] Synthetic monitor deployed by the owner with `wrangler deploy`
- [ ] Item 14.1 deployed before the `tts-1` shutdown date; item 14.3 merged before the Actual server upgrade
- [ ] No regressions introduced

### Definition of Done (Runnable)
<!-- BEGIN DOD -->

| Check | Command | Pass Criteria |
|-------|---------|---------------|
| Tests and coverage gates | `pnpm -r test` | Exit code 0 |
| Lint and types | `pnpm -r lint` | Exit code 0 |
| Core-api integration | `pnpm test:integration` | Exit code 0 |
| Synthetic monitor | `cd cloudflare/synthetic-monitor && npm ci && npx tsc --noEmit && npx vitest run` | Exit code 0 |
| Actual sidecar | `cd scripts/actual && npm ci && npm test` | Exit code 0 |
| No dead rewrite | `! grep -rn "voice-api" packages/web-next/app packages/web-next/components packages/web-next/lib packages/web-next/next.config.ts` | Exit code 0 |

<!-- END DOD -->

---

## Phase 15: Patch pipeline and CI

**Estimated Complexity:** M (~17 files, ~620 LOC)
**Dependencies:** None (GitHub-side; may start at any time)
**Execution Mode:** Sequential

### Goals

- Required checks are deterministic, so an unattended merge is safe.
- Dependabot can update the root lockfile again, and images rebuild every week.
- Patch-level updates merge without the owner.
- The monthly audit and scheduled CI fail when a check cannot run or when automation has gone quiet.
- Each dated pin has a review date and a monthly reminder.

### Work Items

#### 15.1 Tests safe for unattended merges
**Status: PENDING**
**Model Tier: sonnet**
**Requirement Refs:** QA-015, QA-013 (investigation 06, item CI-1)
**Files Affected:**
- `LAB_NOTEBOOK.md` (modify)
- `packages/core-api/src/__tests__/system-health.test.ts` (modify)
- `packages/core-api/vitest.config.ts` (modify)
- `packages/workers/vitest.config.ts` (modify)
- `scripts/tests/conftest.py` (create)
- `scripts/tests/requirements.txt` (modify)
- `.github/workflows/ci.yml` (modify)

**Description:**
`system-health.test.ts` imports `../app.js` inside the test body, so on a loaded runner the cold import exceeds the 30-second
test timeout and a required check goes red; a failed run also prints no coverage table. `scripts/tests/` (56 tests for the
cron-run scripts) is in no workflow and stops at collection with `ModuleNotFoundError: No module named 'lib.db'`. This item moves
the import into `beforeAll`, sets `coverage.reportOnFailure`, fixes the Python import isolation, and runs `scripts/tests` and
`scripts/test-restore-rehearsal.sh` in CI.

**Tasks:**
1. [ ] Add a `LAB_NOTEBOOK.md` entry for Phase 15 before the first commit. Objective: deterministic checks, a resolvable lockfile, weekly rebuilds, patch auto-merge, an audit that fails closed. Hypothesis: `pnpm install --lockfile-only` exits 0 in a clean checkout and the next Dependabot run for `/` succeeds. Rollback: `git revert` per item; set `allow_auto_merge=false`; disable the new workflow with `gh workflow disable`.
2. [ ] In `packages/core-api/src/__tests__/system-health.test.ts` (`:413-428` and the other tests in the block that call `await import('../app.js')`), import the app once in a `beforeAll` with a 60-second timeout and use the cached `createApp` in each test.
3. [ ] Set `coverage.reportOnFailure: true` in `packages/core-api/vitest.config.ts` and in `packages/workers/vitest.config.ts`.
4. [ ] Create `scripts/tests/conftest.py`: put `scripts/` on `sys.path` once, and restore `sys.modules` after each test module so one file's module stubs do not replace the `lib` package for the next file.
5. [ ] Complete `scripts/tests/requirements.txt` with the libraries the five test files import.
6. [ ] In `.github/workflows/ci.yml`, add a job `scripts tests (Python)`: `pip install -r scripts/tests/requirements.txt`, then `python3 -m pytest scripts/tests -v --tb=short`. Add `bash scripts/test-restore-rehearsal.sh` to `build-and-test`, unless a step already runs the script.

**Acceptance Criteria:**
- [ ] WHEN the core-api suite runs on a loaded machine THEN the app import SHALL happen once in `beforeAll` and no test SHALL time out on the import.
- [ ] WHEN a vitest run fails in `core-api` or `workers` THEN the run SHALL still print the coverage table.
- [ ] WHEN `python -m pytest scripts/tests` runs as one suite THEN collection SHALL succeed and every test SHALL pass.
- [ ] `pnpm -r test && python -m pytest scripts/tests` exits 0.
- [ ] A CI job runs `scripts/tests`, and a CI step runs `scripts/test-restore-rehearsal.sh`.

**Notes:**
The three test files with `2026-12-31` fixtures (`bet-routes.test.ts`, `bet-service.test.ts`, `insurance-policies-routes.test.ts`) are fixed in Part 1 item 1.5; do not change them here. Part 1 adds the `test-restore-rehearsal.sh` step with its backup work; whichever lands second keeps one copy of the step. `scripts/test-loki-routing.sh` needs a live Loki and running containers and stays a host check. This item merges before item 15.4.

---

#### 15.2 The root lockfile resolves again
**Status: PENDING**
**Model Tier: sonnet**
**Requirement Refs:** PLT-019, QA-004, SEC-003 and SEC-004 (update mechanics only) (investigation 06, item PP-1 step 1)
**Files Affected:**
- `packages/mobile/package.json` (modify)
- `package.json` (modify)
- `pnpm-lock.yaml` (modify)
- `packages/web-next/package.json` (modify)
- `.github/dependabot.yml` (modify)

**Description:**
Every Dependabot update run against the root lockfile fails. The run logs name the cause: `.npmrc` sets
`strict-peer-dependencies=true`, and `packages/mobile` has `expo-router 6.0.23` with two unmet peers, so
`pnpm install --lockfile-only` exits with `ERR_PNPM_PEER_DEP_ISSUES`. Exact-version entries in `pnpm.overrides` also hold `axios`,
`shell-quote`, and `undici` below the versions Dependabot proposes. This item satisfies the peers, turns the exact overrides into
floors, and lands one catch-up update.

**Tasks:**
1. [ ] In `packages/mobile`, run `npx expo install --check` and add `expo-linking@~8.0.11` and `@expo/metro-runtime@~6.1.2`. If the Expo SDK refuses those versions, add `pnpm.peerDependencyRules.allowedVersions` entries for the two peers in the root `package.json`. Keep `strict-peer-dependencies=true`.
2. [ ] In the root `package.json` (`pnpm.overrides`), replace the exact pins with floors: `"axios": "^1.20.0"`, `"shell-quote@<1.11.0": "^1.11.0"`, `"undici@^6": "^6.28.1"`. Drop each override that the parent packages now satisfy. Update `_overridesNotes`.
3. [ ] Run `pnpm update -r --depth Infinity --no-save` for the transitive set. Then update `next` in `packages/web-next/package.json` to the newest release that the current range `^16.2.5` allows, and run `pnpm --filter @open-brain/web-next build`.
4. [ ] In `.github/dependabot.yml`, in each `npm` entry, split the group `npm-minor-patch` into a patch-only group and a minor-only group. Any edit to this file also re-triggers the root update job.
5. [ ] Run `pnpm install --frozen-lockfile`, `pnpm -r lint`, and `pnpm -r test`. Commit `pnpm-lock.yaml` with the manifests.
6. [ ] GitHub (owner), after the merge: confirm the next Dependabot run for directory `/` completes.

**Acceptance Criteria:**
- [ ] WHEN `pnpm install --lockfile-only` runs in a clean checkout THEN the command SHALL exit 0 with `strict-peer-dependencies=true`.
- [ ] WHEN Dependabot updates a package named in `pnpm.overrides` THEN the override SHALL accept any version at or above the floor.
- [ ] `pnpm-lock.yaml` is committed in the same commit as every `package.json` change.
- [ ] The first Dependabot run for directory `/` after the merge ends without `ERR_PNPM_PEER_DEP_ISSUES`.
- [ ] `pnpm -r lint && pnpm -r test` exits 0.

**Notes:**
The cause is the peer mismatch under strict peers, plus the exact overrides; neither appears in a review finding. Do not answer a failed update with another exact override: exact pins are what hold the three packages back. `follow-redirects` and `proxy-addr` do not move under `pnpm update` and the log gives no reason (unknown U9); record the resolver output of task 3 in `LAB_NOTEBOOK.md`. The `next` update reaches production through an image build and then `scripts/deploy.sh`. The root version-update job last ran on 2026-07-16.

---

#### 15.3 Weekly image rebuild
**Status: PENDING**
**Model Tier: sonnet**
**Requirement Refs:** PLT-019, SEC-004 (mechanics only) (investigation 06, item PP-1 step 2)
**Files Affected:**
- `.github/workflows/build-images.yml` (modify)

**Description:**
`build-images.yml` runs only on a push to `main`, with no `pull:` and with the GitHub Actions layer cache, so base-image and
OS-package updates reach `:latest` only when application code changes. No image has been rebuilt since 2026-07-20. This item adds
a weekly schedule and manual dispatch, pulls base images on every build, and skips the layer cache on the scheduled run.

**Tasks:**
1. [ ] In `.github/workflows/build-images.yml`, under `on:`, add `schedule: - cron: '0 9 * * 1'` and `workflow_dispatch:` (keep `workflow_dispatch` if Part 1 already added the trigger).
2. [ ] On every `docker/build-push-action` step, set `pull: true` and `no-cache: ${{ github.event_name == 'schedule' }}`.
3. [ ] Keep the `sha-<short>` and `latest` tags and the `notify-failure` job. Keep the image revision label if Part 1 added the label.
4. [ ] GitHub (owner), after the merge: `gh workflow run build-images.yml`, then confirm all eight images build.

**Acceptance Criteria:**
- [ ] WHEN Monday 09:00 UTC arrives THEN `build-images.yml` SHALL rebuild every image from freshly pulled base images with no layer cache.
- [ ] WHEN the workflow is dispatched by hand THEN the workflow SHALL build and push all eight images.
- [ ] `gh workflow run build-images.yml` followed by `gh run watch` ends with a successful run.

**Notes:**
A rebuilt `:latest` changes nothing on the host: an image reaches production only through `scripts/deploy.sh <sha>`. A merge made with `GITHUB_TOKEN` (item 15.4) does not trigger `on: push`, so the schedule is the rebuild path for auto-merged updates. Image IDs change on every rebuild without a code change; the CLAUDE.md rule on "in sync" already covers that. A report-only image scan is a security follow-up, outside this plan. GitHub disables a schedule after 60 days without repository activity (item 15.5).

---

#### 15.4 Auto-merge for patch-level updates
**Status: PENDING**
**Model Tier: sonnet**
**Requirement Refs:** QA-004, PLT-025 (investigation 06, item PP-1 step 3)
**Depends On:** 15.1, 15.2
**Files Affected:**
- `.github/workflows/dependabot-automerge.yml` (create)

**Description:**
Green Dependabot PRs wait for the owner: 19 were open and mergeable in November, and the repository setting `allow_auto_merge` is
false. This item adds a workflow that turns on auto-merge for a Dependabot PR whose update is semver-patch, limited to
directories whose tests are required checks, and turns on the repository setting.

**Tasks:**
1. [ ] Create `.github/workflows/dependabot-automerge.yml`: `on: pull_request`; the job runs only when `github.actor == 'dependabot[bot]'`; permissions `contents: write` and `pull-requests: write`; step `dependabot/fetch-metadata@v2`; when `update-type` is `version-update:semver-patch` and the PR's directory is in the allowlist, run `gh pr merge --auto --squash "$PR_URL"`.
2. [ ] Start the allowlist with `/` only. Add `/cloudflare/email-worker`, `/scripts/actual`, and `/cloudflare/synthetic-monitor` one at a time, each after task 4 has made that directory's test job a required check.
3. [ ] GitHub (owner): `gh api -X PATCH repos/davistroy/open-brain -F allow_auto_merge=true`.
4. [ ] GitHub (owner): read the current list with `gh api repos/davistroy/open-brain/branches/main/protection/required_status_checks --jq .contexts`. Add `email-worker tests (Cloudflare Worker)` and `actual-ingest tests (Actual Budget sidecar)` to the required checks. Add the synthetic-monitor job of item 14.4 when that job exists.
5. [ ] Verify with the next patch PR: the PR merges after the required checks pass, with no manual step.

**Acceptance Criteria:**
- [ ] WHEN Dependabot opens a semver-patch PR for an allowlisted directory and every required check passes THEN GitHub SHALL merge the PR without owner action.
- [ ] WHEN the update is semver-minor or semver-major THEN the workflow SHALL NOT turn on auto-merge.
- [ ] WHEN the PR's directory has no required test job THEN the workflow SHALL NOT turn on auto-merge.
- [ ] `gh api repos/davistroy/open-brain --jq .allow_auto_merge` prints `true`.

**Notes:**
Auto-merge is semver-patch only and follows the required checks for the standalone directories. The patch-only Dependabot groups from item 15.2 are what make a patch PR identifiable; a mixed minor-and-patch group reports the higher update type. `@actual-app/api` is ignored by Dependabot (item 14.3) and never auto-merges. Nothing reaches production without `scripts/deploy.sh`. An auto-merged commit counts as repository activity, which keeps the scheduled workflows enabled.

---

#### 15.5 Audit and scheduled CI that cannot go quiet
**Status: PENDING**
**Model Tier: sonnet**
**Requirement Refs:** PLT-018, RC7-06, QA-008, QA-006, PLT-025 (investigation 06, items PP-2 and PP-3)
**Files Affected:**
- `.github/workflows/monthly-audit.yml` (modify)
- `.github/workflows/build-images.yml` (modify)
- `.github/workflows/ci.yml` (modify)
- `OPERATOR_ACTIONS.md` (modify)

**Description:**
The monthly audit reads Dependabot alerts with the job token, which cannot read them. The failed call becomes `null`, the script
sets every count to 0, and Slack receives "0 alerts". Both Slack posts use `curl -sf` and ignore Slack's `ok` field. CI runs only
on push and pull request, so nothing runs the gates on `main` when nobody pushes. This item makes the audit fail when a check
cannot run, adds a weekly CI run, and makes the audit fail when automation has gone quiet.

**Tasks:**
1. [ ] In `.github/workflows/monthly-audit.yml` (alerts step, `:52-84`), call `gh api --paginate` with the repository secret `DEPENDABOT_ALERTS_TOKEN`. When the result is not a JSON array, write "Dependabot alerts: COULD NOT CHECK" to the job summary and to Slack, and `exit 1`.
2. [ ] In `monthly-audit.yml` (`:184-189`) and `.github/workflows/build-images.yml` (`:167-171`), capture the Slack response and require `jq -e '.ok'`. A failed post fails the step.
3. [ ] In `.github/workflows/ci.yml`, add a weekly `schedule` and `workflow_dispatch`. Add a final job that posts to Slack when a scheduled run fails, with the same `ok` check. Pin the gitleaks image to a fixed `v8` release tag in place of `latest`.
4. [ ] In `monthly-audit.yml`, add a step that fails when the newest commit on `main` is older than 45 days, or when the newest Dependabot run is older than 14 days.
5. [ ] Owner: create a fine-grained token with one permission (Dependabot alerts: read), store the token in Bitwarden, and set the secret with `gh secret set DEPENDABOT_ALERTS_TOKEN`.
6. [ ] Add a row to `OPERATOR_ACTIONS.md` for the token's expiry date, with a plain `YYYY-MM-DD` due date.
7. [ ] GitHub (owner), after the merge: `gh workflow run monthly-audit.yml`; the run reports a real alert count or fails with "COULD NOT CHECK".

**Acceptance Criteria:**
- [ ] WHEN the Dependabot alerts call fails or returns a non-array THEN the audit SHALL post "COULD NOT CHECK" and exit 1.
- [ ] WHEN Slack answers `ok: false` THEN the posting step SHALL fail.
- [ ] WHEN no commit has reached `main` for 45 days, or no Dependabot run has happened for 14 days, THEN the monthly audit SHALL fail.
- [ ] WHEN a week passes with no push THEN CI SHALL still run once on `main`.
- [ ] `gh workflow run monthly-audit.yml && gh run view --log | grep -i dependabot` shows a count that matches the repository's open alerts.
- [ ] `gh workflow list --all` lists `CI`, `Build and Push Images`, and `Monthly Dependency & Security Audit` as active.

**Notes:**
The token is a GitHub Actions secret and not an application secret: `scripts/lib/secrets-map.sh` and `deploy/.env.secrets.template` are unchanged. About 2026-12-23, GitHub is likely to disable the scheduled workflows, 60 days after the last repository activity (unknown U6). Any merge to `main` resets the clock, and Part 1 item 1.5 is the first. Whether re-enabling a workflow resets the timer is not verified. After Part 1, the audit calls the shared operator-actions parser; keep that step. The `full-stack-e2e` job runs on a schedule because the ref is `main`.

---

#### 15.6 Dated pins are tracked
**Status: PENDING**
**Model Tier: haiku**
**Requirement Refs:** SA7-13 (investigation 06, item PP-4)
**Depends On:** 15.5
**Files Affected:**
- `config/pins.yaml` (create)
- `.github/workflows/monthly-audit.yml` (modify)

**Description:**
Several pins expire on a vendor's calendar, and nothing records the dates: the `cloudflared` image, the `speaches` tag, the
Node 22 runtime, the Access service token, the TTS model, and the Actual SDK. This item adds `config/pins.yaml` with one entry
per pin (item, current value, review-by date) and a monthly-audit step that lists the entries due within 60 days.

**Tasks:**
1. [ ] Create `config/pins.yaml` as a list of `{ item, current, review_by, source }`. Entries: the `cloudflared` image tag; the `speaches` image tag; the pgvector image pin; the Node 22 runtime (end of life 2027-04); the Cloudflare Access service token expiry; the TTS model (`tts.model`); the `@actual-app/api` exact pin; the gitleaks image tag; the `rclone` pin.
2. [ ] Take each `current` value from the file that holds the pin at implementation time. Re-read each vendor page for `review_by`.
3. [ ] In `.github/workflows/monthly-audit.yml`, add a step that reads `config/pins.yaml`, lists the entries whose `review_by` is past or within 60 days in the job summary and in the Slack message, and fails when an entry has no valid `YYYY-MM-DD` date.
4. [ ] List a token by name and expiry date only. Put no secret value in the file.

**Acceptance Criteria:**
- [ ] WHEN a pin's `review_by` date is within 60 days THEN the monthly audit SHALL list the pin in the job summary and in Slack.
- [ ] WHEN an entry has no valid date THEN the audit step SHALL fail.
- [ ] `python3 -c "import yaml, datetime; [datetime.date.fromisoformat(str(e['review_by'])) for e in yaml.safe_load(open('config/pins.yaml'))]"` exits 0.

**Notes:**
The vendor dates are unverified until task 2. Items 14.1 and 14.3 own the TTS and Actual entries. `config/` is mounted read-only into the containers, and no runtime code reads `config/pins.yaml`. Tier `haiku`: escalate to `sonnet` if the audit step needs more than a short script.

---

### Phase 15 Testing Requirements

- [ ] `pnpm -r test` passes with the app import in `beforeAll`, and a failed run prints the coverage table.
- [ ] `python -m pytest scripts/tests` collects and passes as one suite.
- [ ] `pnpm install --lockfile-only` exits 0 in a clean checkout.
- [ ] Each changed workflow is run once with `gh workflow run` after the merge.

### Phase 15 Completion Checklist

- [ ] All work items complete
- [ ] All tests passing
- [ ] Coverage gates still green (thresholds never lowered)
- [ ] `LAB_NOTEBOOK.md` entry holds the results; Decision Log and Action Items updated
- [ ] CLAUDE.md and memory updated with any non-trivial learning (the strict-peer cause of the Dependabot failures, override floors, the auto-merge allowlist, `config/pins.yaml`)
- [ ] No host deploy in this phase; rebuilt images reach production only through `scripts/deploy.sh`
- [ ] Repository settings set by the owner: `allow_auto_merge`, the added required checks, the `DEPENDABOT_ALERTS_TOKEN` secret
- [ ] A merge to `main` has landed before 2026-12-23
- [ ] No regressions introduced

### Definition of Done (Runnable)
<!-- BEGIN DOD -->

| Check | Command | Pass Criteria |
|-------|---------|---------------|
| Tests and coverage gates | `pnpm -r test` | Exit code 0 |
| Lint and types | `pnpm -r lint` | Exit code 0 |
| Python lint and types | `ruff check . && ruff format --check . && pyright` | Exit code 0 |
| Script tests | `python -m pytest scripts/tests` | Exit code 0 |
| Lockfile in sync | `pnpm install --frozen-lockfile` | Exit code 0 |
| Lockfile resolves in a clean checkout | `tmp=$(mktemp -d) && git worktree add --detach "$tmp" HEAD && (cd "$tmp" && pnpm install --lockfile-only); rc=$?; git worktree remove --force "$tmp"; exit $rc` | Exit code 0 |
| Pins file dates | `python3 -c "import yaml, datetime; [datetime.date.fromisoformat(str(e['review_by'])) for e in yaml.safe_load(open('config/pins.yaml'))]"` | Exit code 0 |

<!-- END DOD -->

---

## Phase 16: Mechanical hardening: fetch timeouts and silent catches

**Estimated Complexity:** S (~14 files, ~150 LOC)
**Dependencies:** Part 1 Phase 5
**Execution Mode:** Parallel

### Goals

- Each of the seven outbound `fetch` calls that had no timeout ends after a fixed time.
- Each listed catch that discarded an error writes a warn line.

### Work Items

#### 16.1 Timeouts on outbound fetches
**Status: PENDING**
**Model Tier: haiku**
**Requirement Refs:** SE7-21 (investigation 05, item TO1)
**Files Affected:**
- `LAB_NOTEBOOK.md` (modify)
- `packages/workers/src/skills/base-skill.ts` (modify)
- `packages/core-api/src/routes/briefs.ts` (modify)
- `packages/shared/src/services/email/gmail-client.ts` (modify)
- `packages/slack-bot/src/server.ts` (modify)
- `packages/slack-bot/src/handlers/auto-response.ts` (modify)
- `packages/workers/src/skills/email-compose.ts` (modify)
- `packages/workers/src/__tests__/base-skill-autonomy.test.ts` (modify)

**Description:**
Seven `fetch` calls pass no `signal`, so each call falls back to undici's 300-second header and body timeouts. The autonomy lookup
in `base-skill.ts` runs inside the concurrency-1 skill worker, so one hung lookup stalls every scheduled skill. This item adds
`AbortSignal.timeout` at the seven sites: 5 seconds for the autonomy lookup, 30 seconds for the TTS request, 10 seconds for the
other five.

**Tasks:**
1. [ ] Add a `LAB_NOTEBOOK.md` entry for Phase 16 before the first commit of either Phase 16 item. Objective: a timeout on each of the seven outbound `fetch` calls, and a log line at each listed silent catch. Hypothesis: each listed `fetch` call carries a `signal`, each listed catch writes a warn line, and every suite stays green. Rollback: `git revert` per item; redeploy the previous commit with `scripts/deploy.sh <previous sha>`.
2. [ ] `packages/workers/src/skills/base-skill.ts:16` (`fetchAutonomyLevel`): add `signal: AbortSignal.timeout(5_000)`.
3. [ ] `packages/core-api/src/routes/briefs.ts:237` (the TTS `fetch`): add `signal: AbortSignal.timeout(30_000)`.
4. [ ] `packages/shared/src/services/email/gmail-client.ts:459` and `:474` (`gmailGet`, `gmailPost`): add `signal: AbortSignal.timeout(10_000)`.
5. [ ] `packages/slack-bot/src/server.ts:35` (`getAutonomyLevel`): add `signal: AbortSignal.timeout(10_000)`.
6. [ ] `packages/slack-bot/src/handlers/auto-response.ts:73` (monitored channels): add `signal: AbortSignal.timeout(10_000)`.
7. [ ] `packages/workers/src/skills/email-compose.ts:188` (create draft): add `signal: AbortSignal.timeout(10_000)`.
8. [ ] Add one assertion to `base-skill-autonomy.test.ts`: the autonomy `fetch` receives an `AbortSignal`. `src/skills/base-skill.ts` has a per-file 100% coverage lock.
9. [ ] Run `pnpm -r test`. Where a test asserts exact `fetch` options, add `signal: expect.any(AbortSignal)` to the expectation.

**Acceptance Criteria:**
- [ ] WHEN core-api does not answer the autonomy lookup within 5 seconds THEN `fetchAutonomyLevel` SHALL abort and return `observe`.
- [ ] WHEN the TTS endpoint does not answer within 30 seconds THEN the audio route SHALL return 502 with code `TTS_ERROR`.
- [ ] `grep -n "await fetch(" packages/workers/src/skills/base-skill.ts packages/core-api/src/routes/briefs.ts` lists two calls, and each call passes a `signal`.
- [ ] `pnpm -r lint` and `pnpm -r test` exit 0.

**Notes:**
The autonomy lookup uses 5 seconds (investigation 04, item M9) and not the 10-second default of investigation 05, because the lookup blocks the concurrency-1 skill worker. Item 10.6 adds the warn log and the 30-second fallback cache on the same function. The TTS timeout is 30 seconds (investigation 05) and not the 15 seconds the finding proposed: a timeout that is too short fails the audio of a long brief. Each timeout surfaces through the call site's existing `catch`. Tier `haiku`: escalate to `sonnet` if a call site must be restructured to pass a signal.

---

#### 16.2 Silent catches write a log line
**Status: PENDING**
**Model Tier: haiku**
**Requirement Refs:** SE7-20 (investigation 04, item M13)
**Files Affected:**
- `packages/core-api/src/mcp/resources/context.ts` (modify)
- `packages/core-api/src/mcp/tools/get-entity.ts` (modify)
- `packages/workers/src/skills/drift-monitor.ts` (modify)
- `packages/workers/src/skills/daily-connections.ts` (modify)
- `packages/shared/src/services/composio-client.ts` (modify)
- `packages/core-api/src/__tests__/mcp-tools.test.ts` (modify)

**Description:**
Four `catch {}` blocks in the MCP context resource, one in `get_entity`, two Pushover sends in workers skills, and three calls in
`ComposioClient` discard the error with no log line. `get_entity` also answers every database error with "Entity lookup is not
yet available. The entity graph is implemented in a later phase", which stopped being true when the entity graph shipped. This
item adds a warn log at each site and replaces the stale message.

**Tasks:**
1. [ ] `packages/core-api/src/mcp/resources/context.ts:68, 96, 124, 149`: bind the error (`catch (err)`) and call `logger.warn({ err, section }, '[mcp-context] section query failed')`. Keep the "_Unable to query …_" output.
2. [ ] `packages/core-api/src/mcp/tools/get-entity.ts:99-102`: call `logger.warn({ err }, '[get_entity] lookup failed')` and return `Entity lookup failed: database error.`.
3. [ ] `packages/workers/src/skills/drift-monitor.ts:218` and `packages/workers/src/skills/daily-connections.ts:194`: where the direct `this.pushover.send` call still exists, replace the call with `this.sendNotification(...)`, which logs a failed send. Part 1 Phase 2 moves the drift push into the daily digest; skip a site that no longer exists.
4. [ ] `packages/shared/src/services/composio-client.ts:137, 149, 162`: replace each `.catch(() => {})` with `.catch((err) => logger.warn({ err }, '[composio] quota bookkeeping call failed'))`.
5. [ ] In `mcp-tools.test.ts`, add a test: `get_entity` with a rejecting `db.execute` returns the new message.

**Acceptance Criteria:**
- [ ] WHEN a query behind the MCP context resource fails THEN core-api SHALL write one warn line that names the section.
- [ ] WHEN `get_entity` hits a database error THEN the tool SHALL return `Entity lookup failed: database error.` and SHALL log the error.
- [ ] WHEN a Pushover or Redis call at a listed site fails THEN the caller SHALL write one warn line and continue.
- [ ] `grep -nE "catch \{$|\.catch\(\(\) => \{\}\)" packages/core-api/src/mcp/resources/context.ts packages/core-api/src/mcp/tools/get-entity.ts packages/workers/src/skills/drift-monitor.ts packages/workers/src/skills/daily-connections.ts packages/shared/src/services/composio-client.ts` prints nothing.
- [ ] `pnpm --filter @open-brain/core-api exec vitest run src/__tests__/mcp-tools.test.ts` exits 0.

**Notes:**
This item holds the part of item 10.6 that did not fit in eight files. The `memory-consolidation.ts:670` catch from the same finding is fixed in item 11.6, which rewrites that file; fixing the catch here would put two phases on one file. Best-effort behaviour stays: no site starts throwing. Tier `haiku`: escalate to `sonnet` if Part 1 has restructured a catch site.

---

### Phase 16 Testing Requirements

- [ ] The autonomy lookup test asserts that the `fetch` call receives an `AbortSignal`.
- [ ] `get_entity` has a test for the database-error message.
- [ ] `src/skills/base-skill.ts` keeps 100% line and function coverage (per-file lock in `packages/workers/vitest.config.ts`).
- [ ] New code has more than 80% test coverage.
- [ ] Integration tests pass.

### Phase 16 Completion Checklist

- [ ] All work items complete
- [ ] All tests passing
- [ ] Coverage gates still green (thresholds never lowered)
- [ ] `LAB_NOTEBOOK.md` entry holds the results; Decision Log and Action Items updated
- [ ] CLAUDE.md and memory updated with any non-trivial learning (the timeout value at each call site, the `get_entity` error message)
- [ ] Deployed through `scripts/deploy.sh` (core-api, workers, slack-bot) and verified in the running container (grep a marker, for example `docker exec open-brain-core-api sh -c 'grep -rlF "[mcp-context] section query failed" /app | head -1'`)
- [ ] No regressions introduced

### Definition of Done (Runnable)
<!-- BEGIN DOD -->

| Check | Command | Pass Criteria |
|-------|---------|---------------|
| Tests and coverage gates | `pnpm -r test` | Exit code 0 |
| Lint and types | `pnpm -r lint` | Exit code 0 |
| Core-api integration | `pnpm test:integration` | Exit code 0 |
| Autonomy lookup test | `pnpm --filter @open-brain/workers exec vitest run src/__tests__/base-skill-autonomy.test.ts` | Exit code 0 |
| MCP tool test | `pnpm --filter @open-brain/core-api exec vitest run src/__tests__/mcp-tools.test.ts` | Exit code 0 |

<!-- END DOD -->

<!-- END PHASES -->

---

<!-- BEGIN TABLES -->

## Parallel Work Opportunities

Phases 9, 10, 11, 15, and 16 and the chain 12 → 13 → 14 are independent of each other after Part 1 Phase 5. Phase 15 can start at any time. Phases that run at the same time share the files named below: merge one phase branch at a time and rebase the next.

| Work Item | Can Run With | Notes |
|-----------|--------------|-------|
| Phase 9 | Phases 10, 11, 12–14, 15, 16 | Needs Part 1 items 2.6 and 3.1 and Part 1 Phase 5. Shares `packages/core-api/src/index.ts` with items 10.3, 11.1, 13.1, 13.3, 13.4, and 14.1, `packages/workers/src/main.ts` (item 9.5) with items 13.1, 13.3, and 13.4, and `packages/workers/src/jobs/embed-capture.ts` (item 9.1) with item 13.3. |
| Phase 10, items 10.1–10.6 | Each other; Phases 9, 11, 12–14, 15, 16 | No two Phase 10 items share a file. Items 10.6 and 16.1 edit the same function in `packages/workers/src/skills/base-skill.ts`. |
| Phase 11 | Phases 9, 10, 12–14, 15, 16 | Item 11.2 waits for Part 1 item 8.1; item 11.6 waits for Part 1 item 1.2. Shares `packages/workers/src/jobs/skill-execution.ts` with items 10.6, 13.1, 13.2, and 14.5. |
| Phases 12 → 13 → 14 | Phases 9, 10, 11, 15, 16 | Phase 13 follows item 12.2. Phase 14 follows Phases 12 and 13: item 14.2 follows item 12.3, and item 14.5 follows items 13.1 and 13.2. Items 14.1 and 14.3 carry calendar dates and can run ahead of Phases 12 and 13. Item 14.1 shares `packages/core-api/src/index.ts`, `packages/core-api/src/routes/briefs.ts`, `packages/shared/src/types/config.ts`, and `config/ai-routing.yaml` with items of Phases 12 and 13: when item 14.1 runs first, rebase Phases 12 and 13 over the change. `config/ai-routing.yaml` is edited by items 12.1, 12.3, 12.4, 13.5, and 14.1. |
| Phase 15 | Every phase of both parts | GitHub-side. `.github/workflows/ci.yml` is also edited by items 9.4 and 14.4; `packages/core-api/src/__tests__/system-health.test.ts` is also edited by items 13.4 and 14.4; `.github/dependabot.yml` is also edited by item 14.3. |
| Phase 16, items 16.1 and 16.2 | Each other; every other phase | The two items share no file. Item 16.1 shares `packages/workers/src/skills/base-skill.ts` with item 10.6 and `packages/core-api/src/routes/briefs.ts` with items 13.3 and 14.1. Item 16.2 leaves `memory-consolidation.ts` to item 11.6. |
| `LAB_NOTEBOOK.md` and `CLAUDE.md` | No parallel edit | Every phase appends to both files. Branches that append after the same entry conflict: merge one branch at a time and keep every entry. |

---

## Risk Mitigation

The first six rows are the four rows of the analysis' Risk Assessment for its phases 6–9; two of those rows named two risks each and are split here. The remaining rows come from the lead rulings and from the "risk if done poorly" columns of the investigation records.

| Risk | Likelihood | Impact | Mitigation Strategy | Status |
|------|------------|--------|---------------------|--------|
| The re-drive duplicates enrichment: commitments are inserted twice and a paid `wiki_ingest` call runs per sweep (Phase 9) | Med | Med | The real-Redis test in item 9.1 asserts processor call counts. `?stage=all` on the retry route is the only path that re-runs enrichment. | Open |
| The re-drive strands a flow: a re-attached failed child makes the new root job wait forever (Phase 9) | Med | High | Item 9.1 removes only the root and embed jobs by ID and adds an embed-only flow; test case (c) proves the new root job completes. | Open |
| Memory consolidation merges and deletes wrongly; the skill is destructive and runs at the live autonomy level (Phase 11) | High | High | First production run with `dryRun`; one transaction with compensation; originals are soft-deleted and recoverable; the cron is disabled if the full fix cannot ship. Never ship a subset of item 11.6. | Open |
| The circuit breaker trips on a cold-start 503 and sends traffic to paid tiers (Phase 12) | Med | Med | Model-loading errors do not count; the breaker values live in YAML and reload without a restart; a high `failure_threshold` switches the breaker off; the budget check runs on every fallback hop. | Open |
| A budget-guard bug blocks free classification again (Phase 12) | Med | High | `isPaidTier` reads the cost fields; the gateway tests drive spend past the limit in both directions (paid blocked at the limit, cost-0 tier proceeds at $999). | Open |
| Auto-merge lands a breaking patch in a directory that no required check tests (Phase 15) | Low | Med | Semver-patch only; an allowlist of directories; each directory's test job becomes a required check first; nothing deploys without `scripts/deploy.sh`. | Open |
| Retention prunes the job IDs that guard against duplicate enrichment, or hides an embed outage (item 9.3) | Low | High | Item 9.3 depends on items 9.1 and 9.2 and on Part 1 item 3.1 (the stuck-capture gauge reads the `captures` table). | Open |
| Tier timeouts passed to Anthropic cut long agent loops (item 12.1) | Low | Med | Raise `t1_fast` to 60 000 ms and `t2_quality` to 180 000 ms before passing the tier timeout. | Open |
| The new required e2e check blocks every merge because the Playwright smoke is unstable (item 9.4) | Med | Med | The check becomes required only after three consecutive green runs on `main`. | Open |
| The derived wipe list truncates a table the owner wants kept (item 10.5) | Low | High | Unknown U10 is resolved before coding; `KEEP_TABLES`; the foreign-key guard; the pre-wipe `pg_dump` is unchanged. | Open |
| The first idle-only prune of `capture_associations` runs one long statement (item 11.3) | Low | Low | The prune deletes in batches of 5,000 rows. | Open |
| GitHub disables the scheduled workflows about 2026-12-23 (Phase 15) | Med | Med | Any merge to `main` resets the clock; item 15.5 makes the monthly audit fail when automation has gone quiet. | Open |
| The `tts-1` model is shut down before item 14.1 is deployed | Low | Med | Item 14.1 can run ahead of Phases 12 and 13; the vendor date is re-read in the item's first tasks. | Open |

---

## Unknowns Register

The IDs U4, U5, U6, U9, and U10 are the IDs of the analysis. U3 and U7 of the analysis affect Part 1 only and are not listed. U11, U12, and U13 are new in this plan.

| ID | Unknown | Severity | Affects | Resolution Strategy | Status |
|----|---------|----------|---------|---------------------|--------|
| U4 | Whether the Spark tier can be restored, and by when | Medium | Phase 12, item 12.3 | Owner check on the Spark host. Item 12.3 makes latency independent of the answer. | Open |
| U5 | Vendor facts: the `tts-1` shutdown date, its successor model and price; the retirement date of the dated Sonnet default in `runAgent`; the edge proxy's origin response limit | Medium | Phase 14, items 14.1, 14.2, 14.5 | Re-read each vendor page in the item's first task. None was verified offline. | Open |
| U6 | Whether GitHub disables the scheduled workflows about 2026-12-23, and whether re-enabling a workflow resets the timer | Medium | Phase 15, items 15.3, 15.5 | The merge of Part 1 item 1.5 resets the clock. Item 15.5 adds the stale-automation check. | Open |
| U9 | Why `follow-redirects` and `proxy-addr` cannot be updated (`pnpm update` exits 0 and the lockfile does not change) | Low | Phase 15, item 15.2 | The catch-up update in item 15.2 shows the resolver's reason; record the output. | Open |
| U10 | Whether the health, insurance, and email tables belong in "WIPE ALL DATA" | Low | Phase 10, item 10.5 | Owner decision, recorded before coding. Default: keep the undecided tables. | Open |
| U11 | The release date of Actual Budget server 27.x, and the server version running when the pin is set | Medium | Phase 14, item 14.3 | Re-read the release page; read the running image tag on the host. | Open |
| U12 | Whether the `full-stack-e2e` job passes on three consecutive runs once the upload defect and the directory ownership are fixed; no surviving log shows a green run | Medium | Phase 9, item 9.4 | The three-run gate in item 9.4 before the check becomes required. | Open |
| U13 | Whether to change the dedup rule in `packages/workers/src/lib/ingest-dedup.ts`: the `SET NX` key `<hash>:<captureId>` with a 5-minute TTL drops a second job for the same capture inside 5 minutes, contrary to the file's doc comment; item 9.1 bypasses the check for `forceRetry` only | Low | Phase 9, item 9.1 | Owner decision on the wider behaviour. | Open |

---

## Success Metrics

- [ ] All phases completed
- [ ] All acceptance criteria met
- [ ] A capture whose embed failed is embedded by the next sweep: on the host, `SELECT count(*) FROM captures WHERE embedding IS NULL AND deleted_at IS NULL AND created_at < now() - interval '1 day';` returns 0
- [ ] The five flow queues hold no completed job older than 7 days and no failed job older than 14 days
- [ ] A filtered search returns `limit` rows on 8 consecutive runs on one connection, and a keyword search returns a capture that has no embedding
- [ ] One consolidation run leaves one merged capture and no live original per cluster; the first production run was a dry run
- [ ] At the hard limit a paid tier makes zero calls and a cost-0 tier proceeds; the budget thresholds exist in `config/ai-routing.yaml` and nowhere else
- [ ] With Spark down, the wait is at most 2 timeouts per process per 10 minutes instead of one timeout per call
- [ ] The off-host monitor alerts within one run after `workers` stops and sends at most 4 messages in the first 6 hours
- [ ] `pnpm install --lockfile-only` exits 0 in a clean checkout, the next Dependabot run for `/` succeeds, and a patch PR merges without the owner
- [ ] The monthly audit reports the real alert count or fails
- [ ] Coverage gates are unchanged or higher: `workers` lines 78 and functions 81 with the four per-file locks, `core-api` 80 and 80

---

## Appendix: Requirement Traceability

| Requirement | Source | Phase | Work Item |
|-------------|--------|-------|-----------|
| SE7-01 | arch-review v7; investigation 03 (CAP-1) | 9 | 9.1, 9.2 |
| PE-012 | arch-review v7; investigation 03 (CAP-1) | 9 | 9.1, 9.2 |
| Defect: a second job for the same capture inside the 5-minute dedup window is dropped | Code at `f341ca6` (`packages/workers/src/lib/ingest-dedup.ts`); found while preparing this plan | 9 | 9.1 |
| Defect: the retry route reports success while nothing runs | Investigation 03 (disagreement 7) | 9 | 9.2 |
| DA7-16 | arch-review v7; investigation 03 (DEL-1) | 9, 11 | 9.2, 11.4, 11.6 |
| PE-004 | arch-review v7; investigation 03 (CAP-2) | 9 | 9.3 |
| Defect: manual wiki re-ingest is a no-op while the flow child is retained | Investigation 03 (disagreement 6) | 9 | 9.3 |
| QA-001 | arch-review v7; investigation 03 (UPL-1) | 9 | 9.4 |
| SE7-24 | arch-review v7; investigation 03 (UPL-1) | 9 | 9.4 |
| SE7-28 (stream half) | arch-review v7; investigation 03 (UPL-1) | 9 | 9.4 |
| QA-005 | arch-review v7; investigation 03 (UPL-2) | 9 | 9.4 |
| SE7-22 | arch-review v7; investigation 03 (PROC-1) | 9 | 9.5 |
| DA7-20 | arch-review v7; investigation 03 (DB-1) | 9 | 9.6 |
| PE-016 | arch-review v7; investigation 03 (DB-1) | 9 | 9.6 |
| SE7-13 | arch-review v7; investigation 03 (ENT-1) | 10 | 10.1 |
| SE7-14 | arch-review v7; investigation 03 (EXT-1) | 10 | 10.1 |
| SE7-23 | arch-review v7; investigation 03 (EXT-1) | 10 | 10.1 |
| SE7-09 | arch-review v7; investigation 04 (M10) | 10 | 10.2 |
| SE7-16 | arch-review v7; investigation 04 (M11) | 10 | 10.3 |
| INT-002 | arch-review v7; investigation 05 (EW1) | 10 | 10.4 |
| DA7-14 | arch-review v7; investigation 04 (M12) | 10 | 10.5 |
| SE7-06 | arch-review v7; investigation 04 (M9) | 10 | 10.6 |
| SE7-20 | arch-review v7; investigation 04 (M9, M13) | 10, 11, 16 | 10.6, 11.6, 16.2 |
| PE-001 | arch-review v7; investigation 03 (SRCH-1) | 11 | 11.1 |
| PE-011 | arch-review v7; investigation 03 (SRCH-1) | 11 | 11.1 |
| QA-011 | arch-review v7; investigation 03 (SRCH-1) | 11 | 11.1 |
| DA7-19 | arch-review v7; investigation 03 (SRCH-2) | 11 | 11.2 |
| SE7-12 | arch-review v7; investigation 04 (M3) | 11 | 11.3 |
| DA7-15 | arch-review v7; investigation 04 (M3) | 11 | 11.3 |
| SE7-26 | arch-review v7; investigation 04 (M3) | 11 | 11.3 |
| PE-014 | arch-review v7; investigation 04 (M3) | 11 | 11.3 |
| QA-002 | arch-review v7; investigation 04 (M2) | 11 | 11.5 |
| SE7-03 | arch-review v7; investigation 04 (M1) | 11 | 11.6 |
| DA7-06 | arch-review v7; investigation 04 (M1) | 11 | 11.6 |
| SA7-07 | arch-review v7; investigation 04 (M1) | 11 | 11.6 |
| Defect: `repointAssociations` fails when two merged originals share a neighbour | Investigation 04 (M1 step 2; disagreement 2) | 11 | 11.6 |
| Defect: the `created_at` watermark never admits re-embedded captures | Investigation 04 (disagreement 3) | 11 | 11.6 |
| SE7-10 | arch-review v7; investigation 05 (FB1) | 12 | 12.1 |
| SE7-19 | arch-review v7; investigation 05 (FB1) | 12 | 12.1 |
| INT-012 (404 part) | arch-review v7; investigation 05 (FB1) | 12, 13 | 12.1, 13.1 |
| SA7-01 | arch-review v7; investigation 05 (B1) | 12, 13 | 12.2, 13.3, 13.4 |
| SE7-02 | arch-review v7; investigation 05 (B1) | 12 | 12.2 |
| INT-011 | arch-review v7; investigation 05 (B1) | 12 | 12.2 |
| Live finding L6: a dead tier costs a full timeout on every call | arch-review v7 live verification; investigation 05 (TH2) | 12 | 12.3 |
| SA7-06 | arch-review v7; investigation 05 (FB2) | 12 | 12.4 |
| SA7-16 | arch-review v7; investigation 05 (FB2) | 12 | 12.4 |
| SE7-04 | arch-review v7; investigation 05 (B1) | 13 | 13.1, 13.2 |
| PE-015 | arch-review v7; investigation 05 (B1) | 13 | 13.1, 13.2 |
| SE7-05 (six threshold copies) | arch-review v7; investigation 05 (B1; correction 2) | 13 | 13.3, 13.4, 13.5 |
| SE7-18 | arch-review v7; investigation 05 (MC1) | 14 | 14.1, 14.5 |
| INT-012 | arch-review v7; investigation 05 (MC1) | 14 | 14.1, 14.5 |
| INT-013 | arch-review v7; investigation 05 (PX1) | 14 | 14.2 |
| INT-016 | arch-review v7; investigation 05 (PX2) | 14 | 14.2 |
| INT-004 | arch-review v7; investigation 05 (ACT1) | 14 | 14.3 |
| SA7-08 | arch-review v7; investigation 06 (AL-4) | 14 | 14.4 |
| QA-007 | arch-review v7; investigation 06 (AL-4) | 14 | 14.4 |
| INT-014 | arch-review v7; investigation 05 (MON1); investigation 06 (AL-4) | 14 | 14.4 |
| QA-015 | arch-review v7; investigation 06 (CI-1) | 15 | 15.1 |
| QA-013 | arch-review v7; investigation 06 (CI-1) | 15 | 15.1 |
| PLT-019 | arch-review v7; investigation 06 (PP-1) | 15 | 15.2, 15.3 |
| QA-004 | arch-review v7; investigation 06 (PP-1) | 15 | 15.2, 15.4 |
| Defect: Dependabot root updates fail on strict peers plus the Expo peer mismatch | Investigation 06 (disagreement 2) | 15 | 15.2 |
| SEC-003 (update mechanics only) | arch-review v7; investigation 06 (PP-1) | 15 | 15.2 |
| SEC-004 (update mechanics only) | arch-review v7; investigation 06 (PP-1) | 15 | 15.2, 15.3 |
| PLT-025 | arch-review v7; investigation 06 (PP-1, PP-3) | 15 | 15.4, 15.5 |
| PLT-018 | arch-review v7; investigation 06 (PP-2) | 15 | 15.5 |
| RC7-06 | arch-review v7; investigation 06 (PP-2) | 15 | 15.5 |
| QA-008 | arch-review v7; investigation 06 (PP-2) | 15 | 15.5 |
| QA-006 | arch-review v7; investigation 06 (PP-3) | 15 | 15.5 |
| SA7-13 | arch-review v7; investigation 06 (PP-4) | 15 | 15.6 |
| SE7-21 | arch-review v7; investigation 05 (TO1) | 16 | 16.1 |

<!-- END TABLES -->

---

*Implementation plan generated by Claude on 2026-11-22 14:13:23*
*Source: /create-plan command*
