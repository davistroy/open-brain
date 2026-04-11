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
import type { Database } from '@open-brain/shared'
import { logger } from '@open-brain/shared'

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

export interface SystemHealthSnapshot {
  status: HealthLevel
  timestamp: string
  uptime_s: number
  queues: QueueStats[]
  redis_memory: RedisMemory
  monthly_spend: MonthlySpend
  skill_last_runs: SkillLastRun[]
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
] as const

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class SystemHealthService {
  constructor(
    private readonly db: Database,
    private readonly redisConnection: ConnectionOptions,
    private readonly redisUrl: string,
  ) {}

  // ---- Public API ----

  async snapshot(): Promise<SystemHealthSnapshot> {
    const [queues, redisMemory, monthlySpend, skillLastRuns] = await Promise.all([
      this.getQueueStats(),
      this.getRedisMemory(),
      this.getMonthlySpend(),
      this.getSkillLastRuns(),
    ])

    const componentStatuses = [
      ...queues.map(q => q.status),
      redisMemory.status,
      monthlySpend.status,
    ]

    const status = deriveOverallStatus(componentStatuses)

    return {
      status,
      timestamp: new Date().toISOString(),
      uptime_s: Math.floor(process.uptime()),
      queues,
      redis_memory: redisMemory,
      monthly_spend: monthlySpend,
      skill_last_runs: skillLastRuns,
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
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deriveOverallStatus(statuses: HealthLevel[]): HealthLevel {
  if (statuses.some(s => s === 'unhealthy')) return 'unhealthy'
  if (statuses.some(s => s === 'degraded')) return 'degraded'
  return 'healthy'
}
