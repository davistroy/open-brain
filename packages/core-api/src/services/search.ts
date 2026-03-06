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
 * SearchService orchestrates hybrid search over captures.
 *
 * Flow:
 *   1. Embed the query string via EmbeddingService
 *   2. Call hybrid_search SQL function (FTS + vector RRF)
 *   3. Fetch matching capture rows
 *   4. Apply actr_temporal_score to each result
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
    } = options

    // Step 1: embed the query
    const queryVector = await this.embeddingService.embed(query)
    const vectorLiteral = `[${queryVector.join(',')}]`

    // Step 2: call hybrid_search — fetch more than `limit` so post-filters have candidates
    const fetchCount = Math.min(limit * 5, 200)

    const hybridRows = await this.db.execute<HybridSearchRow>(sql`
      SELECT capture_id::text, rrf_score, fts_score, vector_score
      FROM hybrid_search(
        ${query},
        ${vectorLiteral}::vector(768),
        ${fetchCount},
        ${ftsWeight},
        ${vectorWeight}
      )
    `)

    if (hybridRows.rows.length === 0) {
      return []
    }

    const captureIds = hybridRows.rows.map(r => r.capture_id)

    // Step 3: fetch capture rows for all returned IDs in one query
    const captureRows = await this.db.execute<CaptureRecord & { id: string }>(sql`
      SELECT *
      FROM captures
      WHERE id = ANY(${captureIds}::uuid[])
    `)

    const captureMap = new Map<string, CaptureRecord>()
    for (const row of captureRows.rows) {
      captureMap.set(row.id, row as unknown as CaptureRecord)
    }

    // Step 4: apply actr_temporal_score and build SearchResult list
    const results: SearchResult[] = []

    for (const hybridRow of hybridRows.rows) {
      const capture = captureMap.get(hybridRow.capture_id)
      if (!capture) continue

      // Apply ACT-R temporal decay via SQL function
      const scoreResult = await this.db.execute<{ final_score: number }>(sql`
        SELECT actr_temporal_score(
          ${hybridRow.rrf_score}::float,
          ${capture.created_at instanceof Date ? capture.created_at.toISOString() : capture.created_at}::timestamptz,
          ${temporalWeight}::float
        ) AS final_score
      `)

      const finalScore = scoreResult.rows[0]?.final_score ?? hybridRow.rrf_score

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
