import { sql } from 'drizzle-orm'
import type { Database } from '@open-brain/shared'
import { logger } from '@open-brain/shared'
import { BaseSkill } from './base-skill.js'
import type { BaseResult, BaseSkillOpts } from './types.js'

// ============================================================
// Types
// ============================================================

export interface CaptureReminderOptions {
  /** 'morning' = simple nudge; 'evening' = capture count + last capture time */
  mode: 'morning' | 'evening'
  /** Override "now" for deterministic testing */
  now?: Date
}

export interface CaptureReminderResult extends BaseResult {
  mode: 'morning' | 'evening'
  notificationSent: boolean
  captureCount?: number
  lastCaptureAt?: string | null
}

// ============================================================
// CaptureReminderSkill
// ============================================================

/**
 * CaptureReminderSkill — lightweight Pushover nudges to encourage voice captures.
 *
 * Two modes:
 * - morning: "What's on your plate today?" (weekdays 7 AM)
 * - evening: "N captures today (last at H:MM PM). How did the day go?" (daily 9 PM)
 *
 * No LLM call, no capture creation. Just a DB query (evening) and Pushover send.
 */
export class CaptureReminderSkill extends BaseSkill<CaptureReminderOptions, CaptureReminderResult> {
  constructor(opts: BaseSkillOpts) {
    super('capture-reminder', opts)
  }

  async execute(options: CaptureReminderOptions): Promise<CaptureReminderResult> {
    const startMs = Date.now()
    const { mode } = options

    // Dynamic skill name: capture-reminder-morning or capture-reminder-evening
    this.skillName = `capture-reminder-${mode}`

    logger.info({ mode }, `[${this.skillName}] starting execution`)

    let captureCount: number | undefined
    let lastCaptureAt: string | null | undefined
    let message: string

    if (mode === 'morning') {
      message = "What's on your plate today?"
    } else {
      // Query today's capture count and last capture time
      const todayStart = new Date(options.now ?? new Date())
      todayStart.setHours(0, 0, 0, 0)

      try {
        const rows = await this.db.execute<{
          count: string
          last_at: string | null
        }>(sql`
          SELECT
            COUNT(*)::text AS count,
            MAX(created_at)::text AS last_at
          FROM captures
          WHERE created_at >= ${todayStart.toISOString()}::timestamptz
            AND deleted_at IS NULL
        `)

        captureCount = Number(rows.rows[0]?.count ?? 0)
        lastCaptureAt = rows.rows[0]?.last_at ?? null
      } catch (err) {
        logger.warn({ err }, `[${this.skillName}] failed to query captures — defaulting to 0`)
        captureCount = 0
        lastCaptureAt = null
      }

      if (captureCount > 0 && lastCaptureAt) {
        const lastTime = new Date(lastCaptureAt)
        const timeStr = lastTime.toLocaleTimeString('en-US', {
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
        })
        message = `${captureCount} capture${captureCount === 1 ? '' : 's'} today (last at ${timeStr}). How did the day go?`
      } else {
        message = 'No captures today. How did the day go?'
      }
    }

    // Send Pushover notification
    let notificationSent = false
    if (this.pushover.isConfigured) {
      try {
        await this.pushover.send({
          title: 'Open Brain',
          message,
          priority: -1,
        })
        notificationSent = true
        logger.info(`[${this.skillName}] Pushover notification sent`)
      } catch (err) {
        logger.warn({ err }, `[${this.skillName}] Pushover send failed`)
      }
    } else {
      logger.debug(`[${this.skillName}] Pushover not configured — skipping`)
    }

    const durationMs = Date.now() - startMs
    const result: CaptureReminderResult = {
      mode,
      notificationSent,
      captureCount,
      lastCaptureAt,
      durationMs,
    }

    // Log to skills_log via BaseSkill
    await this.logResult(
      result,
      `mode:${mode}`,
      `sent:${notificationSent}${captureCount !== undefined ? ` | captures:${captureCount}` : ''}`,
    )

    logger.info({ mode, notificationSent, captureCount, durationMs }, `[${this.skillName}] execution complete`)

    return result
  }
}

// ============================================================
// Skill execution entry point — called by BullMQ skill worker
// ============================================================

/**
 * Top-level function invoked by the skill-execution BullMQ worker.
 *
 * Constructs CaptureReminderSkill with production dependencies and executes.
 */
export async function executeCaptureReminder(
  db: Database,
  options: CaptureReminderOptions,
): Promise<CaptureReminderResult> {
  const skill = new CaptureReminderSkill({ db })
  return skill.execute(options)
}
