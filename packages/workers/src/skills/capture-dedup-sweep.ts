import { sql } from 'drizzle-orm'
import type { Database, AutonomyLevel } from '@open-brain/shared'
import { logger } from '@open-brain/shared'
import { BaseSkill } from './base-skill.js'
import type { BaseResult, BaseSkillOpts } from './types.js'
import {
  findSimilarPairs,
  readScanWatermark,
  writeScanWatermark,
  CAPTURE_DEDUP_WATERMARK_KEY,
} from '../lib/hnsw-similarity.js'

/** ADR-0003 rollback hatch: `SIMILARITY_SCAN_LEGACY=1` → old O(N²) self-join for one weekend. */
const LEGACY_SCAN = process.env.SIMILARITY_SCAN_LEGACY === '1'

// ============================================================
// Types
// ============================================================

/**
 * A pair of captures flagged as near-duplicates.
 */
export interface DedupPair {
  capture_id_a: string
  capture_id_b: string
  similarity: number
  content_a_preview: string
  content_b_preview: string
  created_at_a: string
  created_at_b: string
}

/**
 * Result of the capture dedup sweep execution.
 */
export interface CaptureDedupSweepResult extends BaseResult {
  /** Number of duplicate pairs found */
  pairsFound: number
  /** The flagged pairs (up to maxPairs) */
  pairs: DedupPair[]
  /** Whether a Pushover notification was sent */
  notificationSent: boolean
}

/**
 * Options for the capture dedup sweep skill.
 */
export interface CaptureDedupSweepOptions {
  /** Cosine similarity threshold. Default: 0.95. */
  similarityThreshold?: number
  /** Maximum pairs to return per run. Default: 100. */
  maxPairs?: number
}

// ============================================================
// Constants
// ============================================================

/** Cosine similarity threshold for flagging near-duplicates */
export const DEFAULT_SIMILARITY_THRESHOLD = 0.95

/** Maximum pairs per run (safety limit) */
export const DEFAULT_MAX_PAIRS = 100

/** Content preview length for logging */
const PREVIEW_LENGTH = 120

// ============================================================
// Row type for raw SQL query
// ============================================================

interface DedupPairRow {
  [key: string]: unknown
  capture_id_a: string
  capture_id_b: string
  similarity: string
  content_a: string
  content_b: string
  created_at_a: string
  created_at_b: string
}

/** Row shape for the k-NN-path content/created_at hydration query. */
interface DedupHydrationRow {
  [key: string]: unknown
  id: string
  content: string
  created_at: string
}

// ============================================================
// CaptureDedupSweepSkill
// ============================================================

/**
 * CaptureDedupSweepSkill -- weekly scan for near-duplicate captures
 * (cosine similarity > 0.95) not caught by real-time dedup.
 *
 * Flags pairs for human review -- does NOT auto-merge.
 * That is memory consolidation's job (0.92 threshold).
 *
 * Pattern: query DB, log results, send Pushover if duplicates found.
 */
export class CaptureDedupSweepSkill extends BaseSkill<CaptureDedupSweepOptions, CaptureDedupSweepResult> {
  static minimum_autonomy: AutonomyLevel = 'observe'

  constructor(opts: BaseSkillOpts) {
    super('capture-dedup-sweep', opts)
  }

  protected async run(options: CaptureDedupSweepOptions = {}): Promise<CaptureDedupSweepResult> {
    const {
      similarityThreshold = DEFAULT_SIMILARITY_THRESHOLD,
      maxPairs = DEFAULT_MAX_PAIRS,
    } = options

    const startMs = Date.now()
    const scanStartedAt = new Date()
    logger.info(
      { similarityThreshold, maxPairs },
      '[capture-dedup-sweep] starting execution',
    )

    // Step 0: PE-H1 incremental scoping — only flag duplicates among captures
    // created since the last successful sweep. First run (null) = full scan.
    const candidatesSince = await readScanWatermark(this.db, CAPTURE_DEDUP_WATERMARK_KEY)

    // Step 1: Query near-duplicate pairs (throws on DB failure → watermark not advanced)
    const pairs = await this.queryDuplicatePairs(similarityThreshold, maxPairs, candidatesSince)

    // Scan succeeded → advance the watermark before notifying/logging.
    await writeScanWatermark(this.db, CAPTURE_DEDUP_WATERMARK_KEY, scanStartedAt)

    logger.info(
      { pairsFound: pairs.length },
      '[capture-dedup-sweep] duplicate pairs found',
    )

    // Step 2: Send Pushover notification if duplicates found
    let notificationSent = false
    if (pairs.length > 0) {
      notificationSent = await this.deliverPushover(pairs)
    }

    const durationMs = Date.now() - startMs
    const result: CaptureDedupSweepResult = {
      pairsFound: pairs.length,
      pairs,
      notificationSent,
      durationMs,
    }

    // Step 3: Log to skills_log via BaseSkill
    const inputSummary = `threshold:${similarityThreshold} maxPairs:${maxPairs}`
    const outputSummary = pairs.length === 0
      ? 'No near-duplicates found'
      : `${pairs.length} duplicate pair${pairs.length === 1 ? '' : 's'} flagged`
    await this.logResult(result, inputSummary, outputSummary)

    logger.info(
      { pairsFound: pairs.length, notificationSent, durationMs },
      '[capture-dedup-sweep] execution complete',
    )

    return result
  }

  // ----------------------------------------------------------
  // Private: Query duplicate pairs
  // ----------------------------------------------------------

  /**
   * Find capture pairs with cosine similarity above the threshold.
   *
   * Uses `1 - (embedding <=> embedding)` for cosine similarity
   * (the `<=>` operator returns cosine distance).
   *
   * Excludes:
   * - Soft-deleted captures (deleted_at IS NULL)
   * - Non-complete captures (pipeline_status = 'complete')
   * - Already-consolidated captures (source != 'consolidation')
   * - Captures without embeddings
   */
  private async queryDuplicatePairs(
    similarityThreshold: number,
    maxPairs: number,
    candidatesSince: Date | null = null,
  ): Promise<DedupPair[]> {
    if (LEGACY_SCAN) {
      return this.queryDuplicatePairsLegacy(similarityThreshold, maxPairs)
    }

    // PE-H1 / ADR-0003: per-row HNSW k-NN probe instead of the O(N²) self-join.
    // Dedup excludes source='consolidation' (excludeConsolidationSource:true).
    // Errors propagate so run() never advances the scan watermark on failure.
    const simPairs = await findSimilarPairs(this.db, {
      threshold: similarityThreshold,
      maxPairs,
      excludeConsolidationSource: true,
      candidatesSince,
    })
    if (simPairs.length === 0) return []

    // Hydrate content + created_at previews for the involved captures in one query.
    // PG array literal (Drizzle sends JS arrays as record tuples, not uuid[]).
    const ids = [...new Set(simPairs.flatMap((p) => [p.capture_id_a, p.capture_id_b]))]
    const pgIds = `{${ids.join(',')}}`
    const hydrated = await this.db.execute<DedupHydrationRow>(sql`
      SELECT id::text AS id,
             LEFT(content, ${PREVIEW_LENGTH}) AS content,
             created_at::text AS created_at
      FROM captures
      WHERE id = ANY(${pgIds}::uuid[])
    `)
    const byId = new Map(hydrated.rows.map((r) => [r.id, r]))

    return simPairs.map((p) => ({
      capture_id_a: p.capture_id_a,
      capture_id_b: p.capture_id_b,
      similarity: p.similarity,
      content_a_preview: byId.get(p.capture_id_a)?.content ?? '',
      content_b_preview: byId.get(p.capture_id_b)?.content ?? '',
      created_at_a: byId.get(p.capture_id_a)?.created_at ?? '',
      created_at_b: byId.get(p.capture_id_b)?.created_at ?? '',
    }))
  }

  /**
   * Legacy O(N²) cosine self-join — retained behind `SIMILARITY_SCAN_LEGACY=1` as the
   * one-weekend rollback hatch for ADR-0003. Routed via {@link queryDuplicatePairs}.
   */
  private async queryDuplicatePairsLegacy(
    similarityThreshold: number,
    maxPairs: number,
  ): Promise<DedupPair[]> {
    try {
      const rows = await this.db.execute<DedupPairRow>(sql`
        SELECT
          a.id::text AS capture_id_a,
          b.id::text AS capture_id_b,
          (1 - (a.embedding <=> b.embedding))::text AS similarity,
          LEFT(a.content, ${PREVIEW_LENGTH}) AS content_a,
          LEFT(b.content, ${PREVIEW_LENGTH}) AS content_b,
          a.created_at::text AS created_at_a,
          b.created_at::text AS created_at_b
        FROM captures a
        JOIN captures b ON a.id < b.id
        WHERE a.pipeline_status = 'complete'
          AND b.pipeline_status = 'complete'
          AND a.deleted_at IS NULL
          AND b.deleted_at IS NULL
          AND a.embedding IS NOT NULL
          AND b.embedding IS NOT NULL
          AND a.source != 'consolidation'
          AND b.source != 'consolidation'
          AND (1 - (a.embedding <=> b.embedding)) > ${similarityThreshold}
        ORDER BY (1 - (a.embedding <=> b.embedding)) DESC
        LIMIT ${maxPairs}
      `)

      return rows.rows.map((row) => ({
        capture_id_a: row.capture_id_a,
        capture_id_b: row.capture_id_b,
        similarity: parseFloat(row.similarity),
        content_a_preview: row.content_a ?? '',
        content_b_preview: row.content_b ?? '',
        created_at_a: row.created_at_a,
        created_at_b: row.created_at_b,
      }))
    } catch (err) {
      logger.error({ err }, '[capture-dedup-sweep] failed to query duplicate pairs (legacy)')
      return []
    }
  }

  // ----------------------------------------------------------
  // Private: Pushover notification
  // ----------------------------------------------------------

  /**
   * Send a Pushover summary with count + top 3 examples.
   */
  private async deliverPushover(pairs: DedupPair[]): Promise<boolean> {
    if (!this.pushover.isConfigured) {
      logger.debug('[capture-dedup-sweep] Pushover not configured -- skipping notification')
      return false
    }

    const lines: string[] = [
      `Dedup Sweep: ${pairs.length} near-duplicate pair${pairs.length === 1 ? '' : 's'} found`,
      '',
    ]

    // Show top 3 examples
    const topPairs = pairs.slice(0, 3)
    for (let i = 0; i < topPairs.length; i++) {
      const p = topPairs[i]
      lines.push(`${i + 1}. Similarity: ${(p.similarity * 100).toFixed(1)}%`)
      lines.push(`   A: ${p.content_a_preview.slice(0, 60)}...`)
      lines.push(`   B: ${p.content_b_preview.slice(0, 60)}...`)
    }

    if (pairs.length > 3) {
      lines.push(`   ...and ${pairs.length - 3} more`)
    }

    try {
      await this.pushover.send({
        title: 'Open Brain: Duplicate Captures Found',
        message: lines.join('\n'),
        priority: 0,
      })
      return true
    } catch (err) {
      logger.warn({ err }, '[capture-dedup-sweep] Pushover notification failed')
      return false
    }
  }

}

// ============================================================
// Top-level entry point -- called by BullMQ worker dispatcher
// ============================================================

/** Top-level entry point called by BullMQ skill-execution worker. */
export async function executeCaptureDedupSweep(
  db: Database,
  options: CaptureDedupSweepOptions = {},
): Promise<CaptureDedupSweepResult> {
  return new CaptureDedupSweepSkill({ db }).execute(options)
}
