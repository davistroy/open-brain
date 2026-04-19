import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import type Anthropic from '@anthropic-ai/sdk'
import type { Database } from '@open-brain/shared'
import {
  captures,
  logger,
  TemplateCache,
  runAgent,
} from '@open-brain/shared'
import type { AgentTool, AgentResult } from '@open-brain/shared'
import type { WikiGitService, WikiFrontmatter } from '@open-brain/shared'
import { BaseSkill } from './base-skill.js'
import type { BaseResult, BaseSkillOpts } from './types.js'

// ============================================================
// Types
// ============================================================

export interface WikiIngestResult extends BaseResult {
  captureId: string
  pagesCreated: string[]
  pagesUpdated: string[]
  indexUpdated: boolean
  agentIterations: number
  toolCalls: number
  skipped: boolean
  skipReason?: string
}

export interface WikiIngestOptions {
  /** Anthropic client instance (required for runAgent). */
  anthropicClient?: Anthropic
  /** Model to use for the agent. Default: 'claude-haiku-4-5-20251001'. */
  model?: string
  /** Max agent iterations. Default: 15. */
  maxIterations?: number
  /** Directory containing prompt templates. */
  promptsDir?: string
  /** Template cache instance (shared). */
  templates?: TemplateCache
}

// ============================================================
// Wiki tools for runAgent()
// ============================================================

/**
 * Build wiki tools for the runAgent() loop. Each tool wraps a WikiGitService method.
 * Tool execution errors are caught by runAgent and reported to Claude for recovery.
 *
 * The WikiGitService `writePage` signature is:
 *   writePage(pagePath, content, frontmatter: WikiFrontmatter, commitMessage)
 *
 * The tools abstract away frontmatter handling — the LLM provides page type, title,
 * and tags; the tool constructs the proper WikiFrontmatter.
 */
export function buildWikiTools(wikiService: WikiGitService): AgentTool[] {
  return [
    {
      name: 'read_wiki_page',
      description: 'Read the contents of a wiki page by its path (e.g., "projects/open-brain.md"). Returns frontmatter metadata and markdown content, or a message if the page does not exist.',
      input_schema: {
        type: 'object' as const,
        properties: {
          path: {
            type: 'string',
            description: 'The wiki page path relative to the wiki root (e.g., "projects/open-brain.md")',
          },
        },
        required: ['path'],
      },
      execute: async (input: Record<string, unknown>): Promise<string> => {
        const path = input.path as string
        if (!path || typeof path !== 'string') {
          throw new Error('path is required and must be a string')
        }
        const page = await wikiService.readPage(path)
        if (page === null) {
          return `Page "${path}" does not exist.`
        }
        // Return frontmatter + content so the agent can see existing metadata
        const fmLines = Object.entries(page.frontmatter)
          .filter(([, v]) => v !== undefined && v !== '')
          .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
          .join('\n')
        return `--- Frontmatter ---\n${fmLines}\n--- Content ---\n${page.content}`
      },
    },
    {
      name: 'write_wiki_page',
      description: 'Create or update a wiki page. Provide the path, title, page type, tags, and the markdown body content. The page will be committed to the wiki Git repository with proper YAML frontmatter.',
      input_schema: {
        type: 'object' as const,
        properties: {
          path: {
            type: 'string',
            description: 'The wiki page path relative to the wiki root (e.g., "projects/open-brain.md")',
          },
          title: {
            type: 'string',
            description: 'Page title for frontmatter',
          },
          page_type: {
            type: 'string',
            enum: ['entity', 'concept', 'source', 'comparison', 'synthesis', 'overview'],
            description: 'Wiki page type. Use "entity" for people/projects/tools, "concept" for ideas/principles, "synthesis" for aggregated knowledge, "overview" for broad topics.',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Tags for the page (optional)',
          },
          content: {
            type: 'string',
            description: 'The markdown body content for the page (without frontmatter — that is handled automatically)',
          },
          commit_message: {
            type: 'string',
            description: 'Git commit message describing the change (optional, auto-generated if omitted)',
          },
        },
        required: ['path', 'title', 'page_type', 'content'],
      },
      execute: async (input: Record<string, unknown>): Promise<string> => {
        const path = input.path as string
        const title = input.title as string
        const pageType = input.page_type as WikiFrontmatter['type']
        const content = input.content as string
        const tags = Array.isArray(input.tags) ? input.tags.filter((t): t is string => typeof t === 'string') : undefined
        const commitMessage = (input.commit_message as string) || `wiki-ingest: update ${path}`

        if (!path || typeof path !== 'string') throw new Error('path is required')
        if (!title || typeof title !== 'string') throw new Error('title is required')
        if (!content || typeof content !== 'string') throw new Error('content is required')

        const now = new Date().toISOString().slice(0, 10)

        // Check if the page already exists to preserve the created date
        const existing = await wikiService.readPage(path)
        const createdDate = existing?.frontmatter?.created || now

        const frontmatter: WikiFrontmatter = {
          title,
          type: pageType,
          created: createdDate,
          updated: now,
          ...(tags ? { tags } : {}),
        }

        await wikiService.writePage(path, content, frontmatter, commitMessage)
        return `Page "${path}" written successfully.`
      },
    },
    {
      name: 'list_wiki_pages',
      description: 'List all wiki pages in the repository. Returns a formatted list showing each page path, title, and type.',
      input_schema: {
        type: 'object' as const,
        properties: {},
        required: [],
      },
      execute: async (): Promise<string> => {
        const pages = await wikiService.listPages()
        if (pages.length === 0) {
          return 'No wiki pages exist yet. You can create the first one with write_wiki_page.'
        }
        return pages
          .map((p) => `${p.path} — "${p.frontmatter.title}" (${p.frontmatter.type})`)
          .join('\n')
      },
    },
    {
      name: 'update_index',
      description: 'Update the wiki index page (index.md) with a new table of contents. Provide the full markdown body content for the index.',
      input_schema: {
        type: 'object' as const,
        properties: {
          content: {
            type: 'string',
            description: 'The full markdown body content for index.md (frontmatter is auto-generated)',
          },
        },
        required: ['content'],
      },
      execute: async (input: Record<string, unknown>): Promise<string> => {
        const content = input.content as string
        if (!content || typeof content !== 'string') {
          throw new Error('content is required and must be a string')
        }
        const now = new Date().toISOString().slice(0, 10)
        const existing = await wikiService.readPage('index.md')
        const frontmatter: WikiFrontmatter = {
          title: 'Wiki Index',
          type: 'overview',
          created: existing?.frontmatter?.created || now,
          updated: now,
        }
        await wikiService.writePage('index.md', content, frontmatter, 'wiki-ingest: update index')
        return 'index.md updated successfully.'
      },
    },
  ]
}

// ============================================================
// WikiIngestSkill class
// ============================================================

/** Constructor options for WikiIngestSkill (extends BaseSkillOpts with wiki/agent-specific params). */
export interface WikiIngestSkillOpts extends BaseSkillOpts {
  wikiService: WikiGitService
  anthropicClient?: Anthropic
  model?: string
  maxIterations?: number
  promptsDir?: string
  templates?: TemplateCache
}

/**
 * WikiIngestSkill — reads a capture and integrates its knowledge into the wiki
 * using an LLM agent with wiki tools.
 *
 * The skill:
 * 1. Fetches the capture from the database
 * 2. Renders the system prompt with capture context
 * 3. Runs an agent loop (runAgent) with wiki tools
 * 4. Tracks pages created/updated for logging
 * 5. Appends an entry to the wiki log.md
 * 6. Logs to skills_log table
 */
export class WikiIngestSkill extends BaseSkill<string, WikiIngestResult> {
  private wikiService: WikiGitService
  private templates: TemplateCache
  private anthropicClient?: Anthropic
  private model: string
  private maxIterations: number

  constructor(opts: WikiIngestSkillOpts) {
    super('wiki-ingest', opts)
    this.wikiService = opts.wikiService
    this.anthropicClient = opts.anthropicClient
    this.model = opts.model ?? 'claude-haiku-4-5-20251001'
    this.maxIterations = opts.maxIterations ?? 15
    this.templates = opts.templates ?? new TemplateCache(
      opts.promptsDir ?? join(process.cwd(), 'config', 'prompts'),
    )
  }

  protected async run(captureId: string): Promise<WikiIngestResult> {
    const startMs = Date.now()

    logger.info({ captureId }, '[wiki-ingest] starting execution')

    // ── Step 1: Fetch capture from database ─────────────────────────
    const rows = await this.db
      .select({
        id: captures.id,
        content: captures.content,
        capture_type: captures.capture_type,
        brain_view: captures.brain_view,
        tags: captures.tags,
        created_at: captures.created_at,
      })
      .from(captures)
      .where(eq(captures.id, captureId))
      .limit(1)

    const capture = rows[0]
    if (!capture) {
      logger.warn({ captureId }, '[wiki-ingest] capture not found — skipping')
      return makeSkippedResult(captureId, 'capture not found', Date.now() - startMs)
    }

    // Skip very short or empty captures — not worth wiki integration
    if (!capture.content || capture.content.trim().length < 20) {
      logger.info({ captureId }, '[wiki-ingest] capture too short — skipping')
      return makeSkippedResult(captureId, 'capture too short', Date.now() - startMs)
    }

    // ── Step 2: Build system prompt ─────────────────────────────────
    const dateStr = capture.created_at instanceof Date
      ? capture.created_at.toISOString().slice(0, 10)
      : String(capture.created_at).slice(0, 10)

    const systemPrompt = this.templates.render('wiki-ingest/system.txt', {
      capture_id: captureId,
      capture_type: capture.capture_type ?? 'observation',
      brain_view: capture.brain_view ?? 'personal',
      tags: capture.tags?.join(', ') || '(none)',
      date: dateStr,
      content: capture.content,
    })

    // ── Step 3: Build wiki tools ────────────────────────────────────
    const tools = buildWikiTools(this.wikiService)

    // ── Step 4: Run the agent loop ──────────────────────────────────
    let agentResult: AgentResult

    try {
      agentResult = await runAgent(
        systemPrompt,
        tools,
        'Please process this capture and integrate its knowledge into the wiki. Use the tools to read existing pages, create or update pages as needed, and update the index.',
        {
          client: this.anthropicClient,
          model: this.model,
          maxIterations: this.maxIterations,
          maxTokens: 4096,
          temperature: 0.3,
        },
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error({ captureId, err: msg }, '[wiki-ingest] agent loop failed')
      throw err // Let BullMQ retry
    }

    // ── Step 5: Analyze tool calls to determine what was done ───────
    const pagesCreated: string[] = []
    const pagesUpdated: string[] = []
    let indexUpdated = false

    for (const tc of agentResult.toolCalls) {
      if (tc.isError) continue

      if (tc.name === 'write_wiki_page') {
        const path = tc.input.path as string
        if (path && tc.result.includes('written successfully')) {
          // Heuristic: if the agent read the page first and it didn't exist, it's a create
          const wasRead = agentResult.toolCalls.some(
            (prev) =>
              prev.name === 'read_wiki_page' &&
              prev.input.path === path &&
              prev.result.includes('does not exist'),
          )
          if (wasRead) {
            pagesCreated.push(path)
          } else {
            pagesUpdated.push(path)
          }
        }
      }

      if (tc.name === 'update_index' && tc.result.includes('updated successfully')) {
        indexUpdated = true
      }
    }

    // ── Step 6: Append to wiki log.md ───────────────────────────────
    try {
      await this.appendWikiLog(captureId, dateStr, pagesCreated, pagesUpdated, indexUpdated)
    } catch (err) {
      // Log failure is non-fatal
      logger.warn({ captureId, err }, '[wiki-ingest] failed to append to wiki log.md')
    }

    // ── Step 7: Log to skills_log ───────────────────────────────────
    const durationMs = Date.now() - startMs
    const result: WikiIngestResult = {
      captureId,
      pagesCreated,
      pagesUpdated,
      indexUpdated,
      agentIterations: agentResult.iterations,
      toolCalls: agentResult.toolCalls.length,
      durationMs,
      skipped: false,
    }

    await this.logResult(
      result,
      `capture ${result.captureId}`,
      `created:${result.pagesCreated.length} updated:${result.pagesUpdated.length} index:${result.indexUpdated} iterations:${result.agentIterations} tools:${result.toolCalls}`,
      result.captureId,
    )

    logger.info(
      {
        captureId,
        pagesCreated: pagesCreated.length,
        pagesUpdated: pagesUpdated.length,
        indexUpdated,
        iterations: agentResult.iterations,
        toolCalls: agentResult.toolCalls.length,
        durationMs,
      },
      '[wiki-ingest] execution complete',
    )

    return result
  }

  // ──────────────────────────────────────────────────────────────────
  // Private: wiki log.md
  // ──────────────────────────────────────────────────────────────────

  private async appendWikiLog(
    captureId: string,
    date: string,
    created: string[],
    updated: string[],
    indexUpdated: boolean,
  ): Promise<void> {
    const timestamp = new Date().toISOString()
    const lines: string[] = [
      '',
      `## ${timestamp}`,
      `- **Capture:** ${captureId}`,
      `- **Date:** ${date}`,
    ]

    if (created.length > 0) {
      lines.push(`- **Pages created:** ${created.join(', ')}`)
    }
    if (updated.length > 0) {
      lines.push(`- **Pages updated:** ${updated.join(', ')}`)
    }
    if (indexUpdated) {
      lines.push('- **Index updated:** yes')
    }
    if (created.length === 0 && updated.length === 0) {
      lines.push('- **Result:** No wiki changes needed')
    }

    const logEntry = lines.join('\n') + '\n'

    // Read existing log, append, write back
    const existingPage = await this.wikiService.readPage('log.md')
    const existingContent = existingPage?.content ?? '# Wiki Ingest Log\n'
    const newContent = existingContent + logEntry
    const now = new Date().toISOString().slice(0, 10)
    const logFrontmatter: WikiFrontmatter = {
      title: 'Wiki Ingest Log',
      type: 'overview',
      created: existingPage?.frontmatter?.created || now,
      updated: now,
    }
    await this.wikiService.writePage('log.md', newContent, logFrontmatter, `wiki-ingest: log entry for capture ${captureId}`)
  }

}

// ============================================================
// Helpers
// ============================================================

function makeSkippedResult(captureId: string, reason: string, durationMs: number): WikiIngestResult {
  return {
    captureId,
    pagesCreated: [],
    pagesUpdated: [],
    indexUpdated: false,
    agentIterations: 0,
    toolCalls: 0,
    durationMs,
    skipped: true,
    skipReason: reason,
  }
}

// ============================================================
// Top-level entry point — called by BullMQ worker dispatcher
// ============================================================

/**
 * Top-level entry point called by the wiki-ingest BullMQ worker.
 *
 * The wikiService and anthropicClient must be provided by the caller
 * (the skill-execution worker or a dedicated wiki-ingest worker).
 */
export async function executeWikiIngest(
  db: Database,
  captureId: string,
  wikiService: WikiGitService,
  options: WikiIngestOptions = {},
): Promise<WikiIngestResult> {
  const skill = new WikiIngestSkill({
    db,
    wikiService,
    anthropicClient: options.anthropicClient,
    model: options.model,
    maxIterations: options.maxIterations,
    promptsDir: options.promptsDir,
    templates: options.templates,
  })
  return skill.execute(captureId)
}
