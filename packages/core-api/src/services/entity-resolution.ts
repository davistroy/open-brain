import { eq, sql } from 'drizzle-orm'
import { entities, entity_links } from '@open-brain/shared'
import { NotFoundError } from '@open-brain/shared'
import type { Database } from '@open-brain/shared'
import type { LLMGatewayService } from './llm-gateway.js'
import { logger } from '../lib/logger.js'

/** Return value from resolve() describing what happened. */
export type ResolveOutcome = 'exact_match' | 'alias_match' | 'llm_match' | 'created'

export interface ResolveResult {
  entity_id: string
  outcome: ResolveOutcome
  confidence?: number
}

interface EntityRow {
  id: string
  name: string
  entity_type: string
  canonical_name: string
  aliases: string[]
}

/**
 * EntityResolutionService — three-tier entity matching.
 *
 * Tier 1 — Exact match: case-insensitive name = mention.
 * Tier 2 — Alias match: mention appears in aliases array.
 * Tier 3 — LLM disambiguation: prompt with top candidates → confidence score.
 *           confidence >= 0.8 → link to candidate; < 0.8 → create new entity.
 * No candidates at all → INSERT new entity.
 *
 * merge(sourceId, targetId): Move all entity_links from source to target,
 *   merge aliases, delete source entity.
 * split(entityId, alias): Create new entity from alias, move matching
 *   entity_links where the link was for captures that mention only that alias.
 */
export class EntityResolutionService {
  constructor(
    private db: Database,
    private llm?: LLMGatewayService,
  ) {}

  /**
   * Resolve a mention string to an entity, creating one if needed.
   *
   * @param mention   The name/string extracted from the capture (e.g. "Tom Smith")
   * @param entityType  Suggested type for new entities (default: 'person')
   * @param context   Optional surrounding text — used in LLM disambiguation
   */
  async resolve(
    mention: string,
    entityType = 'person',
    context?: string,
  ): Promise<ResolveResult> {
    const mentionLower = mention.trim().toLowerCase()

    // ----------------------------------------------------------------
    // Tier 1: exact name match (case-insensitive)
    // ----------------------------------------------------------------
    const exactRows = await this.db.execute<EntityRow>(
      sql`SELECT id::text, name, entity_type, canonical_name, aliases
          FROM entities
          WHERE lower(name) = ${mentionLower}
          LIMIT 1`,
    )

    if (exactRows.rows.length > 0) {
      logger.debug({ mention, entityId: exactRows.rows[0].id }, '[entity-resolution] exact match')
      return { entity_id: exactRows.rows[0].id, outcome: 'exact_match', confidence: 1.0 }
    }

    // ----------------------------------------------------------------
    // Tier 2: alias match — mention is contained in any entity's aliases array
    // ----------------------------------------------------------------
    const aliasRows = await this.db.execute<EntityRow>(
      sql`SELECT id::text, name, entity_type, canonical_name, aliases
          FROM entities
          WHERE lower(${mentionLower}) = ANY(SELECT lower(a) FROM unnest(aliases) AS a)
          LIMIT 1`,
    )

    if (aliasRows.rows.length > 0) {
      logger.debug({ mention, entityId: aliasRows.rows[0].id }, '[entity-resolution] alias match')
      return { entity_id: aliasRows.rows[0].id, outcome: 'alias_match', confidence: 0.95 }
    }

    // ----------------------------------------------------------------
    // Tier 3: LLM disambiguation — find candidates with similar names
    // ----------------------------------------------------------------
    const candidateRows = await this.db.execute<EntityRow>(
      sql`SELECT id::text, name, entity_type, canonical_name, aliases
          FROM entities
          WHERE entity_type = ${entityType}
          ORDER BY similarity(lower(name), ${mentionLower}) DESC
          LIMIT 5`,
    )

    if (candidateRows.rows.length > 0 && this.llm) {
      const candidates = candidateRows.rows
        .map((r, i) => `${i + 1}. "${r.name}" (aliases: ${r.aliases.join(', ') || 'none'})`)
        .join('\n')

      const contextBlock = context ? `\nContext: "${context}"` : ''
      const prompt = `You are an entity resolution assistant. Determine if the mention "${mention}" refers to one of the existing entities below, or is a new distinct entity.${contextBlock}

Existing entities:
${candidates}

Reply with ONLY valid JSON in this exact format:
{"match_index": <1-5 or null>, "confidence": <0.0-1.0>, "reasoning": "<one sentence>"}

Use match_index null if none of the entities match or confidence < 0.8.`

      try {
        const raw = await this.llm.complete(prompt, 'fast', { temperature: 0.0, maxTokens: 200 })
        const parsed = this.parseLLMResponse(raw)

        if (
          parsed !== null &&
          parsed.match_index !== null &&
          parsed.match_index >= 1 &&
          parsed.match_index <= candidates.length &&
          parsed.confidence >= 0.8
        ) {
          const matched = candidateRows.rows[parsed.match_index - 1]
          logger.debug(
            { mention, entityId: matched.id, confidence: parsed.confidence },
            '[entity-resolution] llm match',
          )
          return { entity_id: matched.id, outcome: 'llm_match', confidence: parsed.confidence }
        }

        logger.debug(
          { mention, confidence: parsed?.confidence },
          '[entity-resolution] llm rejected — creating new entity',
        )
      } catch (err) {
        // LLM failure is non-fatal — fall through to create new entity
        logger.warn({ mention, err }, '[entity-resolution] llm disambiguation failed, creating new entity')
      }
    }

    // ----------------------------------------------------------------
    // No confident match found — create new entity
    // ----------------------------------------------------------------
    return this.createEntity(mention, entityType)
  }

  /**
   * Merge source entity into target: move all entity_links, merge aliases, delete source.
   */
  async merge(sourceId: string, targetId: string): Promise<void> {
    // Verify both exist
    const [sourceRows, targetRows] = await Promise.all([
      this.db.execute<{ id: string; aliases: string[]; name: string }>(
        sql`SELECT id::text, aliases, name FROM entities WHERE id = ${sourceId}::uuid LIMIT 1`,
      ),
      this.db.execute<{ id: string; aliases: string[]; name: string }>(
        sql`SELECT id::text, aliases, name FROM entities WHERE id = ${targetId}::uuid LIMIT 1`,
      ),
    ])

    if (sourceRows.rows.length === 0) throw new NotFoundError(`Source entity not found: ${sourceId}`)
    if (targetRows.rows.length === 0) throw new NotFoundError(`Target entity not found: ${targetId}`)

    const source = sourceRows.rows[0]
    const target = targetRows.rows[0]

    // Move entity_links from source to target (skip if duplicate — unique constraint on entity_id+capture_id)
    await this.db.execute(
      sql`INSERT INTO entity_links (entity_id, capture_id, relationship, confidence, created_at)
          SELECT ${targetId}::uuid, capture_id, relationship, confidence, created_at
          FROM entity_links
          WHERE entity_id = ${sourceId}::uuid
          ON CONFLICT (entity_id, capture_id) DO NOTHING`,
    )

    // Merge aliases: add source name + source aliases to target
    const mergedAliases = Array.from(
      new Set([...(target.aliases ?? []), source.name, ...(source.aliases ?? [])]),
    ).filter(a => a.toLowerCase() !== target.name.toLowerCase())

    await this.db.execute(
      sql`UPDATE entities
          SET aliases = ${mergedAliases}::text[],
              updated_at = now()
          WHERE id = ${targetId}::uuid`,
    )

    // Delete source entity (entity_links cascade via FK onDelete: cascade)
    await this.db.execute(
      sql`DELETE FROM entities WHERE id = ${sourceId}::uuid`,
    )

    logger.info({ sourceId, targetId }, '[entity-resolution] merge complete')
  }

  /**
   * Split an alias out of an entity into a new independent entity.
   * Creates a new entity with the alias as its name.
   * Does NOT move entity_links — the new entity starts fresh.
   * (Manual curation via Slack commands covers reassigning links.)
   */
  async split(entityId: string, alias: string): Promise<{ new_entity_id: string }> {
    const existingRows = await this.db.execute<EntityRow>(
      sql`SELECT id::text, name, entity_type, canonical_name, aliases FROM entities WHERE id = ${entityId}::uuid LIMIT 1`,
    )

    if (existingRows.rows.length === 0) throw new NotFoundError(`Entity not found: ${entityId}`)

    const existing = existingRows.rows[0]
    const aliasLower = alias.trim().toLowerCase()

    // Remove alias from source entity's aliases array
    const updatedAliases = (existing.aliases ?? []).filter(
      a => a.toLowerCase() !== aliasLower,
    )

    await this.db.execute(
      sql`UPDATE entities
          SET aliases = ${updatedAliases}::text[],
              updated_at = now()
          WHERE id = ${entityId}::uuid`,
    )

    // Create new entity for the alias
    const result = await this.createEntity(alias.trim(), existing.entity_type)

    logger.info(
      { entityId, alias, newEntityId: result.entity_id },
      '[entity-resolution] split complete',
    )

    return { new_entity_id: result.entity_id }
  }

  // ----------------------------------------------------------------
  // Private helpers
  // ----------------------------------------------------------------

  private async createEntity(name: string, entityType: string): Promise<ResolveResult> {
    const [inserted] = await this.db
      .insert(entities)
      .values({
        name: name.trim(),
        entity_type: entityType,
        canonical_name: name.trim().toLowerCase(),
        aliases: [],
      })
      .returning({ id: entities.id })

    logger.debug({ name, entityType, entityId: inserted.id }, '[entity-resolution] created new entity')
    return { entity_id: inserted.id, outcome: 'created' }
  }

  private parseLLMResponse(raw: string): { match_index: number | null; confidence: number } | null {
    try {
      // Extract JSON block — LLM may add surrounding text
      const match = raw.match(/\{[^}]+\}/)
      if (!match) return null
      const parsed = JSON.parse(match[0]) as { match_index?: number | null; confidence?: number }
      return {
        match_index: parsed.match_index ?? null,
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
      }
    } catch {
      return null
    }
  }
}
