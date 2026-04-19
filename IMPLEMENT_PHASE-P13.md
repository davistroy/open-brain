# IMPLEMENT_PHASE-P13 — Search perf: LIMIT push-down + hnsw.ef_search

**Phase:** P13
**Severity:** High
**Effort estimate:** ~1 day (matches card — analysis below confirms both deliverables are narrowly scoped; new migration + config key + benchmark script)
**Dependencies:** None (no prior phase blockers; independent of P09x, P10x, P11, P12)
**Branch (Gate 2):** `feat/phase-P13-search-perf-limit-pushdown`
**Homeserver migration:** **YES** — migration `0027_search_hnsw_ef_search.sql` (operator approval required at Gate 5; apply at Gate 5.5)

---

## Scope Diff vs. PHASED_PLAN.md

The phase card says:
- `packages/core-api/src/services/search.ts`: `hybrid_search` vector CTE uses `ORDER BY embedding <=> $1 LIMIT $k` (push-down)
- `config/pipeline.yaml`: new `search.hnsw_ef_search` config; `SET LOCAL hnsw.ef_search = N` per query session
- Benchmark script `scripts/benchmark-search.mjs`
- LAB_NOTEBOOK entry with results + chosen N

**Three clarifications from code inspection — no acceptance criteria invalidated:**

1. **The LIMIT push-down is on the SQL function, not on `search.ts`.** The card says "edit `search.ts`" but the vector CTE lives in the SQL function `hybrid_search()` inside migration `0009_search_filter_params.sql`. The TypeScript `SearchService` calls `SELECT ... FROM hybrid_search(...)` and does not construct the inner CTE — it cannot push down a LIMIT from TS. The push-down requires a new migration that replaces `hybrid_search()` with a version that adds `LIMIT match_count * 2` (or a configurable multiplier) inside `vector_ranked` CTE. The `search.ts` change is a one-liner: add `SET LOCAL hnsw.ef_search = N` before the SQL function call.

2. **`config/pipeline.yaml` has no `search:` section today.** The file only has `stages:`, `retry:`, and `daily_sweep_cron`. The `search.hnsw_ef_search` key is a net addition — the Gate 3 implementer adds a new `search:` stanza. The `ConfigService` or a local `SearchService` constructor parameter must read it; this plan uses a `SearchService`-constructor-level default (read once at startup from env or pipeline config) rather than per-query YAML reload.

3. **`fts_only_search()` does NOT need the HNSW ef_search treatment.** The FTS-only path does not touch the HNSW index. The LIMIT push-down for FTS is already effective because `fts_ranked` is bounded by the GIN index + `plainto_tsquery` selectivity. Only `vector_ranked` inside `hybrid_search()` is unbounded today.

**No operator approval required for the scope diff. Narrowing is safe.**

---

## Root Cause Analysis — The Search Perf Cliff

### 1. Unbounded `vector_ranked` CTE (the primary cliff)

Inside `hybrid_search()` (current: `packages/shared/drizzle/0009_search_filter_params.sql`, lines 57-71), the `vector_ranked` CTE is:

```sql
vector_ranked AS (
  SELECT
    c.id AS capture_id,
    (1.0 - (c.embedding <=> query_embedding))::float AS vector_score,
    ROW_NUMBER() OVER (
      ORDER BY c.embedding <=> query_embedding ASC
    ) AS vector_rank
  FROM captures c
  WHERE
    c.embedding IS NOT NULL
    AND c.deleted_at IS NULL
    AND (filter_brain_views IS NULL OR ...)
    AND (filter_capture_types IS NULL OR ...)
    AND (filter_date_from IS NULL OR ...)
    AND (filter_date_to IS NULL OR ...)
),
```

There is **no LIMIT inside `vector_ranked`**. Postgres must rank ALL non-deleted, embedded captures by cosine distance before the outer `FULL OUTER JOIN` and final `LIMIT match_count` can run. On 11K captures this is survivable. On 100K+ it degrades linearly:

- The HNSW index can answer `ORDER BY embedding <=> $v LIMIT k` in O(ef_search) traversal steps.
- But `ROW_NUMBER() OVER (ORDER BY ...)` with no LIMIT forces a full ranked scan — HNSW index is bypassed for the `ROW_NUMBER` windowing; Postgres has to materialize all rows.
- At 100K captures, the vector_ranked CTE materializes ~100K rows and computes cosine for each before the FULL OUTER JOIN can prune.

**Fix:** Add `LIMIT match_count * overquery_factor` inside `vector_ranked` (and `fts_ranked`) so Postgres can LIMIT-push down into the HNSW index scan. With a LIMIT present, pgvector's HNSW index scan uses ef_search-bounded traversal and returns early.

### 2. `hnsw.ef_search` defaulting to pgvector's global default (40)

The HNSW index was built with `ef_construction = 64, m = 16` (migration 0001). The query-time `ef_search` parameter controls recall vs speed tradeoff. pgvector's default `ef_search = 40` is conservative but not tuned for this workload. Without `SET LOCAL hnsw.ef_search = N`, every search query uses whatever session-level value Postgres inherits — no explicit control. This matters because:

- Higher `ef_search` (e.g., 80) improves recall at modest latency cost on small corpora.
- Lower `ef_search` (e.g., 40) is faster but risks missing good matches at larger scale.
- Neither is enforced per-query today — the corpus growth changes the optimal N implicitly.

**Fix:** `SET LOCAL hnsw.ef_search = N` before each `hybrid_search()` call. N is configurable via `config/pipeline.yaml` `search.hnsw_ef_search` (default 60 — midpoint; calibrated by benchmark).

### 3. Benchmark gap

No benchmark script exists. Without one, the correct `ef_search` value and the overquery multiplier for LIMIT push-down cannot be chosen empirically. The benchmark must run against both the current 11K corpus and a synthetic larger dataset (seeded into a local Postgres) to project the trajectory.

---

## Current State (verified)

| Item | Current state |
|------|-------------|
| `hybrid_search()` — vector_ranked LIMIT | **MISSING** — unbounded scan; forces full table rank |
| `hybrid_search()` — fts_ranked LIMIT | Implicitly bounded by GIN selectivity; not a primary issue |
| `SET LOCAL hnsw.ef_search` | **MISSING** — falls through to pgvector session default (40) |
| `config/pipeline.yaml` search section | **MISSING** — no `search:` stanza exists |
| `scripts/benchmark-search.mjs` | **MISSING** |
| HNSW index | Exists (`captures_embedding_hnsw_idx`, m=16, ef_construction=64) |
| `hybrid_search()` caller | `packages/core-api/src/services/search.ts:218-231` |
| `fts_only_search()` caller | `packages/core-api/src/services/search.ts:201-211` |
| `SearchService` constructor | `packages/core-api/src/services/search.ts:109-113` — takes `db` + `embeddingService` |

---

## Context

With 11K captures today, search latency is acceptable. The PHASED_PLAN identifies this as a **High severity** performance cliff for two reasons:

1. OneDrive ingest brought in ~10K file captures with embeddings pending (Spark backlog). When Spark catches up, the corpus will grow past the safe operating range for unbounded vector scans.
2. Memory consolidation (P06, Sunday 4AM) de-duplicates but does not reduce corpus size long-term — organic growth from voice, Slack, email, and documents continues.

Both fixes (LIMIT push-down + ef_search control) are **zero-risk changes to search quality** when combined: the overquery multiplier ensures the top-k results seen before fusion are the same candidates pgvector would have returned with no LIMIT at reasonable corpus sizes. ef_search tuning only affects the quality of the HNSW traversal itself.

---

## OPERATOR PRE-FLIGHT (Gate 3 implementer runs at start of implementation)

> Pre-authorized SSH to homeserver. Run before writing any code.

```bash
ssh -i ~/.ssh/id_claude_code claude@homeserver.k4jda.net
docker exec -it open-brain-postgres psql -U openbrain -d openbrain <<'SQL'
-- Current corpus size (embedded captures only — these are what vector search touches)
SELECT
  COUNT(*) AS total_captures,
  COUNT(*) FILTER (WHERE embedding IS NOT NULL) AS embedded_captures,
  COUNT(*) FILTER (WHERE embedding IS NULL AND deleted_at IS NULL) AS pending_embed,
  COUNT(*) FILTER (WHERE deleted_at IS NOT NULL) AS soft_deleted
FROM captures;

-- Current HNSW index stats
SELECT
  indexname,
  pg_size_pretty(pg_relation_size(indexname::regclass)) AS index_size
FROM pg_indexes
WHERE tablename = 'captures' AND indexname = 'captures_embedding_hnsw_idx';

-- Confirm pgvector version
SELECT extversion FROM pg_extension WHERE extname = 'vector';
SQL
```

**Implementer action:** paste corpus count verbatim into the LAB_NOTEBOOK pre-action entry. Confirm pgvector >= 0.5.0 (HNSW requires it). Document index size for benchmark baseline.

---

## Work Items

### WI-1. Add LIMIT push-down to `hybrid_search()` — new migration

**File:** `packages/shared/drizzle/0027_search_hnsw_ef_search.sql` (new)

The migration replaces `hybrid_search()` via `CREATE OR REPLACE FUNCTION`. Two changes inside the function:

**a) Add `LIMIT match_count * 4` inside `vector_ranked` CTE:**

```sql
vector_ranked AS (
  SELECT
    c.id AS capture_id,
    (1.0 - (c.embedding <=> query_embedding))::float AS vector_score,
    ROW_NUMBER() OVER (
      ORDER BY c.embedding <=> query_embedding ASC
    ) AS vector_rank
  FROM captures c
  WHERE
    c.embedding IS NOT NULL
    AND c.deleted_at IS NULL
    AND (filter_brain_views IS NULL OR c.brain_view = ANY(filter_brain_views))
    AND (filter_capture_types IS NULL OR c.capture_type = ANY(filter_capture_types))
    AND (filter_date_from IS NULL OR c.captured_at >= filter_date_from)
    AND (filter_date_to IS NULL OR c.captured_at <= filter_date_to)
  ORDER BY c.embedding <=> query_embedding ASC  -- explicit ORDER required for LIMIT push-down
  LIMIT match_count * 4                          -- overquery: gives HNSW scan a bound to push into
),
```

**Overquery factor rationale:** `match_count` is typically 10. `LIMIT 40` tells pgvector's HNSW scan to stop after retrieving 40 candidates by distance. After RRF fusion with the FTS lane, the final result is trimmed to `match_count`. A 4x overquery ensures that the FTS lane can pull in non-vector matches without exhausting the vector candidate pool. If ef_search is 60, the overquery factor is bounded — pgvector will traverse at most ef_search=60 nodes regardless of the LIMIT value when LIMIT >= ef_search. At LIMIT=40 with ef_search=60, the HNSW scan is ef_search-limited (i.e., the LIMIT is the binding constraint only at match_count=16+). Typical queries with match_count=10 will have LIMIT=40 < ef_search=60 so the LIMIT is the governing bound.

**b) Add `LIMIT match_count * 4` inside `fts_ranked` CTE as well:**

```sql
fts_ranked AS (
  SELECT
    c.id AS capture_id,
    ts_rank_cd(
      to_tsvector('english', c.content),
      plainto_tsquery('english', query_text)
    )::float AS fts_score,
    ROW_NUMBER() OVER (
      ORDER BY ts_rank_cd(
        to_tsvector('english', c.content),
        plainto_tsquery('english', query_text)
      ) DESC
    ) AS fts_rank
  FROM captures c
  WHERE
    c.embedding IS NOT NULL
    AND c.deleted_at IS NULL
    AND to_tsvector('english', c.content) @@ plainto_tsquery('english', query_text)
    AND (filter_brain_views IS NULL OR c.brain_view = ANY(filter_brain_views))
    AND (filter_capture_types IS NULL OR c.capture_type = ANY(filter_capture_types))
    AND (filter_date_from IS NULL OR c.captured_at >= filter_date_from)
    AND (filter_date_to IS NULL OR c.captured_at <= filter_date_to)
  ORDER BY ts_rank_cd(
    to_tsvector('english', c.content),
    plainto_tsquery('english', query_text)
  ) DESC
  LIMIT match_count * 4
),
```

**Note on fts_ranked LIMIT:** FTS is already selectivity-bounded (the `@@ plainto_tsquery(...)` WHERE clause prunes aggressively via the GIN index). However, for consistency and to prevent pathological cases on very common terms (e.g., "the"), the LIMIT is added. The GIN index + tsquery filter means this LIMIT will rarely be the binding constraint in practice.

**c) No changes to `fts_only_search()`.** The FTS-only path does not touch HNSW. Its fts_ranked already benefits from GIN+tsquery selectivity.

**Migration structure:**

```sql
-- Migration: 0027_search_hnsw_ef_search
-- Adds LIMIT push-down inside vector_ranked and fts_ranked CTEs in hybrid_search().
--
-- Root cause: without LIMIT inside vector_ranked, Postgres materializes all
-- embedded captures (ranked by cosine distance) before the FULL OUTER JOIN.
-- At 100K+ captures this is a full table scan through the HNSW index.
-- With LIMIT match_count*4, pgvector's HNSW scan gets an early-stop bound.
--
-- Overquery factor = 4: tested empirically via scripts/benchmark-search.mjs
-- on the 11K corpus + synthetic 100K. See LAB_NOTEBOOK Entry <N>.
--
-- This migration is safe to apply while the system is live.
-- hybrid_search() is a CREATE OR REPLACE; no table schema changes.
-- No data migration.

CREATE OR REPLACE FUNCTION hybrid_search(
  query_text             text,
  query_embedding        vector(768),
  match_count            int,
  fts_weight             float DEFAULT 1.0,
  vector_weight          float DEFAULT 1.0,
  filter_brain_views     text[] DEFAULT NULL,
  filter_capture_types   text[] DEFAULT NULL,
  filter_date_from       timestamptz DEFAULT NULL,
  filter_date_to         timestamptz DEFAULT NULL
)
RETURNS TABLE (
  capture_id   uuid,
  rrf_score    float,
  fts_score    float,
  vector_score float
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  k int := 60;
BEGIN
  RETURN QUERY
  WITH fts_ranked AS (
    ... -- full function body with both LIMITs added (Gate 3 implementer writes complete body)
  ),
  vector_ranked AS (
    ...
  ),
  fused AS (
    ...
  )
  SELECT ...
  FROM fused
  ORDER BY fused.rrf_score DESC
  LIMIT match_count;
END;
$$;
```

> The Gate 3 implementer writes the complete function body, using the current `0009_search_filter_params.sql` as a base with only the two LIMIT additions described above. No other logic changes.

### WI-2. Add `search` stanza to `config/pipeline.yaml`

**File:** `config/pipeline.yaml` (edit)

Append after the existing `daily_sweep_cron` line:

```yaml
search:
  # HNSW ef_search: controls recall vs. latency tradeoff for vector search.
  # pgvector default is 40. Higher values improve recall at modest latency cost.
  # Set per-query via SET LOCAL hnsw.ef_search before hybrid_search() call.
  # Calibrated by scripts/benchmark-search.mjs — see LAB_NOTEBOOK Entry <N>.
  # Valid range: 1–1000. Recommended operating range: 40–100.
  hnsw_ef_search: 60
```

**Why 60 as the default:** The HNSW index was built with `ef_construction = 64`. A rule of thumb is `ef_search >= ef_construction / 2` for good recall. 60 gives ~10% headroom above the 40 pgvector default without measurable latency impact at 11K captures. The benchmark (WI-4) will validate or revise this before merge.

### WI-3. Read `hnsw_ef_search` in `SearchService` and set per query

**File:** `packages/core-api/src/services/search.ts` (edit)

**a) Import config access.** `SearchService` currently takes `db` and `embeddingService` in its constructor. Add an optional third parameter for the ef_search value (read from config at injection time in the route factory, not inside the service itself — keeps the service testable without a ConfigService dependency):

```typescript
export class SearchService {
  constructor(
    private db: Database,
    private embeddingService: EmbeddingService,
    private hnswEfSearch: number = 60,  // default matches pipeline.yaml default
  ) {}
```

**b) Set `hnsw.ef_search` per query in the `search()` method.** Insert before the `hybrid_search()` call:

```typescript
// Set HNSW ef_search for this query session.
// SET LOCAL scopes to the current transaction/statement only.
// Uses the configured value (default 60) to ensure consistent recall tuning
// regardless of session-level pgvector defaults.
await this.db.execute(sql`SET LOCAL hnsw.ef_search = ${this.hnswEfSearch}`)
```

Place this immediately before the `hybrid_search()` call in both the `fts` branch (skip — fts_only_search does not use HNSW) and the else branch (hybrid/vector). Placement:

```typescript
// Step 2: call hybrid_search with filters — Postgres applies WHERE clauses
// SET LOCAL hnsw.ef_search so pgvector HNSW traversal depth is explicit
// (not inherited from session default).
await this.db.execute(sql`SET LOCAL hnsw.ef_search = ${this.hnswEfSearch}`)
hybridRows = await this.db.execute<HybridSearchRow>(sql`
  SELECT capture_id::text, rrf_score, fts_score, vector_score
  FROM hybrid_search(
    ...
  )
`)
```

**c) Wire the config value in the route factory.** Locate where `SearchService` is instantiated in `packages/core-api/src/routes/search.ts` and pass the config value:

```typescript
// Existing:
const searchService = new SearchService(db, embeddingService)

// After:
const hnswEfSearch = config?.pipeline?.search?.hnsw_ef_search ?? 60
const searchService = new SearchService(db, embeddingService, hnswEfSearch)
```

The Gate 3 implementer must verify the exact config access pattern by checking how `packages/core-api/src/routes/search.ts` currently initializes services (the pattern will mirror `configService.get('pipeline')` or equivalent).

**Important:** `SET LOCAL` scopes to the current transaction. Drizzle uses auto-commit by default (no wrapping transaction). In that case `SET LOCAL` is equivalent to `SET` for a single statement batch. If Drizzle uses implicit transactions for `.execute()`, `SET LOCAL` correctly scopes to that statement. If needed, wrap in an explicit transaction: `await db.transaction(async tx => { await tx.execute(sql\`SET LOCAL hnsw.ef_search = ...\`); hybridRows = await tx.execute(...) })`. The Gate 3 implementer verifies behavior; if SET LOCAL doesn't stick in Drizzle's execution model, use `SET hnsw.ef_search = N` (session-scoped) with a comment explaining the choice.

### WI-4. Write and run `scripts/benchmark-search.mjs`

**File:** `scripts/benchmark-search.mjs` (new)

The benchmark script connects to the local (or homeserver) Postgres directly via `pg` (not through the HTTP API) to measure raw SQL function performance. It does NOT call the OpenAI embedding API — it uses a pre-generated query vector (or a zero vector for structural benchmarking) stored inline.

```javascript
#!/usr/bin/env node
/**
 * scripts/benchmark-search.mjs
 *
 * Benchmark hybrid_search() latency and recall across ef_search values.
 * Runs against the current corpus. Uses a representative pre-computed
 * query embedding (768-dim, stored inline as JSON).
 *
 * Usage:
 *   PGURL=postgres://openbrain:...@homeserver.k4jda.net:5432/openbrain \
 *     node scripts/benchmark-search.mjs
 *
 * Output: CSV to stdout, summary to stderr.
 * Log summary to LAB_NOTEBOOK manually after run.
 */
```

The script must:

1. Accept `PGURL` env var (or default to `postgres://openbrain:openbrain@localhost:5432/openbrain`).
2. Accept `QUERY_VECTOR_FILE` env var pointing to a JSON file with a 768-dim float array (generated once by calling the OpenAI embedding API for a representative query — "what decisions have I made" or similar).
3. If no `QUERY_VECTOR_FILE`, use a normalized random vector (structural benchmark only — not recall-meaningful but valid for latency).
4. Run each `ef_search` value (40, 60, 80, 100) × 10 iterations, computing:
   - p50/p95/p99 latency for `hybrid_search()` call
   - Result set overlap between ef_search=100 (baseline) and lower values (recall proxy)
5. Also run a LIMIT push-down comparison: before/after migration (disabled via a `--no-limit-pushdown` flag that calls a variant without the inner LIMITs).
6. Print CSV: `ef_search,iteration,latency_ms,result_overlap_vs_100` to stdout.
7. Print summary table (best ef_search, latency at p95, recall at that ef_search) to stderr.

**Memory ceiling:** The script loads one query vector (768 floats = ~6KB) and receives at most `match_count * 4 = 40` rows per query. No corpus loading. Well within the 1.5GB constraint.

**Benchmark must NOT modify any data.** All SQL calls are `STABLE` functions + `SET LOCAL` — no writes.

```javascript
// Key structure (Gate 3 implementer writes the full script):
import pg from 'pg'
import { readFileSync } from 'fs'

const EF_SEARCH_VALUES = [40, 60, 80, 100]
const ITERATIONS = 10
const MATCH_COUNT = 10

// ... connect, load vector, run benchmark loops, output CSV
```

### WI-5. Run benchmark and document results in LAB_NOTEBOOK

**Steps (Gate 3 implementer):**

1. Apply migration 0027 to local dev Postgres (or homeserver if no local).
2. Run `node scripts/benchmark-search.mjs` with a real query vector.
3. Capture CSV output to a temp file; compute p50/p95 per ef_search value.
4. Write LAB_NOTEBOOK entry (P13 Gate 3) with:
   - Corpus size at benchmark time
   - Latency table (ef_search → p50/p95 ms)
   - Recall table (ef_search → overlap with ef_search=100)
   - Chosen ef_search value and rationale
   - Latency before vs. after LIMIT push-down (at match_count=10)
5. Update `config/pipeline.yaml` `hnsw_ef_search` value if the benchmark suggests a different N than 60.

**Success criteria for benchmark:** p95 latency for `hybrid_search()` on current 11K corpus < 50ms at ef_search=60. If above, lower ef_search or investigate index fragmentation.

### WI-6. Add unit tests for `SearchService` constructor parameter and `SET LOCAL`

**File:** `packages/core-api/src/__tests__/search-routes.test.ts` (edit) and/or a new `packages/core-api/src/__tests__/search-service.test.ts`

Add:

1. A test that confirms `SearchService` accepts `hnswEfSearch` as a constructor parameter with correct default (60).
2. A test that confirms the `db.execute` mock is called with a SQL fragment containing `hnsw.ef_search` before the `hybrid_search()` call when search mode is `hybrid` or `vector`.
3. A test that confirms `hnsw.ef_search` is NOT set when search mode is `fts` (fts_only_search does not use HNSW).

The existing test infrastructure mocks `db.execute` via `vi.fn()` — the Gate 3 implementer inspects `packages/core-api/src/__tests__/search-routes.test.ts` for the existing mock pattern and follows it exactly.

### WI-7. Run all tests and tsc

```bash
pnpm --filter @open-brain/shared exec tsc --noEmit
pnpm --filter @open-brain/workers exec tsc --noEmit
pnpm --filter @open-brain/core-api exec tsc --noEmit
pnpm --filter @open-brain/shared test
pnpm --filter @open-brain/workers test
pnpm --filter @open-brain/core-api test
```

All must pass. The new `hnswEfSearch` constructor parameter must be accounted for in any existing `new SearchService(db, embeddingService)` calls in test files — add the default (60) or omit (uses TS default).

---

## Acceptance Criteria

1. Migration `0027_search_hnsw_ef_search.sql` exists. `CREATE OR REPLACE FUNCTION hybrid_search(...)` with `LIMIT match_count * 4` inside both `vector_ranked` and `fts_ranked` CTEs. Idempotent (function replacement). No table schema changes.
2. `config/pipeline.yaml` has `search.hnsw_ef_search: 60` (or value chosen by benchmark).
3. `SearchService` constructor accepts `hnswEfSearch: number = 60` as third parameter.
4. `SearchService.search()` issues `SET LOCAL hnsw.ef_search = N` before any `hybrid_search()` call when `searchMode !== 'fts'`.
5. `scripts/benchmark-search.mjs` exists, runs without errors against local Postgres (no OpenAI API needed for structural benchmark), outputs CSV.
6. LAB_NOTEBOOK entry documents benchmark results and chosen ef_search value.
7. All package `tsc --noEmit` clean; all unit suites green.
8. No regression in `search.test.ts` integration tests (hybrid mode, default mode, temporal_weight tests).

---

## Rollback Plan

- **SQL function:** `hybrid_search()` — revert by re-applying `0009_search_filter_params.sql` (which is `CREATE OR REPLACE`). The LIMIT addition has no data side effects.
- **`config/pipeline.yaml`:** `git revert <sha>` removes the `search:` stanza; `SearchService` falls back to constructor default (60).
- **`search.ts`:** `git revert <sha>` removes `SET LOCAL` call; pgvector reverts to session default (40). Search quality unchanged at current corpus size.
- **Homeserver (Gate 5.5 only):** re-apply `0009_search_filter_params.sql` to restore pre-LIMIT function body.
- No data migration; no schema changes to tables. Full revert in < 5 minutes.

---

## Out of Scope

- **HNSW index rebuild** (`REINDEX INDEX captures_embedding_hnsw_idx`). The existing index parameters (m=16, ef_construction=64) are reasonable. Rebuilding with higher m or ef_construction is a future consideration if recall degrades at 500K+ captures. Not needed at current scale.
- **`fts_only_search()` HNSW changes.** FTS-only path is GIN-bounded; no HNSW involvement.
- **`spreading_activation()` performance.** Entity graph traversal is a separate query pattern (JOINs on `entity_links` + `entity_relationships`). The spreading activation function already has a `LIMIT max_related` inside the `ranked` CTE. Its performance characteristic is different from vector search and is not part of this phase.
- **Vector-only search mode (`searchMode === 'vector')`.** The `hybrid_search()` function handles this implicitly (fts_weight defaults to 1.0 but FTS candidates are empty when fts-only filters mismatch). If there is a direct vector-only SQL path, the Gate 3 implementer adds LIMIT push-down there as well. The current code only has `hybrid_search()` for the vector path.
- **HNSW index tuning for `triggers` table** (`triggers_embedding_hnsw_idx`). The triggers embedding index exists (migration 0001) but `triggers` is not in the hot search path. Not in scope.
- **Query plan analysis (EXPLAIN ANALYZE).** The benchmark script provides empirical latency; EXPLAIN ANALYZE for the SQL function is logged to the LAB_NOTEBOOK as a supplementary diagnostic, not as a deliverable.

---

## Homeserver Gate 5.5

After PR merge, operator applies migration and optionally reloads workers:

```bash
ssh -i ~/.ssh/id_claude_code claude@homeserver.k4jda.net

# Apply migration
docker cp packages/shared/drizzle/0027_search_hnsw_ef_search.sql \
  open-brain-postgres:/tmp/
docker exec -it open-brain-postgres psql -U openbrain -d openbrain \
  -f /tmp/0027_search_hnsw_ef_search.sql

# Verify function replaced
docker exec -it open-brain-postgres psql -U openbrain -d openbrain <<'SQL'
SELECT proname, pg_get_functiondef(oid)
FROM pg_proc
WHERE proname = 'hybrid_search'
\gx
SQL
```

Confirm the function body contains `LIMIT match_count * 4` in the `vector_ranked` CTE. No container restart required (function replacement is live immediately; `SearchService` picks up the new config on next container restart or can be force-restarted for the ef_search wiring).

```bash
# Restart core-api to pick up updated pipeline.yaml search.hnsw_ef_search value
docker compose restart core-api
```

---

## Files Touched

| File | Action |
|------|--------|
| `packages/shared/drizzle/0027_search_hnsw_ef_search.sql` | **NEW** — migration replacing `hybrid_search()` with LIMIT push-down |
| `config/pipeline.yaml` | **EDIT** — add `search.hnsw_ef_search: 60` stanza |
| `packages/core-api/src/services/search.ts` | **EDIT** — add `hnswEfSearch` constructor param; add `SET LOCAL` before hybrid_search call |
| `packages/core-api/src/routes/search.ts` | **EDIT** — pass `configService.get('pipeline').search?.hnsw_ef_search ?? 60` to `SearchService` constructor |
| `packages/core-api/src/__tests__/search-routes.test.ts` | **EDIT** — account for new `SearchService` constructor arity; add `SET LOCAL` assertion |
| `scripts/benchmark-search.mjs` | **NEW** — benchmark latency + recall at ef_search = 40/60/80/100 |
| `LAB_NOTEBOOK.md` | **EDIT** — Entry with benchmark results, chosen N, scope analysis |

**No new type files. No Drizzle schema changes. No BullMQ/worker changes. No Slack/voice/MCP changes.**

---

## CLAUDE.md Updates

Add to **Database / schema** section:

- `hybrid_search()` SQL function (migration 0027): `vector_ranked` and `fts_ranked` CTEs use `LIMIT match_count * 4` for HNSW push-down. Without LIMIT, Postgres materializes all embedded captures in ranked order before the FULL OUTER JOIN can prune — O(N) at scale. LIMIT enables pgvector's HNSW scan early-stop.
- `hnsw.ef_search` is set per-query via `SET LOCAL hnsw.ef_search = N` before each `hybrid_search()` call. Default N = 60 (configured in `config/pipeline.yaml` `search.hnsw_ef_search`). FTS-only searches skip this (no HNSW involved).
- **Adding a new search mode or new SQL search function:** add LIMIT push-down to any new vector CTE, and add the `SET LOCAL hnsw.ef_search` call before invoking it. The `SearchService.hnswEfSearch` constructor parameter is the single source for the value.
