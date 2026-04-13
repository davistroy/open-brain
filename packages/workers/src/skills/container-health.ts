import { sql } from 'drizzle-orm'
import type { Database } from '@open-brain/shared'
import { container_health, skills_log, logger, PushoverService } from '@open-brain/shared'

// ============================================================
// Types
// ============================================================

export interface ContainerEndpoint {
  name: string
  url: string
}

export interface ContainerCheckResult {
  container_name: string
  healthy: boolean
  response_ms: number
  error?: string
  metadata?: Record<string, unknown>
}

export interface ContainerHealthOptions {
  /** Override container endpoints for testing. */
  endpoints?: ContainerEndpoint[]
  /** Number of consecutive failures before alerting. Default: 3. */
  consecutiveFailureThreshold?: number
  /** Override "now" for deterministic testing. */
  now?: Date
}

export interface ContainerHealthResult {
  checks: ContainerCheckResult[]
  healthyCount: number
  unhealthyCount: number
  alertsSent: string[]
  durationMs: number
}

// ============================================================
// Constants
// ============================================================

const DEFAULT_CONSECUTIVE_FAILURE_THRESHOLD = 3

/**
 * Default container health endpoints.
 * /health is Docker-internal only (not proxied by nginx).
 * Uses container names as Docker DNS names on the open-brain network.
 */
const DEFAULT_ENDPOINTS: ContainerEndpoint[] = [
  { name: 'core-api', url: 'http://core-api:3000/health' },
  { name: 'voice-capture', url: 'http://voice-capture:3001/health' },
  { name: 'voice-pipecat', url: 'http://voice-pipecat:8766/health' },
  { name: 'file-ingestion', url: 'http://file-ingestion:8080/health' },
  // workers (BullMQ) and slack-bot (Socket Mode) have no HTTP health endpoints
  // web (Vite static) health checked via external Cloudflare tunnel instead
]

/**
 * Fetch with timeout and response time measurement.
 * Uses the injected fetch function for testability.
 */
async function timedFetch(
  url: string,
  timeoutMs: number,
  fetchFn: typeof globalThis.fetch,
): Promise<{ ok: boolean; status: number; responseMs: number; body?: string }> {
  const start = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetchFn(url, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' },
    })
    const responseMs = Date.now() - start
    const body = await response.text().catch(() => undefined)
    return { ok: response.ok, status: response.status, responseMs, body }
  } catch (err) {
    const responseMs = Date.now() - start
    const errorMsg = err instanceof Error ? err.message : String(err)
    return { ok: false, status: 0, responseMs, body: errorMsg }
  } finally {
    clearTimeout(timer)
  }
}

// ============================================================
// ContainerHealthSkill
// ============================================================

/**
 * ContainerHealthSkill — checks /health on each container every 15 minutes.
 *
 * - Hits each container's health endpoint with a 10s timeout
 * - Logs results to container_health table
 * - Checks for N consecutive failures per container
 * - Sends Pushover alert after threshold consecutive failures
 * - Never throws — returns degraded result on errors
 *
 * The fetchFn parameter is injectable for testing (no actual HTTP in tests).
 */
export class ContainerHealthSkill {
  private db: Database
  private pushover: PushoverService
  private fetchFn: typeof globalThis.fetch
  private endpoints: ContainerEndpoint[]

  constructor(opts: {
    db: Database
    pushover?: PushoverService
    /** Inject fetch for testing. Defaults to globalThis.fetch. */
    fetchFn?: typeof globalThis.fetch
    endpoints?: ContainerEndpoint[]
  }) {
    this.db = opts.db
    this.pushover = opts.pushover ?? new PushoverService()
    this.fetchFn = opts.fetchFn ?? globalThis.fetch
    this.endpoints = opts.endpoints ?? DEFAULT_ENDPOINTS
  }

  async execute(options: ContainerHealthOptions = {}): Promise<ContainerHealthResult> {
    const startMs = Date.now()
    const endpoints = options.endpoints ?? this.endpoints
    const consecutiveThreshold = options.consecutiveFailureThreshold ?? DEFAULT_CONSECUTIVE_FAILURE_THRESHOLD

    logger.info({ endpointCount: endpoints.length }, '[container-health] starting health checks')

    // Step 1: Check all containers in parallel
    const checks = await Promise.all(
      endpoints.map(ep => this.checkContainer(ep)),
    )

    // Step 2: Write results to container_health table
    await this.writeResults(checks)

    // Step 3: Check for consecutive failures and send alerts
    const alertsSent: string[] = []
    for (const check of checks) {
      if (!check.healthy) {
        const consecutiveCount = await this.getConsecutiveFailureCount(check.container_name)
        if (consecutiveCount >= consecutiveThreshold) {
          const sent = await this.sendAlert(check, consecutiveCount)
          if (sent) alertsSent.push(check.container_name)
        }
      }
    }

    const healthyCount = checks.filter(c => c.healthy).length
    const unhealthyCount = checks.filter(c => !c.healthy).length
    const durationMs = Date.now() - startMs

    // Step 4: Log to skills_log
    await this.logToSkillsLog({
      checks,
      healthyCount,
      unhealthyCount,
      alertsSent,
      durationMs,
    })

    logger.info(
      { healthyCount, unhealthyCount, alertsSent, durationMs },
      '[container-health] execution complete',
    )

    return { checks, healthyCount, unhealthyCount, alertsSent, durationMs }
  }

  // ----------------------------------------------------------
  // Private: check a single container
  // ----------------------------------------------------------

  private async checkContainer(endpoint: ContainerEndpoint): Promise<ContainerCheckResult> {
    const result = await timedFetch(endpoint.url, 10_000, this.fetchFn)

    if (result.ok) {
      return {
        container_name: endpoint.name,
        healthy: true,
        response_ms: result.responseMs,
        metadata: { status: result.status },
      }
    }

    return {
      container_name: endpoint.name,
      healthy: false,
      response_ms: result.responseMs,
      error: result.body ?? `HTTP ${result.status}`,
      metadata: { status: result.status },
    }
  }

  // ----------------------------------------------------------
  // Private: write results to container_health table
  // ----------------------------------------------------------

  private async writeResults(checks: ContainerCheckResult[]): Promise<void> {
    for (const check of checks) {
      try {
        await this.db.insert(container_health).values({
          container_name: check.container_name,
          healthy: check.healthy,
          response_ms: check.response_ms,
          error: check.error ?? null,
          metadata: check.metadata ?? null,
        })
      } catch (err) {
        logger.warn({ err, container: check.container_name }, '[container-health] failed to write health check result')
      }
    }
  }

  // ----------------------------------------------------------
  // Private: count consecutive failures
  // ----------------------------------------------------------

  /**
   * Count the most recent consecutive unhealthy checks for a container.
   * Includes the just-written current check.
   */
  async getConsecutiveFailureCount(containerName: string): Promise<number> {
    try {
      // Get the last N checks for this container, ordered by timestamp DESC
      const rows = await this.db.execute<{ healthy: boolean }>(sql`
        SELECT healthy
        FROM container_health
        WHERE container_name = ${containerName}
        ORDER BY timestamp DESC
        LIMIT 10
      `)

      let count = 0
      for (const row of rows.rows as { healthy: boolean }[]) {
        if (!row.healthy) {
          count++
        } else {
          break
        }
      }
      return count
    } catch (err) {
      logger.warn({ err, containerName }, '[container-health] failed to count consecutive failures')
      return 0
    }
  }

  // ----------------------------------------------------------
  // Private: Pushover alert
  // ----------------------------------------------------------

  private async sendAlert(check: ContainerCheckResult, consecutiveCount: number): Promise<boolean> {
    if (!this.pushover.isConfigured) {
      logger.debug('[container-health] Pushover not configured — skipping alert')
      return false
    }

    const message = [
      `Container "${check.container_name}" has failed ${consecutiveCount} consecutive health checks.`,
      `Response time: ${check.response_ms}ms`,
      check.error ? `Error: ${check.error.slice(0, 300)}` : null,
    ].filter(Boolean).join('\n')

    try {
      await this.pushover.send({
        title: `Open Brain: ${check.container_name} unhealthy`,
        message,
        priority: 1,
      })
      logger.info({ containerName: check.container_name, consecutiveCount }, '[container-health] alert sent')
      return true
    } catch (err) {
      logger.warn({ err }, '[container-health] Pushover alert failed')
      return false
    }
  }

  // ----------------------------------------------------------
  // Private: skills_log
  // ----------------------------------------------------------

  private async logToSkillsLog(params: {
    checks: ContainerCheckResult[]
    healthyCount: number
    unhealthyCount: number
    alertsSent: string[]
    durationMs: number
  }): Promise<void> {
    const unhealthy = params.checks
      .filter(c => !c.healthy)
      .map(c => c.container_name)

    const outputSummary = [
      `healthy:${params.healthyCount}`,
      `unhealthy:${params.unhealthyCount}`,
      unhealthy.length > 0 ? `down:[${unhealthy.join(',')}]` : null,
      params.alertsSent.length > 0 ? `alerts:[${params.alertsSent.join(',')}]` : null,
    ].filter(Boolean).join(' | ')

    try {
      await this.db.insert(skills_log).values({
        skill_name: 'container-health',
        input_summary: `${params.checks.length} containers checked`,
        output_summary: outputSummary,
        duration_ms: params.durationMs,
      })
    } catch (err) {
      logger.warn({ err }, '[container-health] failed to write skills_log entry')
    }
  }
}

// ============================================================
// Entry point for skill-execution worker
// ============================================================

export async function executeContainerHealth(
  db: Database,
  options: ContainerHealthOptions = {},
): Promise<ContainerHealthResult> {
  const skill = new ContainerHealthSkill({ db })
  return skill.execute(options)
}
