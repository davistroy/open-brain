import { eq, desc, and, sql } from 'drizzle-orm'
import { sessions, session_messages } from '@open-brain/shared'
import { NotFoundError, ValidationError } from '@open-brain/shared'
import type { Database } from '@open-brain/shared'
import type { CaptureService } from './capture.js'
import { logger } from '../lib/logger.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SessionType = 'governance' | 'review' | 'planning'
export type SessionStatus = 'active' | 'paused' | 'complete' | 'abandoned'

export interface CreateSessionInput {
  type: SessionType
  config?: {
    max_turns?: number
    timeout_ms?: number
    focus_brain_views?: string[]
  }
}

export interface SessionRecord {
  id: string
  session_type: string
  status: string
  config: Record<string, unknown> | null
  context_capture_ids: string[]
  summary: string | null
  created_at: Date
  updated_at: Date
  completed_at: Date | null
}

export interface SessionMessageRecord {
  id: string
  session_id: string
  role: 'user' | 'assistant'
  content: string
  metadata: Record<string, unknown> | null
  created_at: Date
}

export interface SessionWithTranscript extends SessionRecord {
  transcript: SessionMessageRecord[]
}

export interface CreateSessionResult {
  session: SessionRecord
  first_message: string
}

export interface RespondResult {
  session: SessionRecord
  bot_message: string
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_TURNS = 20
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000   // 30 minutes
const PAUSE_EXPIRY_DAYS = 30
const IDLE_TIMEOUT_MS = 30 * 60 * 1000       // 30 minutes → auto-pause

/**
 * Opening messages per session type.
 */
const SESSION_OPENING_MESSAGES: Record<SessionType, string> = {
  governance: `Good. Let's begin the quick board check.

I'm going to walk you through five areas: (1) current priorities and blockers, (2) key decisions made this week, (3) active bets and predictions — any approaching resolution dates, (4) work-personal energy balance, and (5) a 90-day outlook.

For each area, I'll need concrete specifics — not general statements. What are you actually working on right now, and what's the single biggest blocker you're facing?`,

  review: `Let's do a structured review. I'll guide you through: (1) goals set vs. accomplished, (2) patterns you're noticing, (3) what to carry forward, and (4) what to drop or delegate.

Start by telling me — what did you intend to accomplish this period?`,

  planning: `Let's plan. We'll cover: (1) goals for the period, (2) key decisions that need to be made, (3) resources or blockers to resolve, and (4) success criteria.

What's the primary goal you're planning toward?`,
}

// ---------------------------------------------------------------------------
// SessionService
// ---------------------------------------------------------------------------

/**
 * SessionService manages governance and review session lifecycle.
 *
 * Sessions use the `sessions` and `session_messages` tables from the schema.
 * The governance engine (implemented in 13.2) is injected optionally — the
 * SessionService handles persistence and lifecycle; the engine handles LLM calls.
 *
 * Lifecycle:
 *   create() → active session + first bot message
 *   respond() → append user message, generate bot response, check idle timeout
 *   pause()   → status = 'paused', paused_at stored in config
 *   resume()  → check 30-day expiry, restore conversation context
 *   complete() → status = 'complete', generate summary, capture into brain
 *   abandon() → status = 'abandoned'
 */
export class SessionService {
  constructor(
    private db: Database,
    private captureService?: CaptureService,
    private governanceEngine?: {
      processResponse(
        session: SessionRecord,
        transcript: SessionMessageRecord[],
        userMessage: string,
      ): Promise<{ bot_message: string; context_capture_ids?: string[] }>
    },
  ) {}

  // -------------------------------------------------------------------------
  // create
  // -------------------------------------------------------------------------

  async create(input: CreateSessionInput): Promise<CreateSessionResult> {
    const config = {
      max_turns: input.config?.max_turns ?? DEFAULT_MAX_TURNS,
      timeout_ms: input.config?.timeout_ms ?? DEFAULT_TIMEOUT_MS,
      focus_brain_views: input.config?.focus_brain_views ?? [],
      turn_count: 0,
      last_activity_at: new Date().toISOString(),
    }

    const [session] = await this.db
      .insert(sessions)
      .values({
        session_type: input.type,
        status: 'active',
        config,
        context_capture_ids: [],
      })
      .returning()

    const firstMessage = SESSION_OPENING_MESSAGES[input.type]

    // Store the opening bot message in the transcript
    await this.db.insert(session_messages).values({
      session_id: session.id,
      role: 'assistant',
      content: firstMessage,
      metadata: { turn_index: 0 },
    })

    logger.info({ sessionId: session.id, type: input.type }, '[session] created session')

    return {
      session: session as SessionRecord,
      first_message: firstMessage,
    }
  }

  // -------------------------------------------------------------------------
  // respond
  // -------------------------------------------------------------------------

  async respond(sessionId: string, userMessage: string): Promise<RespondResult> {
    const session = await this.getById(sessionId)

    if (session.status !== 'active') {
      throw new ValidationError(
        `Session ${sessionId} is ${session.status} — cannot respond to a non-active session`,
      )
    }

    const config = (session.config ?? {}) as Record<string, unknown>
    const maxTurns = (config.max_turns as number) ?? DEFAULT_MAX_TURNS
    const turnCount = (config.turn_count as number) ?? 0

    if (turnCount >= maxTurns) {
      throw new ValidationError(
        `Session ${sessionId} has reached the maximum of ${maxTurns} turns`,
      )
    }

    // Check idle timeout — if last_activity_at is older than timeout, auto-pause
    const lastActivity = config.last_activity_at
      ? new Date(config.last_activity_at as string)
      : new Date(session.updated_at)
    const idleMs = Date.now() - lastActivity.getTime()

    if (idleMs > IDLE_TIMEOUT_MS) {
      await this.pause(sessionId)
      throw new ValidationError(
        `Session ${sessionId} was auto-paused due to ${Math.floor(idleMs / 60000)} minutes of inactivity. Resume with /board resume.`,
      )
    }

    // Load full transcript for context
    const transcript = await this.getTranscript(sessionId)

    // Insert user message
    await this.db.insert(session_messages).values({
      session_id: sessionId,
      role: 'user',
      content: userMessage,
      metadata: { turn_index: turnCount + 1 },
    })

    // Generate bot response via governance engine (if wired) or fallback
    let botMessage: string
    let additionalCaptureIds: string[] = []

    if (this.governanceEngine) {
      const result = await this.governanceEngine.processResponse(
        session,
        transcript,
        userMessage,
      )
      botMessage = result.bot_message
      additionalCaptureIds = result.context_capture_ids ?? []
    } else {
      botMessage = `[Governance engine not configured — message received: "${userMessage.slice(0, 80)}..."]`
    }

    const newTurnCount = turnCount + 1

    // Merge any new context captures
    const existingIds = session.context_capture_ids ?? []
    const mergedIds = Array.from(new Set([...existingIds, ...additionalCaptureIds]))

    // Update session state
    const [updatedSession] = await this.db
      .update(sessions)
      .set({
        config: {
          ...config,
          turn_count: newTurnCount,
          last_activity_at: new Date().toISOString(),
        },
        context_capture_ids: mergedIds,
        updated_at: new Date(),
      })
      .where(eq(sessions.id, sessionId))
      .returning()

    // Insert bot response
    await this.db.insert(session_messages).values({
      session_id: sessionId,
      role: 'assistant',
      content: botMessage,
      metadata: { turn_index: newTurnCount },
    })

    logger.info(
      { sessionId, turnCount: newTurnCount },
      '[session] processed respond turn',
    )

    return {
      session: updatedSession as SessionRecord,
      bot_message: botMessage,
    }
  }

  // -------------------------------------------------------------------------
  // pause
  // -------------------------------------------------------------------------

  async pause(sessionId: string): Promise<SessionRecord> {
    const session = await this.getById(sessionId)

    if (session.status === 'paused') {
      return session
    }

    if (session.status !== 'active') {
      throw new ValidationError(
        `Session ${sessionId} is ${session.status} — only active sessions can be paused`,
      )
    }

    const config = (session.config ?? {}) as Record<string, unknown>

    const [updated] = await this.db
      .update(sessions)
      .set({
        status: 'paused',
        config: {
          ...config,
          paused_at: new Date().toISOString(),
        },
        updated_at: new Date(),
      })
      .where(eq(sessions.id, sessionId))
      .returning()

    logger.info({ sessionId }, '[session] paused session')

    return updated as SessionRecord
  }

  // -------------------------------------------------------------------------
  // resume
  // -------------------------------------------------------------------------

  async resume(sessionId: string): Promise<{ session: SessionRecord; context_message: string }> {
    const session = await this.getById(sessionId)

    if (session.status !== 'paused') {
      throw new ValidationError(
        `Session ${sessionId} is ${session.status} — only paused sessions can be resumed`,
      )
    }

    const config = (session.config ?? {}) as Record<string, unknown>
    const pausedAt = config.paused_at ? new Date(config.paused_at as string) : new Date(session.updated_at)
    const pausedDays = (Date.now() - pausedAt.getTime()) / (1000 * 60 * 60 * 24)

    // Auto-expire if paused > 30 days
    if (pausedDays > PAUSE_EXPIRY_DAYS) {
      const [expired] = await this.db
        .update(sessions)
        .set({
          status: 'abandoned',
          updated_at: new Date(),
        })
        .where(eq(sessions.id, sessionId))
        .returning()

      logger.info({ sessionId, pausedDays }, '[session] auto-expired session (>30 days paused)')

      throw new ValidationError(
        `Session ${sessionId} has been paused for ${Math.floor(pausedDays)} days and has expired. Please start a new session.`,
      )
    }

    // Restore to active
    const pausedDaysLabel = pausedDays < 1
      ? `${Math.floor(pausedDays * 24)} hours`
      : `${Math.floor(pausedDays)} day${Math.floor(pausedDays) !== 1 ? 's' : ''}`

    const [updated] = await this.db
      .update(sessions)
      .set({
        status: 'active',
        config: {
          ...config,
          paused_at: null,
          last_activity_at: new Date().toISOString(),
        },
        updated_at: new Date(),
      })
      .where(eq(sessions.id, sessionId))
      .returning()

    // Load last few transcript entries to restore context
    const transcript = await this.getTranscript(sessionId)
    const recent = transcript.slice(-3)
    const contextSummary = recent.length > 0
      ? `Here's where we left off:\n\n${recent.map(t => `**${t.role === 'user' ? 'You' : 'Board'}**: ${t.content.slice(0, 200)}...`).join('\n\n')}`
      : 'We are starting fresh with no prior context.'

    const contextMessage = `Welcome back. This session was paused ${pausedDaysLabel} ago.\n\n${contextSummary}\n\nReady to continue — where were we?`

    logger.info({ sessionId, pausedDays }, '[session] resumed session')

    return {
      session: updated as SessionRecord,
      context_message: contextMessage,
    }
  }

  // -------------------------------------------------------------------------
  // complete
  // -------------------------------------------------------------------------

  async complete(sessionId: string): Promise<{ session: SessionRecord; summary: string }> {
    const session = await this.getById(sessionId)

    if (session.status === 'complete') {
      return { session, summary: session.summary ?? '' }
    }

    if (session.status !== 'active' && session.status !== 'paused') {
      throw new ValidationError(
        `Session ${sessionId} is ${session.status} — cannot complete an abandoned session`,
      )
    }

    const transcript = await this.getTranscript(sessionId)

    // Build a text summary of the session
    const summary = this.generateTextSummary(session, transcript)

    const [updated] = await this.db
      .update(sessions)
      .set({
        status: 'complete',
        summary,
        completed_at: new Date(),
        updated_at: new Date(),
      })
      .where(eq(sessions.id, sessionId))
      .returning()

    // Capture session summary back into the brain (if CaptureService is wired)
    if (this.captureService && transcript.length > 2) {
      try {
        const config = (session.config ?? {}) as Record<string, unknown>
        const views = (config.focus_brain_views as string[] | undefined) ?? []
        const brainView = views.length > 0 ? views[0]! : 'personal'

        await this.captureService.create({
          content: `Governance session completed (${session.session_type}).\n\n${summary}`,
          capture_type: 'reflection',
          brain_view: brainView,
          source: 'api',
          metadata: {
            source_metadata: {
              session_id: sessionId,
              session_type: session.session_type,
              turn_count: transcript.length,
            },
            tags: ['governance', 'session-summary'],
          },
        })

        logger.info({ sessionId }, '[session] captured session summary into brain')
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.warn({ sessionId, err: msg }, '[session] failed to capture session summary — non-fatal')
      }
    }

    logger.info({ sessionId }, '[session] completed session')

    return {
      session: updated as SessionRecord,
      summary,
    }
  }

  // -------------------------------------------------------------------------
  // abandon
  // -------------------------------------------------------------------------

  async abandon(sessionId: string): Promise<SessionRecord> {
    const session = await this.getById(sessionId)

    if (session.status === 'abandoned') {
      return session
    }

    if (session.status === 'complete') {
      throw new ValidationError(`Session ${sessionId} is already complete — cannot abandon`)
    }

    const [updated] = await this.db
      .update(sessions)
      .set({
        status: 'abandoned',
        updated_at: new Date(),
      })
      .where(eq(sessions.id, sessionId))
      .returning()

    logger.info({ sessionId }, '[session] abandoned session')

    return updated as SessionRecord
  }

  // -------------------------------------------------------------------------
  // getById
  // -------------------------------------------------------------------------

  async getById(sessionId: string): Promise<SessionRecord> {
    const rows = await this.db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1)

    if (rows.length === 0) {
      throw new NotFoundError(`Session not found: ${sessionId}`)
    }

    return rows[0] as SessionRecord
  }

  // -------------------------------------------------------------------------
  // getWithTranscript
  // -------------------------------------------------------------------------

  async getWithTranscript(sessionId: string): Promise<SessionWithTranscript> {
    const session = await this.getById(sessionId)
    const transcript = await this.getTranscript(sessionId)
    return { ...session, transcript }
  }

  // -------------------------------------------------------------------------
  // list
  // -------------------------------------------------------------------------

  async list(
    statusFilter?: SessionStatus,
    limit = 20,
    offset = 0,
  ): Promise<{ items: SessionRecord[]; total: number }> {
    const where = statusFilter ? eq(sessions.status, statusFilter) : undefined

    const [items, countResult] = await Promise.all([
      this.db
        .select()
        .from(sessions)
        .where(where)
        .orderBy(desc(sessions.created_at))
        .limit(limit)
        .offset(offset),
      this.db
        .select({ count: sql<string>`count(*)` })
        .from(sessions)
        .where(where),
    ])

    return {
      items: items as SessionRecord[],
      total: Number(countResult[0]?.count ?? 0),
    }
  }

  // -------------------------------------------------------------------------
  // getTranscript (internal + exposed for governance engine)
  // -------------------------------------------------------------------------

  async getTranscript(sessionId: string): Promise<SessionMessageRecord[]> {
    const rows = await this.db
      .select()
      .from(session_messages)
      .where(eq(session_messages.session_id, sessionId))
      .orderBy(session_messages.created_at)

    return rows as SessionMessageRecord[]
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private generateTextSummary(session: SessionRecord, transcript: SessionMessageRecord[]): string {
    const lines: string[] = [
      `Session type: ${session.session_type}`,
      `Started: ${session.created_at.toISOString()}`,
      `Completed: ${new Date().toISOString()}`,
      `Turns: ${transcript.length}`,
      '',
      '--- Transcript Summary ---',
    ]

    // Include all user turns in the summary (assistant turns are skipped for brevity)
    const userTurns = transcript.filter(t => t.role === 'user')
    for (const turn of userTurns) {
      lines.push(`> ${turn.content.slice(0, 500)}`)
    }

    return lines.join('\n')
  }
}
