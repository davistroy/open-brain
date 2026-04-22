import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { WikiGitService, WikiFrontmatter, WikiPage } from '@open-brain/shared'
import type { AgentResult, AgentToolCall } from '@open-brain/shared'

// ---------------------------------------------------------------------------
// Mock runAgent
// ---------------------------------------------------------------------------
const mockRunAgent = vi.fn<any[], Promise<AgentResult>>()

vi.mock('@open-brain/shared', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    runAgent: (...args: any[]) => mockRunAgent(...args),
  }
})

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------
import { WikiIngestSkill, buildWikiTools } from '../skills/wiki-ingest.js'
import type { WikiIngestResult } from '../skills/wiki-ingest.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeMockDb() {
  return {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([]),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 'mock-log-id' }]) }),
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
    render: vi.fn().mockReturnValue('Mock system prompt for wiki ingest'),
  } as any
}

function makeAgentResult(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    text: 'I have updated the wiki.',
    toolCalls: [],
    tokenUsage: {
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    },
    duration: 1000,
    iterations: 2,
    stopReason: 'end_turn',
    ...overrides,
  }
}

function makeToolCall(overrides: Partial<AgentToolCall> = {}): AgentToolCall {
  return {
    name: 'write_wiki_page',
    input: { path: 'test.md', title: 'Test', page_type: 'entity', content: '# Test' },
    result: 'Page "test.md" written successfully.',
    isError: false,
    iteration: 1,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests: buildWikiTools
// ---------------------------------------------------------------------------
describe('buildWikiTools', () => {
  let wikiService: WikiGitService

  beforeEach(() => {
    wikiService = makeMockWikiService()
  })

  it('returns 4 tools with expected names', () => {
    const tools = buildWikiTools(wikiService)
    expect(tools).toHaveLength(4)
    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual(['list_wiki_pages', 'read_wiki_page', 'update_index', 'write_wiki_page'])
  })

  describe('read_wiki_page', () => {
    it('returns content when page exists', async () => {
      const page: WikiPage = {
        path: 'test.md',
        frontmatter: { title: 'Test', type: 'entity', created: '2026-01-01', updated: '2026-04-11' },
        content: '# Test Page\n\nSome content here.',
      }
      ;(wikiService.readPage as ReturnType<typeof vi.fn>).mockResolvedValue(page)

      const tools = buildWikiTools(wikiService)
      const readTool = tools.find((t) => t.name === 'read_wiki_page')!
      const result = await readTool.execute({ path: 'test.md' })

      expect(result).toContain('Test')
      expect(result).toContain('entity')
      expect(result).toContain('Some content here')
      expect(wikiService.readPage).toHaveBeenCalledWith('test.md')
    })

    it('returns "does not exist" when page is null', async () => {
      ;(wikiService.readPage as ReturnType<typeof vi.fn>).mockResolvedValue(null)

      const tools = buildWikiTools(wikiService)
      const readTool = tools.find((t) => t.name === 'read_wiki_page')!
      const result = await readTool.execute({ path: 'missing.md' })

      expect(result).toContain('does not exist')
    })

    it('throws when path is missing', async () => {
      const tools = buildWikiTools(wikiService)
      const readTool = tools.find((t) => t.name === 'read_wiki_page')!

      await expect(readTool.execute({})).rejects.toThrow('path is required')
    })
  })

  describe('write_wiki_page', () => {
    it('calls writePage with proper frontmatter', async () => {
      ;(wikiService.readPage as ReturnType<typeof vi.fn>).mockResolvedValue(null) // new page

      const tools = buildWikiTools(wikiService)
      const writeTool = tools.find((t) => t.name === 'write_wiki_page')!
      const result = await writeTool.execute({
        path: 'projects/open-brain.md',
        title: 'Open Brain',
        page_type: 'entity',
        content: '# Open Brain\n\nAI knowledge system.',
        tags: ['project', 'ai'],
      })

      expect(result).toContain('written successfully')
      expect(wikiService.writePage).toHaveBeenCalledWith(
        'projects/open-brain.md',
        '# Open Brain\n\nAI knowledge system.',
        expect.objectContaining({
          title: 'Open Brain',
          type: 'entity',
          tags: ['project', 'ai'],
        }),
        expect.stringContaining('wiki-ingest'),
      )
    })

    it('preserves created date on existing pages', async () => {
      ;(wikiService.readPage as ReturnType<typeof vi.fn>).mockResolvedValue({
        path: 'test.md',
        frontmatter: { title: 'Old Title', type: 'entity', created: '2025-01-15', updated: '2025-06-01' },
        content: 'old content',
      })

      const tools = buildWikiTools(wikiService)
      const writeTool = tools.find((t) => t.name === 'write_wiki_page')!
      await writeTool.execute({
        path: 'test.md',
        title: 'New Title',
        page_type: 'entity',
        content: 'new content',
      })

      expect(wikiService.writePage).toHaveBeenCalledWith(
        'test.md',
        'new content',
        expect.objectContaining({
          created: '2025-01-15', // preserved from existing
        }),
        expect.any(String),
      )
    })

    it('throws when required fields are missing', async () => {
      const tools = buildWikiTools(wikiService)
      const writeTool = tools.find((t) => t.name === 'write_wiki_page')!

      await expect(writeTool.execute({ title: 'Test', page_type: 'entity', content: 'x' })).rejects.toThrow('path is required')
      await expect(writeTool.execute({ path: 'x.md', page_type: 'entity', content: 'x' })).rejects.toThrow('title is required')
      await expect(writeTool.execute({ path: 'x.md', title: 'Test', page_type: 'entity' })).rejects.toThrow('content is required')
    })
  })

  describe('list_wiki_pages', () => {
    it('returns formatted page list', async () => {
      ;(wikiService.listPages as ReturnType<typeof vi.fn>).mockResolvedValue([
        { path: 'projects/alpha.md', frontmatter: { title: 'Alpha', type: 'entity', created: '2026-01-01', updated: '2026-04-01' } },
        { path: 'concepts/testing.md', frontmatter: { title: 'Testing', type: 'concept', created: '2026-02-01', updated: '2026-04-01' } },
      ])

      const tools = buildWikiTools(wikiService)
      const listTool = tools.find((t) => t.name === 'list_wiki_pages')!
      const result = await listTool.execute({})

      expect(result).toContain('projects/alpha.md')
      expect(result).toContain('Alpha')
      expect(result).toContain('entity')
      expect(result).toContain('concepts/testing.md')
    })

    it('returns empty message when no pages', async () => {
      const tools = buildWikiTools(wikiService)
      const listTool = tools.find((t) => t.name === 'list_wiki_pages')!
      const result = await listTool.execute({})

      expect(result).toContain('No wiki pages exist yet')
    })
  })

  describe('update_index', () => {
    it('writes index.md with overview frontmatter', async () => {
      ;(wikiService.readPage as ReturnType<typeof vi.fn>).mockResolvedValue(null) // new index

      const tools = buildWikiTools(wikiService)
      const indexTool = tools.find((t) => t.name === 'update_index')!
      const result = await indexTool.execute({ content: '# Wiki Index\n\n- Page 1\n- Page 2' })

      expect(result).toContain('updated successfully')
      expect(wikiService.writePage).toHaveBeenCalledWith(
        'index.md',
        '# Wiki Index\n\n- Page 1\n- Page 2',
        expect.objectContaining({
          title: 'Wiki Index',
          type: 'overview',
        }),
        'wiki-ingest: update index',
      )
    })

    it('throws when content is missing', async () => {
      const tools = buildWikiTools(wikiService)
      const indexTool = tools.find((t) => t.name === 'update_index')!

      await expect(indexTool.execute({})).rejects.toThrow('content is required')
    })
  })
})

// ---------------------------------------------------------------------------
// Tests: WikiIngestSkill
// ---------------------------------------------------------------------------
describe('WikiIngestSkill', () => {
  let db: ReturnType<typeof makeMockDb>
  let wikiService: WikiGitService
  let templates: ReturnType<typeof makeMockTemplates>

  beforeEach(() => {
    vi.clearAllMocks()
    db = makeMockDb()
    wikiService = makeMockWikiService()
    templates = makeMockTemplates()
    mockRunAgent.mockResolvedValue(makeAgentResult())
  })

  function makeSkill() {
    return new WikiIngestSkill({
      db,
      wikiService,
      templates,
      model: 'claude-sonnet-4-5-20250929',
    })
  }

  it('skips when capture is not found', async () => {
    db.limit.mockResolvedValue([])

    const result = await makeSkill().execute('missing-id')

    expect(result.skipped).toBe(true)
    expect(result.skipReason).toBe('capture not found')
    expect(mockRunAgent).not.toHaveBeenCalled()
  })

  it('skips when capture content is too short', async () => {
    db.limit.mockResolvedValue([
      { id: 'cap-1', content: 'too short', capture_type: 'observation', brain_view: 'personal', tags: [], created_at: new Date() },
    ])

    const result = await makeSkill().execute('cap-1')

    expect(result.skipped).toBe(true)
    expect(result.skipReason).toBe('capture too short')
    expect(mockRunAgent).not.toHaveBeenCalled()
  })

  it('calls runAgent with system prompt and wiki tools', async () => {
    db.limit.mockResolvedValue([
      {
        id: 'cap-1',
        content: 'This is a substantial capture about a project decision to adopt Kubernetes for container orchestration.',
        capture_type: 'decision',
        brain_view: 'technical',
        tags: ['k8s', 'infrastructure'],
        created_at: new Date('2026-04-11'),
      },
    ])

    mockRunAgent.mockResolvedValue(makeAgentResult({ toolCalls: [] }))

    const result = await makeSkill().execute('cap-1')

    expect(result.skipped).toBe(false)
    expect(mockRunAgent).toHaveBeenCalledOnce()

    // Verify runAgent was called with correct arguments
    const [systemPrompt, tools, userMessage, options] = mockRunAgent.mock.calls[0]
    expect(systemPrompt).toBe('Mock system prompt for wiki ingest')
    expect(tools).toHaveLength(4)
    expect(userMessage).toContain('integrate')
    expect(options).toEqual(expect.objectContaining({
      model: 'claude-sonnet-4-5-20250929',
      maxIterations: 15,
      temperature: 0.3,
    }))
  })

  it('tracks pages created vs updated based on tool calls', async () => {
    db.limit.mockResolvedValue([
      {
        id: 'cap-2',
        content: 'A long capture about Docker containers and orchestration patterns for microservices.',
        capture_type: 'observation',
        brain_view: 'technical',
        tags: [],
        created_at: new Date('2026-04-11'),
      },
    ])

    mockRunAgent.mockResolvedValue(
      makeAgentResult({
        toolCalls: [
          // Read a page that doesn't exist (→ create)
          makeToolCall({
            name: 'read_wiki_page',
            input: { path: 'topics/docker.md' },
            result: 'Page "topics/docker.md" does not exist.',
            iteration: 1,
          }),
          // Write the new page
          makeToolCall({
            name: 'write_wiki_page',
            input: { path: 'topics/docker.md', title: 'Docker', page_type: 'concept', content: '# Docker' },
            result: 'Page "topics/docker.md" written successfully.',
            iteration: 2,
          }),
          // Read a page that exists (→ update)
          makeToolCall({
            name: 'read_wiki_page',
            input: { path: 'projects/infra.md' },
            result: '--- Frontmatter ---\ntitle: Infrastructure\n--- Content ---\n# Infra',
            iteration: 3,
          }),
          // Write the existing page (update)
          makeToolCall({
            name: 'write_wiki_page',
            input: { path: 'projects/infra.md', title: 'Infrastructure', page_type: 'entity', content: '# Infra\nUpdated' },
            result: 'Page "projects/infra.md" written successfully.',
            iteration: 3,
          }),
          // Update index
          makeToolCall({
            name: 'update_index',
            input: { content: '# Index\n- docker\n- infra' },
            result: 'index.md updated successfully.',
            iteration: 4,
          }),
        ],
        iterations: 4,
      }),
    )

    const result = await makeSkill().execute('cap-2')

    expect(result.pagesCreated).toEqual(['topics/docker.md'])
    expect(result.pagesUpdated).toEqual(['projects/infra.md'])
    expect(result.indexUpdated).toBe(true)
    expect(result.agentIterations).toBe(4)
    expect(result.toolCalls).toBe(5)
  })

  it('does not count errored tool calls', async () => {
    db.limit.mockResolvedValue([
      {
        id: 'cap-3',
        content: 'A substantial capture that will trigger wiki updates with some failures along the way.',
        capture_type: 'idea',
        brain_view: 'personal',
        tags: [],
        created_at: new Date('2026-04-11'),
      },
    ])

    mockRunAgent.mockResolvedValue(
      makeAgentResult({
        toolCalls: [
          makeToolCall({
            name: 'write_wiki_page',
            input: { path: 'fail.md' },
            result: 'Error: content is required',
            isError: true,
            iteration: 1,
          }),
        ],
      }),
    )

    const result = await makeSkill().execute('cap-3')

    expect(result.pagesCreated).toEqual([])
    expect(result.pagesUpdated).toEqual([])
  })

  it('appends to wiki log.md', async () => {
    db.limit.mockResolvedValue([
      {
        id: 'cap-4',
        content: 'A capture with enough content to trigger wiki processing and log the result to log.md.',
        capture_type: 'observation',
        brain_view: 'technical',
        tags: [],
        created_at: new Date('2026-04-11'),
      },
    ])

    mockRunAgent.mockResolvedValue(makeAgentResult({ toolCalls: [] }))

    await makeSkill().execute('cap-4')

    // writePage should be called for log.md
    expect(wikiService.writePage).toHaveBeenCalledWith(
      'log.md',
      expect.stringContaining('cap-4'),
      expect.objectContaining({ title: 'Wiki Ingest Log', type: 'overview' }),
      expect.stringContaining('wiki-ingest: log entry'),
    )
  })

  it('logs to skills_log table', async () => {
    db.limit.mockResolvedValue([
      {
        id: 'cap-5',
        content: 'A capture with enough content to trigger wiki processing and verify skills_log insertion.',
        capture_type: 'decision',
        brain_view: 'career',
        tags: ['test'],
        created_at: new Date('2026-04-11'),
      },
    ])

    mockRunAgent.mockResolvedValue(makeAgentResult())

    await makeSkill().execute('cap-5')

    expect(db.insert).toHaveBeenCalled()
  })

  it('re-throws agent errors for BullMQ retry', async () => {
    db.limit.mockResolvedValue([
      {
        id: 'cap-6',
        content: 'A capture that will cause the agent to fail, testing error propagation to BullMQ.',
        capture_type: 'observation',
        brain_view: 'personal',
        tags: [],
        created_at: new Date('2026-04-11'),
      },
    ])

    mockRunAgent.mockRejectedValue(new Error('API timeout'))

    await expect(makeSkill().execute('cap-6')).rejects.toThrow('API timeout')
  })

  it('handles non-fatal wiki log write failure', async () => {
    db.limit.mockResolvedValue([
      {
        id: 'cap-7',
        content: 'A capture that processes successfully but the wiki log write fails gracefully.',
        capture_type: 'observation',
        brain_view: 'personal',
        tags: [],
        created_at: new Date('2026-04-11'),
      },
    ])

    mockRunAgent.mockResolvedValue(makeAgentResult())
    ;(wikiService.writePage as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Git push failed'))

    // Should not throw despite log.md write failure
    const result = await makeSkill().execute('cap-7')
    expect(result.skipped).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Tests: Queue definition
// ---------------------------------------------------------------------------
describe('wiki-ingest queue', () => {
  it('creates queue with correct name and options', async () => {
    const { createWikiIngestQueue } = await import('../queues/wiki-ingest.js')
    const queue = createWikiIngestQueue({ host: 'localhost', port: 6379 })

    expect(queue.name).toBe('wiki-ingest')

    // Clean up
    await queue.close()
  })
})
