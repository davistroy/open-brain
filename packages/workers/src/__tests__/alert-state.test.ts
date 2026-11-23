import { describe, it, expect, vi, afterEach } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import {
  nextAction,
  readAlertState,
  writeAlertState,
  listOpenAlerts,
  alertStateKey,
  raiseAlert,
  alertStateEnabled,
  legacyPushEnabled,
  type AlertState,
  type RaiseAlertArgs,
} from '../lib/alert-state.js'
import { logger } from '@open-brain/shared'
import { PushoverService } from '../services/pushover.js'
import { BaseSkill } from '../skills/base-skill.js'
import type { BaseSkillOpts } from '../skills/types.js'

const NOW = new Date('2026-11-23T12:00:00Z')

const badState: AlertState = {
  status: 'bad',
  since: '2026-11-22T12:00:00.000Z',
  last_notified_at: '2026-11-22T12:00:00.000Z',
  level: 0,
  receipt: null,
  acked_at: null,
}
const okState: AlertState = { ...badState, status: 'ok' }

describe('nextAction', () => {
  const cases: Array<[string, AlertState | null | undefined, boolean, 'critical' | 'warning', string]> = [
    ['ok -> bad', okState, true, 'critical', 'notify'],
    ['bad -> bad', badState, true, 'critical', 'none'],
    ['bad -> bad (warning)', badState, true, 'warning', 'none'],
    ['bad -> ok', badState, false, 'critical', 'resolve'],
    ['ok -> ok', okState, false, 'warning', 'none'],
    ['missing state + bad', null, true, 'critical', 'notify'],
    ['undefined state + bad', undefined, true, 'warning', 'notify'],
    ['missing state + ok', null, false, 'critical', 'none'],
    // 2.2: an open alert whose send never succeeded is retried, so a failed or
    // unconfigured Pushover never turns into a permanent silence.
    ['bad (never notified) -> bad', { ...badState, last_notified_at: null }, true, 'critical', 'notify'],
    ['bad (never notified) -> ok', { ...badState, last_notified_at: null }, false, 'warning', 'resolve'],
  ]
  it.each(cases)('%s', (_n, state, bad, severity, expected) => {
    expect(nextAction(state, { bad, severity, now: NOW })).toBe(expected)
  })
})

describe('alertStateKey', () => {
  it('prefixes the key', () => {
    expect(alertStateKey('backup-stale')).toBe('alert_state:backup-stale')
  })
})

describe('alert-state store', () => {
  it('read returns null when no row', async () => {
    const db = { execute: vi.fn().mockResolvedValue({ rows: [] }) }
    expect(await readAlertState(db as never, 'k')).toBeNull()
  })

  it('write then read round-trips the state', async () => {
    let stored: unknown = null
    const db = {
      execute: vi.fn().mockImplementation(async (q: { queryChunks?: unknown[] }) => {
        // the write statement carries the JSON string as a bound param
        const chunks = (q.queryChunks ?? []) as unknown[]
        const param = chunks.find((c) => typeof c === 'string' && c.startsWith('{'))
        if (param) {
          stored = JSON.parse(param as string)
          return { rows: [] }
        }
        return { rows: stored ? [{ value: stored }] : [] }
      }),
    }
    await writeAlertState(db as never, 'backup-stale', badState)
    expect(db.execute).toHaveBeenCalledTimes(1)
    expect(await readAlertState(db as never, 'backup-stale')).toEqual(badState)
  })

  it('read accepts a JSON string value', async () => {
    const db = { execute: vi.fn().mockResolvedValue({ rows: [{ value: JSON.stringify(badState) }] }) }
    expect(await readAlertState(db as never, 'k')).toEqual(badState)
  })

  it('unparseable JSON is treated as ok (null) with a warn log', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    const db = { execute: vi.fn().mockResolvedValue({ rows: [{ value: '{not json' }] }) }
    expect(await readAlertState(db as never, 'k')).toBeNull()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('a value of the wrong shape is treated as ok (null) with a warn log', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    const db = { execute: vi.fn().mockResolvedValue({ rows: [{ value: { status: 'weird' } }] }) }
    expect(await readAlertState(db as never, 'k')).toBeNull()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('db errors propagate (raiseAlert fails open on them)', async () => {
    const db = { execute: vi.fn().mockRejectedValue(new Error('db down')) }
    await expect(readAlertState(db as never, 'k')).rejects.toThrow('db down')
    await expect(writeAlertState(db as never, 'k', badState)).rejects.toThrow('db down')
  })

  it('listOpenAlerts returns only bad states, key stripped of the prefix', async () => {
    const db = {
      execute: vi.fn().mockResolvedValue({
        rows: [
          { key: 'alert_state:backup-stale', value: badState },
          { key: 'alert_state:queues', value: okState },
          { key: 'alert_state:junk', value: 'garbage' },
        ],
      }),
    }
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    const open = await listOpenAlerts(db as never)
    expect(open).toEqual([{ key: 'backup-stale', state: badState }])
    warn.mockRestore()
  })
})

// ============================================================
// Item 2.2 — raiseAlert, switches, fail-open
// ============================================================

/**
 * In-memory `app_settings` store behind a mocked `db.execute`. Renders the real
 * drizzle SQL with PgDialect and routes on the statement text, so the tests
 * exercise the production read/write statements.
 */
function makeStoreDb(initial: Record<string, AlertState> = {}) {
  const store = new Map<string, unknown>(
    Object.entries(initial).map(([k, v]) => [alertStateKey(k), v]),
  )
  const dialect = new PgDialect()
  const execute = vi.fn().mockImplementation(async (q: SQL) => {
    const { sql: text, params } = dialect.sqlToQuery(q)
    if (text.includes('INSERT INTO app_settings')) {
      store.set(params[0] as string, JSON.parse(params[1] as string))
      return { rows: [] }
    }
    if (text.includes('FROM app_settings WHERE key =')) {
      const v = store.get(params[0] as string)
      return { rows: v === undefined ? [] : [{ value: v }] }
    }
    throw new Error(`unexpected SQL in test: ${text}`)
  })
  return { db: { execute }, store }
}

function makePushover(configured = true) {
  const svc = new PushoverService('fake-token', 'fake-user')
  if (!configured) Object.defineProperty(svc, 'isConfigured', { get: () => false })
  const send = vi.spyOn(svc, 'send').mockResolvedValue(undefined)
  return { svc, send }
}

const ALERT = { key: 'backup-stale', severity: 'critical' as const, title: 'Backup Stale', message: 'Backup is 30.0h old' }

describe('alert switches', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('both switches default on', () => {
    vi.stubEnv('ALERT_STATE_ENABLED', undefined)
    vi.stubEnv('ALERT_LEGACY_PUSH', undefined)
    expect(alertStateEnabled()).toBe(true)
    expect(legacyPushEnabled()).toBe(true)
  })

  it('ALERT_LEGACY_PUSH=false turns the legacy path off while state is on', () => {
    vi.stubEnv('ALERT_LEGACY_PUSH', 'false')
    expect(alertStateEnabled()).toBe(true)
    expect(legacyPushEnabled()).toBe(false)
  })

  it('ALERT_STATE_ENABLED=false forces the legacy path on, whatever ALERT_LEGACY_PUSH says', () => {
    vi.stubEnv('ALERT_STATE_ENABLED', 'false')
    vi.stubEnv('ALERT_LEGACY_PUSH', 'false')
    expect(alertStateEnabled()).toBe(false)
    expect(legacyPushEnabled()).toBe(true)
  })

  it('accepts "false" case-insensitively and trimmed; any other value is on', () => {
    vi.stubEnv('ALERT_STATE_ENABLED', ' FALSE ')
    expect(alertStateEnabled()).toBe(false)
    vi.stubEnv('ALERT_STATE_ENABLED', 'true')
    expect(alertStateEnabled()).toBe(true)
    vi.stubEnv('ALERT_STATE_ENABLED', '0')
    expect(alertStateEnabled()).toBe(true)
  })
})

describe('raiseAlert', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('ok -> bad (critical): sends priority 1 and writes a bad state', async () => {
    const { db, store } = makeStoreDb()
    const { svc, send } = makePushover()
    const res = await raiseAlert({ db: db as never, pushover: svc, now: NOW }, { ...ALERT, bad: true })

    expect(res).toEqual({ action: 'notify', sent: true })
    expect(send).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledWith({ title: 'Backup Stale', message: 'Backup is 30.0h old', priority: 1 })
    expect(store.get('alert_state:backup-stale')).toEqual({
      status: 'bad',
      since: NOW.toISOString(),
      last_notified_at: NOW.toISOString(),
      level: 0,
      receipt: null,
      acked_at: null,
    })
  })

  it('ok -> bad (warning): sends priority 0', async () => {
    const { db } = makeStoreDb({ 'pipeline-queues': okState })
    const { svc, send } = makePushover()
    await raiseAlert(
      { db: db as never, pushover: svc, now: NOW },
      { key: 'pipeline-queues', severity: 'warning', bad: true, title: 'Pipeline Queues', message: 'm' },
    )
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ priority: 0 }))
  })

  it('bad -> bad: sends nothing and writes nothing', async () => {
    const { db } = makeStoreDb({ 'backup-stale': badState })
    const { svc, send } = makePushover()
    const res = await raiseAlert({ db: db as never, pushover: svc, now: NOW }, { ...ALERT, bad: true })
    expect(res).toEqual({ action: 'none', sent: false })
    expect(send).not.toHaveBeenCalled()
    expect(db.execute).toHaveBeenCalledTimes(1) // the read only
  })

  it('bad -> ok: sends "Resolved: <title>" at priority -1 and writes status ok', async () => {
    const { db, store } = makeStoreDb({ 'backup-stale': badState })
    const { svc, send } = makePushover()
    const res = await raiseAlert(
      { db: db as never, pushover: svc, now: NOW },
      { ...ALERT, bad: false, message: 'Backup is 2.0h old' },
    )
    expect(res).toEqual({ action: 'resolve', sent: true })
    expect(send).toHaveBeenCalledWith({ title: 'Resolved: Backup Stale', message: 'Backup is 2.0h old', priority: -1 })
    expect(store.get('alert_state:backup-stale')).toEqual({
      status: 'ok',
      since: NOW.toISOString(),
      last_notified_at: NOW.toISOString(),
      level: 0,
      receipt: null,
      acked_at: null,
    })
  })

  it('ok -> ok: sends nothing and writes nothing', async () => {
    const { db } = makeStoreDb()
    const { svc, send } = makePushover()
    const res = await raiseAlert({ db: db as never, pushover: svc, now: NOW }, { ...ALERT, bad: false })
    expect(res).toEqual({ action: 'none', sent: false })
    expect(send).not.toHaveBeenCalled()
    expect(db.execute).toHaveBeenCalledTimes(1)
  })

  it('ALERT_STATE_ENABLED=false: returns without reading state and sends nothing', async () => {
    vi.stubEnv('ALERT_STATE_ENABLED', 'false')
    const { db } = makeStoreDb()
    const { svc, send } = makePushover()
    const res = await raiseAlert({ db: db as never, pushover: svc, now: NOW }, { ...ALERT, bad: true })
    expect(res).toEqual({ action: 'disabled', sent: false })
    expect(db.execute).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('fail open: a state read error sends the alert as ok -> bad, with a warn log', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    const db = { execute: vi.fn().mockRejectedValue(new Error('db down')) }
    const { svc, send } = makePushover()
    const res = await raiseAlert({ db: db as never, pushover: svc, now: NOW }, { ...ALERT, bad: true })
    expect(res).toEqual({ action: 'notify', sent: true })
    expect(send).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalled()
  })

  it('fail open: a state read error with bad=false sends nothing (no false "resolved")', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    const db = { execute: vi.fn().mockRejectedValue(new Error('db down')) }
    const { svc, send } = makePushover()
    const res = await raiseAlert({ db: db as never, pushover: svc, now: NOW }, { ...ALERT, bad: false })
    expect(res).toEqual({ action: 'none', sent: false })
    expect(send).not.toHaveBeenCalled()
  })

  it('a state write error never suppresses the send and never throws', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    const db = {
      execute: vi.fn()
        .mockResolvedValueOnce({ rows: [] }) // read: no state
        .mockRejectedValueOnce(new Error('write failed')),
    }
    const { svc, send } = makePushover()
    const res = await raiseAlert({ db: db as never, pushover: svc, now: NOW }, { ...ALERT, bad: true })
    expect(res).toEqual({ action: 'notify', sent: true })
    expect(send).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalled()
  })

  it('a failed Pushover send never throws, records bad with last_notified_at null, and retries next run', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    const { db, store } = makeStoreDb()
    const { svc, send } = makePushover()
    send.mockRejectedValueOnce(new Error('Pushover API error 500'))

    const first = await raiseAlert({ db: db as never, pushover: svc, now: NOW }, { ...ALERT, bad: true })
    expect(first).toEqual({ action: 'notify', sent: false })
    expect(store.get('alert_state:backup-stale')).toMatchObject({
      status: 'bad',
      since: NOW.toISOString(),
      last_notified_at: null,
    })

    const later = new Date(NOW.getTime() + 6 * 3600_000)
    const second = await raiseAlert({ db: db as never, pushover: svc, now: later }, { ...ALERT, bad: true })
    expect(second).toEqual({ action: 'notify', sent: true })
    expect(send).toHaveBeenCalledTimes(2)
    // `since` is kept from the first observation; the notification time is the retry
    expect(store.get('alert_state:backup-stale')).toMatchObject({
      status: 'bad',
      since: NOW.toISOString(),
      last_notified_at: later.toISOString(),
    })
  })

  it('Pushover not configured: no send, but the state still records the open condition', async () => {
    const { db, store } = makeStoreDb()
    const { svc, send } = makePushover(false)
    const res = await raiseAlert({ db: db as never, pushover: svc, now: NOW }, { ...ALERT, bad: true })
    expect(res).toEqual({ action: 'notify', sent: false })
    expect(send).not.toHaveBeenCalled()
    expect(store.get('alert_state:backup-stale')).toMatchObject({ status: 'bad', last_notified_at: null })
  })

  it('a failed "resolved" send still closes the alert (a missed low-priority note is not a lost alert)', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    const { db, store } = makeStoreDb({ 'backup-stale': badState })
    const { svc, send } = makePushover()
    send.mockRejectedValueOnce(new Error('Pushover API error 500'))
    const res = await raiseAlert({ db: db as never, pushover: svc, now: NOW }, { ...ALERT, bad: false })
    expect(res).toEqual({ action: 'resolve', sent: false })
    expect(store.get('alert_state:backup-stale')).toMatchObject({
      status: 'ok',
      since: NOW.toISOString(),
      last_notified_at: badState.last_notified_at,
    })
  })

  it('defaults `now` to the current time', async () => {
    const { db, store } = makeStoreDb()
    const { svc } = makePushover()
    const before = Date.now()
    await raiseAlert({ db: db as never, pushover: svc }, { ...ALERT, bad: true })
    const since = Date.parse((store.get('alert_state:backup-stale') as AlertState).since)
    expect(since).toBeGreaterThanOrEqual(before)
    expect(since).toBeLessThanOrEqual(Date.now())
  })

  it('keys are independent', async () => {
    const { db, store } = makeStoreDb()
    const { svc, send } = makePushover()
    await raiseAlert({ db: db as never, pushover: svc, now: NOW }, { ...ALERT, bad: true })
    await raiseAlert(
      { db: db as never, pushover: svc, now: NOW },
      { key: 'pipeline-queues', severity: 'warning', bad: true, title: 'Pipeline Queues', message: 'q' },
    )
    expect(send).toHaveBeenCalledTimes(2)
    expect([...store.keys()].sort()).toEqual(['alert_state:backup-stale', 'alert_state:pipeline-queues'])
  })
})

describe('BaseSkill.raiseAlert', () => {
  class ProbeSkill extends BaseSkill<void, { durationMs: number }> {
    constructor(opts: BaseSkillOpts) {
      super('probe', opts)
    }
    protected async run(): Promise<{ durationMs: number }> {
      return { durationMs: 0 }
    }
    probe(args: RaiseAlertArgs) {
      return this.raiseAlert(args)
    }
  }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('delegates to the library with this.db and this.pushover', async () => {
    const { db, store } = makeStoreDb()
    const { svc, send } = makePushover()
    const skill = new ProbeSkill({ db: db as never, pushover: svc })
    const res = await skill.probe({ ...ALERT, bad: true })
    expect(res).toEqual({ action: 'notify', sent: true })
    expect(send).toHaveBeenCalledOnce()
    expect(store.get('alert_state:backup-stale')).toMatchObject({ status: 'bad' })
  })
})
