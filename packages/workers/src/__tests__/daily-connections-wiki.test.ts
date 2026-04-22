import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest'
import { join } from 'node:path'
import { DailyConnectionsSkill, buildConnectionsMarkdown } from '../skills/daily-connections.js'
import type { DailyConnectionsOutput } from '../skills/daily-connections.js'
import type { CaptureRecord } from '@open-brain/shared'
import { PushoverService } from '../services/pushover.js'
import type { WikiGitService } from '@open-brain/shared'

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
  makeCapture({ id: 'cap-1', content: 'Closed the NovaBurger retainer.', brain_view: 'client', content_hash: 'h1' }),
  makeCapture({ id: 'cap-2', content: 'QSR ops dashboard blocked.', brain_view: 'work-internal', content_hash: 'h2' }),
  makeCapture({ id: 'cap-3', content: 'Voice pipeline working.', brain_view: 'technical', content_hash: 'h3' }),
]

const SAMPLE_CONNECTIONS_OUTPUT: DailyConnectionsOutput = {
  summary: 'Cross-domain pattern between QSR client work and technical infrastructure.',
  connections: [
    {
      theme: 'Client-Infrastructure Convergence',
      captures: ['cap-1', 'cap-2'],
      insight: 'The QSR ops dashboard blocker mirrors a pattern in voice pipeline work.',
      confidence: 'high',
      domains: ['client', 'technical'],
    },
    {
      theme: 'Revenue-Tech Alignment',
      captures: ['cap-1', 'cap-3'],
      insight: 'NovaBurger retainer success correlates with voice pipeline completion.',
      confidence: 'medium',
      domains: ['client', 'technical'],
    },
  ],
  meta_pattern: 'Infrastructure readiness is the gating factor across all domains.',
}

const LOW_CONFIDENCE_OUTPUT: DailyConnectionsOutput = {
  summary: 'Only weak connections found.',
  connections: [
    {
      theme: 'Tenuous Link',
      captures: ['cap-1'],
      insight: 'Very weak connection.',
      confidence: 'low',
      domains: ['personal'],
    },
  ],
  meta_pattern: null,
}

// ============================================================
// Mock helpers
// ============================================================

function makeMockDb(captures = SAMPLE_CAPTURES) {
  let callCount = 0
  return {
    execute: vi.fn().mockImplementation(() => {
      callCount++
      if (callCount === 1) return Promise.resolve({ rows: captures })
      return Promise.resolve({ rows: [] })
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 'mock-log-id' }]) }),
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

function makeMockWikiService(shouldFail = false): WikiGitService {
  return {
    init: vi.fn().mockResolvedValue(undefined),
    readPage: vi.fn().mockResolvedValue(null),
    listPages: vi.fn().mockResolvedValue([]),
    getRecentChanges: vi.fn().mockResolvedValue([]),
    writePage: shouldFail
      ? vi.fn().mockRejectedValue(new Error('Git push failed'))
      : vi.fn().mockResolvedValue(undefined),
    commitAndPush: vi.fn().mockResolvedValue(undefined),
  } as unknown as WikiGitService
}

function makeSkill(opts: {
  wikiService?: WikiGitService
  connectionsOutput?: DailyConnectionsOutput
  captures?: CaptureRecord[]
} = {}) {
  const db = makeMockDb(opts.captures ?? SAMPLE_CAPTURES)
  const mockLitellm = makeMockOpenAI(opts.connectionsOutput ?? SAMPLE_CONNECTIONS_OUTPUT)
  const pushover = new PushoverService('fake-token', 'fake-user')
  vi.spyOn(pushover, 'send').mockResolvedValue(undefined)

  const mockFetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue({ id: 'saved-conn-id' }),
    text: vi.fn().mockResolvedValue(''),
  })
  vi.stubGlobal('fetch', mockFetch)

  const skill = new DailyConnectionsSkill({
    db: db as unknown as import('@open-brain/shared').Database,
    promptsDir: REPO_PROMPTS_DIR,
    coreApiUrl: 'http://localhost:3000',
    pushover,
    wikiService: opts.wikiService,
  })

  // Replace internal litellmClient
  // @ts-ignore — accessing private field for testing
  skill.litellmClient = mockLitellm

  return { skill, db, mockLitellm, pushover, mockFetch }
}

// ============================================================
// Tests: buildConnectionsMarkdown
// ============================================================

describe('buildConnectionsMarkdown', () => {
  it('produces markdown with title and summary', () => {
    const md = buildConnectionsMarkdown(SAMPLE_CONNECTIONS_OUTPUT, '2026-03-01', '2026-03-07')
    expect(md).toContain('# Daily Connections — 2026-03-01 to 2026-03-07')
    expect(md).toContain(SAMPLE_CONNECTIONS_OUTPUT.summary)
  })

  it('includes connection details with confidence and domains', () => {
    const md = buildConnectionsMarkdown(SAMPLE_CONNECTIONS_OUTPUT, '2026-03-01', '2026-03-07')
    expect(md).toContain('### Client-Infrastructure Convergence')
    expect(md).toContain('**Confidence:** high')
    expect(md).toContain('**Domains:** client, technical')
    expect(md).toContain('QSR ops dashboard blocker')
  })

  it('includes meta-pattern section when present', () => {
    const md = buildConnectionsMarkdown(SAMPLE_CONNECTIONS_OUTPUT, '2026-03-01', '2026-03-07')
    expect(md).toContain('## Meta-Pattern')
    expect(md).toContain('Infrastructure readiness is the gating factor')
  })

  it('omits meta-pattern section when null', () => {
    const output: DailyConnectionsOutput = { ...SAMPLE_CONNECTIONS_OUTPUT, meta_pattern: null }
    const md = buildConnectionsMarkdown(output, '2026-03-01', '2026-03-07')
    expect(md).not.toContain('## Meta-Pattern')
  })

  it('includes source captures', () => {
    const md = buildConnectionsMarkdown(SAMPLE_CONNECTIONS_OUTPUT, '2026-03-01', '2026-03-07')
    expect(md).toContain('*Source captures:* cap-1, cap-2')
  })

  it('handles empty connections gracefully', () => {
    const emptyOutput: DailyConnectionsOutput = { summary: 'Nothing found.', connections: [], meta_pattern: null }
    const md = buildConnectionsMarkdown(emptyOutput, '2026-03-01', '2026-03-07')
    expect(md).toContain('Nothing found.')
    expect(md).not.toContain('## Connections')
  })
})

// ============================================================
// Tests: DailyConnectionsSkill — wiki integration
// ============================================================

describe('DailyConnectionsSkill — wiki integration', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('writes connections to wiki as synthesis page when wikiService is provided', async () => {
    const wikiService = makeMockWikiService()
    const { skill } = makeSkill({ wikiService })
    await skill.execute()

    expect(wikiService.writePage).toHaveBeenCalledOnce()
    const callArgs = (wikiService.writePage as unknown as MockInstance).mock.calls[0]
    // pagePath should be synthesis/connections/YYYY-MM-DD.md
    expect(callArgs[0]).toMatch(/^synthesis\/connections\/\d{4}-\d{2}-\d{2}\.md$/)
    // content should contain connections
    expect(callArgs[1]).toContain('# Daily Connections')
    // frontmatter
    expect(callArgs[2].title).toContain('Daily Connections')
    expect(callArgs[2].type).toBe('synthesis')
    expect(callArgs[2].tags).toContain('connections')
    expect(callArgs[2].tags).toContain('synthesis')
    expect(callArgs[2].connection_count).toBe(2)
    // commit message
    expect(callArgs[3]).toContain('daily-connections:')
  })

  it('skips wiki write when wikiService is not provided', async () => {
    const { skill } = makeSkill({ wikiService: undefined })
    const result = await skill.execute()
    expect(result.output.summary).toBe(SAMPLE_CONNECTIONS_OUTPUT.summary)
  })

  it('skips wiki write when only low-confidence connections', async () => {
    const wikiService = makeMockWikiService()
    const { skill } = makeSkill({ wikiService, connectionsOutput: LOW_CONFIDENCE_OUTPUT })
    await skill.execute()

    expect(wikiService.writePage).not.toHaveBeenCalled()
  })

  it('continues execution when wiki write fails', async () => {
    const wikiService = makeMockWikiService(true) // shouldFail = true
    const { skill } = makeSkill({ wikiService })
    const result = await skill.execute()

    expect(wikiService.writePage).toHaveBeenCalledOnce()
    expect(result.output.summary).toBe(SAMPLE_CONNECTIONS_OUTPUT.summary)
    expect(result.savedCaptureId).toBe('saved-conn-id')
  })

  it('does not write wiki when no captures in window', async () => {
    const wikiService = makeMockWikiService()
    const { skill } = makeSkill({ wikiService, captures: [] })
    await skill.execute()

    expect(wikiService.writePage).not.toHaveBeenCalled()
  })

  it('includes wiki status in skills_log output summary', async () => {
    const wikiService = makeMockWikiService()
    const { skill, db } = makeSkill({ wikiService })
    await skill.execute()

    const insertSpy = db.insert as MockInstance
    expect(insertSpy).toHaveBeenCalled()
    const valuesSpy = insertSpy.mock.results[0].value.values as MockInstance
    const logEntry = valuesSpy.mock.calls[0][0]
    expect(logEntry.output_summary).toContain('wiki: true')
  })

  it('frontmatter includes domains from connections', async () => {
    const wikiService = makeMockWikiService()
    const { skill } = makeSkill({ wikiService })
    await skill.execute()

    const callArgs = (wikiService.writePage as unknown as MockInstance).mock.calls[0]
    const frontmatter = callArgs[2]
    expect(frontmatter.domains).toContain('client')
    expect(frontmatter.domains).toContain('technical')
    // Domains should be deduplicated
    expect(new Set(frontmatter.domains).size).toBe(frontmatter.domains.length)
  })
})
