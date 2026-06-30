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
  /** IDs of recently accessed captures — used for Hebbian association boost */
  recentCaptureIds?: string[]
  /** When true, runs spreading activation on top 5 results to find related captures via entity graph */
  includeRelated?: boolean
}

export interface SearchResult {
  capture: CaptureRecord
  score: number
  ftsScore?: number
  vectorScore?: number
}

export interface SearchResponse {
  results: SearchResult[]
  relatedResults?: SearchResult[]
}

type HybridSearchRow = {
  capture_id: string
  rrf_score: number
  fts_score: number
  vector_score: number
}

/** Row shape returned by the enumerated captures SELECT (embedding column excluded — PE-L2) */
type CaptureQueryRow = {
  id: string
  content: string
  content_hash: string
  capture_type: string
  brain_view: string
  source: string
  source_metadata: Record<string, unknown> | null
  tags: string[]
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
    /** HNSW ef_search value -- set per-query via SET LOCAL before hybrid_search().
     * Default 60 matches config/pipeline.yaml search.hnsw_ef_search default.
     * Read from pipeline config at injection time in index.ts (route factory). */
    private hnswEfSearch: number = 60,
  ) {}

  /**
   * Look up Hebbian association weights between result captures and recently
   * accessed captures. Returns a Map from captureId → normalized weight [0,1].
   *
   * Queries capture_associations for any pair where one side is a result capture
   * and the other side is a recent capture. When multiple associations exist for
   * the same result capture (linked to different recent captures), takes the max
   * weight. Normalizes to [0,1] by dividing by the max weight across all results.
   */
  private async lookupAssociationBoosts(
    resultCaptureIds: string[],
    recentCaptureIds: string[],
  ): Promise<Map<string, number>> {
    const boostMap = new Map<string, number>()

    if (resultCaptureIds.length === 0 || recentCaptureIds.length === 0) {
      return boostMap
    }

    const pgResultIds = `{${resultCaptureIds.join(',')}}`
    const pgRecentIds = `{${recentCaptureIds.join(',')}}`

    // Find associations where one side is a result capture and the other
    // is a recent capture. The canonical ordering constraint (a < b) means
    // we need to check both directions.
    const rows = await this.db.execute<{ capture_id: string; max_weight: number }>(sql`
      SELECT capture_id, MAX(weight) as max_weight FROM (
        SELECT capture_id_a AS capture_id, weight
        FROM capture_associations
        WHERE capture_id_a = ANY(${pgResultIds}::uuid[])
          AND capture_id_b = ANY(${pgRecentIds}::uuid[])
        UNION ALL
        SELECT capture_id_b AS capture_id, weight
        FROM capture_associations
        WHERE capture_id_b = ANY(${pgResultIds}::uuid[])
          AND capture_id_a = ANY(${pgRecentIds}::uuid[])
      ) sub
      GROUP BY capture_id
    `)

    if (rows.rows.length === 0) {
      return boostMap
    }

    // Find the max weight across all results for normalization
    let maxWeight = 0
    for (const row of rows.rows) {
      if (row.max_weight > maxWeight) {
        maxWeight = row.max_weight
      }
    }

    // Normalize to [0,1]
    for (const row of rows.rows) {
      boostMap.set(row.capture_id, maxWeight > 0 ? row.max_weight / maxWeight : 0)
    }

    return boostMap
  }

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

      // SE-10: vector-only mode — suppress FTS contribution entirely by passing
      // fts_weight=0. hybrid_search still runs through the same SQL function;
      // RRF scoring becomes pure vector when fts_weight is 0.
      const effectiveFtsWeight = searchMode === 'vector' ? 0 : ftsWeight

      // Steps 2+3: PE-M1 — set HNSW ef_search and run hybrid_search() inside ONE
      // transaction so `SET LOCAL` scopes the GUC to this query on the pooled
      // connection. A bare session-scoped `SET` leaks ef_search onto the pooled
      // connection for whatever query reuses it next; `SET LOCAL` is reverted at
      // COMMIT. (SET LOCAL is a no-op outside an explicit transaction, hence the
      // wrap.) sql.raw() required: SET does not accept parameterized $1 values;
      // the value is an int from validated config (same for every single-user search).
      hybridRows = await this.db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL hnsw.ef_search = ${sql.raw(String(this.hnswEfSearch))}`)
        return await tx.execute<HybridSearchRow>(sql`
          SELECT capture_id::text, rrf_score, fts_score, vector_score
          FROM hybrid_search(
            ${query},
            ${vectorLiteral}::vector(768),
            ${limit},
            ${effectiveFtsWeight},
            ${vectorWeight},
            ${pgBrainViews}::text[],
            ${pgCaptureTypes}::text[],
            ${pgDateFrom}::timestamptz,
            ${pgDateTo}::timestamptz
          )
        `)
      })
    }

    if (hybridRows.rows.length === 0) {
      return []
    }

    const captureIds = hybridRows.rows.map(r => r.capture_id) as string[]

    // Step 3: fetch capture rows for all returned IDs in one query
    // Pass as PostgreSQL array literal — Drizzle's sql`` sends JS arrays as
    // record tuples ($1,$2) which cannot be cast to uuid[].
    const pgArrayLiteral = `{${captureIds.join(',')}}`
    // PE-L2: enumerate columns explicitly — omit the vector(768) `embedding` column
    // which is large (3 KB per row) and unused by any search result consumer.
    const captureRows = await this.db.execute<CaptureQueryRow>(sql`
      SELECT id, content, content_hash, capture_type, brain_view, source,
             source_metadata, tags, pipeline_status, pipeline_attempts,
             pipeline_error, pipeline_completed_at, pre_extracted,
             created_at, updated_at, captured_at, deleted_at,
             access_count, last_accessed_at
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

    // Step 4b: apply Hebbian association boost — captures associated with
    // recently accessed captures get a small multiplicative score increase.
    // Max boost is 10% (score * 1.1). Cold-start safe: no-op when empty.
    const recentCaptureIds = options.recentCaptureIds
    if (recentCaptureIds && recentCaptureIds.length > 0) {
      const resultIds = results.map(r => r.capture.id!)
      const boostMap = await this.lookupAssociationBoosts(resultIds, recentCaptureIds)

      for (const result of results) {
        const boost = boostMap.get(result.capture.id!)
        if (boost != null && boost > 0) {
          // Multiplicative boost: score * (1 + 0.1 * normalizedWeight)
          // normalizedWeight is already in [0,1], so max boost is 10%
          result.score = result.score * (1 + 0.1 * boost)
        }
      }
    }

    // Step 5: sort by final score descending and return
    // No in-memory filtering needed — filters are applied in SQL
    results.sort((a, b) => b.score - a.score)
    return results.slice(0, limit)
  }

  /**
   * Find captures related to seed captures via entity graph traversal.
   *
   * Calls the spreading_activation SQL function which traverses entity_links
   * and entity_relationships up to 2 hops from the seed captures. Fetches
   * full capture records and applies ACT-R temporal decay to activation scores.
   *
   * @param seedCaptureIds - UUIDs of seed captures to start traversal from
   * @param limit - Maximum related captures to return (default 10)
   * @param temporalWeight - ACT-R decay weight (default 0.0, cold-start safe)
   * @returns SearchResult[] scored by activation_score with temporal decay
   */
  async findRelatedCaptures(
    seedCaptureIds: string[],
    limit: number = 10,
    temporalWeight: number = 0.0,
  ): Promise<SearchResult[]> {
    if (seedCaptureIds.length === 0) {
      return []
    }

    const pgSeedIds = `{${seedCaptureIds.join(',')}}`

    // Call the spreading_activation SQL function
    const activationRows = await this.db.execute<{
      capture_id: string
      activation_score: number
      hop_count: number
    }>(sql`
      SELECT capture_id::text, activation_score, hop_count
      FROM spreading_activation(
        ${pgSeedIds}::uuid[],
        2,
        ${limit}
      )
    `)

    if (activationRows.rows.length === 0) {
      return []
    }

    // Fetch full capture records for the related captures
    const relatedIds = activationRows.rows.map(r => r.capture_id)
    const pgRelatedIds = `{${relatedIds.join(',')}}`
    // PE-L2: enumerate columns explicitly — omit the vector(768) `embedding` column.
    // SE-6: filter deleted captures so soft-deleted rows never surface via entity graph.
    const captureRows = await this.db.execute<CaptureQueryRow>(sql`
      SELECT id, content, content_hash, capture_type, brain_view, source,
             source_metadata, tags, pipeline_status, pipeline_attempts,
             pipeline_error, pipeline_completed_at, pre_extracted,
             created_at, updated_at, captured_at, deleted_at,
             access_count, last_accessed_at
      FROM captures
      WHERE id = ANY(${pgRelatedIds}::uuid[])
        AND deleted_at IS NULL
    `)

    const captureMap = new Map<string, CaptureRecord>()
    for (const row of captureRows.rows) {
      captureMap.set(row.id, row as unknown as CaptureRecord)
    }

    // Apply ACT-R temporal decay to activation scores
    const results: SearchResult[] = []
    for (const row of activationRows.rows) {
      const capture = captureMap.get(row.capture_id)
      if (!capture) continue

      const finalScore = applyTemporalDecay(row.activation_score, capture.created_at, temporalWeight)
      results.push({
        capture,
        score: finalScore,
      })
    }

    // Sort by final score descending
    results.sort((a, b) => b.score - a.score)
    return results.slice(0, limit)
  }

  /**
   * Full search with optional spreading activation for related captures.
   *
   * When options.includeRelated is true, runs findRelatedCaptures on the
   * top 5 primary results after the main search completes. Related results
   * exclude any captures already in the primary results.
   */
  async searchWithRelated(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
    const results = await this.search(query, options)

    const response: SearchResponse = { results }

    if (options.includeRelated && results.length > 0) {
      const seedIds = results.slice(0, 5).map(r => r.capture.id!)
      const related = await this.findRelatedCaptures(
        seedIds,
        options.limit ?? 10,
        options.temporalWeight ?? 0.0,
      )

      // Exclude captures already in primary results
      const primaryIds = new Set(results.map(r => r.capture.id!))
      response.relatedResults = related.filter(r => !primaryIds.has(r.capture.id!))
    }

    return response
  }
}
