import { Worker } from 'bullmq'
import { eq, sql, and } from 'drizzle-orm'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import OpenAI from 'openai'
import type { ConnectionOptions } from 'bullmq'
import type { Database } from '@open-brain/shared'
import { captures, entities, entity_links, pipeline_events } from '@open-brain/shared'
import type { ConfigService } from '@open-brain/shared'
import { logger } from '../lib/logger.js'
import { EXTRACT_ENTITIES_BACKOFF_DELAYS_MS } from '../queues/extract-entities.js'
import type { ExtractEntitiesJobData } from '../queues/extract-entities.js'

const LLM_TIMEOUT_MS = 60_000

/**
 * Raw LLM extraction result — validated before use.
 */
interface ExtractedEntities {
  people: string[]
  organizations: string[]
  concepts: string[]
  decisions: string[]
  projects: string[]
}

/**
 * Map from prompt field name to entity_type stored in DB.
 * Aligns with supported entity_type values in the entities table.
 */
const ENTITY_TYPE_MAP: Record<keyof ExtractedEntities, string> = {
  people: 'person',
  organizations: 'org',
  concepts: 'concept',
  decisions: 'decision',
  projects: 'project',
}

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
 * Resolve or create an entity for a given name + type.
 *
 * Resolution order:
 * 1. Exact name or canonical_name match (case-insensitive) within entity_type
 * 2. Alias match within entity_type
 * 3. No match found → INSERT new entity
 *
 * Full LLM disambiguation (three-tier per TDD §6.2) is implemented in
 * EntityResolutionService (work item 12.1). This job uses the lightweight
 * two-tier path appropriate for batch pipeline processing.
 *
 * Returns the resolved entity id.
 */
async function resolveOrCreateEntity(
  db: Database,
  name: string,
  entityType: string,
): Promise<string> {
  const normalizedName = name.trim()
  if (!normalizedName) throw new Error('Entity name must not be empty')

  const lowerName = normalizedName.toLowerCase()

  // Tier 1: Exact case-insensitive name or canonical_name match via indexed lower() lookup.
  // Uses (entity_type, lower(name)) and (entity_type, lower(canonical_name)) indexes.
  const [byName] = await db
    .select({ id: entities.id })
    .from(entities)
    .where(
      and(
        eq(entities.entity_type, entityType),
        sql`(lower(${entities.name}) = ${lowerName} OR lower(${entities.canonical_name}) = ${lowerName})`,
      ),
    )
    .limit(1)

  if (byName) {
    await db
      .update(entities)
      .set({ last_seen_at: new Date(), updated_at: new Date() })
      .where(eq(entities.id, byName.id))
    return byName.id
  }

  // Tier 2: Alias match using Postgres array contains operator (@>).
  // Checks whether the aliases array column contains the lowercased mention.
  const [byAlias] = await db
    .select({ id: entities.id })
    .from(entities)
    .where(
      and(
        eq(entities.entity_type, entityType),
        sql`${entities.aliases} @> ARRAY[${lowerName}]::text[]`,
      ),
    )
    .limit(1)

  if (byAlias) {
    await db
      .update(entities)
      .set({ last_seen_at: new Date(), updated_at: new Date() })
      .where(eq(entities.id, byAlias.id))
    return byAlias.id
  }

  // 3. Create new entity
  const [inserted] = await db
    .insert(entities)
    .values({
      name: normalizedName,
      entity_type: entityType,
      canonical_name: normalizedName,
      aliases: [],
      metadata: null,
    })
    .returning({ id: entities.id })

  if (!inserted) {
    throw new Error(`[extract-entities] INSERT entity failed for name="${normalizedName}" type="${entityType}"`)
  }

  logger.debug(
    { entityId: inserted.id, name: normalizedName, entityType },
    '[extract-entities] new entity created',
  )

  return inserted.id
}

/**
 * Create an entity_link between an entity and a capture (upsert — idempotent).
 * If the link already exists (unique constraint), the error is silently swallowed.
 */
async function linkEntityToCapture(
  db: Database,
  entityId: string,
  captureId: string,
  relationship: string,
  confidence: number,
): Promise<void> {
  try {
    await db
      .insert(entity_links)
      .values({
        entity_id: entityId,
        capture_id: captureId,
        relationship,
        confidence,
      })
      .onConflictDoNothing()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.warn(
      { entityId, captureId, err: msg },
      '[extract-entities] entity_link insert conflict — skipping',
    )
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
  promptsDir: string,
): Promise<void> {
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
    const templatePath = join(promptsDir, 'extract-entities.v1.txt')
    if (!existsSync(templatePath)) {
      throw new Error(`Prompt template not found: ${templatePath}`)
    }
    const prompt = readFileSync(templatePath, 'utf8').replaceAll('{{content}}', capture.content)

    // ── Call LiteLLM synthesis alias ─────────────────────────────────────────
    // Disable thinking/reasoning mode for structured JSON output (Qwen3.5 etc.)
    const response = await litellmClient.chat.completions.create({
      model: synthesisModel,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 1024,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      extra_body: { chat_template_kwargs: { enable_thinking: false } },
    } as any)

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
  promptsDir: string,
): Worker<ExtractEntitiesJobData> {
  const aiConfig = configService.get('ai')
  const synthesisModel: string = aiConfig.models['synthesis'] as string

  const litellmClient = new OpenAI({
    baseURL: litellmBaseUrl,
    apiKey: litellmApiKey,
    timeout: LLM_TIMEOUT_MS,
  })

  const worker = new Worker<ExtractEntitiesJobData>(
    'extract-entities',
    async (job) => {
      await processExtractEntitiesJob(
        job.data,
        db,
        litellmClient,
        synthesisModel,
        promptsDir,
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
