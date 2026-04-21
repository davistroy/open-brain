import { join } from 'node:path'
import type Anthropic from '@anthropic-ai/sdk'
import type { Database } from '@open-brain/shared'
import {
  logger,
  PushoverService,
  TemplateCache,
  runAgent,
  resolveTaskModel,
  ModelResolverError,
} from '@open-brain/shared'
import type { AgentResult, WikiGitService, ConfigService } from '@open-brain/shared'
import { buildWikiTools } from './wiki-ingest.js'
import { BaseSkill } from './base-skill.js'
import type { BaseResult, BaseSkillOpts } from './types.js'

// ============================================================
// Types
// ============================================================

export interface WikiLintResult extends BaseResult {
  pagesScanned: number
  issuesFound: number
  reportPath: string
  agentIterations: number
  toolCalls: number
  notificationSent: boolean
  summary: string
}

export interface WikiLintOptions {
  /** Anthropic client instance (required for runAgent). */
  anthropicClient?: Anthropic
  /** Model override for tests. Production uses resolveTaskModel() via configService. */
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

// Task key used for ai-routing.yaml resolution.
const WIKI_LINT_TASK = 'wiki_lint'

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
 *
 * Model resolved at init via `resolveTaskModel(configService.get('ai'), 'wiki_lint')`.
 * The resolved model is used for `runAgent()` unless `options.model` overrides it
 * at execute() time. Constructor throws `ModelResolverError` (fail loud) if the
 * task key is missing from ai-routing.yaml — misconfiguration must surface at init,
 * not silently mid-run.
 */
/** Constructor options for WikiLintSkill. */
export interface WikiLintSkillOpts extends BaseSkillOpts {
  wikiService: WikiGitService
  anthropicClient?: Anthropic
  configService?: ConfigService
  model?: string
  maxIterations?: number
  promptsDir?: string
  templates?: TemplateCache
}

export class WikiLintSkill extends BaseSkill<void, WikiLintResult> {
  private wikiService: WikiGitService
  private templates: TemplateCache
  private anthropicClient?: Anthropic
  private maxIterations: number

  /** Resolved concrete model string (e.g. `claude-sonnet-4-6`). */
  private readonly resolvedModel: string | null
  /** Tier key the task resolved to (e.g. `t2_quality`). Logged for observability. */
  private readonly resolvedTierKey: string | null

  constructor(opts: WikiLintSkillOpts) {
    super('wiki-lint', opts)
    this.wikiService = opts.wikiService
    this.anthropicClient = opts.anthropicClient
    this.maxIterations = opts.maxIterations ?? 25
    this.templates = opts.templates ?? new TemplateCache(
      opts.promptsDir ?? join(process.cwd(), 'config', 'prompts'),
    )

    const configService = opts.configService ?? null
    if (configService) {
      const resolved = resolveTaskModel(configService.get('ai'), WIKI_LINT_TASK)
      this.resolvedModel = resolved.model
      this.resolvedTierKey = resolved.tierKey
      logger.info(
        { task: WIKI_LINT_TASK, model: resolved.model, tierKey: resolved.tierKey },
        '[wiki-lint] resolved task model at init',
      )
    } else {
      // No configService: accept opts.model as an explicit override (test injection path).
      this.resolvedModel = opts.model ?? null
      this.resolvedTierKey = null
    }
  }

  protected async run(_input?: void): Promise<WikiLintResult> {
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
    // Use the init-time resolved model. When configService is wired (production),
    // this comes from ai-routing.yaml task 'wiki_lint'. When configService is absent
    // (tests), opts.model is the explicit override stored in resolvedModel.
    const model = this.resolvedModel
    if (!model) {
      throw new ModelResolverError(
        `WikiLintSkill cannot determine model: no configService was passed at construction and no options.model override was supplied at execute() time. ` +
          `Wire ConfigService in main.ts (see workers/src/main.ts skill-execution registration).`,
        WIKI_LINT_TASK,
      )
    }

    let agentResult: AgentResult

    try {
      agentResult = await runAgent(
        systemPrompt,
        tools,
        'Please scan all wiki pages for quality issues and produce a lint report. Write the report to wiki/maintenance/lint-report.md.',
        {
          client: this.anthropicClient,
          model,
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
    const pushoverLines = [
      `Scanned ${pagesScanned} pages, found ${issuesFound} issue${issuesFound === 1 ? '' : 's'}.`,
    ]
    if (summary) {
      pushoverLines.push('', summary)
    }
    const notificationSent = await this.sendNotification(
      'Wiki Lint Report',
      pushoverLines.join('\n'),
      issuesFound > 0 ? 0 : -1,
    )

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

    await this.logResult(
      result,
      `scanned ${pagesScanned} wiki pages`,
      `issues:${issuesFound} report:${result.reportPath} iterations:${agentResult.iterations} tools:${agentResult.toolCalls.length}`,
    )

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
  return skill.execute(undefined)
}
