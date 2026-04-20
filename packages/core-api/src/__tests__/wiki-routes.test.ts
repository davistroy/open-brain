import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { registerWikiRoutes } from '../routes/wiki.js'
import type { WikiService } from '../services/wiki.js'
import type { WikiFrontmatter } from '@open-brain/shared'

// ---------------------------------------------------------------------------
// Mock WikiService
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

const mockListPages = vi.fn()
const mockGetPage = vi.fn()
const mockGetRecentChanges = vi.fn()
const mockGetLintReport = vi.fn()
const mockGetStats = vi.fn()
const mockSearch = vi.fn()
const mockTriggerIngest = vi.fn()
const mockTriggerLint = vi.fn()
const mockTriggerResynthesize = vi.fn()

function createMockWikiService(): WikiService {
  return {
    listPages: mockListPages,
    getPage: mockGetPage,
    getRecentChanges: mockGetRecentChanges,
    getLintReport: mockGetLintReport,
    getStats: mockGetStats,
    search: mockSearch,
    triggerIngest: mockTriggerIngest,
    triggerLint: mockTriggerLint,
    triggerResynthesize: mockTriggerResynthesize,
    init: vi.fn(),
    isReady: vi.fn().mockReturnValue(true),
    writePage: vi.fn(),
  } as unknown as WikiService
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Wiki routes', () => {
  let app: Hono

  beforeEach(() => {
    vi.clearAllMocks()
    app = new Hono()
    registerWikiRoutes(app, createMockWikiService())
  })

  describe('GET /api/v1/wiki/pages', () => {
    it('returns all pages with no filter — flat shape', async () => {
      const pages = [
        { path: 'entities/k8s.md', frontmatter: makeFrontmatter({ title: 'Kubernetes' }) },
        { path: 'concepts/rag.md', frontmatter: makeFrontmatter({ title: 'RAG', type: 'concept' }) },
      ]
      mockListPages.mockResolvedValue(pages)

      const res = await app.request('/api/v1/wiki/pages')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.pages).toHaveLength(2)
      expect(body.total).toBe(2)
      // Verify flat shape: title at top level, not nested under frontmatter
      expect(body.pages[0].title).toBe('Kubernetes')
      expect(body.pages[0].type).toBe('entity')
      expect(body.pages[0]).not.toHaveProperty('frontmatter')
    })

    it('passes type filter to service', async () => {
      mockListPages.mockResolvedValue([])
      await app.request('/api/v1/wiki/pages?type=entity')
      expect(mockListPages).toHaveBeenCalledWith('entity', undefined)
    })

    it('passes tag filter to service', async () => {
      mockListPages.mockResolvedValue([])
      await app.request('/api/v1/wiki/pages?tag=ai')
      expect(mockListPages).toHaveBeenCalledWith(undefined, 'ai')
    })
  })

  describe('GET /api/v1/wiki/pages/:path', () => {
    it('returns page content with flat shape', async () => {
      mockGetPage.mockResolvedValue({
        path: 'entities/k8s.md',
        frontmatter: makeFrontmatter({ title: 'Kubernetes' }),
        content: 'Container orchestration platform.',
      })

      const res = await app.request('/api/v1/wiki/pages/entities/k8s.md')
      expect(res.status).toBe(200)
      const body = await res.json()
      // Flat shape: title at top level
      expect(body.title).toBe('Kubernetes')
      expect(body.type).toBe('entity')
      expect(body.content).toContain('orchestration')
      expect(body).not.toHaveProperty('frontmatter')
    })

    it('returns 404 for non-existent page', async () => {
      mockGetPage.mockResolvedValue(null)
      const res = await app.request('/api/v1/wiki/pages/entities/nonexistent.md')
      expect(res.status).toBe(404)
    })

    it('handles nested paths', async () => {
      mockGetPage.mockResolvedValue({
        path: 'entities/cloud/aws.md',
        frontmatter: makeFrontmatter({ title: 'AWS' }),
        content: 'Amazon Web Services.',
      })

      const res = await app.request('/api/v1/wiki/pages/entities/cloud/aws.md')
      expect(res.status).toBe(200)
      expect(mockGetPage).toHaveBeenCalledWith('entities/cloud/aws.md')
    })
  })

  describe('GET /api/v1/wiki/search', () => {
    it('returns search results with flat page shape and pages alias', async () => {
      mockSearch.mockResolvedValue([
        {
          path: 'entities/k8s.md',
          frontmatter: makeFrontmatter({ title: 'Kubernetes' }),
          snippet: '...container orchestration...',
        },
      ])

      const res = await app.request('/api/v1/wiki/search?q=kubernetes')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.query).toBe('kubernetes')
      expect(body.results).toHaveLength(1)
      expect(body.pages).toHaveLength(1)  // alias for web-client compat
      expect(body.total).toBe(1)
      // Flat shape
      expect(body.results[0].title).toBe('Kubernetes')
      expect(body.results[0].snippet).toBe('...container orchestration...')
      expect(body.results[0]).not.toHaveProperty('frontmatter')
    })

    it('requires q parameter', async () => {
      const res = await app.request('/api/v1/wiki/search')
      expect(res.status).toBe(400)
    })
  })

  describe('GET /api/v1/wiki/recent-changes', () => {
    it('returns git log entries', async () => {
      mockGetRecentChanges.mockResolvedValue([
        { hash: 'abc', date: '2026-04-11', message: 'Update k8s', files: ['entities/k8s.md'] },
      ])

      const res = await app.request('/api/v1/wiki/recent-changes')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.changes).toHaveLength(1)
      expect(body.total).toBe(1)
    })

    it('accepts limit parameter', async () => {
      mockGetRecentChanges.mockResolvedValue([])
      await app.request('/api/v1/wiki/recent-changes?limit=5')
      expect(mockGetRecentChanges).toHaveBeenCalledWith(5)
    })
  })

  describe('GET /api/v1/wiki/lint-report', () => {
    it('returns structured lint report directly', async () => {
      mockGetLintReport.mockResolvedValue({
        total_pages: 42,
        issues: [{ page: 'entities/k8s.md', severity: 'warning', message: 'Stale claim', rule: 'lint-warning' }],
        last_run: '2026-04-20T05:00:00Z',
      })

      const res = await app.request('/api/v1/wiki/lint-report')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.total_pages).toBe(42)
      expect(body.issues).toHaveLength(1)
      expect(body.last_run).toBe('2026-04-20T05:00:00Z')
    })

    it('returns empty report when no report exists', async () => {
      mockGetLintReport.mockResolvedValue(null)

      const res = await app.request('/api/v1/wiki/lint-report')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.total_pages).toBe(0)
      expect(body.issues).toEqual([])
      expect(body.last_run).toBeNull()
    })
  })

  describe('GET /api/v1/wiki/stats', () => {
    it('returns aggregate wiki statistics', async () => {
      mockGetStats.mockResolvedValue({
        page_count: 15,
        orphan_count: 3,
        domain_distribution: { entities: 8, concepts: 7 },
        last_updated: '2026-04-20',
        last_lint_run: '2026-04-20T05:00:00Z',
      })

      const res = await app.request('/api/v1/wiki/stats')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.page_count).toBe(15)
      expect(body.orphan_count).toBe(3)
      expect(body.domain_distribution).toEqual({ entities: 8, concepts: 7 })
    })
  })

  describe('POST /api/v1/wiki/ingest', () => {
    it('enqueues ingest job with valid UUID', async () => {
      mockTriggerIngest.mockResolvedValue('job-123')

      const res = await app.request('/api/v1/wiki/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ captureId: '550e8400-e29b-41d4-a716-446655440000' }),
      })
      expect(res.status).toBe(202)
      const body = await res.json()
      expect(body.jobId).toBe('job-123')
      expect(body.status).toBe('enqueued')
    })

    it('returns 400 for invalid UUID', async () => {
      const res = await app.request('/api/v1/wiki/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ captureId: 'not-a-uuid' }),
      })
      expect(res.status).toBe(400)
    })

    it('returns 503 when queue not configured', async () => {
      mockTriggerIngest.mockResolvedValue(null)

      const res = await app.request('/api/v1/wiki/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ captureId: '550e8400-e29b-41d4-a716-446655440000' }),
      })
      expect(res.status).toBe(503)
    })
  })

  describe('POST /api/v1/wiki/lint', () => {
    it('enqueues lint job', async () => {
      mockTriggerLint.mockResolvedValue('lint-job-456')

      const res = await app.request('/api/v1/wiki/lint', { method: 'POST' })
      expect(res.status).toBe(202)
      const body = await res.json()
      expect(body.jobId).toBe('lint-job-456')
      expect(body.status).toBe('enqueued')
    })

    it('returns 503 when queue not configured', async () => {
      mockTriggerLint.mockResolvedValue(null)

      const res = await app.request('/api/v1/wiki/lint', { method: 'POST' })
      expect(res.status).toBe(503)
    })
  })
})
