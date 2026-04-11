import { sql } from 'drizzle-orm'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import type { Database } from '@open-brain/shared'
import { skills_log, logger, PushoverService } from '@open-brain/shared'
import type { WikiGitService } from '@open-brain/shared'

// ============================================================
// Types
// ============================================================

export interface CostAnalysisOptions {
  /** Override "now" for deterministic testing. */
  now?: Date
  /** Daily spend alert threshold in USD. Default: 2.00. */
  dailyAlertThreshold?: number
  /** Wiki output directory (relative to wiki root). Default: operations/cost-reports */
  wikiDir?: string
}

export interface ModelCost {
  model: string
  task_type: string
  call_count: number
  total_tokens: number
  cost_usd: number
}

export interface DailyCostSummary {
  date: string
  totalCost: number
  totalTokens: number
  totalCalls: number
  byModel: ModelCost[]
}

export interface CostAnalysisResult {
  type: 'daily' | 'weekly' | 'monthly'
  summary: DailyCostSummary
  /** Weekly summary (last 7 days), only present on Mondays */
  weeklySummary?: DailyCostSummary
  /** Monthly summary (previous month), only present on 1st of month */
  monthlySummary?: DailyCostSummary
  alertSent: boolean
  wikiPageWritten: boolean
  durationMs: number
}

// ============================================================
// Constants
// ============================================================

const DEFAULT_DAILY_ALERT_THRESHOLD = 2.00
const DEFAULT_WIKI_DIR = 'operations/cost-reports'

// ============================================================
// CostAnalysisSkill
// ============================================================

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
export class CostAnalysisSkill {
  private db: Database
  private pushover: PushoverService
  private wikiService?: WikiGitService
  private wikiDir: string

  constructor(opts: {
    db: Database
    pushover?: PushoverService
    wikiService?: WikiGitService
    wikiDir?: string
  }) {
    this.db = opts.db
    this.pushover = opts.pushover ?? new PushoverService()
    this.wikiService = opts.wikiService
    this.wikiDir = opts.wikiDir ?? DEFAULT_WIKI_DIR
  }

  async execute(options: CostAnalysisOptions = {}): Promise<CostAnalysisResult> {
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

    // Step 1: Query daily spend
    const dailySummary = await this.querySpend(yesterday, todayStart)
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
      weeklySummary = await this.querySpend(weekStart, todayStart)
      weeklySummary.date = `${weekStart.toISOString().split('T')[0]} to ${dateStr}`
    }

    // Step 3: Check for monthly summary (1st of month)
    let monthlySummary: DailyCostSummary | undefined
    if (now.getDate() === 1) {
      const monthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1)
      const monthEnd = new Date(now.getFullYear(), now.getMonth(), 1)
      monthlySummary = await this.querySpend(monthStart, monthEnd)
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

    // Step 6: Log to skills_log
    await this.logToSkillsLog({
      dailySummary,
      weeklySummary,
      monthlySummary,
      alertSent,
      wikiPageWritten,
      durationMs,
    })

    logger.info(
      { type: reportType, totalCost: dailySummary.totalCost, alertSent, wikiPageWritten, durationMs },
      '[cost-analysis] execution complete',
    )

    return {
      type: reportType,
      summary: dailySummary,
      weeklySummary,
      monthlySummary,
      alertSent,
      wikiPageWritten,
      durationMs,
    }
  }

  // ----------------------------------------------------------
  // Private: query spend from ai_audit_log
  // ----------------------------------------------------------

  private async querySpend(from: Date, to: Date): Promise<DailyCostSummary> {
    try {
      const rows = await this.db.execute<{
        model: string
        task_type: string
        call_count: string
        total_tokens: string
        cost_usd: string
      }>(sql`
        SELECT
          model,
          task_type,
          COUNT(*)::text AS call_count,
          COALESCE(SUM(total_tokens), 0)::text AS total_tokens,
          COALESCE(SUM(cost_usd::numeric), 0)::text AS cost_usd
        FROM ai_audit_log
        WHERE created_at >= ${from.toISOString()}::timestamptz
          AND created_at < ${to.toISOString()}::timestamptz
        GROUP BY model, task_type
        ORDER BY cost_usd DESC
      `)

      const byModel: ModelCost[] = (rows.rows as any[]).map(r => ({
        model: r.model,
        task_type: r.task_type,
        call_count: Number(r.call_count),
        total_tokens: Number(r.total_tokens),
        cost_usd: Number(Number(r.cost_usd).toFixed(6)),
      }))

      const totalCost = byModel.reduce((sum, m) => sum + m.cost_usd, 0)
      const totalTokens = byModel.reduce((sum, m) => sum + m.total_tokens, 0)
      const totalCalls = byModel.reduce((sum, m) => sum + m.call_count, 0)

      return {
        date: '',
        totalCost: Number(totalCost.toFixed(6)),
        totalTokens,
        totalCalls,
        byModel,
      }
    } catch (err) {
      logger.warn({ err }, '[cost-analysis] failed to query ai_audit_log')
      return { date: '', totalCost: 0, totalTokens: 0, totalCalls: 0, byModel: [] }
    }
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

  // ----------------------------------------------------------
  // Private: skills_log
  // ----------------------------------------------------------

  private async logToSkillsLog(params: {
    dailySummary: DailyCostSummary
    weeklySummary?: DailyCostSummary
    monthlySummary?: DailyCostSummary
    alertSent: boolean
    wikiPageWritten: boolean
    durationMs: number
  }): Promise<void> {
    const outputSummary = [
      `date:${params.dailySummary.date}`,
      `cost:$${params.dailySummary.totalCost.toFixed(4)}`,
      `calls:${params.dailySummary.totalCalls}`,
      `tokens:${params.dailySummary.totalTokens}`,
      `alert:${params.alertSent}`,
      `wiki:${params.wikiPageWritten}`,
      params.weeklySummary ? `weekly:$${params.weeklySummary.totalCost.toFixed(4)}` : null,
      params.monthlySummary ? `monthly:$${params.monthlySummary.totalCost.toFixed(4)}` : null,
    ].filter(Boolean).join(' | ')

    try {
      await this.db.insert(skills_log).values({
        skill_name: 'cost-analysis',
        input_summary: `daily cost analysis for ${params.dailySummary.date}`,
        output_summary: outputSummary,
        duration_ms: params.durationMs,
      })
    } catch (err) {
      logger.warn({ err }, '[cost-analysis] failed to write skills_log entry')
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
  const skill = new CostAnalysisSkill({
    db,
    wikiService,
  })
  return skill.execute(options)
}
