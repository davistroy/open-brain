import { skills_log, logger, PushoverService, meetsAutonomyLevel } from '@open-brain/shared'
import type { Database, AutonomyLevel } from '@open-brain/shared'
import type { BaseResult, BaseSkillOpts } from './types.js'
import { requireCoreApiUrl } from '../lib/require-core-api-url.js'

// Module-level autonomy cache (5-minute TTL, matches slack-bot pattern)
let _autonomyCache: { level: AutonomyLevel; fetchedAt: number } | null = null
const AUTONOMY_CACHE_TTL = 5 * 60 * 1000

async function fetchAutonomyLevel(coreApiUrl: string): Promise<AutonomyLevel> {
  const now = Date.now()
  if (_autonomyCache && now - _autonomyCache.fetchedAt < AUTONOMY_CACHE_TTL) {
    return _autonomyCache.level
  }
  try {
    const response = await fetch(`${coreApiUrl}/api/v1/settings/autonomy_level`, {
      headers: { 'X-Open-Brain-Caller': 'workers' },
    })
    if (response.ok) {
      const data = (await response.json()) as { value: string }
      const level = (['observe', 'assist', 'advise', 'partner'].includes(data.value)
        ? data.value
        : 'observe') as AutonomyLevel
      _autonomyCache = { level, fetchedAt: now }
      return level
    }
  } catch {
    // Settings unavailable — default to observe (most restrictive)
  }
  _autonomyCache = { level: 'observe', fetchedAt: now }
  return 'observe'
}

export function _resetBaseSkillAutonomyCacheForTest(): void {
  _autonomyCache = null
}

/**
 * BaseSkill — abstract base class for all Open Brain skills.
 *
 * Provides shared infrastructure that every skill needs:
 * - `db` and `pushover` via constructor
 * - `logResult()` — writes to `skills_log` table (all 27 skills do this)
 * - `sendNotification()` — Pushover with error handling (20/27 skills)
 * - `formatDuration()` / `truncate()` — common formatting utilities
 *
 * Subclasses implement `run(input)` with their domain logic.
 * The `execute()` method is a concrete template-method wrapper that checks
 * `static minimum_autonomy` before delegating to `run()`.
 * Never override `execute()` in subclasses — implement `run()`.
 *
 * The return type must extend `BaseResult` (at minimum includes `durationMs`).
 */
export abstract class BaseSkill<TInput, TResult extends BaseResult> {
  protected db: Database
  protected pushover: PushoverService
  protected skillName: string

  // Declare a minimum autonomy level for proactive skills.
  // Absence = ungated (reactive pipeline skills are safe).
  static minimum_autonomy?: AutonomyLevel

  constructor(skillName: string, opts: BaseSkillOpts) {
    this.skillName = skillName
    this.db = opts.db
    this.pushover = opts.pushover ?? new PushoverService()
  }

  /**
   * Template-method wrapper. Checks `static minimum_autonomy` before delegating
   * to `run()`. Do NOT override this in subclasses — implement `run()` instead.
   *
   * `input` is optional at the base layer to preserve backwards compatibility
   * with subclasses whose `run()` declares a default value (e.g.,
   * `run(opts: T = {})`). The optionality is normalized here and `run()` still
   * receives whatever default the subclass defined.
   */
  async execute(input?: TInput): Promise<TResult> {
    const ctor = this.constructor as typeof BaseSkill
    const minimumAutonomy = ctor.minimum_autonomy

    if (minimumAutonomy !== undefined) {
      // SE-16: fail-closed resolution — no silent localhost fallback in production.
      // (main.ts asserts this at boot, so production never reaches the throw here.)
      const coreApiUrl = requireCoreApiUrl()
      const currentLevel = await fetchAutonomyLevel(coreApiUrl)

      if (!meetsAutonomyLevel(currentLevel, minimumAutonomy)) {
        logger.info(
          { skillName: this.skillName, currentLevel, minimumAutonomy },
          `[base-skill] gated — autonomy ${currentLevel} < required ${minimumAutonomy}`,
        )
        return {
          status: 'gated',
          durationMs: 0,
          currentAutonomyLevel: currentLevel,
          requiredAutonomyLevel: minimumAutonomy,
        } as unknown as TResult
      }
    }

    return this.run(input as TInput)
  }

  /**
   * Execute the skill's core logic. Subclasses must implement this.
   * This is called by `execute()` after passing the autonomy gate.
   */
  protected abstract run(input: TInput): Promise<TResult>

  // ──────────────────────────────────────────────────────────────
  // Shared: skills_log
  // ──────────────────────────────────────────────────────────────

  /**
   * Writes a row to the `skills_log` table. Catches and logs errors
   * so that logging failure never crashes the skill.
   *
   * Returns the inserted `skills_log.id` (UUID string) so brief-producing
   * skills can link their `briefs` row back to the log entry. Returns an
   * empty string on insert failure (error is still logged; callers that
   * discard the return value are unaffected).
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
  ): Promise<string> {
    try {
      const rows = await this.db.insert(skills_log).values({
        skill_name: this.skillName,
        capture_id: captureId ?? null,
        input_summary: inputSummary,
        output_summary: outputSummary ?? null,
        result: result as unknown as Record<string, unknown>,
        duration_ms: result.durationMs,
      }).returning({ id: skills_log.id })
      return rows[0]?.id ?? ''
    } catch (err) {
      logger.warn({ err, skillName: this.skillName }, 'Failed to write skills_log entry')
      return ''
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
