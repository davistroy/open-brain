import { describe, it, expect, vi, afterEach } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import {
  nextAction,
  readAlertState,
  writeAlertState,
  listOpenAlerts,
  alertStateKey,
  describeAlertKey,
  raiseAlert,
  alertStateEnabled,
  legacyPushEnabled,
  type AlertState,
  type RaiseAlertArgs,
} from '../lib/alert-state.js'
import { logger } from '@open-brain/shared'
import { PushoverService } from '../services/pushover.js'
import type { SlackMessenger, HimalayaService } from '@open-brain/shared'
import { BaseSkill } from '../skills/base-skill.js'
import type { BaseSkillOpts } from '../skills/types.js'

const NOW = new Date('2026-11-23T12:00:00Z')

const badState: AlertState = {
  status: 'bad',
  // open 1 hour: inside the 24 h escalation window (item 2.3)
  since: '2026-11-23T11:00:00.000Z',
  last_notified_at: '2026-11-23T11:00:00.000Z',
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

describe('describeAlertKey', () => {
  it('renders container:<name> readably for the ops digest', () => {
    expect(describeAlertKey('container:spark-llm')).toBe('spark-llm unhealthy')
    expect(describeAlertKey('container:postgres')).toBe('postgres unhealthy')
  })
  it('keeps queue keys and unknown keys as before', () => {
    expect(describeAlertKey('queue-failed:ingest-root')).toBe('ingest-root queue failures')
    expect(describeAlertKey('backup-stale')).toBe('backup-stale')
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


// ============================================================
// Item 2.3 — escalation and acknowledgement
// ============================================================

const H = 3600_000
const D = 24 * H
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString()

/** An open alert: opened `openMs` ago, last notified `notifiedMs` ago. */
function open(openMs: number, o: Partial<AlertState> = {}, notifiedMs = openMs): AlertState {
  return { status: 'bad', since: ago(openMs), last_notified_at: ago(notifiedMs), level: 0, receipt: null, acked_at: null, ...o }
}

describe('nextAction escalation', () => {
  const cases: Array<[string, AlertState, 'critical' | 'warning', string]> = [
    ['23 h open', open(23 * H), 'critical', 'none'],
    ['24 h open', open(24 * H), 'critical', 'escalate_24h'],
    ['24 h open, already level 1', open(25 * H, { level: 1 }, 24 * H), 'critical', 'none'],
    ['7 d open, level 1', open(7 * D, { level: 1 }, 6 * D), 'critical', 'escalate_7d'],
    ['6 d 23 h open, level 1', open(7 * D - H, { level: 1 }, 6 * D), 'critical', 'none'],
    ['8 d open, level 2, last sent 25 h ago', open(8 * D, { level: 2 }, 25 * H), 'critical', 'repeat_p2'],
    ['8 d open, level 2, last sent 23 h ago', open(8 * D, { level: 2 }, 23 * H), 'critical', 'none'],
    ['8 d open, level 0 (never escalated)', open(8 * D), 'critical', 'escalate_7d'],
    ['warning open 30 d', open(30 * D), 'warning', 'none'],
    ['warning open 8 d, level 2', open(8 * D, { level: 2 }, 25 * H), 'warning', 'none'],
    // acknowledged at 30 h (level 1): snooze until 30 h + 7 d
    ['acked 30 h, now 31 h', open(31 * H, { level: 1, receipt: 'r', acked_at: ago(1 * H) }, 7 * H), 'critical', 'none'],
    ['acked, 1 min before the snooze ends', open(8 * D, { level: 1, receipt: 'r', acked_at: ago(7 * D - 60_000) }, 7 * D), 'critical', 'none'],
    ['acked, snooze over (open > 7 d, level 1)', open(10 * D, { level: 1, receipt: 'r', acked_at: ago(7 * D + 60_000) }, 7 * D), 'critical', 'escalate_7d'],
    ['acked, snooze over (level 2, last sent > 24 h)', open(20 * D, { level: 2, receipt: 'r', acked_at: ago(8 * D) }, 8 * D), 'critical', 'repeat_p2'],
  ]
  it.each(cases)('%s', (_n, state, severity, expected) => {
    expect(nextAction(state, { bad: true, severity, now: NOW })).toBe(expected)
  })

  it('a resolve still wins over escalation', () => {
    expect(nextAction(open(2 * D), { bad: false, severity: 'critical', now: NOW })).toBe('resolve')
  })

  it('a never-notified open alert is notified, not escalated', () => {
    expect(nextAction(open(2 * D, { last_notified_at: null }), { bad: true, severity: 'critical', now: NOW })).toBe('notify')
  })
})

function makeChannels(opts: { slackConfigured?: boolean; himalayaConfigured?: boolean } = {}) {
  const slack = {
    isConfigured: opts.slackConfigured ?? true,
    sendMessage: vi.fn().mockResolvedValue(true),
  }
  const himalaya = {
    isConfigured: opts.himalayaConfigured ?? true,
    send: vi.fn().mockResolvedValue({ success: true, output: '' }),
  }
  return { slack, himalaya, deps: { slack: slack as unknown as SlackMessenger, himalaya: himalaya as unknown as HimalayaService } }
}

describe('raiseAlert escalation', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  function setup(initial: AlertState, configured = true) {
    vi.stubEnv('MORNING_BRIEF_SLACK_CHANNEL', 'D-TEST')
    vi.stubEnv('WEEKLY_BRIEF_EMAIL', 'owner@example.invalid')
    const { db, store } = makeStoreDb({ 'backup-stale': initial })
    const p = makePushover(configured)
    const ch = makeChannels()
    return { db, store, ...p, ...ch }
  }

  it('24 h: one priority-2 send (retry 600, expire 10800), receipt stored, one Slack post', async () => {
    const t = setup(open(24 * H))
    t.send.mockResolvedValueOnce({ receipt: 'rcpt-1' })
    const res = await raiseAlert({ db: t.db as never, pushover: t.svc, now: NOW, ...t.deps }, { ...ALERT, bad: true })
    expect(res).toEqual({ action: 'escalate_24h', sent: true })
    expect(t.send).toHaveBeenCalledOnce()
    expect(t.send).toHaveBeenCalledWith(expect.objectContaining({ priority: 2, retry: 600, expire: 10800 }))
    expect(t.slack.sendMessage).toHaveBeenCalledOnce()
    expect(t.slack.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: 'D-TEST', text: expect.stringContaining('Backup is 30.0h old') }))
    expect(t.himalaya.send).not.toHaveBeenCalled()
    expect(t.store.get('alert_state:backup-stale')).toMatchObject({
      status: 'bad', level: 1, receipt: 'rcpt-1', acked_at: null, last_notified_at: NOW.toISOString(), since: ago(24 * H),
    })
  })

  it('24 h: Slack failure (throw) and a missing channel never block the Pushover send', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    const t = setup(open(24 * H))
    t.slack.sendMessage.mockRejectedValueOnce(new Error('slack down'))
    const res = await raiseAlert({ db: t.db as never, pushover: t.svc, now: NOW, ...t.deps }, { ...ALERT, bad: true })
    expect(res.sent).toBe(true)
    expect(t.send).toHaveBeenCalledOnce()
    expect(t.store.get('alert_state:backup-stale')).toMatchObject({ level: 1 })

    const t2 = setup(open(24 * H))
    vi.stubEnv('MORNING_BRIEF_SLACK_CHANNEL', '')
    await raiseAlert({ db: t2.db as never, pushover: t2.svc, now: NOW, ...t2.deps }, { ...ALERT, bad: true })
    expect(t2.send).toHaveBeenCalledOnce()
    expect(t2.slack.sendMessage).not.toHaveBeenCalled()
  })

  it('24 h: an unconfigured Slack messenger is skipped', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    const t = setup(open(24 * H))
    const c = makeChannels({ slackConfigured: false })
    await raiseAlert({ db: t.db as never, pushover: t.svc, now: NOW, ...c.deps }, { ...ALERT, bad: true })
    expect(t.send).toHaveBeenCalledOnce()
    expect(c.slack.sendMessage).not.toHaveBeenCalled()
  })

  it('24 h: a failed Pushover send does not advance the level, so the next run retries', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    const t = setup(open(24 * H))
    t.send.mockRejectedValueOnce(new Error('Pushover API error 500'))
    const res = await raiseAlert({ db: t.db as never, pushover: t.svc, now: NOW, ...t.deps }, { ...ALERT, bad: true })
    expect(res).toEqual({ action: 'escalate_24h', sent: false })
    expect(t.slack.sendMessage).not.toHaveBeenCalled()
    expect(t.store.get('alert_state:backup-stale')).toMatchObject({ level: 0, last_notified_at: ago(24 * H) })
    const again = await raiseAlert({ db: t.db as never, pushover: t.svc, now: NOW, ...t.deps }, { ...ALERT, bad: true })
    expect(again).toEqual({ action: 'escalate_24h', sent: true })
  })

  it('7 d: one email to WEEKLY_BRIEF_EMAIL and one priority-2 send; level 2', async () => {
    const t = setup(open(7 * D, { level: 1, receipt: 'old' }, 6 * D))
    t.send.mockResolvedValueOnce({ receipt: 'rcpt-7' })
    vi.spyOn(PushoverService.prototype, 'getReceipt').mockResolvedValue({ acknowledged: false, acknowledgedAt: null, expired: true })
    const res = await raiseAlert({ db: t.db as never, pushover: t.svc, now: NOW, ...t.deps }, { ...ALERT, bad: true })
    expect(res).toEqual({ action: 'escalate_7d', sent: true })
    expect(t.himalaya.send).toHaveBeenCalledOnce()
    expect(t.himalaya.send).toHaveBeenCalledWith('owner@example.invalid', expect.stringContaining('Backup Stale'), expect.stringContaining('Backup is 30.0h old'))
    expect(t.send).toHaveBeenCalledOnce()
    expect(t.send).toHaveBeenCalledWith(expect.objectContaining({ priority: 2, retry: 600, expire: 10800 }))
    expect(t.slack.sendMessage).not.toHaveBeenCalled()
    expect(t.store.get('alert_state:backup-stale')).toMatchObject({ level: 2, receipt: 'rcpt-7', acked_at: null })
  })

  it('7 d: a missing email config or a failed email never blocks the Pushover send', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    const t = setup(open(7 * D, { level: 1 }, 6 * D))
    t.himalaya.send.mockRejectedValueOnce(new Error('smtp down'))
    await raiseAlert({ db: t.db as never, pushover: t.svc, now: NOW, ...t.deps }, { ...ALERT, bad: true })
    expect(t.send).toHaveBeenCalledOnce()

    const t2 = setup(open(7 * D, { level: 1 }, 6 * D))
    const c = makeChannels({ himalayaConfigured: false })
    await raiseAlert({ db: t2.db as never, pushover: t2.svc, now: NOW, ...c.deps }, { ...ALERT, bad: true })
    expect(c.himalaya.send).not.toHaveBeenCalled()
    expect(t2.send).toHaveBeenCalledOnce()

    const t3 = setup(open(7 * D, { level: 1 }, 6 * D))
    vi.stubEnv('WEEKLY_BRIEF_EMAIL', '')
    await raiseAlert({ db: t3.db as never, pushover: t3.svc, now: NOW, ...t3.deps }, { ...ALERT, bad: true })
    expect(t3.himalaya.send).not.toHaveBeenCalled()
    expect(t3.send).toHaveBeenCalledOnce()
  })

  it('8 d: one priority-2 send per day, no email, no Slack', async () => {
    const t = setup(open(8 * D, { level: 2, receipt: 'old' }, 25 * H))
    vi.spyOn(PushoverService.prototype, 'getReceipt').mockResolvedValue({ acknowledged: false, acknowledgedAt: null, expired: true })
    t.send.mockResolvedValueOnce({ receipt: 'rcpt-8' })
    const res = await raiseAlert({ db: t.db as never, pushover: t.svc, now: NOW, ...t.deps }, { ...ALERT, bad: true })
    expect(res).toEqual({ action: 'repeat_p2', sent: true })
    expect(t.send).toHaveBeenCalledWith(expect.objectContaining({ priority: 2, retry: 600, expire: 10800 }))
    expect(t.himalaya.send).not.toHaveBeenCalled()
    expect(t.slack.sendMessage).not.toHaveBeenCalled()
    expect(t.store.get('alert_state:backup-stale')).toMatchObject({ level: 2, receipt: 'rcpt-8', last_notified_at: NOW.toISOString() })

    const next = await raiseAlert({ db: t.db as never, pushover: t.svc, now: new Date(NOW.getTime() + 2 * H), ...t.deps }, { ...ALERT, bad: true })
    expect(next.action).toBe('none')
  })

  it('a warning open 30 d sends nothing', async () => {
    const { db } = makeStoreDb({ 'pipeline-queues': open(30 * D) })
    const p = makePushover()
    const ch = makeChannels()
    const res = await raiseAlert(
      { db: db as never, pushover: p.svc, now: NOW, ...ch.deps },
      { key: 'pipeline-queues', severity: 'warning', bad: true, title: 'Pipeline Queues', message: 'q' },
    )
    expect(res).toEqual({ action: 'none', sent: false })
    expect(p.send).not.toHaveBeenCalled()
    expect(ch.slack.sendMessage).not.toHaveBeenCalled()
  })

  it('without injected channels, the defaults are used and an unconfigured environment is skipped', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    vi.stubEnv('SLACK_BOT_TOKEN', '')
    vi.stubEnv('HIMALAYA_CONFIG', '')
    vi.stubEnv('MORNING_BRIEF_SLACK_CHANNEL', 'D-TEST')
    const { db } = makeStoreDb({ 'backup-stale': open(24 * H) })
    const p = makePushover()
    const res = await raiseAlert({ db: db as never, pushover: p.svc, now: NOW }, { ...ALERT, bad: true })
    expect(res.action).toBe('escalate_24h')
    expect(p.send).toHaveBeenCalledOnce()
  })
})

describe('raiseAlert acknowledgement', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('an acknowledged receipt writes acked_at and sends nothing; escalation resumes after 7 d', async () => {
    const ackAt = ago(1 * H)
    const { db, store } = makeStoreDb({ 'backup-stale': open(31 * H, { level: 1, receipt: 'rcpt-1' }, 7 * H) })
    const p = makePushover()
    const ch = makeChannels()
    const getReceipt = vi.spyOn(PushoverService.prototype, 'getReceipt').mockResolvedValue({ acknowledged: true, acknowledgedAt: ackAt, expired: false })
    const res = await raiseAlert({ db: db as never, pushover: p.svc, now: NOW, ...ch.deps }, { ...ALERT, bad: true })
    expect(getReceipt).toHaveBeenCalledWith('rcpt-1')
    expect(res).toEqual({ action: 'none', sent: false })
    expect(p.send).not.toHaveBeenCalled()
    expect(store.get('alert_state:backup-stale')).toMatchObject({ acked_at: ackAt, receipt: 'rcpt-1', level: 1 })

    // 6 d later (still inside the snooze): no lookup, no send
    getReceipt.mockClear()
    const inside = await raiseAlert({ db: db as never, pushover: p.svc, now: new Date(NOW.getTime() + 6 * D), ...ch.deps }, { ...ALERT, bad: true })
    expect(inside.action).toBe('none')
    expect(getReceipt).not.toHaveBeenCalled()

    // 7 d after the ack, and open > 7 d: escalation resumes
    p.send.mockResolvedValueOnce({ receipt: 'rcpt-2' })
    const after = await raiseAlert({ db: db as never, pushover: p.svc, now: new Date(NOW.getTime() + 7 * D), ...ch.deps }, { ...ALERT, bad: true })
    expect(after.action).toBe('escalate_7d')
    expect(store.get('alert_state:backup-stale')).toMatchObject({ receipt: 'rcpt-2', acked_at: null, level: 2 })
  })

  it('an unacknowledged receipt changes nothing', async () => {
    const { db } = makeStoreDb({ 'backup-stale': open(25 * H, { level: 1, receipt: 'rcpt-1' }, H) })
    const p = makePushover()
    vi.spyOn(PushoverService.prototype, 'getReceipt').mockResolvedValue({ acknowledged: false, acknowledgedAt: null, expired: false })
    const res = await raiseAlert({ db: db as never, pushover: p.svc, now: NOW }, { ...ALERT, bad: true })
    expect(res).toEqual({ action: 'none', sent: false })
    expect(db.execute).toHaveBeenCalledTimes(1)
  })

  it('a receipt lookup that throws or returns null is logged at warn and never blocks', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    const { db } = makeStoreDb({ 'backup-stale': open(31 * H, { level: 1, receipt: 'rcpt-1' }, 7 * H) })
    const p = makePushover()
    vi.spyOn(PushoverService.prototype, 'getReceipt').mockRejectedValueOnce(new Error('Pushover receipt API error 500'))
    const res = await raiseAlert({ db: db as never, pushover: p.svc, now: NOW }, { ...ALERT, bad: true })
    expect(res.action).toBe('none')
    expect(warn).toHaveBeenCalled()

    vi.spyOn(PushoverService.prototype, 'getReceipt').mockResolvedValueOnce(null)
    const res2 = await raiseAlert({ db: db as never, pushover: p.svc, now: NOW }, { ...ALERT, bad: true })
    expect(res2.action).toBe('none')
  })

  it('a failed lookup does not stop an due escalation', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    const { db } = makeStoreDb({ 'backup-stale': open(7 * D, { level: 1, receipt: 'rcpt-1' }, 6 * D) })
    const p = makePushover()
    vi.spyOn(PushoverService.prototype, 'getReceipt').mockRejectedValue(new Error('boom'))
    const res = await raiseAlert({ db: db as never, pushover: p.svc, now: NOW }, { ...ALERT, bad: true })
    expect(res.action).toBe('escalate_7d')
    expect(p.send).toHaveBeenCalledOnce()
  })

  it('no lookup when the alert is clearing (bad=false) or has no receipt', async () => {
    const getReceipt = vi.spyOn(PushoverService.prototype, 'getReceipt')
    const a = makeStoreDb({ 'backup-stale': open(31 * H, { level: 1, receipt: 'rcpt-1' }, 7 * H) })
    const p = makePushover()
    await raiseAlert({ db: a.db as never, pushover: p.svc, now: NOW }, { ...ALERT, bad: false })
    const b = makeStoreDb({ 'backup-stale': open(3 * H) })
    await raiseAlert({ db: b.db as never, pushover: p.svc, now: NOW }, { ...ALERT, bad: true })
    expect(getReceipt).not.toHaveBeenCalled()
  })

  it('an acknowledgement with no timestamp falls back to now', async () => {
    const { db, store } = makeStoreDb({ 'backup-stale': open(31 * H, { level: 1, receipt: 'rcpt-1' }, 7 * H) })
    const p = makePushover()
    vi.spyOn(PushoverService.prototype, 'getReceipt').mockResolvedValue({ acknowledged: true, acknowledgedAt: null, expired: false })
    await raiseAlert({ db: db as never, pushover: p.svc, now: NOW }, { ...ALERT, bad: true })
    expect(store.get('alert_state:backup-stale')).toMatchObject({ acked_at: NOW.toISOString() })
  })
})
