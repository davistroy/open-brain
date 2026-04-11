import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { WikiGitService } from '@open-brain/shared'
import type { AgentResult } from '@open-brain/shared'

// ---------------------------------------------------------------------------
// Mock runAgent
// ---------------------------------------------------------------------------
const mockRunAgent = vi.fn<(...args: unknown[]) => Promise<AgentResult>>()

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
import { WikiLintSkill, extractSummary, countIssues } from '../skills/wiki-lint.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeMockDb() {
  return {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    }),
  } as any
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

function makeMockTemplates() {
  return {
    render: vi.fn().mockReturnValue('Mock system prompt for wiki lint'),
  } as any
}

function makeMockPushover(configured = true) {
  return {
    isConfigured: configured,
    send: vi.fn().mockResolvedValue(undefined),
  } as any
}

function makeAgentResult(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    text: 'I have completed the wiki lint scan.',
    toolCalls: [],
    tokenUsage: {
      inputTokens: 200,
      outputTokens: 100,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    },
    duration: 2000,
    iterations: 3,
    stopReason: 'end_turn',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests: extractSummary
// ---------------------------------------------------------------------------
describe('extractSummary', () => {
  it('extracts summary section from agent text', () => {
    const text = `Some analysis here.

## Summary
Overall wiki health is good with 2 minor issues found.`

    expect(extractSummary(text)).toBe('Overall wiki health is good with 2 minor issues found.')
  })

  it('extracts summary with # heading', () => {
    const text = `Analysis...

# Summary
The wiki is in good shape.`

    expect(extractSummary(text)).toBe('The wiki is in good shape.')
  })

  it('falls back to first meaningful line when no summary section', () => {
    const text = `The wiki has 5 pages and 2 issues.
Some other details here.`

    expect(extractSummary(text)).toBe('The wiki has 5 pages and 2 issues.')
  })

  it('returns empty string for empty text', () => {
    expect(extractSummary('')).toBe('')
  })

  it('truncates long summaries to 300 chars', () => {
    const longSummary = '## Summary\n' + 'A'.repeat(400)
    const result = extractSummary(longSummary)
    expect(result.length).toBe(300)
  })
})

// ---------------------------------------------------------------------------
// Tests: countIssues
// ---------------------------------------------------------------------------
describe('countIssues', () => {
  it('counts bullet points as issues', () => {
    const text = `## Contradictions
- Page A says X, Page B says Y
- Another contradiction

## Orphan Pages
- orphan-page.md

## Stale Claims
(none found)

## Summary
3 issues found.`

    expect(countIssues(text)).toBe(3)
  })

  it('excludes "(none found)" lines', () => {
    const text = `## Contradictions
(none found)
## Orphan Pages
(none found)`

    expect(countIssues(text)).toBe(0)
  })

  it('counts * bullet points too', () => {
    const text = `## Issues
* First issue
* Second issue`

    expect(countIssues(text)).toBe(2)
  })

  it('returns 0 for empty text', () => {
    expect(countIssues('')).toBe(0)
  })

  it('excludes "no issues" lines', () => {
    const text = `## Summary
- no issues detected in this category`

    expect(countIssues(text)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Tests: WikiLintSkill
// ---------------------------------------------------------------------------
describe('WikiLintSkill', () => {
  let db: ReturnType<typeof makeMockDb>
  let wikiService: WikiGitService
  let templates: ReturnType<typeof makeMockTemplates>
  let pushover: ReturnType<typeof makeMockPushover>

  beforeEach(() => {
    vi.clearAllMocks()
    db = makeMockDb()
    wikiService = makeMockWikiService()
    templates = makeMockTemplates()
    pushover = makeMockPushover()
    mockRunAgent.mockResolvedValue(makeAgentResult())
  })

  function makeSkill() {
    return new WikiLintSkill({
      db,
      wikiService,
      templates,
      pushover,
      model: 'claude-sonnet-4-5-20250929',
    })
  }

  it('calls runAgent with system prompt and wiki tools', async () => {
    mockRunAgent.mockResolvedValue(makeAgentResult({
      toolCalls: [
        {
          name: 'list_wiki_pages',
          input: {},
          result: 'projects/alpha.md — "Alpha" (entity)',
          isError: false,
          iteration: 1,
        },
        {
          name: 'read_wiki_page',
          input: { path: 'projects/alpha.md' },
          result: '--- Frontmatter ---\ntitle: Alpha\n--- Content ---\n# Alpha',
          isError: false,
          iteration: 2,
        },
      ],
    }))

    const result = await makeSkill().execute()

    expect(result.pagesScanned).toBe(1)
    expect(mockRunAgent).toHaveBeenCalledOnce()

    const [systemPrompt, tools, userMessage, options] = mockRunAgent.mock.calls[0] as unknown[]
    expect(systemPrompt).toBe('Mock system prompt for wiki lint')
    expect(tools).toHaveLength(4) // reuses buildWikiTools from wiki-ingest
    expect(userMessage).toContain('scan all wiki pages')
    expect(options).toEqual(expect.objectContaining({
      model: 'claude-sonnet-4-5-20250929',
      maxIterations: 25,
      temperature: 0.2,
    }))
  })

  it('detects lint report written by agent', async () => {
    mockRunAgent.mockResolvedValue(makeAgentResult({
      toolCalls: [
        {
          name: 'write_wiki_page',
          input: { path: 'wiki/maintenance/lint-report.md', title: 'Lint Report', page_type: 'overview', content: '# Lint Report' },
          result: 'Page "wiki/maintenance/lint-report.md" written successfully.',
          isError: false,
          iteration: 3,
        },
      ],
    }))

    const result = await makeSkill().execute()

    expect(result.reportPath).toBe('wiki/maintenance/lint-report.md')
  })

  it('sends Pushover notification on completion', async () => {
    mockRunAgent.mockResolvedValue(makeAgentResult({
      text: '## Summary\n3 issues found across 5 pages.',
      toolCalls: [
        {
          name: 'read_wiki_page',
          input: { path: 'test.md' },
          result: 'content',
          isError: false,
          iteration: 1,
        },
      ],
    }))

    const result = await makeSkill().execute()

    expect(result.notificationSent).toBe(true)
    expect(pushover.send).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Wiki Lint Report',
    }))
  })

  it('skips Pushover when not configured', async () => {
    pushover = makeMockPushover(false)
    const skill = new WikiLintSkill({
      db,
      wikiService,
      templates,
      pushover,
    })

    const result = await skill.execute()

    expect(result.notificationSent).toBe(false)
    expect(pushover.send).not.toHaveBeenCalled()
  })

  it('logs to skills_log', async () => {
    await makeSkill().execute()

    expect(db.insert).toHaveBeenCalled()
  })

  it('re-throws agent errors for BullMQ retry', async () => {
    mockRunAgent.mockRejectedValue(new Error('API timeout'))

    await expect(makeSkill().execute()).rejects.toThrow('API timeout')
  })

  it('handles Pushover delivery failure gracefully', async () => {
    pushover.send.mockRejectedValue(new Error('Pushover down'))

    const result = await makeSkill().execute()

    expect(result.notificationSent).toBe(false)
  })

  it('handles skills_log insert failure gracefully', async () => {
    db.insert.mockReturnValue({
      values: vi.fn().mockRejectedValue(new Error('DB error')),
    })

    // Should not throw
    const result = await makeSkill().execute()
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('counts pages scanned from read_wiki_page tool calls', async () => {
    mockRunAgent.mockResolvedValue(makeAgentResult({
      toolCalls: [
        {
          name: 'list_wiki_pages',
          input: {},
          result: 'page1.md, page2.md, page3.md',
          isError: false,
          iteration: 1,
        },
        {
          name: 'read_wiki_page',
          input: { path: 'page1.md' },
          result: 'content',
          isError: false,
          iteration: 2,
        },
        {
          name: 'read_wiki_page',
          input: { path: 'page2.md' },
          result: 'content',
          isError: false,
          iteration: 2,
        },
        {
          name: 'read_wiki_page',
          input: { path: 'page3.md' },
          result: 'content',
          isError: false,
          iteration: 3,
        },
        // Errored read should not count
        {
          name: 'read_wiki_page',
          input: { path: 'broken.md' },
          result: 'Error: timeout',
          isError: true,
          iteration: 3,
        },
      ],
    }))

    const result = await makeSkill().execute()

    expect(result.pagesScanned).toBe(3) // excludes errored read
  })
})
