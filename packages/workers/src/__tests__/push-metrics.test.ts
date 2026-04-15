import { describe, it, expect, vi } from 'vitest'
import { buildExposition, pushMetrics } from '../lib/push-metrics.js'
import type { MetricLine } from '../lib/push-metrics.js'

// ============================================================
// buildExposition
// ============================================================

describe('buildExposition', () => {
  it('builds single metric without labels', () => {
    const result = buildExposition([
      { name: 'openbrain_up', value: 1, help: 'Whether the system is up', type: 'gauge' },
    ])
    expect(result).toBe(
      '# HELP openbrain_up Whether the system is up\n' +
      '# TYPE openbrain_up gauge\n' +
      'openbrain_up 1\n',
    )
  })

  it('builds metric with labels', () => {
    const result = buildExposition([
      { name: 'openbrain_queue_waiting', value: 12, labels: { queue: 'embed-capture' }, help: 'Waiting jobs', type: 'gauge' },
    ])
    expect(result).toContain('openbrain_queue_waiting{queue="embed-capture"} 12')
  })

  it('emits HELP and TYPE only once per metric name', () => {
    const metrics: MetricLine[] = [
      { name: 'openbrain_queue_waiting', value: 5, labels: { queue: 'a' }, help: 'Waiting', type: 'gauge' },
      { name: 'openbrain_queue_waiting', value: 3, labels: { queue: 'b' }, help: 'Waiting', type: 'gauge' },
    ]
    const result = buildExposition(metrics)
    const helpCount = (result.match(/# HELP openbrain_queue_waiting/g) || []).length
    const typeCount = (result.match(/# TYPE openbrain_queue_waiting/g) || []).length
    expect(helpCount).toBe(1)
    expect(typeCount).toBe(1)
  })

  it('handles multiple metric names', () => {
    const metrics: MetricLine[] = [
      { name: 'openbrain_queue_waiting', value: 5, labels: { queue: 'a' }, help: 'Waiting', type: 'gauge' },
      { name: 'openbrain_queue_failed', value: 2, labels: { queue: 'a' }, help: 'Failed', type: 'gauge' },
    ]
    const result = buildExposition(metrics)
    expect(result).toContain('# TYPE openbrain_queue_waiting gauge')
    expect(result).toContain('# TYPE openbrain_queue_failed gauge')
    expect(result).toContain('openbrain_queue_waiting{queue="a"} 5')
    expect(result).toContain('openbrain_queue_failed{queue="a"} 2')
  })

  it('escapes double quotes in label values', () => {
    const result = buildExposition([
      { name: 'test_metric', value: 1, labels: { name: 'has "quotes"' } },
    ])
    expect(result).toContain('{name="has \\"quotes\\""}')
  })

  it('defaults type to gauge when omitted', () => {
    const result = buildExposition([
      { name: 'test_metric', value: 42 },
    ])
    expect(result).toContain('# TYPE test_metric gauge')
  })

  it('omits HELP line when help is not provided', () => {
    const result = buildExposition([
      { name: 'test_metric', value: 42 },
    ])
    expect(result).not.toContain('# HELP')
  })
})

// ============================================================
// pushMetrics
// ============================================================

describe('pushMetrics', () => {
  it('POSTs exposition format to Pushgateway URL', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: vi.fn().mockResolvedValue(''),
    })

    await pushMetrics(
      [{ name: 'test_metric', value: 1, help: 'Test', type: 'gauge' }],
      { url: 'http://localhost:9091/metrics/job/test', fetchFn: mockFetch as unknown as typeof globalThis.fetch },
    )

    expect(mockFetch).toHaveBeenCalledOnce()
    const [url, opts] = mockFetch.mock.calls[0]
    expect(url).toBe('http://localhost:9091/metrics/job/test')
    expect(opts.method).toBe('POST')
    expect(opts.headers['Content-Type']).toBe('text/plain; version=0.0.4')
    expect(opts.body).toContain('test_metric 1')
  })

  it('silently catches fetch errors', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))

    // Should not throw
    await pushMetrics(
      [{ name: 'test_metric', value: 1 }],
      { url: 'http://localhost:9091/metrics/job/test', fetchFn: mockFetch as unknown as typeof globalThis.fetch },
    )
  })

  it('logs warning on non-OK response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: vi.fn().mockResolvedValue('Internal Server Error'),
    })

    // Should not throw
    await pushMetrics(
      [{ name: 'test_metric', value: 1 }],
      { url: 'http://localhost:9091/metrics/job/test', fetchFn: mockFetch as unknown as typeof globalThis.fetch },
    )

    expect(mockFetch).toHaveBeenCalledOnce()
  })
})
