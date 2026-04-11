import { eq, desc, isNull, sql } from 'drizzle-orm'
import { voice_sessions, NotFoundError, logger } from '@open-brain/shared'
import type { Database } from '@open-brain/shared'
import type { ActivityFeedService } from './activity-feed.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TranscriptTurn {
  role: 'user' | 'assistant'
  content: string
  timestamp?: string
}

export interface VoiceSessionRecord {
  id: string
  session_key: string
  started_at: Date
  ended_at: Date | null
  duration_seconds: number | null
  turn_count: number | null
  transcript: TranscriptTurn[]
  summary: string | null
  captures_created: string[]
  metadata: Record<string, unknown> | null
  created_at: Date
}

export interface CreateVoiceSessionInput {
  sessionKey: string
  metadata?: Record<string, unknown>
}

export interface UpdateVoiceSessionInput {
  transcript?: TranscriptTurn[]
  turn_count?: number
  summary?: string
  captures_created?: string[]
  metadata?: Record<string, unknown>
  ended_at?: Date
  duration_seconds?: number
}

export interface VoiceSessionListResult {
  items: VoiceSessionRecord[]
  total: number
}

// ---------------------------------------------------------------------------
// VoiceSessionService
// ---------------------------------------------------------------------------

/**
 * Manages Pipecat voice conversation session lifecycle.
 *
 * Sessions are created when a Pipecat voice conversation starts,
 * updated during the conversation as turns accumulate, and completed
 * when the conversation ends with a full transcript and summary.
 */
export class VoiceSessionService {
  private activityFeedService?: ActivityFeedService

  constructor(private db: Database) {}

  /** Set the activity feed service (avoids circular dep in constructor) */
  setActivityFeedService(service: ActivityFeedService): void {
    this.activityFeedService = service
  }

  /**
   * Create a new voice session.
   */
  async create(input: CreateVoiceSessionInput): Promise<VoiceSessionRecord> {
    const [row] = await this.db
      .insert(voice_sessions)
      .values({
        session_key: input.sessionKey,
        metadata: input.metadata ?? {},
      })
      .returning()

    const record = row as VoiceSessionRecord

    logger.info(
      { sessionId: record.id, sessionKey: input.sessionKey },
      '[voice-session] created session',
    )

    // Fire-and-forget activity feed insert
    this.insertActivityEvent('started', record).catch(() => {})

    return record
  }

  /**
   * Update an existing voice session (partial update).
   */
  async update(id: string, data: UpdateVoiceSessionInput): Promise<VoiceSessionRecord> {
    // Verify session exists
    await this.get(id)

    const updateValues: Record<string, unknown> = {}
    if (data.transcript !== undefined) updateValues.transcript = data.transcript
    if (data.turn_count !== undefined) updateValues.turn_count = data.turn_count
    if (data.summary !== undefined) updateValues.summary = data.summary
    if (data.captures_created !== undefined) updateValues.captures_created = data.captures_created
    if (data.metadata !== undefined) updateValues.metadata = data.metadata
    if (data.ended_at !== undefined) updateValues.ended_at = data.ended_at
    if (data.duration_seconds !== undefined) updateValues.duration_seconds = data.duration_seconds

    if (Object.keys(updateValues).length === 0) {
      return this.get(id)
    }

    const [row] = await this.db
      .update(voice_sessions)
      .set(updateValues)
      .where(eq(voice_sessions.id, id))
      .returning()

    logger.info({ sessionId: id }, '[voice-session] updated session')

    return row as VoiceSessionRecord
  }

  /**
   * Complete a voice session — mark ended, store final transcript and summary.
   */
  async complete(
    id: string,
    transcript: TranscriptTurn[],
    summary: string,
    captureIds: string[],
  ): Promise<VoiceSessionRecord> {
    // Verify session exists
    await this.get(id)

    const now = new Date()
    const session = await this.get(id)
    const durationSeconds = Math.round(
      (now.getTime() - new Date(session.started_at).getTime()) / 1000,
    )

    const [row] = await this.db
      .update(voice_sessions)
      .set({
        ended_at: now,
        duration_seconds: durationSeconds,
        turn_count: transcript.length,
        transcript,
        summary,
        captures_created: captureIds,
      })
      .where(eq(voice_sessions.id, id))
      .returning()

    const record = row as VoiceSessionRecord

    logger.info(
      { sessionId: id, turns: transcript.length, captures: captureIds.length },
      '[voice-session] completed session',
    )

    // Fire-and-forget activity feed insert
    this.insertActivityEvent('completed', record).catch(() => {})

    return record
  }

  /**
   * List voice sessions ordered by started_at DESC.
   */
  async list(limit = 50, offset = 0): Promise<VoiceSessionListResult> {
    const [items, countResult] = await Promise.all([
      this.db
        .select()
        .from(voice_sessions)
        .orderBy(desc(voice_sessions.started_at))
        .limit(limit)
        .offset(offset),
      this.db
        .select({ count: sql<string>`count(*)` })
        .from(voice_sessions),
    ])

    return {
      items: items as VoiceSessionRecord[],
      total: Number(countResult[0]?.count ?? 0),
    }
  }

  /**
   * Get a single voice session by ID.
   */
  async get(id: string): Promise<VoiceSessionRecord> {
    const rows = await this.db
      .select()
      .from(voice_sessions)
      .where(eq(voice_sessions.id, id))
      .limit(1)

    if (rows.length === 0) {
      throw new NotFoundError(`Voice session not found: ${id}`)
    }

    return rows[0] as VoiceSessionRecord
  }

  /**
   * Get active (not yet ended) voice sessions.
   */
  async getActive(): Promise<VoiceSessionRecord[]> {
    const rows = await this.db
      .select()
      .from(voice_sessions)
      .where(isNull(voice_sessions.ended_at))
      .orderBy(desc(voice_sessions.started_at))

    return rows as VoiceSessionRecord[]
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async insertActivityEvent(
    action: 'started' | 'completed',
    session: VoiceSessionRecord,
  ): Promise<void> {
    if (!this.activityFeedService) return

    const summary =
      action === 'started'
        ? `Voice conversation started (key: ${session.session_key})`
        : `Voice conversation completed: ${session.turn_count ?? 0} turns, ${session.duration_seconds ?? 0}s${session.summary ? ` — ${session.summary.slice(0, 80)}` : ''}`

    try {
      await this.activityFeedService.insert({
        type: 'voice',
        subtype: action,
        summary,
        detail: {
          session_key: session.session_key,
          turn_count: session.turn_count,
          duration_seconds: session.duration_seconds,
          captures_created: session.captures_created,
        },
        source_id: session.id,
      })
    } catch (err) {
      logger.warn(
        { err, sessionId: session.id },
        'Failed to insert voice session activity entry',
      )
    }
  }
}
