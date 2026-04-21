import { eq, and, isNull, desc, sql } from 'drizzle-orm'
import { briefs } from '@open-brain/shared'
import { NotFoundError } from '@open-brain/shared'
import type { Database } from '@open-brain/shared'
import type { BriefRow, NewBriefRow } from '@open-brain/shared'
import type { Queue } from 'bullmq'
import { logger } from '@open-brain/shared'

/** Paginated list result for briefs */
export interface BriefListResult {
  items: BriefListItem[]
  total: number
  limit: number
  offset: number
}

/** List-shape brief (no body_html / toc / sources — large fields excluded for grid view) */
export interface BriefListItem {
  id: string
  kind: string
  cover: string
  title: string
  subtitle: string | null
  source_skill_log_id: string | null
  refined_from_id: string | null
  generated_at: string
  read_at: string | null
  dismissed_at: string | null
  created_at: string
  updated_at: string
}

/** Full detail shape including body_html, toc, sources, refine_options */
export interface BriefDetailItem extends BriefListItem {
  body_html: string
  toc: unknown
  sources: unknown
  refine_options: unknown
}

/** Input for creating a brief (used by skills, not exposed as a public endpoint) */
export interface CreateBriefInput {
  kind: string
  cover: string
  title: string
  subtitle?: string
  body_html: string
  toc?: unknown[]
  sources?: unknown[]
  refine_options?: string[]
  source_skill_log_id?: string
  refined_from_id?: string
}

/** Job data shape for skill-execution queue */
interface SkillExecutionJobData {
  skillName: string
  input: Record<string, unknown>
}

/**
 * BriefsService — CRUD + async operations for the briefs domain model.
 *
 * list()     — paginated briefs with optional kind/unread filters, sorted by generated_at DESC.
 * getById()  — full detail including body_html, toc, sources, refine_options.
 * create()   — INSERT into briefs table; used by skills, not a public endpoint.
 * refine()   — enqueue a BullMQ skill-execution job for 'refine-brief'; returns {job_id, status}.
 * dismiss()  — set dismissed_at = NOW().
 * patchRead() — set read_at = NOW() (read:true) or NULL (read:false).
 */
export class BriefsService {
  constructor(
    private db: Database,
    private skillQueue?: Queue<SkillExecutionJobData>,
  ) {}

  /** Map a raw DB row to the list-shape DTO */
  private toListItem(row: BriefRow): BriefListItem {
    return {
      id: row.id,
      kind: row.kind,
      cover: row.cover,
      title: row.title,
      subtitle: row.subtitle ?? null,
      source_skill_log_id: row.source_skill_log_id ?? null,
      refined_from_id: row.refined_from_id ?? null,
      generated_at: row.generated_at.toISOString(),
      read_at: row.read_at ? row.read_at.toISOString() : null,
      dismissed_at: row.dismissed_at ? row.dismissed_at.toISOString() : null,
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    }
  }

  /** Map a raw DB row to the detail-shape DTO */
  private toDetailItem(row: BriefRow): BriefDetailItem {
    return {
      ...this.toListItem(row),
      body_html: row.body_html,
      toc: row.toc,
      sources: row.sources,
      refine_options: row.refine_options,
    }
  }

  /**
   * List briefs with optional filters.
   *
   * @param kind     - optional BriefKind filter ('DAILY' | 'WEEKLY' | ...)
   * @param unread   - if true, only return rows where read_at IS NULL
   * @param limit    - max rows (default 20, capped at 100)
   * @param offset   - pagination offset (default 0)
   */
  async list(params: {
    kind?: string
    unread?: boolean
    limit?: number
    offset?: number
  }): Promise<BriefListResult> {
    const limit = Math.min(params.limit ?? 20, 100)
    const offset = params.offset ?? 0

    const conditions: ReturnType<typeof eq>[] = []

    if (params.kind) {
      conditions.push(eq(briefs.kind, params.kind))
    }

    if (params.unread === true) {
      conditions.push(isNull(briefs.read_at) as ReturnType<typeof eq>)
    }

    const whereClause = conditions.length > 0
      ? and(...conditions)
      : undefined

    const [dataRows, countRows] = await Promise.all([
      this.db
        .select({
          id: briefs.id,
          kind: briefs.kind,
          cover: briefs.cover,
          title: briefs.title,
          subtitle: briefs.subtitle,
          source_skill_log_id: briefs.source_skill_log_id,
          refined_from_id: briefs.refined_from_id,
          generated_at: briefs.generated_at,
          read_at: briefs.read_at,
          dismissed_at: briefs.dismissed_at,
          created_at: briefs.created_at,
          updated_at: briefs.updated_at,
        })
        .from(briefs)
        .where(whereClause)
        .orderBy(desc(briefs.generated_at))
        .limit(limit)
        .offset(offset),

      this.db
        .select({ total: sql<string>`count(*)` })
        .from(briefs)
        .where(whereClause),
    ])

    // Map partial rows — body_html/toc/sources/refine_options not selected
    const items: BriefListItem[] = dataRows.map((row) => ({
      id: row.id,
      kind: row.kind,
      cover: row.cover,
      title: row.title,
      subtitle: row.subtitle ?? null,
      source_skill_log_id: row.source_skill_log_id ?? null,
      refined_from_id: row.refined_from_id ?? null,
      generated_at: row.generated_at.toISOString(),
      read_at: row.read_at ? row.read_at.toISOString() : null,
      dismissed_at: row.dismissed_at ? row.dismissed_at.toISOString() : null,
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    }))

    return {
      items,
      total: Number(countRows[0]?.total ?? 0),
      limit,
      offset,
    }
  }

  /**
   * Get a single brief by ID — full detail shape including body_html, toc, sources.
   *
   * @throws NotFoundError if the brief does not exist.
   */
  async getById(id: string): Promise<BriefDetailItem> {
    const rows = await this.db
      .select()
      .from(briefs)
      .where(sql`${briefs.id} = ${id}::uuid`)
      .limit(1)

    if (rows.length === 0) {
      throw new NotFoundError(`Brief not found: ${id}`)
    }

    return this.toDetailItem(rows[0] as BriefRow)
  }

  /**
   * Insert a new brief row.
   * Used internally by brief-writing skills (weekly-brief, daily-sweep-skill, etc.).
   * Not exposed as a public endpoint.
   *
   * @returns The full inserted row.
   */
  async create(data: CreateBriefInput): Promise<BriefDetailItem> {
    const newRow: NewBriefRow = {
      kind: data.kind,
      cover: data.cover,
      title: data.title,
      subtitle: data.subtitle,
      body_html: data.body_html,
      toc: (data.toc ?? []) as NewBriefRow['toc'],
      sources: (data.sources ?? []) as NewBriefRow['sources'],
      refine_options: (data.refine_options ?? []) as NewBriefRow['refine_options'],
      source_skill_log_id: data.source_skill_log_id,
      refined_from_id: data.refined_from_id,
    }

    const inserted = await this.db
      .insert(briefs)
      .values(newRow)
      .returning()

    if (!inserted[0]) {
      throw new Error('Brief insert returned no rows')
    }

    logger.info({ briefId: inserted[0].id, kind: inserted[0].kind }, '[briefs-service] brief created')

    return this.toDetailItem(inserted[0] as BriefRow)
  }

  /**
   * Enqueue a 'refine-brief' skill-execution job for the given brief.
   *
   * Verifies the source brief exists first (throws NotFoundError if not).
   * Requires skillQueue to be injected; throws if absent.
   *
   * @param id     - UUID of the source brief to refine.
   * @param option - refinement preset string (e.g. 'Shorter', 'More formal').
   * @returns      { job_id, status: 'queued' }
   */
  async refine(id: string, option: string): Promise<{ job_id: string | undefined; status: 'queued' }> {
    // Verify the brief exists before queuing
    await this.getById(id)

    if (!this.skillQueue) {
      throw new Error('BriefsService.refine() requires skillQueue — not injected')
    }

    const job = await this.skillQueue.add(
      'refine-brief',
      {
        skillName: 'refine-brief',
        input: {
          source_brief_id: id,
          option,
        },
      },
      {
        priority: 2,
        jobId: `refine_brief_${id}_${Date.now()}`,
      },
    )

    logger.info({ briefId: id, option, jobId: job.id }, '[briefs-service] refine job enqueued')

    return { job_id: job.id, status: 'queued' }
  }

  /**
   * Mark a brief as dismissed (sets dismissed_at = NOW()).
   *
   * @throws NotFoundError if the brief does not exist.
   */
  async dismiss(id: string): Promise<void> {
    const updated = await this.db
      .update(briefs)
      .set({ dismissed_at: new Date(), updated_at: new Date() })
      .where(sql`${briefs.id} = ${id}::uuid`)
      .returning({ id: briefs.id })

    if (updated.length === 0) {
      throw new NotFoundError(`Brief not found: ${id}`)
    }

    logger.info({ briefId: id }, '[briefs-service] brief dismissed')
  }

  /**
   * Toggle the read state of a brief.
   *
   * @param id   - UUID of the brief.
   * @param read - true sets read_at = NOW(); false sets read_at = NULL.
   * @throws NotFoundError if the brief does not exist.
   */
  async patchRead(id: string, read: boolean): Promise<BriefListItem> {
    const updated = await this.db
      .update(briefs)
      .set({
        read_at: read ? new Date() : null,
        updated_at: new Date(),
      })
      .where(sql`${briefs.id} = ${id}::uuid`)
      .returning({
        id: briefs.id,
        kind: briefs.kind,
        cover: briefs.cover,
        title: briefs.title,
        subtitle: briefs.subtitle,
        source_skill_log_id: briefs.source_skill_log_id,
        refined_from_id: briefs.refined_from_id,
        generated_at: briefs.generated_at,
        read_at: briefs.read_at,
        dismissed_at: briefs.dismissed_at,
        created_at: briefs.created_at,
        updated_at: briefs.updated_at,
      })

    if (updated.length === 0) {
      throw new NotFoundError(`Brief not found: ${id}`)
    }

    const row = updated[0]!
    return {
      id: row.id,
      kind: row.kind,
      cover: row.cover,
      title: row.title,
      subtitle: row.subtitle ?? null,
      source_skill_log_id: row.source_skill_log_id ?? null,
      refined_from_id: row.refined_from_id ?? null,
      generated_at: row.generated_at.toISOString(),
      read_at: row.read_at ? row.read_at.toISOString() : null,
      dismissed_at: row.dismissed_at ? row.dismissed_at.toISOString() : null,
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    }
  }
}
