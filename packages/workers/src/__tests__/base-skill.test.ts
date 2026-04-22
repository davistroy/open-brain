import { describe, it, expect, vi, beforeEach } from 'vitest'
import { BaseSkill } from '../skills/base-skill.js'
import { LLMSkill } from '../skills/llm-skill.js'
import { PushoverService } from '../services/pushover.js'
import type { BaseResult, BaseSkillOpts, LLMSkillOpts } from '../skills/types.js'

// ============================================================
// Concrete test subclasses
// ============================================================

interface TestInput {
  value: string
}

interface TestResult extends BaseResult {
  output: string
}

class ConcreteSkill extends BaseSkill<TestInput, TestResult> {
  constructor(opts: BaseSkillOpts) {
    super('test-skill', opts)
  }

  protected async run(input: TestInput): Promise<TestResult> {
    const startMs = Date.now()
    const output = `processed: ${input.value}`
    const durationMs = Date.now() - startMs

    await this.logResult(
      { output, durationMs },
      `value:${input.value}`,
      `output:${output}`,
    )

    return { output, durationMs }
  }

  // Expose protected methods for testing
  async testLogResult(
    result: TestResult,
    inputSummary: string,
    outputSummary?: string,
    captureId?: string,
  ): Promise<string> {
    return this.logResult(result, inputSummary, outputSummary, captureId)
  }

  async testSendNotification(
    title: string,
    message: string,
    priority?: number,
  ): Promise<boolean> {
    return this.sendNotification(title, message, priority)
  }

  testFormatDuration(ms: number): string {
    return this.formatDuration(ms)
  }

  testTruncate(text: string, max?: number): string {
    return this.truncate(text, max)
  }
}

class ConcreteLLMSkill extends LLMSkill<TestInput, TestResult> {
  constructor(opts: LLMSkillOpts) {
    super('test-llm-skill', opts)
  }

  protected async run(input: TestInput): Promise<TestResult> {
    const startMs = Date.now()
    const template = this.renderTemplate('test.txt', { value: input.value })
    const durationMs = Date.now() - startMs
    return { output: template, durationMs }
  }

  // Expose for testing
  getLitellmClient() { return this.litellmClient }
  getAnthropicClient() { return this.anthropicClient }
  getLlmGateway() { return this.llmGateway }
  getTemplates() { return this.templates }
  getCoreApiUrl() { return this.coreApiUrl }
}

// ============================================================
// Mock helpers
// ============================================================

function makeMockDb(opts: { insertError?: boolean } = {}) {
  const returningMock = opts.insertError
    ? vi.fn().mockRejectedValue(new Error('Insert failed'))
    : vi.fn().mockResolvedValue([{ id: 'mock-skills-log-id' }])

  const valuesMock = vi.fn().mockReturnValue({ returning: returningMock })

  return {
    execute: vi.fn().mockResolvedValue({ rows: [] }),
    insert: vi.fn().mockReturnValue({
      values: valuesMock,
    }),
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
  insertError?: boolean
  pushoverConfigured?: boolean
} = {}) {
  const db = makeMockDb(opts)
  const pushover = makePushoverService(opts.pushoverConfigured ?? true)

  const skill = new ConcreteSkill({
    db: db as unknown as import('@open-brain/shared').Database,
    pushover,
  })

  return { skill, db, pushover }
}

// ============================================================
// Tests: BaseSkill
// ============================================================

describe('BaseSkill', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  // ----------------------------------------------------------
  // abstract execute() must be implemented
  // ----------------------------------------------------------

  it('abstract execute() must be implemented by subclass', async () => {
    const { skill } = makeSkill()
    const result = await skill.execute({ value: 'hello' })

    expect(result.output).toBe('processed: hello')
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  // ----------------------------------------------------------
  // logResult() — writes to skills_log
  // ----------------------------------------------------------

  describe('logResult()', () => {
    it('writes to skills_log with correct fields and returns inserted id', async () => {
      const { skill, db } = makeSkill()
      const result: TestResult = { output: 'test', durationMs: 42 }

      const id = await skill.testLogResult(result, 'input:test', 'output:test', 'capture-123')

      expect(id).toBe('mock-skills-log-id')
      expect(db.insert).toHaveBeenCalledOnce()
      const insertChain = db.insert.mock.results[0].value
      expect(insertChain.values).toHaveBeenCalledOnce()

      const logEntry = insertChain.values.mock.calls[0][0]
      expect(logEntry.skill_name).toBe('test-skill')
      expect(logEntry.capture_id).toBe('capture-123')
      expect(logEntry.input_summary).toBe('input:test')
      expect(logEntry.output_summary).toBe('output:test')
      expect(logEntry.duration_ms).toBe(42)
      expect(logEntry.result).toEqual({ output: 'test', durationMs: 42 })
    })

    it('sets capture_id to null when not provided', async () => {
      const { skill, db } = makeSkill()
      const result: TestResult = { output: 'test', durationMs: 10 }

      await skill.testLogResult(result, 'input:test')

      const insertChain = db.insert.mock.results[0].value
      const logEntry = insertChain.values.mock.calls[0][0]
      expect(logEntry.capture_id).toBeNull()
      expect(logEntry.output_summary).toBeNull()
    })

    it('does not throw when insert fails and returns empty string', async () => {
      const { skill } = makeSkill({ insertError: true })
      const result: TestResult = { output: 'test', durationMs: 10 }

      // Should not throw; returns '' on failure
      await expect(
        skill.testLogResult(result, 'input:test', 'output:test'),
      ).resolves.toBe('')
    })
  })

  // ----------------------------------------------------------
  // sendNotification() — Pushover with error handling
  // ----------------------------------------------------------

  describe('sendNotification()', () => {
    it('sends via Pushover and returns true', async () => {
      const { skill, pushover } = makeSkill()

      const sent = await skill.testSendNotification('Title', 'Message', 0)

      expect(sent).toBe(true)
      expect(pushover.send).toHaveBeenCalledOnce()
      expect(pushover.send).toHaveBeenCalledWith({
        title: 'Title',
        message: 'Message',
        priority: 0,
      })
    })

    it('returns false when Pushover is not configured', async () => {
      const { skill, pushover } = makeSkill({ pushoverConfigured: false })

      const sent = await skill.testSendNotification('Title', 'Message')

      expect(sent).toBe(false)
      expect(pushover.send).not.toHaveBeenCalled()
    })

    it('returns false and does not throw when Pushover send fails', async () => {
      const { skill, pushover } = makeSkill()
      vi.mocked(pushover.send).mockRejectedValueOnce(new Error('Pushover API 500'))

      const sent = await skill.testSendNotification('Title', 'Message')

      expect(sent).toBe(false)
    })

    it('defaults priority to 0 when not provided', async () => {
      const { skill, pushover } = makeSkill()

      await skill.testSendNotification('Title', 'Message')

      expect(pushover.send).toHaveBeenCalledWith({
        title: 'Title',
        message: 'Message',
        priority: 0,
      })
    })
  })

  // ----------------------------------------------------------
  // formatDuration()
  // ----------------------------------------------------------

  describe('formatDuration()', () => {
    it('formats sub-second durations in milliseconds', () => {
      const { skill } = makeSkill()

      expect(skill.testFormatDuration(0)).toBe('0ms')
      expect(skill.testFormatDuration(42)).toBe('42ms')
      expect(skill.testFormatDuration(999)).toBe('999ms')
    })

    it('formats durations >= 1 second in seconds', () => {
      const { skill } = makeSkill()

      expect(skill.testFormatDuration(1000)).toBe('1.0s')
      expect(skill.testFormatDuration(1500)).toBe('1.5s')
      expect(skill.testFormatDuration(3200)).toBe('3.2s')
      expect(skill.testFormatDuration(60000)).toBe('60.0s')
    })
  })

  // ----------------------------------------------------------
  // truncate()
  // ----------------------------------------------------------

  describe('truncate()', () => {
    it('returns text unchanged when within max length', () => {
      const { skill } = makeSkill()

      expect(skill.testTruncate('short text')).toBe('short text')
      expect(skill.testTruncate('x'.repeat(100))).toBe('x'.repeat(100))
    })

    it('truncates and appends "..." when text exceeds max', () => {
      const { skill } = makeSkill()

      const result = skill.testTruncate('x'.repeat(150))
      expect(result).toBe('x'.repeat(100) + '...')
      expect(result.length).toBe(103)
    })

    it('respects custom max length', () => {
      const { skill } = makeSkill()

      expect(skill.testTruncate('abcdef', 3)).toBe('abc...')
      expect(skill.testTruncate('ab', 3)).toBe('ab')
      expect(skill.testTruncate('abc', 3)).toBe('abc')
    })

    it('trims whitespace before measuring', () => {
      const { skill } = makeSkill()

      expect(skill.testTruncate('  short  ')).toBe('short')
      expect(skill.testTruncate('  ' + 'x'.repeat(150) + '  ', 10)).toBe('x'.repeat(10) + '...')
    })
  })
})

// ============================================================
// Tests: LLMSkill
// ============================================================

describe('LLMSkill', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('extends BaseSkill correctly', () => {
    const db = makeMockDb()
    const pushover = makePushoverService()
    const skill = new ConcreteLLMSkill({
      db: db as unknown as import('@open-brain/shared').Database,
      pushover,
    })

    // LLMSkill is an instance of BaseSkill
    expect(skill).toBeInstanceOf(BaseSkill)
  })

  it('initializes litellmClient as null when no API key available', () => {
    const db = makeMockDb()
    const pushover = makePushoverService()

    // Clear OPENAI_API_KEY to ensure createOpenAIClient returns null
    const origOpenAI = process.env.OPENAI_API_KEY
    delete process.env.OPENAI_API_KEY

    const skill = new ConcreteLLMSkill({
      db: db as unknown as import('@open-brain/shared').Database,
      pushover,
    })

    expect(skill.getLitellmClient()).toBeNull()

    if (origOpenAI !== undefined) process.env.OPENAI_API_KEY = origOpenAI
  })

  it('accepts pre-constructed litellmClient', () => {
    const db = makeMockDb()
    const pushover = makePushoverService()
    const mockClient = { chat: { completions: { create: vi.fn() } } } as unknown as import('openai').default

    const skill = new ConcreteLLMSkill({
      db: db as unknown as import('@open-brain/shared').Database,
      pushover,
      litellmClient: mockClient,
    })

    expect(skill.getLitellmClient()).toBe(mockClient)
  })

  it('stores anthropicClient and llmGateway when provided', () => {
    const db = makeMockDb()
    const pushover = makePushoverService()
    const mockAnthropic = {} as import('@anthropic-ai/sdk').default
    const mockGateway = {} as import('@open-brain/shared').LLMGatewayService

    const skill = new ConcreteLLMSkill({
      db: db as unknown as import('@open-brain/shared').Database,
      pushover,
      anthropicClient: mockAnthropic,
      llmGateway: mockGateway,
    })

    expect(skill.getAnthropicClient()).toBe(mockAnthropic)
    expect(skill.getLlmGateway()).toBe(mockGateway)
  })

  it('defaults coreApiUrl to env var or localhost', () => {
    const db = makeMockDb()
    const pushover = makePushoverService()

    const origUrl = process.env.OPEN_BRAIN_API_URL
    delete process.env.OPEN_BRAIN_API_URL

    const skill = new ConcreteLLMSkill({
      db: db as unknown as import('@open-brain/shared').Database,
      pushover,
    })

    expect(skill.getCoreApiUrl()).toBe('http://localhost:3000')

    if (origUrl !== undefined) process.env.OPEN_BRAIN_API_URL = origUrl
  })

  it('uses provided coreApiUrl over env var', () => {
    const db = makeMockDb()
    const pushover = makePushoverService()

    const skill = new ConcreteLLMSkill({
      db: db as unknown as import('@open-brain/shared').Database,
      pushover,
      coreApiUrl: 'http://custom:9000',
    })

    expect(skill.getCoreApiUrl()).toBe('http://custom:9000')
  })
})
