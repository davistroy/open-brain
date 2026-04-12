import { sql } from 'drizzle-orm'
import type { Database } from '@open-brain/shared'
import { skills_log, logger, PushoverService } from '@open-brain/shared'

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
export interface CaptureDedupSweepResult {
  /** Number of duplicate pairs found */
  pairsFound: number
  /** The flagged pairs (up to maxPairs) */
  pairs: DedupPair[]
  /** Whether a Pushover notification was sent */
  notificationSent: boolean
  /** Execution duration in milliseconds */
  durationMs: number
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
export class CaptureDedupSweepSkill {
  private db: Database
  private pushover: PushoverService

  constructor(opts: {
    db: Database
    pushover?: PushoverService
  }) {
    this.db = opts.db
    this.pushover = opts.pushover ?? new PushoverService()
  }

  async execute(options: CaptureDedupSweepOptions = {}): Promise<CaptureDedupSweepResult> {
    const {
      similarityThreshold = DEFAULT_SIMILARITY_THRESHOLD,
      maxPairs = DEFAULT_MAX_PAIRS,
    } = options

    const startMs = Date.now()
    logger.info(
      { similarityThreshold, maxPairs },
      '[capture-dedup-sweep] starting execution',
    )

    // Step 1: Query near-duplicate pairs
    const pairs = await this.queryDuplicatePairs(similarityThreshold, maxPairs)

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

    // Step 3: Log to skills_log
    await this.logToSkillsLog({
      pairsFound: pairs.length,
      similarityThreshold,
      pairs,
      durationMs,
    })

    logger.info(
      { pairsFound: pairs.length, notificationSent, durationMs },
      '[capture-dedup-sweep] execution complete',
    )

    return {
      pairsFound: pairs.length,
      pairs,
      notificationSent,
      durationMs,
    }
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
      logger.error({ err }, '[capture-dedup-sweep] failed to query duplicate pairs')
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

  // ----------------------------------------------------------
  // Private: skills_log
  // ----------------------------------------------------------

  private async logToSkillsLog(params: {
    pairsFound: number
    similarityThreshold: number
    pairs: DedupPair[]
    durationMs: number
  }): Promise<void> {
    const inputSummary = `threshold:${params.similarityThreshold} maxPairs:${DEFAULT_MAX_PAIRS}`
    const outputSummary = params.pairsFound === 0
      ? 'No near-duplicates found'
      : `${params.pairsFound} duplicate pair${params.pairsFound === 1 ? '' : 's'} flagged`

    // Build structured result with capture IDs, similarity scores, and previews
    const result: Record<string, unknown> = {
      pairsFound: params.pairsFound,
      similarityThreshold: params.similarityThreshold,
      pairs: params.pairs.map((p) => ({
        capture_id_a: p.capture_id_a,
        capture_id_b: p.capture_id_b,
        similarity: p.similarity,
        content_a_preview: p.content_a_preview,
        content_b_preview: p.content_b_preview,
        created_at_a: p.created_at_a,
        created_at_b: p.created_at_b,
      })),
    }

    try {
      await this.db.insert(skills_log).values({
        skill_name: 'capture-dedup-sweep',
        capture_id: null,
        input_summary: inputSummary,
        output_summary: outputSummary,
        result,
        duration_ms: params.durationMs,
      })
    } catch (err) {
      // skills_log failure is non-fatal
      logger.warn({ err }, '[capture-dedup-sweep] failed to write skills_log entry')
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
