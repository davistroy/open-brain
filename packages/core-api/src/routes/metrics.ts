import type { Hono, MiddlewareHandler } from 'hono'
import { Registry, collectDefaultMetrics, Counter, Histogram } from 'prom-client'

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

export function registerMetricsRoute(app: Hono): void {
  app.get('/metrics', async (c) => {
    const metrics = await metricsRegistry.metrics()
    return c.text(metrics, 200, {
      'Content-Type': metricsRegistry.contentType,
    })
  })
}
