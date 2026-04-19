import type { Database, LLMGatewayService, AutonomyLevel } from '@open-brain/shared'
import { logger } from '@open-brain/shared'
import { LLMSkill } from './llm-skill.js'
import type { LLMSkillOpts } from './types.js'
import {
  queryTodayCaptures,
  queryUnresolvedQuestions,
  queryNewEntities,
  queryVoiceStats,
  assembleContext,
  fmtDate,
  formatVoiceStatsLine,
  DEFAULT_TOKEN_BUDGET,
  CHARS_PER_TOKEN,
} from './daily-sweep-query.js'
import type {
  DailySweepOutput,
  DailySweepResult,
  DailySweepOptions,
  VoiceStats,
} from './daily-sweep-query.js'

// Re-export types so consumers can import from this file
export type { DailySweepOutput, DailySweepResult, DailySweepOptions, VoiceStats } from './daily-sweep-query.js'
export {
  queryTodayCaptures,
  queryUnresolvedQuestions,
  queryNewEntities,
  queryVoiceStats,
  assembleContext,
  fmtDate,
  formatVoiceStatsLine,
} from './daily-sweep-query.js'

// ============================================================
// DailySweepSkill class
// ============================================================

/**
 * DailySweepSkill — produces an evening summary of the day's captures.
 *
 * Follows the DailyConnectionsSkill/DriftMonitorSkill pattern:
 * query data, assemble context, call LLM, parse output, deliver via Pushover,
 * save as capture, log to skills_log.
 */
export class DailySweepSkill extends LLMSkill<DailySweepOptions, DailySweepResult> {
  static minimum_autonomy: AutonomyLevel = 'assist'

  constructor(opts: LLMSkillOpts) {
    super('daily-sweep-skill', opts)
  }

  protected async run(options: DailySweepOptions = {}): Promise<DailySweepResult> {
    const {
      tokenBudget: rawBudget = DEFAULT_TOKEN_BUDGET,
      storeCapture = false,
    } = options
    const tokenBudget = Math.max(1_000, Math.min(rawBudget, 100_000))

    const startMs = Date.now()
    const today = new Date()
    logger.info({ tokenBudget }, '[daily-sweep-skill] starting execution')

    // Step 1: Query today's captures
    const captures = await queryTodayCaptures(this.db)
    const captureCount = captures.length
    logger.info({ captureCount }, '[daily-sweep-skill] captures fetched')

    // Query voice stats (used in both quiet-day and normal paths)
    const voiceStats = await queryVoiceStats(this.db)

    if (captureCount === 0) {
      logger.info('[daily-sweep-skill] no captures today — producing quiet-day summary')
      const quietOutput = emptyOutput()
      const notificationSent = await this.deliverPushover(quietOutput, voiceStats)
      const quietResult: DailySweepResult = {
        output: quietOutput,
        captureCount: 0,
        durationMs: Date.now() - startMs,
        savedCaptureId: null,
        notificationSent,
      }
      await this.logResult(
        quietResult,
        '0 captures today',
        'Quiet day — no captures',
      )
      return quietResult
    }

    // Step 2: Query unresolved questions and new entities
    const questions = await queryUnresolvedQuestions(this.db)
    const newEntities = await queryNewEntities(this.db)
    logger.info(
      { unresolvedQuestions: questions.length, newEntities: newEntities.length },
      '[daily-sweep-skill] supplementary data fetched',
    )

    // Step 3: Assemble context within token budget
    const maxChars = tokenBudget * CHARS_PER_TOKEN
    const { capturesText, questionsText, entitiesText } = assembleContext(captures, questions, newEntities, maxChars)

    // Step 4: Call LLM
    const rawOutput = await this.callLLM(capturesText, questionsText, entitiesText, captureCount, fmtDate(today), 'synthesis')
    const output = parseOutput(rawOutput)
    const durationMs = Date.now() - startMs

    // Step 5: Deliver Pushover notification
    const notificationSent = await this.deliverPushover(output, voiceStats)

    // Step 6: Optionally save as capture back into the brain
    const savedCaptureId = storeCapture
      ? await this.saveSweepCapture(output, fmtDate(today))
      : null

    // Step 7: Log to skills_log via BaseSkill
    const finalResult: DailySweepResult = { output, captureCount, durationMs, savedCaptureId, notificationSent }
    await this.logResult(
      finalResult,
      `${captureCount} captures, ${questions.length} unresolved questions, ${newEntities.length} new entities`,
      `headline: "${output.headline}" | decisions:${output.key_decisions.length} questions:${output.unresolved_questions.length} entities:${output.new_entities.length} tasks:${output.tasks_without_followup.length} | notified:${notificationSent}`,
      savedCaptureId ?? undefined,
    )

    logger.info(
      { captureCount, durationMs, notificationSent, savedCaptureId, headline: output.headline },
      '[daily-sweep-skill] execution complete',
    )

    return finalResult
  }

  // ----------------------------------------------------------
  // Private: LLM call
  // ----------------------------------------------------------

  private async callLLM(
    capturesText: string,
    questionsText: string,
    entitiesText: string,
    captureCount: number,
    date: string,
    modelAlias: string,
  ): Promise<string> {
    const prompt = this.templates.render('daily_sweep_v1.txt', {
      date,
      capture_count: String(captureCount),
      captures: capturesText,
      unresolved_questions: questionsText,
      new_entities: entitiesText,
    })
    logger.debug({ modelAlias, promptLength: prompt.length }, '[daily-sweep-skill] calling LLM')

    // Prefer LLMGatewayService (task-based tier routing with audit log)
    if (this.llmGateway) {
      const raw = await this.llmGateway.completeByTask(prompt, 'daily_sweep', {
        temperature: 0.3,
        maxTokens: 2048,
      })
      logger.info('[daily-sweep-skill] LLM call complete (gateway)')
      return raw
    }

    // Test-compat fallback: OpenAI/LiteLLM client (injected in unit tests)
    if (!this.litellmClient) throw new Error('[daily-sweep-skill] No LLM client configured — set OPENAI_API_KEY or inject llmGateway')

    const response = await this.litellmClient.chat.completions.create({
      model: modelAlias,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_completion_tokens: 2048,
    })

    const text = response.choices[0]?.message?.content ?? ''
    logger.info(
      { promptTokens: response.usage?.prompt_tokens, completionTokens: response.usage?.completion_tokens },
      '[daily-sweep-skill] LLM call complete (OpenAI)',
    )
    return text
  }

  // ----------------------------------------------------------
  // Private: Pushover delivery
  // ----------------------------------------------------------

  private async deliverPushover(output: DailySweepOutput, voiceStats: VoiceStats): Promise<boolean> {
    if (!this.pushover.isConfigured) return false

    const lines: string[] = [output.headline]

    if (output.key_decisions.length > 0) {
      lines.push('', 'Decisions:')
      for (const d of output.key_decisions.slice(0, 3)) {
        lines.push(`  - ${d}`)
      }
    }

    if (output.unresolved_questions.length > 0) {
      lines.push('', 'Open questions:')
      for (const q of output.unresolved_questions.slice(0, 3)) {
        lines.push(`  - ${q}`)
      }
    }

    // Voice capture habit nudge
    lines.push('', formatVoiceStatsLine(voiceStats))

    try {
      await this.pushover.send({
        title: 'Daily Sweep',
        message: lines.join('\n'),
        priority: 0,
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

  private async saveSweepCapture(
    output: DailySweepOutput,
    date: string,
  ): Promise<string | null> {
    try {
      const content = buildSweepText(output, date)
      const res = await fetch(`${this.coreApiUrl}/api/v1/captures`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content,
          capture_type: 'reflection',
          brain_view: 'personal',
          source: 'api',
          tags: ['daily-sweep', 'skill-output'],
          metadata: {
            source_metadata: {
              generator: 'daily-sweep-skill',
              date,
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

}

// ============================================================
// Top-level entry point — called by BullMQ worker dispatcher
// ============================================================

/** Top-level entry point called by BullMQ worker. */
export async function executeDailySweep(
  db: Database,
  options: DailySweepOptions = {},
  llmGateway?: LLMGatewayService,
): Promise<DailySweepResult> {
  return new DailySweepSkill({ db, llmGateway }).execute(options)
}

// ============================================================
// Output parsing
// ============================================================

function emptyOutput(): DailySweepOutput {
  return {
    headline: 'Quiet day — no captures',
    key_decisions: [],
    unresolved_questions: [],
    new_entities: [],
    tasks_without_followup: [],
    notable_captures: [],
  }
}

/**
 * Parses LLM JSON output into a DailySweepOutput.
 * Handles markdown code fences and malformed output gracefully.
 * Exported for testing.
 */
export function parseOutput(raw: string): DailySweepOutput {
  let cleaned = raw.trim()
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(cleaned)
  } catch (err) {
    logger.warn({ raw: raw.slice(0, 500), err }, '[daily-sweep-skill] failed to parse LLM output as JSON — saving raw text')
    return {
      headline: raw.slice(0, 120),
      key_decisions: [],
      unresolved_questions: [],
      new_entities: [],
      tasks_without_followup: [],
      notable_captures: [],
    }
  }

  const headline = typeof parsed.headline === 'string' ? parsed.headline : '(no headline)'

  const arrayFields = ['key_decisions', 'unresolved_questions', 'new_entities', 'tasks_without_followup', 'notable_captures'] as const
  const output: DailySweepOutput = {
    headline,
    key_decisions: [],
    unresolved_questions: [],
    new_entities: [],
    tasks_without_followup: [],
    notable_captures: [],
  }

  for (const field of arrayFields) {
    const val = parsed[field]
    if (Array.isArray(val)) {
      output[field] = val.filter((item): item is string => typeof item === 'string').slice(0, 5)
    }
  }

  return output
}

// ============================================================
// Text rendering (for capture-back-to-brain)
// ============================================================

function buildSweepText(output: DailySweepOutput, date: string): string {
  const lines: string[] = [
    `Daily Sweep — ${date}`,
    '',
    output.headline,
    '',
  ]

  const sections: Array<{ label: string; items: string[] }> = [
    { label: 'Key Decisions', items: output.key_decisions },
    { label: 'Unresolved Questions', items: output.unresolved_questions },
    { label: 'New Entities', items: output.new_entities },
    { label: 'Tasks Without Follow-up', items: output.tasks_without_followup },
    { label: 'Notable Captures', items: output.notable_captures },
  ]

  for (const section of sections) {
    if (section.items.length > 0) {
      lines.push(`${section.label}:`)
      for (const item of section.items) {
        lines.push(`- ${item}`)
      }
      lines.push('')
    }
  }

  return lines.join('\n').trim()
}
