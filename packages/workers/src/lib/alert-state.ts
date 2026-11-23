import { sql } from 'drizzle-orm'
import type { Database, PushoverService, PushoverPriority } from '@open-brain/shared'
import { logger } from '@open-brain/shared'

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

export type AlertAction = 'none' | 'notify' | 'resolve'

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
 * (Escalation actions are added by item 2.3 and use `severity` + `now`.)
 */
export function nextAction(state: AlertState | null | undefined, input: NextActionInput): AlertAction {
  const wasBad = state?.status === 'bad'
  if (input.bad) return wasBad && state?.last_notified_at ? 'none' : 'notify'
  return wasBad ? 'resolve' : 'none'
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

/** Send through Pushover; never throws. False when unconfigured or on any send error. */
async function deliver(
  pushover: PushoverService,
  key: string,
  opts: { title: string; message: string; priority: PushoverPriority },
): Promise<boolean> {
  if (!pushover.isConfigured) {
    logger.debug({ key }, '[alert-state] Pushover not configured — alert not sent')
    return false
  }
  try {
    await pushover.send(opts)
    return true
  } catch (err) {
    logger.warn({ err, key }, '[alert-state] Pushover send failed — will retry on the next run')
    return false
  }
}

/**
 * Report an operational condition (ADR-0005). Sends on ok -> bad (priority 1
 * for `critical`, 0 for `warning`), sends "Resolved: <title>" at priority -1 on
 * bad -> ok, and sends nothing while the condition holds. The new state is
 * written after the send.
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

  const action = nextAction(state, { bad, severity, now })
  if (action === 'none') return { action, sent: false }

  let sent: boolean
  let next: AlertState
  if (action === 'notify') {
    sent = await deliver(pushover, key, { title, message, priority: NOTIFY_PRIORITY[severity] })
    next = state?.status === 'bad'
      // retry of an open alert that was never sent: keep `since` and escalation fields
      ? { ...state, last_notified_at: sent ? nowIso : state.last_notified_at }
      : { status: 'bad', since: nowIso, last_notified_at: sent ? nowIso : null, level: 0, receipt: null, acked_at: null }
  } else {
    sent = await deliver(pushover, key, { title: `Resolved: ${title}`, message, priority: RESOLVE_PRIORITY })
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
  }

  logger.info({ key, severity, action, sent }, `[alert-state] ${action} ${key}`)

  try {
    await writeAlertState(db, key, next)
  } catch (err) {
    logger.warn({ err, key, action }, '[alert-state] state write failed — the send already happened')
  }

  return { action, sent }
}
