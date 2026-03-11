import { join } from 'node:path'
import OpenAI from 'openai'
import type { Database } from '@open-brain/shared'
import { skills_log, loadAndRenderPromptTemplate } from '@open-brain/shared'
import { logger } from '../lib/logger.js'
import { PushoverService } from '../services/pushover.js'
import {
  queryPendingBets,
  queryBetActivity,
  queryEntityFrequency,
  queryGovernanceCommitments,
  formatPendingBets,
  formatGovernanceCommitments,
  formatEntityFrequency,
  fmtDate,
  DEFAULT_BET_ACTIVITY_DAYS,
  DEFAULT_COMMITMENT_DAYS,
  DEFAULT_ENTITY_WINDOW_DAYS,
} from './drift-monitor-query.js'
import type {
  DriftMonitorOutput,
  DriftMonitorResult,
  DriftMonitorOptions,
  DriftItem,
  BetWithActivity,
} from './drift-monitor-query.js'

// Re-export types so consumers can import from this file
export type { DriftMonitorOutput, DriftMonitorResult, DriftMonitorOptions } from './drift-monitor-query.js'

const LLM_TIMEOUT_MS = 120_000

/**
 * DriftMonitorSkill — detects when tracked commitments, bets, or projects go silent.
 *
 * Follows the DailyConnectionsSkill pattern: query data, assemble context,
 * call LLM, parse output, conditionally deliver via Pushover, save as capture, log to skills_log.
 *
 * Key difference from DailyConnectionsSkill: Pushover notification is only sent
 * when drift items with severity >= medium exist.
 */
export class DriftMonitorSkill {
  private db: Database
  private litellmClient: OpenAI
  private pushover: PushoverService
  private promptsDir: string
  private coreApiUrl: string

  constructor(opts: {
    db: Database
    litellmBaseUrl?: string
    litellmApiKey?: string
    pushover?: PushoverService
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
    this.promptsDir = opts.promptsDir ?? join(process.cwd(), 'config', 'prompts')
    this.coreApiUrl = opts.coreApiUrl ?? process.env.OPEN_BRAIN_API_URL ?? 'http://localhost:3000'
  }

  async execute(options: DriftMonitorOptions = {}): Promise<DriftMonitorResult> {
    const {
      betActivityDays = DEFAULT_BET_ACTIVITY_DAYS,
      commitmentDays = DEFAULT_COMMITMENT_DAYS,
      entityWindowDays = DEFAULT_ENTITY_WINDOW_DAYS,
      modelAlias = 'synthesis',
    } = options

    const startMs = Date.now()
    const now = new Date()
    logger.info({ betActivityDays, commitmentDays, entityWindowDays }, '[drift-monitor] starting execution')

    // Step 1: Query pending bets and their activity
    const pendingBets = await queryPendingBets(this.db)
    const betsWithActivity: BetWithActivity[] = await Promise.all(
      pendingBets.map(bet => queryBetActivity(this.db, bet, betActivityDays)),
    )
    logger.info({ pendingBetCount: pendingBets.length }, '[drift-monitor] bets queried')

    // Step 2: Query governance commitments
    const commitments = await queryGovernanceCommitments(this.db, commitmentDays)
    logger.info({ commitmentCount: commitments.length }, '[drift-monitor] governance commitments queried')

    // Step 3: Query entity frequency trends
    const entityFrequency = await queryEntityFrequency(this.db, entityWindowDays)
    logger.info({ decliningEntityCount: entityFrequency.length }, '[drift-monitor] entity frequency queried')

    // Step 4: Check if there's anything to analyze
    const hasData = betsWithActivity.length > 0 || commitments.length > 0 || entityFrequency.length > 0
    if (!hasData) {
      logger.info('[drift-monitor] no bets, commitments, or declining entities — skipping LLM call')
      const emptyResult = emptyOutput()
      await this.logToSkillsLog({
        inputSummary: 'No pending bets, no governance commitments, no entity frequency data',
        outputSummary: 'Skipped — no data to analyze',
        durationMs: Date.now() - startMs,
      })
      return {
        output: emptyResult,
        durationMs: Date.now() - startMs,
        savedCaptureId: null,
        notificationSent: false,
      }
    }

    // Step 5: Assemble context and call LLM
    const pendingBetsText = formatPendingBets(betsWithActivity)
    const commitmentsText = formatGovernanceCommitments(commitments)
    const entityFrequencyText = formatEntityFrequency(entityFrequency)
    const analysisDate = fmtDate(now)

    const rawOutput = await this.callLLM(pendingBetsText, commitmentsText, entityFrequencyText, analysisDate, modelAlias)
    const output = parseOutput(rawOutput)
    const durationMs = Date.now() - startMs

    // Step 6: Conditional Pushover — only if severity >= medium items exist
    const hasMediumOrAbove = output.drift_items.some(d => d.severity === 'high' || d.severity === 'medium')
    let notificationSent = false
    if (hasMediumOrAbove) {
      notificationSent = await this.deliverPushover(output)
    }

    // Step 7: Save as capture back into the brain
    const savedCaptureId = await this.saveDriftCapture(output, analysisDate)

    // Step 8: Log to skills_log
    await this.logToSkillsLog({
      inputSummary: `${betsWithActivity.length} bets, ${commitments.length} commitments, ${entityFrequency.length} declining entities`,
      outputSummary: `health: ${output.overall_health} | drift_items: ${output.drift_items.length} | high: ${output.drift_items.filter(d => d.severity === 'high').length} | medium: ${output.drift_items.filter(d => d.severity === 'medium').length} | notified: ${notificationSent}`,
      durationMs,
      captureId: savedCaptureId ?? undefined,
      result: output,
    })

    logger.info(
      { driftItemCount: output.drift_items.length, overallHealth: output.overall_health, durationMs, notificationSent, savedCaptureId },
      '[drift-monitor] execution complete',
    )

    return { output, durationMs, savedCaptureId, notificationSent }
  }

  // ----------------------------------------------------------
  // Private: LLM call
  // ----------------------------------------------------------

  private async callLLM(
    pendingBetsText: string,
    commitmentsText: string,
    entityFrequencyText: string,
    analysisDate: string,
    modelAlias: string,
  ): Promise<string> {
    const prompt = loadAndRenderPromptTemplate(this.promptsDir, 'drift_monitor_v1.txt', {
      analysis_date: analysisDate,
      pending_bets: pendingBetsText,
      governance_commitments: commitmentsText,
      entity_frequency: entityFrequencyText,
    })
    logger.debug({ modelAlias, promptLength: prompt.length }, '[drift-monitor] calling LLM')

    const response = await this.litellmClient.chat.completions.create({
      model: modelAlias,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 2048,
      extra_body: { chat_template_kwargs: { enable_thinking: false } },
    } as any)

    const text = response.choices[0]?.message?.content ?? ''
    logger.info(
      { promptTokens: response.usage?.prompt_tokens, completionTokens: response.usage?.completion_tokens },
      '[drift-monitor] LLM call complete',
    )
    return text
  }

  // ----------------------------------------------------------
  // Private: Conditional Pushover delivery
  // ----------------------------------------------------------

  private async deliverPushover(output: DriftMonitorOutput): Promise<boolean> {
    if (!this.pushover.isConfigured) return false

    const mediumAndAbove = output.drift_items.filter(d => d.severity === 'high' || d.severity === 'medium')
    if (mediumAndAbove.length === 0) return false

    const highCount = mediumAndAbove.filter(d => d.severity === 'high').length
    const priority = highCount > 0 ? 1 : 0 // high priority for Pushover if any high-severity drift items

    const lines = [
      output.summary,
      '',
      ...mediumAndAbove.slice(0, 5).map((d, i) =>
        `${i + 1}. [${d.severity.toUpperCase()}] ${d.item_name.slice(0, 60)} — ${d.days_silent}d silent`,
      ),
    ]

    try {
      await this.pushover.send({
        title: `Drift Monitor: ${output.overall_health.replace(/_/g, ' ')}`,
        message: lines.join('\n'),
        priority: priority as 0 | 1,
      })
      return true
    } catch {
      // Pushover delivery is non-fatal
      return false
    }
  }

  // ----------------------------------------------------------
  // Private: Save as capture
  // ----------------------------------------------------------

  private async saveDriftCapture(
    output: DriftMonitorOutput,
    analysisDate: string,
  ): Promise<string | null> {
    try {
      const content = buildDriftText(output, analysisDate)
      const res = await fetch(`${this.coreApiUrl}/api/v1/captures`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content,
          capture_type: 'reflection',
          brain_view: 'personal',
          source: 'api',
          tags: ['drift', 'skill-output'],
          metadata: {
            source_metadata: {
              generator: 'drift-monitor-skill',
              analysis_date: analysisDate,
              overall_health: output.overall_health,
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
  // Private: skills_log
  // ----------------------------------------------------------

  private async logToSkillsLog(params: {
    inputSummary: string
    outputSummary: string
    durationMs: number
    captureId?: string
    result?: DriftMonitorOutput
  }): Promise<void> {
    try {
      await this.db.insert(skills_log).values({
        skill_name: 'drift-monitor',
        capture_id: params.captureId ?? null,
        input_summary: params.inputSummary,
        output_summary: params.outputSummary,
        result: params.result ?? null,
        duration_ms: params.durationMs,
      })
    } catch {
      // skills_log failure is non-fatal
    }
  }
}

// ============================================================
// Top-level entry point — called by BullMQ worker dispatcher
// ============================================================

/** Top-level entry point called by BullMQ worker. */
export async function executeDriftMonitor(
  db: Database,
  options: DriftMonitorOptions = {},
): Promise<DriftMonitorResult> {
  return new DriftMonitorSkill({ db }).execute(options)
}

// ============================================================
// Output parsing
// ============================================================

function emptyOutput(): DriftMonitorOutput {
  return { summary: 'All tracked items are active — no drift detected.', drift_items: [], overall_health: 'healthy' }
}

/**
 * Parses LLM JSON output into a DriftMonitorOutput.
 * Handles markdown code fences and malformed output gracefully.
 * Exported for testing.
 */
export function parseOutput(raw: string): DriftMonitorOutput {
  let cleaned = raw.trim()
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(cleaned)
  } catch (err) {
    logger.warn({ raw: raw.slice(0, 500), err }, '[drift-monitor] failed to parse LLM output as JSON — saving raw text')
    return {
      summary: raw.slice(0, 150),
      drift_items: [],
      overall_health: 'healthy',
    }
  }

  const summary = typeof parsed.summary === 'string' ? parsed.summary : '(no summary)'
  const overall_health = isValidHealth(parsed.overall_health) ? parsed.overall_health : 'healthy'

  // Parse drift_items array
  const drift_items: DriftItem[] = []
  if (Array.isArray(parsed.drift_items)) {
    for (const item of parsed.drift_items) {
      if (typeof item === 'object' && item !== null) {
        const d = item as Record<string, unknown>
        drift_items.push({
          item_type: isValidItemType(d.item_type) ? d.item_type : 'entity',
          item_name: typeof d.item_name === 'string' ? d.item_name : '(unnamed)',
          severity: isValidSeverity(d.severity) ? d.severity : 'low',
          days_silent: typeof d.days_silent === 'number' ? d.days_silent : 0,
          reason: typeof d.reason === 'string' ? d.reason : '',
          suggested_action: typeof d.suggested_action === 'string' ? d.suggested_action : '',
        })
      }
    }
  }

  return { summary, drift_items, overall_health }
}

function isValidHealth(val: unknown): val is DriftMonitorOutput['overall_health'] {
  return val === 'healthy' || val === 'minor_drift' || val === 'significant_drift' || val === 'critical_drift'
}

function isValidSeverity(val: unknown): val is 'high' | 'medium' | 'low' {
  return val === 'high' || val === 'medium' || val === 'low'
}

function isValidItemType(val: unknown): val is 'bet' | 'commitment' | 'entity' {
  return val === 'bet' || val === 'commitment' || val === 'entity'
}

// ============================================================
// Text rendering (for capture-back-to-brain)
// ============================================================

function buildDriftText(
  output: DriftMonitorOutput,
  analysisDate: string,
): string {
  const lines: string[] = [
    `Drift Monitor Report — ${analysisDate}`,
    `Overall health: ${output.overall_health.replace(/_/g, ' ')}`,
    '',
    output.summary,
    '',
  ]

  if (output.drift_items.length > 0) {
    lines.push('Drift items:')
    for (const item of output.drift_items) {
      lines.push(`- [${item.severity.toUpperCase()}] [${item.item_type}] ${item.item_name}`)
      lines.push(`  Silent: ${item.days_silent} days | ${item.reason}`)
      lines.push(`  Action: ${item.suggested_action}`)
    }
    lines.push('')
  } else {
    lines.push('No drift items detected — all tracked items are active.')
    lines.push('')
  }

  return lines.join('\n').trim()
}
