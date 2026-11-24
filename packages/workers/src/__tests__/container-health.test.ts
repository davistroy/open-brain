import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { resetAlertStateMirror } from '../lib/alert-state.js'
import { PushoverService } from '@open-brain/shared'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import type { ConfigService } from '@open-brain/shared'
import {
  ContainerHealthSkill,
  DEFAULT_ENDPOINTS,
  LEGACY_MONITORED_CONTAINERS,
  resetContainerStreaks,
} from '../skills/container-health.js'
import type { ContainerEndpoint } from '../skills/container-health.js'
import { pushBackupAgeGauge } from '../lib/backup-age.js'

beforeEach(() => resetAlertStateMirror())

// Mock pushMetrics to prevent real HTTP calls to Pushgateway during tests
vi.mock('../lib/push-metrics.js', () => ({
  pushMetrics: vi.fn().mockResolvedValue(undefined),
  buildExposition: vi.fn().mockReturnValue(''),
}))

// #309: container-health re-pushes the backup-age gauge every run. Mock the
// shared helper so the wiring is asserted without touching fs/Pushgateway.
vi.mock('../lib/backup-age.js', () => ({
  pushBackupAgeGauge: vi.fn().mockResolvedValue(1234),
}))

// ============================================================
// Mock helpers
// ============================================================

const TEST_ENDPOINTS: ContainerEndpoint[] = [
  { name: 'core-api', url: 'http://core-api:3000/health' },
  { name: 'voice-capture', url: 'http://workers:3001/health' },
  { name: 'web', url: 'http://web:5173/' },
]

/**
 * Creates a mock fetch that returns healthy for all URLs by default.
 * Pass `unhealthyContainers` to make specific URLs return errors.
 */
function makeMockFetch(unhealthyUrls: Set<string> = new Set()): typeof globalThis.fetch {
  return vi.fn(async (url: string | URL | Request) => {
    const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
    if (unhealthyUrls.has(urlStr)) {
      return new Response('Service Unavailable', { status: 503 })
    }
    return new Response(JSON.stringify({ status: 'healthy' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as typeof globalThis.fetch
}

/**
 * Creates a mock fetch that throws (simulates network error).
 */
function makeFailingFetch(): typeof globalThis.fetch {
  return vi.fn(async () => {
    throw new Error('ECONNREFUSED')
  }) as unknown as typeof globalThis.fetch
}

function makeMockDb(consecutiveUnhealthyRows: { healthy: boolean }[] = []) {
  const executeMock = vi.fn().mockResolvedValue({ rows: consecutiveUnhealthyRows })
  return {
    execute: executeMock,
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 'mock-log-id' }]) }),
    }),
  }
}

function makePushover(configured = true) {
  const svc = new PushoverService('fake-token', 'fake-user')
  if (!configured) {
    Object.defineProperty(svc, 'isConfigured', { get: () => false })
  }
  vi.spyOn(svc, 'send').mockResolvedValue(undefined)
  return svc
}

function makeSkill(opts: {
  fetchFn?: typeof globalThis.fetch
  pushoverConfigured?: boolean
  consecutiveUnhealthyRows?: { healthy: boolean }[]
  endpoints?: ContainerEndpoint[]
} = {}) {
  const db = makeMockDb(opts.consecutiveUnhealthyRows ?? [])
  const pushover = makePushover(opts.pushoverConfigured ?? true)
  const fetchFn = opts.fetchFn ?? makeMockFetch()

  const skill = new ContainerHealthSkill({
    db: db as unknown as import('@open-brain/shared').Database,
    pushover,
    fetchFn,
    endpoints: opts.endpoints ?? TEST_ENDPOINTS,
    includeStores: false,
  })

  return { skill, db, pushover, fetchFn }
}

// ============================================================
// Tests
// ============================================================

describe('ContainerHealthSkill', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    resetContainerStreaks()
  })

  describe('all containers healthy', () => {
    it('returns all healthy when all /health checks pass', async () => {
      const { skill } = makeSkill()

      const result = await skill.execute()

      expect(result.healthyCount).toBe(3)
      expect(result.unhealthyCount).toBe(0)
      expect(result.alertsSent).toHaveLength(0)
      expect(result.checks).toHaveLength(3)
      for (const check of result.checks) {
        expect(check.healthy).toBe(true)
        expect(check.response_ms).toBeGreaterThanOrEqual(0)
      }
    })

    it('writes results to container_health table', async () => {
      const { skill, db } = makeSkill()

      await skill.execute()

      // 3 insert calls for container_health + 1 for skills_log
      expect(db.insert).toHaveBeenCalledTimes(4)
    })
  })

  describe('unhealthy containers', () => {
    it('detects container returning 503', async () => {
      const unhealthyUrls = new Set(['http://workers:3001/health'])
      const fetchFn = makeMockFetch(unhealthyUrls)

      const { skill } = makeSkill({ fetchFn })

      const result = await skill.execute()

      expect(result.healthyCount).toBe(2)
      expect(result.unhealthyCount).toBe(1)

      const unhealthy = result.checks.find(c => c.container_name === 'voice-capture')
      expect(unhealthy?.healthy).toBe(false)
    })

    it('detects container with network error', async () => {
      const fetchFn = makeFailingFetch()

      const { skill } = makeSkill({ fetchFn })

      const result = await skill.execute()

      expect(result.healthyCount).toBe(0)
      expect(result.unhealthyCount).toBe(3)
      for (const check of result.checks) {
        expect(check.healthy).toBe(false)
        expect(check.error).toContain('ECONNREFUSED')
      }
    })
  })

  describe('consecutive failure alerting', () => {
    it('sends alert after 3 consecutive failures', async () => {
      const unhealthyUrls = new Set(['http://workers:3001/health'])
      const fetchFn = makeMockFetch(unhealthyUrls)
      // 3 consecutive unhealthy rows (including the current one just written)
      const consecutiveRows = [
        { healthy: false },
        { healthy: false },
        { healthy: false },
      ]

      const { skill, pushover } = makeSkill({
        fetchFn,
        consecutiveUnhealthyRows: consecutiveRows,
      })

      const result = await skill.execute({ consecutiveFailureThreshold: 3 })

      expect(result.alertsSent).toContain('voice-capture')
      expect(pushover.send).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Open Brain: voice-capture unhealthy',
          priority: 1,
        }),
      )
    })

    it('does not alert when consecutive count is below threshold', async () => {
      const unhealthyUrls = new Set(['http://workers:3001/health'])
      const fetchFn = makeMockFetch(unhealthyUrls)
      // Only 2 consecutive failures — below threshold of 3
      const consecutiveRows = [
        { healthy: false },
        { healthy: false },
        { healthy: true },
      ]

      const { skill, pushover } = makeSkill({
        fetchFn,
        consecutiveUnhealthyRows: consecutiveRows,
      })

      const result = await skill.execute({ consecutiveFailureThreshold: 3 })

      expect(result.alertsSent).toHaveLength(0)
      expect(pushover.send).not.toHaveBeenCalled()
    })

    it('does not alert when Pushover is not configured', async () => {
      const unhealthyUrls = new Set(['http://workers:3001/health'])
      const fetchFn = makeMockFetch(unhealthyUrls)
      const consecutiveRows = [
        { healthy: false },
        { healthy: false },
        { healthy: false },
      ]

      const { skill, pushover } = makeSkill({
        fetchFn,
        pushoverConfigured: false,
        consecutiveUnhealthyRows: consecutiveRows,
      })

      const result = await skill.execute({ consecutiveFailureThreshold: 3 })

      expect(result.alertsSent).toHaveLength(0)
      expect(pushover.send).not.toHaveBeenCalled()
    })
  })

  describe('custom endpoints', () => {
    it('checks only the configured endpoints', async () => {
      const customEndpoints: ContainerEndpoint[] = [
        { name: 'test-svc', url: 'http://test:8080/health' },
      ]
      const { skill } = makeSkill({ endpoints: customEndpoints })

      const result = await skill.execute()

      expect(result.checks).toHaveLength(1)
      expect(result.checks[0].container_name).toBe('test-svc')
    })
  })

  describe('getConsecutiveFailureCount', () => {
    it('counts consecutive unhealthy rows from most recent', async () => {
      const consecutiveRows = [
        { healthy: false },
        { healthy: false },
        { healthy: true },
        { healthy: false },
      ]
      const { skill } = makeSkill({ consecutiveUnhealthyRows: consecutiveRows })

      const count = await skill.getConsecutiveFailureCount('test')

      // Stops at first healthy row — count is 2
      expect(count).toBe(2)
    })

    it('returns 0 when most recent check is healthy', async () => {
      const consecutiveRows = [
        { healthy: true },
        { healthy: false },
        { healthy: false },
      ]
      const { skill } = makeSkill({ consecutiveUnhealthyRows: consecutiveRows })

      const count = await skill.getConsecutiveFailureCount('test')

      expect(count).toBe(0)
    })
  })

  describe('skills_log', () => {
    it('writes summary to skills_log', async () => {
      const { skill, db } = makeSkill()

      await skill.execute()

      // Last insert call should be skills_log
      const insertCalls = db.insert.mock.calls
      expect(insertCalls.length).toBeGreaterThan(0)
    })
  })
})

describe('backup-age gauge (#309)', () => {
  it('re-pushes the backup-age gauge on every run', async () => {
    const { skill } = makeSkill()
    await skill.execute()
    expect(pushBackupAgeGauge).toHaveBeenCalled()
  })
})

describe('DEFAULT_ENDPOINTS', () => {
  it('does not probe the dead litellm endpoint', () => {
    expect(DEFAULT_ENDPOINTS.some(ep => ep.name === 'litellm')).toBe(false)
  })

  it('probes faster-whisper on its real health path', () => {
    const faster = DEFAULT_ENDPOINTS.find(ep => ep.name === 'faster-whisper')
    expect(faster).toEqual({ name: 'faster-whisper', url: 'http://faster-whisper:8000/health' })
  })

  it('no longer hard-codes the LLM tiers (they follow model_tiers)', () => {
    expect(DEFAULT_ENDPOINTS.some(ep => ep.name.endsWith('-llm'))).toBe(false)
    expect(DEFAULT_ENDPOINTS.map(ep => ep.name)).toEqual(['core-api', 'voice-capture', 'file-ingestion', 'faster-whisper'])
  })
})

// ============================================================
// Item 4.5 — config-driven LLM probes, store probes, raiseAlert
// ============================================================

const ENV_KEYS = ['ALERT_STATE_ENABLED', 'ALERT_LEGACY_PUSH'] as const
const savedEnv: Record<string, string | undefined> = {}

function saveEnv() {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k]
}
function restoreEnv() {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
}

const JETSON_URL = 'http://192.168.10.58:8080/health'
const SPARK_URL = 'http://spark.k4jda.net:8000/health'

function makeConfig(tiers: Record<string, { provider: string; base_url?: string }>): ConfigService {
  return {
    get: vi.fn().mockReturnValue({
      model_tiers: Object.fromEntries(Object.entries(tiers).map(([k, v]) => [k, { model: 'm', ...v }])),
    }),
  } as unknown as ConfigService
}

const TWO_TIERS = {
  t0_local: { provider: 'ollama', base_url: 'http://ollama:11434/v1' },
  t1_jetson: { provider: 'openai_compat', base_url: 'http://192.168.10.58:8080/v1' },
  t1_spark: { provider: 'openai_compat', base_url: 'http://spark.k4jda.net:8000/v1/' },
  t1_fast: { provider: 'anthropic' },
}

/**
 * Stateful db double: an in-memory app_settings store (alert state), a
 * container_health history, and switches to fail individual statements.
 */
function makeStatefulDb(opts: { failAll?: boolean } = {}) {
  const dialect = new PgDialect()
  const state = new Map<string, unknown>()
  const history = new Map<string, boolean[]>()
  const ctl = { failAll: opts.failAll ?? false, failSelect1: false }
  const execute = vi.fn().mockImplementation(async (q: SQL) => {
    const { sql: text, params } = dialect.sqlToQuery(q)
    if (ctl.failAll) throw new Error('db down')
    if (/^\s*SELECT 1\s*$/i.test(text)) {
      if (ctl.failSelect1) throw new Error('connection refused')
      return { rows: [{ '?column?': 1 }] }
    }
    if (text.includes('INSERT INTO app_settings')) {
      state.set(params[0] as string, JSON.parse(params[1] as string))
      return { rows: [] }
    }
    if (text.includes('FROM app_settings')) {
      const v = state.get(params[0] as string)
      return { rows: v === undefined ? [] : [{ value: v }] }
    }
    if (text.includes('FROM container_health')) {
      const h = history.get(params[0] as string) ?? []
      return { rows: [...h].reverse().slice(0, 10).map(healthy => ({ healthy })) }
    }
    return { rows: [] }
  })
  const insert = vi.fn().mockImplementation(() => ({
    values: (v: { container_name?: string; healthy?: boolean }) => {
      if (ctl.failAll) throw new Error('db down')
      if (v.container_name !== undefined) {
        const h = history.get(v.container_name) ?? []
        h.push(Boolean(v.healthy))
        history.set(v.container_name, h)
      }
      return { returning: vi.fn().mockResolvedValue([{ id: 'log' }]) }
    },
  }))
  return { db: { execute, insert }, ctl, state }
}

function makeFetch(down: Set<string> = new Set()) {
  return vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    return down.has(url) ? new Response('nope', { status: 503 }) : new Response('{}', { status: 200 })
  }) as unknown as typeof globalThis.fetch
}

function makeFull(opts: {
  fetchFn?: typeof globalThis.fetch
  config?: ConfigService | undefined
  db?: ReturnType<typeof makeStatefulDb>
  redisPing?: () => Promise<void>
  endpoints?: ContainerEndpoint[]
} = {}) {
  const sdb = opts.db ?? makeStatefulDb()
  const pushover = makePushover(true)
  const skill = new ContainerHealthSkill({
    db: sdb.db as unknown as import('@open-brain/shared').Database,
    pushover,
    fetchFn: opts.fetchFn ?? makeFetch(),
    endpoints: 'endpoints' in opts ? opts.endpoints : [],
    configService: 'config' in opts ? opts.config : makeConfig(TWO_TIERS),
    redisPing: opts.redisPing ?? vi.fn().mockResolvedValue(undefined),
  })
  return { skill, sdb, pushover }
}

const sentTitles = (p: PushoverService) =>
  (p.send as unknown as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0] as { title: string; priority: number })

describe('item 4.5 — probes follow model_tiers', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    resetContainerStreaks()
    saveEnv()
  })
  afterEach(restoreEnv)

  it('probes every openai_compat tier at /health, and nothing for ollama/anthropic', async () => {
    const fetchFn = makeFetch()
    const { skill } = makeFull({ fetchFn, endpoints: undefined })
    const result = await skill.execute()
    const names = result.checks.map(c => c.container_name)
    expect(names).toContain('jetson-llm')
    expect(names).toContain('spark-llm')
    expect(names.filter(n => n.endsWith('-llm'))).toHaveLength(2)
    const urls = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0])
    expect(urls).toContain(JETSON_URL)
    expect(urls).toContain(SPARK_URL)
  })

  it('a third openai_compat tier adds a probe', async () => {
    const config = makeConfig({ ...TWO_TIERS, t2_atlas: { provider: 'openai_compat', base_url: 'http://atlas.lan:9000' } })
    const fetchFn = makeFetch()
    const { skill } = makeFull({ fetchFn, config, endpoints: undefined })
    const result = await skill.execute()
    expect(result.checks.map(c => c.container_name)).toContain('atlas-llm')
    const urls = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0])
    expect(urls).toContain('http://atlas.lan:9000/health')
  })

  it('skips an unparseable base_url with a warning instead of throwing', async () => {
    const config = makeConfig({ t1_bad: { provider: 'openai_compat', base_url: 'not a url' }, ...TWO_TIERS })
    const { skill } = makeFull({ config, endpoints: undefined })
    const result = await skill.execute()
    expect(result.checks.map(c => c.container_name)).not.toContain('bad-llm')
    expect(result.checks.map(c => c.container_name)).toContain('spark-llm')
  })

  it('with no configService there are no LLM probes', async () => {
    const { skill } = makeFull({ config: undefined, endpoints: undefined })
    const result = await skill.execute()
    expect(result.checks.some(c => c.container_name.endsWith('-llm'))).toBe(false)
  })
})

describe('item 4.5 — alerts through raiseAlert', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    resetContainerStreaks()
    saveEnv()
    delete process.env.ALERT_STATE_ENABLED
    process.env.ALERT_LEGACY_PUSH = 'false'
  })
  afterEach(restoreEnv)

  it('a tier down 3 runs raises once, sends nothing on run 4, and sends Resolved on recovery', async () => {
    const down = new Set([SPARK_URL])
    const fetchFn = makeFetch(down)
    const sdb = makeStatefulDb()
    const { skill, pushover } = makeFull({ fetchFn, db: sdb, endpoints: undefined })

    await skill.execute()
    await skill.execute()
    expect(pushover.send).not.toHaveBeenCalled()
    const third = await skill.execute()
    expect(third.alertsSent).toContain('spark-llm')
    expect(pushover.send).toHaveBeenCalledTimes(1)
    expect(sentTitles(pushover)[0].priority).toBe(0) // warning

    const fourth = await skill.execute()
    expect(fourth.alertsSent).not.toContain('spark-llm')
    expect(pushover.send).toHaveBeenCalledTimes(1)

    down.clear()
    await skill.execute()
    expect(pushover.send).toHaveBeenCalledTimes(2)
    expect(sentTitles(pushover)[1].title).toMatch(/^Resolved:/)
  })

  it('a SELECT 1 failure for 3 runs raises container:postgres as critical', async () => {
    const sdb = makeStatefulDb()
    sdb.ctl.failSelect1 = true
    const { skill, pushover } = makeFull({ db: sdb })
    for (let i = 0; i < 3; i++) await skill.execute()
    const calls = sentTitles(pushover)
    expect(calls).toHaveLength(1)
    expect(calls[0].priority).toBe(1)
    expect(calls[0].title).toContain('postgres')
  })

  it('design rule B: a fully-down database still alerts (counts and writes all fail)', async () => {
    const sdb = makeStatefulDb({ failAll: true })
    const { skill, pushover } = makeFull({ db: sdb })
    await skill.execute()
    await skill.execute()
    expect(pushover.send).not.toHaveBeenCalled()
    const third = await skill.execute()
    expect(third.alertsSent).toContain('postgres')
    const pg = sentTitles(pushover).filter(c => c.title.includes('postgres'))
    expect(pg).toHaveLength(1)
    expect(pg[0].priority).toBe(1)

    // The in-process alert mirror keeps the open state while every DB call fails:
    // run 4 sends no second postgres push.
    await skill.execute()
    expect(sentTitles(pushover).filter(c => c.title.includes('postgres'))).toHaveLength(1)

    // Recovery with the database still unreachable-for-state: "Resolved" is sent once.
    sdb.ctl.failAll = false
    sdb.state.clear() // the DB came back empty; only the mirror knows the alert was open
    await skill.execute()
    const resolved = sentTitles(pushover).filter(c => c.title.startsWith('Resolved:') && c.title.includes('postgres'))
    expect(resolved).toHaveLength(1)
  })

  it('a Redis PING failure for 3 runs raises container:redis as critical', async () => {
    const redisPing = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    const { skill, pushover } = makeFull({ redisPing })
    for (let i = 0; i < 3; i++) await skill.execute()
    const calls = sentTitles(pushover)
    expect(calls).toHaveLength(1)
    expect(calls[0].priority).toBe(1)
    expect(calls[0].title).toContain('redis')
  })

  it('without a redis dependency the redis probe is skipped', async () => {
    const sdb = makeStatefulDb()
    const skill = new ContainerHealthSkill({
      db: sdb.db as unknown as import('@open-brain/shared').Database,
      pushover: makePushover(true),
      fetchFn: makeFetch(),
      endpoints: [],
    })
    const result = await skill.execute()
    expect(result.checks.map(c => c.container_name)).toEqual(['postgres'])
  })
})

describe('item 4.5 — exact legacy rollback', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    resetContainerStreaks()
    saveEnv()
  })
  afterEach(restoreEnv)

  it('pins the legacy list to the f341ca6 probe names', () => {
    expect([...LEGACY_MONITORED_CONTAINERS]).toEqual(['core-api', 'voice-capture', 'file-ingestion', 'faster-whisper', 'jetson-llm'])
  })

  it('ALERT_STATE_ENABLED=false: only pinned names get the legacy priority-1 push; spark-llm gets none', async () => {
    process.env.ALERT_STATE_ENABLED = 'false'
    delete process.env.ALERT_LEGACY_PUSH
    const down = new Set([SPARK_URL, JETSON_URL])
    const { skill, pushover } = makeFull({ fetchFn: makeFetch(down), endpoints: undefined })
    for (let i = 0; i < 4; i++) await skill.execute()
    const calls = sentTitles(pushover)
    expect(calls.every(c => c.priority === 1)).toBe(true)
    expect(calls.some(c => c.title === 'Open Brain: jetson-llm unhealthy')).toBe(true)
    expect(calls.some(c => c.title.includes('spark-llm'))).toBe(false)
    // priority-1 every run past the threshold, as at f341ca6 (runs 3 and 4)
    expect(calls.filter(c => c.title.includes('jetson-llm'))).toHaveLength(2)
  })

  it('ALERT_LEGACY_PUSH=false: no legacy push (priority 1 appears only from raiseAlert on critical)', async () => {
    delete process.env.ALERT_STATE_ENABLED
    process.env.ALERT_LEGACY_PUSH = 'false'
    const down = new Set(['http://voice-capture:3001/health'])
    const { skill, pushover } = makeFull({
      fetchFn: makeFetch(down),
      endpoints: [{ name: 'voice-capture', url: 'http://voice-capture:3001/health' }],
    })
    for (let i = 0; i < 4; i++) await skill.execute()
    // raiseAlert (warning, priority 0) once; the legacy priority-1 push never runs
    const calls = sentTitles(pushover).filter(c => c.title.includes('voice-capture'))
    expect(calls).toHaveLength(1)
    expect(calls[0].priority).toBe(0)
  })
})
