import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { WikiPage, WikiFrontmatter, WikiChange } from '@open-brain/shared'

// ---------------------------------------------------------------------------
// Mock WikiGitService — must be hoisted before WikiService import
// ---------------------------------------------------------------------------

const mockInit = vi.fn().mockResolvedValue(undefined)
const mockReadPage = vi.fn()
const mockWritePage = vi.fn().mockResolvedValue(undefined)
const mockListPages = vi.fn()
const mockGetRecentChanges = vi.fn()

vi.mock('@open-brain/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@open-brain/shared')>()
  return {
    ...actual,
    WikiGitService: vi.fn().mockImplementation(() => ({
      init: mockInit,
      readPage: mockReadPage,
      writePage: mockWritePage,
      listPages: mockListPages,
      getRecentChanges: mockGetRecentChanges,
    })),
  }
})

import { WikiService } from '../services/wiki.js'

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

function makeFrontmatter(overrides: Partial<WikiFrontmatter> = {}): WikiFrontmatter {
  return {
    title: 'Test Page',
    type: 'entity',
    created: '2026-04-01',
    updated: '2026-04-10',
    ...overrides,
  }
}

function makePage(overrides: Partial<WikiPage> = {}): WikiPage {
  return {
    path: 'entities/test.md',
    frontmatter: makeFrontmatter(),
    content: 'This is test content about Kubernetes and deployment patterns.',
    ...overrides,
  }
}

const entityPage = makePage({
  path: 'entities/kubernetes.md',
  frontmatter: makeFrontmatter({
    title: 'Kubernetes',
    type: 'entity',
    tags: ['infrastructure', 'containers'],
  }),
  content: 'Kubernetes is a container orchestration platform.',
})

const conceptPage = makePage({
  path: 'concepts/rag.md',
  frontmatter: makeFrontmatter({
    title: 'RAG Architecture',
    type: 'concept',
    tags: ['ai', 'search'],
  }),
  content: 'Retrieval-Augmented Generation combines search with LLM synthesis.',
})

const synthPage = makePage({
  path: 'synthesis/weekly-2026-04-07.md',
  frontmatter: makeFrontmatter({
    title: 'Weekly Synthesis Apr 7',
    type: 'synthesis',
  }),
  content: 'This week focused on wiki implementation and Kubernetes deployment.',
})

const lintPage = makePage({
  path: 'maintenance/lint-report.md',
  frontmatter: makeFrontmatter({ title: 'Lint Report', type: 'overview' }),
  content: '## Lint Results\n\n- 3 orphan pages\n- 1 broken link',
})

const allPageSummaries = [entityPage, conceptPage, synthPage].map(({ path, frontmatter }) => ({
  path,
  frontmatter,
}))

// ---------------------------------------------------------------------------
// Mock BullMQ Queue
// ---------------------------------------------------------------------------

const mockQueueAdd = vi.fn().mockResolvedValue({ id: 'job-123' })

function makeMockQueue() {
  return { add: mockQueueAdd } as any
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WikiService', () => {
  let service: WikiService

  beforeEach(() => {
    vi.clearAllMocks()
    mockListPages.mockResolvedValue(allPageSummaries)
    service = new WikiService({
      repoUrl: 'git@gitea.local:wiki.git',
      localPath: '/tmp/wiki',
      wikiIngestQueue: makeMockQueue(),
      wikiLintQueue: makeMockQueue(),
    })
  })

  describe('init / isReady', () => {
    it('initializes the underlying git service', async () => {
      expect(service.isReady()).toBe(false)
      await service.init()
      expect(service.isReady()).toBe(true)
      expect(mockInit).toHaveBeenCalledOnce()
    })

    it('throws on operations before init', async () => {
      await expect(service.listPages()).rejects.toThrow('WikiService not initialized')
    })
  })

  describe('listPages', () => {
    beforeEach(async () => {
      await service.init()
    })

    it('returns all pages with no filters', async () => {
      const pages = await service.listPages()
      expect(pages).toHaveLength(3)
      expect(pages[0].path).toBe('entities/kubernetes.md')
    })

    it('filters by type', async () => {
      const pages = await service.listPages('concept')
      expect(pages).toHaveLength(1)
      expect(pages[0].frontmatter.title).toBe('RAG Architecture')
    })

    it('filters by tag (case-insensitive)', async () => {
      const pages = await service.listPages(undefined, 'AI')
      expect(pages).toHaveLength(1)
      expect(pages[0].path).toBe('concepts/rag.md')
    })

    it('filters by both type and tag', async () => {
      const pages = await service.listPages('entity', 'containers')
      expect(pages).toHaveLength(1)
      expect(pages[0].frontmatter.title).toBe('Kubernetes')
    })

    it('returns empty array when no pages match', async () => {
      const pages = await service.listPages('comparison')
      expect(pages).toHaveLength(0)
    })
  })

  describe('getPage', () => {
    beforeEach(async () => {
      await service.init()
    })

    it('returns page with content', async () => {
      mockReadPage.mockResolvedValue(entityPage)
      const page = await service.getPage('entities/kubernetes.md')
      expect(page).not.toBeNull()
      expect(page!.frontmatter.title).toBe('Kubernetes')
      expect(page!.content).toContain('container orchestration')
    })

    it('returns null for non-existent page', async () => {
      mockReadPage.mockResolvedValue(null)
      const page = await service.getPage('entities/nonexistent.md')
      expect(page).toBeNull()
    })
  })

  describe('getRecentChanges', () => {
    beforeEach(async () => {
      await service.init()
    })

    it('returns git log entries', async () => {
      const changes: WikiChange[] = [
        { hash: 'abc123', date: '2026-04-11', message: 'Updated kubernetes', files: ['entities/kubernetes.md'] },
        { hash: 'def456', date: '2026-04-10', message: 'Created rag', files: ['concepts/rag.md'] },
      ]
      mockGetRecentChanges.mockResolvedValue(changes)

      const result = await service.getRecentChanges(10)
      expect(result).toHaveLength(2)
      expect(mockGetRecentChanges).toHaveBeenCalledWith(10)
    })

    it('defaults to 20 entries', async () => {
      mockGetRecentChanges.mockResolvedValue([])
      await service.getRecentChanges()
      expect(mockGetRecentChanges).toHaveBeenCalledWith(20)
    })
  })

  describe('getLintReport', () => {
    beforeEach(async () => {
      await service.init()
    })

    it('returns structured lint report parsed from markdown fallback', async () => {
      // JSON sidecar doesn't exist; fall back to markdown lint-report.md
      mockReadPage.mockImplementation((path: string) => {
        if (path === 'maintenance/lint-report.json') return Promise.resolve(null)
        if (path === 'maintenance/lint-report.md') return Promise.resolve(lintPage)
        return Promise.resolve(null)
      })
      const report = await service.getLintReport()
      expect(report).not.toBeNull()
      expect(typeof report!.total_pages).toBe('number')
      expect(Array.isArray(report!.issues)).toBe(true)
    })

    it('returns structured lint report from JSON sidecar when available', async () => {
      const jsonContent = JSON.stringify({
        total_pages: 42,
        issues: [{ page: 'entities/test.md', severity: 'warning', message: 'orphan page', rule: 'orphan' }],
        last_run: '2026-04-20',
      })
      const jsonPage = makePage({ path: 'maintenance/lint-report.json', content: jsonContent })
      mockReadPage.mockImplementation((path: string) => {
        if (path === 'maintenance/lint-report.json') return Promise.resolve(jsonPage)
        return Promise.resolve(null)
      })
      const report = await service.getLintReport()
      expect(report).not.toBeNull()
      expect(report!.total_pages).toBe(42)
      expect(report!.issues).toHaveLength(1)
      expect(report!.last_run).toBe('2026-04-20')
    })

    it('returns null when no lint report exists', async () => {
      mockReadPage.mockResolvedValue(null)
      const report = await service.getLintReport()
      expect(report).toBeNull()
    })
  })

  describe('search', () => {
    beforeEach(async () => {
      await service.init()
      // search reads full pages for body matching
      mockReadPage.mockImplementation((path: string) => {
        if (path === 'entities/kubernetes.md') return Promise.resolve(entityPage)
        if (path === 'concepts/rag.md') return Promise.resolve(conceptPage)
        if (path === 'synthesis/weekly-2026-04-07.md') return Promise.resolve(synthPage)
        return Promise.resolve(null)
      })
    })

    it('finds pages by content match', async () => {
      const results = await service.search('orchestration')
      expect(results).toHaveLength(1)
      expect(results[0].path).toBe('entities/kubernetes.md')
      expect(results[0].snippet).toContain('orchestration')
    })

    it('finds pages by title match', async () => {
      const results = await service.search('Kubernetes')
      expect(results).toHaveLength(2) // title match + content mention in synthPage
      expect(results.some((r) => r.path === 'entities/kubernetes.md')).toBe(true)
    })

    it('finds pages by tag match', async () => {
      const results = await service.search('containers')
      expect(results).toHaveLength(1)
      expect(results[0].path).toBe('entities/kubernetes.md')
    })

    it('is case-insensitive', async () => {
      const results = await service.search('KUBERNETES')
      expect(results.length).toBeGreaterThan(0)
    })

    it('returns empty for no matches', async () => {
      const results = await service.search('xyznonexistent')
      expect(results).toHaveLength(0)
    })

    it('returns empty for empty query', async () => {
      const results = await service.search('   ')
      expect(results).toHaveLength(0)
    })
  })

  describe('writePage', () => {
    beforeEach(async () => {
      await service.init()
    })

    it('delegates to WikiGitService', async () => {
      const fm = makeFrontmatter({ title: 'New Page', type: 'concept' })
      await service.writePage('concepts/new.md', 'New content', fm, 'Add new page')
      expect(mockWritePage).toHaveBeenCalledWith(
        'concepts/new.md',
        'New content',
        fm,
        'Add new page',
      )
    })
  })

  describe('triggerIngest', () => {
    beforeEach(async () => {
      await service.init()
    })

    it('enqueues a wiki-ingest job', async () => {
      const jobId = await service.triggerIngest('capture-uuid-1')
      expect(jobId).toBe('job-123')
      expect(mockQueueAdd).toHaveBeenCalledWith(
        'wiki-ingest',
        { captureId: 'capture-uuid-1' },
        expect.objectContaining({ jobId: 'wiki-ingest_capture-uuid-1' }),
      )
    })

    it('returns null when queue not configured', async () => {
      const noQueueService = new WikiService({
        repoUrl: 'git@gitea.local:wiki.git',
        localPath: '/tmp/wiki',
      })
      await noQueueService.init()
      const jobId = await noQueueService.triggerIngest('capture-uuid-1')
      expect(jobId).toBeNull()
    })
  })

  describe('triggerLint', () => {
    beforeEach(async () => {
      await service.init()
    })

    it('enqueues a wiki-lint job', async () => {
      const jobId = await service.triggerLint()
      expect(jobId).toBe('job-123')
      expect(mockQueueAdd).toHaveBeenCalledWith(
        'wiki-lint',
        expect.objectContaining({ triggeredAt: expect.any(String) }),
        expect.objectContaining({ removeOnComplete: 100 }),
      )
    })

    it('returns null when queue not configured', async () => {
      const noQueueService = new WikiService({
        repoUrl: 'git@gitea.local:wiki.git',
        localPath: '/tmp/wiki',
      })
      await noQueueService.init()
      const jobId = await noQueueService.triggerLint()
      expect(jobId).toBeNull()
    })
  })
})
