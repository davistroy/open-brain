import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import type Anthropic from '@anthropic-ai/sdk'
import type { Database, AutonomyLevel, ConfigService } from '@open-brain/shared'
import {
  logger,
  TemplateCache,
  runAgent,
  resolveTaskModel,
  ModelResolverError,
} from '@open-brain/shared'
import type { AgentTool, AgentResult } from '@open-brain/shared'
import type { WikiGitService, WikiFrontmatter } from '@open-brain/shared'
import { EmailService } from '../services/email.js'
import { BaseSkill } from './base-skill.js'
import type { BaseResult, BaseSkillOpts } from './types.js'

/**
 * Task alias resolved at skill init via `resolveTaskModel()`.
 * Routes through `task_routing.monthly_reflection` in `config/ai-routing.yaml`.
 */
const MONTHLY_REFLECTION_TASK = 'monthly_reflection'

// ============================================================
// Types
// ============================================================

export interface MonthlyReflectionOutput {
  month_label: string
  headline: string
  career_momentum: {
    summary: string
    wins: string[]
    concerns: string[]
  }
  active_projects: {
    summary: string
    highlights: string[]
    stalled: string[]
  }
  technical_exploration: {
    summary: string
    themes: string[]
    depth_vs_breadth: string
  }
  personal_patterns: {
    summary: string
    positive_patterns: string[]
    watch_items: string[]
  }
  cross_domain_insights: string[]
  month_ahead_focus: string[]
  decisions_to_make: string[]
}

export interface MonthlyReflectionResult extends BaseResult {
  output: MonthlyReflectionOutput
  captureCount: number
  agentIterations: number
  toolCalls: number
  savedCaptureId: string | null
  emailSent: boolean
  wikiPageWritten: boolean
  notificationSent: boolean
}

export interface MonthlyReflectionOptions {
  /** Anthropic client instance (required for runAgent). */
  anthropicClient?: Anthropic
  /** Per-call model override (test escape hatch — production uses resolvedModel from configService). */
  model?: string
  /** Max agent iterations. Default: 10. */
  maxIterations?: number
  /** Email recipient override — falls back to WEEKLY_BRIEF_EMAIL env var */
  emailTo?: string
}

// ============================================================
// Constants
// ============================================================

const BRAIN_VIEWS = ['career', 'personal', 'technical', 'work-internal', 'client']
const MAX_CAPTURES_PER_VIEW = 200

// ============================================================
// Agent tools
// ============================================================

interface CaptureRow {
  [key: string]: unknown
  id: string
  content: string
  capture_type: string
  brain_view: string
  source: string
  tags: string[] | null
  created_at: string
}

interface EntityStatsRow {
  [key: string]: unknown
  name: string
  entity_type: string
  mention_count: string
}

/**
 * Build tools the agent uses to query the brain.
 * These are read-only query tools — the agent uses them to gather data
 * before producing its reflection output.
 */
export function buildReflectionTools(db: Database, windowStart: Date, windowEnd: Date): AgentTool[] {
  return [
    {
      name: 'query_captures_by_view',
      description: 'Query captures from a specific brain view within the reflection window. Returns captures ordered by date (newest first). Use this to examine each brain view.',
      input_schema: {
        type: 'object' as const,
        properties: {
          brain_view: {
            type: 'string',
            enum: BRAIN_VIEWS,
            description: 'The brain view to query',
          },
          limit: {
            type: 'number',
            description: 'Max captures to return (default: 100, max: 200)',
          },
        },
        required: ['brain_view'],
      },
      execute: async (input: Record<string, unknown>): Promise<string> => {
        const view = input.brain_view as string
        if (!view || !BRAIN_VIEWS.includes(view)) {
          throw new Error(`brain_view must be one of: ${BRAIN_VIEWS.join(', ')}`)
        }
        const limit = Math.min(
          Math.max(1, typeof input.limit === 'number' ? input.limit : 100),
          MAX_CAPTURES_PER_VIEW,
        )

        const result = await db.execute<CaptureRow>(sql`
          SELECT id::text, content, capture_type, brain_view, source, tags, created_at::text
          FROM captures
          WHERE deleted_at IS NULL
            AND pipeline_status = 'complete'
            AND brain_view = ${view}
            AND created_at >= ${windowStart.toISOString()}::timestamptz
            AND created_at <= ${windowEnd.toISOString()}::timestamptz
          ORDER BY created_at DESC
          LIMIT ${limit}
        `)

        if (result.rows.length === 0) {
          return `No captures found for brain view "${view}" in the reflection window.`
        }

        const lines = result.rows.map((r) => {
          const date = typeof r.created_at === 'string' ? r.created_at.split('T')[0] : ''
          const tags = r.tags?.length ? ` [${r.tags.join(', ')}]` : ''
          return `[${date}] [${r.capture_type}]${tags} ${r.content}`
        })

        return `${result.rows.length} captures for "${view}":\n\n${lines.join('\n')}`
      },
    },
    {
      name: 'get_capture_stats',
      description: 'Get summary statistics for the reflection window: capture counts by brain view and capture type.',
      input_schema: {
        type: 'object' as const,
        properties: {},
        required: [],
      },
      execute: async (): Promise<string> => {
        const byView = await db.execute<{ brain_view: string; cnt: string }>(sql`
          SELECT brain_view, COUNT(*)::text AS cnt
          FROM captures
          WHERE deleted_at IS NULL
            AND pipeline_status = 'complete'
            AND created_at >= ${windowStart.toISOString()}::timestamptz
            AND created_at <= ${windowEnd.toISOString()}::timestamptz
          GROUP BY brain_view
          ORDER BY cnt DESC
        `)

        const byType = await db.execute<{ capture_type: string; cnt: string }>(sql`
          SELECT capture_type, COUNT(*)::text AS cnt
          FROM captures
          WHERE deleted_at IS NULL
            AND pipeline_status = 'complete'
            AND created_at >= ${windowStart.toISOString()}::timestamptz
            AND created_at <= ${windowEnd.toISOString()}::timestamptz
          GROUP BY capture_type
          ORDER BY cnt DESC
        `)

        const total = byView.rows.reduce((sum, r) => sum + parseInt(r.cnt, 10), 0)

        const viewLines = byView.rows.map((r) => `  ${r.brain_view}: ${r.cnt}`).join('\n')
        const typeLines = byType.rows.map((r) => `  ${r.capture_type}: ${r.cnt}`).join('\n')

        return `Total captures: ${total}\n\nBy brain view:\n${viewLines}\n\nBy capture type:\n${typeLines}`
      },
    },
    {
      name: 'get_top_entities',
      description: 'Get the most-mentioned entities in captures from the reflection window. Useful for identifying dominant themes and active projects.',
      input_schema: {
        type: 'object' as const,
        properties: {
          limit: {
            type: 'number',
            description: 'Max entities to return (default: 20, max: 50)',
          },
        },
        required: [],
      },
      execute: async (input: Record<string, unknown>): Promise<string> => {
        const limit = Math.min(
          Math.max(1, typeof input.limit === 'number' ? input.limit : 20),
          50,
        )

        const result = await db.execute<EntityStatsRow>(sql`
          SELECT e.name, e.entity_type, COUNT(el.id)::text AS mention_count
          FROM entities e
          JOIN entity_links el ON el.entity_id = e.id
          JOIN captures c ON c.id = el.capture_id
          WHERE c.deleted_at IS NULL
            AND c.pipeline_status = 'complete'
            AND c.created_at >= ${windowStart.toISOString()}::timestamptz
            AND c.created_at <= ${windowEnd.toISOString()}::timestamptz
          GROUP BY e.id, e.name, e.entity_type
          ORDER BY COUNT(el.id) DESC
          LIMIT ${limit}
        `)

        if (result.rows.length === 0) {
          return 'No entity links found in the reflection window.'
        }

        const lines = result.rows.map(
          (r) => `${r.name} (${r.entity_type}): ${r.mention_count} mentions`,
        )
        return `Top entities (${result.rows.length}):\n\n${lines.join('\n')}`
      },
    },
  ]
}

// ============================================================
// MonthlyReflectionSkill class
// ============================================================

/**
 * MonthlyReflectionSkill — uses runAgent() to query captures across all brain views
 * for the past 30 days and produce a comprehensive "state of Troy" synthesis.
 *
 * Output is:
 * 1. Filed as a wiki page (if WikiGitService configured)
 * 2. Sent as HTML email (if SMTP configured)
 * 3. Saved back as a capture (source: api, type: reflection)
 * 4. Pushover notification
 * 5. Logged to skills_log
 */
/** Constructor options for MonthlyReflectionSkill. */
export interface MonthlyReflectionSkillOpts extends BaseSkillOpts {
  anthropicClient?: Anthropic
  configService?: ConfigService
  wikiService?: WikiGitService
  email?: EmailService
  promptsDir?: string
  coreApiUrl?: string
  templates?: TemplateCache
  maxIterations?: number
}

export class MonthlyReflectionSkill extends BaseSkill<MonthlyReflectionOptions, MonthlyReflectionResult> {
  static minimum_autonomy: AutonomyLevel = 'assist'

  private email: EmailService
  private templates: TemplateCache
  private coreApiUrl: string
  private anthropicClient?: Anthropic
  private wikiService?: WikiGitService
  /** Resolved concrete model string (e.g. `claude-sonnet-4-6`). */
  private readonly resolvedModel: string | null
  /** Tier key the task resolved to (e.g. `t2_quality`). Logged for observability. */
  private readonly resolvedTierKey: string | null
  private maxIterations: number

  constructor(opts: MonthlyReflectionSkillOpts) {
    super('monthly-reflection', opts)
    this.anthropicClient = opts.anthropicClient
    this.wikiService = opts.wikiService
    this.email = opts.email ?? new EmailService()
    this.templates = opts.templates ?? new TemplateCache(
      opts.promptsDir ?? join(process.cwd(), 'config', 'prompts'),
    )
    this.coreApiUrl = opts.coreApiUrl ?? process.env.OPEN_BRAIN_API_URL ?? 'http://localhost:3000'
    this.maxIterations = opts.maxIterations ?? 10

    const configService = opts.configService ?? null
    if (configService) {
      const resolved = resolveTaskModel(configService.get('ai'), MONTHLY_REFLECTION_TASK)
      this.resolvedModel = resolved.model
      this.resolvedTierKey = resolved.tierKey
      logger.info(
        { task: MONTHLY_REFLECTION_TASK, model: resolved.model, tierKey: resolved.tierKey },
        '[monthly-reflection] resolved task model at init',
      )
    } else {
      this.resolvedModel = null
      this.resolvedTierKey = null
    }
  }

  protected async run(options: MonthlyReflectionOptions = {}): Promise<MonthlyReflectionResult> {
    const startMs = Date.now()
    const now = new Date()
    const windowStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
    const emailTo = options.emailTo ?? process.env.WEEKLY_BRIEF_EMAIL
    // Prefer the init-time resolved model. `options.model` is a per-call
    // override (discouraged in production; useful only for tool-level tests).
    const model = options.model ?? this.resolvedModel
    if (!model) {
      throw new ModelResolverError(
        `MonthlyReflectionSkill cannot determine model: no configService was passed at construction and no options.model override was supplied at execute() time. ` +
          `Wire ConfigService in main.ts (see workers/src/main.ts skill-execution registration).`,
        MONTHLY_REFLECTION_TASK,
      )
    }

    const monthLabel = formatMonthLabel(now)
    logger.info({ monthLabel, windowStart: windowStart.toISOString() }, '[monthly-reflection] starting execution')

    // ── Step 1: Build system prompt ──────────────────────────────
    const systemPrompt = this.templates.render('monthly-reflection/system.txt', {})

    // ── Step 2: Build tools ──────────────────────────────────────
    const tools = buildReflectionTools(this.db, windowStart, now)

    // ── Step 3: Run agent ────────────────────────────────────────
    const userMessage = `Generate the monthly reflection for ${monthLabel}. ` +
      `The reflection window is ${fmtDate(windowStart)} to ${fmtDate(now)}. ` +
      `Start by getting capture stats to understand the overall picture, then query each brain view to examine the details. ` +
      `Also check top entities to identify dominant themes. ` +
      `After gathering sufficient data, produce your reflection as the JSON object described in your instructions.`

    let agentResult: AgentResult
    try {
      agentResult = await runAgent(
        systemPrompt,
        tools,
        userMessage,
        {
          client: options.anthropicClient ?? this.anthropicClient,
          model,
          maxIterations: options.maxIterations ?? this.maxIterations,
          maxTokens: 8192,
          temperature: 0.4,
        },
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error({ err: msg }, '[monthly-reflection] agent loop failed')
      throw err
    }

    // ── Step 4: Parse output ─────────────────────────────────────
    const output = parseOutput(agentResult.text, monthLabel)
    const captureCount = countCapturesFromToolCalls(agentResult)

    // ── Step 5: File as wiki page ────────────────────────────────
    const wikiPageWritten = await this.writeWikiPage(output, now)

    // ── Step 6: Send email ───────────────────────────────────────
    const emailSent = await this.deliverEmail(output, emailTo)

    // ── Step 7: Save as capture ──────────────────────────────────
    const savedCaptureId = await this.saveReflectionCapture(output)

    // ── Step 8: Pushover notification ────────────────────────────
    const notificationSent = await this.deliverPushover(output)

    // ── Step 9: Log to skills_log ────────────────────────────────
    const durationMs = Date.now() - startMs
    const result: MonthlyReflectionResult = {
      output,
      captureCount,
      agentIterations: agentResult.iterations,
      toolCalls: agentResult.toolCalls.length,
      durationMs,
      savedCaptureId,
      emailSent,
      wikiPageWritten,
      notificationSent,
    }

    await this.logResult(
      result,
      `${captureCount} captures across 30 days | ${output.month_label}`,
      `headline: "${output.headline}" | email:${emailSent} wiki:${wikiPageWritten} | iterations:${agentResult.iterations} tools:${agentResult.toolCalls.length}`,
      savedCaptureId ?? undefined,
    )

    logger.info(
      {
        monthLabel,
        captureCount,
        iterations: agentResult.iterations,
        toolCalls: agentResult.toolCalls.length,
        durationMs,
        emailSent,
        wikiPageWritten,
        savedCaptureId,
        notificationSent,
      },
      '[monthly-reflection] execution complete',
    )

    return result
  }

  // ----------------------------------------------------------
  // Private: Wiki page
  // ----------------------------------------------------------

  private async writeWikiPage(output: MonthlyReflectionOutput, date: Date): Promise<boolean> {
    if (!this.wikiService) return false

    const yearMonth = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
    const pagePath = `synthesis/reflections/${yearMonth}.md`
    const content = buildWikiMarkdown(output)

    try {
      const now = date.toISOString().slice(0, 10)
      const existing = await this.wikiService.readPage(pagePath)
      const frontmatter: WikiFrontmatter = {
        title: `Monthly Reflection - ${output.month_label}`,
        type: 'synthesis',
        created: existing?.frontmatter?.created || now,
        updated: now,
        tags: ['monthly-reflection', 'synthesis'],
      }
      await this.wikiService.writePage(
        pagePath,
        content,
        frontmatter,
        `monthly-reflection: ${output.month_label}`,
      )
      logger.info({ pagePath }, '[monthly-reflection] wiki page written')
      return true
    } catch (err) {
      logger.warn({ err, pagePath }, '[monthly-reflection] failed to write wiki page')
      return false
    }
  }

  // ----------------------------------------------------------
  // Private: Email delivery
  // ----------------------------------------------------------

  private async deliverEmail(output: MonthlyReflectionOutput, emailTo?: string): Promise<boolean> {
    if (!emailTo || !this.email.isConfigured) return false

    try {
      const htmlBody = renderEmailHtml(output)
      const textBody = renderEmailText(output)
      await this.email.send({
        to: emailTo,
        subject: `Open Brain Monthly Reflection - ${output.month_label}`,
        htmlBody,
        textBody,
      })
      logger.info({ emailTo }, '[monthly-reflection] email sent')
      return true
    } catch (err) {
      logger.warn({ err }, '[monthly-reflection] email delivery failed')
      return false
    }
  }

  // ----------------------------------------------------------
  // Private: Save as capture
  // ----------------------------------------------------------

  private async saveReflectionCapture(output: MonthlyReflectionOutput): Promise<string | null> {
    try {
      const content = buildCaptureText(output)
      const res = await fetch(`${this.coreApiUrl}/api/v1/captures`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Open-Brain-Caller': 'workers',
        },
        body: JSON.stringify({
          content,
          capture_type: 'reflection',
          brain_view: 'personal',
          source: 'api',
          tags: ['monthly-reflection', 'skill-output'],
          metadata: {
            source_metadata: {
              generator: 'monthly-reflection',
              month_label: output.month_label,
            },
          },
        }),
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok) return null
      const data = (await res.json()) as { id?: string; data?: { id?: string } }
      return data.id ?? data.data?.id ?? null
    } catch {
      return null
    }
  }

  // ----------------------------------------------------------
  // Private: Pushover
  // ----------------------------------------------------------

  private async deliverPushover(output: MonthlyReflectionOutput): Promise<boolean> {
    if (!this.pushover.isConfigured) return false

    try {
      const lines: string[] = [output.headline]

      if (output.month_ahead_focus.length > 0) {
        lines.push('', 'Next month focus:')
        for (const item of output.month_ahead_focus.slice(0, 3)) {
          lines.push(`  - ${item}`)
        }
      }

      if (output.decisions_to_make.length > 0) {
        lines.push('', 'Decisions needed:')
        for (const item of output.decisions_to_make.slice(0, 3)) {
          lines.push(`  - ${item}`)
        }
      }

      await this.pushover.send({
        title: `Monthly Reflection - ${output.month_label}`,
        message: lines.join('\n'),
        priority: 0,
      })
      return true
    } catch {
      return false
    }
  }

}

// ============================================================
// Top-level entry point
// ============================================================

/** Top-level entry point called by BullMQ worker. */
export async function executeMonthlyReflection(
  db: Database,
  options: MonthlyReflectionOptions & {
    wikiService?: WikiGitService
    promptsDir?: string
  } = {},
): Promise<MonthlyReflectionResult> {
  return new MonthlyReflectionSkill({
    db,
    anthropicClient: options.anthropicClient,
    wikiService: options.wikiService,
    promptsDir: options.promptsDir,
  }).execute(options)
}

// ============================================================
// Output parsing
// ============================================================

function emptyOutput(monthLabel: string): MonthlyReflectionOutput {
  return {
    month_label: monthLabel,
    headline: `Monthly reflection for ${monthLabel} — insufficient data`,
    career_momentum: { summary: '', wins: [], concerns: [] },
    active_projects: { summary: '', highlights: [], stalled: [] },
    technical_exploration: { summary: '', themes: [], depth_vs_breadth: '' },
    personal_patterns: { summary: '', positive_patterns: [], watch_items: [] },
    cross_domain_insights: [],
    month_ahead_focus: [],
    decisions_to_make: [],
  }
}

/**
 * Parses LLM JSON output into a MonthlyReflectionOutput.
 * Handles markdown code fences and malformed output gracefully.
 * Exported for testing.
 */
export function parseOutput(raw: string, monthLabel: string): MonthlyReflectionOutput {
  let cleaned = raw.trim()
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(cleaned)
  } catch (err) {
    logger.warn({ raw: raw.slice(0, 500), err }, '[monthly-reflection] failed to parse LLM output as JSON')
    return emptyOutput(monthLabel)
  }

  const safeStr = (val: unknown, fallback: string): string =>
    typeof val === 'string' && val.length > 0 ? val : fallback

  const safeStrArray = (val: unknown, maxItems = 5): string[] => {
    if (!Array.isArray(val)) return []
    return val
      .filter((item): item is string => typeof item === 'string')
      .slice(0, maxItems)
  }

  const safeSection = (val: unknown): {
    summary: string
    items1: string[]
    items2: string[]
    extra?: string
  } => {
    if (!val || typeof val !== 'object') {
      return { summary: '', items1: [], items2: [] }
    }
    const obj = val as Record<string, unknown>
    return {
      summary: safeStr(obj.summary, ''),
      items1: safeStrArray(Object.values(obj).find((v) => Array.isArray(v) && v !== Object.values(obj).find((v2) => Array.isArray(v2) && v2 !== v))),
      items2: [],
    }
  }

  // Parse nested sections with their specific field names
  const careerRaw = parsed.career_momentum as Record<string, unknown> | undefined
  const projectsRaw = parsed.active_projects as Record<string, unknown> | undefined
  const techRaw = parsed.technical_exploration as Record<string, unknown> | undefined
  const personalRaw = parsed.personal_patterns as Record<string, unknown> | undefined

  return {
    month_label: safeStr(parsed.month_label, monthLabel),
    headline: safeStr(parsed.headline, `Monthly reflection for ${monthLabel}`),
    career_momentum: {
      summary: safeStr(careerRaw?.summary, ''),
      wins: safeStrArray(careerRaw?.wins),
      concerns: safeStrArray(careerRaw?.concerns),
    },
    active_projects: {
      summary: safeStr(projectsRaw?.summary, ''),
      highlights: safeStrArray(projectsRaw?.highlights),
      stalled: safeStrArray(projectsRaw?.stalled),
    },
    technical_exploration: {
      summary: safeStr(techRaw?.summary, ''),
      themes: safeStrArray(techRaw?.themes),
      depth_vs_breadth: safeStr(techRaw?.depth_vs_breadth, ''),
    },
    personal_patterns: {
      summary: safeStr(personalRaw?.summary, ''),
      positive_patterns: safeStrArray(personalRaw?.positive_patterns),
      watch_items: safeStrArray(personalRaw?.watch_items),
    },
    cross_domain_insights: safeStrArray(parsed.cross_domain_insights),
    month_ahead_focus: safeStrArray(parsed.month_ahead_focus),
    decisions_to_make: safeStrArray(parsed.decisions_to_make),
  }
}

// ============================================================
// Helpers
// ============================================================

export function formatMonthLabel(date: Date): string {
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ]
  return `${months[date.getMonth()]} ${date.getFullYear()}`
}

export function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/**
 * Extract approximate total capture count from agent tool calls.
 * Looks at get_capture_stats results to find the total.
 */
function countCapturesFromToolCalls(agentResult: AgentResult): number {
  for (const tc of agentResult.toolCalls) {
    if (tc.name === 'get_capture_stats' && !tc.isError) {
      const match = tc.result.match(/Total captures:\s*(\d+)/)
      if (match) return parseInt(match[1], 10)
    }
  }
  return 0
}

// ============================================================
// Text rendering — wiki markdown
// ============================================================

function buildWikiMarkdown(output: MonthlyReflectionOutput): string {
  const lines: string[] = [
    `# Monthly Reflection - ${output.month_label}`,
    '',
    `> ${output.headline}`,
    '',
  ]

  // Career Momentum
  if (output.career_momentum.summary) {
    lines.push('## Career Momentum', '', output.career_momentum.summary, '')
    if (output.career_momentum.wins.length > 0) {
      lines.push('**Wins:**')
      for (const w of output.career_momentum.wins) lines.push(`- ${w}`)
      lines.push('')
    }
    if (output.career_momentum.concerns.length > 0) {
      lines.push('**Concerns:**')
      for (const c of output.career_momentum.concerns) lines.push(`- ${c}`)
      lines.push('')
    }
  }

  // Active Projects
  if (output.active_projects.summary) {
    lines.push('## Active Projects', '', output.active_projects.summary, '')
    if (output.active_projects.highlights.length > 0) {
      lines.push('**Highlights:**')
      for (const h of output.active_projects.highlights) lines.push(`- ${h}`)
      lines.push('')
    }
    if (output.active_projects.stalled.length > 0) {
      lines.push('**Stalled:**')
      for (const s of output.active_projects.stalled) lines.push(`- ${s}`)
      lines.push('')
    }
  }

  // Technical Exploration
  if (output.technical_exploration.summary) {
    lines.push('## Technical Exploration', '', output.technical_exploration.summary, '')
    if (output.technical_exploration.themes.length > 0) {
      lines.push('**Themes:**')
      for (const t of output.technical_exploration.themes) lines.push(`- ${t}`)
      lines.push('')
    }
    if (output.technical_exploration.depth_vs_breadth) {
      lines.push(`**Depth vs Breadth:** ${output.technical_exploration.depth_vs_breadth}`, '')
    }
  }

  // Personal Patterns
  if (output.personal_patterns.summary) {
    lines.push('## Personal Patterns', '', output.personal_patterns.summary, '')
    if (output.personal_patterns.positive_patterns.length > 0) {
      lines.push('**Positive Patterns:**')
      for (const p of output.personal_patterns.positive_patterns) lines.push(`- ${p}`)
      lines.push('')
    }
    if (output.personal_patterns.watch_items.length > 0) {
      lines.push('**Watch Items:**')
      for (const w of output.personal_patterns.watch_items) lines.push(`- ${w}`)
      lines.push('')
    }
  }

  // Cross-domain Insights
  if (output.cross_domain_insights.length > 0) {
    lines.push('## Cross-Domain Insights', '')
    for (const insight of output.cross_domain_insights) lines.push(`- ${insight}`)
    lines.push('')
  }

  // Month Ahead Focus
  if (output.month_ahead_focus.length > 0) {
    lines.push('## Month Ahead Focus', '')
    for (const item of output.month_ahead_focus) lines.push(`- ${item}`)
    lines.push('')
  }

  // Decisions to Make
  if (output.decisions_to_make.length > 0) {
    lines.push('## Decisions to Make', '')
    for (const d of output.decisions_to_make) lines.push(`- ${d}`)
    lines.push('')
  }

  return lines.join('\n').trim()
}

// ============================================================
// Text rendering — capture text
// ============================================================

function buildCaptureText(output: MonthlyReflectionOutput): string {
  const lines: string[] = [
    `Monthly Reflection - ${output.month_label}`,
    '',
    output.headline,
    '',
  ]

  const sections: Array<{ label: string; items: string[] }> = [
    { label: 'Career Wins', items: output.career_momentum.wins },
    { label: 'Career Concerns', items: output.career_momentum.concerns },
    { label: 'Project Highlights', items: output.active_projects.highlights },
    { label: 'Stalled Projects', items: output.active_projects.stalled },
    { label: 'Technical Themes', items: output.technical_exploration.themes },
    { label: 'Positive Patterns', items: output.personal_patterns.positive_patterns },
    { label: 'Watch Items', items: output.personal_patterns.watch_items },
    { label: 'Cross-Domain Insights', items: output.cross_domain_insights },
    { label: 'Month Ahead Focus', items: output.month_ahead_focus },
    { label: 'Decisions to Make', items: output.decisions_to_make },
  ]

  for (const section of sections) {
    if (section.items.length > 0) {
      lines.push(`${section.label}:`)
      for (const item of section.items) lines.push(`- ${item}`)
      lines.push('')
    }
  }

  return lines.join('\n').trim()
}

// ============================================================
// Email rendering
// ============================================================

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function htmlList(items: string[]): string {
  if (items.length === 0) return ''
  return `<ul>${items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>`
}

function htmlSection(title: string, summary: string, subsections: Array<{ label: string; items: string[] }>, extra?: string): string {
  if (!summary && subsections.every((s) => s.items.length === 0) && !extra) return ''
  let html = `<h2 style="color:#1a1a1a;border-bottom:1px solid #e5e5e5;padding-bottom:8px">${escapeHtml(title)}</h2>`
  if (summary) html += `<p style="color:#333">${escapeHtml(summary)}</p>`
  for (const sub of subsections) {
    if (sub.items.length > 0) {
      html += `<h3 style="color:#555;font-size:14px;margin-top:16px">${escapeHtml(sub.label)}</h3>${htmlList(sub.items)}`
    }
  }
  if (extra) html += `<p style="color:#555;font-style:italic">${escapeHtml(extra)}</p>`
  return html
}

export function renderEmailHtml(output: MonthlyReflectionOutput): string {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"/><title>Open Brain Monthly Reflection</title></head>
<body style="font-family:sans-serif;max-width:640px;margin:auto;padding:24px">
<h1 style="color:#1a1a1a">Monthly Reflection - ${escapeHtml(output.month_label)}</h1>
<p style="font-size:18px;color:#333;border-left:4px solid #2563eb;padding-left:12px">${escapeHtml(output.headline)}</p>
${htmlSection('Career Momentum', output.career_momentum.summary, [
    { label: 'Wins', items: output.career_momentum.wins },
    { label: 'Concerns', items: output.career_momentum.concerns },
  ])}
${htmlSection('Active Projects', output.active_projects.summary, [
    { label: 'Highlights', items: output.active_projects.highlights },
    { label: 'Stalled', items: output.active_projects.stalled },
  ])}
${htmlSection('Technical Exploration', output.technical_exploration.summary, [
    { label: 'Themes', items: output.technical_exploration.themes },
  ], output.technical_exploration.depth_vs_breadth)}
${htmlSection('Personal Patterns', output.personal_patterns.summary, [
    { label: 'Positive Patterns', items: output.personal_patterns.positive_patterns },
    { label: 'Watch Items', items: output.personal_patterns.watch_items },
  ])}
${output.cross_domain_insights.length > 0
    ? `<h2 style="color:#1a1a1a;border-bottom:1px solid #e5e5e5;padding-bottom:8px">Cross-Domain Insights</h2>${htmlList(output.cross_domain_insights)}`
    : ''}
${output.month_ahead_focus.length > 0
    ? `<h2 style="color:#1a1a1a;border-bottom:1px solid #e5e5e5;padding-bottom:8px">Month Ahead Focus</h2>${htmlList(output.month_ahead_focus)}`
    : ''}
${output.decisions_to_make.length > 0
    ? `<h2 style="color:#1a1a1a;border-bottom:1px solid #e5e5e5;padding-bottom:8px">Decisions to Make</h2>${htmlList(output.decisions_to_make)}`
    : ''}
<hr/><p style="color:#999;font-size:12px">Generated by Open Brain - your self-hosted AI knowledge base.</p>
</body></html>`
}

export function renderEmailText(output: MonthlyReflectionOutput): string {
  const lines: string[] = [
    `OPEN BRAIN - MONTHLY REFLECTION`,
    output.month_label,
    '',
    output.headline,
    '',
  ]

  const textSection = (title: string, summary: string, subsections: Array<{ label: string; items: string[] }>, extra?: string) => {
    if (!summary && subsections.every((s) => s.items.length === 0) && !extra) return
    lines.push(title.toUpperCase(), '')
    if (summary) lines.push(summary, '')
    for (const sub of subsections) {
      if (sub.items.length > 0) {
        lines.push(`${sub.label}:`)
        for (const item of sub.items) lines.push(`  - ${item}`)
        lines.push('')
      }
    }
    if (extra) lines.push(extra, '')
  }

  textSection('Career Momentum', output.career_momentum.summary, [
    { label: 'Wins', items: output.career_momentum.wins },
    { label: 'Concerns', items: output.career_momentum.concerns },
  ])
  textSection('Active Projects', output.active_projects.summary, [
    { label: 'Highlights', items: output.active_projects.highlights },
    { label: 'Stalled', items: output.active_projects.stalled },
  ])
  textSection('Technical Exploration', output.technical_exploration.summary, [
    { label: 'Themes', items: output.technical_exploration.themes },
  ], output.technical_exploration.depth_vs_breadth)
  textSection('Personal Patterns', output.personal_patterns.summary, [
    { label: 'Positive Patterns', items: output.personal_patterns.positive_patterns },
    { label: 'Watch Items', items: output.personal_patterns.watch_items },
  ])

  if (output.cross_domain_insights.length > 0) {
    lines.push('CROSS-DOMAIN INSIGHTS')
    for (const item of output.cross_domain_insights) lines.push(`  - ${item}`)
    lines.push('')
  }

  if (output.month_ahead_focus.length > 0) {
    lines.push('MONTH AHEAD FOCUS')
    for (const item of output.month_ahead_focus) lines.push(`  - ${item}`)
    lines.push('')
  }

  if (output.decisions_to_make.length > 0) {
    lines.push('DECISIONS TO MAKE')
    for (const item of output.decisions_to_make) lines.push(`  - ${item}`)
    lines.push('')
  }

  lines.push('Generated by Open Brain - your self-hosted AI knowledge base.')

  return lines.join('\n')
}
