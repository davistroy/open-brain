/**
 * SystemHealthService — aggregates operational health metrics.
 *
 * Collects: BullMQ queue stats (per-queue waiting/active/failed counts),
 * Redis memory usage, ai_audit_log monthly LLM spend, skills_log last
 * run per skill, and derives an overall system status.
 *
 * Thresholds (from PRD-V2 F6.3):
 *   queue depth >50 = warning, >200 = critical
 *   non-Claude spend >$7 = warning, >$10 = critical
 *   Redis memory >80% = warning, >95% = critical
 */

import { Queue } from 'bullmq'
import type { ConnectionOptions } from 'bullmq'
import { Redis } from 'ioredis'
import { sql } from 'drizzle-orm'
import type { Database, WikiRepoStatus } from '@open-brain/shared'
import { logger } from '@open-brain/shared'

/** Minimal interface for wiki status reporting. Satisfied by both WikiService and WikiGitService. */
interface WikiStatusProvider {
  getStatus(): Promise<WikiRepoStatus>
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HealthLevel = 'healthy' | 'degraded' | 'unhealthy'

export interface QueueStats {
  name: string
  waiting: number
  active: number
  failed: number
  delayed: number
  status: HealthLevel
}

export interface RedisMemory {
  used_bytes: number
  max_bytes: number
  used_pct: number
  status: HealthLevel
}

export interface MonthlySpend {
  month: string           // YYYY-MM
  total_usd: number
  non_claude_usd: number  // cost from litellm client (non-subscription)
  status: HealthLevel
}

export interface SkillLastRun {
  skill_name: string
  last_run_at: string
  duration_ms: number | null
  output_summary: string | null
}

export interface WikiHealthStatus {
  configured: boolean
  status: HealthLevel
  repo_url: string | null
  page_count: number
  last_commit_date: string | null
  last_commit_message: string | null
  error: string | null
}

export interface ContainerHealthEntry {
  id: string
  timestamp: string
  container_name: string
  healthy: boolean
  response_ms: number | null
  error: string | null
}

export interface BackupLogEntry {
  id: string
  timestamp: string
  backup_type: string
  file_path: string | null
  size_bytes: number | null
  duration_seconds: number | null
  status: string
  error: string | null
  pruned_count: number
}

export interface CostSummary {
  month: string
  total_usd: number
  by_model: Array<{ model: string; cost_usd: number; call_count: number }>
}

export interface InfrastructureData {
  container_health: ContainerHealthEntry[]
  backups: BackupLogEntry[]
  cost: CostSummary
}

export interface PipelineFlowEntry {
  capture_id: string
  trace_id: string | null
  pipeline_status: string
  created_at: string
  stages: Array<{
    stage: string
    status: string
    duration_ms: number | null
    error: string | null
    created_at: string | null
  }>
}

export interface SystemHealthSnapshot {
  status: HealthLevel
  timestamp: string
  uptime_s: number
  queues: QueueStats[]
  redis_memory: RedisMemory
  monthly_spend: MonthlySpend
  skill_last_runs: SkillLastRun[]
  wiki: WikiHealthStatus
}

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

export const QUEUE_DEPTH_WARNING = 50
export const QUEUE_DEPTH_CRITICAL = 200

export const SPEND_WARNING = 7    // $7/month non-Claude
export const SPEND_CRITICAL = 10  // $10/month non-Claude

export const REDIS_MEM_WARNING = 0.80   // 80%
export const REDIS_MEM_CRITICAL = 0.95  // 95%

// ---------------------------------------------------------------------------
// Queue names monitored (same list as pipeline-health skill)
// ---------------------------------------------------------------------------

export const MONITORED_QUEUES = [
  'capture-pipeline',
  'embed-capture',
  'extract-entities',
  'check-triggers',
  'skill-execution',
  'document-pipeline',
  'daily-sweep',
  'ingest-root',
  'wiki-ingest',
] as const

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class SystemHealthService {
  constructor(
    private readonly db: Database,
    private readonly redisConnection: ConnectionOptions,
    private readonly redisUrl: string,
    private readonly wikiService?: WikiStatusProvider,
  ) {}

  // ---- Public API ----

  async snapshot(): Promise<SystemHealthSnapshot> {
    const [queues, redisMemory, monthlySpend, skillLastRuns, wiki] = await Promise.all([
      this.getQueueStats(),
      this.getRedisMemory(),
      this.getMonthlySpend(),
      this.getSkillLastRuns(),
      this.getWikiHealth(),
    ])

    const componentStatuses = [
      ...queues.map(q => q.status),
      redisMemory.status,
      monthlySpend.status,
    ]

    // Only include wiki status in overall health when configured
    if (wiki.configured) {
      componentStatuses.push(wiki.status)
    }

    const status = deriveOverallStatus(componentStatuses)

    return {
      status,
      timestamp: new Date().toISOString(),
      uptime_s: Math.floor(process.uptime()),
      queues,
      redis_memory: redisMemory,
      monthly_spend: monthlySpend,
      skill_last_runs: skillLastRuns,
      wiki,
    }
  }

  // ---- BullMQ queue stats ----

  async getQueueStats(): Promise<QueueStats[]> {
    const results: QueueStats[] = []

    for (const name of MONITORED_QUEUES) {
      let queue: Queue | null = null
      try {
        queue = new Queue(name, { connection: this.redisConnection })
        const counts = await queue.getJobCounts('waiting', 'active', 'failed', 'delayed')
        const depth = counts.waiting + counts.active
        results.push({
          name,
          waiting: counts.waiting,
          active: counts.active,
          failed: counts.failed,
          delayed: counts.delayed,
          status: depth > QUEUE_DEPTH_CRITICAL ? 'unhealthy'
            : depth > QUEUE_DEPTH_WARNING ? 'degraded'
            : 'healthy',
        })
      } catch (err) {
        logger.warn({ err, queue: name }, 'Failed to fetch queue stats')
        results.push({
          name,
          waiting: 0,
          active: 0,
          failed: 0,
          delayed: 0,
          status: 'degraded',
        })
      } finally {
        if (queue) await queue.close().catch(() => {})
      }
    }

    return results
  }

  // ---- Redis memory ----

  async getRedisMemory(): Promise<RedisMemory> {
    const redis = new Redis(this.redisUrl, { lazyConnect: true, connectTimeout: 3000 })
    try {
      await redis.connect()
      const info = await redis.info('memory')

      const usedMatch = info.match(/used_memory:(\d+)/)
      const maxMatch = info.match(/maxmemory:(\d+)/)

      const used = usedMatch ? parseInt(usedMatch[1], 10) : 0
      const max = maxMatch ? parseInt(maxMatch[1], 10) : 0

      // maxmemory = 0 means no limit configured
      const pct = max > 0 ? used / max : 0
      const status: HealthLevel = max === 0 ? 'healthy'
        : pct > REDIS_MEM_CRITICAL ? 'unhealthy'
        : pct > REDIS_MEM_WARNING ? 'degraded'
        : 'healthy'

      return { used_bytes: used, max_bytes: max, used_pct: Math.round(pct * 10000) / 10000, status }
    } catch (err) {
      logger.warn({ err }, 'Failed to fetch Redis memory info')
      return { used_bytes: 0, max_bytes: 0, used_pct: 0, status: 'degraded' }
    } finally {
      redis.disconnect()
    }
  }

  // ---- Monthly LLM spend ----

  async getMonthlySpend(): Promise<MonthlySpend> {
    const now = new Date()
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
    try {
      const rows = await this.db.execute<{
        total_usd: string | null
        non_claude_usd: string | null
      }>(sql`
        SELECT
          COALESCE(SUM(cost_usd), 0) AS total_usd,
          COALESCE(SUM(CASE WHEN client_used != 'anthropic' THEN cost_usd ELSE 0 END), 0) AS non_claude_usd
        FROM ai_audit_log
        WHERE created_at >= date_trunc('month', CURRENT_DATE)
      `)

      const row = rows.rows[0]
      const totalUsd = row ? parseFloat(String(row.total_usd)) : 0
      const nonClaudeUsd = row ? parseFloat(String(row.non_claude_usd)) : 0
      const status: HealthLevel = nonClaudeUsd > SPEND_CRITICAL ? 'unhealthy'
        : nonClaudeUsd > SPEND_WARNING ? 'degraded'
        : 'healthy'

      return { month, total_usd: totalUsd, non_claude_usd: nonClaudeUsd, status }
    } catch (err) {
      logger.warn({ err }, 'Failed to fetch monthly spend')
      return { month, total_usd: 0, non_claude_usd: 0, status: 'degraded' }
    }
  }

  // ---- Skills log last runs ----

  async getSkillLastRuns(): Promise<SkillLastRun[]> {
    try {
      const rows = await this.db.execute<{
        skill_name: string
        last_run_at: string
        duration_ms: number | null
        output_summary: string | null
      }>(sql`
        SELECT DISTINCT ON (skill_name)
          skill_name,
          created_at AS last_run_at,
          duration_ms,
          output_summary
        FROM skills_log
        ORDER BY skill_name, created_at DESC
      `)
      return rows.rows
    } catch (err) {
      logger.warn({ err }, 'Failed to fetch skill last runs')
      return []
    }
  }
  // ---- Infrastructure data (container health, backups, cost) ----

  async getInfrastructureData(): Promise<InfrastructureData> {
    const [containerHealth, backups, cost] = await Promise.all([
      this.getContainerHealth(),
      this.getBackupLog(),
      this.getCostSummary(),
    ])
    return { container_health: containerHealth, backups, cost }
  }

  async getContainerHealth(): Promise<ContainerHealthEntry[]> {
    try {
      const rows = await this.db.execute<{
        id: string
        timestamp: string
        container_name: string
        healthy: boolean
        response_ms: number | null
        error: string | null
      }>(sql`
        SELECT id, timestamp, container_name, healthy, response_ms, error
        FROM container_health
        ORDER BY timestamp DESC
        LIMIT 100
      `)
      return rows.rows
    } catch (err) {
      logger.warn({ err }, 'Failed to fetch container health data')
      return []
    }
  }

  async getBackupLog(): Promise<BackupLogEntry[]> {
    try {
      const rows = await this.db.execute<{
        id: string
        timestamp: string
        backup_type: string
        file_path: string | null
        size_bytes: string | null
        duration_seconds: number | null
        status: string
        error: string | null
        pruned_count: number
      }>(sql`
        SELECT id, timestamp, backup_type, file_path, size_bytes, duration_seconds, status, error, pruned_count
        FROM backup_log
        ORDER BY timestamp DESC
        LIMIT 50
      `)
      return rows.rows.map(r => ({
        ...r,
        size_bytes: r.size_bytes ? parseInt(String(r.size_bytes), 10) : null,
      }))
    } catch (err) {
      logger.warn({ err }, 'Failed to fetch backup log')
      return []
    }
  }

  async getCostSummary(): Promise<CostSummary> {
    const now = new Date()
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
    try {
      const rows = await this.db.execute<{
        model: string
        cost_usd: string
        call_count: string
      }>(sql`
        SELECT
          model_used AS model,
          COALESCE(SUM(cost_usd), 0) AS cost_usd,
          COUNT(*) AS call_count
        FROM ai_audit_log
        WHERE created_at >= date_trunc('month', CURRENT_DATE)
        GROUP BY model_used
        ORDER BY SUM(cost_usd) DESC
      `)
      const byModel = rows.rows.map(r => ({
        model: r.model ?? 'unknown',
        cost_usd: parseFloat(String(r.cost_usd)),
        call_count: parseInt(String(r.call_count), 10),
      }))
      const totalUsd = byModel.reduce((sum, m) => sum + m.cost_usd, 0)
      return { month, total_usd: totalUsd, by_model: byModel }
    } catch (err) {
      logger.warn({ err }, 'Failed to fetch cost summary')
      return { month, total_usd: 0, by_model: [] }
    }
  }

  // ---- Pipeline flows (recent captures with pipeline stages) ----

  async getPipelineFlows(limit = 20): Promise<PipelineFlowEntry[]> {
    try {
      const rows = await this.db.execute<{
        id: string
        pipeline_status: string
        created_at: string
        source_metadata: Record<string, unknown> | null
      }>(sql`
        SELECT id, pipeline_status, created_at, source_metadata
        FROM captures
        WHERE pipeline_status IN ('processing', 'pending', 'partial', 'complete', 'failed')
        ORDER BY created_at DESC
        LIMIT ${limit}
      `)

      const captureIds = rows.rows.map(r => r.id)
      if (captureIds.length === 0) return []

      // Postgres array literal — same pattern as search.ts getHebbianBoosts()
      const pgCaptureIds = `{${captureIds.join(',')}}`

      // Fetch pipeline_events for these captures
      const events = await this.db.execute<{
        capture_id: string
        stage: string
        status: string
        duration_ms: number | null
        error: string | null
        created_at: string | null
      }>(sql`
        SELECT capture_id, stage, status, duration_ms, error, created_at
        FROM pipeline_events
        WHERE capture_id = ANY(${pgCaptureIds}::uuid[])
        ORDER BY created_at ASC
      `)

      // Group events by capture_id
      const eventMap = new Map<string, PipelineFlowEntry['stages']>()
      for (const e of events.rows) {
        if (!eventMap.has(e.capture_id)) eventMap.set(e.capture_id, [])
        eventMap.get(e.capture_id)!.push({
          stage: e.stage,
          status: e.status,
          duration_ms: e.duration_ms,
          error: e.error,
          created_at: e.created_at,
        })
      }

      return rows.rows.map(r => ({
        capture_id: r.id,
        trace_id: r.source_metadata?.trace_id as string | null ?? null,
        pipeline_status: r.pipeline_status,
        created_at: r.created_at,
        stages: eventMap.get(r.id) ?? [],
      }))
    } catch (err) {
      logger.warn({ err }, 'Failed to fetch pipeline flows')
      return []
    }
  }

  // ---- Wiki health ----

  async getWikiHealth(): Promise<WikiHealthStatus> {
    if (!this.wikiService) {
      return {
        configured: false,
        status: 'healthy', // Not configured is not unhealthy
        repo_url: null,
        page_count: 0,
        last_commit_date: null,
        last_commit_message: null,
        error: null,
      }
    }

    try {
      const repoStatus = await this.wikiService.getStatus()
      const status: HealthLevel = !repoStatus.initialized ? 'unhealthy'
        : repoStatus.error ? 'degraded'
        : 'healthy'

      return {
        configured: true,
        status,
        repo_url: repoStatus.repoUrl,
        page_count: repoStatus.pageCount,
        last_commit_date: repoStatus.lastCommitDate,
        last_commit_message: repoStatus.lastCommitMessage,
        error: repoStatus.error,
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to fetch wiki health status')
      return {
        configured: true,
        status: 'degraded',
        repo_url: null,
        page_count: 0,
        last_commit_date: null,
        last_commit_message: null,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deriveOverallStatus(statuses: HealthLevel[]): HealthLevel {
  if (statuses.some(s => s === 'unhealthy')) return 'unhealthy'
  if (statuses.some(s => s === 'degraded')) return 'degraded'
  return 'healthy'
}
