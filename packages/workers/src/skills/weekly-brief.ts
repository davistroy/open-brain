import { join } from 'node:path'
import type OpenAI from 'openai'
import type Anthropic from '@anthropic-ai/sdk'
import type { Database } from '@open-brain/shared'
import { skills_log, logger, PushoverService, createLiteLLMClient, TemplateCache, callClaude } from '@open-brain/shared'
import { EmailService } from '../services/email.js'
import { queryCaptures, assembleContext, fmtDate, CHARS_PER_TOKEN } from './weekly-brief-query.js'
import type { WeeklyBriefOutput, WeeklyBriefResult, WeeklyBriefOptions } from './weekly-brief-query.js'
import { renderEmailHtml, renderEmailText, buildBriefText } from './weekly-brief-renderer.js'

// Re-export types so existing consumers don't break
export type { WeeklyBriefOutput, WeeklyBriefResult, WeeklyBriefOptions } from './weekly-brief-query.js'

const DEFAULT_WINDOW_DAYS = 7
const DEFAULT_TOKEN_BUDGET = 50_000

/**
 * WeeklyBriefSkill — orchestrator that coordinates query, LLM, rendering, and delivery.
 * Data fetching is in weekly-brief-query.ts, rendering in weekly-brief-renderer.ts.
 */
export class WeeklyBriefSkill {
  private db: Database
  private litellmClient: OpenAI | null
  private anthropicClient: Anthropic | null
  private pushover: PushoverService
  private email: EmailService
  private templates: TemplateCache
  private coreApiUrl: string

  constructor(opts: {
    db: Database; litellmBaseUrl?: string; litellmApiKey?: string; anthropicClient?: Anthropic
    pushover?: PushoverService; email?: EmailService; promptsDir?: string; coreApiUrl?: string
    templates?: TemplateCache
  }) {
    this.db = opts.db
    this.litellmClient = createLiteLLMClient({
      baseUrl: opts.litellmBaseUrl,
      apiKey: opts.litellmApiKey,
      timeout: 'extended',
      maxRetries: 0,
    })
    this.anthropicClient = opts.anthropicClient ?? null
    this.pushover = opts.pushover ?? new PushoverService({ onError: 'throw' })
    this.email = opts.email ?? new EmailService()
    this.templates = opts.templates ?? new TemplateCache(opts.promptsDir ?? join(process.cwd(), 'config', 'prompts'))
    this.coreApiUrl = opts.coreApiUrl ?? process.env.OPEN_BRAIN_API_URL ?? 'http://localhost:3000'
  }

  async execute(options: WeeklyBriefOptions = {}): Promise<WeeklyBriefResult> {
    const { windowDays = DEFAULT_WINDOW_DAYS, tokenBudget = DEFAULT_TOKEN_BUDGET, modelAlias = 'synthesis', emailTo = process.env.WEEKLY_BRIEF_EMAIL } = options
    const startMs = Date.now()
    const now = new Date()
    const windowStart = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000)
    logger.info({ windowDays, windowStart }, '[weekly-brief] starting execution')

    const captures = await queryCaptures(this.db, windowStart, now)
    const captureCount = captures.length
    logger.info({ captureCount }, '[weekly-brief] captures fetched')

    if (captureCount === 0) {
      await this.logToSkillsLog({ inputSummary: `0 captures in last ${windowDays} days`, outputSummary: 'Skipped — no captures', durationMs: Date.now() - startMs })
      return { brief: emptyBrief(), captureCount: 0, durationMs: Date.now() - startMs, savedCaptureId: null }
    }

    const { contextText, capturesByView } = assembleContext(captures, tokenBudget * CHARS_PER_TOKEN)
    const dateRange = `${fmtDate(windowStart)} to ${fmtDate(now)}`
    const weekStart = fmtDate(windowStart)
    const weekEnd = fmtDate(now)

    const rawOutput = await this.callLLM(contextText, dateRange, captureCount, modelAlias)
    const brief = parseOutput(rawOutput)
    const durationMs = Date.now() - startMs

    const emailSent = await this.deliverEmail(brief, capturesByView, weekStart, weekEnd, captureCount, emailTo)
    await this.deliverPushover(brief)
    const savedCaptureId = await this.saveBriefCapture(brief, weekStart, weekEnd)

    await this.logToSkillsLog({
      inputSummary: `${captureCount} captures from ${dateRange}`,
      outputSummary: `headline: "${brief.headline}" | wins:${brief.wins.length} blockers:${brief.blockers.length} risks:${brief.risks.length} | email:${emailSent}`,
      durationMs, captureId: savedCaptureId ?? undefined, result: brief,
    })
    logger.info({ captureCount, durationMs, savedCaptureId }, '[weekly-brief] execution complete')
    return { brief, captureCount, durationMs, savedCaptureId }
  }

  private async callLLM(contextText: string, dateRange: string, captureCount: number, modelAlias: string): Promise<string> {
    const prompt = this.templates.render('weekly_brief_v1.txt', {
      date_range: dateRange, capture_count: String(captureCount), captures: contextText,
    })
    logger.debug({ modelAlias, promptLength: prompt.length }, '[weekly-brief] calling LLM')

    // Prefer Anthropic (Claude) client; fall back to OpenAI/LiteLLM
    if (this.anthropicClient) {
      const result = await callClaude(this.anthropicClient, prompt, {
        model: modelAlias, maxTokens: 2048, temperature: 0.3,
      })
      logger.info({ inputTokens: result.inputTokens, outputTokens: result.outputTokens }, '[weekly-brief] LLM call complete (Claude)')
      return result.text
    }

    if (!this.litellmClient) throw new Error('[weekly-brief] No LLM client configured — set ANTHROPIC_API_KEY or LITELLM_API_KEY')
    const response = await this.litellmClient.chat.completions.create({
      model: modelAlias, messages: [{ role: 'user', content: prompt }],
      temperature: 0.3, max_completion_tokens: 2048,
    })
    const text = response.choices[0]?.message?.content ?? ''
    logger.info({ promptTokens: response.usage?.prompt_tokens, completionTokens: response.usage?.completion_tokens }, '[weekly-brief] LLM call complete (OpenAI)')
    return text
  }

  private async deliverEmail(brief: WeeklyBriefOutput, capturesByView: Record<string, number>, weekStart: string, weekEnd: string, captureCount: number, emailTo?: string): Promise<boolean> {
    if (!emailTo || !this.email.isConfigured) return false
    try {
      const htmlBody = renderEmailHtml(brief, capturesByView, weekStart, weekEnd, captureCount)
      const textBody = renderEmailText(brief, weekStart, weekEnd, captureCount)
      await this.email.send({ to: emailTo, subject: `Open Brain Weekly Brief — ${weekStart}`, htmlBody, textBody })
      return true
    } catch { return false }
  }

  private async deliverPushover(brief: WeeklyBriefOutput): Promise<void> {
    if (!this.pushover.isConfigured) return
    try { await this.pushover.send({ title: 'Weekly Brief Ready', message: brief.headline, priority: 0 }) } catch { /* non-fatal */ }
  }

  private async saveBriefCapture(brief: WeeklyBriefOutput, weekStart: string, weekEnd: string): Promise<string | null> {
    try {
      const res = await fetch(`${this.coreApiUrl}/api/v1/captures`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: buildBriefText(brief, weekStart, weekEnd), capture_type: 'reflection', brain_view: 'personal', source: 'api', metadata: { source_metadata: { generator: 'weekly-brief-skill', week_start: weekStart, week_end: weekEnd } } }),
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok) return null
      const data = (await res.json()) as { id?: string; data?: { id?: string } }
      return data.id ?? data.data?.id ?? null
    } catch { return null }
  }

  private async logToSkillsLog(params: { inputSummary: string; outputSummary: string; durationMs: number; captureId?: string; result?: WeeklyBriefOutput }): Promise<void> {
    try {
      await this.db.insert(skills_log).values({ skill_name: 'weekly-brief', capture_id: params.captureId ?? null, input_summary: params.inputSummary, output_summary: params.outputSummary, result: params.result ?? null, duration_ms: params.durationMs })
    } catch { /* non-fatal */ }
  }
}

/** Top-level entry point called by BullMQ worker. */
export async function executeWeeklyBrief(db: Database, options: WeeklyBriefOptions = {}, anthropicClient?: Anthropic): Promise<WeeklyBriefResult> {
  return new WeeklyBriefSkill({ db, anthropicClient }).execute(options)
}

function emptyBrief(): WeeklyBriefOutput {
  return { headline: '', wins: [], blockers: [], risks: [], open_loops: [], next_week_focus: [], avoided_decisions: [], drift_alerts: [], connections: [] }
}

/** Parses LLM JSON output into a WeeklyBriefOutput. Exported for testing. */
export function parseOutput(raw: string): WeeklyBriefOutput {
  let cleaned = raw.trim()
  if (cleaned.startsWith('```')) cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  let parsed: Record<string, unknown>
  try { parsed = JSON.parse(cleaned) } catch (err) {
    logger.error({ raw: raw.slice(0, 500), err }, '[weekly-brief] failed to parse LLM output as JSON')
    throw new Error(`[weekly-brief] LLM output is not valid JSON: ${(err as Error).message}`)
  }
  const arrayFields = ['wins', 'blockers', 'risks', 'open_loops', 'next_week_focus', 'avoided_decisions', 'drift_alerts', 'connections'] as const
  const brief: WeeklyBriefOutput = { headline: typeof parsed.headline === 'string' ? parsed.headline : '(no headline)', wins: [], blockers: [], risks: [], open_loops: [], next_week_focus: [], avoided_decisions: [], drift_alerts: [], connections: [] }
  for (const field of arrayFields) { const val = parsed[field]; if (Array.isArray(val)) brief[field] = val.filter((item): item is string => typeof item === 'string') }
  return brief
}
