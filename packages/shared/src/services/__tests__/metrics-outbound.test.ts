import { describe, it, expect, beforeEach } from 'vitest'
import { Registry } from 'prom-client'
import {
  recordOutbound,
  timeOutboundCall,
  statusClassFromError,
  getOutboundMetricLines,
  registerOutboundMetrics,
  resetOutboundMetrics,
  OUTBOUND_DURATION_METRIC,
  OUTBOUND_TOTAL_METRIC,
} from '../metrics-outbound.js'

describe('metrics-outbound', () => {
  beforeEach(() => {
    resetOutboundMetrics()
  })

  // -------------------------------------------------------------------------
  // statusClassFromError
  // -------------------------------------------------------------------------

  describe('statusClassFromError', () => {
    it('maps a 4xx status to "4xx"', () => {
      expect(statusClassFromError({ status: 429 })).toBe('4xx')
    })

    it('maps a 5xx status to "5xx"', () => {
      expect(statusClassFromError({ status: 503 })).toBe('5xx')
    })

    it('maps a 2xx status to "2xx"', () => {
      expect(statusClassFromError({ status: 200 })).toBe('2xx')
    })

    it('returns "error" when there is no numeric status', () => {
      expect(statusClassFromError(new Error('ECONNREFUSED'))).toBe('error')
      expect(statusClassFromError({ status: 'nope' })).toBe('error')
      expect(statusClassFromError(null)).toBe('error')
      expect(statusClassFromError(undefined)).toBe('error')
    })
  })

  // -------------------------------------------------------------------------
  // recordOutbound + getOutboundMetricLines (label shape)
  // -------------------------------------------------------------------------

  describe('recordOutbound / getOutboundMetricLines', () => {
    it('records the histogram and counter under {provider, operation, status_class}', async () => {
      recordOutbound('openai', 'chat', '2xx', 1.5)

      const lines = await getOutboundMetricLines()

      const total = lines.find(
        (l) => l.name === OUTBOUND_TOTAL_METRIC && l.labels?.status_class === '2xx',
      )
      expect(total).toBeDefined()
      expect(total?.labels).toEqual({ provider: 'openai', operation: 'chat', status_class: '2xx' })
      expect(total?.value).toBe(1)

      const count = lines.find(
        (l) => l.name === `${OUTBOUND_DURATION_METRIC}_count`,
      )
      expect(count).toBeDefined()
      expect(count?.value).toBe(1)

      const sum = lines.find((l) => l.name === `${OUTBOUND_DURATION_METRIC}_sum`)
      expect(sum?.value).toBeCloseTo(1.5)
    })

    it('emits histogram bucket series with an le label', async () => {
      recordOutbound('anthropic', 'chat', '2xx', 0.3)
      const lines = await getOutboundMetricLines()

      const buckets = lines.filter((l) => l.name === `${OUTBOUND_DURATION_METRIC}_bucket`)
      expect(buckets.length).toBeGreaterThan(0)
      // Every bucket carries the base labels PLUS an le boundary label.
      for (const b of buckets) {
        expect(b.labels?.provider).toBe('anthropic')
        expect(b.labels?.operation).toBe('chat')
        expect(b.labels?.status_class).toBe('2xx')
        expect(typeof b.labels?.le).toBe('string')
      }
    })

    it('NEVER labels with url or host (bounded cardinality)', async () => {
      recordOutbound('openai', 'embedding', '2xx', 0.2)
      recordOutbound('openai_compat', 'chat', '5xx', 4.2)
      const lines = await getOutboundMetricLines()

      expect(lines.length).toBeGreaterThan(0)
      for (const l of lines) {
        expect(l.labels?.url).toBeUndefined()
        expect(l.labels?.host).toBeUndefined()
        expect(l.labels?.baseUrl).toBeUndefined()
        expect(l.labels?.model).toBeUndefined()
      }
    })

    it('separates series by label combination', async () => {
      recordOutbound('openai', 'chat', '2xx', 1)
      recordOutbound('openai', 'chat', '2xx', 1)
      recordOutbound('anthropic', 'chat', '5xx', 2)

      const lines = await getOutboundMetricLines()
      const openaiOk = lines.find(
        (l) =>
          l.name === OUTBOUND_TOTAL_METRIC &&
          l.labels?.provider === 'openai' &&
          l.labels?.status_class === '2xx',
      )
      const anthropicErr = lines.find(
        (l) =>
          l.name === OUTBOUND_TOTAL_METRIC &&
          l.labels?.provider === 'anthropic' &&
          l.labels?.status_class === '5xx',
      )
      expect(openaiOk?.value).toBe(2)
      expect(anthropicErr?.value).toBe(1)
    })

    it('returns no lines before any call', async () => {
      const lines = await getOutboundMetricLines()
      expect(lines).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  // timeOutboundCall
  // -------------------------------------------------------------------------

  describe('timeOutboundCall', () => {
    it('records a 2xx observation on success and returns the result', async () => {
      const result = await timeOutboundCall('openai', 'chat', async () => 'ok')
      expect(result).toBe('ok')

      const lines = await getOutboundMetricLines()
      const total = lines.find(
        (l) => l.name === OUTBOUND_TOTAL_METRIC && l.labels?.status_class === '2xx',
      )
      expect(total?.value).toBe(1)
      expect(total?.labels).toEqual({ provider: 'openai', operation: 'chat', status_class: '2xx' })
    })

    it('records the derived status class on error and re-throws', async () => {
      const err = Object.assign(new Error('rate limited'), { status: 429 })
      await expect(
        timeOutboundCall('openai', 'chat', async () => {
          throw err
        }),
      ).rejects.toBe(err)

      const lines = await getOutboundMetricLines()
      const total = lines.find(
        (l) => l.name === OUTBOUND_TOTAL_METRIC && l.labels?.status_class === '4xx',
      )
      expect(total?.value).toBe(1)
    })

    it('records "error" for a non-HTTP failure', async () => {
      await expect(
        timeOutboundCall('anthropic', 'chat', async () => {
          throw new Error('network down')
        }),
      ).rejects.toThrow('network down')

      const lines = await getOutboundMetricLines()
      const total = lines.find(
        (l) => l.name === OUTBOUND_TOTAL_METRIC && l.labels?.status_class === 'error',
      )
      expect(total?.value).toBe(1)
    })
  })

  // -------------------------------------------------------------------------
  // registerOutboundMetrics
  // -------------------------------------------------------------------------

  describe('registerOutboundMetrics', () => {
    it('registers both metrics into a supplied registry', () => {
      const registry = new Registry()
      registerOutboundMetrics(registry)
      expect(registry.getSingleMetric(OUTBOUND_DURATION_METRIC)).toBeDefined()
      expect(registry.getSingleMetric(OUTBOUND_TOTAL_METRIC)).toBeDefined()
    })

    it('is idempotent — a second call does not throw (double-registration guard)', () => {
      const registry = new Registry()
      registerOutboundMetrics(registry)
      expect(() => registerOutboundMetrics(registry)).not.toThrow()
    })

    it('exports the registered metrics in the registry text output', async () => {
      const registry = new Registry()
      registerOutboundMetrics(registry)
      recordOutbound('openai', 'chat', '2xx', 0.5)
      const text = await registry.metrics()
      expect(text).toContain(OUTBOUND_DURATION_METRIC)
      expect(text).toContain(OUTBOUND_TOTAL_METRIC)
      expect(text).toContain('provider="openai"')
    })
  })
})
