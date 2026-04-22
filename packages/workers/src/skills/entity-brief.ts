import { sql } from 'drizzle-orm'
import {
  logger,
  SafePromptBuilder,
  renderBriefHtml,
  mapCaptureSourceToBriefType,
  briefs,
  REFINE_OPTIONS,
} from '@open-brain/shared'
import type { Database, LLMGatewayService, AutonomyLevel } from '@open-brain/shared'
import type { BriefSource } from '@open-brain/shared'
import { LLMSkill } from './llm-skill.js'
import type { LLMSkillOpts, BaseResult } from './types.js'

// ============================================================
// Constants
// ============================================================

/** Top-N captures fetched for the entity brief (FTS ranked on entity name). */
const MAX_CAPTURES = 50

/** Top-N related entities fetched via entity_relationships (1-hop). */
const MAX_RELATED_ENTITIES = 10

/** Task key in ai-routing.yaml — reuses search_synthesis tier (D116). */
const ENTITY_BRIEF_TASK = 'search_synthesis'

/** Dossier-specific refinement options shown in the brief reader. */
const DOSSIER_REFINE_OPTIONS: readonly string[] = [
  'Focus on recent',
  'Focus on decisions',
  'Key relationships only',
] as const

// ============================================================
// Input / Output types
// ============================================================

export interface EntityBriefInput {
  /** UUID of the entity to generate a dossier for. */
  entityId: string
  /** Display name of the entity (used in prompt + brief title). */
  entityName?: string
  /** Entity type label (person, org, project, concept, place, tool). */
  entityType?: string
}

export interface EntityBriefOutput {
  summary: string
  key_facts: string[]
  recent_activity: string[]
  open_threads: string[]
  relationship_context: string
  signals: string[]
}

export interface EntityBriefResult extends BaseResult {
  entityId: string
  entityName: string
  captureCount: number
  briefId: string | null
  generated: boolean
}

// ============================================================
// Minimal DB row shapes (must satisfy Record<string, unknown> for db.execute<T>)
// ============================================================

interface EntityRow extends Record<string, unknown> {
  id: string
  name: string
  entity_type: string
}

interface CaptureRow extends Record<string, unknown> {
  id: string
  content: string
  capture_type: string
  source: string
  captured_at: Date | string
}

interface RelatedEntityRow extends Record<string, unknown> {
  id: string
  name: string
  entity_type: string
  co_occurrence_count: number
}

// ============================================================
// Helpers
// ============================================================

function fmtDate(d: Date | string): string {
  const dt = d instanceof Date ? d : new Date(d)
  return dt.toISOString().slice(0, 10)
}

function buildEntityBriefMarkdown(
  entityName: string,
  entityType: string,
  output: EntityBriefOutput,
): string {
  const lines: string[] = [
    `# ${entityName}`,
    `*Entity type: ${entityType}*`,
    '',
    output.summary,
    '',
  ]

  if (output.key_facts.length > 0) {
    lines.push('## Key Facts')
    for (const fact of output.key_facts) lines.push(`- ${fact}`)
    lines.push('')
  }

  if (output.recent_activity.length > 0) {
    lines.push('## Recent Activity')
    for (const item of output.recent_activity) lines.push(`- ${item}`)
    lines.push('')
  }

  if (output.relationship_context) {
    lines.push('## Relationship Context')
    lines.push(output.relationship_context)
    lines.push('')
  }

  if (output.open_threads.length > 0) {
    lines.push('## Open Threads')
    for (const thread of output.open_threads) lines.push(`- ${thread}`)
    lines.push('')
  }

  if (output.signals.length > 0) {
    lines.push('## Signals & Patterns')
    for (const signal of output.signals) lines.push(`- ${signal}`)
    lines.push('')
  }

  return lines.join('\n').trim()
}

/**
 * Parses the LLM JSON output into EntityBriefOutput.
 * Exported for unit-testing the parser in isolation.
 */
export function parseEntityBriefOutput(raw: string): EntityBriefOutput {
  let cleaned = raw.trim()
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  }

  const empty: EntityBriefOutput = {
    summary: '',
    key_facts: [],
    recent_activity: [],
    open_threads: [],
    relationship_context: '',
    signals: [],
  }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(cleaned) as Record<string, unknown>
  } catch (err) {
    logger.error({ raw: raw.slice(0, 500), err }, '[entity-brief] failed to parse LLM output as JSON')
    // Fall back to raw text as summary
    return { ...empty, summary: cleaned.slice(0, 400) || '(no summary)' }
  }

  const toStringArray = (val: unknown): string[] => {
    if (!Array.isArray(val)) return []
    return val.filter((item): item is string => typeof item === 'string')
  }

  return {
    summary: typeof parsed.summary === 'string' ? parsed.summary : '(no summary)',
    key_facts: toStringArray(parsed.key_facts),
    recent_activity: toStringArray(parsed.recent_activity),
    open_threads: toStringArray(parsed.open_threads),
    relationship_context: typeof parsed.relationship_context === 'string' ? parsed.relationship_context : '',
    signals: toStringArray(parsed.signals),
  }
}

// ============================================================
// EntityBriefSkill
// ============================================================

/**
 * EntityBriefSkill — generates an on-demand DOSSIER brief for a single entity.
 *
 * Execution flow:
 *  1. Fetch entity row (name, type) from DB.
 *  2. Fetch top-50 captures linked to the entity via FTS rank on entity name.
 *  3. Fetch related entities (1-hop via entity_relationships, top-10 by weight).
 *  4. Build prompt with SafePromptBuilder, call LLM via search_synthesis task.
 *  5. Parse JSON output → build Markdown → renderBriefHtml → insert briefs row.
 *  6. logResult → return EntityBriefResult.
 *
 * minimum_autonomy: 'observe' — informational only, always safe to generate.
 *
 * Brief insert is non-fatal: if it fails, skill still returns a valid result.
 */
export class EntityBriefSkill extends LLMSkill<EntityBriefInput, EntityBriefResult> {
  static minimum_autonomy: AutonomyLevel = 'observe'

  constructor(opts: LLMSkillOpts) {
    super('entity-brief', opts)
  }

  protected async run(input: EntityBriefInput): Promise<EntityBriefResult> {
    const startMs = Date.now()
    const { entityId } = input

    logger.info({ entityId }, '[entity-brief] starting execution')

    // ── Step 1: Fetch entity ───────────────────────────────────────────
    const entityRows = await this.db.execute<EntityRow>(
      sql`SELECT id, name, entity_type FROM entities WHERE id = ${entityId} LIMIT 1`,
    )
    const entity = entityRows.rows[0]

    if (!entity) {
      const durationMs = Date.now() - startMs
      logger.warn({ entityId }, '[entity-brief] entity not found — aborting')
      const result: EntityBriefResult = {
        entityId,
        entityName: input.entityName ?? entityId,
        captureCount: 0,
        briefId: null,
        generated: false,
        durationMs,
      }
      await this.logResult(result, `entityId:${entityId}`, 'entity not found')
      return result
    }

    const entityName = entity.name
    const entityType = entity.entity_type

    logger.info({ entityId, entityName, entityType }, '[entity-brief] entity fetched')

    // ── Step 2: Fetch top captures via FTS on entity name ─────────────
    // Joins entity_links to get captures directly linked, ordered by FTS rank.
    // Falls back to FTS content match to catch mentions without entity links.
    let captures: CaptureRow[] = []
    try {
      const captureResult = await this.db.execute<CaptureRow>(sql`
        SELECT DISTINCT c.id, c.content, c.capture_type, c.source, c.captured_at
        FROM captures c
        JOIN entity_links el ON el.capture_id = c.id
        WHERE el.entity_id = ${entityId}
          AND c.deleted_at IS NULL
          AND c.pipeline_status = 'complete'
        ORDER BY c.captured_at DESC
        LIMIT ${MAX_CAPTURES}
      `)
      captures = captureResult.rows
    } catch (err) {
      logger.warn({ err, entityId }, '[entity-brief] capture fetch failed — continuing with 0 captures')
    }

    const captureCount = captures.length
    logger.info({ entityId, captureCount }, '[entity-brief] captures fetched')

    // ── Step 3: Fetch related entities (1-hop, by weight) ─────────────
    let relatedEntities: RelatedEntityRow[] = []
    if (captureCount > 0) {
      try {
        const relatedResult = await this.db.execute<RelatedEntityRow>(sql`
          SELECT
            e.id,
            e.name,
            e.entity_type,
            er.co_occurrence_count
          FROM entity_relationships er
          JOIN entities e ON (
            CASE WHEN er.entity_id_a = ${entityId} THEN er.entity_id_b ELSE er.entity_id_a END = e.id
          )
          WHERE (er.entity_id_a = ${entityId} OR er.entity_id_b = ${entityId})
          ORDER BY er.weight DESC, er.co_occurrence_count DESC
          LIMIT ${MAX_RELATED_ENTITIES}
        `)
        relatedEntities = relatedResult.rows
      } catch (err) {
        logger.warn({ err, entityId }, '[entity-brief] related entity fetch failed — continuing without related entities')
      }
    }

    logger.info({ entityId, relatedCount: relatedEntities.length }, '[entity-brief] related entities fetched')

    // ── Step 4: Handle 0-capture case ─────────────────────────────────
    if (captureCount === 0) {
      const minimalOutput: EntityBriefOutput = {
        summary: `No captures have been recorded for ${entityName} yet. As information is captured, a dossier will be built here.`,
        key_facts: [],
        recent_activity: [],
        open_threads: [],
        relationship_context: '',
        signals: [],
      }

      const briefId = await this.writeBrief(entityName, entityType, minimalOutput, captures, null)
      const durationMs = Date.now() - startMs

      const result: EntityBriefResult = {
        entityId,
        entityName,
        captureCount: 0,
        briefId,
        generated: true,
        durationMs,
      }
      await this.logResult(
        result,
        `entityId:${entityId} entityName:${entityName}`,
        `0 captures — minimal brief inserted briefId:${briefId ?? 'null'}`,
      )
      return result
    }

    // ── Step 5: Build prompt ───────────────────────────────────────────
    const capturesBlock = captures
      .map(
        (c) =>
          `[${fmtDate(c.captured_at)}] [${c.capture_type}] ${c.content.slice(0, 500)}`,
      )
      .join('\n')

    const relatedEntitiesBlock =
      relatedEntities.length > 0
        ? relatedEntities
            .map((r) => `${r.name} (${r.entity_type}, ${r.co_occurrence_count} co-occurrences)`)
            .join(', ')
        : '(none)'

    const safeCaptures = new SafePromptBuilder().wrapContent(capturesBlock, 'captures-block')

    const prompt = this.templates.render('entity_brief_v1.txt', {
      entity_name: entityName,
      entity_type: entityType,
      capture_count: String(captureCount),
      related_entities: relatedEntitiesBlock,
      captures: safeCaptures,
    })

    logger.debug({ entityId, promptLength: prompt.length }, '[entity-brief] calling LLM')

    // ── Step 6: Call LLM ───────────────────────────────────────────────
    let rawOutput: string
    if (this.llmGateway) {
      rawOutput = await this.llmGateway.completeByTask(prompt, ENTITY_BRIEF_TASK, {
        temperature: 0.3,
        maxTokens: 2048,
      })
      logger.info('[entity-brief] LLM call complete (gateway)')
    } else {
      if (!this.litellmClient) {
        throw new Error('[entity-brief] No LLM client configured — set OPENAI_API_KEY or inject llmGateway')
      }
      const response = await this.litellmClient.chat.completions.create({
        model: 'synthesis',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_completion_tokens: 2048,
      })
      rawOutput = response.choices[0]?.message?.content ?? ''
      logger.info(
        {
          promptTokens: response.usage?.prompt_tokens,
          completionTokens: response.usage?.completion_tokens,
        },
        '[entity-brief] LLM call complete (OpenAI)',
      )
    }

    // ── Step 7: Parse + render + insert ───────────────────────────────
    const output = parseEntityBriefOutput(rawOutput)
    const skillLogId = null // written after insert so we pass null here, set after logResult

    const briefId = await this.writeBrief(entityName, entityType, output, captures, skillLogId)

    const durationMs = Date.now() - startMs

    const finalResult: EntityBriefResult = {
      entityId,
      entityName,
      captureCount,
      briefId,
      generated: briefId !== null,
      durationMs,
    }

    await this.logResult(
      finalResult,
      `entityId:${entityId} entityName:${entityName} captures:${captureCount}`,
      `summary:"${output.summary.slice(0, 80)}" keyFacts:${output.key_facts.length} openThreads:${output.open_threads.length} briefId:${briefId ?? 'null'}`,
    )

    logger.info(
      {
        entityId,
        entityName,
        captureCount,
        briefId,
        durationMs,
      },
      '[entity-brief] execution complete',
    )

    return finalResult
  }

  /**
   * Renders the LLM output to HTML and inserts a DOSSIER brief row.
   * Non-fatal — returns null on failure; skill result is not affected.
   */
  private async writeBrief(
    entityName: string,
    entityType: string,
    output: EntityBriefOutput,
    captures: CaptureRow[],
    _skillLogId: string | null,
  ): Promise<string | null> {
    try {
      const markdown = buildEntityBriefMarkdown(entityName, entityType, output)
      const { html, toc } = renderBriefHtml(markdown)

      const sources: BriefSource[] = captures
        .slice(0, 12)
        .map((c) => ({
          type: mapCaptureSourceToBriefType(c.source as Parameters<typeof mapCaptureSourceToBriefType>[0]),
          title: (c.content ?? '').slice(0, 80),
          excerpt: (c.content ?? '').slice(0, 200),
          capture_id: c.id,
        }))

      const inserted = await this.db.insert(briefs).values({
        kind: 'DOSSIER',
        cover: 'canvas',
        title: `${entityName} — Dossier`,
        subtitle: `${entityType} · ${captures.length} capture${captures.length !== 1 ? 's' : ''}`,
        body_html: html,
        toc: toc as unknown as Record<string, unknown>[],
        sources: sources as unknown as Record<string, unknown>[],
        refine_options: [...DOSSIER_REFINE_OPTIONS] as string[],
      }).returning({ id: briefs.id })

      const briefId = inserted[0]?.id ?? null
      logger.info({ briefId, entityName }, '[entity-brief] brief row inserted')
      return briefId
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), entityName },
        '[entity-brief] brief insert failed — non-fatal',
      )
      return null
    }
  }
}

// ============================================================
// Top-level entry point — called by BullMQ skill-execution worker
// ============================================================

/**
 * Execute the entity-brief skill.
 *
 * @param db          Drizzle database instance
 * @param input       Entity identification (entityId required; name/type optional hints)
 * @param llmGateway  Optional LLM gateway for task-based tier routing
 */
export async function executeEntityBrief(
  db: Database,
  input: EntityBriefInput,
  llmGateway?: LLMGatewayService,
): Promise<EntityBriefResult> {
  return new EntityBriefSkill({ db, llmGateway }).execute(input)
}
