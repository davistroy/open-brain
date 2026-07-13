/**
 * Outbound-dependency request metrics (IA-M4).
 *
 * A single, process-wide histogram + counter that time every outbound call to a
 * third-party dependency (LLM inference APIs, embedding API). Labels are kept to
 * a bounded, low-cardinality set: `{provider, operation, status_class}`.
 *
 *   - `provider`     — which backend (e.g. `openai`, `anthropic`, `openai_compat`, `ollama`).
 *   - `operation`    — the logical call (e.g. `chat`, `embedding`, `embedding_batch`).
 *   - `status_class` — outcome bucket (`2xx`, `4xx`, `5xx`, or `error`).
 *
 * URL / host / model are DELIBERATELY NOT labels — they are unbounded and would
 * explode Prometheus series cardinality. Provider + operation is enough to spot
 * a degraded or failing dependency.
 *
 * Two export mechanisms, because the two processes that make outbound calls
 * export metrics differently:
 *   - core-api scrapes a prom-client pull registry → {@link registerOutboundMetrics}
 *     adds these metrics to that registry.
 *   - workers has NO scrape registry; it pushes text exposition to a Pushgateway
 *     → {@link getOutboundMetricLines} renders the current values as pushable lines.
 *
 * The metrics live on a module-private registry so they exist exactly once per
 * process (ES module caching), which also disarms double-registration.
 */

import { Counter, Histogram, Registry } from 'prom-client'

/** Metric name for the outbound request duration histogram. */
export const OUTBOUND_DURATION_METRIC = 'openbrain_outbound_request_duration_seconds'
/** Metric name for the outbound request counter. */
export const OUTBOUND_TOTAL_METRIC = 'openbrain_outbound_requests_total'

/** The bounded label set. Order is not significant to prom-client. */
const OUTBOUND_LABELS = ['provider', 'operation', 'status_class'] as const

/**
 * Buckets tuned for LLM/embedding latencies (seconds). LLM chat calls routinely
 * take multiple seconds; embeddings are sub-second to a few seconds. Covers fast
 * local models through slow cloud calls up to the 60s+ timeout ceiling.
 */
const OUTBOUND_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120]

/**
 * Module-private registry. Owns the two metrics so a single process holds
 * exactly one instance of each (importing this module more than once reuses the
 * same instances). core-api additionally registers the same instances into its
 * scrape registry via {@link registerOutboundMetrics}; a prom-client metric can
 * belong to multiple registries while sharing one set of observed values.
 */
const outboundRegistry = new Registry()

/** Outbound request duration histogram (seconds), labeled {provider, operation, status_class}. */
export const outboundRequestDuration = new Histogram({
  name: OUTBOUND_DURATION_METRIC,
  help: 'Duration of outbound requests to third-party dependencies (LLM, embeddings) in seconds',
  labelNames: OUTBOUND_LABELS,
  buckets: OUTBOUND_BUCKETS,
  registers: [outboundRegistry],
})

/** Outbound request counter, labeled {provider, operation, status_class}. */
export const outboundRequestsTotal = new Counter({
  name: OUTBOUND_TOTAL_METRIC,
  help: 'Total outbound requests to third-party dependencies (LLM, embeddings)',
  labelNames: OUTBOUND_LABELS,
  registers: [outboundRegistry],
})

/**
 * Minimal structural view of a prom-client `Registry` — just the two methods
 * {@link registerOutboundMetrics} needs. Declared here so callers (core-api)
 * can pass their real `Registry`; a full prom-client Registry satisfies it.
 */
export interface OutboundMetricsRegistry {
  registerMetric(metric: Histogram<string> | Counter<string>): void
  getSingleMetric(name: string): unknown
}

/**
 * Register the outbound metrics into a caller-supplied prom-client registry
 * (core-api's pull/scrape registry). Idempotent — guards against
 * double-registration in a single process (prom-client throws if a metric name
 * is registered twice into the same registry).
 */
export function registerOutboundMetrics(registry: OutboundMetricsRegistry): void {
  if (!registry.getSingleMetric(OUTBOUND_DURATION_METRIC)) {
    registry.registerMetric(outboundRequestDuration)
  }
  if (!registry.getSingleMetric(OUTBOUND_TOTAL_METRIC)) {
    registry.registerMetric(outboundRequestsTotal)
  }
}

/**
 * Derive a low-cardinality `status_class` from a thrown error. OpenAI and
 * Anthropic SDK errors both expose a numeric `status` (HTTP status). A numeric
 * status maps to its class (`429` → `4xx`, `503` → `5xx`); anything else
 * (network failure, abort, non-HTTP error) is `error`.
 */
export function statusClassFromError(err: unknown): string {
  const status = (err as { status?: unknown } | null)?.status
  if (typeof status === 'number' && status >= 100 && status < 600) {
    return `${Math.floor(status / 100)}xx`
  }
  return 'error'
}

/**
 * Record one outbound call. `durationSeconds` is observed into the histogram and
 * the counter is incremented, both under the same label set.
 */
export function recordOutbound(
  provider: string,
  operation: string,
  statusClass: string,
  durationSeconds: number,
): void {
  const labels = { provider, operation, status_class: statusClass }
  outboundRequestDuration.observe(labels, durationSeconds)
  outboundRequestsTotal.inc(labels)
}

/**
 * Time an outbound call and record its duration + outcome. On success records
 * `2xx`; on throw derives the status class from the error and re-throws (the
 * caller's error handling is unchanged). This is the single instrumentation
 * helper used at every outbound call site.
 */
export async function timeOutboundCall<T>(
  provider: string,
  operation: string,
  fn: () => Promise<T>,
): Promise<T> {
  const startMs = Date.now()
  try {
    const result = await fn()
    recordOutbound(provider, operation, '2xx', (Date.now() - startMs) / 1000)
    return result
  } catch (err) {
    recordOutbound(provider, operation, statusClassFromError(err), (Date.now() - startMs) / 1000)
    throw err
  }
}

/**
 * A single Prometheus exposition line — structurally identical to the workers'
 * `MetricLine`, so the result can be spread directly into a Pushgateway payload.
 */
export interface OutboundMetricLine {
  name: string
  value: number
  labels?: Record<string, string>
  help?: string
  type?: 'gauge' | 'counter'
}

/**
 * Render the current outbound-metric values as pushable exposition lines, for
 * the workers Pushgateway path (workers has no scrape registry). Histograms are
 * expanded into their `_bucket` / `_sum` / `_count` component series; the
 * counter yields its `_total` series. Never throws — returns `[]` on any error
 * (metrics collection must never break a health push).
 */
export async function getOutboundMetricLines(): Promise<OutboundMetricLine[]> {
  try {
    const json = await outboundRegistry.getMetricsAsJSON()
    const lines: OutboundMetricLine[] = []

    for (const metric of json) {
      // prom-client's TS types annotate `type` as the numeric `MetricType` enum,
      // but getMetricsAsJSON() returns the lowercase string ('counter'/'gauge'/
      // 'histogram') at runtime — cast through unknown to compare the real value.
      const type: 'gauge' | 'counter' =
        (metric.type as unknown as string) === 'counter' ? 'counter' : 'gauge'
      const values = (metric as { values?: Array<{ value: number; labels?: Record<string, string | number>; metricName?: string }> }).values ?? []

      for (const v of values) {
        const labels: Record<string, string> = {}
        for (const [k, val] of Object.entries(v.labels ?? {})) {
          labels[k] = String(val)
        }
        lines.push({
          name: v.metricName ?? metric.name,
          value: v.value,
          labels: Object.keys(labels).length > 0 ? labels : undefined,
          help: metric.help,
          type,
        })
      }
    }

    return lines
  } catch {
    return []
  }
}

/**
 * Reset all outbound-metric values. Test-only helper — lets a test start from a
 * clean slate so cross-test observations do not leak. Not used in production.
 */
export function resetOutboundMetrics(): void {
  outboundRequestDuration.reset()
  outboundRequestsTotal.reset()
}
