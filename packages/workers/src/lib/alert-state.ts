import { sql } from 'drizzle-orm'
import type { Database, PushoverService, PushoverPriority } from '@open-brain/shared'
import { logger, SlackMessenger, HimalayaService } from '@open-brain/shared'

// ============================================================
// ADR-0005 — alert state store + pure decision function
// ============================================================
//
// Every operational alert has a state row in `app_settings` under
// `alert_state:<key>`. A caller reports the condition (`bad`) on each run;
// `nextAction()` compares it with the stored state and decides whether the
// alert must fire (ok -> bad), resolve (bad -> ok) or stay silent.
//
// The keys are written through the database layer only; they are NOT in the
// settings API whitelists (READABLE_KEYS / WRITABLE_KEYS). `app_settings` is
// not pruned by data-retention-prune and survives a Redis loss.
//
// Store functions let database errors propagate: `raiseAlert` wraps them and
// fails open, so a state error never suppresses a send. An unparseable stored
// value is not a database error — it is read as "no state" (ok) with a warn log.
//
// Rollout switches (item 2.2, both default on):
//   ALERT_STATE_ENABLED=false -> raiseAlert is a no-op; the legacy direct pushes
//                                run exactly as before (the rollback switch).
//   ALERT_LEGACY_PUSH=false   -> the legacy direct pushes stop; only raiseAlert
//                                sends (set one week after the first deploy).

export const ALERT_STATE_PREFIX = 'alert_state:'

export type AlertSeverity = 'critical' | 'warning'

export interface AlertState {
  status: 'ok' | 'bad'
  /** ISO time the alert last entered `bad` (or `ok` for a resolved row). */
  since: string
  /** ISO time of the last send for this alert, or null. */
  last_notified_at: string | null
  /** Highest escalation level sent while open: 0 (none), 1 (24 h), 2 (7 d). */
  level: 0 | 1 | 2
  /** Pushover receipt of the last priority-2 send, or null. */
  receipt: string | null
  /** ISO time the receipt was acknowledged, or null. */
  acked_at: string | null
}

export type AlertAction = 'none' | 'notify' | 'resolve' | 'escalate_24h' | 'escalate_7d' | 'repeat_p2'

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS
/** A critical alert open this long escalates to priority 2 + Slack. */
export const ESCALATE_24H_MS = DAY_MS
/** A critical alert open this long escalates to email + a daily priority 2. */
export const ESCALATE_7D_MS = 7 * DAY_MS
/** An acknowledgement snoozes escalation for this long. */
export const ACK_SNOOZE_MS = 7 * DAY_MS
/** Priority-2 repeat interval once at level 2. */
export const REPEAT_P2_MS = DAY_MS
/** Pushover emergency retry/expire (seconds) for escalation sends. */
export const ESCALATION_RETRY_S = 600
export const ESCALATION_EXPIRE_S = 10_800

export function alertStateKey(key: string): string {
  return `${ALERT_STATE_PREFIX}${key}`
}

function isAlertState(v: unknown): v is AlertState {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return (o.status === 'ok' || o.status === 'bad') && typeof o.since === 'string'
}

/** Parse a stored `app_settings.value` (jsonb object, or a JSON string) into an AlertState, or null. */
function parseState(raw: unknown, key: string): AlertState | null {
  if (raw == null) return null
  let value: unknown = raw
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw)
    } catch (err) {
      logger.warn({ err, key }, '[alert-state] unparseable stored state; treating as ok')
      return null
    }
  }
  if (!isAlertState(value)) {
    logger.warn({ key }, '[alert-state] stored state has an unexpected shape; treating as ok')
    return null
  }
  return {
    status: value.status,
    since: value.since,
    last_notified_at: value.last_notified_at ?? null,
    level: value.level ?? 0,
    receipt: value.receipt ?? null,
    acked_at: value.acked_at ?? null,
  }
}

/** Read the state for `key`. Null when absent or unparseable. Database errors propagate. */
export async function readAlertState(db: Database, key: string): Promise<AlertState | null> {
  const res = await db.execute<{ value: unknown }>(
    sql`SELECT value FROM app_settings WHERE key = ${alertStateKey(key)}`,
  )
  return parseState(res.rows[0]?.value, key)
}

/** Upsert the state for `key`. Database errors propagate. */
export async function writeAlertState(db: Database, key: string, state: AlertState): Promise<void> {
  await db.execute(sql`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (${alertStateKey(key)}, ${JSON.stringify(state)}::jsonb, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
  `)
}

export interface OpenAlert {
  /** The alert key without the `alert_state:` prefix. */
  key: string
  state: AlertState
}

/** All alerts whose stored status is `bad`. Rows that fail to parse are skipped (warn-logged). */
export async function listOpenAlerts(db: Database): Promise<OpenAlert[]> {
  const res = await db.execute<{ key: string; value: unknown }>(
    sql`SELECT key, value FROM app_settings WHERE key LIKE ${ALERT_STATE_PREFIX + '%'} AND value->>'status' = 'bad' ORDER BY key`,
  )
  const open: OpenAlert[] = []
  for (const row of res.rows) {
    const state = parseState(row.value, row.key)
    if (state?.status === 'bad') open.push({ key: row.key.slice(ALERT_STATE_PREFIX.length), state })
  }
  return open
}

export interface NextActionInput {
  /** The condition as observed on this run. */
  bad: boolean
  severity: AlertSeverity
  now: Date
}

/**
 * Pure decision: what to do given the stored state and the observed condition.
 * ok -> bad = notify; bad -> bad = none; bad -> ok = resolve; ok -> ok = none.
 * A missing or unparseable state (null/undefined) counts as ok.
 * An open alert that was never successfully sent (`last_notified_at` null —
 * Pushover failed or is unconfigured) is notified again, so a failed send never
 * turns into a permanent silence.
 *
 * Escalation (item 2.3, `critical` only; a `warning` never rises above its
 * first message). For an open alert that was notified:
 *   - an acknowledgement (`acked_at`) snoozes escalation for 7 days;
 *   - open >= 7 d and level < 2 -> `escalate_7d`;
 *   - open >= 24 h and level < 1 -> `escalate_24h`;
 *   - level 2 and the last send >= 24 h ago -> `repeat_p2`.
 * `level` records the highest escalation sent, so each step fires once.
 */
export function nextAction(state: AlertState | null | undefined, input: NextActionInput): AlertAction {
  const wasBad = state?.status === 'bad'
  if (!input.bad) return wasBad ? 'resolve' : 'none'
  if (!state || !wasBad || !state.last_notified_at) return 'notify'
  if (input.severity !== 'critical') return 'none'

  const nowMs = input.now.getTime()
  if (state.acked_at) {
    const ackedMs = Date.parse(state.acked_at)
    if (Number.isFinite(ackedMs) && nowMs < ackedMs + ACK_SNOOZE_MS) return 'none'
  }
  const openMs = nowMs - Date.parse(state.since)
  if (openMs >= ESCALATE_7D_MS && state.level < 2) return 'escalate_7d'
  if (openMs >= ESCALATE_24H_MS && state.level < 1) return 'escalate_24h'
  if (state.level >= 2 && nowMs - Date.parse(state.last_notified_at) >= REPEAT_P2_MS) return 'repeat_p2'
  return 'none'
}

// ============================================================
// Item 2.2 — rollout switches + raiseAlert
// ============================================================

function envIsFalse(name: string): boolean {
  return (process.env[name] ?? '').trim().toLowerCase() === 'false'
}

/** True unless `ALERT_STATE_ENABLED` is `false`. Off = raiseAlert does nothing (rollback). */
export function alertStateEnabled(): boolean {
  return !envIsFalse('ALERT_STATE_ENABLED')
}

/**
 * Whether the legacy direct pushes run. True when the state path is off
 * (`ALERT_STATE_ENABLED=false`, so an alert can never be lost to the rollback)
 * or while `ALERT_LEGACY_PUSH` is not `false` (the one-week parallel run).
 */
export function legacyPushEnabled(): boolean {
  return !alertStateEnabled() || !envIsFalse('ALERT_LEGACY_PUSH')
}

export interface RaiseAlertDeps {
  db: Database
  pushover: PushoverService
  /** Slack messenger for the 24 h escalation. Default: `new SlackMessenger()` (reads SLACK_BOT_TOKEN). */
  slack?: SlackMessenger
  /** Email sender for the 7 d escalation. Default: `new HimalayaService()` (reads HIMALAYA_CONFIG). */
  himalaya?: HimalayaService
  /** Clock for the stored timestamps. Default: the current time. */
  now?: Date
}

export interface RaiseAlertArgs {
  /** State key without the `alert_state:` prefix, e.g. `backup-stale`. */
  key: string
  severity: AlertSeverity
  /** The condition as observed on this run. Pass false when it is clear. */
  bad: boolean
  /** Alert name without the app prefix (PushoverService adds it), e.g. `Backup Stale`. */
  title: string
  /** The current observation. Sent on notify, and as the body of the "Resolved" message. */
  message: string
}

export interface RaiseAlertResult {
  /** `disabled` when ALERT_STATE_ENABLED=false (nothing read, nothing sent). */
  action: AlertAction | 'disabled'
  /** True when a Pushover message was delivered on this call. */
  sent: boolean
}

const NOTIFY_PRIORITY: Record<AlertSeverity, PushoverPriority> = { critical: 1, warning: 0 }
const RESOLVE_PRIORITY: PushoverPriority = -1

interface DeliverResult {
  sent: boolean
  /** Pushover receipt of a priority-2 send, or null. */
  receipt: string | null
}

/** Send through Pushover; never throws. `sent` is false when unconfigured or on any send error. */
async function deliver(
  pushover: PushoverService,
  key: string,
  opts: { title: string; message: string; priority: PushoverPriority; retry?: number; expire?: number },
): Promise<DeliverResult> {
  if (!pushover.isConfigured) {
    logger.debug({ key }, '[alert-state] Pushover not configured — alert not sent')
    return { sent: false, receipt: null }
  }
  try {
    const res = await pushover.send(opts)
    return { sent: true, receipt: res?.receipt ?? null }
  } catch (err) {
    logger.warn({ err, key }, '[alert-state] Pushover send failed — will retry on the next run')
    return { sent: false, receipt: null }
  }
}

function describeAge(ms: number): string {
  const hours = Math.floor(ms / HOUR_MS)
  return hours >= 48 ? `${Math.floor(hours / 24)} d` : `${hours} h`
}

/** Post the escalation to Slack. Never throws; a missing token or channel logs at warn. */
async function escalateSlack(deps: RaiseAlertDeps, key: string, text: string): Promise<void> {
  const channel = (process.env.MORNING_BRIEF_SLACK_CHANNEL ?? '').trim()
  if (!channel) {
    logger.warn({ key }, '[alert-state] MORNING_BRIEF_SLACK_CHANNEL not set — Slack escalation skipped')
    return
  }
  try {
    const slack = deps.slack ?? new SlackMessenger()
    if (!slack.isConfigured) {
      logger.warn({ key }, '[alert-state] Slack token not configured — Slack escalation skipped')
      return
    }
    if (!(await slack.sendMessage({ channel, text }))) {
      logger.warn({ key }, '[alert-state] Slack escalation send failed')
    }
  } catch (err) {
    logger.warn({ err, key }, '[alert-state] Slack escalation failed')
  }
}

/** Email the escalation to WEEKLY_BRIEF_EMAIL. Never throws; missing config logs at warn. */
async function escalateEmail(deps: RaiseAlertDeps, key: string, subject: string, body: string): Promise<void> {
  const to = (process.env.WEEKLY_BRIEF_EMAIL ?? '').trim()
  if (!to) {
    logger.warn({ key }, '[alert-state] WEEKLY_BRIEF_EMAIL not set — email escalation skipped')
    return
  }
  try {
    const himalaya = deps.himalaya ?? new HimalayaService()
    if (!himalaya.isConfigured) {
      logger.warn({ key }, '[alert-state] HIMALAYA_CONFIG not set — email escalation skipped')
      return
    }
    await himalaya.send(to, subject, body)
  } catch (err) {
    logger.warn({ err, key }, '[alert-state] email escalation failed')
  }
}

/**
 * Look up the receipt of an open alert and, when acknowledged, return the state
 * with `acked_at` set (else null). Never throws: a failed lookup logs at warn.
 */
async function checkAcknowledgement(pushover: PushoverService, key: string, state: AlertState, nowIso: string): Promise<AlertState | null> {
  try {
    const status = await pushover.getReceipt(state.receipt!)
    if (status?.acknowledged) return { ...state, acked_at: status.acknowledgedAt ?? nowIso }
  } catch (err) {
    logger.warn({ err, key }, '[alert-state] receipt lookup failed — continuing without it')
  }
  return null
}

/**
 * Report an operational condition (ADR-0005). Sends on ok -> bad (priority 1
 * for `critical`, 0 for `warning`), sends "Resolved: <title>" at priority -1 on
 * bad -> ok, and sends nothing while the condition holds. The new state is
 * written after the send.
 *
 * Item 2.3: a `critical` alert that stays open escalates (see `nextAction`):
 * 24 h = priority 2 (retry 600, expire 10800) + a Slack message; 7 d = email +
 * priority 2; then one priority 2 per day. Each call with `bad: true` first
 * polls the stored receipt; an acknowledgement is stored as `acked_at` and
 * snoozes escalation for 7 days. Slack/email run after a successful Pushover
 * send and their failures are logged, never thrown; a failed Pushover send
 * leaves the level unchanged so the next run retries the whole step.
 *
 * Fail open: a state read error is logged at warn and treated as "no state",
 * so a bad condition is sent as ok -> bad; a write error is logged at warn and
 * cannot undo the send. Never throws.
 */
export async function raiseAlert(deps: RaiseAlertDeps, args: RaiseAlertArgs): Promise<RaiseAlertResult> {
  if (!alertStateEnabled()) return { action: 'disabled', sent: false }

  const { db, pushover } = deps
  const { key, severity, bad, title, message } = args
  const now = deps.now ?? new Date()
  const nowIso = now.toISOString()

  let state: AlertState | null = null
  try {
    state = await readAlertState(db, key)
  } catch (err) {
    logger.warn({ err, key }, '[alert-state] state read failed — failing open (treating as ok)')
  }

  // Poll the receipt of an open alert that has one and no acknowledgement yet.
  let ackedState: AlertState | null = null
  if (bad && state?.status === 'bad' && state.receipt && !state.acked_at) {
    ackedState = await checkAcknowledgement(pushover, key, state, nowIso)
    if (ackedState) state = ackedState
  }

  const action = nextAction(state, { bad, severity, now })
  if (action === 'none') {
    if (ackedState) {
      try {
        await writeAlertState(db, key, ackedState)
      } catch (err) {
        logger.warn({ err, key }, '[alert-state] state write failed — acknowledgement not stored')
      }
    }
    return { action, sent: false }
  }

  let sent: boolean
  let next: AlertState
  if (action === 'notify') {
    ;({ sent } = await deliver(pushover, key, { title, message, priority: NOTIFY_PRIORITY[severity] }))
    next = state?.status === 'bad'
      // retry of an open alert that was never sent: keep `since` and escalation fields
      ? { ...state, last_notified_at: sent ? nowIso : state.last_notified_at }
      : { status: 'bad', since: nowIso, last_notified_at: sent ? nowIso : null, level: 0, receipt: null, acked_at: null }
  } else if (action === 'resolve') {
    ;({ sent } = await deliver(pushover, key, { title: `Resolved: ${title}`, message, priority: RESOLVE_PRIORITY }))
    // A failed "resolved" note still closes the alert: it is low priority and
    // the condition is clear; retrying it would keep a closed alert listed open.
    next = {
      status: 'ok',
      since: nowIso,
      last_notified_at: sent ? nowIso : (state?.last_notified_at ?? null),
      level: 0,
      receipt: null,
      acked_at: null,
    }
  } else {
    // escalate_24h | escalate_7d | repeat_p2 — `state` is a notified, open, critical alert here
    const open = state!
    const age = describeAge(now.getTime() - Date.parse(open.since))
    const text = `${message} (open ${age})`
    const res = await deliver(pushover, key, {
      title,
      message: text,
      priority: 2,
      retry: ESCALATION_RETRY_S,
      expire: ESCALATION_EXPIRE_S,
    })
    sent = res.sent
    if (sent) {
      if (action === 'escalate_24h') await escalateSlack(deps, key, `*${title}* — ${text}`)
      if (action === 'escalate_7d') await escalateEmail(deps, key, `[Open Brain] ${title} (open ${age})`, `${text}\n\nOpen since ${open.since}.`)
      next = {
        ...open,
        level: action === 'escalate_24h' ? 1 : 2,
        last_notified_at: nowIso,
        receipt: res.receipt,
        acked_at: null, // a new receipt is unacknowledged
      }
    } else {
      next = open // level unchanged: the next run retries this step
    }
  }

  logger.info({ key, severity, action, sent }, `[alert-state] ${action} ${key}`)

  try {
    if (action === 'notify' || action === 'resolve' || sent || ackedState) await writeAlertState(db, key, next)
  } catch (err) {
    logger.warn({ err, key, action }, '[alert-state] state write failed — the send already happened')
  }

  return { action, sent }
}
