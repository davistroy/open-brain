import { logger } from '@open-brain/shared'

// ============================================================
// Prometheus Pushgateway helper
// ============================================================

/**
 * A single Prometheus gauge metric line.
 * Labels are optional key-value pairs appended as `{key="value",key2="value2"}`.
 */
export interface MetricLine {
  name: string
  value: number
  labels?: Record<string, string>
  help?: string
  type?: 'gauge' | 'counter'
}

/**
 * Build Prometheus text exposition format from an array of metric lines.
 *
 * Output example:
 *   # HELP openbrain_queue_waiting Number of waiting jobs per queue
 *   # TYPE openbrain_queue_waiting gauge
 *   openbrain_queue_waiting{queue="embed-capture"} 12
 *   openbrain_queue_waiting{queue="extract-entities"} 3
 */
export function buildExposition(metrics: MetricLine[]): string {
  const lines: string[] = []
  const seen = new Set<string>()

  for (const m of metrics) {
    // Emit HELP and TYPE headers once per metric name
    if (!seen.has(m.name)) {
      seen.add(m.name)
      if (m.help) lines.push(`# HELP ${m.name} ${m.help}`)
      lines.push(`# TYPE ${m.name} ${m.type ?? 'gauge'}`)
    }

    // Build label string
    let labelStr = ''
    if (m.labels && Object.keys(m.labels).length > 0) {
      const pairs = Object.entries(m.labels)
        .map(([k, v]) => `${k}="${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
        .join(',')
      labelStr = `{${pairs}}`
    }

    lines.push(`${m.name}${labelStr} ${m.value}`)
  }

  return lines.join('\n') + '\n'
}

/**
 * Push metrics to a Prometheus Pushgateway.
 *
 * Uses simple HTTP POST with text/plain body in Prometheus exposition format.
 * Failures are logged but never thrown — metrics push must never break the
 * calling skill's execution.
 *
 * @param metrics  Array of metric lines to push
 * @param options  Optional overrides for URL and job/instance labels
 */
export async function pushMetrics(
  metrics: MetricLine[],
  options?: {
    /** Full Pushgateway URL including /metrics/job/... path. Overrides default. */
    url?: string
    /** Fetch function — injectable for testing. */
    fetchFn?: typeof globalThis.fetch
  },
): Promise<void> {
  const baseUrl = process.env.PUSHGATEWAY_URL ?? 'http://pushgateway:9091'
  const url = options?.url ?? `${baseUrl}/metrics/job/open-brain/instance/workers`
  const fetchFn = options?.fetchFn ?? globalThis.fetch

  const body = buildExposition(metrics)

  try {
    const response = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain; version=0.0.4' },
      body,
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      logger.warn(
        { status: response.status, body: text.slice(0, 200) },
        '[push-metrics] Pushgateway returned non-OK status',
      )
    } else {
      logger.debug({ metricCount: metrics.length }, '[push-metrics] pushed to Pushgateway')
    }
  } catch (err) {
    // Silently swallow — metrics push failure must never break health checks
    logger.warn({ err }, '[push-metrics] failed to push to Pushgateway')
  }
}
