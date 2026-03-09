import { eq, and, desc, sql, gte, lte, isNull } from 'drizzle-orm'
import { captures } from '@open-brain/shared'
import { contentHash, ConflictError, NotFoundError } from '@open-brain/shared'
import type { Database } from '@open-brain/shared'
import type { CreateCaptureInput, CaptureFilter, CaptureRecord } from '@open-brain/shared'
import type { PipelineService } from './pipeline.js'

const DEDUP_WINDOW_MS = 60_000 // 60 seconds

export interface CaptureStats {
  total_captures: number
  by_source: Record<string, number>
  by_type: Record<string, number>
  by_view: Record<string, number>
  pipeline_health: {
    pending: number
    processing: number
    complete: number
    failed: number
  }
  total_entities: number
}

export interface UpdateCaptureInput {
  tags?: string[]
  brain_view?: string
  metadata_overrides?: Record<string, unknown>
}

export class CaptureService {
  constructor(
    private db: Database,
    private pipelineService?: PipelineService,
  ) {}

  async create(input: CreateCaptureInput): Promise<CaptureRecord> {
    const hash = contentHash(input.content)

    // Dedup check: look for same hash within last 60 seconds
    const existing = await this.db
      .select({ id: captures.id, created_at: captures.created_at })
      .from(captures)
      .where(
        and(
          eq(captures.content_hash, hash),
          gte(captures.created_at, new Date(Date.now() - DEDUP_WINDOW_MS)),
        ),
      )
      .limit(1)

    if (existing.length > 0) {
      throw new ConflictError(`Duplicate capture detected within the last 60 seconds (id: ${existing[0].id})`)
    }

    const metadata = input.metadata ?? {}
    const capturedAt = metadata.captured_at ? new Date(metadata.captured_at) : new Date()

    let created: typeof captures.$inferSelect
    try {
      const [row] = await this.db
        .insert(captures)
        .values({
          content: input.content,
          content_hash: hash,
          capture_type: input.capture_type,
          brain_view: input.brain_view,
          source: input.source,
          source_metadata: metadata.source_metadata ?? null,
          tags: metadata.tags ?? [],
          pipeline_status: 'pending',
          pre_extracted: metadata.pre_extracted ?? null,
          captured_at: capturedAt,
        })
        .returning()
      created = row
    } catch (err: unknown) {
      // Handle DB-level unique constraint violation on content_hash
      // Drizzle wraps pg errors — check message and cause chain
      const errStr = err instanceof Error ? err.message : String(err)
      const causeStr = err instanceof Error && err.cause instanceof Error ? err.cause.message : ''
      if (errStr.includes('content_hash') || causeStr.includes('content_hash') ||
          errStr.includes('23505') || causeStr.includes('23505')) {
        throw new ConflictError('Duplicate capture: content already exists')
      }
      throw err
    }

    // Auto-enqueue pipeline job after successful insert
    if (this.pipelineService) {
      try {
        await this.pipelineService.enqueue(created.id)
      } catch (err) {
        // Pipeline enqueue failure must not fail the capture creation.
        // The daily sweep will re-enqueue captures stuck in 'pending' status.
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(`[CaptureService] Failed to enqueue pipeline for capture ${created.id}: ${msg}`)
      }
    }

    return created as CaptureRecord
  }

  async getById(id: string): Promise<CaptureRecord> {
    const rows = await this.db
      .select()
      .from(captures)
      .where(and(eq(captures.id, id), isNull(captures.deleted_at)))
      .limit(1)

    if (rows.length === 0) {
      throw new NotFoundError(`Capture not found: ${id}`)
    }

    return rows[0] as CaptureRecord
  }

  async list(filter: CaptureFilter = {}, limit = 20, offset = 0): Promise<{ items: CaptureRecord[]; total: number }> {
    const conditions = [isNull(captures.deleted_at)]

    if (filter.brain_view) conditions.push(eq(captures.brain_view, filter.brain_view))
    if (filter.capture_type) conditions.push(eq(captures.capture_type, filter.capture_type))
    if (filter.source) conditions.push(eq(captures.source, filter.source))
    if (filter.pipeline_status) conditions.push(eq(captures.pipeline_status, filter.pipeline_status))
    if (filter.date_from) conditions.push(gte(captures.created_at, filter.date_from))
    if (filter.date_to) conditions.push(lte(captures.created_at, filter.date_to))
    if (filter.tags && filter.tags.length > 0) {
      // Array overlap: captures where any tag matches
      conditions.push(sql`${captures.tags} && ${filter.tags}::text[]`)
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined

    const [items, countResult] = await Promise.all([
      this.db
        .select()
        .from(captures)
        .where(where)
        .orderBy(desc(captures.created_at))
        .limit(limit)
        .offset(offset),
      this.db
        .select({ count: sql<string>`count(*)` })
        .from(captures)
        .where(where),
    ])

    return {
      items: items as CaptureRecord[],
      total: Number(countResult[0]?.count ?? 0),
    }
  }

  async update(id: string, input: UpdateCaptureInput): Promise<CaptureRecord> {
    // Verify exists first
    await this.getById(id)

    const updateValues: Record<string, unknown> = {
      updated_at: new Date(),
    }

    if (input.tags !== undefined) updateValues.tags = input.tags
    if (input.brain_view !== undefined) updateValues.brain_view = input.brain_view

    if (input.metadata_overrides !== undefined) {
      // Merge metadata_overrides into source_metadata
      updateValues.source_metadata = sql`COALESCE(source_metadata, '{}'::jsonb) || ${JSON.stringify(input.metadata_overrides)}::jsonb`
    }

    const [updated] = await this.db
      .update(captures)
      .set(updateValues as any)
      .where(eq(captures.id, id))
      .returning()

    return updated as CaptureRecord
  }

  async softDelete(id: string): Promise<void> {
    await this.getById(id)
    const now = new Date()
    await this.db
      .update(captures)
      .set({ deleted_at: now, pipeline_status: 'deleted', updated_at: now })
      .where(eq(captures.id, id))
  }

  async getStats(): Promise<CaptureStats> {
    const [bySource, byType, byView, pipelineHealth] = await Promise.all([
      this.db.select({ source: captures.source, count: sql<string>`count(*)` })
        .from(captures)
        .where(isNull(captures.deleted_at))
        .groupBy(captures.source),

      this.db.select({ capture_type: captures.capture_type, count: sql<string>`count(*)` })
        .from(captures)
        .where(isNull(captures.deleted_at))
        .groupBy(captures.capture_type),

      this.db.select({ brain_view: captures.brain_view, count: sql<string>`count(*)` })
        .from(captures)
        .where(isNull(captures.deleted_at))
        .groupBy(captures.brain_view),

      this.db.select({ pipeline_status: captures.pipeline_status, count: sql<string>`count(*)` })
        .from(captures)
        .where(isNull(captures.deleted_at))
        .groupBy(captures.pipeline_status),
    ])

    const total = bySource.reduce((sum, r) => sum + Number(r.count), 0)

    const health = { pending: 0, processing: 0, complete: 0, failed: 0 }
    for (const r of pipelineHealth) {
      const count = Number(r.count)
      if (r.pipeline_status === 'pending') health.pending = count
      else if (r.pipeline_status === 'processing') health.processing = count
      else if (r.pipeline_status === 'complete') health.complete = count
      else if (r.pipeline_status === 'failed') health.failed = count
    }

    return {
      total_captures: total,
      by_source: Object.fromEntries(bySource.map(r => [r.source, Number(r.count)])),
      by_type: Object.fromEntries(byType.map(r => [r.capture_type, Number(r.count)])),
      by_view: Object.fromEntries(byView.map(r => [r.brain_view, Number(r.count)])),
      pipeline_health: health,
      total_entities: 0, // populated in Phase 12
    }
  }
}
