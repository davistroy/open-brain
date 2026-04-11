/**
 * ActivityFeedService — unified activity feed for the dashboard.
 *
 * Provides:
 *   - insert(entry) — raw insert
 *   - insertCapture/insertSkill/insertPipeline/insertEntity — typed helpers
 *   - list(filters) — paginated, filterable feed query
 *   - notify() — fires pg_notify for SSE push
 */

import { desc, and, eq, gte, sql } from 'drizzle-orm'
import { activity_feed } from '@open-brain/shared'
import type { Database } from '@open-brain/shared'
import { logger } from '@open-brain/shared'
import { pgNotify } from '../lib/pg-notify.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ActivityFeedEntry {
  type: string
  subtype?: string
  timestamp?: Date
  summary: string
  view?: string
  detail?: Record<string, unknown>
  source_id?: string
}

export interface ActivityFeedRecord {
  id: string
  type: string
  subtype: string | null
  timestamp: Date
  summary: string
  view: string | null
  detail: unknown
  source_id: string | null
  created_at: Date
}

export interface ActivityFeedFilter {
  type?: string
  view?: string
  since?: Date
}

export interface ActivityFeedPage {
  items: ActivityFeedRecord[]
  total: number
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class ActivityFeedService {
  constructor(private db: Database) {}

  /**
   * Insert a raw activity feed entry and fire pg-notify for SSE.
   */
  async insert(entry: ActivityFeedEntry): Promise<ActivityFeedRecord> {
    const [row] = await this.db
      .insert(activity_feed)
      .values({
        type: entry.type,
        subtype: entry.subtype ?? null,
        timestamp: entry.timestamp ?? new Date(),
        summary: entry.summary,
        view: entry.view ?? null,
        detail: entry.detail ?? null,
        source_id: entry.source_id ?? null,
      })
      .returning()

    // Fire pg-notify for SSE (fire-and-forget — failure must not break the insert)
    this.notifyNewEntry(row as ActivityFeedRecord).catch((err) => {
      logger.debug({ err }, 'activity_feed pg-notify failed')
    })

    return row as ActivityFeedRecord
  }

  /**
   * Insert an activity entry for a new capture.
   */
  async insertCapture(capture: {
    id: string
    content: string
    capture_type: string
    brain_view: string
    source: string
  }): Promise<void> {
    const preview = capture.content.length > 120
      ? capture.content.slice(0, 120) + '...'
      : capture.content
    try {
      await this.insert({
        type: 'capture',
        subtype: 'created',
        summary: `New ${capture.capture_type} from ${capture.source}: ${preview}`,
        view: capture.brain_view,
        detail: {
          capture_type: capture.capture_type,
          source: capture.source,
        },
        source_id: capture.id,
      })
    } catch (err) {
      logger.warn({ err, captureId: capture.id }, 'Failed to insert capture activity entry')
    }
  }

  /**
   * Insert an activity entry for a skill completion.
   */
  async insertSkill(skill: {
    skill_name: string
    duration_ms?: number
    output_summary?: string
    skill_log_id?: string
  }): Promise<void> {
    const summary = skill.output_summary
      ? `Skill "${skill.skill_name}" completed: ${skill.output_summary.slice(0, 100)}`
      : `Skill "${skill.skill_name}" completed`
    try {
      await this.insert({
        type: 'skill',
        subtype: 'completed',
        summary,
        detail: {
          skill_name: skill.skill_name,
          duration_ms: skill.duration_ms,
        },
        source_id: skill.skill_log_id,
      })
    } catch (err) {
      logger.warn({ err, skill: skill.skill_name }, 'Failed to insert skill activity entry')
    }
  }

  /**
   * Insert an activity entry for a pipeline stage event.
   */
  async insertPipeline(pipeline: {
    capture_id: string
    stage: string
    status: string
    duration_ms?: number
    error?: string
  }): Promise<void> {
    const statusEmoji = pipeline.status === 'success' ? 'completed' : 'failed'
    const summary = pipeline.error
      ? `Pipeline ${pipeline.stage} ${statusEmoji}: ${pipeline.error.slice(0, 100)}`
      : `Pipeline ${pipeline.stage} ${statusEmoji} (${pipeline.duration_ms ?? '?'}ms)`
    try {
      await this.insert({
        type: 'pipeline',
        subtype: `${pipeline.stage}:${pipeline.status}`,
        summary,
        detail: {
          stage: pipeline.stage,
          status: pipeline.status,
          duration_ms: pipeline.duration_ms,
          error: pipeline.error,
        },
        source_id: pipeline.capture_id,
      })
    } catch (err) {
      logger.warn({ err, captureId: pipeline.capture_id }, 'Failed to insert pipeline activity entry')
    }
  }

  /**
   * Insert an activity entry for an entity change.
   */
  async insertEntity(entity: {
    entity_id: string
    name: string
    action: string  // created | merged | updated
  }): Promise<void> {
    try {
      await this.insert({
        type: 'entity',
        subtype: entity.action,
        summary: `Entity "${entity.name}" ${entity.action}`,
        detail: { name: entity.name, action: entity.action },
        source_id: entity.entity_id,
      })
    } catch (err) {
      logger.warn({ err, entityId: entity.entity_id }, 'Failed to insert entity activity entry')
    }
  }

  /**
   * Paginated, filterable list of activity feed entries.
   */
  async list(
    filter: ActivityFeedFilter = {},
    limit = 50,
    offset = 0,
  ): Promise<ActivityFeedPage> {
    const conditions: ReturnType<typeof eq>[] = []

    if (filter.type) conditions.push(eq(activity_feed.type, filter.type))
    if (filter.view) conditions.push(eq(activity_feed.view, filter.view))
    if (filter.since) conditions.push(gte(activity_feed.timestamp, filter.since))

    const where = conditions.length > 0 ? and(...conditions) : undefined

    const [items, countResult] = await Promise.all([
      this.db
        .select()
        .from(activity_feed)
        .where(where)
        .orderBy(desc(activity_feed.timestamp))
        .limit(limit)
        .offset(offset),
      this.db
        .select({ count: sql<string>`count(*)` })
        .from(activity_feed)
        .where(where),
    ])

    return {
      items: items as ActivityFeedRecord[],
      total: Number(countResult[0]?.count ?? 0),
    }
  }

  /**
   * Fire pg-notify so SSE clients see the new entry immediately.
   */
  private async notifyNewEntry(entry: ActivityFeedRecord): Promise<void> {
    await pgNotify.notify('activity_feed', {
      id: entry.id,
      type: entry.type,
      subtype: entry.subtype,
      timestamp: entry.timestamp.toISOString(),
      summary: entry.summary,
      view: entry.view,
      source_id: entry.source_id,
    })
  }
}
