# Performance Engineer Findings

**Reviewer:** Performance Engineer
**Date:** 2026-04-18
**Target:** `C:/Users/Troy Davis/dev/personal/open-brain` (main, HEAD `9443f93`)
**Confidence:** Medium — code review only; no access to production metrics, `ai_audit_log`, HNSW recall data, or live RSS numbers. Load-testing tooling (`k6`/`ab`/`wrk`/`hey`/`vegeta`) not installed on this host — all findings are structural, not measured.

> This review is based on code and configuration analysis. Structural risks
> identified here should be validated with actual load tests on the
> homeserver, and by spot-checking `docker stats`, `SELECT * FROM ai_audit_log`,
> and `pg_stat_statements` output.

---

## SLO Baseline

| SLO | Stated Target | Instrumented? | Finding |
|-----|---------------|---------------|---------|
| RSS per process | **1.5 GB hard limit** (CLAUDE.md) | No | **Not enforced on most containers.** Only `faster-whisper` (8 GB), `voice-pipecat` (4 GB), `file-ingestion` (1.5 GB) carry `mem_limit`. `postgres`, `core-api`, `workers`, `slack-bot`, `voice-capture`, `web`, `cloudflared`, `financial-ingest`, `utility-ingest` have no limit. A runaway Node heap or Postgres `work_mem * 50 connections * 2 sort ops = 6.4 GB` spike has no ceiling. Violates the stated rule. |
| Monthly AI spend | $30 soft / $50 hard | Partial (`ai_audit_log` + optional proxy) | `budget-check` skill runs daily at 08:00 but does not circuit-break in-process — it only fires a Pushover alert. The only *enforced* throttle/pause lives inside `embed-capture` worker (`SpendTracker.check()`); entity extraction, synthesis, governance, skills are not gated on spend. The April-15 cost incident ($100+ overnight) confirms this gap. |
| Search latency | None stated | Zero | No p50/p95 measurement. No `pg_stat_statements` enabled in `postgresql.conf`. |
| Pipeline retry budget | 5 attempts / 2 h total + daily sweep | Yes | Enforced via BullMQ `PIPELINE_BACKOFF_DELAYS_MS` and `daily-sweep` cron. |
| Capture→searchable latency | None stated | No | No measurement exists for stage-by-stage duration aside from `pipeline_events.duration_ms`. |
| Embedding API latency | None stated | No | 60 s timeout in `EmbeddingService`; no p95 tracking. |

---

## Structural Performance Risk Register

| ID | Risk | Location | Severity | Load Scenario | Recommendation |
|----|------|----------|----------|---------------|----------------|
| **P1** | `mem_limit` missing on 9 of 12 containers — violates the 1.5 GB CLAUDE.md rule. One OOM in `workers` or `core-api` takes down the node. | `docker-compose.yml` | **Critical** | Any memory leak, large payload, stuck BullMQ job, or 128 k-char capture in the adaptive-truncation loop → unbounded RSS growth. | Add `mem_limit: 1536m` + `memswap_limit: 1536m` to all Node services; `mem_limit: 8g` on postgres (matches `shared_buffers: 2 GB + effective_cache_size: 6 GB`). Set `NODE_OPTIONS: --max-old-space-size=1280` (80 % of 1.5 GB) on every Node container. |
| **P2** | Access-stats queue has a consumer but **no producer anywhere in `core-api`**. Hebbian `access_count`, `last_accessed_at`, and `capture_associations` are never populated. The entire cognitive memory pathway (association boost, ACT-R decay from `last_accessed_at`) is dead code in production. | `packages/workers/src/queues/access-stats.ts` (producer absent in `packages/core-api/src/routes/search.ts`) | **High** | Every search. Measurable gap: `SELECT COUNT(*) FROM capture_associations` on homeserver will likely be 0. | Enqueue an `access-stats` job at the end of `registerSearchRoutes` → `searchService.search/searchWithRelated` call, using the returned capture IDs. Also enqueue from `getCaptureById`, `searchBrainTool`, and MCP tools. Job is already low-priority, attempts=1, non-blocking. |
| **P3** | `pruneStaleAssociations()` exists and is tested but **is never called**. `capture_associations` will grow unbounded once P2 is fixed (C(10,2)=45 pairs per search × hundreds of searches/day). | `packages/workers/src/jobs/update-access-stats.ts:178` | **High** | Unbounded DB growth after P2 is fixed. | Register it on a repeatable cron (e.g., daily at 03:30 after daily-sweep). Trivial fix — add 15 lines in `scheduler.ts`. |
| **P4** | Hebbian co-access upsert runs **45 sequential `INSERT ... ON CONFLICT` statements** in a `for (const [a,b] of pairs) { await db.insert(...) }` loop on the hot path of every search. No transaction, no batching. | `packages/workers/src/jobs/update-access-stats.ts:42-62` | **High** | Each search triggers an access-stats job (once P2 is fixed). 45 round-trips at 0.5-2 ms each = 25-100 ms per job. At 1 search/sec → saturates 1-2 of the 5-concurrency-access-stats workers. | Refactor to a single bulk `INSERT ... VALUES (…),(…),… ON CONFLICT ...` statement (Postgres handles this natively and it matches the UNIQUE index). Also wrap in a transaction. Target: 1 DB round-trip. |
| **P5** | `hybrid_search` SQL function ranks EVERY capture with an embedding, not a top-N. The `vector_ranked` CTE has no LIMIT; it computes cosine distance and ROW_NUMBER over all ~11 K rows today, and scales O(N) with the corpus. Combined with the FULL OUTER JOIN with `fts_ranked`, this is the single largest query the system runs. | `packages/shared/drizzle/0002_search_functions.sql` (and 0006, 0009) | **High** | At 100 K captures this becomes a 100 K-row CTE scan per search. Even HNSW doesn't help because the function doesn't use `ORDER BY embedding <=> q LIMIT k` — it uses `ROW_NUMBER() OVER (ORDER BY …)` with no LIMIT, forcing a sort of the whole set. | Push a `LIMIT match_count * 3` (or similar) into both CTEs before the RRF fusion. HNSW will use `ORDER BY <=> … LIMIT k` and complete in milliseconds regardless of corpus size. This is the single biggest future-scaling win. |
| **P6** | `hnsw.ef_search` is never set in runtime — pgvector's default (40) is used. TDD §4.6 says "start at 40, increase to 100 if recall drops below 95%" but no `SET hnsw.ef_search = X` statement exists in any SQL function, migration, or `postgresql.conf`. | `config/postgres/postgresql.conf` | Medium | At 11 K embeddings, recall is likely fine; at 100 K+, recall drop below 95 % is documented pgvector behavior. No data to know which side of the line the system is on. | Set `hnsw.ef_search = 80` in `postgresql.conf` (session default) or inside the `hybrid_search` function with `SET LOCAL`. Measure recall with a query-ground-truth set before ramping past 100. |
| **P7** | `MCP search_brain` tool defaults `include_related: true`. Every MCP search runs `spreading_activation` (2-hop entity-graph traversal) as a second full DB call. Spreading activation is STABLE PARALLEL SAFE but does multi-way JOINs on `entity_links` and `entity_relationships`. | `packages/core-api/src/mcp/tools/search-brain.ts:13` | Medium | Every tool call from Claude Desktop / OpenClaw. Cost is one extra Postgres call per MCP search. | Acceptable for now at 11 K captures but worth flagging — once entity graph grows, this 2-hop traversal will dominate. Consider making `include_related` opt-in for the "I just want fast lookup" case and measuring hop-1 vs. hop-2 cost separately. |
| **P8** | MCP `source_filter` and `tag_filter` are applied **post-search, in JS** after the SQL function returns `limit` rows. Combined with `threshold` filter, the tool may return fewer results than the user asked for even when matching data exists. | `packages/core-api/src/mcp/tools/search-brain.ts:54-61` | Medium | Any MCP search that sets `source_filter` on a rare source (e.g., `slack`). User asks for 10, gets 2. | Push source + tag filters into the SQL function (migration 0009 already added brain_view, capture_type, date filters — follow the same pattern). |
| **P9** | Postgres pool `max: 20`. Workers container spawns 13 workers with concurrencies [3, 2, 3, 5, 2, 2, 1, 2, 2, 5, 1, 1, 3] = 32 potential concurrent DB operations from one container, plus core-api. Under burst load this will starve. | `packages/shared/src/db/client.ts:15` | Medium | Daily-sweep + morning-brief + scheduled skills hitting simultaneously → connection queue builds → p95 latency spikes. | Raise pool `max` to 30-40 per container (Postgres `max_connections: 50` is the ceiling; at 2 containers × 20 = 40 you're close). Alternative: lower worker concurrency ceilings, or introduce pgBouncer in transaction pooling mode. |
| **P10** | `EmbeddingService.embedBatch()` passes **all truncated texts in one request** but does not chunk by total character count. 50 texts × 16 000 chars = 800 000 chars (~200 K tokens) exceeds the single-request input budget. | `packages/shared/src/services/embedding.ts:161-195` | Medium | Any batch embedding call with > ~40 medium-sized texts. Likely a 400 error that the adaptive-truncation retry doesn't handle (it only halves per-item, not batch size). | Split into sub-batches of N items when total char-sum > 100 K. The adaptive truncation path in `embedWithAdaptiveTruncation` is not reused by `embedBatch`. |
| **P11** | `trigger_cache` in `check-triggers.ts` is module-level in-process state with a 60 s TTL. On worker container restart (common after any deploy), cache is empty and every check-triggers job hits DB until warm. Also: the cache invalidation via `invalidateTriggerCache()` is process-local — if a user flips a trigger in the UI (core-api), the workers container won't see it for up to 60 s. | `packages/workers/src/jobs/check-triggers.ts:30-79` | Low | Toggling a trigger via the dashboard takes up to 1 minute to take effect in the pipeline. | Use `pg_notify('trigger_update')` from the core-api routes and LISTEN in workers — pattern already used elsewhere per CLAUDE.md. |
| **P12** | No `pg_stat_statements` or `auto_explain` enabled. No way to find the actual slow queries without restarting postgres with new shared_preload_libraries. | `config/postgres/postgresql.conf` | Low | Once a slow query appears (P5 at 100 K captures), you have no telemetry to pinpoint it. | Add `shared_preload_libraries = 'pg_stat_statements'` and `pg_stat_statements.max = 1000`; create the extension via migration. |
| **P13** | Adaptive truncation in `EmbeddingService.embedWithAdaptiveTruncation()` holds the full `text` string (potentially the full capture content) in memory until success. For an XLSX-extracted 50 MB text blob (file-ingestion's `MAX_TEXT_SIZE`), a single embedding call holds 50 MB + client buffer + SDK overhead = potentially 150-200 MB just for one call. | `packages/shared/src/services/embedding.ts:102-146` | Low | Rarely hit in practice (most captures are small), but a large document-pipeline run could stack up. | Pre-truncate to `MAX_EMBEDDING_CHARS` before entering the loop; don't carry the full text. Or refuse to embed texts > 100 K chars entirely and require the document-pipeline to chunk first. |
| **P14** | `memory-consolidation` skill at 04:00 Sunday mutates `captures` (soft-delete originals), migrates `entity_links`, repoints `capture_associations`, and creates new consolidated captures — all without an advisory lock. A concurrent daily-sweep or ingestion pipeline job touching the same capture IDs races. | `packages/workers/src/skills/memory-consolidation.ts` | Low | Theoretical; daily-sweep fires at 03:00, memory-consolidation at 04:00 so they don't overlap by design. But any manual `/admin/trigger-skill` call could. | Wrap the mutation block in a transaction with `pg_advisory_xact_lock` on a fixed hash (e.g., `hashtext('memory-consolidation')`). |

---

## Database Performance Assessment

| Finding | Location | Risk | Recommendation |
|---------|----------|------|----------------|
| HNSW indexes `m=16, ef_construction=64` — pgvector defaults. Documented that these are adequate for ≤100K embeddings. | `0001_custom_extensions.sql` | Low now, medium at 100 K+ | Keep defaults; re-benchmark at 50 K and tune `ef_search` per P6. |
| FTS: expression GIN index on `to_tsvector('english', content)` (no `tsv` column). Good — inserts are immediately searchable. | `0006_fts_search.sql`, scripts/init-schema.sql:187 | None | No action. |
| `captures.embedding IS NOT NULL AND deleted_at IS NULL` is checked in every search but there's no **partial index** with these predicates, so the planner scans the full B-tree and then filters. | `packages/shared/drizzle/0005_captures_deleted_at.sql` | Low | Create `CREATE INDEX ... WHERE embedding IS NOT NULL AND deleted_at IS NULL` as a partial HNSW index — smaller footprint, faster scans. |
| `pg_stat_statements` not enabled — no slow-query telemetry available. | `postgresql.conf` | Medium | Enable via `shared_preload_libraries`; requires postgres restart. |
| `work_mem = 64 MB` × `max_connections = 50` × potential 2-3 sort/hash ops per query = 6.4-9.6 GB peak — this blows the implicit 8 GB postgres mem_limit from TDD, and has no explicit ceiling in compose. | `postgresql.conf` + `docker-compose.yml` | Medium | Either lower `work_mem` to 16-32 MB, or set `mem_limit: 8g` and drop max_connections to 30. |
| `hybrid_search` FULL OUTER JOIN + no LIMIT push-down (see P5). Single most important query in the system. | `0009_search_filter_params.sql` | High | See P5. |
| `capture_associations` write path is sequential 45 inserts on the hot path (P4). | `update-access-stats.ts` | High | Batch insert (P4). |
| `capture_associations.weight` recomputation uses a subtraction of `last_co_access` from `accessedAt` **using the OLD `last_co_access` in the conflict update** — correct formula, but the `EXTRACT(EPOCH FROM …) / 3600.0` will be zero on the first update within the same second, driving weight to `co_access_count * exp(0) = co_access_count`. Not a bug, but the weighting behaves non-intuitively for rapid reuse. | `update-access-stats.ts:57` | Low | Acceptable; worth documenting. |

---

## Caching Effectiveness Assessment

- **Cache strategy identified:** Partial — several ad-hoc caches, no central strategy.
- **TTL discipline:** Inconsistent (60 s module-level in `check-triggers`, 5 min for autonomy level in CLAUDE.md notes, `TemplateCache` is process-lifetime).
- **Invalidation correctness risk:** **Medium.** `trigger_cache` is per-process — mutations from `core-api` do not invalidate the `workers` container's cache (P11).
- **Thundering herd exposure:** Low — single-user system; but `SkillExecution` concurrency=1 + aggregation pattern guards this implicitly.
- **Specific findings:**
  - `IngestDedup` uses Redis with a 5-minute TTL for content-hash dedup — correct, survives restart, shared across core-api and workers.
  - `TemplateCache` loads prompt templates once per process. Lives in `@open-brain/shared`. Good.
  - No Redis cache for `hybrid_search` result sets, trigger definitions, or active autonomy level across processes. For a single-user system, this is probably fine until multi-process coordination matters (P11).

---

## Concurrency and Async Assessment

| Observation | Detail |
|-------------|--------|
| **Worker concurrency budget** | 13 workers in one container with concurrencies summing to 32. Combined with the Postgres `pool.max = 20`, connection starvation is plausible under burst. |
| **Extract-entities parallelizes `linkPromises` via `Promise.all`** | `resolveOrCreateEntity` + `linkEntityToCapture` can issue dozens of simultaneous DB writes per capture. Each entity mention = 2 DB queries. Typical capture with 10 entities = 20 simultaneous DB requests per job. Combined with concurrency=2 on the worker, single capture can occupy 40 pool slots. |
| **Thread safety / shared mutable state** | `trigger_cache` module-level in `check-triggers.ts` mutated without lock. Single-threaded Node, so fine, but worth noting. No `SharedArrayBuffer` or worker threads — all I/O-bound. |
| **Blocking-in-async risks** | `embed-capture` throttle uses `await new Promise(resolve => setTimeout(resolve, 30_000))` — **blocks the worker slot for 30 s** during spend-throttle, rather than using BullMQ `DelayedError` (which it does for the pause path). Fine for concurrency=2 but holds a DB connection idle during throttle. |
| **Queue singleton enforcement** | `budget-check`, `daily-sweep`, `skill-execution`, `wiki-ingest` all set concurrency=1, correctly. |
| **Graceful shutdown** | `Promise.allSettled(workers.map(w => w.close()))` — proper. |

---

## Capacity Model (Qualitative)

**Binding resource at current scale (~11 K captures, single user):**
- **Postgres memory/connections** under skill burst; nothing hard today.
- **API budget ($50 hard)** for any unanticipated LLM-fanout bug — already hit once (April-15 cost incident).

**Next binding resource as system grows:**
1. **`hybrid_search` CTE scan (P5)** — at 100 K captures, current implementation goes from ~50 ms to 500 ms+ per search. HNSW index is effectively bypassed because there is no LIMIT push-down into the vector CTE.
2. **Postgres connection pool (P9)** — 2 containers × 20 pool slots < 13 workers × avg 2 concurrent + core-api requests.
3. **Node heap on workers container (P1)** — any single worker leaking (e.g., entity resolution map, skill agent-loop context) with no `mem_limit` → OOM kills the whole container, all 13 workers restart simultaneously → BullMQ retry storm.
4. **`capture_associations` table growth (P3)** — unbounded until prune is scheduled.

**Time to ceiling (rough, no data):**
- Search latency ceiling at ~100 K captures with P5 unfixed: weeks of OneDrive ingestion.
- Memory ceiling: one bad workflow, any day.
- Cost ceiling: one misrouted model alias, overnight (already happened).

---

## Scaling Configuration Review

| Area | Current | Finding |
|------|---------|---------|
| Replicas | 1 per service | Correct for single-user — no HPA needed. |
| Auto-scaling | None | Correct — not needed. |
| Resource limits | Only 3 of 12 containers | **P1 — add limits.** |
| Pool sizes | `pg.Pool max: 20`, Redis `maxRetriesPerRequest: 3` | Low — see P9. |
| Rate limits | In-memory sliding window, `strict: 20/min`, `default: 100/min`, `admin: 5/min` | Appropriate for single-user accident prevention. Bypass via `X-Open-Brain-Caller` is documented. |
| BullMQ concurrency | Sum = 32 across 13 workers | Potentially excessive given P9. |
| Postgres tunables | `shared_buffers: 2 GB`, `effective_cache_size: 6 GB`, `work_mem: 64 MB`, `max_connections: 50` | `work_mem * max_connections` peak = 3.2 GB; combined with `shared_buffers` = 5.2 GB typical, 8+ GB peak. Fits a host with 128 GB RAM but blows the `mem_limit: 8g` guidance. |

---

## Load Testing Requirements

These cannot be performed in code review. Recommend:

1. **Search fan-out test** — hit `/api/v1/search?q=X` at 5 rps for 5 min; watch p95 latency, postgres CPU, HNSW recall (compare top-10 vs. brute-force result sets).
2. **Corpus-scaling synthetic** — ingest 100 K synthetic captures; re-run search latency test; measure before/after P5 fix.
3. **Workers burst** — enqueue 500 captures in quick succession; watch worker RSS in `docker stats`, Postgres connection count (`pg_stat_activity`), BullMQ queue depth.
4. **MCP `include_related: true` vs `false`** — measure cost of spreading_activation at 11 K vs projected 100 K entities.
5. **Batch embedding test** — send 100-text batch to validate P10. Watch for 400 error.
6. **Memory-consolidation dry-run** — at 11 K captures, measure wall-clock and Postgres wait events for the Sunday 04:00 run.
7. **Single-process RSS under steady load** — 1-hour soak at realistic capture rate; record peak RSS per container to validate the implicit 1.5 GB rule.

---

## Findings Summary

| Severity | Count |
|----------|-------|
| Critical | 1 |
| High | 4 |
| Medium | 6 |
| Low | 3 |
| Total | **14** |

**Critical (P1):** Missing `mem_limit` on 9 containers — direct violation of the mandatory 1.5 GB CLAUDE.md rule.

**High (P2-P5):** Access-stats producer missing; prune never scheduled; Hebbian upsert is 45 serial writes; `hybrid_search` does not push LIMIT into vector CTE (primary scaling risk).

**Medium (P6-P11):** `hnsw.ef_search` unset, MCP `include_related` default + post-search filtering, pool sizing, batch embedding char-budget, trigger-cache invalidation cross-process.

**Low (P12-P14):** `pg_stat_statements` missing, adaptive-truncation holds full text, memory-consolidation lacks advisory lock.

**Top 3 actions to take first:**
1. **P1** — add `mem_limit` + `NODE_OPTIONS --max-old-space-size` to every container. Stops OOM risk cold.
2. **P5** — push `LIMIT` into `vector_ranked` CTE. One migration, massive future-scaling win.
3. **P2 + P3** — wire up access-stats producer and schedule `pruneStaleAssociations`. Closes the gap where the cognitive-memory layer is designed but inactive.
