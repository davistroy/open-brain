import { eq, desc, sql } from 'drizzle-orm'
import { triggers, captures } from '@open-brain/shared'
import { NotFoundError, ValidationError } from '@open-brain/shared'
import type { Database } from '@open-brain/shared'
import type { EmbeddingService } from '@open-brain/shared'

const MAX_ACTIVE_TRIGGERS = 20
const DEFAULT_THRESHOLD = 0.72
const DEFAULT_COOLDOWN_MINUTES = 60

export interface TriggerRecord {
  id: string
  name: string
  description: string | null
  condition_text: string
  threshold: number
  action: string
  action_config: Record<string, unknown> | null
  enabled: boolean
  last_triggered_at: Date | null
  trigger_count: number
  created_at: Date
  updated_at: Date
}

export interface TriggerTestMatch {
  capture_id: string
  content: string
  similarity: number
  capture_type: string
  brain_view: string
  created_at: Date
}

export interface CreateTriggerInput {
  name: string
  queryText: string
  description?: string
  threshold?: number
  cooldownMinutes?: number
  deliveryChannel?: 'pushover' | 'slack' | 'both'
}

/**
 * TriggerService manages semantic push triggers.
 *
 * Triggers store a pre-computed embedding of the query text and fire
 * Pushover/Slack notifications when a new capture's embedding exceeds
 * the cosine similarity threshold (default 0.72) and cooldown has elapsed.
 *
 * Limit: 20 active triggers maximum (enforced on create).
 * Soft deactivate on delete (is_active = false / enabled = false).
 * Test endpoint computes similarity against recent captures without firing.
 */
export class TriggerService {
  constructor(
    private db: Database,
    private embeddingService: EmbeddingService,
  ) {}

  /**
   * Create a new trigger with a pre-computed embedding.
   * Enforces max 20 active triggers.
   * Default threshold: 0.72, cooldown: 60 minutes.
   */
  async create(input: CreateTriggerInput): Promise<TriggerRecord> {
    const {
      name,
      queryText,
      description,
      threshold = DEFAULT_THRESHOLD,
      cooldownMinutes = DEFAULT_COOLDOWN_MINUTES,
      deliveryChannel = 'pushover',
    } = input

    // Validate threshold range
    if (threshold < 0 || threshold > 1) {
      throw new ValidationError('Threshold must be between 0.0 and 1.0')
    }

    // Enforce max active triggers
    const countResult = await this.db
      .select({ count: sql<string>`count(*)` })
      .from(triggers)
      .where(eq(triggers.enabled, true))

    const activeCount = Number(countResult[0]?.count ?? 0)
    if (activeCount >= MAX_ACTIVE_TRIGGERS) {
      throw new ValidationError(
        `Maximum of ${MAX_ACTIVE_TRIGGERS} active triggers already reached. Deactivate one before creating another.`,
      )
    }

    // Generate embedding for the query text
    const embedding = await this.embeddingService.embed(queryText)

    const [created] = await this.db
      .insert(triggers)
      .values({
        name,
        description: description ?? null,
        condition_text: queryText,
        embedding,
        threshold,
        action: 'notify',
        action_config: {
          delivery_channel: deliveryChannel,
          cooldown_minutes: cooldownMinutes,
        },
        enabled: true,
      })
      .returning()

    return created as unknown as TriggerRecord
  }

  /**
   * List all triggers with status metadata.
   */
  async list(): Promise<TriggerRecord[]> {
    const rows = await this.db
      .select({
        id: triggers.id,
        name: triggers.name,
        description: triggers.description,
        condition_text: triggers.condition_text,
        threshold: triggers.threshold,
        action: triggers.action,
        action_config: triggers.action_config,
        enabled: triggers.enabled,
        last_triggered_at: triggers.last_triggered_at,
        trigger_count: triggers.trigger_count,
        created_at: triggers.created_at,
        updated_at: triggers.updated_at,
      })
      .from(triggers)
      .orderBy(desc(triggers.created_at))

    return rows as unknown as TriggerRecord[]
  }

  /**
   * Soft-deactivate a trigger by name or ID (sets enabled = false).
   */
  async delete(nameOrId: string): Promise<void> {
    // Try by ID first, then by name
    const [byId] = await this.db
      .select({ id: triggers.id })
      .from(triggers)
      .where(eq(triggers.id, nameOrId))
      .limit(1)

    const [byName] = byId
      ? [byId]
      : await this.db
          .select({ id: triggers.id })
          .from(triggers)
          .where(eq(triggers.name, nameOrId))
          .limit(1)

    if (!byName) {
      throw new NotFoundError(`Trigger not found: ${nameOrId}`)
    }

    await this.db
      .update(triggers)
      .set({ enabled: false, updated_at: new Date() })
      .where(eq(triggers.id, byName.id))
  }

  /**
   * Test a query text against recent captures — returns top matches without firing.
   * Computes cosine similarity between the query embedding and capture embeddings in-memory.
   */
  async test(queryText: string, limit = 5): Promise<TriggerTestMatch[]> {
    // Generate embedding for the test query
    const queryEmbedding = await this.embeddingService.embed(queryText)

    // Use pgvector cosine similarity to find top matches across all captures with embeddings
    const rows = await this.db.execute<{
      id: string
      content: string
      capture_type: string
      brain_view: string
      created_at: Date
      similarity: number
    }>(sql`
      SELECT
        id::text,
        content,
        capture_type,
        brain_view,
        created_at,
        1 - (embedding <=> ${`[${queryEmbedding.join(',')}]`}::vector(768)) AS similarity
      FROM captures
      WHERE embedding IS NOT NULL
        AND pipeline_status NOT IN ('deleted', 'failed')
      ORDER BY embedding <=> ${`[${queryEmbedding.join(',')}]`}::vector(768) ASC
      LIMIT ${limit}
    `)

    return rows.rows.map((row) => ({
      capture_id: row.id,
      content: row.content,
      similarity: Number(row.similarity),
      capture_type: row.capture_type,
      brain_view: row.brain_view,
      created_at: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
    }))
  }

  /**
   * Load all active (enabled) triggers with their embeddings for the check-triggers job.
   * Returns full trigger rows including embedding vectors.
   */
  async loadActiveTriggers(): Promise<Array<TriggerRecord & { embedding: number[] | null }>> {
    const rows = await this.db
      .select()
      .from(triggers)
      .where(eq(triggers.enabled, true))

    return rows as unknown as Array<TriggerRecord & { embedding: number[] | null }>
  }

  /**
   * Record a trigger fire: update last_triggered_at and increment trigger_count.
   */
  async recordFire(triggerId: string): Promise<void> {
    await this.db
      .update(triggers)
      .set({
        last_triggered_at: new Date(),
        trigger_count: sql`${triggers.trigger_count} + 1`,
        updated_at: new Date(),
      })
      .where(eq(triggers.id, triggerId))
  }
}
