import { join } from 'node:path'
import OpenAI from 'openai'
import type { Database } from '@open-brain/shared'
import { skills_log, loadAndRenderPromptTemplate } from '@open-brain/shared'
import { logger } from '../lib/logger.js'
import { PushoverService } from '../services/pushover.js'
import {
  queryRecentCaptures,
  buildEntityCoOccurrence,
  assembleContext,
  formatCoOccurrence,
  fmtDate,
  CHARS_PER_TOKEN,
} from './daily-connections-query.js'
import type {
  DailyConnectionsOutput,
  DailyConnectionsResult,
  DailyConnectionsOptions,
  ConnectionItem,
} from './daily-connections-query.js'

// Re-export types so consumers can import from this file
export type { DailyConnectionsOutput, DailyConnectionsResult, DailyConnectionsOptions } from './daily-connections-query.js'

const DEFAULT_WINDOW_DAYS = 7
const DEFAULT_TOKEN_BUDGET = 30_000
const LLM_TIMEOUT_MS = 120_000

/**
 * DailyConnectionsSkill — surfaces non-obvious cross-domain connections
 * across recent captures using entity co-occurrence data and LLM synthesis.
 *
 * Follows the WeeklyBriefSkill pattern: query data, assemble context,
 * call LLM, parse output, deliver via Pushover, save as capture, log to skills_log.
 */
export class DailyConnectionsSkill {
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

  async execute(options: DailyConnectionsOptions = {}): Promise<DailyConnectionsResult> {
    const {
      windowDays = DEFAULT_WINDOW_DAYS,
      tokenBudget = DEFAULT_TOKEN_BUDGET,
      modelAlias = 'synthesis',
    } = options

    const startMs = Date.now()
    const now = new Date()
    const windowStart = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000)
    logger.info({ windowDays, windowStart }, '[daily-connections] starting execution')

    // Step 1: Query recent captures
    const captures = await queryRecentCaptures(this.db, windowDays)
    const captureCount = captures.length
    logger.info({ captureCount }, '[daily-connections] captures fetched')

    if (captureCount === 0) {
      logger.info('[daily-connections] no captures in window — skipping LLM call')
      await this.logToSkillsLog({
        inputSummary: `0 captures in last ${windowDays} days`,
        outputSummary: 'Skipped — no captures',
        durationMs: Date.now() - startMs,
      })
      return {
        output: emptyOutput(),
        captureCount: 0,
        durationMs: Date.now() - startMs,
        savedCaptureId: null,
      }
    }

    // Step 2: Build entity co-occurrence data
    const captureIds = captures.map(c => c.id)
    const coOccurrence = await buildEntityCoOccurrence(this.db, captureIds)
    logger.info({ coOccurrencePairs: coOccurrence.length }, '[daily-connections] entity co-occurrence built')

    // Step 3: Assemble context within token budget
    const { contextText } = assembleContext(captures, tokenBudget * CHARS_PER_TOKEN)
    const coOccurrenceText = formatCoOccurrence(coOccurrence)
    const dateRange = `${fmtDate(windowStart)} to ${fmtDate(now)}`

    // Step 4: Call LLM
    const rawOutput = await this.callLLM(contextText, coOccurrenceText, dateRange, captureCount, modelAlias)
    const output = parseOutput(rawOutput)
    const durationMs = Date.now() - startMs

    // Step 5: Deliver Pushover notification (top 3 connections summary)
    await this.deliverPushover(output)

    // Step 6: Save as capture back into the brain
    const savedCaptureId = await this.saveConnectionsCapture(output, fmtDate(windowStart), fmtDate(now))

    // Step 7: Log to skills_log
    await this.logToSkillsLog({
      inputSummary: `${captureCount} captures from ${dateRange}, ${coOccurrence.length} entity pairs`,
      outputSummary: `summary: "${output.summary}" | connections:${output.connections.length} | meta_pattern:${output.meta_pattern ? 'yes' : 'none'}`,
      durationMs,
      captureId: savedCaptureId ?? undefined,
      result: output,
    })

    logger.info({ captureCount, connectionCount: output.connections.length, durationMs, savedCaptureId }, '[daily-connections] execution complete')

    return { output, captureCount, durationMs, savedCaptureId }
  }

  // ----------------------------------------------------------
  // Private: LLM call
  // ----------------------------------------------------------

  private async callLLM(
    contextText: string,
    coOccurrenceText: string,
    dateRange: string,
    captureCount: number,
    modelAlias: string,
  ): Promise<string> {
    const prompt = loadAndRenderPromptTemplate(this.promptsDir, 'daily_connections_v1.txt', {
      date_range: dateRange,
      capture_count: String(captureCount),
      captures: contextText,
      entity_cooccurrence: coOccurrenceText,
    })
    logger.debug({ modelAlias, promptLength: prompt.length }, '[daily-connections] calling LLM')

    const response = await this.litellmClient.chat.completions.create({
      model: modelAlias,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.4,
      max_tokens: 2048,
      extra_body: { chat_template_kwargs: { enable_thinking: false } },
    } as any)

    const text = response.choices[0]?.message?.content ?? ''
    logger.info(
      { promptTokens: response.usage?.prompt_tokens, completionTokens: response.usage?.completion_tokens },
      '[daily-connections] LLM call complete',
    )
    return text
  }

  // ----------------------------------------------------------
  // Private: Pushover delivery
  // ----------------------------------------------------------

  private async deliverPushover(output: DailyConnectionsOutput): Promise<void> {
    if (!this.pushover.isConfigured) return
    if (output.connections.length === 0) return

    const top3 = output.connections.slice(0, 3)
    const lines = [
      output.summary,
      '',
      ...top3.map((c, i) => `${i + 1}. ${c.theme}: ${c.insight.slice(0, 100)}`),
    ]

    try {
      await this.pushover.send({
        title: 'Daily Connections',
        message: lines.join('\n'),
        priority: 0,
      })
    } catch {
      // Pushover delivery is non-fatal
    }
  }

  // ----------------------------------------------------------
  // Private: Save as capture
  // ----------------------------------------------------------

  private async saveConnectionsCapture(
    output: DailyConnectionsOutput,
    windowStart: string,
    windowEnd: string,
  ): Promise<string | null> {
    try {
      const content = buildConnectionsText(output, windowStart, windowEnd)
      const res = await fetch(`${this.coreApiUrl}/api/v1/captures`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content,
          capture_type: 'reflection',
          brain_view: 'personal',
          source: 'api',
          tags: ['connections', 'skill-output'],
          metadata: {
            source_metadata: {
              generator: 'daily-connections-skill',
              window_start: windowStart,
              window_end: windowEnd,
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
    result?: DailyConnectionsOutput
  }): Promise<void> {
    try {
      await this.db.insert(skills_log).values({
        skill_name: 'daily-connections',
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
export async function executeDailyConnections(
  db: Database,
  options: DailyConnectionsOptions = {},
): Promise<DailyConnectionsResult> {
  return new DailyConnectionsSkill({ db }).execute(options)
}

// ============================================================
// Output parsing
// ============================================================

function emptyOutput(): DailyConnectionsOutput {
  return { summary: '', connections: [], meta_pattern: null }
}

/**
 * Parses LLM JSON output into a DailyConnectionsOutput.
 * Handles markdown code fences and malformed output gracefully.
 * Exported for testing.
 */
export function parseOutput(raw: string): DailyConnectionsOutput {
  let cleaned = raw.trim()
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(cleaned)
  } catch (err) {
    logger.warn({ raw: raw.slice(0, 500), err }, '[daily-connections] failed to parse LLM output as JSON — saving raw text')
    // Graceful fallback: return the raw text as the summary so it's still saved
    return {
      summary: raw.slice(0, 150),
      connections: [],
      meta_pattern: null,
    }
  }

  const summary = typeof parsed.summary === 'string' ? parsed.summary : '(no summary)'
  const meta_pattern = typeof parsed.meta_pattern === 'string' ? parsed.meta_pattern : null

  // Parse connections array
  const connections: ConnectionItem[] = []
  if (Array.isArray(parsed.connections)) {
    for (const item of parsed.connections) {
      if (typeof item === 'object' && item !== null) {
        const conn = item as Record<string, unknown>
        connections.push({
          theme: typeof conn.theme === 'string' ? conn.theme : '(unnamed)',
          captures: Array.isArray(conn.captures)
            ? conn.captures.filter((c): c is string => typeof c === 'string')
            : [],
          insight: typeof conn.insight === 'string' ? conn.insight : '',
          confidence: isValidConfidence(conn.confidence) ? conn.confidence : 'low',
          domains: Array.isArray(conn.domains)
            ? conn.domains.filter((d): d is string => typeof d === 'string')
            : [],
        })
      }
    }
  }

  return { summary, connections, meta_pattern }
}

function isValidConfidence(val: unknown): val is 'high' | 'medium' | 'low' {
  return val === 'high' || val === 'medium' || val === 'low'
}

// ============================================================
// Text rendering (for capture-back-to-brain)
// ============================================================

function buildConnectionsText(
  output: DailyConnectionsOutput,
  windowStart: string,
  windowEnd: string,
): string {
  const lines: string[] = [
    `Daily Connections — ${windowStart} to ${windowEnd}`,
    '',
    output.summary,
    '',
  ]

  if (output.connections.length > 0) {
    lines.push('Connections:')
    for (const conn of output.connections) {
      lines.push(`- [${conn.confidence}] ${conn.theme} (${conn.domains.join(', ')})`)
      lines.push(`  ${conn.insight}`)
    }
    lines.push('')
  }

  if (output.meta_pattern) {
    lines.push('Meta-pattern:')
    lines.push(output.meta_pattern)
    lines.push('')
  }

  return lines.join('\n').trim()
}
