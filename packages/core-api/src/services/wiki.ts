/**
 * WikiService — application-layer wrapper around WikiGitService.
 *
 * Provides: page listing with filters, page retrieval, search (grep-like
 * over page content), recent changes from git log, lint report reading,
 * and BullMQ job triggers for wiki-ingest and wiki-lint.
 *
 * Concurrency: WikiGitService requires serialized git access. Read operations
 * are safe to call concurrently (no git mutations). Write operations (ingest,
 * lint) are dispatched as BullMQ jobs with concurrency=1 on the worker side.
 */

import type { Queue } from 'bullmq'
import {
  WikiGitService,
  type WikiPage,
  type WikiFrontmatter,
  type WikiChange,
  type WikiGitServiceOptions,
} from '@open-brain/shared'
import { createLogger } from '@open-brain/shared'

const logger = createLogger('wiki-service')

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Page summary returned from list (no body content). */
export interface WikiPageSummary {
  path: string
  frontmatter: WikiFrontmatter
}

export interface WikiSearchResult {
  path: string
  frontmatter: WikiFrontmatter
  /** Snippet of content around the match. */
  snippet: string
}

// ---------------------------------------------------------------------------
// WikiService
// ---------------------------------------------------------------------------

export interface WikiServiceOptions extends WikiGitServiceOptions {
  /** BullMQ queue for wiki-ingest jobs (optional — manual trigger disabled when missing). */
  wikiIngestQueue?: Queue
  /** BullMQ queue for wiki-lint jobs (optional — manual trigger disabled when missing). */
  wikiLintQueue?: Queue
}

export class WikiService {
  private readonly git: WikiGitService
  private readonly wikiIngestQueue?: Queue
  private readonly wikiLintQueue?: Queue
  private initialized = false

  constructor(opts: WikiServiceOptions) {
    this.git = new WikiGitService({
      repoUrl: opts.repoUrl,
      localPath: opts.localPath,
    })
    this.wikiIngestQueue = opts.wikiIngestQueue
    this.wikiLintQueue = opts.wikiLintQueue
  }

  /** Initialize the underlying git repo (clone or pull). */
  async init(): Promise<void> {
    await this.git.init()
    this.initialized = true
    logger.info('WikiService initialized')
  }

  /** Check if wiki is initialized and available. */
  isReady(): boolean {
    return this.initialized
  }

  /** Get repo sync status for health reporting. Delegates to WikiGitService.getStatus(). */
  async getStatus() {
    return this.git.getStatus()
  }

  // -------------------------------------------------------------------------
  // Read operations
  // -------------------------------------------------------------------------

  /**
   * List wiki pages with optional filters.
   * @param type Filter by frontmatter type (entity, concept, etc.)
   * @param tag Filter by tag presence in frontmatter tags array
   */
  async listPages(type?: string, tag?: string): Promise<WikiPageSummary[]> {
    this.ensureReady()
    const pages = await this.git.listPages()

    let filtered = pages
    if (type) {
      filtered = filtered.filter((p) => p.frontmatter.type === type)
    }
    if (tag) {
      const tagLower = tag.toLowerCase()
      filtered = filtered.filter(
        (p) => p.frontmatter.tags?.some((t) => t.toLowerCase() === tagLower),
      )
    }

    return filtered.map((p) => ({
      path: p.path,
      frontmatter: p.frontmatter,
    }))
  }

  /**
   * Get a single wiki page by path.
   * @param pagePath Relative path (e.g. "entities/kubernetes.md")
   */
  async getPage(pagePath: string): Promise<WikiPage | null> {
    this.ensureReady()
    return this.git.readPage(pagePath)
  }

  /**
   * Get recent changes from git log.
   * @param limit Maximum number of log entries (default 20)
   */
  async getRecentChanges(limit = 20): Promise<WikiChange[]> {
    this.ensureReady()
    return this.git.getRecentChanges(limit)
  }

  /**
   * Read the lint report from wiki/maintenance/lint-report.md.
   * Returns the raw markdown content, or null if no report exists.
   */
  async getLintReport(): Promise<string | null> {
    this.ensureReady()
    const page = await this.git.readPage('maintenance/lint-report.md')
    if (!page) return null
    return page.content
  }

  /**
   * Search across wiki page content (case-insensitive substring match).
   * Scans all .md files and returns matches with snippets.
   *
   * For small wikis (<200 pages) this is efficient enough.
   * For larger wikis, switch to a FTS index.
   */
  async search(query: string): Promise<WikiSearchResult[]> {
    this.ensureReady()
    if (!query.trim()) return []

    const allPages = await this.git.listPages()
    const results: WikiSearchResult[] = []
    const queryLower = query.toLowerCase()

    for (const pageSummary of allPages) {
      // Check frontmatter fields first (title, tags)
      const titleMatch = pageSummary.frontmatter.title.toLowerCase().includes(queryLower)
      const tagMatch = pageSummary.frontmatter.tags?.some((t) =>
        t.toLowerCase().includes(queryLower),
      )

      // Read full content for body search
      const fullPage = await this.git.readPage(pageSummary.path)
      if (!fullPage) continue

      const contentLower = fullPage.content.toLowerCase()
      const contentMatch = contentLower.includes(queryLower)

      if (titleMatch || tagMatch || contentMatch) {
        let snippet = ''
        if (contentMatch) {
          snippet = this.extractSnippet(fullPage.content, queryLower)
        } else if (titleMatch) {
          snippet = fullPage.content.slice(0, 200).trim()
        } else {
          snippet = fullPage.content.slice(0, 200).trim()
        }

        results.push({
          path: pageSummary.path,
          frontmatter: pageSummary.frontmatter,
          snippet,
        })
      }
    }

    return results
  }

  // -------------------------------------------------------------------------
  // Write operations (via WikiGitService directly)
  // -------------------------------------------------------------------------

  /**
   * Write a wiki page directly (auto-commits and pushes).
   * Used by MCP write_wiki_page tool.
   */
  async writePage(
    pagePath: string,
    content: string,
    frontmatter: WikiFrontmatter,
    commitMessage: string,
  ): Promise<void> {
    this.ensureReady()
    await this.git.writePage(pagePath, content, frontmatter, commitMessage)
    logger.info({ pagePath }, 'Wiki page written via WikiService')
  }

  // -------------------------------------------------------------------------
  // BullMQ job triggers
  // -------------------------------------------------------------------------

  /**
   * Enqueue a wiki-ingest job for a specific capture.
   * @returns Job ID or null if queue not configured.
   */
  async triggerIngest(captureId: string): Promise<string | null> {
    if (!this.wikiIngestQueue) {
      logger.warn('Wiki ingest queue not configured — cannot trigger ingest')
      return null
    }

    const job = await this.wikiIngestQueue.add(
      'wiki-ingest',
      { captureId },
      {
        jobId: `wiki-ingest_${captureId}`,
        removeOnComplete: 100,
        removeOnFail: 50,
      },
    )

    logger.info({ captureId, jobId: job.id }, 'Wiki ingest job enqueued')
    return job.id ?? null
  }

  /**
   * Enqueue a wiki-lint job.
   * @returns Job ID or null if queue not configured.
   */
  async triggerLint(): Promise<string | null> {
    if (!this.wikiLintQueue) {
      logger.warn('Wiki lint queue not configured — cannot trigger lint')
      return null
    }

    const job = await this.wikiLintQueue.add(
      'wiki-lint',
      { triggeredAt: new Date().toISOString() },
      {
        jobId: `wiki-lint_${Date.now()}`,
        removeOnComplete: 100,
        removeOnFail: 50,
      },
    )

    logger.info({ jobId: job.id }, 'Wiki lint job enqueued')
    return job.id ?? null
  }

  /**
   * Enqueue a wiki re-synthesis job for a specific page.
   * Uses the skill-execution queue to run wiki-ingest with the page path.
   * @returns Job ID or null if queue not configured.
   */
  async triggerResynthesize(pagePath: string): Promise<string | null> {
    if (!this.wikiIngestQueue) {
      logger.warn('Wiki ingest queue not configured — cannot trigger resynthesize')
      return null
    }

    const job = await this.wikiIngestQueue.add(
      'wiki-ingest',
      { pagePath, resynthesize: true },
      {
        jobId: `wiki-resynthesize_${pagePath.replace(/\//g, '_')}_${Date.now()}`,
        removeOnComplete: 100,
        removeOnFail: 50,
      },
    )

    logger.info({ pagePath, jobId: job.id }, 'Wiki resynthesize job enqueued')
    return job.id ?? null
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private ensureReady(): void {
    if (!this.initialized) {
      throw new Error('WikiService not initialized — call init() first')
    }
  }

  /**
   * Extract a snippet around a query match in content.
   * Returns ~200 chars centered on the first occurrence.
   */
  private extractSnippet(content: string, queryLower: string): string {
    const idx = content.toLowerCase().indexOf(queryLower)
    if (idx === -1) return content.slice(0, 200).trim()

    const contextChars = 100
    const start = Math.max(0, idx - contextChars)
    const end = Math.min(content.length, idx + queryLower.length + contextChars)

    let snippet = content.slice(start, end).trim()
    if (start > 0) snippet = '…' + snippet
    if (end < content.length) snippet = snippet + '…'

    return snippet
  }
}
