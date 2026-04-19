import { mkdir, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import type { Database } from '@open-brain/shared'
import { logger } from '@open-brain/shared'
import type { WikiGitService } from '@open-brain/shared'
import { BaseSkill } from './base-skill.js'
import type { BaseSkillOpts } from './types.js'
import { querySpend } from './cost-analysis-query.js'
import type { CostAnalysisOptions, ModelCost, DailyCostSummary, CostAnalysisResult } from './cost-analysis-query.js'

// Re-export types so consumers can import from this file
export type { CostAnalysisOptions, ModelCost, DailyCostSummary, CostAnalysisResult } from './cost-analysis-query.js'

// ============================================================
// Constants
// ============================================================

const DEFAULT_DAILY_ALERT_THRESHOLD = 2.00
const DEFAULT_WIKI_DIR = 'operations/cost-reports'

// ============================================================
// CostAnalysisSkill
// ============================================================

/** Constructor options for CostAnalysisSkill. */
export interface CostAnalysisSkillOpts extends BaseSkillOpts {
  wikiService?: WikiGitService
  wikiDir?: string
  litellmSpendUrl?: string
  litellmApiKey?: string
}

/**
 * CostAnalysisSkill — daily LLM cost analysis with weekly/monthly reports.
 *
 * - Runs daily at 7 AM
 * - Queries ai_audit_log for the previous day's spend
 * - Aggregates by model and task type
 * - Sends Pushover alert if daily spend exceeds threshold
 * - On Mondays: includes 7-day weekly summary
 * - On 1st of month: includes previous month's full breakdown
 * - Writes reports to wiki/operations/cost-reports/
 */
export class CostAnalysisSkill extends BaseSkill<CostAnalysisOptions, CostAnalysisResult> {
  private wikiService?: WikiGitService
  private wikiDir: string
  private litellmSpendUrl: string
  private litellmApiKey: string

  constructor(opts: CostAnalysisSkillOpts) {
    super('cost-analysis', opts)
    this.wikiService = opts.wikiService
    this.wikiDir = opts.wikiDir ?? DEFAULT_WIKI_DIR
    // Field names predate rename; read from LLM_SPEND_URL / LLM_SPEND_API_KEY env vars.
    this.litellmSpendUrl = opts.litellmSpendUrl ?? process.env.LLM_SPEND_URL ?? ''
    this.litellmApiKey = opts.litellmApiKey ?? process.env.LLM_SPEND_API_KEY ?? ''
  }

  protected async run(options: CostAnalysisOptions = {}): Promise<CostAnalysisResult> {
    const startMs = Date.now()
    const now = options.now ?? new Date()
    const dailyAlertThreshold = options.dailyAlertThreshold ?? DEFAULT_DAILY_ALERT_THRESHOLD

    logger.info({ dailyAlertThreshold }, '[cost-analysis] starting execution')

    // Previous day window
    const yesterday = new Date(now)
    yesterday.setDate(yesterday.getDate() - 1)
    yesterday.setHours(0, 0, 0, 0)
    const todayStart = new Date(now)
    todayStart.setHours(0, 0, 0, 0)

    // Step 1: Query daily spend — LiteLLM as primary, local ai_audit_log as supplement
    const dailySummary = await this.querySpendCombined(yesterday, todayStart)
    const dateStr = yesterday.toISOString().split('T')[0]
    dailySummary.date = dateStr

    // Step 2: Check for weekly summary (Monday)
    let weeklySummary: DailyCostSummary | undefined
    const dayOfWeek = now.getDay()
    if (dayOfWeek === 1) {
      // Monday — 7-day lookback
      const weekStart = new Date(now)
      weekStart.setDate(weekStart.getDate() - 7)
      weekStart.setHours(0, 0, 0, 0)
      weeklySummary = await this.querySpendCombined(weekStart, todayStart)
      weeklySummary.date = `${weekStart.toISOString().split('T')[0]} to ${dateStr}`
    }

    // Step 3: Check for monthly summary (1st of month)
    let monthlySummary: DailyCostSummary | undefined
    if (now.getDate() === 1) {
      const monthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1)
      const monthEnd = new Date(now.getFullYear(), now.getMonth(), 1)
      monthlySummary = await this.querySpendCombined(monthStart, monthEnd)
      const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December']
      monthlySummary.date = `${monthNames[monthStart.getMonth()]} ${monthStart.getFullYear()}`
    }

    // Step 4: Alert if daily spend exceeds threshold
    let alertSent = false
    if (dailySummary.totalCost > dailyAlertThreshold) {
      alertSent = await this.sendAlert(dailySummary, dailyAlertThreshold)
    }

    // Step 5: Write wiki report
    let wikiPageWritten = false
    const reportType = monthlySummary ? 'monthly' : weeklySummary ? 'weekly' : 'daily'
    wikiPageWritten = await this.writeWikiReport(dateStr, dailySummary, weeklySummary, monthlySummary)

    const durationMs = Date.now() - startMs

    const finalResult: CostAnalysisResult = {
      type: reportType,
      summary: dailySummary,
      weeklySummary,
      monthlySummary,
      alertSent,
      wikiPageWritten,
      durationMs,
    }

    // Step 6: Log to skills_log via BaseSkill
    const outputSummary = [
      `date:${dailySummary.date}`,
      `cost:$${dailySummary.totalCost.toFixed(4)}`,
      `calls:${dailySummary.totalCalls}`,
      `tokens:${dailySummary.totalTokens}`,
      `alert:${alertSent}`,
      `wiki:${wikiPageWritten}`,
      weeklySummary ? `weekly:$${weeklySummary.totalCost.toFixed(4)}` : null,
      monthlySummary ? `monthly:$${monthlySummary.totalCost.toFixed(4)}` : null,
    ].filter(Boolean).join(' | ')

    await this.logResult(
      finalResult,
      `daily cost analysis for ${dailySummary.date}`,
      outputSummary,
    )

    logger.info(
      { type: reportType, totalCost: dailySummary.totalCost, alertSent, wikiPageWritten, durationMs },
      '[cost-analysis] execution complete',
    )

    return finalResult
  }

  // ----------------------------------------------------------
  // Private: combined spend query (LiteLLM primary + local supplement)
  // ----------------------------------------------------------

  /**
   * Queries spend from LiteLLM as primary source (real proxy-tracked costs),
   * then supplements with local ai_audit_log for calls that bypass the proxy
   * (e.g., direct Ollama, Anthropic subscription calls logged locally).
   *
   * When LITELLM_SPEND_URL is not set, falls back entirely to local data.
   */
  private async querySpendCombined(from: Date, to: Date): Promise<DailyCostSummary> {
    const litellmData = await this.queryLiteLLMSpend(from, to)
    const localData = await this.queryLocalSpend(from, to)

    if (!litellmData) {
      // No LiteLLM data — use local ai_audit_log as sole source
      return localData
    }

    // Merge: LiteLLM costs are authoritative for proxy-routed calls.
    // Local ai_audit_log supplements with call counts and token totals,
    // plus any calls that bypassed the proxy (e.g., Ollama, direct Anthropic).
    // Use LiteLLM cost values where available, fall back to local estimates.
    const mergedByModel: Map<string, ModelCost> = new Map()

    // Start with local data for call counts and token totals
    for (const m of localData.byModel) {
      const key = `${m.model}|${m.task_type}`
      mergedByModel.set(key, { ...m })
    }

    // Override costs with LiteLLM data where available
    for (const [model, cost] of Object.entries(litellmData.by_model)) {
      // Find matching local entries for this model to update cost
      let found = false
      for (const [key, entry] of mergedByModel) {
        if (entry.model === model) {
          entry.cost_usd = cost
          found = true
        }
      }
      // If no local entry for this model, add a placeholder
      if (!found) {
        mergedByModel.set(`${model}|proxy`, {
          model,
          task_type: 'proxy',
          call_count: 0,
          total_tokens: 0,
          cost_usd: cost,
        })
      }
    }

    const byModel = Array.from(mergedByModel.values()).sort((a, b) => b.cost_usd - a.cost_usd)
    const totalCost = litellmData.total  // LiteLLM total is authoritative
    const totalTokens = byModel.reduce((sum, m) => sum + m.total_tokens, 0)
    const totalCalls = byModel.reduce((sum, m) => sum + m.call_count, 0)

    return {
      date: '',
      totalCost: Number(totalCost.toFixed(6)),
      totalTokens,
      totalCalls,
      byModel,
    }
  }

  // ----------------------------------------------------------
  // Private: query LiteLLM spend API
  // ----------------------------------------------------------

  /**
   * Queries LiteLLM /spend/logs for a date range.
   * Returns null if LITELLM_SPEND_URL is not configured or the request fails.
   *
   * The /spend/logs endpoint returns a raw JSON array of individual request
   * records. We iterate, sum the `spend` field, and group by `model`.
   */
  private async queryLiteLLMSpend(from: Date, to: Date): Promise<{ total: number; by_model: Record<string, number> } | null> {
    if (!this.litellmSpendUrl) return null

    try {
      const startDate = from.toISOString().slice(0, 10)
      const endDate = to.toISOString().slice(0, 10)

      const url = new URL('/spend/logs', this.litellmSpendUrl)
      url.searchParams.set('start_date', startDate)
      url.searchParams.set('end_date', endDate)

      logger.debug({ url: url.toString(), startDate, endDate }, '[cost-analysis] querying LiteLLM spend API')

      const res = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.litellmApiKey}`,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(15_000),
      })

      if (!res.ok) {
        const body = await res.text().catch(() => '')
        logger.warn({ status: res.status, body }, '[cost-analysis] LiteLLM spend API error')
        return null
      }

      const data = await res.json() as unknown

      if (Array.isArray(data)) {
        const by_model: Record<string, number> = {}
        let total = 0

        for (const row of data as Array<Record<string, unknown>>) {
          const rowSpend = typeof row.spend === 'number' ? row.spend
            : typeof row.total_cost === 'number' ? row.total_cost
            : 0
          total += rowSpend

          const model = typeof row.model === 'string' ? row.model : 'unknown'
          by_model[model] = (by_model[model] ?? 0) + rowSpend
        }

        logger.debug({ total, records: data.length }, '[cost-analysis] LiteLLM spend data retrieved')
        return { total, by_model }
      }

      // Handle unexpected object format
      const dataObj = data as Record<string, unknown>
      if (typeof dataObj.total_cost === 'number') {
        return { total: dataObj.total_cost, by_model: (dataObj.spend_by_model as Record<string, number>) ?? {} }
      }

      logger.warn({ data }, '[cost-analysis] LiteLLM spend response format not recognized')
      return null
    } catch (err) {
      logger.warn({ err }, '[cost-analysis] failed to query LiteLLM spend API')
      return null
    }
  }

  // ----------------------------------------------------------
  // Private: query spend from ai_audit_log (delegates to query file)
  // ----------------------------------------------------------

  private async queryLocalSpend(from: Date, to: Date): Promise<DailyCostSummary> {
    return querySpend(this.db, from, to)
  }

  // ----------------------------------------------------------
  // Private: Pushover alert
  // ----------------------------------------------------------

  private async sendAlert(summary: DailyCostSummary, threshold: number): Promise<boolean> {
    if (!this.pushover.isConfigured) {
      logger.debug('[cost-analysis] Pushover not configured — skipping alert')
      return false
    }

    const lines: string[] = [
      `Daily AI spend: $${summary.totalCost.toFixed(2)} (threshold: $${threshold.toFixed(2)})`,
      `Calls: ${summary.totalCalls} | Tokens: ${summary.totalTokens.toLocaleString()}`,
      '',
      'Breakdown:',
    ]

    for (const m of summary.byModel.slice(0, 5)) {
      lines.push(`  ${m.model}/${m.task_type}: $${m.cost_usd.toFixed(4)} (${m.call_count} calls)`)
    }

    try {
      await this.pushover.send({
        title: 'Open Brain: Daily AI Spend Alert',
        message: lines.join('\n'),
        priority: 0,
      })
      return true
    } catch (err) {
      logger.warn({ err }, '[cost-analysis] Pushover alert failed')
      return false
    }
  }

  // ----------------------------------------------------------
  // Private: wiki report
  // ----------------------------------------------------------

  private async writeWikiReport(
    dateStr: string,
    daily: DailyCostSummary,
    weekly?: DailyCostSummary,
    monthly?: DailyCostSummary,
  ): Promise<boolean> {
    const lines: string[] = []
    const now = new Date()

    // Frontmatter
    lines.push('---')
    lines.push(`title: "Cost Report ${dateStr}"`)
    lines.push(`created: ${now.toISOString()}`)
    lines.push(`updated: ${now.toISOString()}`)
    lines.push('tags: [cost, operations, infrastructure]')
    lines.push('---')
    lines.push('')

    // Daily summary
    lines.push(`# Cost Report — ${dateStr}`)
    lines.push('')
    lines.push(`**Total Spend:** $${daily.totalCost.toFixed(4)}`)
    lines.push(`**Total Calls:** ${daily.totalCalls}`)
    lines.push(`**Total Tokens:** ${daily.totalTokens.toLocaleString()}`)
    lines.push('')

    if (daily.byModel.length > 0) {
      lines.push('## Breakdown by Model & Task')
      lines.push('')
      lines.push('| Model | Task Type | Calls | Tokens | Cost (USD) |')
      lines.push('|-------|-----------|-------|--------|------------|')
      for (const m of daily.byModel) {
        lines.push(`| ${m.model} | ${m.task_type} | ${m.call_count} | ${m.total_tokens.toLocaleString()} | $${m.cost_usd.toFixed(4)} |`)
      }
      lines.push('')
    }

    // Weekly summary
    if (weekly) {
      lines.push('## Weekly Summary (7 days)')
      lines.push('')
      lines.push(`**Period:** ${weekly.date}`)
      lines.push(`**Total Spend:** $${weekly.totalCost.toFixed(4)}`)
      lines.push(`**Total Calls:** ${weekly.totalCalls}`)
      lines.push(`**Daily Average:** $${(weekly.totalCost / 7).toFixed(4)}`)
      lines.push('')
    }

    // Monthly summary
    if (monthly) {
      lines.push('## Monthly Summary')
      lines.push('')
      lines.push(`**Period:** ${monthly.date}`)
      lines.push(`**Total Spend:** $${monthly.totalCost.toFixed(4)}`)
      lines.push(`**Total Calls:** ${monthly.totalCalls}`)
      lines.push(`**Total Tokens:** ${monthly.totalTokens.toLocaleString()}`)
      lines.push('')

      if (monthly.byModel.length > 0) {
        lines.push('### Monthly Breakdown')
        lines.push('')
        lines.push('| Model | Task Type | Calls | Tokens | Cost (USD) |')
        lines.push('|-------|-----------|-------|--------|------------|')
        for (const m of monthly.byModel) {
          lines.push(`| ${m.model} | ${m.task_type} | ${m.call_count} | ${m.total_tokens.toLocaleString()} | $${m.cost_usd.toFixed(4)} |`)
        }
        lines.push('')
      }
    }

    const content = lines.join('\n')
    const pagePath = `${this.wikiDir}/${dateStr}.md`

    // Try wiki service first, fall back to local file
    if (this.wikiService) {
      try {
        const frontmatter = {
          title: `Cost Report ${dateStr}`,
          type: 'synthesis' as const,
          created: now.toISOString(),
          updated: now.toISOString(),
          tags: ['cost', 'operations', 'infrastructure'],
        }
        await this.wikiService.writePage(
          pagePath,
          content.split('---').slice(2).join('---').trim(),
          frontmatter,
          `cost-analysis: ${dateStr} report`,
        )
        return true
      } catch (err) {
        logger.warn({ err }, '[cost-analysis] wiki service write failed — falling back to local file')
      }
    }

    // Fallback: write to local wiki directory
    const wikiBase = process.env.WIKI_PATH ?? '/wiki'
    const fullPath = join(wikiBase, pagePath)
    try {
      await mkdir(dirname(fullPath), { recursive: true })
      await writeFile(fullPath, content, 'utf-8')
      return true
    } catch (err) {
      logger.warn({ err, fullPath }, '[cost-analysis] failed to write wiki report')
      return false
    }
  }

}

// ============================================================
// Entry point for skill-execution worker
// ============================================================

export async function executeCostAnalysis(
  db: Database,
  options: CostAnalysisOptions = {},
  wikiService?: WikiGitService,
): Promise<CostAnalysisResult> {
  return new CostAnalysisSkill({
    db,
    wikiService,
    litellmSpendUrl: options.litellmSpendUrl,
    litellmApiKey: options.litellmApiKey,
  }).execute(options)
}
