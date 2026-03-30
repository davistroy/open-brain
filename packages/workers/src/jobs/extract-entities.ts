import { Worker } from 'bullmq'
import { eq } from 'drizzle-orm'
import type OpenAI from 'openai'
import type { ConnectionOptions } from 'bullmq'
import type { Database } from '@open-brain/shared'
import { captures, pipeline_events, logger, createLiteLLMClient, TemplateCache } from '@open-brain/shared'
import type { ConfigService } from '@open-brain/shared'
import { EXTRACT_ENTITIES_BACKOFF_DELAYS_MS } from '../queues/extract-entities.js'
import type { ExtractEntitiesJobData } from '../queues/extract-entities.js'
import { ENTITY_TYPE_MAP, resolveOrCreateEntity, linkEntityToCapture } from '../lib/entity-resolver.js'
import type { ExtractedEntities } from '../lib/entity-resolver.js'

/**
 * Parse and validate the LLM JSON response.
 * Returns a safe ExtractedEntities object — missing fields default to empty arrays.
 * Non-string array elements are filtered out.
 */
function parseEntityResponse(raw: string): ExtractedEntities {
  let parsed: unknown
  try {
    // Strip markdown fences if the model wrapped the JSON
    const cleaned = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim()
    parsed = JSON.parse(cleaned)
  } catch {
    logger.warn({ raw }, '[extract-entities] LLM response is not valid JSON — returning empty')
    return { people: [], organizations: [], concepts: [], decisions: [], projects: [] }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { people: [], organizations: [], concepts: [], decisions: [], projects: [] }
  }

  const obj = parsed as Record<string, unknown>

  function toStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return []
    return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
  }

  return {
    people:        toStringArray(obj['people']),
    organizations: toStringArray(obj['organizations']),
    concepts:      toStringArray(obj['concepts']),
    decisions:     toStringArray(obj['decisions']),
    projects:      toStringArray(obj['projects']),
  }
}

/**
 * Custom BullMQ backoff strategy for patient entity extraction retry delays.
 */
export function extractEntitiesBackoffStrategy(attemptsMade: number): number {
  const idx = Math.min(attemptsMade - 1, EXTRACT_ENTITIES_BACKOFF_DELAYS_MS.length - 1)
  return EXTRACT_ENTITIES_BACKOFF_DELAYS_MS[idx]
}

/**
 * Core extract-entities job handler.
 *
 * Algorithm:
 * 1. Fetch capture content from DB
 * 2. Load extract-entities prompt template, substitute {{content}}
 * 3. Call LiteLLM `synthesis` alias for entity extraction
 * 4. Parse JSON response → ExtractedEntities
 * 5. For each entity mention: resolveOrCreateEntity() → linkEntityToCapture()
 * 6. Record pipeline_events stage entry
 *
 * Failures:
 * - Capture not found → log warn, return (idempotent skip)
 * - LLM failure → throw (triggers BullMQ patient backoff; non-critical to pipeline)
 * - DB errors → throw (triggers BullMQ patient backoff)
 *
 * Stage failure is intentionally non-blocking: captures are fully searchable
 * via embedding even if entity extraction fails. The pipeline_status field
 * is NOT updated here — entity extraction runs post-pipeline as an enrichment.
 */
export async function processExtractEntitiesJob(
  data: ExtractEntitiesJobData,
  db: Database,
  litellmClient: OpenAI,
  synthesisModel: string,
  templatesOrDir: TemplateCache | string,
): Promise<void> {
  const templates = typeof templatesOrDir === 'string'
    ? new TemplateCache(templatesOrDir)
    : templatesOrDir
  const { captureId } = data
  const start = Date.now()

  logger.info({ captureId }, '[extract-entities] job received')

  // ── Fetch capture ──────────────────────────────────────────────────────────
  const [capture] = await db
    .select({
      id: captures.id,
      content: captures.content,
      pipeline_status: captures.pipeline_status,
    })
    .from(captures)
    .where(eq(captures.id, captureId))
    .limit(1)

  if (!capture) {
    logger.warn({ captureId }, '[extract-entities] capture not found — skipping')
    return
  }

  // ── Record stage start ─────────────────────────────────────────────────────
  await db.insert(pipeline_events).values({
    capture_id: captureId,
    stage: 'extract_entities',
    status: 'started',
  })

  try {
    // ── Load prompt template ─────────────────────────────────────────────────
    const prompt = templates.render('extract-entities.v1.txt', { content: capture.content })

    // ── Call LiteLLM synthesis alias ─────────────────────────────────────────
    // Disable thinking/reasoning mode for structured JSON output (Qwen3.5 etc.)
    const response = await litellmClient.chat.completions.create({
      model: synthesisModel,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 1024,
    })

    const rawText = response.choices[0]?.message?.content ?? ''
    logger.debug({ captureId, rawText }, '[extract-entities] LLM response received')

    // ── Parse extracted entities ─────────────────────────────────────────────
    const extracted = parseEntityResponse(rawText)

    const totalMentions = Object.values(extracted).reduce((sum, arr) => sum + arr.length, 0)
    logger.info(
      { captureId, totalMentions },
      '[extract-entities] entities parsed from LLM response',
    )

    // ── Resolve and link each entity mention ─────────────────────────────────
    const linkPromises: Promise<void>[] = []

    for (const [field, entityType] of Object.entries(ENTITY_TYPE_MAP) as [keyof ExtractedEntities, string][]) {
      const mentions = extracted[field]
      for (const mention of mentions) {
        linkPromises.push(
          (async () => {
            try {
              const entityId = await resolveOrCreateEntity(db, mention, entityType)
              await linkEntityToCapture(db, entityId, captureId, 'mentioned', 0.9)
              logger.debug(
                { captureId, entityId, mention, entityType },
                '[extract-entities] entity linked',
              )
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err)
              logger.warn(
                { captureId, mention, entityType, err: msg },
                '[extract-entities] failed to resolve/link entity — skipping mention',
              )
            }
          })(),
        )
      }
    }

    await Promise.all(linkPromises)

    // ── Record stage success ───────────────────────────────────────────────────
    const durationMs = Date.now() - start
    await db.insert(pipeline_events).values({
      capture_id: captureId,
      stage: 'extract_entities',
      status: 'success',
      duration_ms: durationMs,
      metadata: { entity_counts: Object.fromEntries(
        Object.entries(ENTITY_TYPE_MAP).map(([field, type]) => [
          type,
          extracted[field as keyof ExtractedEntities].length,
        ]),
      )},
    })

    logger.info(
      { captureId, duration_ms: durationMs, totalMentions },
      '[extract-entities] job complete',
    )
  } catch (err) {
    const durationMs = Date.now() - start
    const errMsg = err instanceof Error ? err.message : String(err)

    await db.insert(pipeline_events).values({
      capture_id: captureId,
      stage: 'extract_entities',
      status: 'failed',
      duration_ms: durationMs,
      error: errMsg,
    })

    logger.error({ captureId, err }, '[extract-entities] job failed')
    throw err // let BullMQ retry with patient backoff
  }
}

/**
 * Creates and returns a BullMQ Worker for the 'extract-entities' queue.
 * The caller is responsible for calling worker.close() on process shutdown.
 */
export function createExtractEntitiesWorker(
  connection: ConnectionOptions,
  db: Database,
  configService: ConfigService,
  litellmBaseUrl: string,
  litellmApiKey: string,
  templates: TemplateCache,
): Worker<ExtractEntitiesJobData> {
  const aiConfig = configService.get('ai')
  const synthesisModel: string = aiConfig.models['synthesis'] as string

  const litellmClient = createLiteLLMClient({
    baseUrl: litellmBaseUrl,
    apiKey: litellmApiKey,
    timeout: 'standard',
    maxRetries: 0,
  })

  if (!litellmClient) {
    logger.warn('[extract-entities] LiteLLM client not available — entity extraction will fail')
  }

  const worker = new Worker<ExtractEntitiesJobData>(
    'extract-entities',
    async (job) => {
      if (!litellmClient) throw new Error('[extract-entities] LiteLLM client not configured — LITELLM_API_KEY missing')
      await processExtractEntitiesJob(
        job.data,
        db,
        litellmClient,
        synthesisModel,
        templates,
      )
    },
    {
      connection,
      concurrency: 2, // entity extraction can be parallelized; LiteLLM handles rate limiting
      settings: {
        backoffStrategy: extractEntitiesBackoffStrategy,
      },
    },
  )

  worker.on('failed', (job, err) => {
    const captureId = job?.data?.captureId ?? 'unknown'
    const attempts = job?.attemptsMade ?? 0
    logger.warn(
      { captureId, attempts, err: err.message },
      `[extract-entities] job failed (attempt ${attempts})`,
    )
  })

  worker.on('completed', (job) => {
    const captureId = job?.data?.captureId ?? 'unknown'
    logger.debug({ captureId }, '[extract-entities] job completed successfully')
  })

  return worker
}
