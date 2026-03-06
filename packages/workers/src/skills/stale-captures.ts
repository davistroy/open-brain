import { Queue } from 'bullmq'
import { sql } from 'drizzle-orm'
import { skills_log } from '@open-brain/shared'
import type { Database } from '@open-brain/shared'
import { logger } from '../lib/logger.js'
import { PushoverService } from '../services/pushover.js'
import type { CapturePipelineJobData } from '../queues/capture-pipeline.js'

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

export interface StaleCapturesResult {
  found: number
  requeued: number
  failed: number
  staleCaptures: StaleCapture[]
  durationMs: number
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
export class StaleCapturesSkill {
  private db: Database
  private capturePipelineQueue: Queue<CapturePipelineJobData>
  private pushover: PushoverService

  constructor(opts: {
    db: Database
    capturePipelineQueue: Queue<CapturePipelineJobData>
    pushover?: PushoverService
  }) {
    this.db = opts.db
    this.capturePipelineQueue = opts.capturePipelineQueue
    this.pushover = opts.pushover ?? new PushoverService()
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
  async execute(options: StaleCapturesOptions = {}): Promise<StaleCapturesResult> {
    const { thresholdMinutes = 60 } = options
    const startMs = Date.now()

    logger.info({ thresholdMinutes }, '[stale-captures] starting execution')

    // Step 1: Query stale captures
    const staleCaptures = await this.queryStaleCaptures(thresholdMinutes)
    const found = staleCaptures.length

    logger.info({ found, thresholdMinutes }, '[stale-captures] stale captures found')

    if (found === 0) {
      const durationMs = Date.now() - startMs
      await this.logToSkillsLog({
        inputSummary: `threshold: ${thresholdMinutes}min`,
        outputSummary: 'No stale captures found',
        durationMs,
      })
      logger.info('[stale-captures] no stale captures — nothing to do')
      return { found: 0, requeued: 0, failed: 0, staleCaptures: [], durationMs }
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

    // Step 4: Log to skills_log
    const outputSummary = buildOutputSummary(staleCaptures, requeued, failed, thresholdMinutes)
    await this.logToSkillsLog({
      inputSummary: `threshold: ${thresholdMinutes}min`,
      outputSummary,
      durationMs,
    })

    return { found, requeued, failed, staleCaptures, durationMs }
  }

  // ----------------------------------------------------------
  // Private: data fetching
  // ----------------------------------------------------------

  /**
   * Finds captures stuck in 'received' or 'processing' for longer than the
   * specified threshold, ordered oldest-first.
   *
   * Uses created_at (not captured_at) as the reference — this is when the
   * row was written, so it accurately reflects how long the pipeline has
   * had a chance to process it.
   */
  private async queryStaleCaptures(thresholdMinutes: number): Promise<StaleCapture[]> {
    const rows = await this.db.execute<{
      id: string
      pipeline_status: string
      created_at: string
      age_minutes: number
    }>(
      sql.raw(`
        SELECT id, pipeline_status, created_at,
               EXTRACT(EPOCH FROM (NOW() - created_at)) / 60 AS age_minutes
        FROM captures
        WHERE pipeline_status IN ('received', 'processing')
          AND created_at < NOW() - INTERVAL '${thresholdMinutes} minutes'
        ORDER BY created_at ASC
      `),
    )

    return (rows.rows as Array<{ id: string; pipeline_status: string; created_at: string; age_minutes: number }>).map(
      (row) => ({
        id: row.id,
        pipeline_status: row.pipeline_status,
        created_at: new Date(row.created_at),
        age_minutes: Math.round(Number(row.age_minutes)),
      }),
    )
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

  // ----------------------------------------------------------
  // Private: skills_log
  // ----------------------------------------------------------

  private async logToSkillsLog(params: {
    inputSummary: string
    outputSummary: string
    durationMs: number
  }): Promise<void> {
    try {
      await this.db.insert(skills_log).values({
        skill_name: 'stale-captures',
        capture_id: null,
        input_summary: params.inputSummary,
        output_summary: params.outputSummary,
        duration_ms: params.durationMs,
      })
    } catch (err) {
      // skills_log failure is non-fatal
      logger.warn({ err }, '[stale-captures] failed to write skills_log entry')
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
