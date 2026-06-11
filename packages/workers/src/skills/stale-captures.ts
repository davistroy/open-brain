import { Queue } from 'bullmq'
import { sql } from 'drizzle-orm'
import type { Database } from '@open-brain/shared'
import { logger } from '@open-brain/shared'
import { BaseSkill } from './base-skill.js'
import type { BaseResult, BaseSkillOpts } from './types.js'
import type { CapturePipelineJobData } from '../queues/capture-pipeline.js'
import { SWEEPABLE_STATUSES } from '../lib/sweepable-statuses.js'

// ============================================================
// Types
// ============================================================

export interface StaleCapture {
  id: string
  pipeline_status: string
  created_at: Date
  /** Age in minutes at time of detection */
  age_minutes: number
}

export interface StaleCapturesResult extends BaseResult {
  found: number
  requeued: number
  failed: number
  staleCaptures: StaleCapture[]
}

export interface StaleCapturesOptions {
  /**
   * How old (in minutes) a capture must be before it is considered stale.
   * Default: 60 minutes.
   * Configurable so tests and manual triggers can use a shorter threshold.
   */
  thresholdMinutes?: number
}

// ============================================================
// StaleCapturesSkill
// ============================================================

/**
 * StaleCapturesSkill — on-demand version of the daily-sweep job.
 *
 * Finds captures stuck in 'received' or 'processing' pipeline_status for
 * longer than a configurable threshold (default: 60 minutes) and re-enqueues
 * them to the capture-pipeline BullMQ queue.
 *
 * Unlike the nightly DailySweep job (which runs silently at 3 AM), this
 * skill sends a Pushover notification summarising what was re-queued — useful
 * when manually investigating pipeline issues during the day.
 *
 * Re-enqueue uses jobId = captureId so BullMQ deduplicates: if a capture is
 * already queued, the add() call is a no-op.
 *
 * Dependencies are injected for testability. The skill is invoked via
 * POST /api/v1/skills/stale-captures/trigger (SkillExecutor framework).
 */
export interface StaleCapturesSkillOpts extends BaseSkillOpts {
  capturePipelineQueue: Queue<CapturePipelineJobData>
}

export class StaleCapturesSkill extends BaseSkill<StaleCapturesOptions, StaleCapturesResult> {
  private capturePipelineQueue: Queue<CapturePipelineJobData>

  constructor(opts: StaleCapturesSkillOpts) {
    super('stale-captures', opts)
    this.capturePipelineQueue = opts.capturePipelineQueue
  }

  // ----------------------------------------------------------
  // Public API
  // ----------------------------------------------------------

  /**
   * Execute the stale captures skill end-to-end.
   *
   * 1. Query captures stuck in 'received' or 'processing' beyond the threshold
   * 2. Re-enqueue each stuck capture to capture-pipeline (idempotent via jobId)
   * 3. Send Pushover notification summarising what was re-queued
   * 4. Log to skills_log
   *
   * Returns a result object describing what was found and re-queued.
   * Non-fatal errors (individual re-queue failures, Pushover, skills_log) are
   * caught and logged — the skill does not throw on partial failure.
   */
  protected async run(options: StaleCapturesOptions = {}): Promise<StaleCapturesResult> {
    const { thresholdMinutes = 60 } = options
    const startMs = Date.now()

    logger.info({ thresholdMinutes }, '[stale-captures] starting execution')

    // Step 1: Query stale captures
    const staleCaptures = await this.queryStaleCaptures(thresholdMinutes)
    const found = staleCaptures.length

    logger.info({ found, thresholdMinutes }, '[stale-captures] stale captures found')

    if (found === 0) {
      const durationMs = Date.now() - startMs
      const emptyResult: StaleCapturesResult = { found: 0, requeued: 0, failed: 0, staleCaptures: [], durationMs }
      await this.logResult(emptyResult, `threshold: ${thresholdMinutes}min`, 'No stale captures found')
      logger.info('[stale-captures] no stale captures — nothing to do')
      return emptyResult
    }

    // Step 2: Re-enqueue stuck captures
    let requeued = 0
    let failed = 0

    for (const capture of staleCaptures) {
      try {
        // jobId = captureId ensures BullMQ deduplicates — if already queued, no-op
        await this.capturePipelineQueue.add(
          'ingest',
          { captureId: capture.id },
          { jobId: capture.id },
        )
        requeued++
        logger.debug({ captureId: capture.id, age_minutes: capture.age_minutes }, '[stale-captures] re-enqueued')
      } catch (err) {
        failed++
        logger.warn({ captureId: capture.id, err }, '[stale-captures] failed to re-enqueue capture')
      }
    }

    const durationMs = Date.now() - startMs

    logger.info({ found, requeued, failed, durationMs }, '[stale-captures] re-enqueue complete')

    // Step 3: Send Pushover notification
    await this.deliverPushover(staleCaptures, requeued, failed, thresholdMinutes)

    // Step 4: Log to skills_log via BaseSkill
    const outputSummary = buildOutputSummary(staleCaptures, requeued, failed, thresholdMinutes)
    const result: StaleCapturesResult = { found, requeued, failed, staleCaptures, durationMs }
    await this.logResult(result, `threshold: ${thresholdMinutes}min`, outputSummary)

    return result
  }

  // ----------------------------------------------------------
  // Private: data fetching
  // ----------------------------------------------------------

  /**
   * Finds captures stuck in a sweepable status (pending / processing /
   * extracted — see SWEEPABLE_STATUSES) for longer than the specified
   * threshold, ordered oldest-first.
   *
   * Uses created_at (not captured_at) as the reference — this is when the
   * row was written, so it accurately reflects how long the pipeline has
   * had a chance to process it.
   */
  private async queryStaleCaptures(thresholdMinutes: number): Promise<StaleCapture[]> {
    const threshold = new Date(Date.now() - thresholdMinutes * 60 * 1000)

    const rows = await this.db.execute<{
      id: string
      pipeline_status: string
      created_at: string
      age_minutes: number
    }>(sql`
      SELECT id, pipeline_status, created_at,
             EXTRACT(EPOCH FROM (NOW() - created_at)) / 60 AS age_minutes
      FROM captures
      WHERE pipeline_status IN (${sql.join(SWEEPABLE_STATUSES.map((s) => sql`${s}`), sql`, `)})
        AND created_at < ${threshold.toISOString()}::timestamptz
      ORDER BY created_at ASC
    `)

    return rows.rows.map((row) => ({
      id: row.id,
      pipeline_status: row.pipeline_status,
      created_at: new Date(row.created_at),
      age_minutes: Math.round(Number(row.age_minutes)),
    }))
  }

  // ----------------------------------------------------------
  // Private: Pushover notification
  // ----------------------------------------------------------

  /**
   * Sends a Pushover notification summarising the re-queue results.
   *
   * Priority 1 (high) — stale captures indicate a pipeline issue that warrants
   * immediate attention, but it's not a full emergency (Pushover priority 2).
   *
   * Silently skips if Pushover is not configured.
   */
  private async deliverPushover(
    staleCaptures: StaleCapture[],
    requeued: number,
    failed: number,
    thresholdMinutes: number,
  ): Promise<void> {
    if (!this.pushover.isConfigured) {
      logger.debug('[stale-captures] Pushover not configured — skipping notification')
      return
    }

    const oldest = staleCaptures.reduce(
      (max, c) => (c.age_minutes > max ? c.age_minutes : max),
      0,
    )

    const lines: string[] = [
      `Found ${staleCaptures.length} stale capture${staleCaptures.length === 1 ? '' : 's'} (>${thresholdMinutes}min)`,
    ]

    if (requeued > 0) {
      lines.push(`Re-queued: ${requeued}`)
    }
    if (failed > 0) {
      lines.push(`Failed to re-queue: ${failed}`)
    }
    if (oldest > 0) {
      lines.push(`Oldest: ${oldest}min ago`)
    }

    // List up to 3 capture IDs so it's actionable
    const idList = staleCaptures
      .slice(0, 3)
      .map(c => `${c.id.slice(0, 8)} (${c.pipeline_status}, ${c.age_minutes}min)`)
      .join(', ')

    if (idList) {
      lines.push(idList)
    }

    const message = lines.join('\n')

    try {
      await this.pushover.send({
        title: 'Open Brain: Stale Captures Re-queued',
        message,
        priority: 1,
      })
      logger.info({ requeued, failed }, '[stale-captures] Pushover notification sent')
    } catch (err) {
      logger.warn({ err }, '[stale-captures] Pushover delivery failed — continuing')
    }
  }

}

// ============================================================
// Skill execution entry point — called by BullMQ worker / SkillExecutor
// ============================================================

/**
 * Top-level function invoked by the skill-execution BullMQ worker.
 *
 * Constructs StaleCapturesSkill with production dependencies and executes.
 * On final failure (after BullMQ exhausts retries), a Pushover alert is
 * sent by the caller (skill worker, not here).
 */
export async function executeStaleCapturesSkill(
  db: Database,
  capturePipelineQueue: Queue<CapturePipelineJobData>,
  options: StaleCapturesOptions = {},
): Promise<StaleCapturesResult> {
  const skill = new StaleCapturesSkill({ db, capturePipelineQueue })
  return skill.execute(options)
}

// ============================================================
// Helpers
// ============================================================

function buildOutputSummary(
  staleCaptures: StaleCapture[],
  requeued: number,
  failed: number,
  thresholdMinutes: number,
): string {
  const oldest = staleCaptures.reduce(
    (max, c) => (c.age_minutes > max ? c.age_minutes : max),
    0,
  )
  return `found:${staleCaptures.length} requeued:${requeued} failed:${failed} threshold:${thresholdMinutes}min oldest:${oldest}min`
}
