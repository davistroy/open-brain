import { createHash } from 'node:crypto'
import { Worker } from 'bullmq'
import { eq, and, sql } from 'drizzle-orm'
import type { ConnectionOptions } from 'bullmq'
import type { Database } from '@open-brain/shared'
import { captures, pipeline_events, commitments, logger, TemplateCache } from '@open-brain/shared'
import type { LLMGatewayService } from '@open-brain/shared'
import { EXTRACT_COMMITMENTS_BACKOFF_DELAYS_MS } from '../queues/extract-commitments.js'
import type { ExtractCommitmentsJobData } from '../queues/extract-commitments.js'
import { resolveOrCreateEntity } from '../lib/entity-resolver.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Raw commitment object as returned by the LLM JSON response.
 * Validated before upsert — all fields optional until checked.
 */
interface RawCommitment {
  text?: unknown
  due_date_iso?: unknown
  entity_name?: unknown
  direction?: unknown
}

/**
 * Validated commitment ready for DB upsert.
 */
interface ValidatedCommitment {
  text: string
  due_date_iso: string | null
  entity_name: string | null
  direction: 'pending' | 'owed_by_user' | 'waiting_on'
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

const VALID_DIRECTIONS = new Set(['pending', 'owed_by_user', 'waiting_on'])

/**
 * Parse and validate the LLM JSON response for commitment extraction.
 * Returns an array of validated commitments — invalid elements are skipped.
 * Strips markdown fences if the model wrapped the JSON.
 */
function parseCommitmentResponse(raw: string): ValidatedCommitment[] {
  let parsed: unknown
  try {
    const cleaned = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim()
    parsed = JSON.parse(cleaned)
  } catch {
    logger.warn({ raw }, '[extract-commitments] LLM response is not valid JSON — returning empty')
    return []
  }

  if (!Array.isArray(parsed)) {
    logger.warn({ type: typeof parsed }, '[extract-commitments] LLM response is not an array — returning empty')
    return []
  }

  const result: ValidatedCommitment[] = []

  for (const item of parsed as RawCommitment[]) {
    if (typeof item !== 'object' || item === null) continue

    const text = item.text
    if (typeof text !== 'string' || text.trim().length === 0) continue

    const direction = item.direction
    if (typeof direction !== 'string' || !VALID_DIRECTIONS.has(direction)) continue

    const due = item.due_date_iso
    const due_date_iso =
      typeof due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(due.trim())
        ? due.trim()
        : null

    const entityRaw = item.entity_name
    const entity_name =
      typeof entityRaw === 'string' && entityRaw.trim().length > 0
        ? entityRaw.trim()
        : null

    result.push({
      text: text.trim(),
      due_date_iso,
      entity_name,
      direction: direction as ValidatedCommitment['direction'],
    })
  }

  return result
}

/**
 * Compute SHA-256 of `captureId + text` to dedup repeated runs.
 * Two commitments with identical text from the same capture are the same row.
 */
function commitmentHash(captureId: string, text: string): string {
  return createHash('sha256').update(`${captureId}:${text}`).digest('hex')
}

// ---------------------------------------------------------------------------
// Custom BullMQ backoff strategy
// ---------------------------------------------------------------------------

export function extractCommitmentsBackoffStrategy(attemptsMade: number): number {
  const idx = Math.min(attemptsMade - 1, EXTRACT_COMMITMENTS_BACKOFF_DELAYS_MS.length - 1)
  return EXTRACT_COMMITMENTS_BACKOFF_DELAYS_MS[idx]
}

// ---------------------------------------------------------------------------
// Core job handler
// ---------------------------------------------------------------------------

/**
 * Core extract-commitments job handler.
 *
 * Algorithm:
 * 1. Fetch capture content from DB
 * 2. Record pipeline_events stage: started
 * 3. Load extract-commitments prompt template, substitute {{content}}
 * 4. Call T1 LLM via llmGateway.completeByTask('commitment_extraction')
 * 5. Parse JSON response → ValidatedCommitment[]
 * 6. For each commitment:
 *    a. Compute SHA-256 dedup hash (captureId + text)
 *    b. Check if row already exists — skip if duplicate
 *    c. Optionally resolve entity_name to entity_id via entity-resolver
 *    d. INSERT commitment row
 * 7. Record pipeline_events stage: success / failed
 *
 * Non-critical: failures are recorded in pipeline_events but NEVER propagate
 * to the ingest pipeline — ingest-root runs regardless via removeDependencyOnFailure.
 */
export async function processExtractCommitmentsJob(
  data: ExtractCommitmentsJobData,
  db: Database,
  templates: TemplateCache,
  llmGateway: LLMGatewayService,
): Promise<void> {
  const { captureId, traceId } = data
  const start = Date.now()
  const log = traceId ? logger.child({ captureId, traceId }) : logger.child({ captureId })

  log.info('[extract-commitments] job received')

  // ── Fetch capture ──────────────────────────────────────────────────────────
  const [capture] = await db
    .select({
      id: captures.id,
      content: captures.content,
    })
    .from(captures)
    .where(eq(captures.id, captureId))
    .limit(1)

  if (!capture) {
    log.warn('[extract-commitments] capture not found — skipping')
    return
  }

  // ── Record stage start ─────────────────────────────────────────────────────
  await db.insert(pipeline_events).values({
    capture_id: captureId,
    stage: 'extract_commitments',
    status: 'started',
    metadata: traceId ? { trace_id: traceId } : undefined,
  })

  try {
    // ── Load prompt template ─────────────────────────────────────────────────
    const prompt = templates.render('extract-commitments.v1.txt', { content: capture.content })

    // ── Call T1 LLM for commitment extraction ────────────────────────────────
    const rawText = await llmGateway.completeByTask(prompt, 'commitment_extraction', {
      temperature: 0.1,
      maxTokens: 2048,
      captureId,
      jsonMode: true,
    })

    log.debug('[extract-commitments] gateway response received')

    // ── Parse extracted commitments ──────────────────────────────────────────
    const extracted = parseCommitmentResponse(rawText)

    log.info(
      { count: extracted.length },
      '[extract-commitments] commitments parsed from LLM response',
    )

    if (extracted.length === 0) {
      // No commitments — record success and exit
      const durationMs = Date.now() - start
      await db.insert(pipeline_events).values({
        capture_id: captureId,
        stage: 'extract_commitments',
        status: 'success',
        duration_ms: durationMs,
        metadata: {
          ...(traceId ? { trace_id: traceId } : {}),
          commitment_count: 0,
        },
      })
      log.info({ duration_ms: durationMs }, '[extract-commitments] job complete — no commitments found')
      return
    }

    // ── Upsert commitments (SHA-256 dedup per capture) ───────────────────────
    let insertedCount = 0
    let skippedCount = 0

    for (const commitment of extracted) {
      const hash = commitmentHash(captureId, commitment.text)

      // Check for existing row by dedup hash (stored in a metadata field via select).
      // We use a direct SQL existence check on text + capture_id since we don't store
      // the hash column — equivalent dedup via (capture_id, SHA256(text)) is enforced
      // by checking text equality per capture which is what the hash guards.
      const [existing] = await db
        .select({ id: commitments.id })
        .from(commitments)
        .where(
          and(
            eq(commitments.capture_id, captureId),
            sql`md5(${commitments.text}) = md5(${commitment.text})`,
          ),
        )
        .limit(1)

      if (existing) {
        log.debug({ hash, text: commitment.text.slice(0, 60) }, '[extract-commitments] duplicate — skipping')
        skippedCount++
        continue
      }

      // Resolve entity_name → entity_id if present
      let entityId: string | null = null
      if (commitment.entity_name) {
        try {
          entityId = await resolveOrCreateEntity(db, commitment.entity_name, 'person')
          log.debug(
            { entityId, entityName: commitment.entity_name },
            '[extract-commitments] entity resolved',
          )
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          log.warn(
            { entityName: commitment.entity_name, err: msg },
            '[extract-commitments] entity resolution failed — storing commitment without entity_id',
          )
          entityId = null
        }
      }

      // INSERT commitment row
      await db.insert(commitments).values({
        capture_id: captureId,
        entity_id: entityId ?? undefined,
        text: commitment.text,
        due_date: commitment.due_date_iso ?? undefined,
        status: commitment.direction,
      })

      log.debug(
        { status: commitment.direction, entityId, text: commitment.text.slice(0, 60) },
        '[extract-commitments] commitment inserted',
      )
      insertedCount++
    }

    // ── Record stage success ───────────────────────────────────────────────────
    const durationMs = Date.now() - start
    await db.insert(pipeline_events).values({
      capture_id: captureId,
      stage: 'extract_commitments',
      status: 'success',
      duration_ms: durationMs,
      metadata: {
        ...(traceId ? { trace_id: traceId } : {}),
        commitment_count: insertedCount,
        skipped_count: skippedCount,
      },
    })

    log.info(
      { duration_ms: durationMs, inserted: insertedCount, skipped: skippedCount },
      '[extract-commitments] job complete',
    )
  } catch (err) {
    const durationMs = Date.now() - start
    const errMsg = err instanceof Error ? err.message : String(err)

    await db.insert(pipeline_events).values({
      capture_id: captureId,
      stage: 'extract_commitments',
      status: 'failed',
      duration_ms: durationMs,
      error: errMsg,
      metadata: traceId ? { trace_id: traceId } : undefined,
    })

    log.error({ err }, '[extract-commitments] job failed')
    throw err // let BullMQ retry with patient backoff
  }
}

// ---------------------------------------------------------------------------
// Worker factory
// ---------------------------------------------------------------------------

/**
 * Creates and returns a BullMQ Worker for the 'extract-commitments' queue.
 * The caller is responsible for calling worker.close() on process shutdown.
 *
 * Concurrency: 2 — commitment extraction can be parallelized; T1 LLM handles
 * rate limiting. Keep consistent with extract-entities concurrency.
 */
export function createExtractCommitmentsWorker(
  connection: ConnectionOptions,
  db: Database,
  templates: TemplateCache,
  llmGateway: LLMGatewayService,
): Worker<ExtractCommitmentsJobData> {
  logger.info('[extract-commitments] Using LLMGatewayService for commitment extraction (task-based routing)')

  const worker = new Worker<ExtractCommitmentsJobData>(
    'extract-commitments',
    async (job) => {
      await processExtractCommitmentsJob(job.data, db, templates, llmGateway)
    },
    {
      connection,
      concurrency: 2,
      settings: {
        backoffStrategy: extractCommitmentsBackoffStrategy,
      },
    },
  )

  worker.on('failed', (job, err) => {
    const captureId = job?.data?.captureId ?? 'unknown'
    const attempts = job?.attemptsMade ?? 0
    logger.warn(
      { captureId, attempts, err: err.message },
      `[extract-commitments] job failed (attempt ${attempts})`,
    )
  })

  worker.on('completed', (job) => {
    const captureId = job?.data?.captureId ?? 'unknown'
    logger.debug({ captureId }, '[extract-commitments] job completed successfully')
  })

  return worker
}
