import { sql } from 'drizzle-orm'
import { Queue } from 'bullmq'
import type { ConnectionOptions } from 'bullmq'
import type { Database, PushoverService } from '@open-brain/shared'
import { logger } from '@open-brain/shared'
import { BaseSkill } from './base-skill.js'
import type { BaseResult, BaseSkillOpts } from './types.js'

// ============================================================
// Types
// ============================================================

export interface WikiSynthesisResult extends BaseResult {
  capturesChecked: number
  capturesQueued: number
  captureIds: string[]
  notificationSent: boolean
}

export interface WikiSynthesisOptions {
  /** How many hours to look back for unintegrated captures. Default: 24. */
  lookbackHours?: number
  /** Redis connection for creating wiki-ingest queue. */
  redisConnection?: ConnectionOptions
  /** Pre-created wiki-ingest queue (for testing). */
  wikiIngestQueue?: WikiIngestQueueLike
  /** Pushover service instance. */
  pushover?: PushoverService
}

/** Minimal queue interface for wiki-ingest queue (for testability). */
export interface WikiIngestQueueLike {
  add(name: string, data: { captureId: string }, opts?: Record<string, unknown>): Promise<unknown>
  close(): Promise<void>
}

// ============================================================
// Query helpers
// ============================================================

interface UnintegratedCapture {
  [key: string]: unknown
  id: string
  content: string
  capture_type: string
  created_at: string
}

/**
 * Find captures from the last N hours that have no `wiki-ingest` entry
 * in skills_log. These are captures the wiki hasn't processed yet.
 *
 * Only includes captures that have completed the pipeline (pipeline_status = 'complete')
 * and have not been soft-deleted.
 */
export async function queryUnintegratedCaptures(
  db: Database,
  lookbackHours: number,
): Promise<UnintegratedCapture[]> {
  const result = await db.execute<UnintegratedCapture>(sql`
    SELECT c.id::text, c.content, c.capture_type, c.created_at::text
    FROM captures c
    WHERE c.pipeline_status = 'complete'
      AND c.deleted_at IS NULL
      AND c.created_at >= NOW() - make_interval(hours => ${lookbackHours})
      AND c.source != 'consolidation'
      AND NOT EXISTS (
        SELECT 1 FROM skills_log sl
        WHERE sl.skill_name = 'wiki-ingest'
          AND sl.capture_id = c.id
      )
    ORDER BY c.created_at ASC
    LIMIT 50
  `)
  return result.rows
}

// ============================================================
// WikiSynthesisSkill class
// ============================================================

/**
 * WikiSynthesisSkill — identifies captures not yet integrated into the wiki
 * and queues wiki-ingest jobs for each one.
 *
 * This is a lightweight coordination skill (no LLM calls). It queries
 * the database for recent captures without a corresponding wiki-ingest
 * entry in skills_log, then adds them to the wiki-ingest BullMQ queue.
 *
 * Scheduled daily (6 AM) via BullMQ.
 */
export class WikiSynthesisSkill extends BaseSkill<WikiSynthesisOptions, WikiSynthesisResult> {
  constructor(opts: BaseSkillOpts) {
    super('wiki-synthesis', opts)
  }

  protected async run(options: WikiSynthesisOptions = {}): Promise<WikiSynthesisResult> {
    const startMs = Date.now()
    const lookbackHours = options.lookbackHours ?? 24

    logger.info({ lookbackHours }, '[wiki-synthesis] starting execution')

    // ── Step 1: Query unintegrated captures ─────────────────────────
    const captures = await queryUnintegratedCaptures(this.db, lookbackHours)
    const capturesChecked = captures.length

    logger.info(
      { capturesChecked, lookbackHours },
      '[wiki-synthesis] unintegrated captures found',
    )

    if (capturesChecked === 0) {
      const result: WikiSynthesisResult = {
        capturesChecked: 0,
        capturesQueued: 0,
        captureIds: [],
        durationMs: Date.now() - startMs,
        notificationSent: false,
      }
      await this.logResult(
        result,
        `checked 0 captures (none found)`,
        `queued:0 notified:false`,
      )
      logger.info('[wiki-synthesis] no unintegrated captures — done')
      return result
    }

    // ── Step 2: Get or create wiki-ingest queue ─────────────────────
    const queue = options.wikiIngestQueue ?? await this.createQueue(options.redisConnection)
    const ownQueue = !options.wikiIngestQueue // track if we created it (need to close)

    // ── Step 3: Queue wiki-ingest jobs ──────────────────────────────
    const queuedIds: string[] = []

    for (const capture of captures) {
      try {
        await queue.add(
          'wiki-ingest',
          { captureId: capture.id },
          { jobId: `wiki-synthesis-${capture.id}` },
        )
        queuedIds.push(capture.id)
        logger.debug(
          { captureId: capture.id, captureType: capture.capture_type },
          '[wiki-synthesis] queued wiki-ingest job',
        )
      } catch (err) {
        // Queue failure for individual captures is non-fatal
        logger.warn(
          { captureId: capture.id, err },
          '[wiki-synthesis] failed to queue wiki-ingest job',
        )
      }
    }

    // Close queue if we created it
    if (ownQueue) {
      try {
        await queue.close()
      } catch {
        // Queue close failure is non-fatal
      }
    }

    // ── Step 4: Deliver Pushover notification ───────────────────────
    let notificationSent = false
    if (queuedIds.length > 0) {
      notificationSent = await this.sendNotification(
        'Wiki Synthesis',
        `Queued ${queuedIds.length} of ${capturesChecked} unintegrated capture${capturesChecked === 1 ? '' : 's'} for wiki ingestion.`,
        -1,
      )
    }

    // ── Step 5: Log to skills_log ───────────────────────────────────
    const durationMs = Date.now() - startMs
    const result: WikiSynthesisResult = {
      capturesChecked,
      capturesQueued: queuedIds.length,
      captureIds: queuedIds,
      durationMs,
      notificationSent,
    }

    await this.logResult(
      result,
      `checked ${capturesChecked} captures (${queuedIds.length > 0 ? 'last 24h' : 'none found'})`,
      `queued:${queuedIds.length} notified:${notificationSent}`,
    )

    logger.info(
      {
        capturesChecked,
        capturesQueued: queuedIds.length,
        durationMs,
        notificationSent,
      },
      '[wiki-synthesis] execution complete',
    )

    return result
  }

  // ──────────────────────────────────────────────────────────────────
  // Private: Create wiki-ingest queue
  // ──────────────────────────────────────────────────────────────────

  private async createQueue(connection?: ConnectionOptions): Promise<WikiIngestQueueLike> {
    if (!connection) {
      // Parse REDIS_URL environment variable as fallback
      const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379'
      const parsed = new URL(redisUrl)
      connection = {
        host: parsed.hostname,
        port: Number(parsed.port) || 6379,
        ...(parsed.password ? { password: parsed.password } : {}),
      }
    }

    return new Queue('wiki-ingest', { connection })
  }
}

// ============================================================
// Top-level entry point — called by BullMQ worker dispatcher
// ============================================================

/**
 * Top-level entry point called by the skill-execution BullMQ worker.
 */
export async function executeWikiSynthesis(
  db: Database,
  options: WikiSynthesisOptions = {},
): Promise<WikiSynthesisResult> {
  const skill = new WikiSynthesisSkill({ db, pushover: options.pushover })
  return skill.execute(options)
}
