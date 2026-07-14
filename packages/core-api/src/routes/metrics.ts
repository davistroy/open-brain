import type { Hono, MiddlewareHandler } from 'hono'
import { Registry, collectDefaultMetrics, Counter, Histogram, Gauge } from 'prom-client'
import { sql } from 'drizzle-orm'
import type { Database } from '@open-brain/shared'
import { registerOutboundMetrics } from '@open-brain/shared'

// --- Minimal Redis subset for metrics refresh ---
// Duck-typed — any ioredis client satisfies this interface.
export interface MetricsRedisClient {
  get: (key: string) => Promise<string | null>
}

// Dedicated registry — avoids conflicts with any global default registry
export const metricsRegistry = new Registry()
metricsRegistry.setDefaultLabels({ app: 'open-brain-core-api' })

// Default Node.js runtime metrics (CPU, memory, event loop lag, GC)
collectDefaultMetrics({ register: metricsRegistry })

// --- Custom business metrics ---

/** HTTP request counter — labels: method, route, status_code */
export const httpRequestsTotal = new Counter({
  name: 'openbrain_http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status_code'] as const,
  registers: [metricsRegistry],
})

/** HTTP request duration histogram — labels: method, route */
export const httpRequestDuration = new Histogram({
  name: 'openbrain_http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [metricsRegistry],
})

/** Captures ingested counter — label: source */
export const capturesTotal = new Counter({
  name: 'openbrain_captures_total',
  help: 'Total captures ingested',
  labelNames: ['source'] as const,
  registers: [metricsRegistry],
})

/** LLM cost counter — label: model */
export const llmCostTotal = new Counter({
  name: 'openbrain_llm_cost_usd_total',
  help: 'Cumulative LLM cost in USD',
  labelNames: ['model'] as const,
  registers: [metricsRegistry],
})

/**
 * Monthly LLM spend gauge (USD) — refreshed from ai_audit_log on each /metrics scrape.
 * Used by the BudgetAt80Percent and BudgetHardCap Prometheus alert rules in
 * config/prometheus/alerts/budget.yml. Value is current-month cumulative spend.
 */
export const budgetSpentUsd = new Gauge({
  name: 'openbrain_budget_spent_usd',
  help: 'Current month total LLM spend in USD (from ai_audit_log, refreshed per scrape)',
  registers: [metricsRegistry],
})

/**
 * Composio monthly usage gauge — refreshed from Redis on each /metrics scrape.
 * Key: composio:monthly_usage:YYYY-MM (set by ComposioClient.execute()).
 * Used by ComposioQuotaWarning and ComposioQuotaCritical Prometheus alert rules in
 * config/prometheus/alerts/integration.yml.
 */
export const composioMonthlyUsage = new Gauge({
  name: 'openbrain_composio_monthly_usage',
  help: 'Composio API calls used this calendar month (from Redis composio:monthly_usage:YYYY-MM)',
  registers: [metricsRegistry],
})

/**
 * IA-M4: register the shared outbound-dependency metrics (LLM + embedding request
 * duration/count, labeled {provider, operation, status_class}) into this scrape
 * registry so core-api's own outbound calls are exported at /metrics. The shared
 * module owns the metric instances (module-private registry); this shares them
 * into the core-api scrape registry. Idempotent — guards double-registration.
 */
registerOutboundMetrics(metricsRegistry)

// --- Route pattern normalization ---

/**
 * Collapse path parameters into placeholders to keep label cardinality low.
 * /api/v1/captures/abc-123 -> /api/v1/captures/:id
 * /api/v1/entities/def-456/links -> /api/v1/entities/:id/links
 */
function normalizeRoute(path: string): string {
  // UUID pattern (8-4-4-4-12 hex)
  const uuidNormalized = path.replace(
    /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    '/:id',
  )
  // Numeric IDs
  return uuidNormalized.replace(/\/\d+/g, '/:id')
}

// --- Hono middleware ---

/**
 * Metrics collection middleware. Instruments every request with
 * duration histogram and request counter. Excludes /metrics itself.
 */
export function metricsMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const path = c.req.path
    // Don't instrument the metrics endpoint itself
    if (path === '/metrics') {
      return next()
    }

    const method = c.req.method
    const route = normalizeRoute(path)
    const end = httpRequestDuration.startTimer({ method, route })

    await next()

    const statusCode = String(c.res.status)
    end()
    httpRequestsTotal.inc({ method, route, status_code: statusCode })
  }
}

// --- Route registration ---

/**
 * Register the Prometheus /metrics endpoint.
 *
 * When db is provided, refreshes openbrain_budget_spent_usd from ai_audit_log on
 * each scrape (one SUM query per 15s — indexed on created_at, negligible cost).
 *
 * When redis is provided, refreshes openbrain_composio_monthly_usage from the
 * Redis key composio:monthly_usage:YYYY-MM on each scrape.
 *
 * Both refreshes are non-fatal — a stale value is served if the DB or Redis
 * query fails (gauge defaults to 0 on first request).
 */
export function registerMetricsRoute(app: Hono, db?: Database, redis?: MetricsRedisClient): void {
  app.get('/metrics', async (c) => {
    // Refresh budget gauge from DB on each scrape (P11b)
    if (db) {
      try {
        const result = await db.execute<{ total: string }>(sql`
          SELECT COALESCE(SUM(cost_usd), 0)::text AS total
          FROM ai_audit_log
          WHERE created_at >= date_trunc('month', now())
        `)
        const total = result.rows[0]?.total
        budgetSpentUsd.set(total ? Number(total) : 0)
      } catch {
        // Non-fatal — stale value is fine (gauge stays at last known value)
      }
    }

    // Refresh Composio monthly usage gauge from Redis on each scrape (P11b)
    if (redis) {
      try {
        const now = new Date()
        const month = String(now.getMonth() + 1).padStart(2, '0')
        const key = `composio:monthly_usage:${now.getFullYear()}-${month}`
        const raw = await redis.get(key)
        composioMonthlyUsage.set(raw ? Number(raw) : 0)
      } catch {
        // Non-fatal
      }
    }

    const metrics = await metricsRegistry.metrics()
    return c.text(metrics, 200, {
      'Content-Type': metricsRegistry.contentType,
    })
  })
}
