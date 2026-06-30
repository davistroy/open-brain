import { sql, type SQL } from 'drizzle-orm'
import type { Database } from '@open-brain/shared'
import { logger } from '@open-brain/shared'

// ============================================================
// PE-H1 / ADR-0003 — per-row HNSW k-NN similarity scan
// ============================================================
//
// Replaces the O(N²) `captures a JOIN captures b ON a.id < b.id` cosine
// self-joins (memory-consolidation + capture-dedup-sweep) with one indexed
// k-NN probe per candidate row. The HNSW index (`captures_embedding_hnsw_idx`)
// cannot serve a join predicate — it answers single-point nearest-neighbour
// queries — so the only way to make the scan O(N·log N) is to issue one
// `ORDER BY embedding <=> <probe> LIMIT k` per candidate.
//
// IMPORTANT (verified by EXPLAIN ANALYZE on the production 11K corpus, Entry 173):
// the probe vector MUST be supplied as a **scalar subquery**
// `(SELECT embedding FROM captures WHERE id = $cid)`. Postgres evaluates it as a
// one-shot InitPlan constant, which lets pgvector use the HNSW index. A
// *materialized* CTE (`WITH cand AS MATERIALIZED ...`) instead forces a Seq Scan
// + top-N heapsort — silently O(N²). Do not "simplify" the probe to a CTE.
//
// Memory: the candidate enumeration returns IDs only; embeddings are never
// pulled into the process (the probe reads them in-DB). Far below the
// 1.5 GB/process ceiling at any corpus size the single HNSW index supports.

/** Default k for the per-candidate k-NN probe (generous for min-cluster-size 3). */
export const DEFAULT_K = 50

/** Default HNSW ef_search for the probes (matches search.hnsw_ef_search default). */
export const DEFAULT_EF_SEARCH = 60

/** `app_settings` key holding the last successful memory-consolidation scan timestamp. */
export const MEMORY_CONSOLIDATION_WATERMARK_KEY = 'memory_consolidation_last_scan_at'

/** `app_settings` key holding the last successful capture-dedup-sweep scan timestamp. */
export const CAPTURE_DEDUP_WATERMARK_KEY = 'capture_dedup_last_scan_at'

/**
 * Read the incremental-scan watermark (last successful scan timestamp) from
 * `app_settings`. Returns null when absent or unparseable — callers treat null
 * as "full scan", which is the safe default (a missing/garbled watermark must
 * never cause captures to be silently skipped).
 */
export async function readScanWatermark(db: Database, key: string): Promise<Date | null> {
  try {
    const res = await db.execute<{ value: unknown }>(
      sql`SELECT value FROM app_settings WHERE key = ${key}`,
    )
    const raw = res.rows[0]?.value
    if (raw == null) return null
    const d = new Date(typeof raw === 'string' ? raw : String(raw))
    return Number.isNaN(d.getTime()) ? null : d
  } catch (err) {
    logger.warn({ err, key }, '[hnsw-similarity] failed to read scan watermark; treating as full scan')
    return null
  }
}

/**
 * Record a successful scan's start time as the new watermark (upsert). Swallows
 * failures: a failed watermark write must not fail the skill — the worst case is
 * the next run repeats a full scan, which is safe (idempotent flagging / re-cluster).
 */
export async function writeScanWatermark(db: Database, key: string, ts: Date): Promise<void> {
  try {
    await db.execute(sql`
      INSERT INTO app_settings (key, value, updated_at)
      VALUES (${key}, to_jsonb(${ts.toISOString()}::text), now())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
    `)
  } catch (err) {
    logger.warn({ err, key }, '[hnsw-similarity] failed to write scan watermark')
  }
}

/** A pair of similar captures, canonically ordered so `capture_id_a < capture_id_b`. */
export interface SimilarPair {
  capture_id_a: string
  capture_id_b: string
  similarity: number
}

export interface FindSimilarPairsOptions {
  /** Cosine similarity threshold; neighbours with `similarity > threshold` are kept (strict, matches the old self-join). */
  threshold: number
  /** Global cap on returned pairs (sorted by similarity desc) — mirrors the old `LIMIT`. */
  maxPairs: number
  /** k for each per-candidate k-NN probe. Default {@link DEFAULT_K}. */
  k?: number
  /** HNSW ef_search applied (via `SET LOCAL`) for the duration of the probe transaction. Default {@link DEFAULT_EF_SEARCH}. */
  efSearch?: number
  /**
   * Exclude `source = 'consolidation'` rows from BOTH the candidate set and the
   * neighbour set. The dedup sweep sets this true; memory-consolidation leaves it
   * false (it may re-cluster previously-consolidated reflections). Preserving this
   * per-call asymmetry is required for the side-by-side cluster-diff to be ∅.
   */
  excludeConsolidationSource?: boolean
  /**
   * Incremental scoping: only captures created strictly after this timestamp are
   * used as CANDIDATES. Each candidate still probes the FULL corpus, so new↔new and
   * new↔old pairs are found; only the unchanged old↔old space is skipped (already
   * processed in prior runs). `null`/omitted = full scan (first run / validation).
   */
  candidatesSince?: Date | null
}

interface CandidateRow {
  id: string
  [key: string]: unknown
}

interface NeighborRow {
  neighbor_id: string
  similarity: string // Postgres ::text cast of the numeric similarity
  [key: string]: unknown
}

/**
 * Find capture pairs with cosine similarity above `threshold` via per-candidate
 * HNSW k-NN probes. Returns canonically-ordered pairs (`a < b`), de-duplicated,
 * sorted by similarity descending, capped at `maxPairs`.
 */
export async function findSimilarPairs(
  db: Database,
  options: FindSimilarPairsOptions,
): Promise<SimilarPair[]> {
  const {
    threshold,
    maxPairs,
    k = DEFAULT_K,
    efSearch = DEFAULT_EF_SEARCH,
    excludeConsolidationSource = false,
    candidatesSince = null,
  } = options

  // Composable, parity-preserving filter fragments.
  const candidateSourceFilter: SQL = excludeConsolidationSource
    ? sql`AND source <> 'consolidation'`
    : sql``
  const sinceFilter: SQL = candidatesSince
    ? sql`AND created_at > ${candidatesSince.toISOString()}::timestamptz`
    : sql``
  const neighborSourceFilter: SQL = excludeConsolidationSource
    ? sql`AND n.source <> 'consolidation'`
    : sql``

  // 1. Enumerate candidate IDs (IDs only — no embeddings into the process).
  //    Errors PROPAGATE: a failed scan must not let the caller advance its scan
  //    watermark (which would permanently skip the un-scanned captures).
  const candidates = await db.execute<CandidateRow>(sql`
    SELECT id::text AS id
    FROM captures
    WHERE pipeline_status = 'complete'
      AND deleted_at IS NULL
      AND embedding IS NOT NULL
      ${candidateSourceFilter}
      ${sinceFilter}
    ORDER BY id ASC
  `)

  if (candidates.rows.length === 0) {
    return []
  }

  // 2. Probe each candidate against the full corpus inside ONE transaction so
  //    SET LOCAL hnsw.ef_search is deterministic and scoped (PE-M1 primitive).
  const pairMap = new Map<string, SimilarPair>()
  const efSearchInt = Math.trunc(efSearch)
  const kInt = Math.trunc(k)

  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL hnsw.ef_search = ${sql.raw(String(efSearchInt))}`)

    for (const cand of candidates.rows) {
      const cid = cand.id
      const probe = await tx.execute<NeighborRow>(sql`
        SELECT n.id::text AS neighbor_id,
               (1 - (n.embedding <=> (SELECT embedding FROM captures WHERE id = ${cid}::uuid)))::text AS similarity
        FROM captures n
        WHERE n.id <> ${cid}::uuid
          AND n.deleted_at IS NULL
          AND n.pipeline_status = 'complete'
          AND n.embedding IS NOT NULL
          ${neighborSourceFilter}
        ORDER BY n.embedding <=> (SELECT embedding FROM captures WHERE id = ${cid}::uuid)
        LIMIT ${kInt}
      `)

      for (const nb of probe.rows) {
        const sim = parseFloat(nb.similarity)
        if (!(sim > threshold)) continue
        const [a, b] = cid < nb.neighbor_id ? [cid, nb.neighbor_id] : [nb.neighbor_id, cid]
        const key = `${a}|${b}`
        const existing = pairMap.get(key)
        if (!existing || sim > existing.similarity) {
          pairMap.set(key, { capture_id_a: a, capture_id_b: b, similarity: sim })
        }
      }
    }
  })

  // 3. Sort by similarity descending and cap (mirrors the old `ORDER BY ... DESC LIMIT`).
  const pairs = Array.from(pairMap.values())
  pairs.sort((x, y) => y.similarity - x.similarity)
  return pairs.slice(0, maxPairs)
}
