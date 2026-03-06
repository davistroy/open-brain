import { Worker, Queue } from 'bullmq'
import { sql } from 'drizzle-orm'
import type { ConnectionOptions } from 'bullmq'
import type { Database } from '@open-brain/shared'
import { logger } from '../lib/logger.js'
import { PushoverService } from '../services/pushover.js'

// ============================================================
// Types
// ============================================================

export interface BudgetCheckJobData {
  /** ISO 8601 timestamp — informational */
  triggeredAt: string
}

export interface BudgetCheckResult {
  /** Total spend for the current calendar month (USD) */
  monthlySpend: number
  /** Source of spend data — 'litellm' | 'local' | 'combined' */
  spendSource: string
  /** Whether an alert was sent */
  alertSent: boolean
  /** Threshold that was crossed (if any) */
  thresholdCrossed: 'soft' | 'hard' | null
}

// ============================================================
// Constants
// ============================================================

const DEFAULT_SOFT_LIMIT = 30 // USD
const DEFAULT_HARD_LIMIT = 50 // USD
const LITELLM_TIMEOUT_MS = 15_000

// ============================================================
// BudgetCheckJob processor
// ============================================================

/**
 * BudgetCheckJob — queries monthly AI spend from LiteLLM and local ai_audit_log,
 * then sends a Pushover alert when spend crosses soft ($30) or hard ($50) thresholds.
 *
 * Design decisions:
 * - Primary source: LiteLLM spend API at GET /spend/logs (requires LITELLM_API_KEY)
 * - Fallback source: local ai_audit_log table (estimated cost via token counts)
 * - If both sources available, uses LiteLLM (authoritative) and logs local for comparison
 * - Soft limit: normal priority Pushover alert with spend details
 * - Hard limit: high priority Pushover alert — circuit breaker is LiteLLM's job,
 *   this is proactive monitoring while there's still headroom
 * - Logs spend regardless of whether an alert fires
 *
 * Environment variables:
 * - LITELLM_URL: LiteLLM proxy URL (default: https://llm.k4jda.net)
 * - LITELLM_API_KEY: API key for LiteLLM spend endpoint
 * - BUDGET_SOFT_LIMIT: soft alert threshold in USD (default: 30)
 * - BUDGET_HARD_LIMIT: hard alert threshold in USD (default: 50)
 * - PUSHOVER_APP_TOKEN, PUSHOVER_USER_KEY: Pushover credentials
 */
export async function processBudgetCheckJob(
  data: BudgetCheckJobData,
  db: Database,
  pushover: PushoverService,
  opts?: {
    litellmUrl?: string
    litellmApiKey?: string
    softLimit?: number
    hardLimit?: number
  },
): Promise<BudgetCheckResult> {
  const litellmUrl = opts?.litellmUrl ?? process.env.LITELLM_URL ?? 'https://llm.k4jda.net'
  const litellmApiKey = opts?.litellmApiKey ?? process.env.LITELLM_API_KEY ?? ''
  const softLimit = opts?.softLimit ?? Number(process.env.BUDGET_SOFT_LIMIT ?? DEFAULT_SOFT_LIMIT)
  const hardLimit = opts?.hardLimit ?? Number(process.env.BUDGET_HARD_LIMIT ?? DEFAULT_HARD_LIMIT)

  logger.info({ triggeredAt: data.triggeredAt, softLimit, hardLimit }, '[budget-check] starting')

  // --------------------------------------------------------
  // Step 1: Query LiteLLM spend API for current month
  // --------------------------------------------------------
  let litellmSpend: number | null = null
  let spendSource = 'local'

  if (litellmApiKey) {
    litellmSpend = await queryLiteLLMSpend(litellmUrl, litellmApiKey)
  } else {
    logger.warn('[budget-check] LITELLM_API_KEY not set — skipping LiteLLM spend query')
  }

  // --------------------------------------------------------
  // Step 2: Query local ai_audit_log for comparison
  // --------------------------------------------------------
  const localSpend = await queryLocalSpend(db)

  logger.info({ litellmSpend, localSpend }, '[budget-check] spend data retrieved')

  // --------------------------------------------------------
  // Step 3: Determine authoritative monthly spend
  // --------------------------------------------------------
  let monthlySpend: number

  if (litellmSpend !== null) {
    monthlySpend = litellmSpend
    spendSource = localSpend !== null ? 'combined' : 'litellm'
  } else if (localSpend !== null) {
    monthlySpend = localSpend
    spendSource = 'local'
  } else {
    logger.warn('[budget-check] no spend data available from either source — skipping alert check')
    return { monthlySpend: 0, spendSource: 'none', alertSent: false, thresholdCrossed: null }
  }

  // --------------------------------------------------------
  // Step 4: Check thresholds and send alerts
  // --------------------------------------------------------
  let alertSent = false
  let thresholdCrossed: 'soft' | 'hard' | null = null

  if (monthlySpend >= hardLimit) {
    thresholdCrossed = 'hard'
    alertSent = await sendBudgetAlert(pushover, monthlySpend, hardLimit, 'hard', spendSource)
  } else if (monthlySpend >= softLimit) {
    thresholdCrossed = 'soft'
    alertSent = await sendBudgetAlert(pushover, monthlySpend, softLimit, 'soft', spendSource)
  } else {
    logger.info(
      { monthlySpend, softLimit, hardLimit },
      '[budget-check] spend under soft limit — no alert needed',
    )
  }

  logger.info(
    { monthlySpend, spendSource, thresholdCrossed, alertSent },
    '[budget-check] complete',
  )

  return { monthlySpend, spendSource, alertSent, thresholdCrossed }
}

// ============================================================
// LiteLLM spend query
// ============================================================

/**
 * Queries LiteLLM spend/logs endpoint for the current calendar month total.
 *
 * LiteLLM's /spend/logs endpoint returns spend records. We filter by the
 * current month (start_date / end_date query params) and sum total_cost.
 *
 * Returns null if the request fails (non-fatal — falls back to local data).
 */
async function queryLiteLLMSpend(baseUrl: string, apiKey: string): Promise<number | null> {
  try {
    const now = new Date()
    const startDate = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10) // YYYY-MM-DD
    const endDate = now.toISOString().slice(0, 10)

    const url = new URL('/spend/logs', baseUrl)
    url.searchParams.set('start_date', startDate)
    url.searchParams.set('end_date', endDate)

    logger.debug({ url: url.toString(), startDate, endDate }, '[budget-check] querying LiteLLM spend API')

    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(LITELLM_TIMEOUT_MS),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      logger.warn({ status: res.status, body }, '[budget-check] LiteLLM spend API error')
      return null
    }

    const data = await res.json() as unknown

    // LiteLLM /spend/logs returns an array of spend records or an object with spend summary.
    // Handle both formats:
    // - Array format: [{ spend: number, ... }, ...]  → sum all spend values
    // - Object with total_cost: { total_cost: number }
    // - Object with spend: { spend: number }
    if (Array.isArray(data)) {
      const total = (data as Array<Record<string, unknown>>).reduce((sum, row) => {
        const rowSpend = typeof row.spend === 'number' ? row.spend :
          typeof row.total_cost === 'number' ? row.total_cost : 0
        return sum + rowSpend
      }, 0)
      logger.debug({ total, records: data.length }, '[budget-check] LiteLLM spend (array format)')
      return total
    }

    const dataObj = data as Record<string, unknown>
    if (typeof dataObj.total_cost === 'number') {
      logger.debug({ total: dataObj.total_cost }, '[budget-check] LiteLLM spend (total_cost format)')
      return dataObj.total_cost
    }

    if (typeof dataObj.spend === 'number') {
      logger.debug({ total: dataObj.spend }, '[budget-check] LiteLLM spend (spend format)')
      return dataObj.spend
    }

    logger.warn({ data }, '[budget-check] LiteLLM spend response format not recognized')
    return null
  } catch (err) {
    logger.warn({ err }, '[budget-check] failed to query LiteLLM spend API — using local data')
    return null
  }
}

// ============================================================
// Local ai_audit_log spend query
// ============================================================

/**
 * Estimates monthly spend from local ai_audit_log table using token counts.
 *
 * Uses a conservative $1.00/1M token estimate — this is an approximation since
 * actual costs vary by model. The LiteLLM API is the authoritative source;
 * this is a fallback and cross-check.
 *
 * Returns null if the query fails.
 */
async function queryLocalSpend(db: Database): Promise<number | null> {
  try {
    const now = new Date()
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)

    const result = await db.execute<{
      total_tokens: string | null
      call_count: string
    }>(sql`
      SELECT
        SUM(total_tokens) AS total_tokens,
        COUNT(*) AS call_count
      FROM ai_audit_log
      WHERE created_at >= ${monthStart.toISOString()}::timestamptz
        AND error IS NULL
    `)

    const row = result.rows[0]
    if (!row) return null

    const totalTokens = row.total_tokens ? Number(row.total_tokens) : 0
    const callCount = Number(row.call_count)

    // Conservative estimate: $1.00 per 1M tokens (blended rate across embedding + LLM calls)
    const estimatedCost = (totalTokens / 1_000_000) * 1.0

    logger.debug({ totalTokens, callCount, estimatedCost }, '[budget-check] local ai_audit_log spend estimate')

    return estimatedCost
  } catch (err) {
    logger.warn({ err }, '[budget-check] failed to query ai_audit_log — skipping local estimate')
    return null
  }
}

// ============================================================
// Alert delivery
// ============================================================

/**
 * Sends a Pushover budget alert.
 *
 * Soft limit: normal priority (0) — "AI spend is $X.XX this month ($30 soft limit)"
 * Hard limit: high priority (1) — urgent warning, circuit breaker may be near
 *
 * Returns true if alert was sent, false if Pushover not configured.
 */
async function sendBudgetAlert(
  pushover: PushoverService,
  monthlySpend: number,
  threshold: number,
  level: 'soft' | 'hard',
  spendSource: string,
): Promise<boolean> {
  if (!pushover.isConfigured) {
    logger.warn({ level, monthlySpend, threshold }, '[budget-check] Pushover not configured — alert not sent')
    return false
  }

  const spendFormatted = `$${monthlySpend.toFixed(2)}`
  const thresholdFormatted = `$${threshold}`
  const priority = level === 'hard' ? 1 : 0

  const title = level === 'hard'
    ? 'AI Budget Warning — Hard Limit Approaching'
    : 'AI Budget Alert — Soft Limit Reached'

  const message = level === 'hard'
    ? `AI spend is ${spendFormatted} this month — approaching the ${thresholdFormatted} hard limit. Circuit breaker will activate at $${DEFAULT_HARD_LIMIT}. (source: ${spendSource})`
    : `AI spend is ${spendFormatted} this month (${thresholdFormatted} soft limit). Monitor usage to stay under the $${DEFAULT_HARD_LIMIT} hard limit. (source: ${spendSource})`

  logger.info({ level, monthlySpend, threshold, priority }, '[budget-check] sending budget alert')

  try {
    await pushover.send({ title, message, priority })
    logger.info({ level, monthlySpend }, '[budget-check] budget alert sent')
    return true
  } catch (err) {
    logger.warn({ err, level, monthlySpend }, '[budget-check] failed to send budget alert')
    return false
  }
}

// ============================================================
// BullMQ Worker factory
// ============================================================

/**
 * Creates a BullMQ Worker for the 'budget-check' queue.
 *
 * Job options (set via scheduler):
 * - Schedule: daily at 8:00 AM (cron: 0 8 * * *)
 * - attempts: 2 (retry once on transient failure; spend check is idempotent)
 * - concurrency: 1 (singleton — no parallel spend checks)
 *
 * The caller is responsible for calling worker.close() on process shutdown.
 */
export function createBudgetCheckWorker(
  connection: ConnectionOptions,
  db: Database,
  opts?: {
    appToken?: string
    userKey?: string
    litellmUrl?: string
    litellmApiKey?: string
    softLimit?: number
    hardLimit?: number
  },
): Worker<BudgetCheckJobData> {
  const pushover = new PushoverService(opts?.appToken, opts?.userKey)

  const worker = new Worker<BudgetCheckJobData>(
    'budget-check',
    async (job) => {
      await processBudgetCheckJob(job.data, db, pushover, {
        litellmUrl: opts?.litellmUrl,
        litellmApiKey: opts?.litellmApiKey,
        softLimit: opts?.softLimit,
        hardLimit: opts?.hardLimit,
      })
    },
    {
      connection,
      concurrency: 1,
    },
  )

  worker.on('failed', (job, err) => {
    logger.error(
      { jobId: job?.id, attempts: job?.attemptsMade, err: err.message },
      '[budget-check] job failed',
    )
  })

  worker.on('completed', (job) => {
    logger.info({ jobId: job?.id }, '[budget-check] job completed')
  })

  return worker
}

// ============================================================
// Queue factory
// ============================================================

/**
 * Creates the budget-check BullMQ queue.
 * Used by the scheduler to register the repeatable job.
 */
export function createBudgetCheckQueue(connection: ConnectionOptions): Queue<BudgetCheckJobData> {
  return new Queue<BudgetCheckJobData>('budget-check', {
    connection,
    defaultJobOptions: {
      attempts: 2,
      backoff: { type: 'fixed', delay: 60_000 }, // 1 minute between attempts
      removeOnComplete: { count: 30 },            // keep 30 days of results
      removeOnFail: { count: 10 },
    },
  })
}
