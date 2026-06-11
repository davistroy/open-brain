# Performance Engineer Findings

**Reviewer:** Performance Engineer
**Date:** 2026-06-10
**Target:** /home/davistroy/dev/personal/open-brain (v1.6.0, main)
**Confidence:** Medium — code review only, no live environment access. No load-test tooling available on this host (k6/ab/wrk/hey/vegeta all absent); no access to production `pg_stat_statements`, Grafana dashboards, or `docker stats`.

> Note: This review is based on code and configuration analysis. Load testing requires a
> production-equivalent environment and is not part of a code-based architecture review.
> Structural risks identified here should be validated with actual load tests.

> **Prior-review closure (2026-04-18 review, remediated via PRs #180–#189):** verified closed,
> not re-reported — per-container `mem_limit` now set on all 17 services with `NODE_OPTIONS
> --max-old-space-size=1200` inside 1500m limits; `BYPASS_CALLERS` hoisted to module scope;
> ingest N+1 fixed; `hybrid_search()` LIMIT push-down landed (migration 0027); batch-UPSERT
> invariant in `update-access-stats.ts` holds (single multi-VALUES statement); BullMQ
> concurrency discipline (default 2, documented singletons at 1) matches the documented policy;
> email-classify is rule-based per item with one aggregated LLM digest call (cost-tiering
> aggregation rule honored).

---

## SLO Baseline

| SLO | Stated Target | Instrumented? | Finding |
|-----|--------------|--------------|---------|
| HTTP request latency | **None stated** | Yes — `openbrain_http_request_duration_seconds` histogram (`packages/core-api/src/routes/metrics.ts`), Prometheus + Grafana deployed | Instrumentation exists but no p95/p99 targets or alert rules defined anywhere in `config/prometheus/` or docs. See M6. |
| Search latency | None (calibration data exists: LAB_NOTEBOOK Entry 108, `scripts/benchmark-search.mjs`) | Partial — benchmark script with ef_search sweep 40–100, p50/p95 output | Good calibration discipline, but point-in-time and manual; no recurring regression check as the corpus grows. |
| Memory per process | 1.5 GB RSS/process (CLAUDE.md) | Yes — enforced via `mem_limit` + `--max-old-space-size=1200` on all Node services | Closed since prior review. Compliant. |
| Capacity | TDD §4199: ~4KB/capture, 250K captures ≈ 1GB Postgres | No live tracking against the model | `storage-audit` (Sun 3 AM) reports sizes; no threshold alerting tied to the capacity model. |
| AI spend | $30 soft / $50 hard monthly | Yes — `budget-check` daily + `ai_audit_log` cost fields (P03) | Adequate for the stated budget. |

## Structural Performance Risk Register

| ID | Risk | Location | Severity | Load Scenario | Recommendation |
|----|------|----------|----------|--------------|----------------|
| H1 | **O(N²) pairwise cosine self-join** — `JOIN captures b ON a.id < b.id` with `(1 - (a.embedding <=> b.embedding)) > threshold` computes a 768-dim distance for every pair of complete embedded captures. The HNSW index cannot serve a join predicate; `LIMIT 5000` applies only **after** the `ORDER BY similarity DESC` forces full evaluation of all pairs. At the current ~11K embedded captures this is ~60M distance computations (minutes of single-backend CPU); at 50K captures ~1.25B (hours); at the TDD's 250K design point ~31B — structurally infeasible. Two independent copies of the pattern run weekly: memory-consolidation (Sun 4 AM) and capture-dedup-sweep (Sat 4 AM). | `packages/workers/src/skills/memory-consolidation-query.ts:142-158`; `packages/workers/src/skills/capture-dedup-sweep.ts:164-186` | **High** | Weekly batch; quadratic growth with corpus size. Daily email/financial/voice ingestion makes this the fastest-growing cost in the system. | Replace the self-join with a per-row HNSW k-NN probe: for each capture (or only captures newer than the last sweep), `SELECT id FROM captures ORDER BY embedding <=> $row LIMIT k` with `SET hnsw.ef_search`, filter by threshold — O(N·log N) and incremental-friendly. Extract one shared implementation for both skills. |
| M4 | **No CPU limits anywhere; faster-whisper `large-v3` on CPU** (`WHISPER__DEVICE: cpu`, int8). A multi-minute voice memo saturates most of the 8C/8T host for roughly real-time duration, contending with Postgres, core-api, and any concurrently running batch job. No `cpus:`/`cpuset:` on any of the 17 services. | `docker-compose.yml:382-399` (faster-whisper); whole file (no `cpus` keys) | Medium | Voice memo upload during a search session, or coinciding with the Sat/Sun 3–5 AM batch window. | Add `cpus: 4` (or cpuset pinning) to faster-whisper; consider `distil-large-v3`/`medium` — int8 large-v3 on a 2019-era 8-core is the slowest sensible choice. Optionally cap file-ingestion and voice-pipecat too. |
| M5 | **Spreading activation cost scales with entity degree, uncapped.** `spreading_activation()` hop-2 uses an OR-join over `entity_relationships` plus a `NOT IN` subquery and `GROUP BY el.capture_id`. A hub entity (a person/project linked to thousands of captures) makes hop-1/hop-2 candidate sets explode; no per-entity degree cap or candidate LIMIT before the final top-N. Runs on **every MCP search** (`include_related` defaults true for MCP) with top-5 seeds. | `packages/shared/drizzle/0012_spreading_activation.sql`; `packages/core-api/src/services/search.ts:386-405` | Medium (**requires investigation**) | Agent-driven MCP usage (OpenClaw) issuing frequent searches as entity-graph density grows. | Add a degree cap in `seed_entities` (exclude or truncate entities with > X links); record `EXPLAIN ANALYZE` at current scale as a baseline. Actual cost depends on entity degree distribution — not measurable from code. |
| L4 | Voice upload **buffer-and-rebuild** (`c.req.formData()` then rebuilt `FormData`) holds the entire audio file in core-api memory before proxying to voice-capture. Documented decision (D126) and bounded by the strict rate tier, but no explicit file-size cap is enforced in the proxy route — a 100 MB recording would be fully buffered inside the 1.2 GB heap. | `packages/core-api/src/routes/voice-captures.ts` | Low | Concurrent large uploads (unlikely single-user; possible via client retry loops). | Reject with 413 on a `Content-Length`/file-size cap (e.g., 50 MB) before buffering. |
| L5 | **Loki log driver runs in default blocking mode** — no `mode: non-blocking` in any `logging:` block. Timeouts are short (2s, 3 retries, 800ms backoff), but a slow-but-reachable Loki can backpressure container stdout writes on every service simultaneously (single shared Loki). | `docker-compose.yml` (all 17 `logging:` blocks) | Low | Loki degradation on homeserver during heavy log volume. | Add `mode: non-blocking` + `max-buffer-size: 4m` to the shared logging options; accept the already-documented log-loss trade-off. |

## Database Performance Assessment

| Finding | Location | Risk | Recommendation |
|---------|----------|------|----------------|
| **M1 — `SET hnsw.ef_search` executes on an arbitrary pooled connection.** `SearchService` issues `SET` (session-scoped, deliberately not `SET LOCAL` because Drizzle auto-commits) via `this.db.execute()`, then calls `hybrid_search()` in a **separate** `db.execute()`. With `pg.Pool` (max 20), the two statements can check out different connections — the search may run on a session still at pgvector's default `ef_search=40`, not the calibrated 60. It converges over time (every search re-issues SET on some connection) but is nondeterministic per query, silently degrades recall after restarts, and a `hnsw_ef_search` config change propagates unevenly across the pool. | `packages/core-api/src/services/search.ts:221-241`; `packages/shared/src/db/client.ts` | Medium | Run SET + hybrid_search on one client: `db.transaction(async tx => { SET LOCAL ...; SELECT ... FROM hybrid_search(...) })`, or check out a dedicated `pool.connect()` client for both statements. |
| **M2 — `ts_rank_cd` recomputes `to_tsvector('english', content)` per candidate row.** The GIN expression index serves only the `@@` predicate; ranking re-parses the full `content` of every matching row before the `LIMIT match_count*4` (ORDER BY rank requires full evaluation of all `@@` matches). For common query terms matching thousands of rows — including long document captures — FTS rank cost is O(matches × content length). Same pattern in `fts_only_search`. | `packages/shared/drizzle/0027_search_hnsw_ef_search.sql` (`fts_ranked` CTE); migration 0006 | Medium | Add a `GENERATED ALWAYS AS (to_tsvector('english', content)) STORED` column with a plain GIN index; rank against the stored column. Eliminates per-row re-parse at ~1KB/row storage cost (non-issue per the TDD capacity table). |
| **L1 — Connection budget is thin.** `max_connections = 50`; core-api pool (max 20) + workers pool (max 20) = 40 ceiling, leaving ~7 effective slots (minus superuser reserve) for psql, `pg_dump` (P04a pre-wipe + backups), `benchmark-search.mjs`, and any future service calling `createDb()`. A third DB-consuming service at the default pool size would exhaust connections under burst. | `config/postgres/postgresql.conf:6`; `packages/shared/src/db/client.ts:15` | Low | Document the budget; lower per-service `max` to 10 (ample for single-user, worker concurrency ≤2) or raise `max_connections` to 80. `work_mem = 64MB` is sized for current low concurrency — revisit if pools grow. |
| **L2 — Search hydration and capture list fetch the `embedding` column unnecessarily.** `SELECT * FROM captures WHERE id = ANY(...)` (search, twice — primary + related) and `.select()` in `CaptureService.list()` (limit ≤ 100) serialize the 768-dim vector (~6–9KB as text) per row that no consumer uses — up to ~1MB wasted per max-size list call. | `packages/core-api/src/services/search.ts:254, 350`; `packages/core-api/src/services/capture.ts:135` | Low | Enumerate columns excluding `embedding` in both hydration queries. |
| **Verified good:** `hybrid_search()` LIMIT push-down with overquery factor 4 (0027) bounds both HNSW traversal and FTS scan; HNSW `m=16, ef_construction=64` appropriate for 768-dim at this corpus size; partial index on `deleted_at IS NULL`; hot FK tables (`entity_links`, `capture_associations`, `pipeline_events`) have covering indexes; `postgresql.conf` sensibly tuned for the 8 GB container (shared_buffers 2GB, effective_cache_size 6GB, random_page_cost 1.1, `log_min_duration_statement = 1000` gives slow-query visibility). | — | — | — |

## Caching Effectiveness Assessment

- **Cache strategy identified:** Partial (deliberate — single-user, read-your-own-writes; no Redis response cache, which is reasonable)
- **TTL discipline:** Consistent where caches exist — autonomy level 5-min module caches (slack-bot `server.ts`, workers `base-skill.ts`) with fail-safe default `observe`; `TemplateCache` is unbounded-lifetime but correct (templates are static files, eagerly preloaded for fail-fast)
- **Invalidation correctness risk:** Low — autonomy changes propagate within ≤5 min (documented, acceptable); template cache has explicit `clear()` for dev
- **Thundering herd exposure:** No — single instance per service, in-memory caches, no shared cache to stampede; rate limiter is an in-memory sliding window (correct for one core-api replica; would need a Redis-backed limiter only if core-api ever scales horizontally)
- **Specific findings:** No caching of query embeddings — every hybrid/vector search pays an OpenAI embedding round-trip (~50–200 ms + T3 cost), and agent/MCP usage repeats queries. A small LRU keyed on query text (TTL ~1h) would cut both latency and spend. Noted as an optimization opportunity, not counted as a risk finding.

## Concurrency and Async Assessment

- **BullMQ discipline holds:** 16 workers audited; default concurrency 2 everywhere, documented singletons at 1 (`budget-check`, `daily-sweep`, `skill-execution`, `wiki-ingest`, `prune-associations`, access-stats trigger). `removeOnComplete`/`removeOnFail` bounds set on all queues (counts 10–500) — Redis job-history growth is bounded.
- **Scheduler cron slots:** verified staggered per the slot registry; no two repeatables share a minute. Sat 4 AM `capture-dedup-sweep` and Sun 4 AM `memory-consolidation` are on different days — relevant since both run the H1 quadratic query.
- **Fire-and-forget patterns are correctly non-blocking:** access-stats enqueue (5 sites, `.catch` to debug log), Hebbian co-access try/catch, Slack auto-response `.then()/.catch()`. None block the response path.
- **Event-loop blocking:** low risk. Embedding truncation (16K chars adaptive) bounds string ops; document parsing is delegated to the Python sidecar (serialized via `/tmp/process.lock` under a concurrency-2 worker — occasional wasted worker slot, benign). The ~10KB vector literal built per search is negligible.
- **Shared mutable state:** rate limiter Maps and autonomy caches are module-scoped per process — safe in Node's single-threaded model; no worker_threads in use.
- **M3 — Redis has no `--maxmemory` / `--maxmemory-policy`:** `redis-server --appendonly yes` inside a 512m `mem_limit` container. If memory grows (queue backlog during an OpenAI outage with 5-attempt/2h-backoff retries + AOF buffers), the failure mode is a cgroup OOM-kill of the whole Redis container (all queues, scheduler state, Composio meter, admin reset tokens) rather than a controlled error. For BullMQ the correct policy is `noeviction` with maxmemory under the cgroup limit so writes fail loudly first: `--maxmemory 400mb --maxmemory-policy noeviction`. (Medium)

## Capacity Model (Qualitative)

Binding constraints, in the order they bind:

1. **CPU (8C/8T, no GPU) is the first wall.** Two dominant consumers: faster-whisper large-v3 CPU transcription (real-time-ish bursts, uncapped — M4) and the weekly O(N²) similarity scans (H1). Interactive load is trivial (single user, ≤ a few req/s), so CPU pain manifests first as latency interference during bursts, then as batch-window overrun as the quadratic jobs grow.
2. **The quadratic similarity jobs are the first thing that breaks outright.** At current ingestion rates (daily email digests, financial captures, voice, files), every corpus doubling quadruples the Sat/Sun scan cost. Estimated infeasibility threshold ~50–100K captures (hours of single-backend CPU inside the 3–5 AM window, colliding with the next cron slot). This precedes any search-path problem.
3. **Interactive search scales fine to the design point.** With LIMIT push-down + HNSW, hybrid search is ~O(log N); 250K captures ≈ 1GB table + low-hundreds-MB HNSW index, comfortably inside 2GB shared_buffers / the 8GB container. Spreading activation (M5) is the wildcard — its cost tracks entity-graph density, not capture count.
4. **Memory is not a near-term constraint:** ~34 GB of container limits against 128 GB host RAM. Disk (32 TB) is a non-issue.
5. **External APIs (OpenAI embeddings) govern ingestion throughput**, already mitigated by queue-and-retry; the budget circuit breaker bounds the blast radius.

## Scaling Configuration Review

- **Memory limits:** all 17 services capped; Node heaps (`--max-old-space-size=1200`) sit correctly under 1500m container limits with ~300m headroom for non-heap RSS. Compliant with the 1.5 GB rule.
- **CPU limits:** none (M4) — the one real gap in resource governance.
- **Replicas/autoscaling:** N/A by design (single host, single user). In-memory rate limiter and module caches correctly assume one instance; flagged as a horizontal-scaling precondition only (P33 is explicitly scale-gated).
- **Rate-limit tiers** (default 100, strict 20, admin 5, mobile 200 per token hash/min) are sensible for the threat model; internal-IP defense-in-depth on bypass claims is in place.
- **Postgres 8 GB limit vs config:** internally consistent (2GB shared_buffers, 6GB effective_cache_size).

## Load Testing Requirements

Cannot be performed in this review (no tooling on host, no live access). Recommended scenarios, in priority order:

1. **Quadratic-job rehearsal at synthetic scale:** clone the DB, synthesize 50K/100K embedded captures, time `querySimilarPairs` / `queryDuplicatePairs` with `EXPLAIN (ANALYZE, BUFFERS)` — validates or refutes H1's growth estimate before it bites.
2. **Search latency under whisper interference:** run `scripts/benchmark-search.mjs` while a 3-minute audio file transcribes; measure p95 delta (validates M4).
3. **ef_search application check:** restart core-api, run 20 searches, confirm via `pg_stat_activity` sampling or recall comparison that the configured ef_search actually applies (validates M1).
4. **Redis backlog soak:** block egress to api.openai.com for 2h, ingest 500 captures, watch Redis RSS vs the 512m limit through the 5-attempt backoff cycle (validates M3).
5. **MCP burst:** 200 `search_brain` calls (`include_related=true`) over 60s — exercises spreading activation + access-stats enqueue + strict-tier behavior (validates M5).
6. **Recurring search-latency regression check:** wire `benchmark-search.mjs` into the monthly maintenance cron, appending results to LAB_NOTEBOOK, so HNSW recall/latency drift is caught as the corpus grows (addresses M6's measurement half).

## Cross-Domain Note (for functional reviewers)

**L3 —** `POST /api/v1/search` pagination is structurally broken: `searchService.search()` is called with `limit: body.limit`, then the route slices `results.slice(body.offset, body.offset + body.limit)` — any `offset >= limit` always returns an empty page (`packages/core-api/src/routes/search.ts:95-128`). Counted as Low here because the performance consequence is that clients compensate by inflating `limit` (max 50); it is primarily a correctness bug.

## Findings Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 1 |
| Medium | 6 |
| Low | 5 |
| Requires investigation | 1 (M5 — counted within Medium) |
| **Total** | **12** |

**High:** H1 (O(N²) similarity self-joins ×2 weekly).
**Medium:** M1 (ef_search pool-connection mismatch), M2 (ts_rank tsvector recompute), M3 (Redis no maxmemory policy), M4 (no CPU limits / whisper large-v3 CPU), M5 (spreading activation degree explosion — requires investigation), M6 (no SLO targets/alerts despite full histogram instrumentation).
**Low:** L1 (connection budget headroom), L2 (embedding column over-fetch), L3 (search offset pagination, perf-adjacent), L4 (voice upload buffering without size cap), L5 (Loki blocking log-driver mode).
