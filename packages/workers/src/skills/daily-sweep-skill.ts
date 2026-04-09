import { join } from 'node:path'
import type OpenAI from 'openai'
import { sql } from 'drizzle-orm'
import type { Database } from '@open-brain/shared'
import { skills_log, logger, PushoverService, createLiteLLMClient, TemplateCache } from '@open-brain/shared'

// ============================================================
// Types
// ============================================================

export interface DailySweepOutput {
  headline: string
  key_decisions: string[]
  unresolved_questions: string[]
  new_entities: string[]
  tasks_without_followup: string[]
  notable_captures: string[]
}

export interface DailySweepResult {
  output: DailySweepOutput
  captureCount: number
  durationMs: number
  savedCaptureId: string | null
  notificationSent: boolean
}

export interface DailySweepOptions {
  /** Max chars of context to include. Default: 30000 */
  tokenBudget?: number
  /** Actual model name (not alias). Required. */
  modelAlias?: string
  /** Whether to save the sweep output as a capture. Default: false */
  storeCapture?: boolean
}

// ============================================================
// Constants
// ============================================================

const DEFAULT_TOKEN_BUDGET = 30_000
const CHARS_PER_TOKEN = 4

// ============================================================
// Query helpers
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

interface QuestionRow {
  [key: string]: unknown
  id: string
  content: string
  brain_view: string
  created_at: string
  tags: string[] | null
}

interface EntityRow {
  [key: string]: unknown
  name: string
  entity_type: string
}

/** Query today's completed captures. */
export async function queryTodayCaptures(db: Database): Promise<CaptureRow[]> {
  const todayMidnight = new Date()
  todayMidnight.setHours(0, 0, 0, 0)

  const result = await db.execute<CaptureRow>(sql`
    SELECT id::text, content, capture_type, brain_view, source, tags, created_at::text
    FROM captures
    WHERE deleted_at IS NULL
      AND pipeline_status = 'complete'
      AND created_at >= ${todayMidnight.toISOString()}::timestamptz
    ORDER BY created_at DESC
  `)
  return result.rows
}

/** Query unresolved questions — questions with no follow-up via entity overlap in 7 days. */
export async function queryUnresolvedQuestions(db: Database): Promise<QuestionRow[]> {
  const result = await db.execute<QuestionRow>(sql`
    SELECT c.id::text, c.content, c.brain_view, c.created_at::text, c.tags
    FROM captures c
    WHERE c.capture_type = 'question'
      AND c.pipeline_status = 'complete'
      AND c.deleted_at IS NULL
      AND c.created_at >= (NOW() - INTERVAL '30 days')
      AND NOT EXISTS (
        SELECT 1 FROM entity_links el1
        JOIN entity_links el2 ON el1.entity_id = el2.entity_id
        JOIN captures c2 ON el2.capture_id = c2.id
        WHERE el1.capture_id = c.id
          AND c2.id != c.id
          AND c2.created_at > c.created_at
          AND c2.created_at <= c.created_at + INTERVAL '7 days'
          AND c2.deleted_at IS NULL
          AND c2.pipeline_status = 'complete'
      )
    ORDER BY c.created_at DESC
    LIMIT 10
  `)
  return result.rows
}

/** Query new entities first seen today. */
export async function queryNewEntities(db: Database): Promise<EntityRow[]> {
  const todayMidnight = new Date()
  todayMidnight.setHours(0, 0, 0, 0)

  const result = await db.execute<EntityRow>(sql`
    SELECT name, entity_type
    FROM entities
    WHERE first_seen_at >= ${todayMidnight.toISOString()}::timestamptz
    ORDER BY first_seen_at DESC
    LIMIT 20
  `)
  return result.rows
}

// ============================================================
// Context assembly
// ============================================================

function formatCapture(c: CaptureRow): string {
  const tags = c.tags?.length ? ` [${c.tags.join(', ')}]` : ''
  const date = typeof c.created_at === 'string' ? c.created_at.split('T')[0] : ''
  return `[${date}] [${c.capture_type}] [${c.brain_view}]${tags} ${c.content}\n`
}

function formatQuestion(q: QuestionRow): string {
  const date = typeof q.created_at === 'string' ? q.created_at.split('T')[0] : ''
  return `[${date}] [${q.brain_view}] ${q.content}\n`
}

function formatEntity(e: EntityRow): string {
  return `${e.name} (${e.entity_type})\n`
}

export function assembleContext(
  captures: CaptureRow[],
  questions: QuestionRow[],
  entities: EntityRow[],
  maxChars: number,
): { capturesText: string; questionsText: string; entitiesText: string } {
  // Allocate budget: 70% captures, 20% questions, 10% entities
  const captureBudget = Math.floor(maxChars * 0.7)
  const questionBudget = Math.floor(maxChars * 0.2)
  const entityBudget = Math.floor(maxChars * 0.1)

  let capturesText = ''
  let usedChars = 0
  for (const c of captures) {
    const line = formatCapture(c)
    if (usedChars + line.length > captureBudget) break
    capturesText += line
    usedChars += line.length
  }
  if (captures.length === 0) capturesText = '(no captures today)\n'

  let questionsText = ''
  usedChars = 0
  for (const q of questions) {
    const line = formatQuestion(q)
    if (usedChars + line.length > questionBudget) break
    questionsText += line
    usedChars += line.length
  }
  if (questions.length === 0) questionsText = '(no unresolved questions)\n'

  let entitiesText = ''
  usedChars = 0
  for (const e of entities) {
    const line = formatEntity(e)
    if (usedChars + line.length > entityBudget) break
    entitiesText += line
    usedChars += line.length
  }
  if (entities.length === 0) entitiesText = '(no new entities today)\n'

  return { capturesText, questionsText, entitiesText }
}

// ============================================================
// Date formatting
// ============================================================

export function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

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
export class DailySweepSkill {
  private db: Database
  private litellmClient: OpenAI | null
  private pushover: PushoverService
  private templates: TemplateCache
  private coreApiUrl: string

  constructor(opts: {
    db: Database
    litellmBaseUrl?: string
    litellmApiKey?: string
    pushover?: PushoverService
    promptsDir?: string
    coreApiUrl?: string
    templates?: TemplateCache
  }) {
    this.db = opts.db
    this.litellmClient = createLiteLLMClient({
      baseUrl: opts.litellmBaseUrl,
      apiKey: opts.litellmApiKey,
      timeout: 'extended',
      maxRetries: 0,
    })
    this.pushover = opts.pushover ?? new PushoverService({ onError: 'throw' })
    this.templates = opts.templates ?? new TemplateCache(opts.promptsDir ?? join(process.cwd(), 'config', 'prompts'))
    this.coreApiUrl = opts.coreApiUrl ?? process.env.OPEN_BRAIN_API_URL ?? 'http://localhost:3000'
  }

  async execute(options: DailySweepOptions = {}): Promise<DailySweepResult> {
    const {
      tokenBudget: rawBudget = DEFAULT_TOKEN_BUDGET,
      modelAlias = 'synthesis',
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

    if (captureCount === 0) {
      logger.info('[daily-sweep-skill] no captures today — producing quiet-day summary')
      const quietOutput = emptyOutput()
      const notificationSent = await this.deliverPushover(quietOutput)
      await this.logToSkillsLog({
        inputSummary: '0 captures today',
        outputSummary: 'Quiet day — no captures',
        durationMs: Date.now() - startMs,
      })
      return {
        output: quietOutput,
        captureCount: 0,
        durationMs: Date.now() - startMs,
        savedCaptureId: null,
        notificationSent,
      }
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
    const rawOutput = await this.callLLM(capturesText, questionsText, entitiesText, captureCount, fmtDate(today), modelAlias)
    const output = parseOutput(rawOutput)
    const durationMs = Date.now() - startMs

    // Step 5: Deliver Pushover notification
    const notificationSent = await this.deliverPushover(output)

    // Step 6: Optionally save as capture back into the brain
    const savedCaptureId = storeCapture
      ? await this.saveSweepCapture(output, fmtDate(today))
      : null

    // Step 7: Log to skills_log
    await this.logToSkillsLog({
      inputSummary: `${captureCount} captures, ${questions.length} unresolved questions, ${newEntities.length} new entities`,
      outputSummary: `headline: "${output.headline}" | decisions:${output.key_decisions.length} questions:${output.unresolved_questions.length} entities:${output.new_entities.length} tasks:${output.tasks_without_followup.length} | notified:${notificationSent}`,
      durationMs,
      captureId: savedCaptureId ?? undefined,
      result: output,
    })

    logger.info(
      { captureCount, durationMs, notificationSent, savedCaptureId, headline: output.headline },
      '[daily-sweep-skill] execution complete',
    )

    return { output, captureCount, durationMs, savedCaptureId, notificationSent }
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
    if (!this.litellmClient) throw new Error('[daily-sweep-skill] LiteLLM client not configured — LITELLM_API_KEY missing')
    const prompt = this.templates.render('daily_sweep_v1.txt', {
      date,
      capture_count: String(captureCount),
      captures: capturesText,
      unresolved_questions: questionsText,
      new_entities: entitiesText,
    })
    logger.debug({ modelAlias, promptLength: prompt.length }, '[daily-sweep-skill] calling LLM')

    const response = await this.litellmClient.chat.completions.create({
      model: modelAlias,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_completion_tokens: 2048,
    })

    const text = response.choices[0]?.message?.content ?? ''
    logger.info(
      { promptTokens: response.usage?.prompt_tokens, completionTokens: response.usage?.completion_tokens },
      '[daily-sweep-skill] LLM call complete',
    )
    return text
  }

  // ----------------------------------------------------------
  // Private: Pushover delivery
  // ----------------------------------------------------------

  private async deliverPushover(output: DailySweepOutput): Promise<boolean> {
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

  // ----------------------------------------------------------
  // Private: skills_log
  // ----------------------------------------------------------

  private async logToSkillsLog(params: {
    inputSummary: string
    outputSummary: string
    durationMs: number
    captureId?: string
    result?: DailySweepOutput
  }): Promise<void> {
    try {
      await this.db.insert(skills_log).values({
        skill_name: 'daily-sweep-skill',
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
export async function executeDailySweep(
  db: Database,
  options: DailySweepOptions = {},
): Promise<DailySweepResult> {
  return new DailySweepSkill({ db }).execute(options)
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
