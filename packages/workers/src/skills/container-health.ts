import { sql } from 'drizzle-orm'
import { Redis } from 'ioredis'
import type { ConnectionOptions } from 'bullmq'
import type { Database, ConfigService } from '@open-brain/shared'
import { container_health, logger } from '@open-brain/shared'
import { BaseSkill } from './base-skill.js'
import type { BaseResult, BaseSkillOpts } from './types.js'
import { pushMetrics } from '../lib/push-metrics.js'
import type { MetricLine } from '../lib/push-metrics.js'
import { pushBackupAgeGauge } from '../lib/backup-age.js'
import { legacyPushEnabled, containerAlertKey } from '../lib/alert-state.js'

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

export interface ContainerHealthResult extends BaseResult {
  checks: ContainerCheckResult[]
  healthyCount: number
  unhealthyCount: number
  alertsSent: string[]
}

// ============================================================
// Constants
// ============================================================

const DEFAULT_CONSECUTIVE_FAILURE_THRESHOLD = 3

/**
 * Default container health endpoints (the compose containers with an HTTP
 * /health). /health is Docker-internal only (not proxied by nginx). Uses
 * container names as Docker DNS names on the open-brain network.
 *
 * litellm is deliberately NOT probed here — it is a standalone shared proxy
 * (llm.k4jda.net), not a container in this compose stack; the old
 * `litellm:4000` entry resolved nothing and always reported unhealthy.
 * faster-whisper's `/health` path matches its own Docker healthcheck
 * (docker-compose.yml `faster-whisper` service, internal port 8000).
 *
 * The EXTERNAL LLM tiers (jetson-llm, spark-llm, ...) are NOT listed here: they
 * are built from `config/ai-routing.yaml` `model_tiers` (see `llmEndpointsFromConfig`)
 * so the probe list cannot drift from the routing config. Postgres and Redis are
 * probed by `SELECT 1` / `PING`, not by URL.
 */
export const DEFAULT_ENDPOINTS: ContainerEndpoint[] = [
  { name: 'core-api', url: 'http://core-api:3000/health' },
  { name: 'voice-capture', url: 'http://voice-capture:3001/health' },
  { name: 'file-ingestion', url: 'http://file-ingestion:8080/health' },
  { name: 'faster-whisper', url: 'http://faster-whisper:8000/health' },
  // workers (BullMQ) and slack-bot (Socket Mode) have no HTTP health endpoints
  // web-next (Next.js) health checked via external Cloudflare tunnel instead
]

/**
 * The probe names of the LEGACY direct push, frozen at commit f341ca6
 * (`DEFAULT_ENDPOINTS` there). The legacy path (priority 1 every run past the
 * threshold) reads only these, so the rollback (ALERT_STATE_ENABLED=false) and
 * the parallel week push exactly as before and never for a probe f341ca6 did not
 * have (spark-llm, postgres, redis). The alert-state path covers every probe.
 * Delete with the legacy path.
 */
export const LEGACY_MONITORED_CONTAINERS = [
  'core-api',
  'voice-capture',
  'file-ingestion',
  'faster-whisper',
  'jetson-llm',
] as const

/** Probes whose outage is critical (priority 1, escalates). Every other probe is a warning. */
const CRITICAL_PROBES: ReadonlySet<string> = new Set(['postgres', 'redis', 'core-api'])

const PROBE_TIMEOUT_MS = 10_000

/**
 * Build the LLM-tier probes from `ai-routing.yaml` `model_tiers`: every tier with
 * `provider: openai_compat` and a `base_url`. URL = base_url without a trailing
 * `/`, with a trailing `/v1` replaced by `/health` (or `/health` appended).
 * Name = tier key without its `t<digit>_` prefix, plus `-llm`. Never throws: an
 * entry that cannot be parsed is skipped with a warning.
 */
export function llmEndpointsFromConfig(configService: ConfigService | undefined): ContainerEndpoint[] {
  if (!configService) {
    logger.warn('[container-health] no configService — LLM tier probes disabled')
    return []
  }
  let tiers: Record<string, { provider?: string; base_url?: string }> | undefined
  try {
    tiers = configService.get('ai').model_tiers
  } catch (err) {
    logger.warn({ err }, '[container-health] could not read ai config — LLM tier probes disabled')
    return []
  }
  const endpoints: ContainerEndpoint[] = []
  for (const [key, tier] of Object.entries(tiers ?? {})) {
    if (tier?.provider !== 'openai_compat' || !tier.base_url) continue
    try {
      const url = new URL(tier.base_url)
      const base = url.href.replace(/\/+$/, '')
      const healthUrl = /\/v1$/.test(base) ? base.replace(/\/v1$/, '/health') : `${base}/health`
      endpoints.push({ name: `${key.replace(/^t\d+_/, '')}-llm`, url: healthUrl })
    } catch (err) {
      logger.warn({ err, tier: key }, '[container-health] unparseable base_url — tier not probed')
    }
  }
  return endpoints
}

/**
 * In-process consecutive-failure streak per probe. The DB-backed count lives in
 * the Postgres being probed, so it is blind exactly when Postgres is down; the
 * streak keeps counting. Module-level because `runSkill` builds a new skill
 * instance per job.
 */
const streaks = new Map<string, number>()

/** Test helper: forget all in-process streaks. */
export function resetContainerStreaks(): void {
  streaks.clear()
}

async function withTimeout<T>(work: () => Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

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
export interface ContainerHealthSkillOpts extends BaseSkillOpts {
  /** Inject fetch for testing. Defaults to globalThis.fetch. */
  fetchFn?: typeof globalThis.fetch
  /** Replaces the whole HTTP probe list (DEFAULT_ENDPOINTS + config-derived LLM tiers). */
  endpoints?: ContainerEndpoint[]
  /** Source of the LLM tier probes (`model_tiers`). Omitted: no LLM probes (warn). */
  configService?: ConfigService
  /** Production: Redis connection for the short-lived PING client. */
  redisConnection?: ConnectionOptions
  /** Tests: replaces the Redis PING. Rejects on failure. */
  redisPing?: () => Promise<void>
  /** Probe Postgres (`SELECT 1`) and Redis (`PING`). Default true. */
  includeStores?: boolean
}

export class ContainerHealthSkill extends BaseSkill<ContainerHealthOptions, ContainerHealthResult> {
  private fetchFn: typeof globalThis.fetch
  private endpoints: ContainerEndpoint[] | undefined
  private configService: ConfigService | undefined
  private redisPing: (() => Promise<void>) | undefined
  private includeStores: boolean

  constructor(opts: ContainerHealthSkillOpts) {
    super('container-health', opts)
    this.fetchFn = opts.fetchFn ?? globalThis.fetch
    this.endpoints = opts.endpoints
    this.configService = opts.configService
    this.includeStores = opts.includeStores ?? true
    this.redisPing = opts.redisPing ?? (opts.redisConnection ? makeRedisPing(opts.redisConnection) : undefined)
  }

  protected async run(options: ContainerHealthOptions = {}): Promise<ContainerHealthResult> {
    const startMs = Date.now()
    const endpoints = options.endpoints ?? this.endpoints ?? [...DEFAULT_ENDPOINTS, ...llmEndpointsFromConfig(this.configService)]
    const consecutiveThreshold = options.consecutiveFailureThreshold ?? DEFAULT_CONSECUTIVE_FAILURE_THRESHOLD

    logger.info({ endpointCount: endpoints.length }, '[container-health] starting health checks')

    // Step 1: Check all containers in parallel
    const probes: Array<Promise<ContainerCheckResult>> = endpoints.map(ep => this.checkContainer(ep))
    if (this.includeStores) {
      probes.push(this.checkPostgres())
      if (this.redisPing) {
        probes.push(this.checkRedis(this.redisPing))
      } else {
        logger.warn('[container-health] no Redis connection — redis probe skipped')
      }
    }
    const checks = await Promise.all(probes)

    // Streaks first: they must not depend on the database being reachable.
    for (const c of checks) {
      streaks.set(c.container_name, c.healthy ? 0 : (streaks.get(c.container_name) ?? 0) + 1)
    }

    // Step 2: Write results to container_health table
    await this.writeResults(checks)

    // Step 2.5: Push container health metrics to Pushgateway
    await this.pushContainerMetrics(checks)

    // Step 2.6: Re-push the backup-age gauge on this 15-min cadence (#309).
    // Pushgateway has no persistence; after a restart the gauge would be ABSENT
    // for up to 6h if only pipeline-health (every 6h) pushed it — and
    // OpenBrainBackupStale cannot fire on an absent metric. Graceful/no-op if the
    // /backup-latest mount is absent.
    await pushBackupAgeGauge()

    // Step 3: alert on every probe, healthy ones too (so recovery sends "Resolved").
    const alertsSent: string[] = []
    const legacyOn = legacyPushEnabled()
    for (const check of checks) {
      const name = check.container_name
      const consecutiveCount = check.healthy ? 0 : await this.effectiveFailureCount(name)
      const bad = !check.healthy && consecutiveCount >= consecutiveThreshold

      const raised = await this.raiseAlert({
        key: containerAlertKey(name),
        severity: CRITICAL_PROBES.has(name) ? 'critical' : 'warning',
        bad,
        title: `${name} unhealthy`,
        message: check.healthy ? `Container "${name}" is healthy again.` : this.alertMessage(check, consecutiveCount),
      })
      let sent = raised.sent

      // Legacy direct push: f341ca6 probe names only (rollback must be exact).
      if (legacyOn && bad && (LEGACY_MONITORED_CONTAINERS as readonly string[]).includes(name)) {
        if (await this.sendAlert(check, consecutiveCount)) sent = true
      }
      if (sent) alertsSent.push(name)
    }

    const healthyCount = checks.filter(c => c.healthy).length
    const unhealthyCount = checks.filter(c => !c.healthy).length
    const durationMs = Date.now() - startMs

    // Step 4: Log to skills_log via BaseSkill
    const unhealthyNames = checks.filter(c => !c.healthy).map(c => c.container_name)
    const outputSummary = [
      `healthy:${healthyCount}`,
      `unhealthy:${unhealthyCount}`,
      unhealthyNames.length > 0 ? `down:[${unhealthyNames.join(',')}]` : null,
      alertsSent.length > 0 ? `alerts:[${alertsSent.join(',')}]` : null,
    ].filter(Boolean).join(' | ')
    const result: ContainerHealthResult = { checks, healthyCount, unhealthyCount, alertsSent, durationMs }
    await this.logResult(result, `${endpoints.length} containers checked`, outputSummary)

    logger.info(
      { healthyCount, unhealthyCount, alertsSent, durationMs },
      '[container-health] execution complete',
    )

    return result
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
  // Private: push container health metrics to Pushgateway
  // ----------------------------------------------------------

  /**
   * Push container health gauges to Prometheus Pushgateway.
   * Metrics: openbrain_container_healthy (0 or 1), openbrain_container_response_ms.
   * Failures are silently caught.
   */
  private async pushContainerMetrics(checks: ContainerCheckResult[]): Promise<void> {
    const metrics: MetricLine[] = []

    for (const c of checks) {
      metrics.push(
        { name: 'openbrain_container_healthy', value: c.healthy ? 1 : 0, labels: { container: c.container_name }, help: 'Whether the container is healthy (1) or not (0)', type: 'gauge' },
        { name: 'openbrain_container_response_ms', value: c.response_ms, labels: { container: c.container_name }, help: 'Container health check response time in milliseconds', type: 'gauge' },
      )
    }

    await pushMetrics(metrics)
  }

  // ----------------------------------------------------------
  // Private: count consecutive failures
  // ----------------------------------------------------------

  /**
   * Count the most recent consecutive unhealthy checks for a container.
   * Includes the just-written current check. Returns 0 if the database cannot
   * be read (use `effectiveFailureCount` for alerting).
   */
  async getConsecutiveFailureCount(containerName: string): Promise<number> {
    try {
      return await this.readFailureCount(containerName)
    } catch (err) {
      logger.warn({ err, containerName }, '[container-health] failed to count consecutive failures')
      return 0
    }
  }

  private async readFailureCount(containerName: string): Promise<number> {
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
  }

  /**
   * The failure count used for alerting: the larger of the DB-backed count and
   * the in-process streak. When the database is down both the insert and the
   * count fail, so only the streak sees the outage (design rule B). A read error
   * never throws out of the run.
   */
  private async effectiveFailureCount(containerName: string): Promise<number> {
    const streak = streaks.get(containerName) ?? 0
    try {
      return Math.max(await this.readFailureCount(containerName), streak)
    } catch (err) {
      logger.warn({ err, containerName }, '[container-health] failed to count consecutive failures — using in-process streak')
      return streak
    }
  }

  // ----------------------------------------------------------
  // Private: store probes
  // ----------------------------------------------------------

  private async checkPostgres(): Promise<ContainerCheckResult> {
    const start = Date.now()
    try {
      await withTimeout(() => this.db.execute(sql`SELECT 1`), PROBE_TIMEOUT_MS, 'postgres SELECT 1')
      return { container_name: 'postgres', healthy: true, response_ms: Date.now() - start, metadata: { probe: 'SELECT 1' } }
    } catch (err) {
      return {
        container_name: 'postgres',
        healthy: false,
        response_ms: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
        metadata: { probe: 'SELECT 1' },
      }
    }
  }

  private async checkRedis(ping: () => Promise<void>): Promise<ContainerCheckResult> {
    const start = Date.now()
    try {
      await withTimeout(ping, PROBE_TIMEOUT_MS, 'redis PING')
      return { container_name: 'redis', healthy: true, response_ms: Date.now() - start, metadata: { probe: 'PING' } }
    } catch (err) {
      return {
        container_name: 'redis',
        healthy: false,
        response_ms: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
        metadata: { probe: 'PING' },
      }
    }
  }

  private alertMessage(check: ContainerCheckResult, consecutiveCount: number): string {
    return [
      `Container "${check.container_name}" has failed ${consecutiveCount} consecutive health checks.`,
      `Response time: ${check.response_ms}ms`,
      check.error ? `Error: ${check.error.slice(0, 300)}` : null,
    ].filter(Boolean).join('\n')
  }

  // ----------------------------------------------------------
  // Private: Pushover alert
  // ----------------------------------------------------------

  private async sendAlert(check: ContainerCheckResult, consecutiveCount: number): Promise<boolean> {
    if (!this.pushover.isConfigured) {
      logger.debug('[container-health] Pushover not configured — skipping alert')
      return false
    }

    const message = this.alertMessage(check, consecutiveCount)

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

}

/**
 * Production Redis PING: a short-lived client with fail-fast options (no retry
 * storm, no offline queue), always disconnected afterwards.
 */
function makeRedisPing(connection: ConnectionOptions): () => Promise<void> {
  return async () => {
    const conn = connection as { host?: string; port?: number; password?: string }
    const client = new Redis({
      host: conn.host ?? 'localhost',
      port: conn.port ?? 6379,
      ...(conn.password ? { password: conn.password } : {}),
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 5_000,
      retryStrategy: () => null,
    })
    client.on('error', () => { /* surfaced through the rejected command */ })
    try {
      await client.connect()
      await client.ping()
    } finally {
      client.disconnect()
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
