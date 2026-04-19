import { sql } from 'drizzle-orm'
import type { Database } from '@open-brain/shared'
import type { BaseResult } from './types.js'

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

export interface DailySweepResult extends BaseResult {
  output: DailySweepOutput
  captureCount: number
  savedCaptureId: string | null
  notificationSent: boolean
}

export interface DailySweepOptions {
  /** Max chars of context to include. Default: 30000 */
  tokenBudget?: number
  /** Whether to save the sweep output as a capture. Default: false */
  storeCapture?: boolean
}

// ============================================================
// Constants
// ============================================================

export const DEFAULT_TOKEN_BUDGET = 30_000
export const CHARS_PER_TOKEN = 4

// ============================================================
// Row types for raw SQL queries
// ============================================================

export interface CaptureRow {
  [key: string]: unknown
  id: string
  content: string
  capture_type: string
  brain_view: string
  source: string
  tags: string[] | null
  created_at: string
}

export interface QuestionRow {
  [key: string]: unknown
  id: string
  content: string
  brain_view: string
  created_at: string
  tags: string[] | null
}

export interface EntityRow {
  [key: string]: unknown
  name: string
  entity_type: string
}

export interface VoiceStats {
  count: number
  lastVoiceDate: Date | null
}

// ============================================================
// Query functions
// ============================================================

/** Query voice capture stats for the last 7 days. */
export async function queryVoiceStats(db: Database): Promise<VoiceStats> {
  const result = await db.execute<{ count: string; last_voice: string | null }>(sql`
    SELECT
      COUNT(*)::text AS count,
      MAX(created_at)::text AS last_voice
    FROM captures
    WHERE source = 'voice'
      AND deleted_at IS NULL
      AND created_at > NOW() - INTERVAL '7 days'
  `)
  const row = result.rows[0]
  return {
    count: parseInt(row?.count ?? '0', 10),
    lastVoiceDate: row?.last_voice ? new Date(row.last_voice) : null,
  }
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

/** Format voice stats line for Pushover notification. */
export function formatVoiceStatsLine(stats: VoiceStats): string {
  if (stats.count === 0) {
    return 'Voice memos this week: 0'
  }
  const now = new Date()
  const daysAgo = Math.floor((now.getTime() - (stats.lastVoiceDate?.getTime() ?? now.getTime())) / (1000 * 60 * 60 * 24))
  const lastStr = daysAgo === 0 ? 'last: today' : daysAgo === 1 ? 'last: 1 day ago' : `last: ${daysAgo} days ago`
  return `Voice memos this week: ${stats.count} (${lastStr})`
}
