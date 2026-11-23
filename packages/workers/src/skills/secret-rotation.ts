import { execFile, type ExecFileOptions } from 'node:child_process'
import type { Database } from '@open-brain/shared'
import { logger } from '@open-brain/shared'
import { BaseSkill } from './base-skill.js'
import { recordHeartbeat } from '../lib/heartbeat.js'
import type { BaseResult, BaseSkillOpts } from './types.js'

function execFileAsync(cmd: string, args: string[], opts: ExecFileOptions = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) return reject(err)
      resolve({ stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

// ============================================================
// Types
// ============================================================

/**
 * Shape of a single secret from `bws secret list` JSON output.
 * Only the fields we care about — bws returns more, but we ignore
 * secret values entirely (they are never logged or stored).
 */
export interface BwsSecret {
  id: string
  key: string
  organizationId?: string
  projectId?: string
  revisionDate: string  // ISO 8601 timestamp
  creationDate: string  // ISO 8601 timestamp
}

export interface SecretAgeInfo {
  id: string
  key: string
  revisionDate: string
  ageDays: number
  stale: boolean
}

export interface SecretRotationOptions {
  /** Maximum age in days before a secret is considered stale. Default: 90. */
  maxAgeDays?: number
  /** Path to the bws CLI binary. Default: bws (relies on PATH or BWS_PATH env). */
  bwsBinary?: string
  /** Override "now" for deterministic testing. */
  now?: Date
}

export interface SecretRotationResult extends BaseResult {
  totalSecrets: number
  staleSecrets: SecretAgeInfo[]
  freshSecrets: number
  alertSent: boolean
  error?: string
}

// ============================================================
// Constants
// ============================================================

const DEFAULT_MAX_AGE_DAYS = 90
const DEFAULT_BWS_BINARY = 'bws'
/** Pushover message budget: the first run flags most secrets, so the report stays short. */
const MAX_REPORT_CHARS = 280
const MAX_LISTED_SECRETS = 5
const MS_PER_DAY = 1000 * 60 * 60 * 24

// ============================================================
// SecretRotationSkill
// ============================================================

/**
 * SecretRotationSkill — monthly check for stale API keys and secrets.
 *
 * Executes `bws secret list` to get all secrets from Bitwarden Secrets Manager,
 * checks `revisionDate` on each, and sends a Pushover alert if any secret
 * has not been rotated within the configured threshold (default 90 days).
 *
 * A check that cannot run (bws missing, token bad, unparseable output) raises the
 * stateful `secret-check-unavailable` alert and writes a failing `secret-rotation`
 * heartbeat; a successful run clears the alert and writes an ok heartbeat. The
 * operator-action register is NOT read here — the daily ops digest owns it.
 *
 * Design decisions:
 * - Uses `bws` CLI which reads BWS_ACCESS_TOKEN from env automatically
 * - Never logs, stores, or returns secret values — only key names and dates
 * - Injectable execFn for testability
 * - Non-fatal: CLI or parse failures degrade to an error result (never throw).
 * - skills_log entry written on both success and failure
 */
export interface SecretRotationSkillOpts extends BaseSkillOpts {
  /** Override command executor for testing. */
  execFn?: typeof execFileAsync
}

export class SecretRotationSkill extends BaseSkill<SecretRotationOptions, SecretRotationResult> {
  private execFn: typeof execFileAsync

  constructor(opts: SecretRotationSkillOpts) {
    super('secret-rotation', opts)
    this.execFn = opts.execFn ?? execFileAsync
  }

  // ----------------------------------------------------------
  // Public API
  // ----------------------------------------------------------

  /**
   * Execute the secret rotation check end-to-end.
   *
   * 1. Run `bws secret list` and parse JSON output
   * 2. Calculate age of each secret from revisionDate
   * 3. Identify stale secrets (age > maxAgeDays)
   * 4. Send a bounded Pushover report if any secrets are stale
   * 5. Write the heartbeat; raise/clear secret-check-unavailable
   * 6. Log to skills_log
   *
   * Never throws — returns a degraded result on error.
   */
  protected async run(options: SecretRotationOptions = {}): Promise<SecretRotationResult> {
    const {
      maxAgeDays = DEFAULT_MAX_AGE_DAYS,
      bwsBinary = process.env.BWS_PATH ?? DEFAULT_BWS_BINARY,
      now = new Date(),
    } = options

    const startMs = Date.now()

    logger.info({ maxAgeDays, bwsBinary }, '[secret-rotation] starting execution')

    // Step 1: Query secrets from bws CLI
    let secrets: BwsSecret[]
    try {
      secrets = await this.querySecrets(bwsBinary)
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      logger.error({ err }, '[secret-rotation] failed to query secrets from bws CLI')

      const durationMs = Date.now() - startMs
      const errorResult: SecretRotationResult = {
        totalSecrets: 0,
        staleSecrets: [],
        freshSecrets: 0,
        alertSent: false,
        durationMs,
        error: errorMsg,
      }
      // The check could not run: say so (once, via alert state) and record a failing heartbeat.
      await this.raiseAlert({
        key: 'secret-check-unavailable',
        severity: 'warning',
        bad: true,
        title: 'Secret Check Unavailable',
        message: `secret-rotation could not list secrets: ${errorMsg.slice(0, 200)}`,
      })
      await recordHeartbeat(this.db, 'secret-rotation', { ok: false, errors: [errorMsg] })
      await this.logResult(
        errorResult,
        '0 secrets checked',
        buildOutputSummary(0, 0, 0, false, errorMsg),
      )

      return errorResult
    }

    // Step 2: Calculate ages and identify stale secrets
    const secretAges = secrets.map((s) => this.calculateAge(s, now, maxAgeDays))
    const staleSecrets = secretAges.filter((s) => s.stale)
    const freshCount = secretAges.length - staleSecrets.length

    logger.info(
      { totalSecrets: secrets.length, staleCount: staleSecrets.length, freshCount },
      '[secret-rotation] age analysis complete',
    )

    // Step 3: Send report if stale secrets found
    let alertSent = false
    if (staleSecrets.length > 0) {
      alertSent = await this.sendAlert(staleSecrets, maxAgeDays)
    }

    const durationMs = Date.now() - startMs
    const result: SecretRotationResult = {
      totalSecrets: secrets.length,
      staleSecrets,
      freshSecrets: freshCount,
      alertSent,
      durationMs,
    }

    // Step 4: Heartbeat + clear any open "check unavailable" alert
    await this.raiseAlert({
      key: 'secret-check-unavailable',
      severity: 'warning',
      bad: false,
      title: 'Secret Check Unavailable',
      message: `secret-rotation listed ${secrets.length} secrets`,
    })
    await recordHeartbeat(this.db, 'secret-rotation', { ok: true, meta: { totalSecrets: secrets.length } })

    // Step 5: Log to skills_log via BaseSkill
    await this.logResult(
      result,
      `${secrets.length} secrets checked`,
      buildOutputSummary(secrets.length, staleSecrets.length, freshCount, alertSent),
    )

    logger.info(
      {
        totalSecrets: secrets.length,
        staleCount: staleSecrets.length,
        alertSent,
        durationMs,
      },
      '[secret-rotation] execution complete',
    )

    return result
  }

  // ----------------------------------------------------------
  // Private: query bws CLI
  // ----------------------------------------------------------

  /**
   * Execute `bws secret list` and parse the JSON output.
   * BWS_ACCESS_TOKEN is read from env by the bws CLI automatically.
   */
  private async querySecrets(bwsBinary: string): Promise<BwsSecret[]> {
    const { stdout } = await this.execFn(bwsBinary, ['secret', 'list'], {
      env: { ...process.env },
      timeout: 30_000,
    })

    const parsed = JSON.parse(stdout)

    // bws secret list returns an array of secret objects
    if (!Array.isArray(parsed)) {
      throw new Error('bws secret list did not return an array')
    }

    // Map to our interface, keeping only safe fields (no values)
    return parsed.map((s: Record<string, unknown>) => ({
      id: String(s.id ?? ''),
      key: String(s.key ?? ''),
      organizationId: s.organizationId != null ? String(s.organizationId) : undefined,
      projectId: s.projectId != null ? String(s.projectId) : undefined,
      revisionDate: String(s.revisionDate ?? ''),
      creationDate: String(s.creationDate ?? ''),
    }))
  }

  // ----------------------------------------------------------
  // Private: age calculation
  // ----------------------------------------------------------

  /**
   * Calculate the age of a secret based on its revisionDate.
   * Returns age in whole days and whether it exceeds the threshold.
   */
  calculateAge(secret: BwsSecret, now: Date, maxAgeDays: number): SecretAgeInfo {
    const revisionDate = new Date(secret.revisionDate)
    const ageMs = now.getTime() - revisionDate.getTime()
    const ageDays = Math.floor(ageMs / MS_PER_DAY)

    return {
      id: secret.id,
      key: secret.key,
      revisionDate: secret.revisionDate,
      ageDays,
      stale: ageDays > maxAgeDays,
    }
  }

  // ----------------------------------------------------------
  // Private: Pushover alert
  // ----------------------------------------------------------

  /**
   * Send the stale-secret report through `sendInfo` (a report, not an alert).
   * Count + the oldest names only, capped at MAX_REPORT_CHARS (never values).
   */
  private async sendAlert(staleSecrets: SecretAgeInfo[], maxAgeDays: number): Promise<boolean> {
    const message = buildStaleReport(staleSecrets, maxAgeDays)
    const sent = await this.sendInfo('Open Brain: Secret Rotation Reminder', message, 0)
    if (sent) logger.info({ staleCount: staleSecrets.length }, '[secret-rotation] stale-secret report sent')
    return sent
  }

}

// ============================================================
// Helpers
// ============================================================

/** Count plus the oldest names, trimmed to MAX_REPORT_CHARS. Exported for tests. */
export function buildStaleReport(stale: SecretAgeInfo[], maxAgeDays: number): string {
  const oldest = [...stale].sort((a, b) => b.ageDays - a.ageDays).slice(0, MAX_LISTED_SECRETS)
  const head = `${stale.length} secret${stale.length === 1 ? '' : 's'} older than ${maxAgeDays}d. Oldest: `
  let msg = head
  let listed = 0
  for (const s of oldest) {
    const item = `${listed > 0 ? ', ' : ''}${s.key} (${s.ageDays}d)`
    if (msg.length + item.length > MAX_REPORT_CHARS) break
    msg += item
    listed++
  }
  return msg
}

function buildOutputSummary(
  totalSecrets: number,
  staleCount: number,
  freshCount: number,
  alertSent: boolean,
  error?: string,
): string {
  const parts = [
    `total:${totalSecrets}`,
    `stale:${staleCount}`,
    `fresh:${freshCount}`,
    `alert:${alertSent}`,
  ]
  if (error) {
    parts.push(`error:${error.slice(0, 200)}`)
  }
  return parts.join(' | ')
}

// ============================================================
// Skill execution entry point — called by BullMQ skill worker
// ============================================================

/**
 * Top-level function invoked by the skill-execution BullMQ worker.
 *
 * Constructs SecretRotationSkill with production dependencies and executes.
 */
export async function executeSecretRotation(
  db: Database,
  options: SecretRotationOptions = {},
): Promise<SecretRotationResult> {
  const skill = new SecretRotationSkill({ db })
  return skill.execute(options)
}
