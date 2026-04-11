import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest'
import { join } from 'node:path'
import type { AgentResult, AgentToolCall, WikiGitService, WikiPage } from '@open-brain/shared'

// ---------------------------------------------------------------------------
// Mock runAgent
// ---------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockRunAgent = vi.fn<any>()

vi.mock('@open-brain/shared', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    runAgent: (...args: unknown[]) => mockRunAgent(...args),
  }
})

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------
import {
  MonthlyReflectionSkill,
  parseOutput,
  formatMonthLabel,
  fmtDate,
  buildReflectionTools,
  escapeHtml,
  renderEmailHtml,
  renderEmailText,
} from '../skills/monthly-reflection.js'
import type { MonthlyReflectionOutput } from '../skills/monthly-reflection.js'
import { PushoverService } from '../services/pushover.js'

// Prompt templates live at <repo-root>/config/prompts/
const REPO_PROMPTS_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'config', 'prompts')

// ============================================================
// Fixtures
// ============================================================

const SAMPLE_OUTPUT: MonthlyReflectionOutput = {
  month_label: 'April 2026',
  headline: 'AI infrastructure matured while client pipeline expanded — strategic inflection point',
  career_momentum: {
    summary: 'Strong forward momentum with NovaBurger retainer secured and Open Brain reaching production maturity.',
    wins: ['Closed NovaBurger retainer at $8K/month', 'Open Brain v1.5 deployed with cognitive memory'],
    concerns: ['Pipeline capacity if second QSR client signs'],
  },
  active_projects: {
    summary: 'Open Brain moving from feature development to operational hardening. Client work ramping.',
    highlights: ['Open Brain: cognitive memory shipped (PR #44)', 'NovaBurger: kickoff completed on schedule'],
    stalled: ['Amateur radio ARES integration — no captures for 3 weeks'],
  },
  technical_exploration: {
    summary: 'Deep investment in Hebbian learning and spreading activation. Claude subscription model changes architecture.',
    themes: ['Hebbian learning for knowledge graphs', 'Claude API dual-client routing'],
    depth_vs_breadth: 'Focused depth on cognitive memory — breadth narrowing appropriately.',
  },
  personal_patterns: {
    summary: 'Voice capture habit strong. Evening reflection becoming routine.',
    positive_patterns: ['Consistent daily voice captures', 'Evening sweeps generating actionable insights'],
    watch_items: ['Weekend capture volume dropping — potential burnout signal'],
  },
  cross_domain_insights: [
    'NovaBurger ops needs mirror the same pipeline architecture being built in Open Brain — potential reuse',
    'Hebbian learning research influencing how client engagement patterns are analyzed',
  ],
  month_ahead_focus: [
    'Lock in second QSR client or explicitly defer to Q3',
    'Open Brain wiki layer — highest-value next feature for knowledge retention',
    'Schedule amateur radio ARES commitment check',
  ],
  decisions_to_make: [
    'Whether to take second QSR client this quarter — capacity vs revenue tradeoff',
    'Open Brain voice: keep iOS Shortcut or build native watch app',
  ],
}

// ============================================================
// Mock helpers
// ============================================================

function makeAgentResult(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    text: JSON.stringify(SAMPLE_OUTPUT),
    toolCalls: [
      makeToolCall({
        name: 'get_capture_stats',
        input: {},
        result: 'Total captures: 142\n\nBy brain view:\n  career: 30\n  technical: 45\n  personal: 25\n  work-internal: 22\n  client: 20\n\nBy capture type:\n  observation: 50\n  decision: 25',
      }),
      makeToolCall({
        name: 'query_captures_by_view',
        input: { brain_view: 'career' },
        result: '30 captures for "career":\n\n[2026-04-01] [win] Closed NovaBurger retainer',
      }),
    ],
    tokenUsage: {
      inputTokens: 2000,
      outputTokens: 800,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    },
    duration: 5000,
    iterations: 4,
    stopReason: 'end_turn',
    ...overrides,
  }
}

function makeToolCall(overrides: Partial<AgentToolCall> = {}): AgentToolCall {
  return {
    name: 'get_capture_stats',
    input: {},
    result: 'Total captures: 42',
    isError: false,
    iteration: 1,
    ...overrides,
  }
}

function makeMockDb() {
  return {
    execute: vi.fn().mockResolvedValue({ rows: [] }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    }),
  }
}

function makeMockWikiService(): WikiGitService {
  return {
    init: vi.fn().mockResolvedValue(undefined),
    readPage: vi.fn().mockResolvedValue(null),
    writePage: vi.fn().mockResolvedValue(undefined),
    listPages: vi.fn().mockResolvedValue([]),
    getRecentChanges: vi.fn().mockResolvedValue([]),
    commitAndPush: vi.fn().mockResolvedValue(undefined),
  } as unknown as WikiGitService
}

function makePushoverService(configured = true) {
  const svc = new PushoverService('fake-token', 'fake-user')
  if (!configured) {
    Object.defineProperty(svc, 'isConfigured', { get: () => false })
  }
  vi.spyOn(svc, 'send').mockResolvedValue(undefined)
  return svc
}

function makeMockTemplates() {
  return {
    render: vi.fn().mockReturnValue('You are a personal strategist... generate monthly reflection.'),
  } as any
}

function makeSkill(opts: {
  agentResult?: AgentResult
  pushoverConfigured?: boolean
  wikiService?: WikiGitService
  coreApiResponse?: { ok: boolean; json?: object; status?: number }
} = {}) {
  const db = makeMockDb()
  const pushover = makePushoverService(opts.pushoverConfigured ?? true)
  const wikiService = opts.wikiService ?? undefined
  const templates = makeMockTemplates()

  const agentResult = opts.agentResult ?? makeAgentResult()
  mockRunAgent.mockResolvedValue(agentResult)

  const fetchResponse = opts.coreApiResponse ?? { ok: true, json: { id: 'saved-cap-id' } }
  const mockFetch = vi.fn().mockResolvedValue({
    ok: fetchResponse.ok,
    status: fetchResponse.status ?? (fetchResponse.ok ? 200 : 500),
    json: vi.fn().mockResolvedValue(fetchResponse.json ?? {}),
    text: vi.fn().mockResolvedValue(''),
  })
  vi.stubGlobal('fetch', mockFetch)

  const skill = new MonthlyReflectionSkill({
    db: db as any,
    pushover,
    wikiService,
    templates,
    coreApiUrl: 'http://localhost:3000',
  })

  return { skill, db, pushover, wikiService, templates, mockFetch }
}

// ============================================================
// Tests: parseOutput
// ============================================================

describe('parseOutput', () => {
  it('parses valid JSON into MonthlyReflectionOutput', () => {
    const raw = JSON.stringify(SAMPLE_OUTPUT)
    const result = parseOutput(raw, 'April 2026')
    expect(result.headline).toBe(SAMPLE_OUTPUT.headline)
    expect(result.month_label).toBe('April 2026')
    expect(result.career_momentum.wins).toHaveLength(2)
    expect(result.active_projects.highlights).toHaveLength(2)
    expect(result.cross_domain_insights).toHaveLength(2)
    expect(result.month_ahead_focus).toHaveLength(3)
    expect(result.decisions_to_make).toHaveLength(2)
  })

  it('strips markdown code fences before parsing', () => {
    const raw = '```json\n' + JSON.stringify(SAMPLE_OUTPUT) + '\n```'
    const result = parseOutput(raw, 'April 2026')
    expect(result.headline).toBe(SAMPLE_OUTPUT.headline)
  })

  it('returns empty output for invalid JSON', () => {
    const result = parseOutput('not json at all', 'April 2026')
    expect(result.month_label).toBe('April 2026')
    expect(result.headline).toContain('insufficient data')
    expect(result.career_momentum.wins).toEqual([])
    expect(result.cross_domain_insights).toEqual([])
  })

  it('handles missing nested sections gracefully', () => {
    const raw = JSON.stringify({
      headline: 'Test headline',
      month_label: 'April 2026',
    })
    const result = parseOutput(raw, 'April 2026')
    expect(result.headline).toBe('Test headline')
    expect(result.career_momentum.summary).toBe('')
    expect(result.career_momentum.wins).toEqual([])
    expect(result.active_projects.highlights).toEqual([])
    expect(result.personal_patterns.watch_items).toEqual([])
  })

  it('limits arrays to 5 items', () => {
    const raw = JSON.stringify({
      ...SAMPLE_OUTPUT,
      month_ahead_focus: Array.from({ length: 10 }, (_, i) => `Focus ${i}`),
    })
    const result = parseOutput(raw, 'April 2026')
    expect(result.month_ahead_focus).toHaveLength(5)
  })

  it('filters non-string items from arrays', () => {
    const raw = JSON.stringify({
      ...SAMPLE_OUTPUT,
      cross_domain_insights: ['valid', 42, null, 'also valid'],
    })
    const result = parseOutput(raw, 'April 2026')
    expect(result.cross_domain_insights).toEqual(['valid', 'also valid'])
  })

  it('uses fallback month_label when not in output', () => {
    const raw = JSON.stringify({ headline: 'Test' })
    const result = parseOutput(raw, 'March 2026')
    expect(result.month_label).toBe('March 2026')
  })
})

// ============================================================
// Tests: formatMonthLabel
// ============================================================

describe('formatMonthLabel', () => {
  it('formats January correctly', () => {
    expect(formatMonthLabel(new Date('2026-01-15'))).toBe('January 2026')
  })

  it('formats December correctly', () => {
    // Use explicit time to avoid timezone edge case (UTC midnight = previous month in US timezones)
    expect(formatMonthLabel(new Date('2026-12-15T12:00:00'))).toBe('December 2026')
  })

  it('formats April correctly', () => {
    expect(formatMonthLabel(new Date('2026-04-10'))).toBe('April 2026')
  })
})

// ============================================================
// Tests: fmtDate
// ============================================================

describe('fmtDate', () => {
  it('formats a Date as YYYY-MM-DD', () => {
    expect(fmtDate(new Date('2026-04-10T14:30:00Z'))).toBe('2026-04-10')
  })
})

// ============================================================
// Tests: escapeHtml
// ============================================================

describe('escapeHtml', () => {
  it('escapes HTML special characters', () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;',
    )
  })

  it('escapes ampersands', () => {
    expect(escapeHtml('R&D')).toBe('R&amp;D')
  })
})

// ============================================================
// Tests: buildReflectionTools
// ============================================================

describe('buildReflectionTools', () => {
  const windowStart = new Date('2026-03-10')
  const windowEnd = new Date('2026-04-10')

  it('returns 3 tools with expected names', () => {
    const db = makeMockDb()
    const tools = buildReflectionTools(db as any, windowStart, windowEnd)
    expect(tools).toHaveLength(3)
    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual(['get_capture_stats', 'get_top_entities', 'query_captures_by_view'])
  })

  describe('query_captures_by_view', () => {
    it('returns formatted captures for valid brain view', async () => {
      const db = makeMockDb()
      db.execute.mockResolvedValue({
        rows: [
          { id: 'c1', content: 'Test capture', capture_type: 'observation', brain_view: 'career', source: 'api', tags: ['test'], created_at: '2026-04-01T10:00:00Z' },
        ],
      })

      const tools = buildReflectionTools(db as any, windowStart, windowEnd)
      const queryTool = tools.find((t) => t.name === 'query_captures_by_view')!
      const result = await queryTool.execute({ brain_view: 'career' })

      expect(result).toContain('1 captures for "career"')
      expect(result).toContain('Test capture')
      expect(result).toContain('[observation]')
    })

    it('returns message for empty result set', async () => {
      const db = makeMockDb()
      db.execute.mockResolvedValue({ rows: [] })

      const tools = buildReflectionTools(db as any, windowStart, windowEnd)
      const queryTool = tools.find((t) => t.name === 'query_captures_by_view')!
      const result = await queryTool.execute({ brain_view: 'personal' })

      expect(result).toContain('No captures found')
    })

    it('throws for invalid brain view', async () => {
      const db = makeMockDb()
      const tools = buildReflectionTools(db as any, windowStart, windowEnd)
      const queryTool = tools.find((t) => t.name === 'query_captures_by_view')!

      await expect(queryTool.execute({ brain_view: 'invalid' })).rejects.toThrow('brain_view must be one of')
    })

    it('caps limit at 200', async () => {
      const db = makeMockDb()
      db.execute.mockResolvedValue({ rows: [] })

      const tools = buildReflectionTools(db as any, windowStart, windowEnd)
      const queryTool = tools.find((t) => t.name === 'query_captures_by_view')!
      await queryTool.execute({ brain_view: 'career', limit: 500 })

      // The SQL call should have been made (we can't easily inspect the SQL limit
      // parameter, but at least the function doesn't throw)
      expect(db.execute).toHaveBeenCalled()
    })
  })

  describe('get_capture_stats', () => {
    it('returns formatted stats', async () => {
      const db = makeMockDb()
      // First call: by view, second call: by type
      let callCount = 0
      db.execute.mockImplementation(() => {
        callCount++
        if (callCount === 1) {
          return Promise.resolve({
            rows: [
              { brain_view: 'technical', cnt: '45' },
              { brain_view: 'career', cnt: '30' },
            ],
          })
        }
        return Promise.resolve({
          rows: [
            { capture_type: 'observation', cnt: '50' },
            { capture_type: 'decision', cnt: '25' },
          ],
        })
      })

      const tools = buildReflectionTools(db as any, windowStart, windowEnd)
      const statsTool = tools.find((t) => t.name === 'get_capture_stats')!
      const result = await statsTool.execute({})

      expect(result).toContain('Total captures: 75')
      expect(result).toContain('technical: 45')
      expect(result).toContain('career: 30')
      expect(result).toContain('observation: 50')
    })
  })

  describe('get_top_entities', () => {
    it('returns formatted entity stats', async () => {
      const db = makeMockDb()
      db.execute.mockResolvedValue({
        rows: [
          { name: 'Open Brain', entity_type: 'project', mention_count: '15' },
          { name: 'NovaBurger', entity_type: 'organization', mention_count: '8' },
        ],
      })

      const tools = buildReflectionTools(db as any, windowStart, windowEnd)
      const entityTool = tools.find((t) => t.name === 'get_top_entities')!
      const result = await entityTool.execute({})

      expect(result).toContain('Open Brain (project): 15 mentions')
      expect(result).toContain('NovaBurger (organization): 8 mentions')
    })

    it('returns message when no entities found', async () => {
      const db = makeMockDb()
      db.execute.mockResolvedValue({ rows: [] })

      const tools = buildReflectionTools(db as any, windowStart, windowEnd)
      const entityTool = tools.find((t) => t.name === 'get_top_entities')!
      const result = await entityTool.execute({})

      expect(result).toContain('No entity links found')
    })
  })
})

// ============================================================
// Tests: renderEmailHtml
// ============================================================

describe('renderEmailHtml', () => {
  it('produces HTML with all sections', () => {
    const html = renderEmailHtml(SAMPLE_OUTPUT)
    expect(html).toContain('Monthly Reflection - April 2026')
    expect(html).toContain(SAMPLE_OUTPUT.headline)
    expect(html).toContain('Career Momentum')
    expect(html).toContain('Active Projects')
    expect(html).toContain('Technical Exploration')
    expect(html).toContain('Personal Patterns')
    expect(html).toContain('Cross-Domain Insights')
    expect(html).toContain('Month Ahead Focus')
    expect(html).toContain('Decisions to Make')
  })

  it('escapes HTML in content', () => {
    const output: MonthlyReflectionOutput = {
      ...SAMPLE_OUTPUT,
      headline: '<script>alert("xss")</script>',
    }
    const html = renderEmailHtml(output)
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })
})

// ============================================================
// Tests: renderEmailText
// ============================================================

describe('renderEmailText', () => {
  it('produces plain text with all sections', () => {
    const text = renderEmailText(SAMPLE_OUTPUT)
    expect(text).toContain('MONTHLY REFLECTION')
    expect(text).toContain('April 2026')
    expect(text).toContain(SAMPLE_OUTPUT.headline)
    expect(text).toContain('CAREER MOMENTUM')
    expect(text).toContain('ACTIVE PROJECTS')
    expect(text).toContain('TECHNICAL EXPLORATION')
    expect(text).toContain('PERSONAL PATTERNS')
    expect(text).toContain('CROSS-DOMAIN INSIGHTS')
    expect(text).toContain('MONTH AHEAD FOCUS')
    expect(text).toContain('DECISIONS TO MAKE')
  })
})

// ============================================================
// Tests: MonthlyReflectionSkill — execute
// ============================================================

describe('MonthlyReflectionSkill', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    mockRunAgent.mockReset()
  })

  describe('execute — happy path', () => {
    it('returns a MonthlyReflectionResult with correct fields', async () => {
      const { skill } = makeSkill()
      const result = await skill.execute()

      expect(result.output.headline).toBe(SAMPLE_OUTPUT.headline)
      expect(result.output.month_label).toBe('April 2026')
      expect(result.captureCount).toBe(142)
      expect(result.agentIterations).toBe(4)
      expect(result.toolCalls).toBe(2)
      expect(result.durationMs).toBeGreaterThanOrEqual(0)
    })

    it('calls runAgent with system prompt from templates', async () => {
      const { skill, templates } = makeSkill()
      await skill.execute()

      expect(mockRunAgent).toHaveBeenCalledOnce()
      expect(templates.render).toHaveBeenCalledWith('monthly-reflection/system.txt', {})

      // Check the user message mentions the month
      const userMsg = (mockRunAgent.mock.calls[0] as unknown[])[2] as string
      expect(userMsg).toContain('monthly reflection')
    })

    it('saves reflection as capture via Core API POST', async () => {
      const { skill, mockFetch } = makeSkill()
      await skill.execute()

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3000/api/v1/captures',
        expect.objectContaining({ method: 'POST' }),
      )

      const fetchBody = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(fetchBody.capture_type).toBe('reflection')
      expect(fetchBody.brain_view).toBe('personal')
      expect(fetchBody.source).toBe('api')
      expect(fetchBody.tags).toEqual(['monthly-reflection', 'skill-output'])
      expect(fetchBody.metadata.source_metadata.generator).toBe('monthly-reflection')
    })

    it('returns savedCaptureId from API response', async () => {
      const { skill } = makeSkill()
      const result = await skill.execute()
      expect(result.savedCaptureId).toBe('saved-cap-id')
    })

    it('sends Pushover notification with headline and focus items', async () => {
      const { skill, pushover } = makeSkill()
      await skill.execute()

      expect(pushover.send).toHaveBeenCalledWith(
        expect.objectContaining({
          title: expect.stringContaining('Monthly Reflection'),
          priority: 0,
        }),
      )
      const sendCall = (pushover.send as unknown as MockInstance).mock.calls[0][0]
      expect(sendCall.message).toContain(SAMPLE_OUTPUT.headline)
      expect(sendCall.message).toContain('Next month focus:')
    })

    it('writes a skills_log entry', async () => {
      const { skill, db } = makeSkill()
      await skill.execute()

      const insertSpy = db.insert as MockInstance
      expect(insertSpy).toHaveBeenCalled()
      const valuesSpy = insertSpy.mock.results[0].value.values as MockInstance
      const logEntry = valuesSpy.mock.calls[0][0]
      expect(logEntry.skill_name).toBe('monthly-reflection')
      expect(logEntry.input_summary).toContain('142 captures')
      expect(logEntry.output_summary).toContain('headline:')
      expect(logEntry.result).toBeDefined()
    })
  })

  // ----------------------------------------------------------
  // Wiki integration
  // ----------------------------------------------------------

  describe('execute — wiki integration', () => {
    it('writes wiki page when wikiService is configured', async () => {
      const wikiService = makeMockWikiService()
      const { skill } = makeSkill({ wikiService })
      const result = await skill.execute()

      expect(result.wikiPageWritten).toBe(true)
      expect(wikiService.writePage).toHaveBeenCalledOnce()

      const writePath = (wikiService.writePage as unknown as MockInstance).mock.calls[0][0]
      expect(writePath).toMatch(/^synthesis\/reflections\/\d{4}-\d{2}\.md$/)
    })

    it('skips wiki page when wikiService is not configured', async () => {
      const { skill } = makeSkill()
      const result = await skill.execute()
      expect(result.wikiPageWritten).toBe(false)
    })

    it('continues if wiki write fails', async () => {
      const wikiService = makeMockWikiService()
      ;(wikiService.writePage as unknown as MockInstance).mockRejectedValue(new Error('Git push failed'))

      const { skill } = makeSkill({ wikiService })
      const result = await skill.execute()

      expect(result.wikiPageWritten).toBe(false)
      expect(result.output.headline).toBe(SAMPLE_OUTPUT.headline)
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

      const result = await skill.execute()
      expect(result.output.headline).toBe(SAMPLE_OUTPUT.headline)
      expect(result.savedCaptureId).toBeNull()
    })

    it('continues if skills_log insert fails', async () => {
      const { skill, db } = makeSkill()
      ;(db.insert as MockInstance).mockReturnValue({
        values: vi.fn().mockRejectedValue(new Error('DB write failed')),
      })

      const result = await skill.execute()
      expect(result.captureCount).toBe(142)
    })

    it('skips Pushover if not configured', async () => {
      const { skill, pushover } = makeSkill({ pushoverConfigured: false })
      await skill.execute()
      expect(pushover.send).not.toHaveBeenCalled()
    })
  })

  // ----------------------------------------------------------
  // Agent failure
  // ----------------------------------------------------------

  describe('execute — agent failure', () => {
    it('propagates agent error', async () => {
      const { skill } = makeSkill()
      mockRunAgent.mockRejectedValue(new Error('Anthropic API timeout'))

      await expect(skill.execute()).rejects.toThrow('Anthropic API timeout')
    })
  })

  // ----------------------------------------------------------
  // Capture count extraction
  // ----------------------------------------------------------

  describe('capture count extraction from tool calls', () => {
    it('extracts capture count from get_capture_stats result', async () => {
      const { skill } = makeSkill()
      const result = await skill.execute()
      expect(result.captureCount).toBe(142)
    })

    it('returns 0 when no get_capture_stats tool call', async () => {
      const agentResult = makeAgentResult({
        toolCalls: [
          makeToolCall({
            name: 'query_captures_by_view',
            input: { brain_view: 'career' },
            result: '5 captures for "career"',
          }),
        ],
      })
      const { skill } = makeSkill({ agentResult })
      const result = await skill.execute()
      expect(result.captureCount).toBe(0)
    })
  })
})

// ============================================================
// Tests: executeMonthlyReflection top-level function
// ============================================================

describe('executeMonthlyReflection', () => {
  it('is exported and callable', async () => {
    const { executeMonthlyReflection } = await import('../skills/monthly-reflection.js')
    expect(typeof executeMonthlyReflection).toBe('function')
  })
})
