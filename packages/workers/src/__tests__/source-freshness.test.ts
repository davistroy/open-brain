/**
 * Item 3.3 — per-source heartbeats: the store (lib/heartbeat.ts), the reader
 * (querySourceFreshness) and pipeline-health's one-alert-per-source wiring.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import type { HeartbeatRecord } from '@open-brain/shared'
import { PipelineHealthSkill } from '../skills/pipeline-health.js'
import { querySourceFreshness, EXPECTED_HEARTBEAT_SOURCES } from '../skills/pipeline-health-query.js'
import { recordHeartbeat, readHeartbeats, ensureHeartbeatBaseline } from '../lib/heartbeat.js'

const pushMetricsMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
vi.mock('../lib/push-metrics.js', () => ({
  pushMetrics: pushMetricsMock,
  buildExposition: vi.fn().mockReturnValue(''),
}))

const NOW = new Date('2026-11-23T15:00:00.000Z')
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString()
const daysAgo = (d: number) => hoursAgo(d * 24)
const dialect = new PgDialect()

function rec(over: Partial<HeartbeatRecord> = {}): HeartbeatRecord {
  return { last_attempt_at: hoursAgo(1), last_success_at: hoursAgo(1), ok: true, errors: [], meta: {}, ...over }
}

/** In-memory app_settings + captures behind db.execute, parsed from the real rendered SQL. */
function makeDb(seed: Record<string, unknown> = {}, captureRows: Array<{ source: string; newest: string }> = []) {
  const store = new Map<string, unknown>(Object.entries(seed))
  const execute = vi.fn(async (q: SQL) => {
    const { sql: text, params } = dialect.sqlToQuery(q)
    if (/INSERT INTO app_settings/.test(text)) {
      const key = params[0] as string
      const doNothing = /DO NOTHING/.test(text)
      if (!(doNothing && store.has(key))) store.set(key, JSON.parse(params[1] as string))
      return { rows: [] }
    }
    if (/FROM app_settings WHERE key LIKE/.test(text)) {
      const prefix = String(params[0]).replace(/%$/, '')
      return { rows: [...store].filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value })) }
    }
    if (/FROM app_settings WHERE key =/.test(text)) {
      return { rows: store.has(params[0] as string) ? [{ value: store.get(params[0] as string) }] : [] }
    }
    if (/FROM captures/.test(text) && /GROUP BY source/.test(text)) return { rows: captureRows }
    return { rows: [] }
  })
  const insert = vi.fn().mockReturnValue({ values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 'log-id' }]) }) })
  return { db: { execute, insert } as never, store, execute }
}

function queueFactory() {
  return () => ({
    getJobCounts: vi.fn().mockResolvedValue({ waiting: 0, active: 0, failed: 0, delayed: 0, paused: 0 }),
    getJobCountByTypes: vi.fn().mockResolvedValue(0),
    countFailedSince: vi.fn().mockResolvedValue(0),
    close: vi.fn().mockResolvedValue(undefined),
  })
}

function allFresh(over: Record<string, unknown> = {}): Record<string, unknown> {
  const seed: Record<string, unknown> = {}
  for (const s of EXPECTED_HEARTBEAT_SOURCES) seed[`heartbeat:${s}`] = rec()
  return { ...seed, ...over }
}

describe('lib/heartbeat', () => {
  it('recordHeartbeat keeps last_success_at on failure and stores at most 5 errors', async () => {
    const { db, store } = makeDb({ 'heartbeat:gas': rec({ last_success_at: '2026-11-20T00:00:00.000Z' }) })
    await recordHeartbeat(db, 'gas', { ok: false, errors: ['1', '2', '3', '4', '5', '6', '7'] }, NOW)
    const saved = store.get('heartbeat:gas') as HeartbeatRecord
    expect(saved.ok).toBe(false)
    expect(saved.errors).toEqual(['1', '2', '3', '4', '5'])
    expect(saved.last_success_at).toBe('2026-11-20T00:00:00.000Z')
    expect(saved.last_attempt_at).toBe(NOW.toISOString())
  })

  it('recordHeartbeat advances last_success_at on success and never throws', async () => {
    const { db, store } = makeDb()
    await recordHeartbeat(db, 'memory-consolidation', { ok: true }, NOW)
    expect((store.get('heartbeat:memory-consolidation') as HeartbeatRecord).last_success_at).toBe(NOW.toISOString())
    const boom = { execute: vi.fn().mockRejectedValue(new Error('db down')) } as never
    await expect(recordHeartbeat(boom, 'gas', { ok: true })).resolves.toBeNull()
  })

  it('ensureHeartbeatBaseline writes a baseline dated now only for sources with no record', async () => {
    const { db, store } = makeDb({ 'heartbeat:gas': rec({ last_success_at: daysAgo(30) }) })
    const written = await ensureHeartbeatBaseline(db, ['gas', 'actual'], NOW)
    expect(written).toEqual(['actual'])
    expect((store.get('heartbeat:actual') as HeartbeatRecord).last_success_at).toBe(NOW.toISOString())
    expect((store.get('heartbeat:gas') as HeartbeatRecord).last_success_at).toBe(daysAgo(30))
    expect((await readHeartbeats(db)).size).toBe(2)
  })
})

describe('querySourceFreshness thresholds', () => {
  const stale = async (source: string, r: HeartbeatRecord) => {
    const { db } = makeDb({ [`heartbeat:${source}`]: r })
    const res = await querySourceFreshness(db, NOW)
    return res!.sources.find((s) => s.source === source)!
  }

  it.each([
    ['gas', 47, false],
    ['gas', 49, true],
    ['actual', 35, false],
    ['actual', 37, true],
    ['email:gmail', 37, true],
    ['email:hotmail', 35, false],
    ['secret-rotation', 34 * 24, false],
    ['secret-rotation', 36 * 24, true],
    ['memory-consolidation', 7 * 24, false],
    ['memory-consolidation', 9 * 24, true],
  ])('%s last success %i h ago -> stale=%s', async (source, hours, expected) => {
    const f = await stale(source, rec({ last_success_at: hoursAgo(hours as number) }))
    expect(f.stale).toBe(expected)
  })

  it('ok=false is stale even when the last success is recent', async () => {
    const f = await stale('actual', rec({ ok: false, errors: ['auth expired'] }))
    expect(f.stale).toBe(true)
    expect(f.reason).toContain('auth expired')
  })

  it('gas with a latest_bill_date older than 40 d is stale; 39 d is not', async () => {
    expect((await stale('gas', rec({ meta: { latest_bill_date: daysAgo(41) } }))).stale).toBe(true)
    expect((await stale('gas', rec({ meta: { latest_bill_date: daysAgo(39) } }))).stale).toBe(false)
  })

  it('omits a source with no record, and returns null when the read fails', async () => {
    const { db } = makeDb()
    expect((await querySourceFreshness(db, NOW))!.sources).toEqual([])
    const boom = { execute: vi.fn().mockRejectedValue(new Error('down')) } as never
    expect(await querySourceFreshness(boom, NOW)).toBeNull()
  })

  it('reports the newest capture per source and flags those idle over 7 d', async () => {
    const { db } = makeDb({}, [
      { source: 'voice', newest: daysAgo(2) },
      { source: 'slack', newest: daysAgo(12) },
    ])
    const res = await querySourceFreshness(db, NOW)
    expect(res!.captureSources.find((c) => c.source === 'voice')).toMatchObject({ ageDays: 2, quiet: false })
    expect(res!.captureSources.find((c) => c.source === 'slack')).toMatchObject({ ageDays: 12, quiet: true })
  })
})

describe('pipeline-health source-stale alerts', () => {
  beforeEach(() => {
    vi.stubEnv('ALERT_STATE_ENABLED', 'true')
    vi.stubEnv('LEGACY_PUSH_ENABLED', 'false')
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    pushMetricsMock.mockClear()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  function make(db: never) {
    const send = vi.fn().mockResolvedValue({ success: true, output: '' })
    const skill = new PipelineHealthSkill({
      db,
      queueFactory: queueFactory(),
      pushover: { isConfigured: true, send } as never,
    })
    return { skill, send }
  }
  const staleTitles = (send: ReturnType<typeof vi.fn>) =>
    send.mock.calls.map((c) => (c[0] as { title: string }).title).filter((t) => t.includes('Source Stale'))

  it('a stale heartbeat pushes exactly once, stays silent next run, and resolves after a fresh heartbeat', async () => {
    const { db, store } = makeDb(allFresh({ 'heartbeat:gas': rec({ last_success_at: hoursAgo(49) }) }))
    const { skill, send } = make(db)

    const first = await skill.execute()
    expect(first.staleSources).toEqual(['gas'])
    expect(staleTitles(send)).toEqual(['Source Stale: gas'])

    send.mockClear()
    await skill.execute()
    expect(staleTitles(send)).toEqual([])

    store.set('heartbeat:gas', rec({ ok: true, last_success_at: hoursAgo(0) }))
    send.mockClear()
    const third = await skill.execute()
    expect(third.staleSources).toEqual([])
    const titles = send.mock.calls.map((c) => (c[0] as { title: string }).title)
    expect(titles).toContain('Resolved: Source Stale: gas')
  })

  it('writes a baseline for a missing record and raises no alert on that run', async () => {
    const { db, store } = makeDb()
    const { skill, send } = make(db)
    const res = await skill.execute()
    for (const s of EXPECTED_HEARTBEAT_SOURCES) {
      expect((store.get(`heartbeat:${s}`) as HeartbeatRecord).last_success_at).toBe(NOW.toISOString())
    }
    expect(res.staleSources).toEqual([])
    expect(staleTitles(send)).toEqual([])
  })

  it('raises one alert per source with its own key', async () => {
    const { db, store } = makeDb(
      allFresh({ 'heartbeat:actual': rec({ ok: false, errors: ['x'] }), 'heartbeat:email:gmail': rec({ ok: false, errors: ['y'] }) }),
    )
    const { skill, send } = make(db)
    await skill.execute()
    expect(staleTitles(send).sort()).toEqual(['Source Stale: actual', 'Source Stale: email:gmail'])
    expect(store.has('alert_state:source-stale:actual')).toBe(true)
    expect(store.has('alert_state:source-stale:email:gmail')).toBe(true)
  })

  it('lists an idle voice/slack/email capture source in the summary and raises no alert', async () => {
    const { db } = makeDb(allFresh(), [{ source: 'slack', newest: daysAgo(12) }])
    const { skill, send } = make(db)
    const res = await skill.execute()
    expect(res.quietCaptureSources).toEqual(['slack:12d'])
    expect(staleTitles(send)).toEqual([])
  })

  it('pushes the openbrain_source_last_success_seconds gauge per source', async () => {
    const { db } = makeDb(allFresh({ 'heartbeat:gas': rec({ last_success_at: hoursAgo(2) }) }))
    const { skill } = make(db)
    await skill.execute()
    const lines = pushMetricsMock.mock.calls.flatMap((c) => c[0] as Array<{ name: string; value: number; labels?: Record<string, string> }>)
    const gas = lines.find((m) => m.name === 'openbrain_source_last_success_seconds' && m.labels?.source === 'gas')
    expect(gas?.value).toBe(7200)
  })
})
