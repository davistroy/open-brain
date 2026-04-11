import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  searchWikiTool,
  readWikiPageTool,
  writeWikiPageTool,
  listWikiPagesTool,
} from '../mcp/tools/wiki-tools.js'
import type { WikiService, WikiPageSummary, WikiSearchResult } from '../services/wiki.js'
import type { WikiPage, WikiFrontmatter } from '@open-brain/shared'

// ---------------------------------------------------------------------------
// Mock WikiService
// ---------------------------------------------------------------------------

const mockListPages = vi.fn()
const mockGetPage = vi.fn()
const mockSearch = vi.fn()
const mockWritePage = vi.fn().mockResolvedValue(undefined)

function createMockWikiService(): WikiService {
  return {
    listPages: mockListPages,
    getPage: mockGetPage,
    search: mockSearch,
    writePage: mockWritePage,
    init: vi.fn(),
    isReady: vi.fn().mockReturnValue(true),
    getRecentChanges: vi.fn(),
    getLintReport: vi.fn(),
    triggerIngest: vi.fn(),
    triggerLint: vi.fn(),
  } as unknown as WikiService
}

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MCP Wiki Tools', () => {
  let wikiService: WikiService

  beforeEach(() => {
    vi.clearAllMocks()
    wikiService = createMockWikiService()
  })

  describe('search_wiki', () => {
    it('returns formatted results', async () => {
      const results: WikiSearchResult[] = [
        {
          path: 'entities/k8s.md',
          frontmatter: makeFrontmatter({ title: 'Kubernetes', tags: ['infra'] }),
          snippet: '...container orchestration platform...',
        },
      ]
      mockSearch.mockResolvedValue(results)

      const output = await searchWikiTool({ query: 'kubernetes' }, wikiService)
      expect(output).toContain('Wiki search: "kubernetes"')
      expect(output).toContain('1 page')
      expect(output).toContain('Kubernetes')
      expect(output).toContain('entities/k8s.md')
      expect(output).toContain('infra')
    })

    it('returns message when no results', async () => {
      mockSearch.mockResolvedValue([])
      const output = await searchWikiTool({ query: 'nonexistent' }, wikiService)
      expect(output).toContain('No wiki pages found')
    })
  })

  describe('read_wiki_page', () => {
    it('returns formatted page content', async () => {
      const page: WikiPage = {
        path: 'entities/k8s.md',
        frontmatter: makeFrontmatter({
          title: 'Kubernetes',
          source_count: 5,
          tags: ['infra', 'containers'],
          aliases: ['k8s'],
        }),
        content: 'Kubernetes is a container orchestration platform.',
      }
      mockGetPage.mockResolvedValue(page)

      const output = await readWikiPageTool({ path: 'entities/k8s.md' }, wikiService)
      expect(output).toContain('# Kubernetes')
      expect(output).toContain('**Type:** entity')
      expect(output).toContain('**Sources:** 5')
      expect(output).toContain('**Tags:** infra, containers')
      expect(output).toContain('**Aliases:** k8s')
      expect(output).toContain('container orchestration platform')
    })

    it('returns not found message', async () => {
      mockGetPage.mockResolvedValue(null)
      const output = await readWikiPageTool({ path: 'entities/missing.md' }, wikiService)
      expect(output).toContain('not found')
    })
  })

  describe('write_wiki_page', () => {
    it('creates a new page', async () => {
      mockGetPage.mockResolvedValue(null)
      const output = await writeWikiPageTool(
        {
          path: 'concepts/new.md',
          title: 'New Concept',
          type: 'concept',
          content: 'Content here.',
          tags: ['test'],
        },
        wikiService,
      )

      expect(output).toContain('created successfully')
      expect(output).toContain('concepts/new.md')
      expect(mockWritePage).toHaveBeenCalledWith(
        'concepts/new.md',
        'Content here.',
        expect.objectContaining({
          title: 'New Concept',
          type: 'concept',
          tags: ['test'],
        }),
        'wiki: create concepts/new.md',
      )
    })

    it('updates an existing page and preserves created date', async () => {
      mockGetPage.mockResolvedValue({
        path: 'entities/k8s.md',
        frontmatter: makeFrontmatter({ title: 'Old Title', created: '2026-01-01' }),
        content: 'Old content',
      })

      const output = await writeWikiPageTool(
        {
          path: 'entities/k8s.md',
          title: 'Kubernetes',
          type: 'entity',
          content: 'Updated content.',
          commit_message: 'Update k8s page',
        },
        wikiService,
      )

      expect(output).toContain('updated successfully')
      expect(mockWritePage).toHaveBeenCalledWith(
        'entities/k8s.md',
        'Updated content.',
        expect.objectContaining({
          created: '2026-01-01', // preserved from existing
        }),
        'Update k8s page',
      )
    })
  })

  describe('list_wiki_pages', () => {
    it('returns formatted page list', async () => {
      const pages: WikiPageSummary[] = [
        { path: 'entities/k8s.md', frontmatter: makeFrontmatter({ title: 'Kubernetes', tags: ['infra'] }) },
        { path: 'concepts/rag.md', frontmatter: makeFrontmatter({ title: 'RAG', type: 'concept' }) },
      ]
      mockListPages.mockResolvedValue(pages)

      const output = await listWikiPagesTool({}, wikiService)
      expect(output).toContain('2 found')
      expect(output).toContain('Kubernetes (entity)')
      expect(output).toContain('RAG (concept)')
      expect(output).toContain('[infra]')
    })

    it('passes type filter', async () => {
      mockListPages.mockResolvedValue([])
      await listWikiPagesTool({ type: 'entity' }, wikiService)
      expect(mockListPages).toHaveBeenCalledWith('entity', undefined)
    })

    it('passes tag filter', async () => {
      mockListPages.mockResolvedValue([])
      await listWikiPagesTool({ tag: 'ai' }, wikiService)
      expect(mockListPages).toHaveBeenCalledWith(undefined, 'ai')
    })

    it('returns message when empty', async () => {
      mockListPages.mockResolvedValue([])
      const output = await listWikiPagesTool({ type: 'comparison' }, wikiService)
      expect(output).toContain('No wiki pages found')
      expect(output).toContain('type=comparison')
    })
  })
})
