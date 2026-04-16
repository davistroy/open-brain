import { skills_log, logger, PushoverService } from '@open-brain/shared'
import type { Database } from '@open-brain/shared'
import type { BaseResult, BaseSkillOpts } from './types.js'

/**
 * BaseSkill — abstract base class for all Open Brain skills.
 *
 * Provides shared infrastructure that every skill needs:
 * - `db` and `pushover` via constructor
 * - `logResult()` — writes to `skills_log` table (all 27 skills do this)
 * - `sendNotification()` — Pushover with error handling (20/27 skills)
 * - `formatDuration()` / `truncate()` — common formatting utilities
 *
 * Subclasses implement `execute(input)` with their domain logic.
 * The return type must extend `BaseResult` (at minimum includes `durationMs`).
 */
export abstract class BaseSkill<TInput, TResult extends BaseResult> {
  protected db: Database
  protected pushover: PushoverService
  protected skillName: string

  constructor(skillName: string, opts: BaseSkillOpts) {
    this.skillName = skillName
    this.db = opts.db
    this.pushover = opts.pushover ?? new PushoverService()
  }

  /**
   * Execute the skill's core logic. Subclasses must implement this.
   */
  abstract execute(input: TInput): Promise<TResult>

  // ──────────────────────────────────────────────────────────────
  // Shared: skills_log
  // ──────────────────────────────────────────────────────────────

  /**
   * Writes a row to the `skills_log` table. Catches and logs errors
   * so that logging failure never crashes the skill.
   *
   * @param result   The skill result (stored as JSONB in `result` column)
   * @param inputSummary  Short description of the input (e.g., "mode:evening")
   * @param outputSummary Short description of the output (e.g., "sent:true | captures:3")
   * @param captureId     Optional capture UUID to link the log entry
   */
  protected async logResult(
    result: TResult,
    inputSummary: string,
    outputSummary?: string,
    captureId?: string,
  ): Promise<void> {
    try {
      await this.db.insert(skills_log).values({
        skill_name: this.skillName,
        capture_id: captureId ?? null,
        input_summary: inputSummary,
        output_summary: outputSummary ?? null,
        result: result as unknown as Record<string, unknown>,
        duration_ms: result.durationMs,
      })
    } catch (err) {
      logger.warn({ err, skillName: this.skillName }, 'Failed to write skills_log entry')
    }
  }

  // ──────────────────────────────────────────────────────────────
  // Shared: Pushover notification
  // ──────────────────────────────────────────────────────────────

  /**
   * Sends a Pushover notification with error handling.
   * Returns `true` if sent successfully, `false` if not configured or on error.
   * Never throws — failures are logged and swallowed.
   */
  protected async sendNotification(
    title: string,
    message: string,
    priority?: number,
  ): Promise<boolean> {
    if (!this.pushover.isConfigured) return false
    try {
      await this.pushover.send({ title, message, priority: (priority ?? 0) as -2 | -1 | 0 | 1 | 2 })
      return true
    } catch (err) {
      logger.warn({ err, skillName: this.skillName }, 'Pushover send failed')
      return false
    }
  }

  // ──────────────────────────────────────────────────────────────
  // Shared: formatting utilities
  // ──────────────────────────────────────────────────────────────

  /**
   * Formats a duration in milliseconds to a human-readable string.
   * Under 1 second: "42ms". Over 1 second: "3.2s".
   */
  protected formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`
    return `${(ms / 1000).toFixed(1)}s`
  }

  /**
   * Truncates text to a maximum length, appending "..." if truncated.
   * Trims whitespace before measuring.
   */
  protected truncate(text: string, max = 100): string {
    const trimmed = text.trim()
    if (trimmed.length <= max) return trimmed
    return trimmed.slice(0, max) + '...'
  }
}
