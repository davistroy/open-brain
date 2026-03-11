import { sql } from 'drizzle-orm'
import type { Database } from '@open-brain/shared'
import type { CaptureRecord } from '@open-brain/shared'
import type { EmbeddingService } from '@open-brain/shared'

export interface SearchOptions {
  limit?: number
  temporalWeight?: number
  ftsWeight?: number
  vectorWeight?: number
  brainViews?: string[]
  captureTypes?: string[]
  dateFrom?: Date
  dateTo?: Date
  searchMode?: 'hybrid' | 'vector' | 'fts'
}

export interface SearchResult {
  capture: CaptureRecord
  score: number
  ftsScore?: number
  vectorScore?: number
}

type HybridSearchRow = {
  capture_id: string
  rrf_score: number
  fts_score: number
  vector_score: number
}

/** Row shape returned by SELECT * FROM captures WHERE id = ANY(...) */
type CaptureQueryRow = {
  id: string
  content: string
  content_hash: string
  capture_type: string
  brain_view: string
  source: string
  source_metadata: Record<string, unknown> | null
  tags: string[]
  embedding: number[] | null
  pipeline_status: string
  pipeline_attempts: number
  pipeline_error: string | null
  pipeline_completed_at: Date | null
  pre_extracted: Record<string, unknown> | null
  created_at: Date
  updated_at: Date
  captured_at: Date
  deleted_at: Date | null
  access_count: number
  last_accessed_at: Date | null
}

/**
 * Applies ACT-R-inspired temporal decay to a base similarity score.
 *
 * Matches the SQL actr_temporal_score function exactly:
 *   - if temporalWeight === 0.0 → returns baseScore unchanged (cold-start safe)
 *   - otherwise:
 *       hoursSince = max((now - createdAt) / 3600000, 0)
 *       decay      = exp(-0.01 * sqrt(hoursSince))
 *       result     = baseScore * decay * temporalWeight
 *                  + baseScore * (1 - temporalWeight)
 *
 * decay_rate is fixed at 0.01 (gentle decay; a capture from 1 week ago
 * retains ~85% of its decay factor; from 1 year ago ~27%).
 */
export function applyTemporalDecay(
  rrfScore: number,
  createdAt: Date | string,
  temporalWeight: number,
): number {
  if (temporalWeight === 0.0) {
    return rrfScore
  }

  const DECAY_RATE = 0.01
  const createdAtMs = createdAt instanceof Date ? createdAt.getTime() : new Date(createdAt).getTime()
  const hoursSince = Math.max((Date.now() - createdAtMs) / 3_600_000, 0)
  const decay = Math.exp(-DECAY_RATE * Math.sqrt(hoursSince))

  return rrfScore * decay * temporalWeight + rrfScore * (1 - temporalWeight)
}

/**
 * SearchService orchestrates hybrid search over captures.
 *
 * Flow:
 *   1. Embed the query string via EmbeddingService
 *   2. Call hybrid_search SQL function (FTS + vector RRF) with filter params
 *   3. Fetch matching capture rows
 *   4. Apply ACT-R temporal decay in-memory (no per-row DB round-trip)
 *   5. Return top N results sorted by final score descending
 *
 * Filters (brainViews, captureTypes, dateFrom, dateTo) are pushed into the
 * SQL functions as WHERE clause parameters — no in-memory post-filtering.
 */
export class SearchService {
  constructor(
    private db: Database,
    private embeddingService: EmbeddingService,
  ) {}

  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const {
      limit = 10,
      temporalWeight = 0.0,
      ftsWeight = 0.5,
      vectorWeight = 0.5,
      brainViews,
      captureTypes,
      dateFrom,
      dateTo,
      searchMode = 'hybrid',
    } = options

    // Build filter params — NULL means "no filter" in the SQL functions
    const pgBrainViews = brainViews && brainViews.length > 0
      ? `{${brainViews.join(',')}}` : null
    const pgCaptureTypes = captureTypes && captureTypes.length > 0
      ? `{${captureTypes.join(',')}}` : null
    const pgDateFrom = dateFrom ? dateFrom.toISOString() : null
    const pgDateTo = dateTo ? dateTo.toISOString() : null

    let hybridRows: { rows: { capture_id: string; rrf_score: number; fts_score: number; vector_score: number }[] }

    if (searchMode === 'fts') {
      // FTS-only path: no embedding call, works even when LiteLLM is down,
      // searches captures regardless of whether they have embeddings yet.
      hybridRows = await this.db.execute<HybridSearchRow>(sql`
        SELECT capture_id::text, rrf_score, fts_score, vector_score
        FROM fts_only_search(
          ${query},
          ${limit},
          ${pgBrainViews}::text[],
          ${pgCaptureTypes}::text[],
          ${pgDateFrom}::timestamptz,
          ${pgDateTo}::timestamptz
        )
      `)
    } else {
      // Step 1: embed the query (throws EmbeddingUnavailableError if LiteLLM is down)
      const queryVector = await this.embeddingService.embed(query)
      const vectorLiteral = `[${queryVector.join(',')}]`

      // Step 2: call hybrid_search with filters — Postgres applies WHERE clauses
      hybridRows = await this.db.execute<HybridSearchRow>(sql`
        SELECT capture_id::text, rrf_score, fts_score, vector_score
        FROM hybrid_search(
          ${query},
          ${vectorLiteral}::vector(768),
          ${limit},
          ${ftsWeight},
          ${vectorWeight},
          ${pgBrainViews}::text[],
          ${pgCaptureTypes}::text[],
          ${pgDateFrom}::timestamptz,
          ${pgDateTo}::timestamptz
        )
      `)
    }

    if (hybridRows.rows.length === 0) {
      return []
    }

    const captureIds = hybridRows.rows.map(r => r.capture_id) as string[]

    // Step 3: fetch capture rows for all returned IDs in one query
    // Pass as PostgreSQL array literal — Drizzle's sql`` sends JS arrays as
    // record tuples ($1,$2) which cannot be cast to uuid[].
    const pgArrayLiteral = `{${captureIds.join(',')}}`
    const captureRows = await this.db.execute<CaptureQueryRow>(sql`
      SELECT *
      FROM captures
      WHERE id = ANY(${pgArrayLiteral}::uuid[])
    `)

    const captureMap = new Map<string, CaptureRecord>()
    for (const row of captureRows.rows) {
      captureMap.set(row.id, row as unknown as CaptureRecord)
    }

    // Step 4: apply ACT-R temporal decay in-memory — zero extra DB round-trips
    const results: SearchResult[] = []

    for (const hybridRow of hybridRows.rows as HybridSearchRow[]) {
      const capture = captureMap.get(hybridRow.capture_id)
      if (!capture) continue

      const finalScore = applyTemporalDecay(hybridRow.rrf_score, capture.created_at, temporalWeight)

      results.push({
        capture,
        score: finalScore,
        ftsScore: hybridRow.fts_score,
        vectorScore: hybridRow.vector_score,
      })
    }

    // Step 5: sort by final score descending and return
    // No in-memory filtering needed — filters are applied in SQL
    results.sort((a, b) => b.score - a.score)
    return results.slice(0, limit)
  }
}
