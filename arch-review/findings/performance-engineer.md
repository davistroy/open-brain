# Performance Engineer Findings

**Reviewer:** Performance Engineer
**Date:** 2026-07-12
**Target:** /home/davistroy/dev/personal/open-brain
**Confidence:** High — code review only, no live environment access; but v5 scope is narrow (only Dependabot PRs #232–#234 merged since v4) and every v4 finding was re-verified line-by-line in current code rather than carried forward on trust. Latency figures cited are from the project's own documented benchmarks (LAB_NOTEBOOK Entry 108/173), not independently measured.

> Note: This review is based on code and configuration analysis. Load testing requires a
> production-equivalent environment and is not part of a code-based architecture review.
> Structural risks identified here should be validated with actual load tests.
> No load-test tooling (k6/ab/wrk/hey/vegeta) is available in the review environment.
> **v5 — supersedes the 2026-07-09 v4 findings.** Since v4, the only merged code is the
> Dependabot dependency remediation (PRs #232–#234): vitest 2→3 + coverage-v8 (dev-only),
> nodemailer 8→9 (workers), hono 4.12.5→4.12.25, transitive security overrides
> (axios/undici/ws/lodash/form-data/etc.), plus test backfill and dead-code removal in
> core-api (`services/sse.ts`, unused exports). **None of these changes is
> performance-relevant to production paths**, and none touches any v4 finding location.

---

## v4 Finding Adjudication

Every v4 finding was re-verified against current HEAD (`cd14c1f`). Diff scope since v4 confirmed via `git diff --stat`: dependency manifests/lockfiles, two new test files, dead-code removal, LAB_NOTEBOOK, dependabot.yml only.

| v4 ID | Verdict | Evidence (current code) |
|-------|---------|------------------------|
| PE-H1 (High) — unbounded agent-loop context in monthly-reflection / runAgent | **STILL OPEN** | `monthly-reflection.ts:164` still interpolates full `r.content` untruncated into tool results; `run-agent.ts` grep for budget/truncate/slice = zero hits — only `maxIterations` (default 10) bounds the loop. Issue #204 unaddressed. |
| PE-M1 (Med) — unbounded search `offset` defeats LIMIT push-down | **STILL OPEN** | `schemas/search.ts:12` `offset: z.number().int().min(0).default(0)` — no `.max()`; `routes/search.ts:97` `fetchLimit = body.offset + body.limit` still flows into `hybrid_search(match_count)` → `LIMIT match_count * 4` CTE scans. |
| PE-M2 (Med) — per-chunk single-text embedding calls | **STILL OPEN (wording corrected)** | Correction to v4 text: `EmbeddingService.embedBatch(texts[])` DOES exist (`embedding.ts:196`, added in Phase 6 PR #224, i.e., it already existed at v4 — v4 overstated "only supports single-input"). However it has **zero production callers**: `embed-capture.ts:128` and `document-pipeline.ts:304` still call `.embed()` per capture/per chunk. The finding stands with a smaller fix: wire the existing batch primitive into the chunk-embed path; no new service code needed. |
| PE-M3 (Med) — BullMQ orphan repeatable jobs on cron changes (#217) | **STILL OPEN** | `getRepeatableJobs`/`removeRepeatable` grep across `scheduler.ts` + `main.ts` = zero hits; no startup reconciliation sweep exists. |
| PE-L1 (Low) — per-connection SSE polling of expensive snapshot | **STILL OPEN** | `routes/system-health.ts:61` per-connection `setInterval` calling `service.snapshot()` unchanged. (Note: the deleted `services/sse.ts` was unrelated dead code — this route builds its own stream.) |
| PE-L2 (Low) — `ILIKE '%q%'` seq scans in agent tools | **STILL OPEN** | `email-compose.ts:87,127–128`; `email-compose-assist.ts:218,258–259` — all four leading-wildcard sites unchanged. |
| PE-L3 (Low) — pool headroom one consumer from exhaustion | **STILL OPEN** | `shared/src/db/client.ts:15` `max: 20` still hardcoded, not env-tunable; `max_connections = 50` unchanged. |
| PE-L4 (Low) — no ingest-pipeline latency histogram | **STILL OPEN** | `docs/SLO.md` §4 still titled "proxy metric — no histogram today"; `openbrain_job_duration_seconds` exists only as the deferred design sketch (SLO.md:109–111), zero hits in workers src/config. |
| PE-L5 (Low) — voice proxy buffers full multipart body | **STILL OPEN (accepted decision D126)** | `routes/voice-captures.ts:11` `await c.req.formData()` buffer-and-rebuild unchanged; 50 MB guard at line 23. Accept as-is per v4. |
| PE-L6 (Low) — spend-throttle sleep occupies a worker slot | **STILL OPEN (intended semantics)** | `embed-capture.ts:39,79` — 30 s in-handler sleep at concurrency 2 unchanged. Real fix remains PE-M2 batching. |
| PE-L7 (Low) — slack capture poll inert on stale `'received'` literal | **STILL OPEN** | `slack-bot/src/handlers/capture.ts:45` still checks `'received' \|\| 'processing'`; fresh captures are `'pending'` → loop exits on first poll. (Cross-domain: correctness/QA, SE-1 bug class.) |
| PE-RI1 (RI) — HNSW ~50K ceiling needs scheduled re-benchmark (#73) | **STILL OPEN** | No corpus-size watermark/benchmark-reminder in `storage-audit.ts` (grep = zero hits); `scripts/benchmark-search.mjs` exists but nothing triggers it as corpus grows. |

**Net-new findings this pass: none.** The Dependabot waves were audited for production-runtime perf impact: hono 4.12.5→4.12.25 is a patch-line bump on the HTTP framework (no perf-behavioral changes flagged in that range); nodemailer 8→9 affects the low-volume email-outbound path only; all other bumps are dev-only (vitest 3) or transitive security pins. The core-api dead-code removal (`services/sse.ts`, unused schema/service exports) is perf-neutral-to-positive (smaller bundle). No regression risk identified.

---

## SLO Baseline

Unchanged from v4 — re-verified `docs/SLO.md` present and consistent with recording rules.

| SLO | Stated Target | Instrumented? | Finding |
|-----|--------------|--------------|---------|
| API p99 latency (all routes) | < 2.0 s / 5-min window | Yes — `openbrain_api_p99_latency_seconds` recording rule + `ApiP99LatencySLOBreach` alert | Sound. Histogram buckets (5 ms–10 s) resolve p99 without interpolation error. |
| Search p99 (`/api/v1/search`) | < 3.0 s | Yes — recording rule + alert | Sound; ~3.75× headroom over measured p99 ~800 ms at ef_search=60 on 11K corpus. Doc flags re-benchmark trigger at 50K captures or ef_search > 80. |
| MCP p99 (`/mcp.*`) | < 5.0 s | Yes — recording rule + alert | Sound; correctly bifurcates LLM-backed vs DB-only tools. |
| Ingest pipeline latency | ≥1 capture/6h proxy + 95% success (manual) | **Partial** — no per-job duration histogram; `CaptureFlowStale` is an availability proxy only | Gap acknowledged in SLO.md §4 with deferred design (BullMQ job-duration histogram via Pushgateway). See PE-L4. |
| Availability | 99% monthly | Partial — `ContainerDown` alert + manual Grafana review | Acceptable for single-node; formal tracking explicitly deferred. |

Overall: SLO discipline remains unusually good for a single-operator system.

---

## Structural Performance Risk Register

All carried forward from v4 (re-verified, no code changed at these sites). Severities unchanged.

| ID | Risk | Location | Severity | Load Scenario | Recommendation |
|----|------|----------|----------|--------------|----------------|
| PE-H1 | **Unbounded agent-loop context growth in monthly-reflection (#204).** `query_captures_by_view` returns full untruncated capture content for up to 200 captures/call (`monthly-reflection.ts:164`) across 5 brain views; `runAgent()` bounds iterations (10) but has no per-tool-result size cap and no cumulative context/token budget — structural cause of the observed 6.5M-token blowup; also a material fraction of the $50/month hard cap per run. | `monthly-reflection.ts:118–167`, `run-agent.ts` | High | High-capture-volume month in any single brain view (bulk file/email ingest) | (1) Truncate `r.content` per capture (400–500 chars; email-compose precedent = 300); (2) cumulative context budget in `runAgent`; (3) per-tool-result size cap at the runAgent layer so all agent skills inherit it. |
| PE-M1 | **POST /api/v1/search `offset` unbounded, defeats P13 LIMIT push-down.** `fetchLimit = offset + limit` → `match_count`; CTEs scan `LIMIT match_count * 4`. `offset=100000` → 400K-row FTS/HNSW candidate materialization — the exact O(N) cliff migration 0027 removed. Each page also re-embeds the query (one OpenAI call/page). 17 internal bypass callers hit this unthrottled. | `schemas/search.ts:12`, `routes/search.ts:91–147` | Medium | Deep pagination by web UI, agent loop, or buggy client | Cap offset (e.g., `.max(490)` so offset+limit ≤ 500) or keyset pagination. `total` reflects fetched pool, not true match count — misleading to paginating clients. |
| PE-M2 | **Per-chunk single-text embedding calls in the document pipeline — batch primitive exists but is unwired.** `EmbeddingService.embedBatch()` (`embedding.ts:196`) has zero production callers; `document-pipeline.ts:304` and `embed-capture.ts:128` embed one text per HTTP round-trip at concurrency 2. A 3,230-file bulk ingest = thousands of sequential calls; the 30 s spend-throttle (PE-L6) multiplies wall time when above soft budget. | `embedding.ts:196`, `jobs/document-pipeline.ts:304`, `jobs/embed-capture.ts:128` | Medium | Bulk document/backfill ingest; forced re-embed on model change (#73 migration) | Wire the existing `embedBatch` into a batch-aware chunk-embed job (per-element adaptive truncation). Keep single-item path for the real-time track. Smaller fix than v4 assumed — the service method already exists. |
| PE-M3 | **BullMQ orphan repeatable jobs on cron changes (#217).** BullMQ keys repeatables by (name, pattern); editing a `const *Cron` string leaves the old repeatable firing forever. No `getRepeatableJobs()` reconciliation at startup (grep: zero hits). Phase 9 moved two Sunday slots — potential live duplicates; duplicated LLM spend + contention with singleton-concurrency jobs. | `packages/workers/src/scheduler.ts` | Medium | Any cron-schedule change deployed without manual Redis cleanup | Startup reconciliation sweep: enumerate repeatables per queue, remove any (name, pattern) not in the current registration set (~30 lines). |
| PE-L1 | **Per-connection SSE polling of an expensive snapshot.** `/system-health` SSE spawns a per-connection 10 s `setInterval` → `service.snapshot()` (~8 parallel queries: queue stats, Redis INFO, 180-day spend aggregation, skill last-runs, wiki/container/backup status). N tabs = N× load; nothing shared. | `routes/system-health.ts:61`, `services/system-health.ts` | Low | Several dashboard tabs open (realistic: 2–5) | Single module-level poller broadcasting to all subscribers, or memoize `snapshot()` with 5–10 s TTL. |
| PE-L2 | **`ILIKE '%q%'` sequential scans in agent search tools** — unindexable leading-wildcard scans over `captures.content` and `entities`, inside interactive agent loops. Trivial at 11K rows; linear degradation with growth. | `email-compose.ts:87,127–128`, `email-compose-assist.ts:218,258–259` | Low | Corpus at 100K+ captures | Route through existing `fts_only_search()`/tsquery (GIN index from 0034 already exists); `pg_trgm` GIN on `lower(name)` for entities if ILIKE must stay. |
| PE-L3 | **Connection-pool headroom one consumer from exhaustion.** `createDb()` hardcodes `max: 20`; core-api + workers = 40 + pg-notify client + health pool + ad-hoc migrate containers vs `max_connections = 50`. Not configurable. | `shared/src/db/client.ts:15`, `config/postgres/postgresql.conf` | Low | Third `createDb` consumer; migration container during load | Env-tunable pool `max`; document the 50-connection budget beside `max_connections`. |
| PE-L4 | **No ingest-pipeline latency histogram** — classify→extract→embed→complete has no duration SLO measurement; only the 6h `CaptureFlowStale` proxy. Consciously deferred in SLO.md §4 with correct design sketch. | `docs/SLO.md` §4 | Low | Silent pipeline latency regression that never trips the staleness proxy | Implement deferred `openbrain_job_duration_seconds` via existing Pushgateway path; `pipeline_events.duration_ms` already has per-stage data — a periodic export closes most of the gap. |
| PE-L5 | **Voice upload proxy buffers entire multipart body in memory** (settled decision D126) — up to 50 MB per in-flight upload inside core-api (1200 MB heap). Bounded by 413 guard both sides; safe at single-user concurrency. | `routes/voice-captures.ts:11,23` | Low | Batch tooling pushing many memos concurrently | Accept as-is; revisit with streaming proxy only if batch voice upload is added. |
| PE-L6 | **Spend-throttle sleep occupies a worker slot** — 30 s in-handler sleep at concurrency 2 → ~4 embeds/min when between soft/hard budget limits. Intended semantics; combined with PE-M2, throttled bulk ingests take days. | `jobs/embed-capture.ts:39,79` | Low | Bulk ingest while above soft budget | No isolated change; PE-M2 batching is the real fix (one batched call embeds ~100 chunks per 30 s toll). |
| PE-L7 | **Slack capture poll loop inert — stale `'received'` status literal (SE-1 class; cross-domain flag).** Poll continues only while status is `'received'`/`'processing'`, but fresh captures are `'pending'` → loop exits on first check and never polls. Performance-neutral (reduces load); flagged for correctness/QA domain. | `slack-bot/src/handlers/capture.ts:45` | Low | n/a (functional, not load) | Use `'pending' \|\| 'processing'` or import from a shared status module (sweepable-statuses pattern); add literal-pinning regression test. |
| PE-RI1 | **pgvector HNSW capacity ceiling (~50K embeddings) — #73; needs scheduled re-benchmark, not a rewrite.** Corpus ~11.3K, growing via batch pipelines. At 50K: HNSW maintenance memory, weekly k-NN consolidation scan (~5× today), and ef_search recall/latency trade-off all shift. `benchmark-search.mjs` exists; nothing triggers it. | ADR-0003, `workers/src/lib/hnsw-similarity.ts`, #73 | Requires investigation | Corpus at 25K–50K captures | Corpus-size watermark in storage-audit firing a Pushover reminder to re-run `benchmark-search.mjs` at 25K and 40K, ahead of the #73 Qdrant decision point. |

### Confirmed-fixed prior findings (re-verified in v4, unchanged since — not re-reported)

- P13/0027 `LIMIT match_count * 4` push-down in `hybrid_search`/`fts_only_search`.
- `SET LOCAL hnsw.ef_search` in `db.transaction()` (SearchService + hnsw-similarity); value from `pipeline.yaml`.
- Migration 0034 stored `content_tsvector` + GIN; SQL functions read the column.
- Search SELECTs exclude the 3 KB `embedding` vector.
- ADR-0003 scalar-subquery HNSW k-NN probes replacing O(N²) self-joins; incremental watermark scoping.
- P06 single-statement batch UPSERT in `upsertCoAccessAssociations`.
- Redis 400 MB `noeviction`; bounded `removeOnComplete/removeOnFail` (+`age:14d` on skill-execution).
- Entry 180 `pgUuidArray()` fix in daily-connections/memory-consolidation (proven live, 105 rows).
- `spreading_activation` bounded to 2 hops + `LIMIT max_related`, soft-delete filter.

---

## Database Performance Assessment

Unchanged from v4 (no schema/config changes since):

| Finding | Location | Risk | Recommendation |
|---------|----------|------|----------------|
| Index coverage comprehensive: 137 indexes in generated snapshot; all spot-checked filtered/FK columns covered; HNSW (m=16, ef_construction=64) + GIN tsvector. | `scripts/init-schema.sql` | None | No action. |
| `postgresql.conf` sensibly tuned for 8 GB container (shared_buffers 2 GB, effective_cache_size 6 GB, random_page_cost 1.1, slow-query log 1 s). `work_mem = 64MB` aggressive at max_connections 50 but actual concurrency single-digit. | `config/postgres/postgresql.conf` | Low | Leave as-is. |
| /dev/shm 64 MB vs maintenance_work_mem 512 MB breaks parallel index builds during migrations; `shm_size: "512mb"` deferred to batched daemon-restart window; PGOPTIONS workaround documented. | compose `postgres` service | Low (migration-time, mitigated) | Confirm `shm_size` lands in next restart window. |
| Event-table growth bounded by `data-retention-prune` (migration 0035). Note: A135 (v4 exec summary) flagged the skills_log prune as FK-blocked by `briefs.source_skill_log_id` — that is a correctness finding owned by the data domain; perf implication (skills_log unbounded growth feeding pipeline-health LIKE scans) is minor at current volume. | `workers/src/jobs/data-retention-prune.ts` | Low | Track via A135 remediation. |
| Unbounded `offset` → `match_count` in POST search (PE-M1). | `routes/search.ts` | Medium | Cap offset. |
| ILIKE leading-wildcard scans in agent tools (PE-L2). | email-compose(-assist) | Low | Route via existing FTS. |
| Only core-api + workers open DB pools (2 × 20); slack-bot/voice-capture/sidecars go through HTTP — clean topology; see PE-L3 headroom math. | `shared/src/db/client.ts` | Low | Env-tunable pool size. |

## Caching Effectiveness Assessment

- **Cache strategy identified:** Yes — deliberately minimal, appropriate for single-user / low-QPS.
- **TTL discipline:** Consistent. Autonomy caches 5 min; trigger cache with `invalidateTriggerCache()` on mutation; TemplateCache; Redis TTS cache 24 h; ingest dedup 5 min; admin reset tokens 5 min GETDEL; TanStack Query `staleTime` 30–120 s with bounded refetch.
- **Invalidation correctness risk:** Low — single-process module caches, no cross-instance coherence problem by design.
- **Thundering herd exposure:** No — single user. Only fan-in point is per-tab SSE snapshot polling (PE-L1), a fan-out inefficiency, not a stampede.
- **Specific findings:** No search-result caching, and none warranted (personalized queries, low rate, continuously mutating corpus). Redis is a job store + small KV; `noeviction` is the correct policy.

## Concurrency and Async Assessment

- BullMQ default concurrency 2; documented singletons at 1; cron-slot uniqueness CI-enforced (`scheduler-slots.test.ts`). Gap: repeatable orphaning on pattern change (PE-M3).
- No blocking on hot paths; all `setTimeout`s legitimate (backoff, abort timers, throttle sleep in async handler). Auto-response and access-stats enqueues fire-and-forget with `.catch`.
- Module-level mutable caches safe under Node single-threaded model; rate limiter prunes per-request + 5-min `unref()` cleanup.
- pg LISTEN/NOTIFY on a dedicated client with backoff reconnect + channel re-registration — does not starve the pool.
- Event-loop CPU work trivial (≤50 results in-memory; 768-dim dot products on cached triggers).
- Graceful shutdown: pool `.end()` + worker `.close()`; voice-spool interval `unref()`'d and test-gated.

## Capacity Model (Qualitative)

Binding-constraint ordering (single user, ~11.3K captures, growth via batch pipelines) — unchanged from v4:

1. **pgvector/HNSW corpus size (~50K embeddings)** — first structural ceiling; search p99 (~800 ms measured at 11K/ef_search 60 vs 3 s SLO) and weekly k-NN consolidation both degrade with N; #73 gates the Qdrant decision. Instrument this (PE-RI1), not CPU/RAM.
2. **OpenAI API spend** throttles ingest throughput first by design ($30 soft → ~4 embeds/min; $50 hard → pause). Bulk ingest under throttle is the worst realistic latency scenario (PE-M2 × PE-L6).
3. **core-api Node process** (2 CPU, 1200 MB heap) — saturates only under pathological deep-pagination or agent-loop bursts (PE-M1, PE-H1); ceiling orders of magnitude above actual load.
4. **Postgres (8 GB / 4 CPU)** — comfortable to 100K+ captures; HNSW build memory during reindex (and /dev/shm until fixed) is the only pressure point.
5. **faster-whisper (8 GB / 4 CPU, no GPU)** — serial transcription; fine at personal cadence (#54/#57 track).
6. **Redis 400 MB noeviction** — extended OpenAI outage during bulk ingest could hit the ceiling; enqueues then fail loudly and daily-sweep recovers — designed failure mode, acceptable.

## Scaling Configuration Review

No autoscaling/replicas — correct for single-host Unraid; horizontal scaling explicitly out of scope. What exists is sensible: every service has `mem_limit`; four Node services pair `mem_limit: 1500m` with `--max-old-space-size=1200` (correct heap-to-cgroup margin); CPU caps oversubscribe 8 cores acceptably (anti-correlated load); Redis fail-loud back-pressure; rate-limit tiers + 17 bypass callers + mobile Bearer tier form admission control — internal callers unthrottled by design, which is why PE-M1's bound matters (bypass ≠ bounded work).

## Load Testing Requirements

Cannot be performed in this review (no tooling, no environment access). Priority order:

1. **Search scaling benchmark** — `scripts/benchmark-search.mjs` against synthetic 25K/50K corpora, ef_search sweep 40–100, p50/p99 → feeds #73 (PE-RI1).
2. **Bulk-ingest burst** — 500 multi-chunk documents at once: Redis headroom, embed-queue drain time with/without throttle, quantify PE-M2 batching win.
3. **Deep-pagination probe** — POST /search offset ∈ {0, 100, 1000, 10000} before/after PE-M1 cap; EXPLAIN ANALYZE on `hybrid_search`.
4. **Monthly-reflection dry run** on a high-volume synthetic month with per-iteration context-size logging — validates PE-H1 fix (context should plateau).
5. **SSE fan-out** — 10 concurrent `/system-health` SSE connections × 10 min; measure query rate before/after shared poller (PE-L1).

## Findings Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 1 |
| Medium | 3 |
| Low | 7 |
| Requires investigation | 1 |
| **Total** | **12** |

All 12 findings are carried forward from v4 as STILL OPEN (PE-M2 with a wording correction — the batch primitive exists but is unwired). Zero net-new performance findings from the Dependabot remediation waves.
