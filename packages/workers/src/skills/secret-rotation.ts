import { execFile, type ExecFileOptions } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import type { Database } from '@open-brain/shared'
import { logger } from '@open-brain/shared'
import { BaseSkill } from './base-skill.js'
import type { BaseResult, BaseSkillOpts } from './types.js'

function execFileAsync(cmd: string, args: string[], opts: ExecFileOptions = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) return reject(err)
      resolve({ stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

type ReadFileFn = (path: string) => Promise<string>

const defaultReadFile: ReadFileFn = (path) => readFile(path, 'utf8')

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

/**
 * A single row from the OPERATOR_ACTIONS.md "## Open Actions" table (RC-19).
 * `dueDate` is null when the Due cell is not a plain YYYY-MM-DD date
 * (e.g. "next restart window") — such rows are never flagged overdue.
 */
export interface OperatorAction {
  id: string
  action: string
  due: string
  dueDate: Date | null
  owner: string
  source: string
  status: string
}

export interface OperatorActionCheck {
  /** true once the register was read + parsed; false if the file was absent/unreadable. */
  checked: boolean
  overdue: OperatorAction[]
  approaching: OperatorAction[]
  alertSent: boolean
}

export interface SecretRotationOptions {
  /** Maximum age in days before a secret is considered stale. Default: 90. */
  maxAgeDays?: number
  /** Path to the bws CLI binary. Default: bws (relies on PATH or BWS_PATH env). */
  bwsBinary?: string
  /** Override "now" for deterministic testing. */
  now?: Date
  /** Path to the dated operator-actions register. Default: OPERATOR_ACTIONS_PATH env or /app/OPERATOR_ACTIONS.md. */
  operatorActionsPath?: string
  /** Days-ahead window that counts a dated action as "approaching". Default: 7. */
  approachingDays?: number
}

export interface SecretRotationResult extends BaseResult {
  totalSecrets: number
  staleSecrets: SecretAgeInfo[]
  freshSecrets: number
  alertSent: boolean
  /** RC-19 operator-action reminder outcome (independent of the secret check). */
  operatorActions: OperatorActionCheck
  error?: string
}

// ============================================================
// Constants
// ============================================================

const DEFAULT_MAX_AGE_DAYS = 90
const DEFAULT_BWS_BINARY = 'bws'
const DEFAULT_OPERATOR_ACTIONS_PATH = process.env.OPERATOR_ACTIONS_PATH ?? '/app/OPERATOR_ACTIONS.md'
const DEFAULT_APPROACHING_DAYS = 7
const MS_PER_DAY = 1000 * 60 * 60 * 24

// ============================================================
// SecretRotationSkill
// ============================================================

/**
 * SecretRotationSkill — monthly check for stale API keys and secrets,
 * plus (RC-19) a reminder pass over the dated OPERATOR_ACTIONS.md register.
 *
 * Executes `bws secret list` to get all secrets from Bitwarden Secrets Manager,
 * checks `revisionDate` on each, and sends a Pushover alert if any secret
 * has not been rotated within the configured threshold (default 90 days).
 *
 * It ALSO reads OPERATOR_ACTIONS.md and Pushover-alerts on any OPEN/IN-PROGRESS
 * operator action that is overdue or approaching its Due date — the forcing
 * function that keeps post-merge operator actions from silently lapsing.
 *
 * Design decisions:
 * - Uses `bws` CLI which reads BWS_ACCESS_TOKEN from env automatically
 * - Never logs, stores, or returns secret values — only key names and dates
 * - Injectable execFn / readFileFn for testability
 * - Non-fatal: CLI, parse, or file failures degrade gracefully and log warnings.
 *   The operator-action check runs even when the bws query fails (the two are
 *   independent), and skips cleanly when OPERATOR_ACTIONS.md is absent — the
 *   file is mounted read-only into the workers container but may be missing.
 * - skills_log entry written on both success and failure
 */
export interface SecretRotationSkillOpts extends BaseSkillOpts {
  /** Override command executor for testing. */
  execFn?: typeof execFileAsync
  /** Override file reader for testing. */
  readFileFn?: ReadFileFn
}

export class SecretRotationSkill extends BaseSkill<SecretRotationOptions, SecretRotationResult> {
  private execFn: typeof execFileAsync
  private readFileFn: ReadFileFn

  constructor(opts: SecretRotationSkillOpts) {
    super('secret-rotation', opts)
    this.execFn = opts.execFn ?? execFileAsync
    this.readFileFn = opts.readFileFn ?? defaultReadFile
  }

  // ----------------------------------------------------------
  // Public API
  // ----------------------------------------------------------

  /**
   * Execute the secret rotation check + operator-action reminder end-to-end.
   *
   * 1. Read OPERATOR_ACTIONS.md and Pushover-alert overdue/approaching items (RC-19)
   * 2. Run `bws secret list` and parse JSON output
   * 3. Calculate age of each secret from revisionDate
   * 4. Identify stale secrets (age > maxAgeDays)
   * 5. Send Pushover alert if any secrets are stale
   * 6. Log to skills_log
   *
   * Never throws — returns a degraded result on error.
   */
  protected async run(options: SecretRotationOptions = {}): Promise<SecretRotationResult> {
    const {
      maxAgeDays = DEFAULT_MAX_AGE_DAYS,
      bwsBinary = process.env.BWS_PATH ?? DEFAULT_BWS_BINARY,
      now = new Date(),
      operatorActionsPath = DEFAULT_OPERATOR_ACTIONS_PATH,
      approachingDays = DEFAULT_APPROACHING_DAYS,
    } = options

    const startMs = Date.now()

    logger.info({ maxAgeDays, bwsBinary }, '[secret-rotation] starting execution')

    // Step 1: Operator-action reminders (RC-19) — runs regardless of bws state
    const operatorActions = await this.checkOperatorActions(operatorActionsPath, now, approachingDays)

    // Step 2: Query secrets from bws CLI
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
        operatorActions,
        durationMs,
        error: errorMsg,
      }
      await this.logResult(
        errorResult,
        '0 secrets checked',
        buildOutputSummary(0, 0, 0, false, operatorActions, errorMsg),
      )

      return errorResult
    }

    // Step 3: Calculate ages and identify stale secrets
    const secretAges = secrets.map((s) => this.calculateAge(s, now, maxAgeDays))
    const staleSecrets = secretAges.filter((s) => s.stale)
    const freshCount = secretAges.length - staleSecrets.length

    logger.info(
      { totalSecrets: secrets.length, staleCount: staleSecrets.length, freshCount },
      '[secret-rotation] age analysis complete',
    )

    // Step 4: Send alert if stale secrets found
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
      operatorActions,
      durationMs,
    }

    // Step 5: Log to skills_log via BaseSkill
    await this.logResult(
      result,
      `${secrets.length} secrets checked`,
      buildOutputSummary(secrets.length, staleSecrets.length, freshCount, alertSent, operatorActions),
    )

    logger.info(
      {
        totalSecrets: secrets.length,
        staleCount: staleSecrets.length,
        alertSent,
        operatorOverdue: operatorActions.overdue.length,
        operatorApproaching: operatorActions.approaching.length,
        durationMs,
      },
      '[secret-rotation] execution complete',
    )

    return result
  }

  // ----------------------------------------------------------
  // Private: operator-action register (RC-19)
  // ----------------------------------------------------------

  /**
   * Read OPERATOR_ACTIONS.md, find OPEN/IN-PROGRESS rows whose dated Due is
   * overdue or within `approachingDays`, and Pushover-alert them.
   *
   * Graceful: a missing/unreadable file logs a warning and returns
   * `{ checked: false }` — it never fails the skill (the file is mounted
   * read-only into the container but may be absent on some deployments).
   */
  private async checkOperatorActions(
    path: string,
    now: Date,
    approachingDays: number,
  ): Promise<OperatorActionCheck> {
    let content: string
    try {
      content = await this.readFileFn(path)
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), path },
        '[secret-rotation] OPERATOR_ACTIONS.md unreadable — skipping operator-action reminders',
      )
      return { checked: false, overdue: [], approaching: [], alertSent: false }
    }

    const actions = parseOperatorActions(content)
    const approachingMs = approachingDays * MS_PER_DAY
    const overdue: OperatorAction[] = []
    const approaching: OperatorAction[] = []

    for (const a of actions) {
      const st = a.status.toUpperCase()
      if (st.startsWith('DONE') || st.startsWith('BLOCKED')) continue
      if (!a.dueDate) continue // undated Due (e.g. "next restart window") — never overdue
      const delta = a.dueDate.getTime() - now.getTime()
      if (delta < 0) overdue.push(a)
      else if (delta <= approachingMs) approaching.push(a)
    }

    let alertSent = false
    if (overdue.length > 0 || approaching.length > 0) {
      alertSent = await this.sendOperatorActionAlert(overdue, approaching, approachingDays)
    }

    return { checked: true, overdue, approaching, alertSent }
  }

  /**
   * Pushover-alert overdue + approaching operator actions.
   * Priority 1 (high) when anything is overdue, else 0 (advisory).
   */
  private async sendOperatorActionAlert(
    overdue: OperatorAction[],
    approaching: OperatorAction[],
    approachingDays: number,
  ): Promise<boolean> {
    if (!this.pushover.isConfigured) {
      logger.debug('[secret-rotation] Pushover not configured — skipping operator-action alert')
      return false
    }

    const lines: string[] = []
    if (overdue.length > 0) {
      lines.push(`${overdue.length} OVERDUE operator action${overdue.length === 1 ? '' : 's'}:`)
      for (const a of overdue) lines.push(`  [${a.id}] ${a.action.slice(0, 90)} (due ${a.due})`)
      lines.push('')
    }
    if (approaching.length > 0) {
      lines.push(`${approaching.length} due within ${approachingDays} days:`)
      for (const a of approaching) lines.push(`  [${a.id}] ${a.action.slice(0, 90)} (due ${a.due})`)
      lines.push('')
    }
    lines.push('See OPERATOR_ACTIONS.md.')

    try {
      await this.pushover.send({
        title: 'Open Brain: Operator Actions Due',
        message: lines.join('\n'),
        priority: overdue.length > 0 ? 1 : 0,
      })
      logger.info(
        { overdue: overdue.length, approaching: approaching.length },
        '[secret-rotation] operator-action Pushover alert sent',
      )
      return true
    } catch (err) {
      logger.warn({ err }, '[secret-rotation] operator-action Pushover alert failed — continuing')
      return false
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

}

// ============================================================
// Helpers
// ============================================================

/**
 * Parse the "## Open Actions" markdown table from OPERATOR_ACTIONS.md.
 * Rows under "## Completed Actions" are ignored. Header/separator rows are
 * skipped. Exported for unit testing.
 */
export function parseOperatorActions(markdown: string): OperatorAction[] {
  const openIdx = markdown.indexOf('## Open Actions')
  if (openIdx === -1) return []
  const rest = markdown.slice(openIdx)
  const endIdx = rest.indexOf('## Completed Actions')
  const section = endIdx === -1 ? rest : rest.slice(0, endIdx)

  const rows: OperatorAction[] = []
  for (const line of section.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('|')) continue
    const cells = trimmed.split('|').slice(1, -1).map((c) => c.trim())
    if (cells.length < 6) continue
    const [id, action, due, owner, source, status] = cells
    if (id === 'ID' || /^-+$/.test(id)) continue // header row or |---| separator
    rows.push({ id, action, due, owner, source, status, dueDate: parseDueDate(due) })
  }
  return rows
}

/** Parse a Due cell as a UTC date; returns null for non-YYYY-MM-DD phrases. */
function parseDueDate(due: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) return null
  const d = new Date(`${due}T00:00:00Z`)
  return Number.isNaN(d.getTime()) ? null : d
}

function buildOutputSummary(
  totalSecrets: number,
  staleCount: number,
  freshCount: number,
  alertSent: boolean,
  operatorActions: OperatorActionCheck,
  error?: string,
): string {
  const parts = [
    `total:${totalSecrets}`,
    `stale:${staleCount}`,
    `fresh:${freshCount}`,
    `alert:${alertSent}`,
    `ops_overdue:${operatorActions.overdue.length}`,
    `ops_approaching:${operatorActions.approaching.length}`,
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
