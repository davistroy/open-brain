import { sql } from 'drizzle-orm'
import type { Database } from '@open-brain/shared'
import type { CaptureRecord } from '@open-brain/shared'
import type { EmbeddingService } from './embedding.js'

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

interface HybridSearchRow {
  capture_id: string
  rrf_score: number
  fts_score: number
  vector_score: number
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
 *   2. Call hybrid_search SQL function (FTS + vector RRF)
 *   3. Fetch matching capture rows
 *   4. Apply ACT-R temporal decay in-memory (no per-row DB round-trip)
 *   5. Filter by brainViews / captureTypes / date range if provided
 *   6. Return top N results sorted by final score descending
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

    const fetchCount = Math.min(limit * 5, 200)

    let hybridRows: { rows: { capture_id: string; rrf_score: number; fts_score: number; vector_score: number }[] }

    if (searchMode === 'fts') {
      // FTS-only path: no embedding call, works even when LiteLLM is down,
      // searches captures regardless of whether they have embeddings yet.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      hybridRows = await this.db.execute<any>(sql`
        SELECT capture_id::text, rrf_score, fts_score, vector_score
        FROM fts_only_search(${query}, ${fetchCount})
      `)
    } else {
      // Step 1: embed the query (throws EmbeddingUnavailableError if LiteLLM is down)
      const queryVector = await this.embeddingService.embed(query)
      const vectorLiteral = `[${queryVector.join(',')}]`

      // Step 2: call hybrid_search — fetch more than `limit` so post-filters have candidates
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      hybridRows = await this.db.execute<any>(sql`
        SELECT capture_id::text, rrf_score, fts_score, vector_score
        FROM hybrid_search(
          ${query},
          ${vectorLiteral}::vector(768),
          ${fetchCount},
          ${ftsWeight},
          ${vectorWeight}
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const captureRows = await this.db.execute<any>(sql`
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

    // Step 5: apply optional post-filters
    let filtered = results

    if (brainViews && brainViews.length > 0) {
      const viewSet = new Set(brainViews)
      filtered = filtered.filter(r => viewSet.has(r.capture.brain_view))
    }

    if (captureTypes && captureTypes.length > 0) {
      const typeSet = new Set(captureTypes)
      filtered = filtered.filter(r => typeSet.has(r.capture.capture_type))
    }

    if (dateFrom) {
      filtered = filtered.filter(r => new Date(r.capture.captured_at) >= dateFrom)
    }

    if (dateTo) {
      filtered = filtered.filter(r => new Date(r.capture.captured_at) <= dateTo)
    }

    // Step 6: sort by final score descending and return top N
    filtered.sort((a, b) => b.score - a.score)
    return filtered.slice(0, limit)
  }
}
