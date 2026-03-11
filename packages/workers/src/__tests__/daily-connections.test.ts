import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest'
import { join } from 'node:path'
import { DailyConnectionsSkill, parseOutput } from '../skills/daily-connections.js'
import type { DailyConnectionsOutput } from '../skills/daily-connections.js'
import {
  queryRecentCaptures,
  buildEntityCoOccurrence,
  assembleContext,
  formatCoOccurrence,
  fmtDate,
  formatCapture,
  CHARS_PER_TOKEN,
  DEFAULT_TOKEN_BUDGET,
  VIEW_ORDER,
} from '../skills/daily-connections-query.js'
import type { EntityCoOccurrence } from '../skills/daily-connections-query.js'
import type { CaptureRecord } from '@open-brain/shared'
import { PushoverService } from '../services/pushover.js'

// Prompt templates live at <repo-root>/config/prompts/
const REPO_PROMPTS_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'config', 'prompts')

// ============================================================
// Fixtures
// ============================================================

function makeCapture(overrides: Partial<CaptureRecord> = {}): CaptureRecord {
  return {
    id: 'cap-1',
    content: 'Test capture content.',
    capture_type: 'observation',
    brain_view: 'technical',
    source: 'api',
    tags: [],
    captured_at: new Date('2026-03-01T10:00:00Z'),
    created_at: new Date('2026-03-01T10:00:00Z'),
    updated_at: new Date('2026-03-01T10:00:00Z'),
    content_hash: 'hash1',
    pipeline_status: 'complete',
    pipeline_attempts: 1,
    ...overrides,
  } as CaptureRecord
}

const SAMPLE_CAPTURES: CaptureRecord[] = [
  makeCapture({
    id: 'cap-1',
    content: 'Closed the NovaBurger retainer — $8K/month starting April.',
    capture_type: 'win',
    brain_view: 'client',
    tags: ['stratfield', 'revenue'],
    captured_at: new Date('2026-03-01T10:00:00Z'),
    content_hash: 'hash1',
  }),
  makeCapture({
    id: 'cap-2',
    content: 'QSR ops dashboard blocked — IT access request still pending.',
    capture_type: 'blocker',
    brain_view: 'work-internal',
    tags: ['qsr', 'infrastructure'],
    captured_at: new Date('2026-03-02T14:30:00Z'),
    content_hash: 'hash2',
  }),
  makeCapture({
    id: 'cap-3',
    content: 'Voice pipeline end-to-end working — Apple Watch to Postgres.',
    capture_type: 'win',
    brain_view: 'technical',
    tags: ['open-brain', 'voice'],
    captured_at: new Date('2026-03-03T09:00:00Z'),
    content_hash: 'hash3',
  }),
]

const SAMPLE_CO_OCCURRENCE: EntityCoOccurrence[] = [
  { entity_a_name: 'QSR Corp', entity_a_type: 'organization', entity_b_name: 'NovaBurger', entity_b_type: 'organization', co_occurrence_count: 5 },
  { entity_a_name: 'Troy', entity_a_type: 'person', entity_b_name: 'Open Brain', entity_b_type: 'project', co_occurrence_count: 3 },
]

const SAMPLE_CONNECTIONS_OUTPUT: DailyConnectionsOutput = {
  summary: 'Cross-domain pattern between QSR client work and technical infrastructure.',
  connections: [
    {
      theme: 'Client-Infrastructure Convergence',
      captures: ['cap-1', 'cap-2'],
      insight: 'The QSR ops dashboard blocker mirrors a pattern in voice pipeline work — both require upstream API access.',
      confidence: 'high',
      domains: ['client', 'technical'],
    },
    {
      theme: 'Revenue-Tech Alignment',
      captures: ['cap-1', 'cap-3'],
      insight: 'NovaBurger retainer success correlates with voice pipeline completion — both validate the AI-first approach.',
      confidence: 'medium',
      domains: ['client', 'technical'],
    },
  ],
  meta_pattern: 'Infrastructure readiness is the gating factor across all domains.',
}

// ============================================================
// Mock helpers
// ============================================================

function makeMockDb(captures = SAMPLE_CAPTURES, coOccurrence = SAMPLE_CO_OCCURRENCE) {
  let callCount = 0
  return {
    execute: vi.fn().mockImplementation(() => {
      callCount++
      // First call: queryRecentCaptures, second call: buildEntityCoOccurrence
      if (callCount === 1) return Promise.resolve({ rows: captures })
      return Promise.resolve({ rows: coOccurrence })
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    }),
  }
}

function makeMockOpenAI(jsonOutput: DailyConnectionsOutput = SAMPLE_CONNECTIONS_OUTPUT) {
  return {
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [{ message: { content: JSON.stringify(jsonOutput) } }],
          usage: { prompt_tokens: 600, completion_tokens: 300, total_tokens: 900 },
        }),
      },
    },
  }
}

function makePushoverService(configured = true) {
  const svc = new PushoverService('fake-token', 'fake-user')
  if (!configured) {
    Object.defineProperty(svc, 'isConfigured', { get: () => false })
  }
  vi.spyOn(svc, 'send').mockResolvedValue(undefined)
  return svc
}

function makeSkill(opts: {
  captures?: CaptureRecord[]
  coOccurrence?: EntityCoOccurrence[]
  connectionsOutput?: DailyConnectionsOutput
  pushoverConfigured?: boolean
  promptsDir?: string
  coreApiResponse?: { ok: boolean; json?: object; status?: number }
} = {}) {
  const db = makeMockDb(opts.captures ?? SAMPLE_CAPTURES, opts.coOccurrence ?? SAMPLE_CO_OCCURRENCE)
  const mockLitellm = makeMockOpenAI(opts.connectionsOutput ?? SAMPLE_CONNECTIONS_OUTPUT)
  const pushover = makePushoverService(opts.pushoverConfigured ?? true)

  const fetchResponse = opts.coreApiResponse ?? { ok: true, json: { id: 'saved-cap-id' } }
  const mockFetch = vi.fn().mockResolvedValue({
    ok: fetchResponse.ok,
    status: fetchResponse.status ?? (fetchResponse.ok ? 200 : 500),
    json: vi.fn().mockResolvedValue(fetchResponse.json ?? {}),
    text: vi.fn().mockResolvedValue(''),
  })

  const skill = new DailyConnectionsSkill({
    db: db as unknown as import('@open-brain/shared').Database,
    promptsDir: opts.promptsDir ?? REPO_PROMPTS_DIR,
    coreApiUrl: 'http://localhost:3000',
    pushover,
  })

  // Replace internal litellmClient
  // @ts-ignore — accessing private field for testing
  skill.litellmClient = mockLitellm

  // Replace global fetch
  vi.stubGlobal('fetch', mockFetch)

  return { skill, db, mockLitellm, pushover, mockFetch }
}

// ============================================================
// Tests: parseOutput
// ============================================================

describe('parseOutput', () => {
  it('parses valid JSON into DailyConnectionsOutput', () => {
    const raw = JSON.stringify(SAMPLE_CONNECTIONS_OUTPUT)
    const result = parseOutput(raw)
    expect(result.summary).toBe(SAMPLE_CONNECTIONS_OUTPUT.summary)
    expect(result.connections).toHaveLength(2)
    expect(result.connections[0].theme).toBe('Client-Infrastructure Convergence')
    expect(result.connections[0].confidence).toBe('high')
    expect(result.meta_pattern).toBe(SAMPLE_CONNECTIONS_OUTPUT.meta_pattern)
  })

  it('strips markdown code fences before parsing', () => {
    const raw = '```json\n' + JSON.stringify(SAMPLE_CONNECTIONS_OUTPUT) + '\n```'
    const result = parseOutput(raw)
    expect(result.summary).toBe(SAMPLE_CONNECTIONS_OUTPUT.summary)
    expect(result.connections).toHaveLength(2)
  })

  it('strips code fences without language specifier', () => {
    const raw = '```\n' + JSON.stringify(SAMPLE_CONNECTIONS_OUTPUT) + '\n```'
    const result = parseOutput(raw)
    expect(result.summary).toBe(SAMPLE_CONNECTIONS_OUTPUT.summary)
  })

  it('returns fallback for completely invalid JSON', () => {
    const raw = 'This is not JSON at all, sorry.'
    const result = parseOutput(raw)
    expect(result.summary).toBe('This is not JSON at all, sorry.')
    expect(result.connections).toEqual([])
    expect(result.meta_pattern).toBeNull()
  })

  it('truncates raw text to 150 chars for fallback summary', () => {
    const raw = 'A'.repeat(300)
    const result = parseOutput(raw)
    expect(result.summary).toHaveLength(150)
  })

  it('handles missing summary field gracefully', () => {
    const raw = JSON.stringify({ connections: [], meta_pattern: null })
    const result = parseOutput(raw)
    expect(result.summary).toBe('(no summary)')
  })

  it('handles missing connections array gracefully', () => {
    const raw = JSON.stringify({ summary: 'Test', meta_pattern: null })
    const result = parseOutput(raw)
    expect(result.connections).toEqual([])
  })

  it('handles missing meta_pattern gracefully', () => {
    const raw = JSON.stringify({ summary: 'Test', connections: [] })
    const result = parseOutput(raw)
    expect(result.meta_pattern).toBeNull()
  })

  it('provides defaults for malformed connection items', () => {
    const raw = JSON.stringify({
      summary: 'Test',
      connections: [
        { theme: 42, captures: 'not-array', insight: null, confidence: 'bogus', domains: 'nope' },
      ],
      meta_pattern: null,
    })
    const result = parseOutput(raw)
    expect(result.connections).toHaveLength(1)
    expect(result.connections[0].theme).toBe('(unnamed)')
    expect(result.connections[0].captures).toEqual([])
    expect(result.connections[0].insight).toBe('')
    expect(result.connections[0].confidence).toBe('low')
    expect(result.connections[0].domains).toEqual([])
  })

  it('filters non-string items from captures and domains arrays', () => {
    const raw = JSON.stringify({
      summary: 'Test',
      connections: [
        { theme: 'T', captures: ['cap-1', 42, null, 'cap-2'], insight: 'I', confidence: 'high', domains: ['a', 123, 'b'] },
      ],
      meta_pattern: null,
    })
    const result = parseOutput(raw)
    expect(result.connections[0].captures).toEqual(['cap-1', 'cap-2'])
    expect(result.connections[0].domains).toEqual(['a', 'b'])
  })

  it('handles empty string input', () => {
    const result = parseOutput('')
    expect(result.connections).toEqual([])
  })
})

// ============================================================
// Tests: query module — fmtDate
// ============================================================

describe('fmtDate', () => {
  it('formats a Date as YYYY-MM-DD', () => {
    expect(fmtDate(new Date('2026-03-10T14:30:00Z'))).toBe('2026-03-10')
  })

  it('handles year boundaries', () => {
    expect(fmtDate(new Date('2025-12-31T23:59:59Z'))).toBe('2025-12-31')
  })
})

// ============================================================
// Tests: query module — formatCapture
// ============================================================

describe('formatCapture', () => {
  it('formats a capture with date, type, and content', () => {
    const c = makeCapture({ capture_type: 'win', content: 'Shipped feature X' })
    const result = formatCapture(c)
    expect(result).toContain('[2026-03-01]')
    expect(result).toContain('[win]')
    expect(result).toContain('Shipped feature X')
  })

  it('includes tags when present', () => {
    const c = makeCapture({ tags: ['alpha', 'beta'] })
    const result = formatCapture(c)
    expect(result).toContain('[alpha, beta]')
  })

  it('omits tag brackets when tags are empty', () => {
    const c = makeCapture({ tags: [] })
    const result = formatCapture(c)
    expect(result).not.toContain('[]')
  })

  it('ends with a newline', () => {
    const result = formatCapture(makeCapture())
    expect(result.endsWith('\n')).toBe(true)
  })
})

// ============================================================
// Tests: query module — formatCoOccurrence
// ============================================================

describe('formatCoOccurrence', () => {
  it('formats entity pairs as plain text', () => {
    const result = formatCoOccurrence(SAMPLE_CO_OCCURRENCE)
    expect(result).toContain('QSR Corp (organization) + NovaBurger (organization): 5 co-occurrences')
    expect(result).toContain('Troy (person) + Open Brain (project): 3 co-occurrences')
  })

  it('returns placeholder text for empty pairs', () => {
    const result = formatCoOccurrence([])
    expect(result).toBe('(no entity co-occurrence data available)')
  })
})

// ============================================================
// Tests: query module — assembleContext
// ============================================================

describe('assembleContext', () => {
  const MULTI_VIEW_CAPTURES: CaptureRecord[] = [
    makeCapture({ id: 'c1', brain_view: 'career', content: 'Career capture', captured_at: new Date('2026-03-05'), content_hash: 'h1' }),
    makeCapture({ id: 'c2', brain_view: 'career', content: 'Another career capture', captured_at: new Date('2026-03-04'), content_hash: 'h2' }),
    makeCapture({ id: 'c3', brain_view: 'client', content: 'Client work capture', captured_at: new Date('2026-03-05'), content_hash: 'h3' }),
    makeCapture({ id: 'c4', brain_view: 'technical', content: 'Technical capture', captured_at: new Date('2026-03-03'), content_hash: 'h4' }),
    makeCapture({ id: 'c5', brain_view: 'personal', content: 'Personal note', captured_at: new Date('2026-03-02'), content_hash: 'h5' }),
    makeCapture({ id: 'c6', brain_view: 'custom-view' as any, content: 'Custom view capture', captured_at: new Date('2026-03-01'), content_hash: 'h6' }),
  ]

  it('groups captures by brain_view with section headers', () => {
    const { contextText } = assembleContext(MULTI_VIEW_CAPTURES, 100_000)
    expect(contextText).toContain('=== CAREER')
    expect(contextText).toContain('=== CLIENT')
    expect(contextText).toContain('=== TECHNICAL')
    expect(contextText).toContain('=== PERSONAL')
  })

  it('follows VIEW_ORDER for configured views', () => {
    const { contextText } = assembleContext(MULTI_VIEW_CAPTURES, 100_000)
    const careerIdx = contextText.indexOf('=== CAREER')
    const clientIdx = contextText.indexOf('=== CLIENT')
    const technicalIdx = contextText.indexOf('=== TECHNICAL')
    const personalIdx = contextText.indexOf('=== PERSONAL')

    expect(careerIdx).toBeLessThan(clientIdx)
    expect(clientIdx).toBeLessThan(technicalIdx)
    expect(technicalIdx).toBeLessThan(personalIdx)
  })

  it('places unknown views after configured views', () => {
    const { contextText } = assembleContext(MULTI_VIEW_CAPTURES, 100_000)
    const personalIdx = contextText.indexOf('=== PERSONAL')
    const customIdx = contextText.indexOf('=== CUSTOM-VIEW')
    expect(personalIdx).toBeLessThan(customIdx)
  })

  it('returns capturesByView with correct counts', () => {
    const { capturesByView } = assembleContext(MULTI_VIEW_CAPTURES, 100_000)
    expect(capturesByView['career']).toBe(2)
    expect(capturesByView['client']).toBe(1)
    expect(capturesByView['technical']).toBe(1)
    expect(capturesByView['personal']).toBe(1)
    expect(capturesByView['custom-view']).toBe(1)
  })

  it('includes capture count in section header', () => {
    const { contextText } = assembleContext(MULTI_VIEW_CAPTURES, 100_000)
    expect(contextText).toContain('=== CAREER (2 captures) ===')
    expect(contextText).toContain('=== CLIENT (1 captures) ===')
  })

  it('truncates when maxChars is exceeded', () => {
    const largeCaps = Array.from({ length: 50 }, (_, i) =>
      makeCapture({ id: `c-${i}`, brain_view: 'technical', content: 'x'.repeat(200), content_hash: `h-${i}` }),
    )
    const { contextText } = assembleContext(largeCaps, 500)
    const matches = contextText.match(/\[observation\]/g)
    expect(matches).toBeTruthy()
    expect(matches!.length).toBeLessThan(50)
  })

  it('returns empty contextText for empty captures', () => {
    const { contextText, capturesByView } = assembleContext([], 100_000)
    expect(contextText).toBe('')
    expect(Object.keys(capturesByView)).toHaveLength(0)
  })

  it('handles captures with null brain_view as "unknown"', () => {
    const cap = makeCapture({ brain_view: undefined as any })
    const { contextText } = assembleContext([cap], 100_000)
    expect(contextText).toContain('=== UNKNOWN')
  })
})

// ============================================================
// Tests: query module — queryRecentCaptures
// ============================================================

describe('queryRecentCaptures', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('calls db.execute and returns rows', async () => {
    const mockDb = { execute: vi.fn().mockResolvedValue({ rows: SAMPLE_CAPTURES }) }
    const result = await queryRecentCaptures(mockDb as any, 7)
    expect(mockDb.execute).toHaveBeenCalledOnce()
    expect(result).toEqual(SAMPLE_CAPTURES)
  })

  it('returns empty array when no captures found', async () => {
    const mockDb = { execute: vi.fn().mockResolvedValue({ rows: [] }) }
    const result = await queryRecentCaptures(mockDb as any, 7)
    expect(result).toEqual([])
  })
})

// ============================================================
// Tests: query module — buildEntityCoOccurrence
// ============================================================

describe('buildEntityCoOccurrence', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('calls db.execute and returns entity co-occurrence rows', async () => {
    const mockDb = { execute: vi.fn().mockResolvedValue({ rows: SAMPLE_CO_OCCURRENCE }) }
    const result = await buildEntityCoOccurrence(mockDb as any, ['cap-1', 'cap-2'])
    expect(mockDb.execute).toHaveBeenCalledOnce()
    expect(result).toEqual(SAMPLE_CO_OCCURRENCE)
  })

  it('returns empty array when captureIds is empty', async () => {
    const mockDb = { execute: vi.fn() }
    const result = await buildEntityCoOccurrence(mockDb as any, [])
    expect(result).toEqual([])
    expect(mockDb.execute).not.toHaveBeenCalled()
  })

  it('returns empty array on db error', async () => {
    const mockDb = { execute: vi.fn().mockRejectedValue(new Error('relation does not exist')) }
    const result = await buildEntityCoOccurrence(mockDb as any, ['cap-1'])
    expect(result).toEqual([])
  })

  it('respects topN parameter', async () => {
    const manyPairs = Array.from({ length: 20 }, (_, i) => ({
      entity_a_name: `EntityA-${i}`,
      entity_a_type: 'organization',
      entity_b_name: `EntityB-${i}`,
      entity_b_type: 'person',
      co_occurrence_count: 20 - i,
    }))
    const mockDb = { execute: vi.fn().mockResolvedValue({ rows: manyPairs.slice(0, 5) }) }
    const result = await buildEntityCoOccurrence(mockDb as any, ['cap-1'], 5)
    expect(result).toHaveLength(5)
  })
})

// ============================================================
// Tests: query module — constants
// ============================================================

describe('constants', () => {
  it('VIEW_ORDER contains all 5 brain views', () => {
    expect(VIEW_ORDER).toEqual(['career', 'work-internal', 'client', 'technical', 'personal'])
  })

  it('CHARS_PER_TOKEN is 4', () => {
    expect(CHARS_PER_TOKEN).toBe(4)
  })

  it('DEFAULT_TOKEN_BUDGET is 30_000', () => {
    expect(DEFAULT_TOKEN_BUDGET).toBe(30_000)
  })
})

// ============================================================
// Tests: DailyConnectionsSkill — execute happy path
// ============================================================

describe('DailyConnectionsSkill', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  describe('execute — happy path', () => {
    it('returns a DailyConnectionsResult with correct captureCount', async () => {
      const { skill } = makeSkill()
      const result = await skill.execute()

      expect(result.captureCount).toBe(SAMPLE_CAPTURES.length)
      expect(result.output.summary).toBe(SAMPLE_CONNECTIONS_OUTPUT.summary)
      expect(result.output.connections).toHaveLength(2)
      expect(result.durationMs).toBeGreaterThan(0)
    })

    it('returns savedCaptureId from Core API response', async () => {
      const { skill } = makeSkill()
      const result = await skill.execute()
      expect(result.savedCaptureId).toBe('saved-cap-id')
    })

    it('sends Pushover notification with top 3 connections', async () => {
      const { skill, pushover } = makeSkill()
      await skill.execute()

      expect(pushover.send).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Daily Connections',
          priority: 0,
        }),
      )
      // Verify message contains summary and connection themes
      const sendCall = (pushover.send as MockInstance).mock.calls[0][0]
      expect(sendCall.message).toContain(SAMPLE_CONNECTIONS_OUTPUT.summary)
      expect(sendCall.message).toContain('Client-Infrastructure Convergence')
    })

    it('saves connections back to brain via Core API POST', async () => {
      const { skill, mockFetch } = makeSkill()
      await skill.execute()

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3000/api/v1/captures',
        expect.objectContaining({ method: 'POST' }),
      )

      // Verify capture body
      const fetchBody = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(fetchBody.capture_type).toBe('reflection')
      expect(fetchBody.brain_view).toBe('personal')
      expect(fetchBody.tags).toEqual(['connections', 'skill-output'])
      expect(fetchBody.metadata.source_metadata.generator).toBe('daily-connections-skill')
    })

    it('writes a skills_log entry', async () => {
      const { skill, db } = makeSkill()
      await skill.execute()

      const insertSpy = db.insert as MockInstance
      expect(insertSpy).toHaveBeenCalled()
      const valuesSpy = insertSpy.mock.results[0].value.values as MockInstance
      const logEntry = valuesSpy.mock.calls[0][0]
      expect(logEntry.skill_name).toBe('daily-connections')
      expect(logEntry.input_summary).toContain('3 captures')
      expect(logEntry.output_summary).toContain('summary:')
      expect(logEntry.result).toBeDefined()
    })

    it('calls LLM with daily_connections_v1 template variables substituted', async () => {
      const { skill, mockLitellm } = makeSkill()
      await skill.execute()

      const createSpy = mockLitellm.chat.completions.create as MockInstance
      const callArgs = createSpy.mock.calls[0][0]
      const prompt: string = callArgs.messages[0].content

      // Template vars should be substituted
      expect(prompt).not.toContain('{{date_range}}')
      expect(prompt).not.toContain('{{capture_count}}')
      expect(prompt).not.toContain('{{captures}}')
      expect(prompt).not.toContain('{{entity_cooccurrence}}')

      // Should contain actual content
      expect(prompt).toContain('3')
      expect(prompt).toContain('NovaBurger')
    })

    it('respects custom windowDays and tokenBudget options', async () => {
      const { skill, db } = makeSkill()
      await skill.execute({ windowDays: 14, tokenBudget: 10_000 })

      // db.execute called at least once for captures query
      expect(db.execute).toHaveBeenCalled()
    })

    it('uses the provided modelAlias in LLM call', async () => {
      const { skill, mockLitellm } = makeSkill()
      await skill.execute({ modelAlias: 'custom-model' })

      const createSpy = mockLitellm.chat.completions.create as MockInstance
      const callArgs = createSpy.mock.calls[0][0]
      expect(callArgs.model).toBe('custom-model')
    })
  })

  // ----------------------------------------------------------
  // Empty captures
  // ----------------------------------------------------------

  describe('execute — no captures in window', () => {
    it('returns empty output and skips LLM call', async () => {
      const { skill, mockLitellm } = makeSkill({ captures: [] })
      const result = await skill.execute()

      expect(result.captureCount).toBe(0)
      expect(result.output.summary).toBe('')
      expect(result.output.connections).toEqual([])
      expect(result.output.meta_pattern).toBeNull()
      expect(result.savedCaptureId).toBeNull()
      expect(mockLitellm.chat.completions.create).not.toHaveBeenCalled()
    })

    it('still writes a skills_log entry when no captures found', async () => {
      const { skill, db } = makeSkill({ captures: [] })
      await skill.execute()

      expect(db.insert).toHaveBeenCalled()
      const valuesSpy = (db.insert as MockInstance).mock.results[0].value.values as MockInstance
      const logEntry = valuesSpy.mock.calls[0][0]
      expect(logEntry.output_summary).toContain('Skipped')
    })
  })

  // ----------------------------------------------------------
  // Single capture
  // ----------------------------------------------------------

  describe('execute — single capture', () => {
    it('processes a single capture without error', async () => {
      const singleCapture = [makeCapture({ id: 'cap-solo', content: 'Only one capture here' })]
      const { skill } = makeSkill({ captures: singleCapture })
      const result = await skill.execute()

      expect(result.captureCount).toBe(1)
      expect(result.output).toBeDefined()
    })
  })

  // ----------------------------------------------------------
  // Delivery failures (non-fatal)
  // ----------------------------------------------------------

  describe('delivery — non-fatal failures', () => {
    it('continues if Pushover delivery fails', async () => {
      const { skill, pushover } = makeSkill()
      vi.spyOn(pushover, 'send').mockRejectedValue(new Error('Pushover API down'))

      const result = await skill.execute()
      expect(result.output.summary).toBe(SAMPLE_CONNECTIONS_OUTPUT.summary)
    })

    it('continues if Core API save-back fails', async () => {
      const { skill } = makeSkill({ coreApiResponse: { ok: false, status: 500 } })

      const result = await skill.execute()
      expect(result.output.summary).toBe(SAMPLE_CONNECTIONS_OUTPUT.summary)
      expect(result.savedCaptureId).toBeNull()
    })

    it('continues if skills_log insert fails', async () => {
      const { skill, db } = makeSkill()
      ;(db.insert as MockInstance).mockReturnValue({
        values: vi.fn().mockRejectedValue(new Error('DB write failed')),
      })

      const result = await skill.execute()
      expect(result.captureCount).toBe(SAMPLE_CAPTURES.length)
    })
  })

  // ----------------------------------------------------------
  // Notification configuration
  // ----------------------------------------------------------

  describe('notification configuration', () => {
    it('skips Pushover if not configured', async () => {
      const { skill, pushover } = makeSkill({ pushoverConfigured: false })
      await skill.execute()
      expect(pushover.send).not.toHaveBeenCalled()
    })

    it('skips Pushover if no connections found', async () => {
      const emptyOutput: DailyConnectionsOutput = { summary: 'Nothing found', connections: [], meta_pattern: null }
      const { skill, pushover } = makeSkill({ connectionsOutput: emptyOutput })
      await skill.execute()
      expect(pushover.send).not.toHaveBeenCalled()
    })
  })

  // ----------------------------------------------------------
  // LLM timeout
  // ----------------------------------------------------------

  describe('execute — LLM timeout', () => {
    it('propagates LLM timeout error', async () => {
      const { skill, mockLitellm } = makeSkill()
      ;(mockLitellm.chat.completions.create as MockInstance).mockRejectedValue(new Error('Request timed out'))

      await expect(skill.execute()).rejects.toThrow('Request timed out')
    })
  })
})

// ============================================================
// Tests: executeDailyConnections top-level function
// ============================================================

describe('executeDailyConnections', () => {
  it('is exported and callable (delegates to DailyConnectionsSkill)', async () => {
    const { executeDailyConnections } = await import('../skills/daily-connections.js')
    expect(typeof executeDailyConnections).toBe('function')
  })
})
