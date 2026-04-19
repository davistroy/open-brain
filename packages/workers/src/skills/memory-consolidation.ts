import { sql } from 'drizzle-orm'
import type { Database, LLMGatewayService } from '@open-brain/shared'
import { logger } from '@open-brain/shared'
import { LLMSkill } from './llm-skill.js'
import type { LLMSkillOpts, BaseResult } from './types.js'
import {
  findConsolidationCandidates,
  type ConsolidationCluster,
  type ConsolidationQueryResult,
} from './memory-consolidation-query.js'

// ============================================================
// Types
// ============================================================

/**
 * LLM output from the memory consolidation prompt.
 */
export interface ConsolidationLLMOutput {
  should_merge: boolean
  merged_content: string
  merged_tags: string[]
  merge_rationale: string
}

/**
 * Result of processing a single cluster.
 */
export interface ClusterResult {
  clusterIndex: number
  captureIds: string[]
  avgSimilarity: number
  shouldMerge: boolean
  mergeRationale: string
  newCaptureId: string | null
  entityLinksMigrated: number
  associationsRepointed: number
  originalsDeleted: number
  error?: string
}

/**
 * Full result of the memory consolidation skill execution.
 */
export interface MemoryConsolidationResult extends BaseResult {
  queryResult: ConsolidationQueryResult
  clusterResults: ClusterResult[]
  totalMerged: number
  totalSkipped: number
  totalErrors: number
  notificationSent: boolean
}

export interface MemoryConsolidationOptions {
  /** Cosine similarity threshold for clustering. Default: 0.92. */
  similarityThreshold?: number
  /** Minimum captures in a cluster. Default: 3. */
  minClusterSize?: number
  /** Maximum clusters to process. Default: 5. */
  maxClusters?: number
}

// ============================================================
// Row types for raw SQL queries
// ============================================================

interface CaptureRow {
  [key: string]: unknown
  id: string
  content: string
  capture_type: string
  brain_view: string
  source: string
  tags: string[] | null
  created_at: string
}

// ============================================================
// MemoryConsolidationSkill
// ============================================================

/**
 * MemoryConsolidationSkill -- identifies clusters of near-duplicate captures,
 * merges them via LLM, migrates entity_links and capture_associations,
 * then soft-deletes originals.
 *
 * Follows the weekly-brief / daily-sweep skill pattern:
 * query data, call LLM, persist results, deliver notification, log to skills_log.
 */
export class MemoryConsolidationSkill extends LLMSkill<MemoryConsolidationOptions, MemoryConsolidationResult> {
  constructor(opts: LLMSkillOpts) {
    super('memory-consolidation', opts)
  }

  protected async run(options: MemoryConsolidationOptions = {}): Promise<MemoryConsolidationResult> {
    const {
      similarityThreshold,
      minClusterSize,
      maxClusters,
    } = options
    const startMs = Date.now()
    logger.info({ similarityThreshold, minClusterSize, maxClusters }, '[memory-consolidation] starting execution')

    // Step 1: Find candidate clusters
    const queryResult = await findConsolidationCandidates(this.db, {
      similarityThreshold,
      minClusterSize,
      maxClusters,
    })

    if (queryResult.clusters.length === 0) {
      logger.info('[memory-consolidation] no consolidation candidates found')
      const durationMs = Date.now() - startMs
      const emptyResult: MemoryConsolidationResult = {
        queryResult,
        clusterResults: [],
        totalMerged: 0,
        totalSkipped: 0,
        totalErrors: 0,
        durationMs,
        notificationSent: false,
      }
      await this.logResult(
        emptyResult,
        `${queryResult.totalPairsFound} pairs, ${queryResult.totalClustersFound} clusters (none met threshold)`,
        'No clusters to consolidate',
      )
      return emptyResult
    }

    logger.info(
      { clusters: queryResult.clusters.length, totalPairs: queryResult.totalPairsFound },
      '[memory-consolidation] processing clusters',
    )

    // Step 2: Process each cluster
    const clusterResults: ClusterResult[] = []
    for (let i = 0; i < queryResult.clusters.length; i++) {
      const cluster = queryResult.clusters[i]
      const result = await this.processCluster(cluster, i)
      clusterResults.push(result)
    }

    // Summarize
    const totalMerged = clusterResults.filter(r => r.shouldMerge && r.newCaptureId).length
    const totalSkipped = clusterResults.filter(r => !r.shouldMerge && !r.error).length
    const totalErrors = clusterResults.filter(r => r.error).length
    const durationMs = Date.now() - startMs

    // Step 3: Pushover notification
    const notificationSent = await this.deliverPushover(clusterResults, totalMerged, totalSkipped, totalErrors)

    // Step 4: Log to skills_log via BaseSkill
    const finalResult: MemoryConsolidationResult = {
      queryResult,
      clusterResults,
      totalMerged,
      totalSkipped,
      totalErrors,
      durationMs,
      notificationSent,
    }
    await this.logResult(
      finalResult,
      `${queryResult.totalPairsFound} pairs, ${queryResult.clusters.length} clusters processed`,
      `merged:${totalMerged} skipped:${totalSkipped} errors:${totalErrors}`,
    )

    logger.info(
      { totalMerged, totalSkipped, totalErrors, durationMs, notificationSent },
      '[memory-consolidation] execution complete',
    )

    return finalResult
  }

  // ----------------------------------------------------------
  // Private: Process a single cluster
  // ----------------------------------------------------------

  private async processCluster(
    cluster: ConsolidationCluster,
    index: number,
  ): Promise<ClusterResult> {
    const base: ClusterResult = {
      clusterIndex: index,
      captureIds: cluster.captureIds,
      avgSimilarity: cluster.avgSimilarity,
      shouldMerge: false,
      mergeRationale: '',
      newCaptureId: null,
      entityLinksMigrated: 0,
      associationsRepointed: 0,
      originalsDeleted: 0,
    }

    try {
      // Step 2a: Load full capture content
      const captureRows = await this.loadCaptures(cluster.captureIds)
      if (captureRows.length < 2) {
        base.mergeRationale = 'Too few captures loaded (some may have been deleted)'
        return base
      }

      // Step 2b: Render consolidation prompt template
      const capturesText = this.formatCapturesForPrompt(captureRows)
      // Use the most common brain_view from the cluster
      const brainView = this.mostCommonBrainView(captureRows)

      // Step 2c: Call LLM
      const llmOutput = await this.callLLM(capturesText, captureRows.length, brainView)

      // Step 2d: Parse response -- check should_merge safety valve
      base.shouldMerge = llmOutput.should_merge
      base.mergeRationale = llmOutput.merge_rationale

      if (!llmOutput.should_merge) {
        logger.info(
          { clusterIndex: index, rationale: llmOutput.merge_rationale },
          '[memory-consolidation] LLM decided not to merge cluster',
        )
        return base
      }

      // Step 2e: Create new consolidated capture via internal service call (POST to API)
      const newCaptureId = await this.createConsolidatedCapture(
        llmOutput.merged_content,
        llmOutput.merged_tags,
        brainView,
        cluster.captureIds,
      )

      if (!newCaptureId) {
        base.error = 'Failed to create consolidated capture'
        return base
      }
      base.newCaptureId = newCaptureId

      // Step 2f: Migrate entity_links from originals to new capture
      base.entityLinksMigrated = await this.migrateEntityLinks(cluster.captureIds, newCaptureId)

      // Step 2g: Re-point capture_associations to new capture ID
      base.associationsRepointed = await this.repointAssociations(cluster.captureIds, newCaptureId)

      // Step 2h: Soft-delete originals
      base.originalsDeleted = await this.softDeleteOriginals(cluster.captureIds)

      logger.info(
        {
          clusterIndex: index,
          newCaptureId,
          entityLinksMigrated: base.entityLinksMigrated,
          associationsRepointed: base.associationsRepointed,
          originalsDeleted: base.originalsDeleted,
        },
        '[memory-consolidation] cluster merged successfully',
      )

      return base
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error({ clusterIndex: index, err: msg }, '[memory-consolidation] cluster processing failed')
      base.error = msg
      return base
    }
  }

  // ----------------------------------------------------------
  // Private: Load captures by IDs
  // ----------------------------------------------------------

  private async loadCaptures(captureIds: string[]): Promise<CaptureRow[]> {
    if (captureIds.length === 0) return []

    const rows = await this.db.execute<CaptureRow>(sql`
      SELECT
        id::text,
        content,
        capture_type,
        brain_view,
        source,
        tags,
        created_at::text
      FROM captures
      WHERE id = ANY(${captureIds}::uuid[])
        AND deleted_at IS NULL
        AND pipeline_status = 'complete'
      ORDER BY created_at ASC
    `)
    return rows.rows
  }

  // ----------------------------------------------------------
  // Private: Format captures for the LLM prompt
  // ----------------------------------------------------------

  private formatCapturesForPrompt(captureRows: CaptureRow[]): string {
    return captureRows.map((c, i) => {
      const date = typeof c.created_at === 'string' ? c.created_at.split('T')[0] : 'unknown'
      const tags = c.tags?.length ? ` | Tags: ${c.tags.join(', ')}` : ''
      return `--- Capture ${i + 1} (${date}, ${c.capture_type}, ${c.source})${tags} ---\n${c.content}\n`
    }).join('\n')
  }

  // ----------------------------------------------------------
  // Private: Determine most common brain_view in a cluster
  // ----------------------------------------------------------

  private mostCommonBrainView(captureRows: CaptureRow[]): string {
    const counts = new Map<string, number>()
    for (const c of captureRows) {
      counts.set(c.brain_view, (counts.get(c.brain_view) ?? 0) + 1)
    }
    let best = captureRows[0]?.brain_view ?? 'personal'
    let bestCount = 0
    for (const [view, count] of counts) {
      if (count > bestCount) {
        best = view
        bestCount = count
      }
    }
    return best
  }

  // ----------------------------------------------------------
  // Private: Call LLM with consolidation prompt
  // ----------------------------------------------------------

  private async callLLM(
    capturesText: string,
    captureCount: number,
    brainView: string,
  ): Promise<ConsolidationLLMOutput> {
    const prompt = this.templates.render('memory_consolidation_v1.txt', {
      capture_count: String(captureCount),
      brain_view: brainView,
      captures: capturesText,
    })

    logger.debug({ promptLength: prompt.length }, '[memory-consolidation] calling LLM')

    // Prefer LLMGatewayService (task-based tier routing with audit log)
    if (this.llmGateway) {
      // TODO A71: rename task key to 'memory_consolidation' once ai-routing.yaml entry is added
      const raw = await this.llmGateway.completeByTask(prompt, 'search_synthesis', {
        temperature: 0.2,
        maxTokens: 2048,
      })
      logger.info('[memory-consolidation] LLM call complete (gateway)')
      return this.parseLLMOutput(raw)
    }

    // Test-compat fallback: OpenAI/LiteLLM client (injected in unit tests)
    if (!this.litellmClient) {
      throw new Error('[memory-consolidation] No LLM client configured — set OPENAI_API_KEY or inject llmGateway')
    }

    const synthesisModel = 'synthesis'
    const response = await this.litellmClient.chat.completions.create({
      model: synthesisModel,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
      max_completion_tokens: 2048,
    })

    const text = response.choices[0]?.message?.content ?? ''
    logger.info(
      { promptTokens: response.usage?.prompt_tokens, completionTokens: response.usage?.completion_tokens },
      '[memory-consolidation] LLM call complete (OpenAI)',
    )

    return this.parseLLMOutput(text)
  }

  // ----------------------------------------------------------
  // Private: Parse LLM JSON output
  // ----------------------------------------------------------

  private parseLLMOutput(raw: string): ConsolidationLLMOutput {
    let cleaned = raw.trim()
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
    }

    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(cleaned)
    } catch (err) {
      logger.error({ raw: raw.slice(0, 500), err }, '[memory-consolidation] failed to parse LLM output as JSON')
      // Safety: if we can't parse, don't merge
      return {
        should_merge: false,
        merged_content: '',
        merged_tags: [],
        merge_rationale: `LLM output not valid JSON: ${(err as Error).message}`,
      }
    }

    return {
      should_merge: parsed.should_merge === true,
      merged_content: typeof parsed.merged_content === 'string' ? parsed.merged_content : '',
      merged_tags: Array.isArray(parsed.merged_tags)
        ? (parsed.merged_tags as unknown[]).filter((t): t is string => typeof t === 'string')
        : [],
      merge_rationale: typeof parsed.merge_rationale === 'string' ? parsed.merge_rationale : '(no rationale)',
    }
  }

  // ----------------------------------------------------------
  // Private: Create consolidated capture via POST to API
  // ----------------------------------------------------------

  private async createConsolidatedCapture(
    content: string,
    tags: string[],
    brainView: string,
    originalIds: string[],
  ): Promise<string | null> {
    try {
      const res = await fetch(`${this.coreApiUrl}/api/v1/captures`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content,
          capture_type: 'reflection',
          brain_view: brainView,
          source: 'consolidation',
          tags: [...new Set([...tags, 'consolidated'])],
          metadata: {
            source_metadata: {
              generator: 'memory-consolidation-skill',
              original_capture_ids: originalIds,
              consolidated_at: new Date().toISOString(),
            },
          },
        }),
        signal: AbortSignal.timeout(15_000),
      })

      if (!res.ok) {
        const body = await res.text().catch(() => '')
        logger.warn({ status: res.status, body: body.slice(0, 200) }, '[memory-consolidation] failed to create consolidated capture')
        return null
      }

      const data = (await res.json()) as { id?: string; data?: { id?: string } }
      return data.id ?? data.data?.id ?? null
    } catch (err) {
      logger.warn({ err }, '[memory-consolidation] error creating consolidated capture')
      return null
    }
  }

  // ----------------------------------------------------------
  // Private: Migrate entity_links from originals to new capture
  // ----------------------------------------------------------

  /**
   * Copy entity_links from original captures to the new consolidated capture.
   * Uses INSERT ... ON CONFLICT DO NOTHING to handle the unique(entity_id, capture_id) constraint.
   * Returns the number of links migrated.
   */
  private async migrateEntityLinks(originalIds: string[], newCaptureId: string): Promise<number> {
    try {
      const result = await this.db.execute<{ migrated: string }>(sql`
        WITH inserted AS (
          INSERT INTO entity_links (entity_id, capture_id, relationship, confidence)
          SELECT DISTINCT ON (entity_id)
            entity_id,
            ${newCaptureId}::uuid,
            relationship,
            confidence
          FROM entity_links
          WHERE capture_id = ANY(${originalIds}::uuid[])
          ORDER BY entity_id, confidence DESC NULLS LAST
          ON CONFLICT (entity_id, capture_id) DO NOTHING
          RETURNING id
        )
        SELECT COUNT(*)::text AS migrated FROM inserted
      `)
      const count = Number(result.rows[0]?.migrated ?? 0)
      logger.debug({ count, newCaptureId }, '[memory-consolidation] entity links migrated')
      return count
    } catch (err) {
      logger.warn({ err, newCaptureId }, '[memory-consolidation] failed to migrate entity links')
      return 0
    }
  }

  // ----------------------------------------------------------
  // Private: Re-point capture_associations to new capture
  // ----------------------------------------------------------

  /**
   * Re-point capture_associations that reference any original capture to reference
   * the new consolidated capture instead. Handles canonical ordering (a < b)
   * and merges weights on conflict.
   */
  private async repointAssociations(originalIds: string[], newCaptureId: string): Promise<number> {
    try {
      // We need to update associations in two passes:
      // 1. Associations where an original ID is in capture_id_a
      // 2. Associations where an original ID is in capture_id_b
      // After updating, we enforce canonical ordering (a < b) and merge on conflict.

      // Delete any self-referencing associations that would result from re-pointing
      // (e.g., if both captures in a pair are being consolidated)
      await this.db.execute(sql`
        DELETE FROM capture_associations
        WHERE (capture_id_a = ANY(${originalIds}::uuid[]) AND capture_id_b = ANY(${originalIds}::uuid[]))
      `)

      // Re-point capture_id_a references
      const resultA = await this.db.execute<{ updated: string }>(sql`
        WITH to_update AS (
          SELECT id,
            CASE WHEN ${newCaptureId}::uuid < capture_id_b THEN ${newCaptureId}::uuid ELSE capture_id_b END AS new_a,
            CASE WHEN ${newCaptureId}::uuid < capture_id_b THEN capture_id_b ELSE ${newCaptureId}::uuid END AS new_b,
            co_access_count,
            weight,
            last_co_access
          FROM capture_associations
          WHERE capture_id_a = ANY(${originalIds}::uuid[])
            AND capture_id_b != ${newCaptureId}::uuid
            AND capture_id_b != ALL(${originalIds}::uuid[])
        ),
        deleted AS (
          DELETE FROM capture_associations
          WHERE id IN (SELECT id FROM to_update)
          RETURNING id
        ),
        inserted AS (
          INSERT INTO capture_associations (capture_id_a, capture_id_b, co_access_count, weight, last_co_access)
          SELECT new_a, new_b, co_access_count, weight, last_co_access
          FROM to_update
          ON CONFLICT (capture_id_a, capture_id_b) DO UPDATE SET
            co_access_count = capture_associations.co_access_count + EXCLUDED.co_access_count,
            weight = GREATEST(capture_associations.weight, EXCLUDED.weight),
            last_co_access = GREATEST(capture_associations.last_co_access, EXCLUDED.last_co_access)
          RETURNING id
        )
        SELECT COUNT(*)::text AS updated FROM inserted
      `)

      // Re-point capture_id_b references
      const resultB = await this.db.execute<{ updated: string }>(sql`
        WITH to_update AS (
          SELECT id,
            CASE WHEN capture_id_a < ${newCaptureId}::uuid THEN capture_id_a ELSE ${newCaptureId}::uuid END AS new_a,
            CASE WHEN capture_id_a < ${newCaptureId}::uuid THEN ${newCaptureId}::uuid ELSE capture_id_a END AS new_b,
            co_access_count,
            weight,
            last_co_access
          FROM capture_associations
          WHERE capture_id_b = ANY(${originalIds}::uuid[])
            AND capture_id_a != ${newCaptureId}::uuid
            AND capture_id_a != ALL(${originalIds}::uuid[])
        ),
        deleted AS (
          DELETE FROM capture_associations
          WHERE id IN (SELECT id FROM to_update)
          RETURNING id
        ),
        inserted AS (
          INSERT INTO capture_associations (capture_id_a, capture_id_b, co_access_count, weight, last_co_access)
          SELECT new_a, new_b, co_access_count, weight, last_co_access
          FROM to_update
          ON CONFLICT (capture_id_a, capture_id_b) DO UPDATE SET
            co_access_count = capture_associations.co_access_count + EXCLUDED.co_access_count,
            weight = GREATEST(capture_associations.weight, EXCLUDED.weight),
            last_co_access = GREATEST(capture_associations.last_co_access, EXCLUDED.last_co_access)
          RETURNING id
        )
        SELECT COUNT(*)::text AS updated FROM inserted
      `)

      const countA = Number(resultA.rows[0]?.updated ?? 0)
      const countB = Number(resultB.rows[0]?.updated ?? 0)
      const total = countA + countB
      logger.debug({ countA, countB, total, newCaptureId }, '[memory-consolidation] associations repointed')
      return total
    } catch (err) {
      logger.warn({ err, newCaptureId }, '[memory-consolidation] failed to repoint associations')
      return 0
    }
  }

  // ----------------------------------------------------------
  // Private: Soft-delete originals
  // ----------------------------------------------------------

  private async softDeleteOriginals(captureIds: string[]): Promise<number> {
    try {
      const now = new Date()
      const result = await this.db.execute<{ deleted: string }>(sql`
        WITH updated AS (
          UPDATE captures
          SET deleted_at = ${now.toISOString()}::timestamptz,
              updated_at = ${now.toISOString()}::timestamptz
          WHERE id = ANY(${captureIds}::uuid[])
            AND deleted_at IS NULL
          RETURNING id
        )
        SELECT COUNT(*)::text AS deleted FROM updated
      `)
      const count = Number(result.rows[0]?.deleted ?? 0)
      logger.debug({ count }, '[memory-consolidation] originals soft-deleted')
      return count
    } catch (err) {
      logger.warn({ err }, '[memory-consolidation] failed to soft-delete originals')
      return 0
    }
  }

  // ----------------------------------------------------------
  // Private: Pushover notification
  // ----------------------------------------------------------

  private async deliverPushover(
    clusterResults: ClusterResult[],
    totalMerged: number,
    totalSkipped: number,
    totalErrors: number,
  ): Promise<boolean> {
    if (!this.pushover.isConfigured) return false

    const lines: string[] = [`Memory Consolidation: ${totalMerged} merged, ${totalSkipped} skipped, ${totalErrors} errors`]

    for (const r of clusterResults) {
      if (r.shouldMerge && r.newCaptureId) {
        lines.push(`  Cluster ${r.clusterIndex + 1}: ${r.captureIds.length} captures merged (${r.entityLinksMigrated} links, ${r.associationsRepointed} assoc)`)
      } else if (r.error) {
        lines.push(`  Cluster ${r.clusterIndex + 1}: ERROR - ${r.error.slice(0, 80)}`)
      } else {
        lines.push(`  Cluster ${r.clusterIndex + 1}: skipped - ${r.mergeRationale.slice(0, 80)}`)
      }
    }

    try {
      await this.pushover.send({
        title: 'Memory Consolidation',
        message: lines.join('\n'),
        priority: 0,
      })
      return true
    } catch {
      return false
    }
  }

}

// ============================================================
// Top-level entry point -- called by BullMQ worker dispatcher
// ============================================================

/** Top-level entry point called by BullMQ worker. */
export async function executeMemoryConsolidation(
  db: Database,
  options: MemoryConsolidationOptions = {},
  llmGateway?: LLMGatewayService,
): Promise<MemoryConsolidationResult> {
  return new MemoryConsolidationSkill({ db, llmGateway }).execute(options)
}
