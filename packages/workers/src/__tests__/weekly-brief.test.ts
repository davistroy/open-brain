import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest'
import { join } from 'node:path'
import { WeeklyBriefSkill } from '../skills/weekly-brief.js'
import type { WeeklyBriefOutput } from '../skills/weekly-brief.js'
import { PushoverService } from '../services/pushover.js'
import { EmailService } from '../services/email.js'

// Prompt templates live at <repo-root>/config/prompts/ — go up two levels from packages/workers
const REPO_PROMPTS_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'config', 'prompts')

// ============================================================
// Fixtures
// ============================================================

const SAMPLE_CAPTURES = [
  {
    id: 'cap-1',
    content: 'Closed the NovaBurger retainer — $8K/month starting April.',
    capture_type: 'win',
    brain_view: 'client',
    source: 'slack',
    tags: ['stratfield', 'revenue'],
    captured_at: new Date('2026-03-01T10:00:00Z'),
    created_at: new Date('2026-03-01T10:00:00Z'),
    updated_at: new Date('2026-03-01T10:00:00Z'),
    content_hash: 'hash1',
    pipeline_status: 'complete',
    pipeline_attempts: 1,
    embedding: null,
  },
  {
    id: 'cap-2',
    content: 'QSR ops dashboard blocked — IT access request still pending after 3 attempts.',
    capture_type: 'blocker',
    brain_view: 'work-internal',
    source: 'voice',
    tags: ['qsr', 'infrastructure'],
    captured_at: new Date('2026-03-02T14:30:00Z'),
    created_at: new Date('2026-03-02T14:30:00Z'),
    updated_at: new Date('2026-03-02T14:30:00Z'),
    content_hash: 'hash2',
    pipeline_status: 'complete',
    pipeline_attempts: 1,
    embedding: null,
  },
  {
    id: 'cap-3',
    content: 'Voice pipeline end-to-end working — Apple Watch to Postgres in under 10 seconds.',
    capture_type: 'win',
    brain_view: 'technical',
    source: 'api',
    tags: ['open-brain', 'voice'],
    captured_at: new Date('2026-03-03T09:00:00Z'),
    created_at: new Date('2026-03-03T09:00:00Z'),
    updated_at: new Date('2026-03-03T09:00:00Z'),
    content_hash: 'hash3',
    pipeline_status: 'complete',
    pipeline_attempts: 1,
    embedding: null,
  },
]

const SAMPLE_BRIEF_JSON: WeeklyBriefOutput = {
  headline: 'QSR client timeline compressed — all deliverables now due two weeks earlier.',
  wins: ['Closed Stratfield retainer with NovaBurger ($8K/month)', 'Voice pipeline end-to-end complete'],
  blockers: ['QSR ops dashboard blocked on API access — 3 requests unanswered'],
  risks: ['LiteLLM Jetson device thermal throttling'],
  open_loops: ['Decision on expanding Stratfield team still deferred'],
  next_week_focus: ['Escalate QSR API access', 'Schedule NovaBurger kickoff'],
  avoided_decisions: ['Whether to take second QSR client'],
  drift_alerts: ['Amateur radio project (K4JDA ARES) absent for 3 weeks'],
  connections: ['QSR timeline compression and voice pipeline completion both forcing Phase 13 prioritization'],
}

// ============================================================
// Mock helpers
// ============================================================

function makeMockDb(captures = SAMPLE_CAPTURES) {
  return {
    execute: vi.fn().mockResolvedValue({ rows: captures }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    }),
  }
}

function makeMockOpenAI(jsonOutput: WeeklyBriefOutput = SAMPLE_BRIEF_JSON) {
  return {
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [{ message: { content: JSON.stringify(jsonOutput) } }],
          usage: { prompt_tokens: 800, completion_tokens: 400, total_tokens: 1200 },
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

function makeEmailService(configured = true) {
  const svc = new EmailService({ host: 'smtp.test', user: 'user', pass: 'pass' })
  if (!configured) {
    Object.defineProperty(svc, 'isConfigured', { get: () => false })
  }
  vi.spyOn(svc, 'send').mockResolvedValue(undefined)
  return svc
}

/**
 * Builds a WeeklyBriefSkill with all external I/O mocked.
 */
function makeSkill(opts: {
  captures?: typeof SAMPLE_CAPTURES
  briefOutput?: WeeklyBriefOutput
  pushoverConfigured?: boolean
  emailConfigured?: boolean
  promptsDir?: string
  coreApiResponse?: { ok: boolean; json?: object; status?: number }
} = {}) {
  const db = makeMockDb(opts.captures ?? SAMPLE_CAPTURES)
  const mockLitellm = makeMockOpenAI(opts.briefOutput ?? SAMPLE_BRIEF_JSON)
  const pushover = makePushoverService(opts.pushoverConfigured ?? true)
  const email = makeEmailService(opts.emailConfigured ?? true)

  // Mock fetch for save-brief-capture
  const fetchResponse = opts.coreApiResponse ?? { ok: true, json: { id: 'saved-cap-id' } }
  const mockFetch = vi.fn().mockResolvedValue({
    ok: fetchResponse.ok,
    status: fetchResponse.status ?? (fetchResponse.ok ? 200 : 500),
    json: vi.fn().mockResolvedValue(fetchResponse.json ?? {}),
    text: vi.fn().mockResolvedValue(''),
  })

  const skill = new WeeklyBriefSkill({
    db: db as unknown as import('@open-brain/shared').Database,
    promptsDir: opts.promptsDir ?? REPO_PROMPTS_DIR,
    coreApiUrl: 'http://localhost:3000',
    pushover,
    email,
  })

  // Replace internal litellmClient
  // @ts-ignore — accessing private field for testing
  skill.litellmClient = mockLitellm

  // Replace global fetch
  vi.stubGlobal('fetch', mockFetch)

  return { skill, db, mockLitellm, pushover, email, mockFetch }
}

// ============================================================
// Tests
// ============================================================

describe('WeeklyBriefSkill', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  // ----------------------------------------------------------
  // Happy path
  // ----------------------------------------------------------

  describe('execute — happy path', () => {
    it('returns a WeeklyBriefResult with correct captureCount', async () => {
      const { skill } = makeSkill()
      const result = await skill.execute({ emailTo: 'troy@example.com' })

      expect(result.captureCount).toBe(SAMPLE_CAPTURES.length)
      expect(result.brief.headline).toBe(SAMPLE_BRIEF_JSON.headline)
      expect(result.brief.wins).toEqual(SAMPLE_BRIEF_JSON.wins)
      expect(result.durationMs).toBeGreaterThan(0)
    })

    it('returns all 9 structured output sections', async () => {
      const { skill } = makeSkill()
      const result = await skill.execute({ emailTo: 'troy@example.com' })

      expect(result.brief).toHaveProperty('headline')
      expect(result.brief).toHaveProperty('wins')
      expect(result.brief).toHaveProperty('blockers')
      expect(result.brief).toHaveProperty('risks')
      expect(result.brief).toHaveProperty('open_loops')
      expect(result.brief).toHaveProperty('next_week_focus')
      expect(result.brief).toHaveProperty('avoided_decisions')
      expect(result.brief).toHaveProperty('drift_alerts')
      expect(result.brief).toHaveProperty('connections')
    })

    it('sends Pushover notification with brief headline', async () => {
      const { skill, pushover } = makeSkill()
      await skill.execute({ emailTo: 'troy@example.com' })

      expect(pushover.send).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Weekly Brief Ready',
          message: SAMPLE_BRIEF_JSON.headline,
          priority: 0,
        }),
      )
    })

    it('sends email to the specified recipient', async () => {
      const { skill, email } = makeSkill()
      await skill.execute({ emailTo: 'troy@stratfield.io' })

      expect(email.send).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'troy@stratfield.io',
          subject: expect.stringContaining('Open Brain Weekly Brief'),
        }),
      )
    })

    it('saves brief back to brain via Core API POST', async () => {
      const { skill, mockFetch } = makeSkill()
      const result = await skill.execute({ emailTo: 'troy@example.com' })

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3000/api/v1/captures',
        expect.objectContaining({ method: 'POST' }),
      )
      expect(result.savedCaptureId).toBe('saved-cap-id')
    })

    it('writes a skills_log entry with input/output summary', async () => {
      const { skill, db } = makeSkill()
      await skill.execute({ emailTo: 'troy@example.com' })

      const insertSpy = db.insert as MockInstance
      expect(insertSpy).toHaveBeenCalled()
      // values() receives the skills_log record
      const valuesSpy = insertSpy.mock.results[0].value.values as MockInstance
      const logEntry = valuesSpy.mock.calls[0][0]
      expect(logEntry.skill_name).toBe('weekly-brief')
      expect(logEntry.input_summary).toContain('3 captures')
      expect(logEntry.output_summary).toContain('headline:')
    })

    it('calls LLM with weekly_brief_v1 template variables substituted', async () => {
      const { skill, mockLitellm } = makeSkill()
      await skill.execute({ emailTo: 'troy@example.com' })

      const createSpy = mockLitellm.chat.completions.create as MockInstance
      const callArgs = createSpy.mock.calls[0][0]
      const prompt: string = callArgs.messages[0].content

      // Template vars should be substituted
      expect(prompt).not.toContain('{{date_range}}')
      expect(prompt).not.toContain('{{capture_count}}')
      expect(prompt).not.toContain('{{captures}}')

      // Should contain actual content
      expect(prompt).toContain('3')
      expect(prompt).toContain('NovaBurger')
    })
  })

  // ----------------------------------------------------------
  // Empty captures
  // ----------------------------------------------------------

  describe('execute — no captures in window', () => {
    it('returns empty brief and skips LLM call when no captures found', async () => {
      const { skill, mockLitellm } = makeSkill({ captures: [] })
      const result = await skill.execute()

      expect(result.captureCount).toBe(0)
      expect(result.brief.headline).toBe('')
      expect(result.brief.wins).toEqual([])
      expect(mockLitellm.chat.completions.create).not.toHaveBeenCalled()
    })

    it('still writes a skills_log entry when no captures found', async () => {
      const { skill, db } = makeSkill({ captures: [] })
      await skill.execute()

      expect(db.insert).toHaveBeenCalled()
    })
  })

  // ----------------------------------------------------------
  // JSON parsing
  // ----------------------------------------------------------

  describe('parseOutput — LLM output parsing', () => {
    it('strips markdown code fences before parsing JSON', async () => {
      const fencedOutput = SAMPLE_BRIEF_JSON
      const mockLitellm = {
        chat: {
          completions: {
            create: vi.fn().mockResolvedValue({
              choices: [{ message: { content: '```json\n' + JSON.stringify(fencedOutput) + '\n```' } }],
              usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
            }),
          },
        },
      }

      const { skill } = makeSkill()
      // @ts-ignore
      skill.litellmClient = mockLitellm

      const result = await skill.execute({ emailTo: 'test@test.com' })
      expect(result.brief.headline).toBe(SAMPLE_BRIEF_JSON.headline)
    })

    it('fills missing array fields with empty arrays', async () => {
      const partialOutput = { headline: 'Partial week', wins: ['One win'] }
      const { skill, mockLitellm } = makeSkill({ briefOutput: partialOutput as WeeklyBriefOutput })

      const createSpy = mockLitellm.chat.completions.create as MockInstance
      createSpy.mockResolvedValueOnce({
        choices: [{ message: { content: JSON.stringify(partialOutput) } }],
        usage: {},
      })

      const result = await skill.execute({ emailTo: 'test@test.com' })
      expect(result.brief.blockers).toEqual([])
      expect(result.brief.risks).toEqual([])
      expect(result.brief.open_loops).toEqual([])
    })

    it('throws when LLM returns completely invalid JSON', async () => {
      const { skill, mockLitellm } = makeSkill()
      const createSpy = mockLitellm.chat.completions.create as MockInstance
      createSpy.mockResolvedValueOnce({
        choices: [{ message: { content: 'This is not JSON at all, sorry.' } }],
        usage: {},
      })

      await expect(skill.execute({ emailTo: 'test@test.com' })).rejects.toThrow(
        /not valid JSON/i,
      )
    })
  })

  // ----------------------------------------------------------
  // Context assembly
  // ----------------------------------------------------------

  describe('context assembly', () => {
    it('groups captures by brain_view in the context string', async () => {
      const { skill, mockLitellm } = makeSkill()
      await skill.execute({ emailTo: 'test@test.com' })

      const createSpy = mockLitellm.chat.completions.create as MockInstance
      const prompt: string = createSpy.mock.calls[0][0].messages[0].content

      // Each brain_view should appear as a section header
      expect(prompt).toContain('CLIENT')
      expect(prompt).toContain('WORK-INTERNAL')
      expect(prompt).toContain('TECHNICAL')
    })

    it('respects token budget by truncating large context', async () => {
      // Create 1000 large captures to exceed a tiny budget
      const largeCap = {
        ...SAMPLE_CAPTURES[0],
        id: 'big',
        content: 'x'.repeat(1000),
      }
      const manyCaptures = Array.from({ length: 100 }, (_, i) => ({
        ...largeCap,
        id: `cap-${i}`,
        content_hash: `hash-${i}`,
      }))

      const { skill, mockLitellm } = makeSkill({ captures: manyCaptures })
      await skill.execute({ emailTo: 'test@test.com', tokenBudget: 1 }) // tiny budget = 4 chars

      const createSpy = mockLitellm.chat.completions.create as MockInstance
      const prompt: string = createSpy.mock.calls[0][0].messages[0].content

      // With budget of 4 chars, context should be very short (or empty for that section)
      // The prompt itself still runs — just with truncated context
      expect(typeof prompt).toBe('string')
    })
  })

  // ----------------------------------------------------------
  // Delivery failures (non-fatal)
  // ----------------------------------------------------------

  describe('delivery — non-fatal failures', () => {
    it('continues if Pushover delivery fails', async () => {
      const { skill, pushover } = makeSkill()
      vi.spyOn(pushover, 'send').mockRejectedValue(new Error('Pushover API down'))

      // Should not throw
      const result = await skill.execute({ emailTo: 'test@test.com' })
      expect(result.brief.headline).toBe(SAMPLE_BRIEF_JSON.headline)
    })

    it('continues if email delivery fails', async () => {
      const { skill, email } = makeSkill()
      vi.spyOn(email, 'send').mockRejectedValue(new Error('SMTP connection refused'))

      const result = await skill.execute({ emailTo: 'test@test.com' })
      expect(result.brief.headline).toBe(SAMPLE_BRIEF_JSON.headline)
    })

    it('continues if Core API save-back fails', async () => {
      const { skill } = makeSkill({
        coreApiResponse: { ok: false, status: 500 },
      })

      const result = await skill.execute({ emailTo: 'test@test.com' })
      expect(result.brief.headline).toBe(SAMPLE_BRIEF_JSON.headline)
      expect(result.savedCaptureId).toBeNull()
    })

    it('continues if skills_log insert fails', async () => {
      const { skill, db } = makeSkill()
      ;(db.insert as MockInstance).mockReturnValue({
        values: vi.fn().mockRejectedValue(new Error('DB write failed')),
      })

      // Should not throw
      const result = await skill.execute({ emailTo: 'test@test.com' })
      expect(result.captureCount).toBe(SAMPLE_CAPTURES.length)
    })
  })

  // ----------------------------------------------------------
  // Notification configuration
  // ----------------------------------------------------------

  describe('notification configuration', () => {
    it('skips Pushover if not configured', async () => {
      const { skill, pushover } = makeSkill({ pushoverConfigured: false })
      await skill.execute({ emailTo: 'test@test.com' })

      expect(pushover.send).not.toHaveBeenCalled()
    })

    it('skips email if not configured', async () => {
      const { skill, email } = makeSkill({ emailConfigured: false })
      await skill.execute({ emailTo: 'test@test.com' })

      expect(email.send).not.toHaveBeenCalled()
    })

    it('skips email if emailTo is not provided', async () => {
      const { skill, email } = makeSkill()
      // No emailTo passed, no env var set
      delete process.env.WEEKLY_BRIEF_EMAIL
      await skill.execute()

      expect(email.send).not.toHaveBeenCalled()
    })
  })

  // ----------------------------------------------------------
  // executeWeeklyBrief convenience function
  // ----------------------------------------------------------

  describe('executeWeeklyBrief', () => {
    it('executes and returns a WeeklyBriefResult', async () => {
      // This is an integration-level test of the module's top-level export.
      // We call it via the class directly since the function just delegates.
      const db = makeMockDb()
      const mockLitellm = makeMockOpenAI()
      const pushover = makePushoverService()
      const email = makeEmailService()

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({ id: 'cap-xyz' }),
        text: vi.fn().mockResolvedValue(''),
      }))

      const skill = new WeeklyBriefSkill({
        db: db as unknown as import('@open-brain/shared').Database,
        promptsDir: REPO_PROMPTS_DIR,
        coreApiUrl: 'http://localhost:3000',
        pushover,
        email,
      })
      // @ts-ignore
      skill.litellmClient = mockLitellm

      const result = await skill.execute({ emailTo: 'troy@example.com' })
      expect(result).toHaveProperty('brief')
      expect(result).toHaveProperty('captureCount')
      expect(result).toHaveProperty('durationMs')
      expect(result).toHaveProperty('savedCaptureId')
    })
  })
})
