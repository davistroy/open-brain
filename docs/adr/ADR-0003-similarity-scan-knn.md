# ADR-0003: Replace Pairwise O(N²) Cosine Self-Joins with Per-Row HNSW k-NN Probes

**Status:** Accepted (deployed Phase 7)
**Date:** 2026-06-15
**Deciders:** Troy Davis (single-user system owner)
**Driven by:** `/ultra-plan` remediation of arch-review v3 — finding PE-H1 (change set CS-7)

---

## Context

Two weekly batch jobs find similar capture pairs by a full pairwise self-join on the embedding column:

- `packages/workers/src/lib/memory-consolidation-query.ts:142–158` (`querySimilarPairs`, threshold 0.92, Sundays `0 4 * * 0`)
- `packages/workers/src/skills/capture-dedup-sweep.ts:164–186` (`queryDuplicatePairs`, threshold 0.95, Saturdays `0 4 * * 6`)

Both run:

```sql
SELECT a.id, b.id, (1 - (a.embedding <=> b.embedding)) AS similarity
FROM captures a JOIN captures b ON a.id < b.id
WHERE ... AND (1 - (a.embedding <=> b.embedding)) > $threshold
ORDER BY similarity DESC
LIMIT $MAX_PAIRS
```

This is O(N²): the HNSW index (`captures_embedding_hnsw_idx`, migration 0001) **cannot serve a join predicate** — k-NN indexes answer single-point nearest-neighbour queries, not "all pairs within threshold." The `LIMIT` applies only *after* the planner has computed every pairwise distance. At the current ~11K embedded captures that is ~60M distance computations per run; it quadruples per corpus doubling and becomes infeasible at the documented ~50–100K horizon (the review's fastest-growing cost). The `MAX_PAIRS = 5000` cap bounds the *output*, not the *computation*.

## Decision

**Rewrite both scans as per-row HNSW k-NN probes behind a shared library, `packages/workers/src/lib/hnsw-similarity.ts`.**

For each candidate capture, issue a single indexed nearest-neighbour query:

```sql
-- inside db.transaction so SET LOCAL applies to this connection (see PE-M1)
SET LOCAL hnsw.ef_search = 60;
SELECT id, (1 - (embedding <=> $1)) AS similarity
FROM captures
WHERE id <> $candidateId
  AND deleted_at IS NULL
  AND pipeline_status = 'complete'
ORDER BY embedding <=> $1            -- HNSW-served, indexed
LIMIT $k;                            -- k = 50
-- then filter in SQL/TS: keep similarity > threshold
```

Emit ordered pairs (`a.id < b.id`) so the existing Union-Find cluster-formation logic in `memory-consolidation.ts` is unchanged. **Preserve all D28 semantics:** consolidation threshold 0.92 / min cluster 3 / top-5 clusters; dedup threshold 0.95. Exclude `deleted_at IS NOT NULL` and `source = 'consolidation'` rows exactly as today.

**Incremental scoping** per job: process only captures created since the last run (timestamp in `app_settings`), probing each against the full corpus — this finds all new↔new and new↔old pairs while skipping the unchanged old↔old space that produced nothing new last week. The first post-deploy run uses a full scan (every `complete` capture as a candidate) to establish the baseline.

Two dependencies ship inside CS-7 ahead of this rewrite:

- **PE-M1** (prerequisite): wrap `SET LOCAL hnsw.ef_search` + the query in `db.transaction()` so ef_search is deterministic on a pooled connection. The k-NN probes inherit this primitive.
- **PE-M2** (migration 0034): `content_tsvector GENERATED ALWAYS … STORED` + GIN index, so FTS ranking stops recomputing `to_tsvector` per row. Independent of k-NN but lands in the same search-performance change set.

## Alternatives Considered

1. **Keep the self-join, add a coarse pre-filter (e.g. bucket by a cheap hash, only join within buckets).** Rejected — still O(N²) within buckets, adds a bucketing scheme to maintain, and locality-sensitive hashing on 768-dim vectors is its own tuning problem when an HNSW index already exists.
2. **Materialize a periodic similarity-pairs table incrementally.** Rejected as premature — adds a table + maintenance job; the per-row k-NN probe is cheap enough (O(N·log N)) that precomputation buys nothing at this horizon.
3. **Raise `MAX_PAIRS` / accept and revisit at scale.** Rejected — the cap bounds output, not the quadratic computation; the wall-clock blowout happens regardless of how many pairs are kept.
4. **External vector DB (Qdrant) for the similarity scan.** Out of scope — Qdrant evaluation is independently scale-gated (issue #73, ≥50K embeddings); this rewrite keeps the work in pgvector where the data lives and is correct at any scale the single HNSW index supports.

## Consequences

**Positive:** O(N·log N) instead of O(N²); incremental scoping makes steady-state runs touch only the week's new captures. Same cluster output (validated side-by-side). Shared library removes the duplicated self-join SQL across two files.

**Negative / risks:**
- **Recall is approximate.** HNSW k-NN with `ef_search = 60` and `k = 50` may miss a true match beyond the 50th neighbour or outside the graph's explored frontier. Mitigation: `k = 50` is generous for cluster formation (min cluster size 3); the dedup sweep flags for *review*, not auto-action, so a rare miss is low-impact. Tune `k`/`ef_search` if side-by-side validation shows dropped clusters.
- **Cluster-membership drift.** The rewrite could subtly change which captures cluster together. Mitigation (mandatory before cutover): run the new probe and the old self-join against the **production 11K snapshot** and diff cluster output; keep the old query behind a flag for one weekend cycle.
- **Memory ceiling (1.5 GB/process):** k-NN streams one candidate's neighbours at a time — far below the self-join's materialization. No concern.

**Verification:** Benchmark on a synthetic 50K-capture corpus showing the O(N·log N) curve vs the O(N²) baseline; cluster-output diff == ∅ against the production snapshot; `scripts/benchmark-search.mjs` p95 unchanged (the new STORED tsvector column should improve it). Batch-UPSERT invariant for `capture_associations` preserved (single multi-VALUES INSERT in the consolidation skill, unchanged).

**Rollback:** the shared library is additive; both jobs revert to the prior self-join query in one commit. Migration 0034 (tsvector column) is independently revertible (`DROP COLUMN content_tsvector` + restore the old expression index).
