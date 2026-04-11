import { join } from 'node:path'
import type Anthropic from '@anthropic-ai/sdk'
import type { Database } from '@open-brain/shared'
import {
  skills_log,
  logger,
  PushoverService,
  TemplateCache,
  runAgent,
} from '@open-brain/shared'
import type { AgentResult, WikiGitService } from '@open-brain/shared'
import { buildWikiTools } from './wiki-ingest.js'

// ============================================================
// Types
// ============================================================

export interface WikiLintResult {
  pagesScanned: number
  issuesFound: number
  reportPath: string
  agentIterations: number
  toolCalls: number
  durationMs: number
  notificationSent: boolean
  summary: string
}

export interface WikiLintOptions {
  /** Anthropic client instance (required for runAgent). */
  anthropicClient?: Anthropic
  /** Model to use for the agent. Default: 'claude-sonnet-4-5-20250929'. */
  model?: string
  /** Max agent iterations. Default: 25 (wiki-lint reads many pages). */
  maxIterations?: number
  /** Directory containing prompt templates. */
  promptsDir?: string
  /** Template cache instance (shared). */
  templates?: TemplateCache
  /** Pushover service instance. */
  pushover?: PushoverService
}

// ============================================================
// WikiLintSkill class
// ============================================================

/**
 * WikiLintSkill — scans all wiki pages for quality issues using an LLM agent.
 *
 * Checks for: contradictions, orphan pages, stale claims, missing
 * cross-references, and structural issues. Writes a lint report to
 * wiki/maintenance/lint-report.md and sends a Pushover summary.
 *
 * Scheduled weekly (Sundays 5 AM) via BullMQ.
 */
export class WikiLintSkill {
  private db: Database
  private wikiService: WikiGitService
  private templates: TemplateCache
  private anthropicClient?: Anthropic
  private model: string
  private maxIterations: number
  private pushover: PushoverService

  constructor(opts: {
    db: Database
    wikiService: WikiGitService
    anthropicClient?: Anthropic
    model?: string
    maxIterations?: number
    promptsDir?: string
    templates?: TemplateCache
    pushover?: PushoverService
  }) {
    this.db = opts.db
    this.wikiService = opts.wikiService
    this.anthropicClient = opts.anthropicClient
    this.model = opts.model ?? 'claude-sonnet-4-5-20250929'
    this.maxIterations = opts.maxIterations ?? 25
    this.templates = opts.templates ?? new TemplateCache(
      opts.promptsDir ?? join(process.cwd(), 'config', 'prompts'),
    )
    this.pushover = opts.pushover ?? new PushoverService({ onError: 'throw' })
  }

  async execute(): Promise<WikiLintResult> {
    const startMs = Date.now()
    const dateStr = new Date().toISOString().slice(0, 10)

    logger.info('[wiki-lint] starting execution')

    // ── Step 1: Build system prompt ─────────────────────────────────
    const systemPrompt = this.templates.render('wiki-lint/system.txt', {
      date: dateStr,
    })

    // ── Step 2: Build wiki tools ────────────────────────────────────
    const tools = buildWikiTools(this.wikiService)

    // ── Step 3: Run the agent loop ──────────────────────────────────
    let agentResult: AgentResult

    try {
      agentResult = await runAgent(
        systemPrompt,
        tools,
        'Please scan all wiki pages for quality issues and produce a lint report. Write the report to wiki/maintenance/lint-report.md.',
        {
          client: this.anthropicClient,
          model: this.model,
          maxIterations: this.maxIterations,
          maxTokens: 8192,
          temperature: 0.2,
        },
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error({ err: msg }, '[wiki-lint] agent loop failed')
      throw err // Let BullMQ retry
    }

    // ── Step 4: Analyze results ─────────────────────────────────────
    const pagesScanned = countToolCalls(agentResult, 'read_wiki_page')
    const listCalls = countToolCalls(agentResult, 'list_wiki_pages')
    const reportWritten = agentResult.toolCalls.some(
      (tc) =>
        tc.name === 'write_wiki_page' &&
        !tc.isError &&
        typeof tc.input.path === 'string' &&
        tc.input.path.includes('lint-report'),
    )

    // Extract summary from agent's final text response
    const summary = extractSummary(agentResult.text)

    // Count issues from the agent text (heuristic — count bullet points in issues sections)
    const issuesFound = countIssues(agentResult.text)

    logger.info(
      {
        pagesScanned,
        listCalls,
        reportWritten,
        issuesFound,
        iterations: agentResult.iterations,
        toolCalls: agentResult.toolCalls.length,
      },
      '[wiki-lint] agent analysis complete',
    )

    // ── Step 5: Deliver Pushover notification ───────────────────────
    const notificationSent = await this.deliverPushover(pagesScanned, issuesFound, summary)

    // ── Step 6: Log to skills_log ───────────────────────────────────
    const durationMs = Date.now() - startMs
    const result: WikiLintResult = {
      pagesScanned,
      issuesFound,
      reportPath: 'wiki/maintenance/lint-report.md',
      agentIterations: agentResult.iterations,
      toolCalls: agentResult.toolCalls.length,
      durationMs,
      notificationSent,
      summary,
    }

    await this.logToSkillsLog(result)

    logger.info(
      {
        pagesScanned,
        issuesFound,
        reportWritten,
        notificationSent,
        durationMs,
      },
      '[wiki-lint] execution complete',
    )

    return result
  }

  // ──────────────────────────────────────────────────────────────────
  // Private: Pushover delivery
  // ──────────────────────────────────────────────────────────────────

  private async deliverPushover(
    pagesScanned: number,
    issuesFound: number,
    summary: string,
  ): Promise<boolean> {
    if (!this.pushover.isConfigured) return false

    const lines = [
      `Scanned ${pagesScanned} pages, found ${issuesFound} issue${issuesFound === 1 ? '' : 's'}.`,
    ]
    if (summary) {
      lines.push('', summary)
    }

    try {
      await this.pushover.send({
        title: 'Wiki Lint Report',
        message: lines.join('\n'),
        priority: issuesFound > 0 ? 0 : -1,
      })
      return true
    } catch {
      logger.warn('[wiki-lint] Pushover delivery failed')
      return false
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // Private: skills_log
  // ──────────────────────────────────────────────────────────────────

  private async logToSkillsLog(result: WikiLintResult): Promise<void> {
    try {
      await this.db.insert(skills_log).values({
        skill_name: 'wiki-lint',
        input_summary: `scanned ${result.pagesScanned} wiki pages`,
        output_summary: `issues:${result.issuesFound} report:${result.reportPath} iterations:${result.agentIterations} tools:${result.toolCalls}`,
        result: result as unknown as Record<string, unknown>,
        duration_ms: result.durationMs,
      })
    } catch {
      logger.warn('[wiki-lint] failed to write skills_log')
    }
  }
}

// ============================================================
// Helpers
// ============================================================

/** Count the number of calls to a specific tool in an agent result. */
function countToolCalls(result: AgentResult, toolName: string): number {
  return result.toolCalls.filter((tc) => tc.name === toolName && !tc.isError).length
}

/**
 * Extract a summary from the agent's final text response.
 * Looks for a "Summary" section or falls back to the first sentence.
 */
export function extractSummary(text: string): string {
  // Look for a summary section in the agent's text
  const summaryMatch = text.match(/(?:^|\n)##?\s*Summary\s*\n+([\s\S]*?)(?:\n##|\n$|$)/i)
  if (summaryMatch) {
    return summaryMatch[1].trim().slice(0, 300)
  }
  // Fall back to the first meaningful line
  const firstLine = text.split('\n').find((l) => l.trim().length > 10)
  return firstLine?.trim().slice(0, 300) ?? ''
}

/**
 * Heuristic: count issues from the agent's text by looking for bullet points
 * in issue sections (contradictions, orphans, stale, missing refs, structural).
 */
export function countIssues(text: string): number {
  // Match lines that look like issue items (- or * bullets under issue headers)
  const issueLines = text.match(/^[\s]*[-*]\s+.+$/gm)
  // Exclude lines that say "(none found)" or similar
  const filtered = issueLines?.filter(
    (line) => !line.match(/\(none\s+found\)/i) && !line.match(/no\s+issues/i),
  )
  return filtered?.length ?? 0
}

// ============================================================
// Top-level entry point — called by BullMQ worker dispatcher
// ============================================================

/**
 * Top-level entry point called by the skill-execution BullMQ worker.
 */
export async function executeWikiLint(
  db: Database,
  wikiService: WikiGitService,
  options: WikiLintOptions = {},
): Promise<WikiLintResult> {
  const skill = new WikiLintSkill({
    db,
    wikiService,
    anthropicClient: options.anthropicClient,
    model: options.model,
    maxIterations: options.maxIterations,
    promptsDir: options.promptsDir,
    templates: options.templates,
    pushover: options.pushover,
  })
  return skill.execute()
}
