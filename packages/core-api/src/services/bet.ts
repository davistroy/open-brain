import { eq, and, lte, sql } from 'drizzle-orm'
import { bets, captures } from '@open-brain/shared'
import { NotFoundError, contentHash } from '@open-brain/shared'
import type { Database } from '@open-brain/shared'

// ============================================================
// Types
// ============================================================

export interface BetRecord {
  id: string
  statement: string
  confidence: number
  domain: string | null
  resolution_date: Date | null
  resolution: string | null
  resolution_notes: string | null
  session_id: string | null
  created_at: Date
  updated_at: Date
}

export interface CreateBetInput {
  /** Falsifiable prediction statement */
  statement?: string
  /** Commitment phrasing (governance engine alias for statement) */
  commitment?: string
  /** Criteria for resolution */
  criteria?: string
  /** Confidence 0.0–1.0 */
  confidence: number
  /** Optional domain/category (e.g. 'technical', 'business', 'personal') */
  domain?: string
  /** When the bet should be resolved */
  due_date?: Date
  /** Session that originated this bet (optional) */
  session_id?: string
  /** Source that created this bet */
  source?: string
  /** Tags associated with this bet */
  tags?: string[]
}

export interface ResolveBetInput {
  /** Resolution outcome: correct | incorrect | ambiguous */
  resolution: 'correct' | 'incorrect' | 'ambiguous'
  /** Supporting evidence or notes for the resolution */
  evidence?: string
}

export interface BetListResult {
  items: BetRecord[]
  total: number
}

// ============================================================
// BetService
// ============================================================

/**
 * BetService — CRUD operations for explicit predictions/bets.
 *
 * create()       — Insert a new bet with 'pending' resolution.
 * list()         — Paginated bet list with optional status filter.
 * getById()      — Fetch a single bet by ID.
 * resolve()      — Set resolution outcome + auto-capture the result as a brain entry.
 * getExpiring()  — Bets due within N days that are still pending.
 *
 * On resolution, a brain entry is auto-captured (capture_type: 'reflection') so that
 * bet outcomes are searchable via the normal capture pipeline.
 */
export class BetService {
  constructor(private db: Database) {}

  // --------------------------------------------------------------------------
  // create — insert a new open bet
  // --------------------------------------------------------------------------
  async create(input: CreateBetInput): Promise<BetRecord> {
    const [created] = await this.db
      .insert(bets)
      .values({
        statement: input.commitment ?? input.statement ?? '',
        confidence: input.confidence,
        domain: input.domain ?? null,
        resolution_date: input.due_date ?? null,
        resolution: 'pending',
        resolution_notes: null,
        session_id: input.session_id ?? null,
      })
      .returning()

    return created as BetRecord
  }

  // --------------------------------------------------------------------------
  // list — paginated list with optional resolution (status) filter
  // --------------------------------------------------------------------------
  async list(
    statusFilter?: string,
    limit = 20,
    offset = 0,
  ): Promise<BetListResult> {
    const safeLimit = Math.min(limit, 100)
    const safeOffset = Math.max(offset, 0)

    const whereClause = statusFilter
      ? eq(bets.resolution, statusFilter)
      : undefined

    const [countResult, items] = await Promise.all([
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(bets)
        .where(whereClause),
      this.db
        .select()
        .from(bets)
        .where(whereClause)
        .orderBy(sql`created_at DESC`)
        .limit(safeLimit)
        .offset(safeOffset),
    ])

    return {
      items: items as BetRecord[],
      total: countResult[0]?.count ?? 0,
    }
  }

  // --------------------------------------------------------------------------
  // getById — fetch a single bet, throws NotFoundError if missing
  // --------------------------------------------------------------------------
  async getById(id: string): Promise<BetRecord> {
    const [bet] = await this.db
      .select()
      .from(bets)
      .where(eq(bets.id, id))
      .limit(1)

    if (!bet) {
      throw new NotFoundError(`Bet not found: ${id}`)
    }

    return bet as BetRecord
  }

  // --------------------------------------------------------------------------
  // resolve — set resolution outcome + optionally add evidence notes.
  // Auto-captures the result as a brain 'reflection' entry so it flows
  // through the normal pipeline and becomes searchable.
  // --------------------------------------------------------------------------
  async resolve(id: string, input: ResolveBetInput): Promise<BetRecord> {
    const bet = await this.getById(id)

    if (bet.resolution !== 'pending') {
      throw new Error(`Bet ${id} is already resolved (${bet.resolution})`)
    }

    const [updated] = await this.db
      .update(bets)
      .set({
        resolution: input.resolution,
        resolution_notes: input.evidence ?? null,
        updated_at: new Date(),
      })
      .where(eq(bets.id, id))
      .returning()

    // Auto-capture the resolution as a brain entry so it's searchable
    await this._captureResolution(bet, input)

    return updated as BetRecord
  }

  // --------------------------------------------------------------------------
  // getExpiring — bets with resolution_date within the next N days
  // that are still pending
  // --------------------------------------------------------------------------
  async getExpiring(daysAhead = 7): Promise<BetRecord[]> {
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() + daysAhead)

    const rows = await this.db
      .select()
      .from(bets)
      .where(
        and(
          eq(bets.resolution, 'pending'),
          lte(bets.resolution_date, cutoff),
        ),
      )
      .orderBy(bets.resolution_date)

    return rows as BetRecord[]
  }

  // --------------------------------------------------------------------------
  // _captureResolution — private: insert a capture for the bet resolution.
  // Uses capture_type 'reflection' (outcome of a prediction fits reflection
  // better than decision). capture_type could be 'decision' for bets that
  // drove an explicit choice — callers can override in the future if needed.
  // --------------------------------------------------------------------------
  private async _captureResolution(
    bet: BetRecord,
    resolution: ResolveBetInput,
  ): Promise<void> {
    const outcomeEmoji = resolution.resolution === 'correct' ? '[WON]'
      : resolution.resolution === 'incorrect' ? '[LOST]'
      : '[AMBIGUOUS]'

    const content = [
      `Bet resolved ${outcomeEmoji}: ${bet.statement}`,
      `Confidence at creation: ${Math.round(bet.confidence * 100)}%`,
      `Outcome: ${resolution.resolution}`,
      resolution.evidence ? `Notes: ${resolution.evidence}` : null,
      bet.domain ? `Domain: ${bet.domain}` : null,
    ]
      .filter(Boolean)
      .join('\n')

    const hash = contentHash(content)

    // Check for an existing capture with the same hash to avoid duplication
    // if resolve() is called more than once (e.g. retry after transient failure).
    const existing = await this.db
      .select({ id: captures.id })
      .from(captures)
      .where(eq(captures.content_hash, hash))
      .limit(1)

    if (existing.length > 0) {
      return
    }

    await this.db.insert(captures).values({
      content,
      content_hash: hash,
      capture_type: 'reflection',
      brain_view: 'personal',
      source: 'system',
      source_metadata: {
        bet_id: bet.id,
        bet_resolution: resolution.resolution,
        session_id: bet.session_id,
      },
      tags: ['bet', 'prediction', resolution.resolution],
      pipeline_status: 'pending',
      pre_extracted: null,
      captured_at: new Date(),
    })
  }
}
