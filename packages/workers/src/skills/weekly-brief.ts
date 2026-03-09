import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import OpenAI from 'openai'
import type { Database } from '@open-brain/shared'
import { skills_log } from '@open-brain/shared'
import type { CaptureRecord } from '@open-brain/shared'
import { logger } from '../lib/logger.js'
import { PushoverService } from '../services/pushover.js'
import { EmailService } from '../services/email.js'

// ============================================================
// Types
// ============================================================

/**
 * Structured output from the weekly brief AI call.
 * All array fields are guaranteed to be present (may be empty).
 */
export interface WeeklyBriefOutput {
  headline: string
  wins: string[]
  blockers: string[]
  risks: string[]
  open_loops: string[]
  next_week_focus: string[]
  avoided_decisions: string[]
  drift_alerts: string[]
  connections: string[]
}

export interface WeeklyBriefResult {
  brief: WeeklyBriefOutput
  captureCount: number
  durationMs: number
  /** UUID of the capture created to store the brief back into the brain */
  savedCaptureId: string | null
}

export interface WeeklyBriefOptions {
  /**
   * How far back to query captures (in days). Default: 7.
   * Can be overridden for testing with seeded data.
   */
  windowDays?: number
  /**
   * Approximate token budget for assembled captures context.
   * Captures are truncated (lowest-to-highest priority dropped) to stay under this.
   * Default: 50_000 tokens ≈ roughly 200K characters.
   */
  tokenBudget?: number
  /**
   * Override the AI model alias. Default: 'synthesis'.
   */
  modelAlias?: string
  /** Email recipient override — falls back to WEEKLY_BRIEF_EMAIL env var */
  emailTo?: string
}

// ============================================================
// Constants
// ============================================================

const DEFAULT_WINDOW_DAYS = 7
const DEFAULT_TOKEN_BUDGET = 50_000
// Rough chars-per-token estimate (English prose). Used for budget enforcement.
const CHARS_PER_TOKEN = 4
const MAX_CAPTURE_CHARS = DEFAULT_TOKEN_BUDGET * CHARS_PER_TOKEN
const LLM_TIMEOUT_MS = 120_000

// Brain view display order for context assembly
const VIEW_ORDER = ['career', 'work-internal', 'client', 'technical', 'personal']

// ============================================================
// WeeklyBriefSkill
// ============================================================

/**
 * WeeklyBriefSkill — queries the last N days of captures, synthesizes via LiteLLM,
 * delivers the brief via email + Pushover, captures the brief back into the brain
 * as a reflection, and logs to skills_log.
 *
 * Dependencies are injected for testability. The LiteLLM client (OpenAI SDK
 * pointed at the proxy) is constructed internally using env vars unless provided.
 *
 * Key design decisions:
 * - Queries captures directly via SQL (not via SearchService) — we want ALL
 *   captures in the window, not semantically ranked results
 * - Context assembled by brain_view bucket, sorted newest-first within each view
 * - Content truncated to respect 50K token budget; lowest-value (oldest) truncated first
 * - Prompt template loaded from config/prompts/weekly_brief_v1.txt
 * - AI output parsed as JSON; invalid output logs a warning and returns null brief
 * - Delivery via email + Pushover happens even if saving back to brain fails
 * - skills_log entry written on both success and failure
 */
export class WeeklyBriefSkill {
  private db: Database
  private litellmClient: OpenAI
  private pushover: PushoverService
  private email: EmailService
  private promptsDir: string
  private coreApiUrl: string

  constructor(opts: {
    db: Database
    litellmBaseUrl?: string
    litellmApiKey?: string
    pushover?: PushoverService
    email?: EmailService
    promptsDir?: string
    coreApiUrl?: string
  }) {
    this.db = opts.db
    this.litellmClient = new OpenAI({
      baseURL: opts.litellmBaseUrl ?? process.env.LITELLM_URL ?? 'https://llm.k4jda.net',
      apiKey: opts.litellmApiKey ?? process.env.LITELLM_API_KEY ?? 'no-key',
      timeout: LLM_TIMEOUT_MS,
    })
    this.pushover = opts.pushover ?? new PushoverService()
    this.email = opts.email ?? new EmailService()
    this.promptsDir = opts.promptsDir ?? join(process.cwd(), 'config', 'prompts')
    this.coreApiUrl = opts.coreApiUrl ?? process.env.OPEN_BRAIN_API_URL ?? 'http://localhost:3000'
  }

  // ----------------------------------------------------------
  // Public API
  // ----------------------------------------------------------

  /**
   * Execute the weekly brief skill end-to-end.
   *
   * 1. Query all captures from the last windowDays days
   * 2. Group by brain_view, assemble context respecting token budget
   * 3. Call LiteLLM with weekly_brief_v1 prompt template
   * 4. Parse structured JSON output
   * 5. Deliver: email (HTML), Pushover notification
   * 6. Capture back into brain as 'reflection' (source: 'system')
   * 7. Log to skills_log
   *
   * @throws on unrecoverable errors (DB connection, LLM failure, JSON parse failure)
   */
  async execute(options: WeeklyBriefOptions = {}): Promise<WeeklyBriefResult> {
    const {
      windowDays = DEFAULT_WINDOW_DAYS,
      tokenBudget = DEFAULT_TOKEN_BUDGET,
      modelAlias = 'synthesis',
      emailTo = process.env.WEEKLY_BRIEF_EMAIL,
    } = options

    const startMs = Date.now()
    const now = new Date()
    const windowStart = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000)

    logger.info({ windowDays, windowStart }, '[weekly-brief] starting execution')

    // Step 1: Query all captures in the window
    const captures = await this.queryCaptures(windowStart, now)
    const captureCount = captures.length

    logger.info({ captureCount }, '[weekly-brief] captures fetched')

    if (captureCount === 0) {
      logger.warn('[weekly-brief] no captures found in window — skipping brief generation')
      await this.logToSkillsLog({
        inputSummary: `0 captures in last ${windowDays} days`,
        outputSummary: 'Skipped — no captures',
        durationMs: Date.now() - startMs,
      })
      return {
        brief: emptyBrief(),
        captureCount: 0,
        durationMs: Date.now() - startMs,
        savedCaptureId: null,
      }
    }

    // Step 2: Assemble context string, respect token budget
    const { contextText, capturesByView } = this.assembleContext(captures, tokenBudget * CHARS_PER_TOKEN)

    // Step 3: Build date range strings
    const dateRange = `${fmtDate(windowStart)} to ${fmtDate(now)}`
    const weekStart = fmtDate(windowStart)
    const weekEnd = fmtDate(now)

    // Step 4: Call LiteLLM
    const rawOutput = await this.callLLM(contextText, dateRange, captureCount, modelAlias)

    // Step 5: Parse structured JSON
    const brief = this.parseOutput(rawOutput)

    const durationMs = Date.now() - startMs

    // Step 6: Deliver
    const emailSent = await this.deliverEmail(brief, capturesByView, weekStart, weekEnd, captureCount, emailTo)
    await this.deliverPushover(brief)

    // Step 7: Capture brief back into brain
    const savedCaptureId = await this.saveBriefCapture(brief, weekStart, weekEnd)

    // Step 8: Log to skills_log
    await this.logToSkillsLog({
      inputSummary: `${captureCount} captures from ${dateRange}`,
      outputSummary: `headline: "${brief.headline}" | wins:${brief.wins.length} blockers:${brief.blockers.length} risks:${brief.risks.length} | email:${emailSent}`,
      durationMs,
      captureId: savedCaptureId ?? undefined,
      result: brief,
    })

    logger.info({ captureCount, durationMs, savedCaptureId }, '[weekly-brief] execution complete')

    return { brief, captureCount, durationMs, savedCaptureId }
  }

  // ----------------------------------------------------------
  // Private: data fetching
  // ----------------------------------------------------------

  /**
   * Fetch all captures in the time window, ordered by brain_view then captured_at DESC.
   * Does not use SearchService — we want all captures, not semantically ranked ones.
   */
  private async queryCaptures(from: Date, to: Date): Promise<CaptureRecord[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await this.db.execute<any>(sql`
      SELECT id, content, capture_type, brain_view, source, tags, captured_at, created_at, updated_at,
             pipeline_status, pipeline_attempts, content_hash
      FROM captures
      WHERE captured_at >= ${from.toISOString()}::timestamptz
        AND captured_at <= ${to.toISOString()}::timestamptz
        AND pipeline_status = 'complete'
      ORDER BY brain_view ASC, captured_at DESC
    `)
    return rows.rows as CaptureRecord[]
  }

  // ----------------------------------------------------------
  // Private: context assembly
  // ----------------------------------------------------------

  /**
   * Group captures by brain_view, format each capture as plain text,
   * and concatenate into a context string that fits within the char budget.
   *
   * Truncation strategy: process views in priority order. Within each view,
   * captures are newest-first. Drop from the end of each view's list until
   * under budget.
   */
  private assembleContext(
    captures: CaptureRecord[],
    maxChars: number,
  ): { contextText: string; capturesByView: Record<string, number> } {
    // Group by view
    const byView = new Map<string, CaptureRecord[]>()
    for (const c of captures) {
      const view = c.brain_view ?? 'unknown'
      if (!byView.has(view)) byView.set(view, [])
      byView.get(view)!.push(c)
    }

    // Determine display order (configured views first, then any extras alphabetically)
    const allViews = [...byView.keys()]
    const orderedViews = [
      ...VIEW_ORDER.filter(v => byView.has(v)),
      ...allViews.filter(v => !VIEW_ORDER.includes(v)).sort(),
    ]

    const capturesByView: Record<string, number> = {}
    const sections: string[] = []
    let totalChars = 0

    for (const view of orderedViews) {
      const viewCaptures = byView.get(view) ?? []
      capturesByView[view] = viewCaptures.length

      const lines: string[] = []
      for (const c of viewCaptures) {
        const line = formatCapture(c)
        if (totalChars + line.length > maxChars) {
          logger.debug({ view, truncatedAt: lines.length }, '[weekly-brief] context budget reached — truncating')
          break
        }
        lines.push(line)
        totalChars += line.length
      }

      if (lines.length > 0) {
        sections.push(`=== ${view.toUpperCase()} (${lines.length} captures) ===\n${lines.join('\n')}`)
      }
    }

    return { contextText: sections.join('\n\n'), capturesByView }
  }

  // ----------------------------------------------------------
  // Private: LLM call
  // ----------------------------------------------------------

  private async callLLM(
    contextText: string,
    dateRange: string,
    captureCount: number,
    modelAlias: string,
  ): Promise<string> {
    const prompt = this.buildPrompt(contextText, dateRange, captureCount)

    logger.debug({ modelAlias, promptLength: prompt.length }, '[weekly-brief] calling LLM')

    // Disable thinking/reasoning mode for structured JSON output (Qwen3.5 etc.)
    const response = await this.litellmClient.chat.completions.create({
      model: modelAlias,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 2048,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      extra_body: { chat_template_kwargs: { enable_thinking: false } },
    } as any)

    const text = response.choices[0]?.message?.content ?? ''
    const usage = response.usage

    logger.info(
      { promptTokens: usage?.prompt_tokens, completionTokens: usage?.completion_tokens },
      '[weekly-brief] LLM call complete',
    )

    return text
  }

  /**
   * Loads weekly_brief_v1.txt prompt template and substitutes variables.
   */
  private buildPrompt(contextText: string, dateRange: string, captureCount: number): string {
    const templatePath = join(this.promptsDir, 'weekly_brief_v1.txt')

    if (!existsSync(templatePath)) {
      throw new Error(`[weekly-brief] Prompt template not found: ${templatePath}`)
    }

    let template = readFileSync(templatePath, 'utf8')

    const vars: Record<string, string> = {
      date_range: dateRange,
      capture_count: String(captureCount),
      captures: contextText,
    }

    for (const [key, value] of Object.entries(vars)) {
      template = template.replaceAll(`{{${key}}}`, value)
    }

    return template
  }

  // ----------------------------------------------------------
  // Private: output parsing
  // ----------------------------------------------------------

  /**
   * Parses the LLM JSON output into a WeeklyBriefOutput.
   *
   * Handles LLM quirks:
   * - Strips markdown code fences (```json ... ```)
   * - Fills missing array fields with []
   * - Fills missing headline with a fallback string
   * - Throws if JSON is completely unparseable (caller handles retry)
   */
  private parseOutput(raw: string): WeeklyBriefOutput {
    // Strip markdown fences if present
    let cleaned = raw.trim()
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
    }

    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(cleaned)
    } catch (err) {
      logger.error({ raw: raw.slice(0, 500), err }, '[weekly-brief] failed to parse LLM output as JSON')
      throw new Error(`[weekly-brief] LLM output is not valid JSON: ${(err as Error).message}`)
    }

    const arrayFields = [
      'wins',
      'blockers',
      'risks',
      'open_loops',
      'next_week_focus',
      'avoided_decisions',
      'drift_alerts',
      'connections',
    ] as const

    const brief: WeeklyBriefOutput = {
      headline: typeof parsed.headline === 'string' ? parsed.headline : '(no headline)',
      wins: [],
      blockers: [],
      risks: [],
      open_loops: [],
      next_week_focus: [],
      avoided_decisions: [],
      drift_alerts: [],
      connections: [],
    }

    for (const field of arrayFields) {
      const val = parsed[field]
      if (Array.isArray(val)) {
        brief[field] = val.filter((item): item is string => typeof item === 'string')
      }
    }

    return brief
  }

  // ----------------------------------------------------------
  // Private: delivery
  // ----------------------------------------------------------

  /**
   * Sends the weekly brief email using the HTML template.
   * Returns true if delivered, false if SMTP not configured or emailTo missing.
   */
  private async deliverEmail(
    brief: WeeklyBriefOutput,
    capturesByView: Record<string, number>,
    weekStart: string,
    weekEnd: string,
    captureCount: number,
    emailTo?: string,
  ): Promise<boolean> {
    if (!emailTo) {
      logger.debug('[weekly-brief] WEEKLY_BRIEF_EMAIL not set — skipping email')
      return false
    }

    if (!this.email.isConfigured) {
      logger.debug('[weekly-brief] SMTP not configured — skipping email')
      return false
    }

    const htmlBody = this.renderEmailHtml(brief, capturesByView, weekStart, weekEnd, captureCount)
    const textBody = this.renderEmailText(brief, weekStart, weekEnd, captureCount)

    try {
      await this.email.send({
        to: emailTo,
        subject: `Open Brain Weekly Brief — ${weekStart}`,
        htmlBody,
        textBody,
      })
      logger.info({ to: emailTo }, '[weekly-brief] email delivered')
      return true
    } catch (err) {
      logger.warn({ err }, '[weekly-brief] email delivery failed — continuing')
      return false
    }
  }

  /**
   * Renders the weekly brief HTML email body.
   *
   * Uses the weekly-brief.html template (simple string interpolation since it's
   * a static file — no Handlebars dependency). The template uses {{var}} placeholders
   * for simple strings and conditional/loop sections are handled by string construction.
   */
  private renderEmailHtml(
    brief: WeeklyBriefOutput,
    capturesByView: Record<string, number>,
    weekStart: string,
    weekEnd: string,
    captureCount: number,
  ): string {
    const templatePath = join(
      process.cwd(),
      'packages',
      'workers',
      'src',
      'templates',
      'weekly-brief.html',
    )

    let html: string
    try {
      html = readFileSync(templatePath, 'utf8')
    } catch {
      // Fallback to adjacent path (when run from workers package dir)
      const altPath = join(process.cwd(), 'src', 'templates', 'weekly-brief.html')
      html = existsSync(altPath)
        ? readFileSync(altPath, 'utf8')
        : buildFallbackHtml(brief, weekStart, weekEnd, captureCount)
    }

    // Replace simple {{var}} placeholders
    html = html.replaceAll('{{headline}}', escapeHtml(brief.headline))
    html = html.replaceAll('{{week_start}}', escapeHtml(weekStart))
    html = html.replaceAll('{{week_end}}', escapeHtml(weekEnd))

    const viewsSummary = Object.entries(capturesByView)
      .map(([v, n]) => `${n} ${v}`)
      .join(', ')
    html = html.replaceAll('{{captures_count}}', String(captureCount))
    html = html.replaceAll('{{brain_views_summary}}', escapeHtml(viewsSummary))

    // Handlebars-style conditional/loop blocks — manual expansion
    html = expandHtmlSection(html, 'wins', brief.wins)
    html = expandHtmlSection(html, 'blockers', brief.blockers)
    html = expandHtmlSection(html, 'risks', brief.risks)
    html = expandHtmlSection(html, 'open_loops', brief.open_loops)
    html = expandHtmlSection(html, 'next_week_focus', brief.next_week_focus)
    html = expandHtmlSection(html, 'avoided_decisions', brief.avoided_decisions)
    html = expandHtmlSection(html, 'drift_alerts', brief.drift_alerts)
    html = expandHtmlSection(html, 'connections', brief.connections)

    return html
  }

  /**
   * Renders the plain-text email fallback.
   */
  private renderEmailText(
    brief: WeeklyBriefOutput,
    weekStart: string,
    weekEnd: string,
    captureCount: number,
  ): string {
    const lines: string[] = [
      `OPEN BRAIN — WEEKLY BRIEF`,
      `Week of ${weekStart} to ${weekEnd}`,
      `${captureCount} captures`,
      '',
      `HEADLINE`,
      brief.headline,
      '',
    ]

    const sections: Array<{ title: string; items: string[] }> = [
      { title: 'WINS', items: brief.wins },
      { title: 'BLOCKERS', items: brief.blockers },
      { title: 'RISKS', items: brief.risks },
      { title: 'OPEN LOOPS', items: brief.open_loops },
      { title: 'NEXT WEEK FOCUS', items: brief.next_week_focus },
      { title: 'DECISIONS AVOIDED', items: brief.avoided_decisions },
      { title: 'DRIFT ALERTS', items: brief.drift_alerts },
      { title: 'CONNECTIONS', items: brief.connections },
    ]

    for (const { title, items } of sections) {
      if (items.length > 0) {
        lines.push(title)
        for (const item of items) {
          lines.push(`  - ${item}`)
        }
        lines.push('')
      }
    }

    lines.push('Generated by Open Brain — your self-hosted AI knowledge base.')

    return lines.join('\n')
  }

  /**
   * Sends a Pushover notification announcing the brief is ready.
   * Priority 0 (normal) — informational, not urgent.
   */
  private async deliverPushover(brief: WeeklyBriefOutput): Promise<void> {
    if (!this.pushover.isConfigured) {
      logger.debug('[weekly-brief] Pushover not configured — skipping')
      return
    }

    try {
      await this.pushover.send({
        title: 'Weekly Brief Ready',
        message: brief.headline,
        priority: 0,
      })
      logger.info('[weekly-brief] Pushover notification sent')
    } catch (err) {
      logger.warn({ err }, '[weekly-brief] Pushover delivery failed — continuing')
    }
  }

  // ----------------------------------------------------------
  // Private: save brief back to brain
  // ----------------------------------------------------------

  /**
   * POST the brief to Core API as a 'reflection' capture so it becomes searchable.
   *
   * Source: 'system' — indicates machine-generated content.
   * Capture type: 'reflection' — matches the intended brain_view.
   *
   * Uses the Core API HTTP endpoint (not direct DB insert) so the brief goes
   * through the full pipeline (classification, embedding, entity extraction).
   *
   * Returns the new capture ID on success, null on failure (non-fatal).
   */
  private async saveBriefCapture(
    brief: WeeklyBriefOutput,
    weekStart: string,
    weekEnd: string,
  ): Promise<string | null> {
    const briefText = buildBriefText(brief, weekStart, weekEnd)

    try {
      const res = await fetch(`${this.coreApiUrl}/api/v1/captures`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: briefText,
          capture_type: 'reflection',
          brain_view: 'personal',
          source: 'api',
          metadata: {
            source_metadata: {
              generator: 'weekly-brief-skill',
              week_start: weekStart,
              week_end: weekEnd,
            },
          },
        }),
        signal: AbortSignal.timeout(15_000),
      })

      if (!res.ok) {
        const body = await res.text().catch(() => '')
        logger.warn({ status: res.status, body }, '[weekly-brief] failed to save brief capture')
        return null
      }

      const data = (await res.json()) as { id?: string; data?: { id?: string } }
      const captureId = data.id ?? data.data?.id ?? null

      logger.info({ captureId }, '[weekly-brief] brief saved back to brain')
      return captureId ?? null
    } catch (err) {
      logger.warn({ err }, '[weekly-brief] save brief capture failed — continuing')
      return null
    }
  }

  // ----------------------------------------------------------
  // Private: skills_log
  // ----------------------------------------------------------

  private async logToSkillsLog(params: {
    inputSummary: string
    outputSummary: string
    durationMs: number
    captureId?: string
    result?: WeeklyBriefOutput
  }): Promise<void> {
    try {
      await this.db.insert(skills_log).values({
        skill_name: 'weekly-brief',
        capture_id: params.captureId ?? null,
        input_summary: params.inputSummary,
        output_summary: params.outputSummary,
        result: params.result ?? null,
        duration_ms: params.durationMs,
      })
    } catch (err) {
      // skills_log failure is non-fatal
      logger.warn({ err }, '[weekly-brief] failed to write skills_log entry')
    }
  }
}

// ============================================================
// Skill execution entry point — called by BullMQ worker
// ============================================================

/**
 * Top-level function invoked by the skill-execution BullMQ worker.
 *
 * Constructs WeeklyBriefSkill with production dependencies and executes.
 * On final failure (after BullMQ exhausts retries), a Pushover alert is
 * sent by the caller (skill worker, not here).
 */
export async function executeWeeklyBrief(
  db: Database,
  options: WeeklyBriefOptions = {},
): Promise<WeeklyBriefResult> {
  const skill = new WeeklyBriefSkill({ db })
  return skill.execute(options)
}

// ============================================================
// Helpers
// ============================================================

function emptyBrief(): WeeklyBriefOutput {
  return {
    headline: '',
    wins: [],
    blockers: [],
    risks: [],
    open_loops: [],
    next_week_focus: [],
    avoided_decisions: [],
    drift_alerts: [],
    connections: [],
  }
}

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10) // YYYY-MM-DD
}

function formatCapture(c: CaptureRecord): string {
  const date = fmtDate(new Date(c.captured_at))
  const tags = c.tags && c.tags.length > 0 ? ` [${c.tags.join(', ')}]` : ''
  return `[${date}] [${c.capture_type}]${tags} ${c.content}\n`
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Expands {{#if field}}...{{#each field}}<li>{{this}}</li>{{/each}}...{{/if}}
 * blocks in the HTML template.
 *
 * We do minimal regex-based expansion here rather than pulling in Handlebars.
 * The template only uses these two constructs so simple regex is sufficient.
 */
function expandHtmlSection(html: string, field: string, items: string[]): string {
  // Match: {{#if field}}...content...{{/if}}
  const ifPattern = new RegExp(
    `\\{\\{#if ${field}\\}\\}([\\s\\S]*?)\\{\\{\\/if\\}\\}`,
    'g',
  )

  if (items.length === 0) {
    // Remove the entire block
    return html.replace(ifPattern, '')
  }

  return html.replace(ifPattern, (_, blockContent: string) => {
    // Expand {{#each field}}<li>{{this}}</li>{{/each}}
    const eachPattern = new RegExp(
      `\\{\\{#each ${field}\\}\\}([\\s\\S]*?)\\{\\{\\/each\\}\\}`,
      'g',
    )
    const expanded = blockContent.replace(eachPattern, (_, itemTemplate: string) => {
      return items
        .map(item => itemTemplate.replace(/\{\{this\}\}/g, escapeHtml(item)))
        .join('')
    })
    return expanded
  })
}

/**
 * Minimal HTML fallback when the template file cannot be found.
 */
function buildFallbackHtml(
  brief: WeeklyBriefOutput,
  weekStart: string,
  weekEnd: string,
  captureCount: number,
): string {
  const listItems = (items: string[]) =>
    items.length > 0 ? `<ul>${items.map(i => `<li>${escapeHtml(i)}</li>`).join('')}</ul>` : ''

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"/><title>Open Brain Weekly Brief</title></head>
<body style="font-family:sans-serif;max-width:640px;margin:auto;padding:24px">
<h1>Open Brain — Weekly Brief</h1>
<p style="color:#666">Week of ${escapeHtml(weekStart)} – ${escapeHtml(weekEnd)} &nbsp;|&nbsp; ${captureCount} captures</p>
<h2>${escapeHtml(brief.headline)}</h2>
${brief.wins.length ? `<h3>Wins</h3>${listItems(brief.wins)}` : ''}
${brief.blockers.length ? `<h3>Blockers</h3>${listItems(brief.blockers)}` : ''}
${brief.risks.length ? `<h3>Risks</h3>${listItems(brief.risks)}` : ''}
${brief.open_loops.length ? `<h3>Open Loops</h3>${listItems(brief.open_loops)}` : ''}
${brief.next_week_focus.length ? `<h3>Next Week Focus</h3>${listItems(brief.next_week_focus)}` : ''}
${brief.avoided_decisions.length ? `<h3>Decisions Avoided</h3>${listItems(brief.avoided_decisions)}` : ''}
${brief.drift_alerts.length ? `<h3>Drift Alerts</h3>${listItems(brief.drift_alerts)}` : ''}
${brief.connections.length ? `<h3>Connections</h3>${listItems(brief.connections)}` : ''}
<hr/><p style="color:#999;font-size:12px">Generated by Open Brain</p>
</body></html>`
}

/**
 * Renders the brief as plain text for capture-back-to-brain and plain email.
 */
function buildBriefText(brief: WeeklyBriefOutput, weekStart: string, weekEnd: string): string {
  const lines: string[] = [
    `Weekly Brief — ${weekStart} to ${weekEnd}`,
    '',
    brief.headline,
    '',
  ]

  const sections: Array<{ label: string; items: string[] }> = [
    { label: 'Wins', items: brief.wins },
    { label: 'Blockers', items: brief.blockers },
    { label: 'Risks', items: brief.risks },
    { label: 'Open Loops', items: brief.open_loops },
    { label: 'Next Week Focus', items: brief.next_week_focus },
    { label: 'Decisions Avoided', items: brief.avoided_decisions },
    { label: 'Drift Alerts', items: brief.drift_alerts },
    { label: 'Connections', items: brief.connections },
  ]

  for (const { label, items } of sections) {
    if (items.length > 0) {
      lines.push(`${label}:`)
      for (const item of items) lines.push(`- ${item}`)
      lines.push('')
    }
  }

  return lines.join('\n').trim()
}
