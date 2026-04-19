import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest'
import { join } from 'node:path'
import {
  DailySweepSkill,
  parseOutput,
  assembleContext,
  fmtDate,
  formatVoiceStatsLine,
  queryTodayCaptures,
  queryUnresolvedQuestions,
  queryNewEntities,
  queryVoiceStats,
} from '../skills/daily-sweep-skill.js'
import type { DailySweepOutput, VoiceStats } from '../skills/daily-sweep-skill.js'
import { PushoverService } from '../services/pushover.js'

// Prompt templates live at <repo-root>/config/prompts/
const REPO_PROMPTS_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'config', 'prompts')

// ============================================================
// Fixtures
// ============================================================

const SAMPLE_CAPTURES = [
  {
    id: 'cap-1',
    content: 'Decided to switch to OpenAI embeddings for better quality.',
    capture_type: 'decision',
    brain_view: 'technical',
    source: 'api',
    tags: ['open-brain', 'embeddings'],
    created_at: '2026-04-02',
  },
  {
    id: 'cap-2',
    content: 'Why is the voice pipeline latency so high on the watch?',
    capture_type: 'question',
    brain_view: 'technical',
    source: 'voice',
    tags: ['voice'],
    created_at: '2026-04-02',
  },
  {
    id: 'cap-3',
    content: 'Closed the NovaBurger retainer — $8K/month starting April.',
    capture_type: 'win',
    brain_view: 'client',
    source: 'slack',
    tags: ['stratfield', 'revenue'],
    created_at: '2026-04-02',
  },
]

const SAMPLE_QUESTIONS = [
  {
    id: 'q-1',
    content: 'Should we move to a dedicated embedding service?',
    brain_view: 'technical',
    created_at: '2026-03-28',
    tags: ['architecture'],
  },
  {
    id: 'q-2',
    content: 'What is the ideal ACT-R temporal weight for warm start?',
    brain_view: 'technical',
    created_at: '2026-03-25',
    tags: null,
  },
]

const SAMPLE_ENTITIES = [
  { name: 'NovaBurger', entity_type: 'organization' },
  { name: 'OpenAI Embeddings', entity_type: 'technology' },
]

const SAMPLE_OUTPUT: DailySweepOutput = {
  headline: 'Embedding migration decided + NovaBurger retainer closed',
  key_decisions: ['Switch to OpenAI text-embedding-3-large for all vectors'],
  unresolved_questions: ['Voice pipeline watch latency root cause unknown', 'Dedicated embedding service decision pending'],
  new_entities: ['NovaBurger — new QSR client retainer', 'OpenAI Embeddings — vector provider'],
  tasks_without_followup: [],
  notable_captures: ['NovaBurger retainer closes $8K/month recurring revenue'],
}

// ============================================================
// Mock helpers
// ============================================================

const DEFAULT_VOICE_STATS_ROW = { count: '3', last_voice: '2026-04-01T14:00:00Z' }

function makeMockDb(
  captures = SAMPLE_CAPTURES,
  questions = SAMPLE_QUESTIONS,
  entities = SAMPLE_ENTITIES,
  voiceStatsRow: { count: string; last_voice: string | null } = DEFAULT_VOICE_STATS_ROW,
) {
  let callCount = 0
  return {
    execute: vi.fn().mockImplementation(() => {
      callCount++
      // Call order: 1=todayCaptures, 2=voiceStats, 3=unresolvedQuestions, 4=newEntities
      if (callCount === 1) return Promise.resolve({ rows: captures })
      if (callCount === 2) return Promise.resolve({ rows: [voiceStatsRow] })
      if (callCount === 3) return Promise.resolve({ rows: questions })
      return Promise.resolve({ rows: entities })
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    }),
  }
}

function makeMockOpenAI(jsonOutput: DailySweepOutput = SAMPLE_OUTPUT) {
  return {
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [{ message: { content: JSON.stringify(jsonOutput) } }],
          usage: { prompt_tokens: 500, completion_tokens: 200, total_tokens: 700 },
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
  captures?: typeof SAMPLE_CAPTURES
  questions?: typeof SAMPLE_QUESTIONS
  entities?: typeof SAMPLE_ENTITIES
  voiceStatsRow?: { count: string; last_voice: string | null }
  sweepOutput?: DailySweepOutput
  pushoverConfigured?: boolean
  promptsDir?: string
  coreApiResponse?: { ok: boolean; json?: object; status?: number }
} = {}) {
  const db = makeMockDb(
    opts.captures ?? SAMPLE_CAPTURES,
    opts.questions ?? SAMPLE_QUESTIONS,
    opts.entities ?? SAMPLE_ENTITIES,
    opts.voiceStatsRow ?? DEFAULT_VOICE_STATS_ROW,
  )
  const mockLitellm = makeMockOpenAI(opts.sweepOutput ?? SAMPLE_OUTPUT)
  const pushover = makePushoverService(opts.pushoverConfigured ?? true)

  const fetchResponse = opts.coreApiResponse ?? { ok: true, json: { id: 'saved-cap-id' } }
  const mockFetch = vi.fn().mockResolvedValue({
    ok: fetchResponse.ok,
    status: fetchResponse.status ?? (fetchResponse.ok ? 200 : 500),
    json: vi.fn().mockResolvedValue(fetchResponse.json ?? {}),
    text: vi.fn().mockResolvedValue(''),
  })

  const skill = new DailySweepSkill({
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
  it('parses valid JSON into DailySweepOutput', () => {
    const raw = JSON.stringify(SAMPLE_OUTPUT)
    const result = parseOutput(raw)
    expect(result.headline).toBe(SAMPLE_OUTPUT.headline)
    expect(result.key_decisions).toHaveLength(1)
    expect(result.unresolved_questions).toHaveLength(2)
    expect(result.new_entities).toHaveLength(2)
    expect(result.tasks_without_followup).toEqual([])
    expect(result.notable_captures).toHaveLength(1)
  })

  it('strips markdown code fences before parsing', () => {
    const raw = '```json\n' + JSON.stringify(SAMPLE_OUTPUT) + '\n```'
    const result = parseOutput(raw)
    expect(result.headline).toBe(SAMPLE_OUTPUT.headline)
    expect(result.key_decisions).toHaveLength(1)
  })

  it('strips code fences without language specifier', () => {
    const raw = '```\n' + JSON.stringify(SAMPLE_OUTPUT) + '\n```'
    const result = parseOutput(raw)
    expect(result.headline).toBe(SAMPLE_OUTPUT.headline)
  })

  it('returns fallback for completely invalid JSON', () => {
    const raw = 'This is not JSON at all, sorry.'
    const result = parseOutput(raw)
    expect(result.headline).toBe('This is not JSON at all, sorry.')
    expect(result.key_decisions).toEqual([])
    expect(result.unresolved_questions).toEqual([])
    expect(result.new_entities).toEqual([])
    expect(result.tasks_without_followup).toEqual([])
    expect(result.notable_captures).toEqual([])
  })

  it('truncates raw text to 120 chars for fallback headline', () => {
    const raw = 'A'.repeat(300)
    const result = parseOutput(raw)
    expect(result.headline).toHaveLength(120)
  })

  it('handles missing headline field gracefully', () => {
    const raw = JSON.stringify({ key_decisions: [], unresolved_questions: [] })
    const result = parseOutput(raw)
    expect(result.headline).toBe('(no headline)')
  })

  it('handles missing array fields gracefully', () => {
    const raw = JSON.stringify({ headline: 'Test' })
    const result = parseOutput(raw)
    expect(result.key_decisions).toEqual([])
    expect(result.unresolved_questions).toEqual([])
    expect(result.new_entities).toEqual([])
    expect(result.tasks_without_followup).toEqual([])
    expect(result.notable_captures).toEqual([])
  })

  it('filters non-string items from arrays', () => {
    const raw = JSON.stringify({
      headline: 'Test',
      key_decisions: ['valid', 42, null, 'also valid'],
      unresolved_questions: [true, 'question'],
      new_entities: [],
      tasks_without_followup: [],
      notable_captures: [],
    })
    const result = parseOutput(raw)
    expect(result.key_decisions).toEqual(['valid', 'also valid'])
    expect(result.unresolved_questions).toEqual(['question'])
  })

  it('limits arrays to 5 items', () => {
    const raw = JSON.stringify({
      headline: 'Test',
      key_decisions: Array.from({ length: 10 }, (_, i) => `Decision ${i}`),
    })
    const result = parseOutput(raw)
    expect(result.key_decisions).toHaveLength(5)
  })

  it('handles empty string input', () => {
    const result = parseOutput('')
    expect(result.key_decisions).toEqual([])
  })
})

// ============================================================
// Tests: fmtDate
// ============================================================

describe('fmtDate', () => {
  it('formats a Date as YYYY-MM-DD', () => {
    expect(fmtDate(new Date('2026-04-02T14:30:00Z'))).toBe('2026-04-02')
  })

  it('handles year boundaries', () => {
    expect(fmtDate(new Date('2025-12-31T23:59:59Z'))).toBe('2025-12-31')
  })
})

// ============================================================
// Tests: formatVoiceStatsLine
// ============================================================

describe('formatVoiceStatsLine', () => {
  it('formats zero voice captures', () => {
    const result = formatVoiceStatsLine({ count: 0, lastVoiceDate: null })
    expect(result).toBe('Voice memos this week: 0')
  })

  it('formats captures with last today', () => {
    const result = formatVoiceStatsLine({ count: 5, lastVoiceDate: new Date() })
    expect(result).toBe('Voice memos this week: 5 (last: today)')
  })

  it('formats captures with last 1 day ago', () => {
    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)
    // Set to same time to ensure we get exactly 1 day
    yesterday.setHours(0, 0, 0, 0)
    const now = new Date()
    now.setHours(23, 59, 59, 0)
    // Use a deterministic approach: construct a date exactly 1.5 days ago
    const oneDayAgo = new Date(Date.now() - 1.5 * 24 * 60 * 60 * 1000)
    const result = formatVoiceStatsLine({ count: 2, lastVoiceDate: oneDayAgo })
    expect(result).toBe('Voice memos this week: 2 (last: 1 day ago)')
  })

  it('formats captures with last multiple days ago', () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
    const result = formatVoiceStatsLine({ count: 1, lastVoiceDate: threeDaysAgo })
    expect(result).toBe('Voice memos this week: 1 (last: 3 days ago)')
  })
})

// ============================================================
// Tests: queryVoiceStats
// ============================================================

describe('queryVoiceStats', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('returns count and lastVoiceDate from query', async () => {
    const mockDb = { execute: vi.fn().mockResolvedValue({ rows: [{ count: '5', last_voice: '2026-04-01T14:00:00Z' }] }) }
    const result = await queryVoiceStats(mockDb as any)
    expect(result.count).toBe(5)
    expect(result.lastVoiceDate).toEqual(new Date('2026-04-01T14:00:00Z'))
  })

  it('returns zero count and null date when no voice captures', async () => {
    const mockDb = { execute: vi.fn().mockResolvedValue({ rows: [{ count: '0', last_voice: null }] }) }
    const result = await queryVoiceStats(mockDb as any)
    expect(result.count).toBe(0)
    expect(result.lastVoiceDate).toBeNull()
  })
})

// ============================================================
// Tests: assembleContext
// ============================================================

describe('assembleContext', () => {
  it('formats captures, questions, and entities within budget', () => {
    const { capturesText, questionsText, entitiesText } = assembleContext(
      SAMPLE_CAPTURES,
      SAMPLE_QUESTIONS,
      SAMPLE_ENTITIES,
      100_000,
    )
    expect(capturesText).toContain('decision')
    expect(capturesText).toContain('Decided to switch')
    expect(questionsText).toContain('dedicated embedding service')
    expect(entitiesText).toContain('NovaBurger')
    expect(entitiesText).toContain('organization')
  })

  it('returns placeholder text when captures are empty', () => {
    const { capturesText } = assembleContext([], SAMPLE_QUESTIONS, SAMPLE_ENTITIES, 100_000)
    expect(capturesText).toBe('(no captures today)\n')
  })

  it('returns placeholder text when questions are empty', () => {
    const { questionsText } = assembleContext(SAMPLE_CAPTURES, [], SAMPLE_ENTITIES, 100_000)
    expect(questionsText).toBe('(no unresolved questions)\n')
  })

  it('returns placeholder text when entities are empty', () => {
    const { entitiesText } = assembleContext(SAMPLE_CAPTURES, SAMPLE_QUESTIONS, [], 100_000)
    expect(entitiesText).toBe('(no new entities today)\n')
  })

  it('truncates captures when budget is exceeded', () => {
    const largeCaptures = Array.from({ length: 50 }, (_, i) => ({
      id: `c-${i}`,
      content: 'x'.repeat(200),
      capture_type: 'observation',
      brain_view: 'technical',
      source: 'api',
      tags: [],
      created_at: '2026-04-02',
    }))
    const { capturesText } = assembleContext(largeCaptures, [], [], 500)
    const lineCount = capturesText.split('\n').filter(l => l.trim()).length
    expect(lineCount).toBeLessThan(50)
  })
})

// ============================================================
// Tests: query functions
// ============================================================

describe('queryTodayCaptures', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('calls db.execute and returns rows', async () => {
    const mockDb = { execute: vi.fn().mockResolvedValue({ rows: SAMPLE_CAPTURES }) }
    const result = await queryTodayCaptures(mockDb as any)
    expect(mockDb.execute).toHaveBeenCalledOnce()
    expect(result).toEqual(SAMPLE_CAPTURES)
  })

  it('returns empty array when no captures found', async () => {
    const mockDb = { execute: vi.fn().mockResolvedValue({ rows: [] }) }
    const result = await queryTodayCaptures(mockDb as any)
    expect(result).toEqual([])
  })
})

describe('queryUnresolvedQuestions', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('calls db.execute and returns rows', async () => {
    const mockDb = { execute: vi.fn().mockResolvedValue({ rows: SAMPLE_QUESTIONS }) }
    const result = await queryUnresolvedQuestions(mockDb as any)
    expect(mockDb.execute).toHaveBeenCalledOnce()
    expect(result).toEqual(SAMPLE_QUESTIONS)
  })
})

describe('queryNewEntities', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('calls db.execute and returns rows', async () => {
    const mockDb = { execute: vi.fn().mockResolvedValue({ rows: SAMPLE_ENTITIES }) }
    const result = await queryNewEntities(mockDb as any)
    expect(mockDb.execute).toHaveBeenCalledOnce()
    expect(result).toEqual(SAMPLE_ENTITIES)
  })
})

// ============================================================
// Tests: DailySweepSkill — execute happy path
// ============================================================

describe('DailySweepSkill', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  describe('execute — happy path', () => {
    it('returns a DailySweepResult with correct captureCount', async () => {
      const { skill } = makeSkill()
      const result = await skill.execute()

      expect(result.captureCount).toBe(SAMPLE_CAPTURES.length)
      expect(result.output.headline).toBe(SAMPLE_OUTPUT.headline)
      expect(result.output.key_decisions).toHaveLength(1)
      expect(result.durationMs).toBeGreaterThanOrEqual(0)
    })

    it('does NOT create a capture by default (storeCapture defaults to false)', async () => {
      const { skill, mockFetch } = makeSkill()
      const result = await skill.execute()
      expect(result.savedCaptureId).toBeNull()
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it('returns savedCaptureId when storeCapture is true', async () => {
      const { skill } = makeSkill()
      const result = await skill.execute({ storeCapture: true })
      expect(result.savedCaptureId).toBe('saved-cap-id')
    })

    it('sends Pushover notification with headline and key items', async () => {
      const { skill, pushover } = makeSkill()
      await skill.execute()

      expect(pushover.send).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Daily Sweep',
          priority: 0,
        }),
      )
      const sendCall = (pushover.send as unknown as MockInstance).mock.calls[0][0]
      expect(sendCall.message).toContain(SAMPLE_OUTPUT.headline)
    })

    it('includes voice stats in Pushover notification', async () => {
      const { skill, pushover } = makeSkill()
      await skill.execute()

      const sendCall = (pushover.send as unknown as MockInstance).mock.calls[0][0]
      expect(sendCall.message).toContain('Voice memos this week: 3')
    })

    it('shows zero voice memos when none in last 7 days', async () => {
      const { skill, pushover } = makeSkill({ voiceStatsRow: { count: '0', last_voice: null } })
      await skill.execute()

      const sendCall = (pushover.send as unknown as MockInstance).mock.calls[0][0]
      expect(sendCall.message).toContain('Voice memos this week: 0')
    })

    it('saves sweep back to brain via Core API POST when storeCapture is true', async () => {
      const { skill, mockFetch } = makeSkill()
      await skill.execute({ storeCapture: true })

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3000/api/v1/captures',
        expect.objectContaining({ method: 'POST' }),
      )

      const fetchBody = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(fetchBody.capture_type).toBe('reflection')
      expect(fetchBody.brain_view).toBe('personal')
      expect(fetchBody.tags).toEqual(['daily-sweep', 'skill-output'])
      expect(fetchBody.metadata.source_metadata.generator).toBe('daily-sweep-skill')
    })

    it('writes a skills_log entry', async () => {
      const { skill, db } = makeSkill()
      await skill.execute()

      const insertSpy = db.insert as MockInstance
      expect(insertSpy).toHaveBeenCalled()
      const valuesSpy = insertSpy.mock.results[0].value.values as MockInstance
      const logEntry = valuesSpy.mock.calls[0][0]
      expect(logEntry.skill_name).toBe('daily-sweep-skill')
      expect(logEntry.input_summary).toContain('3 captures')
      expect(logEntry.output_summary).toContain('headline:')
      expect(logEntry.result).toBeDefined()
    })

    it('calls LLM with daily_sweep_v1 template variables substituted', async () => {
      const { skill, mockLitellm } = makeSkill()
      await skill.execute()

      const createSpy = mockLitellm.chat.completions.create as MockInstance
      const callArgs = createSpy.mock.calls[0][0]
      const prompt: string = callArgs.messages[0].content

      // Template vars should be substituted
      expect(prompt).not.toContain('{{date}}')
      expect(prompt).not.toContain('{{capture_count}}')
      expect(prompt).not.toContain('{{captures}}')
      expect(prompt).not.toContain('{{unresolved_questions}}')
      expect(prompt).not.toContain('{{new_entities}}')

      // Should contain actual content
      expect(prompt).toContain('3')
      expect(prompt).toContain('NovaBurger')
    })

    it('uses max_completion_tokens not max_tokens', async () => {
      const { skill, mockLitellm } = makeSkill()
      await skill.execute()

      const createSpy = mockLitellm.chat.completions.create as MockInstance
      const callArgs = createSpy.mock.calls[0][0]
      expect(callArgs.max_completion_tokens).toBe(2048)
      expect(callArgs.max_tokens).toBeUndefined()
    })
  })

  // ----------------------------------------------------------
  // Empty captures (quiet day)
  // ----------------------------------------------------------

  describe('execute — no captures today', () => {
    it('returns quiet-day output and skips LLM call', async () => {
      const { skill, mockLitellm } = makeSkill({ captures: [] })
      const result = await skill.execute()

      expect(result.captureCount).toBe(0)
      expect(result.output.headline).toBe('Quiet day — no captures')
      expect(result.output.key_decisions).toEqual([])
      expect(result.savedCaptureId).toBeNull()
      expect(mockLitellm.chat.completions.create).not.toHaveBeenCalled()
    })

    it('still writes a skills_log entry when no captures found', async () => {
      const { skill, db } = makeSkill({ captures: [] })
      await skill.execute()

      expect(db.insert).toHaveBeenCalled()
      const valuesSpy = (db.insert as MockInstance).mock.results[0].value.values as MockInstance
      const logEntry = valuesSpy.mock.calls[0][0]
      expect(logEntry.output_summary).toContain('Quiet day')
    })

    it('still sends Pushover notification on quiet day', async () => {
      const { skill, pushover } = makeSkill({ captures: [] })
      await skill.execute()

      expect(pushover.send).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Daily Sweep',
          message: expect.stringContaining('Quiet day'),
        }),
      )
    })

    it('includes voice stats in quiet-day Pushover notification', async () => {
      const { skill, pushover } = makeSkill({ captures: [] })
      await skill.execute()

      const sendCall = (pushover.send as unknown as MockInstance).mock.calls[0][0]
      expect(sendCall.message).toContain('Voice memos this week:')
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
      expect(result.output.headline).toBe(SAMPLE_OUTPUT.headline)
      expect(result.notificationSent).toBe(false)
    })

    it('continues if Core API save-back fails', async () => {
      const { skill } = makeSkill({ coreApiResponse: { ok: false, status: 500 } })

      const result = await skill.execute({ storeCapture: true })
      expect(result.output.headline).toBe(SAMPLE_OUTPUT.headline)
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
// Tests: executeDailySweep top-level function
// ============================================================

describe('executeDailySweep', () => {
  it('is exported and callable (delegates to DailySweepSkill)', async () => {
    const { executeDailySweep } = await import('../skills/daily-sweep-skill.js')
    expect(typeof executeDailySweep).toBe('function')
  })
})
