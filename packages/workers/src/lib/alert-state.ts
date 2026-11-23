import { sql } from 'drizzle-orm'
import type { Database } from '@open-brain/shared'
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
// Store functions let database errors propagate: `raiseAlert` (item 2.2) wraps
// them and fails open, so a state error never suppresses a send. An unparseable
// stored value is not a database error — it is read as "no state" (ok) with a
// warn log.

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
 * (Escalation actions are added by item 2.3 and use `severity` + `now`.)
 */
export function nextAction(state: AlertState | null | undefined, input: NextActionInput): AlertAction {
  const wasBad = state?.status === 'bad'
  if (input.bad) return wasBad ? 'none' : 'notify'
  return wasBad ? 'resolve' : 'none'
}
