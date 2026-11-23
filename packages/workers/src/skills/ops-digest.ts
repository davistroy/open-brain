import { stat } from 'node:fs/promises'
import { sql } from 'drizzle-orm'
import type { Database, PushoverService } from '@open-brain/shared'
import { logger, SlackMessenger, loadOperatorActions, parseOperatorActions, summarizeOperatorActions } from '@open-brain/shared'
import type { LoadOperatorActionsOpts } from '@open-brain/shared'
import { BaseSkill } from './base-skill.js'
import type { BaseResult, BaseSkillOpts } from './types.js'
import { listOpenAlerts, alertStateEnabled, describeAlertKey } from '../lib/alert-state.js'
import type { OpenAlert } from '../lib/alert-state.js'
import { DEFAULT_BACKUP_MANIFEST_PATH } from '../lib/backup-age.js'

// ============================================================
// ops-digest (ADR-0005, item 2.4)
// ============================================================
//
// One Pushover per day (07:30 scheduler time): open alerts with their ages
// first, then one line per report source read from `skills_log`, then the
// backup age. The full text goes to the Slack DM. Nothing is sent when no
// alert is open and no report row exists in the last 24 hours.
//
// T0 only — no LLM call. The digest INPUT is `skills_log.output_summary`:
// item 2.5 turns the direct pushes of the report skills off
// (ALERT_LEGACY_PUSH=false) and the digest keeps reading the rows they
// already write, so a new report source needs only an entry in
// DIGEST_INFO_SOURCES.
//
// The alert block is read only while ALERT_STATE_ENABLED is on: with the
// switch off nothing updates `alert_state:*`, so those rows are frozen at
// their last value and would list stale alerts forever. A failed alert-state
// read is fail-soft: one "Alert state unavailable" line, and the report lines
// are still sent.

/** Skills whose newest `skills_log.output_summary` (last 24 h) becomes one digest line. */
export const DIGEST_INFO_SOURCES = [
  'drift-monitor',
  'wiki-lint',
  'email-classify',
  'capture-dedup-sweep',
  'storage-audit',
  'memory-consolidation',
  'secret-rotation',
] as const

/** Pushover message cap (PushoverService truncates above this). */
export const PUSH_CAP = 1024
const ALERT_LINE_MAX = 110
const INFO_LINE_MAX = 200
const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

export interface DigestAlert {
  key: string
  ageMs: number
  /** Highest escalation level sent (0 none, 1 = 24 h, 2 = 7 d). */
  level: 0 | 1 | 2
  acked: boolean
}

export interface OpsDigest {
  openAlerts: DigestAlert[]
  /** True when the alert-state read failed; the digest says so in one line. */
  alertStateUnavailable: boolean
  infoLines: string[]
  backupAgeSeconds: number | null
  /** True when there is no open alert, no alert-state error and no report line: nothing to send. */
  isEmpty: boolean
  /** Pushover text: every alert line first, <= PUSH_CAP characters. */
  pushText: string
  /** Everything, for the Slack DM. */
  fullText: string
}

export interface BuildOpsDigestOpts {
  /** Register source overrides (tests). Default: GitHub raw, then `OPERATOR_ACTIONS_PATH` or `/app/OPERATOR_ACTIONS.md`. */
  operatorActions?: Partial<LoadOperatorActionsOpts>
  /** Latest-backup manifest path. Default `BACKUP_LATEST_PATH` or `/backup-latest/manifest.json`. */
  backupManifestPath?: string
}

function clip(s: string, max: number): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

function fmtAge(ms: number): string {
  const hours = Math.max(0, Math.floor(ms / HOUR_MS))
  return hours >= 48 ? `${Math.floor(hours / 24)} d` : `${hours} h`
}

function alertLine(a: DigestAlert): string {
  const tags = [a.level === 2 ? 'escalated 7d' : a.level === 1 ? 'escalated 24h' : '', a.acked ? 'acked' : '']
    .filter(Boolean)
    .join(', ')
  return clip(`- ${describeAlertKey(a.key)}: open ${fmtAge(a.ageMs)}${tags ? ` (${tags})` : ''}`, ALERT_LINE_MAX)
}

async function readBackupAgeSeconds(now: Date, manifestPath: string): Promise<number | null> {
  try {
    const s = await stat(manifestPath)
    return Math.max(0, Math.floor((now.getTime() - s.mtime.getTime()) / 1000))
  } catch {
    return null
  }
}

/** Newest `output_summary` per digest source in the last 24 h, one line each. Never throws. */
async function readInfoLines(db: Database, now: Date): Promise<string[]> {
  const since = new Date(now.getTime() - DAY_MS).toISOString()
  try {
    const names = sql.join(DIGEST_INFO_SOURCES.map((n) => sql`${n}`), sql`, `)
    const res = await db.execute<{ skill_name: string; output_summary: string | null }>(sql`
      SELECT DISTINCT ON (skill_name) skill_name, output_summary
      FROM skills_log
      WHERE skill_name IN (${names}) AND created_at >= ${since}::timestamptz
      ORDER BY skill_name, created_at DESC
    `)
    const order = new Map<string, number>(DIGEST_INFO_SOURCES.map((n, i) => [n, i]))
    return res.rows
      .slice()
      .sort((a, b) => (order.get(a.skill_name) ?? 99) - (order.get(b.skill_name) ?? 99))
      .map((r) => clip(`- ${r.skill_name}: ${r.output_summary?.trim() || '(no summary)'}`, INFO_LINE_MAX))
  } catch (err) {
    logger.warn({ err }, '[ops-digest] report query failed — continuing without report lines')
    return []
  }
}

/**
 * Open alerts, or [] while ALERT_STATE_ENABLED=false (frozen rows are not
 * read). Never throws: a read error returns `unavailable: true`.
 */
async function readOpenAlerts(db: Database): Promise<{ open: OpenAlert[]; unavailable: boolean }> {
  if (!alertStateEnabled()) return { open: [], unavailable: false }
  try {
    return { open: await listOpenAlerts(db), unavailable: false }
  } catch (err) {
    logger.warn({ err }, '[ops-digest] alert-state read failed — continuing without the alert list')
    return { open: [], unavailable: true }
  }
}

/**
 * The operator-action line (item 3.2): `ops: M overdue; oldest: <3 IDs>` (+
 * `; N parse error(s)`), `ops: register unreadable` when both sources fail,
 * or null when nothing is overdue and every status parses. Never throws.
 */
async function readOperatorActionLine(
  now: Date,
  opts: Partial<LoadOperatorActionsOpts> = {},
): Promise<{ line: string | null; noteworthy: boolean }> {
  try {
    const md = await loadOperatorActions({
      fallbackPath: process.env.OPERATOR_ACTIONS_PATH ?? '/app/OPERATOR_ACTIONS.md',
      ...opts,
    })
    const s = summarizeOperatorActions(parseOperatorActions(md), now)
    const errs = s.parseErrors.length
    if (s.overdue === 0 && errs === 0) return { line: null, noteworthy: false }
    const parts = [`ops: ${s.overdue} overdue`]
    if (s.oldest.length > 0) parts[0] += `; oldest: ${s.oldest.map((a) => a.id).join(', ')}`
    if (errs > 0) parts.push(`${errs} parse error${errs === 1 ? '' : 's'}`)
    return { line: parts.join('; '), noteworthy: true }
  } catch (err) {
    logger.warn({ err }, '[ops-digest] operator-action register unreadable — continuing without it')
    // Unreadable alone does not trigger a send, but rides along on any digest that is sent.
    return { line: 'ops: register unreadable', noteworthy: false }
  }
}

export async function buildOpsDigest(db: Database, now: Date, opts: BuildOpsDigestOpts = {}): Promise<OpsDigest> {
  const { open, unavailable: alertStateUnavailable } = await readOpenAlerts(db)
  const openAlerts: DigestAlert[] = open
    .map((o) => ({
      key: o.key,
      ageMs: now.getTime() - Date.parse(o.state.since),
      level: o.state.level,
      acked: o.state.acked_at !== null,
    }))
    .sort((a, b) => b.ageMs - a.ageMs)
  const infoLines = await readInfoLines(db, now)
  const manifestPath = opts.backupManifestPath ?? process.env.BACKUP_LATEST_PATH ?? DEFAULT_BACKUP_MANIFEST_PATH
  const backupAgeSeconds = await readBackupAgeSeconds(now, manifestPath)

  const ops = await readOperatorActionLine(now, opts.operatorActions)

  const isEmpty = openAlerts.length === 0 && infoLines.length === 0 && !alertStateUnavailable && !ops.noteworthy
  const backupLine =
    backupAgeSeconds === null ? 'Backup: age unknown' : `Backup: ${fmtAge(backupAgeSeconds * 1000)} old`

  const alertBlock: string[] = alertStateUnavailable
    ? ['Alert state unavailable']
    : openAlerts.length > 0 ? [`Open alerts (${openAlerts.length}):`, ...openAlerts.map(alertLine)] : []
  if (ops.line) alertBlock.push(ops.line)
  const reportBlock = infoLines.length > 0 ? ['Reports:', ...infoLines] : []
  const fullText = [...alertBlock, ...reportBlock, backupLine].join('\n')

  // pushText: alerts always; then the backup line and report lines while they fit.
  const push = [...alertBlock]
  let omitted = 0
  const tail = [backupLine, ...(infoLines.length > 0 ? ['Reports:', ...infoLines] : [])]
  const reserve = 24 // room for "(+NN more in Slack)"
  for (const line of tail) {
    const next = [...push, line].join('\n')
    if (next.length + reserve <= PUSH_CAP) push.push(line)
    else omitted++
  }
  if (omitted > 0) push.push(`(+${omitted} more in Slack)`)
  let pushText = push.join('\n')
  if (pushText.length > PUSH_CAP) pushText = pushText.slice(0, PUSH_CAP) // only if alerts alone overflow

  return { openAlerts, alertStateUnavailable, infoLines, backupAgeSeconds, isEmpty, pushText, fullText }
}

export interface OpsDigestOptions {
  /** Override "now" for deterministic testing. */
  now?: Date
}

export interface OpsDigestResult extends BaseResult {
  openAlerts: number
  infoLines: number
  sent: boolean
  slackSent: boolean
}

export interface OpsDigestSkillOpts extends BaseSkillOpts {
  slack?: SlackMessenger
  slackChannelId?: string
  backupManifestPath?: string
}

export class OpsDigestSkill extends BaseSkill<OpsDigestOptions, OpsDigestResult> {
  // No minimum_autonomy: the digest is informational and must run at every level.
  private slack: SlackMessenger
  private slackChannelId: string
  private backupManifestPath?: string

  constructor(opts: OpsDigestSkillOpts) {
    super('ops-digest', opts)
    this.slack = opts.slack ?? new SlackMessenger()
    this.slackChannelId = opts.slackChannelId ?? process.env.MORNING_BRIEF_SLACK_CHANNEL ?? ''
    this.backupManifestPath = opts.backupManifestPath
  }

  protected async run(options: OpsDigestOptions = {}): Promise<OpsDigestResult> {
    const startMs = Date.now()
    const now = options.now ?? new Date()
    const digest = await buildOpsDigest(this.db, now, { backupManifestPath: this.backupManifestPath })

    let sent = false
    let slackSent = false
    if (digest.isEmpty) {
      logger.info('[ops-digest] no open alerts and no reports — nothing to send')
    } else {
      if (this.pushover.isConfigured) {
        try {
          await this.pushover.send({ title: 'Daily Ops Digest', message: digest.pushText, priority: 0 })
          sent = true
        } catch (err) {
          logger.warn({ err }, '[ops-digest] Pushover send failed')
        }
      }
      if (this.slack.isConfigured && this.slackChannelId) {
        try {
          slackSent = await this.slack.sendMessage({ channel: this.slackChannelId, text: digest.fullText })
        } catch (err) {
          logger.warn({ err }, '[ops-digest] Slack send failed')
        }
      } else {
        logger.debug('[ops-digest] Slack not configured or no channel — skipping DM')
      }
    }

    const result: OpsDigestResult = {
      openAlerts: digest.openAlerts.length,
      infoLines: digest.infoLines.length,
      sent,
      slackSent,
      durationMs: Date.now() - startMs,
    }
    await this.logResult(
      result,
      `date:${now.toISOString().slice(0, 10)}`,
      `alerts:${result.openAlerts} | reports:${result.infoLines} | pushover:${sent} | slack:${slackSent}`,
    )
    return result
  }
}
