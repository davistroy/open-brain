import { execFile } from 'node:child_process'
import type { Database } from '@open-brain/shared'
import { skills_log, logger, PushoverService } from '@open-brain/shared'

function execFileAsync(cmd: string, args: string[], opts: Record<string, unknown> = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts as any, (err, stdout, stderr) => {
      if (err) return reject(err)
      resolve({ stdout: stdout as string, stderr: stderr as string })
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

export interface SecretRotationResult {
  totalSecrets: number
  staleSecrets: SecretAgeInfo[]
  freshSecrets: number
  alertSent: boolean
  durationMs: number
  error?: string
}

// ============================================================
// Constants
// ============================================================

const DEFAULT_MAX_AGE_DAYS = 90
const DEFAULT_BWS_BINARY = 'bws'

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
 * Design decisions:
 * - Uses `bws` CLI which reads BWS_ACCESS_TOKEN from env automatically
 * - Never logs, stores, or returns secret values — only key names and dates
 * - Injectable execFn for testability (tests supply mock CLI output)
 * - Non-fatal: CLI or parse failures return degraded result, logs warning
 * - skills_log entry written on both success and failure
 */
export class SecretRotationSkill {
  private db: Database
  private pushover: PushoverService
  private execFn: typeof execFileAsync

  constructor(opts: {
    db: Database
    pushover?: PushoverService
    /** Override command executor for testing. */
    execFn?: typeof execFileAsync
  }) {
    this.db = opts.db
    this.pushover = opts.pushover ?? new PushoverService()
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
   * 4. Send Pushover alert if any secrets are stale
   * 5. Log to skills_log
   *
   * Never throws — returns a degraded result on error.
   */
  async execute(options: SecretRotationOptions = {}): Promise<SecretRotationResult> {
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
      await this.logToSkillsLog({
        totalSecrets: 0,
        staleCount: 0,
        freshCount: 0,
        alertSent: false,
        durationMs,
        error: errorMsg,
      })

      return {
        totalSecrets: 0,
        staleSecrets: [],
        freshSecrets: 0,
        alertSent: false,
        durationMs,
        error: errorMsg,
      }
    }

    // Step 2: Calculate ages and identify stale secrets
    const secretAges = secrets.map((s) => this.calculateAge(s, now, maxAgeDays))
    const staleSecrets = secretAges.filter((s) => s.stale)
    const freshCount = secretAges.length - staleSecrets.length

    logger.info(
      { totalSecrets: secrets.length, staleCount: staleSecrets.length, freshCount },
      '[secret-rotation] age analysis complete',
    )

    // Step 3: Send alert if stale secrets found
    let alertSent = false
    if (staleSecrets.length > 0) {
      alertSent = await this.sendAlert(staleSecrets, maxAgeDays)
    }

    const durationMs = Date.now() - startMs

    // Step 4: Log to skills_log
    await this.logToSkillsLog({
      totalSecrets: secrets.length,
      staleCount: staleSecrets.length,
      freshCount,
      alertSent,
      durationMs,
    })

    logger.info(
      { totalSecrets: secrets.length, staleCount: staleSecrets.length, alertSent, durationMs },
      '[secret-rotation] execution complete',
    )

    return {
      totalSecrets: secrets.length,
      staleSecrets,
      freshSecrets: freshCount,
      alertSent,
      durationMs,
    }
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
    const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24))

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
   * Send a Pushover alert listing stale secrets.
   * Priority 0 (normal) — rotation is advisory, not urgent.
   */
  private async sendAlert(staleSecrets: SecretAgeInfo[], maxAgeDays: number): Promise<boolean> {
    if (!this.pushover.isConfigured) {
      logger.debug('[secret-rotation] Pushover not configured — skipping alert')
      return false
    }

    const lines: string[] = [
      `${staleSecrets.length} secret${staleSecrets.length === 1 ? '' : 's'} older than ${maxAgeDays} days:`,
      '',
    ]

    // List each stale secret with its age (never log values)
    for (const s of staleSecrets) {
      lines.push(`  ${s.key}: ${s.ageDays} days (last rotated ${s.revisionDate.split('T')[0]})`)
    }

    lines.push('', 'Rotate these keys in Bitwarden Secrets Manager.')

    const message = lines.join('\n')

    try {
      await this.pushover.send({
        title: 'Open Brain: Secret Rotation Reminder',
        message,
        priority: 0,
      })
      logger.info({ staleCount: staleSecrets.length }, '[secret-rotation] Pushover alert sent')
      return true
    } catch (err) {
      logger.warn({ err }, '[secret-rotation] Pushover alert failed — continuing')
      return false
    }
  }

  // ----------------------------------------------------------
  // Private: skills_log
  // ----------------------------------------------------------

  private async logToSkillsLog(params: {
    totalSecrets: number
    staleCount: number
    freshCount: number
    alertSent: boolean
    durationMs: number
    error?: string
  }): Promise<void> {
    const inputSummary = `${params.totalSecrets} secrets checked`
    const outputParts = [
      `total:${params.totalSecrets}`,
      `stale:${params.staleCount}`,
      `fresh:${params.freshCount}`,
      `alert:${params.alertSent}`,
    ]
    if (params.error) {
      outputParts.push(`error:${params.error.slice(0, 200)}`)
    }
    const outputSummary = outputParts.join(' | ')

    try {
      await this.db.insert(skills_log).values({
        skill_name: 'secret-rotation',
        capture_id: null,
        input_summary: inputSummary,
        output_summary: outputSummary,
        duration_ms: params.durationMs,
      })
    } catch (err) {
      // skills_log failure is non-fatal
      logger.warn({ err }, '[secret-rotation] failed to write skills_log entry')
    }
  }
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
