/**
 * Unit tests — dashboard-mappers.
 *
 * Focus: the pipeline health-status derivation (issue #200). The dashboard used
 * to read "degraded" permanently whenever ANY capture had ever terminally
 * failed (`failed > 0`), so a couple of months-old failures pinned it there with
 * no number shown. The rule now decouples the health LABEL from the stale
 * all-time failure count — failures are surfaced as their own number
 * (`pipeline_failed`) and only a real flood (or a live backlog) degrades health.
 */

import { describe, expect, it } from 'vitest'
import type { StatsResponse } from '@/lib/api-client'
import { derivePipelineStatus, mapStatsToDashboard } from '../dashboard-mappers'

function makeStats(overrides?: Partial<StatsResponse['pipeline_health']>): StatsResponse {
  return {
    total_captures: 11287,
    by_type: {},
    by_view: {},
    by_source: {},
    pipeline_health: {
      pending: 0,
      processing: 0,
      complete: 11287,
      failed: 0,
      ...overrides,
    },
  }
}

describe('derivePipelineStatus', () => {
  it('is healthy for a clean pipeline', () => {
    expect(derivePipelineStatus(0, 0)).toBe('healthy')
  })

  it('#200: a few stale terminal failures do NOT degrade health', () => {
    // The regression this change fixes — 2 old failed captures must read healthy.
    expect(derivePipelineStatus(2, 0)).toBe('healthy')
  })

  it('keeps a high failure bar: a real failure flood is unhealthy', () => {
    expect(derivePipelineStatus(50, 0)).toBe('healthy') // boundary: >50
    expect(derivePipelineStatus(51, 0)).toBe('unhealthy')
  })

  it('degrades on a live backlog', () => {
    expect(derivePipelineStatus(0, 50)).toBe('healthy') // boundary: >50
    expect(derivePipelineStatus(0, 51)).toBe('degraded')
  })

  it('is unhealthy on a severe backlog', () => {
    expect(derivePipelineStatus(0, 100)).toBe('degraded') // boundary: >100
    expect(derivePipelineStatus(0, 101)).toBe('unhealthy')
  })
})

describe('mapStatsToDashboard', () => {
  it('#200: surfaces the terminal-failure count and stays healthy for stale failures', () => {
    const result = mapStatsToDashboard(makeStats({ failed: 2, processing: 3, pending: 0 }))
    expect(result.pipeline_failed).toBe(2)
    expect(result.pipeline_status).toBe('healthy')
    expect(result.pipeline_active).toBe(3)
    expect(result.pipeline_queued).toBe(0)
  })

  it('reports zero failures cleanly', () => {
    const result = mapStatsToDashboard(makeStats({ failed: 0 }))
    expect(result.pipeline_failed).toBe(0)
    expect(result.pipeline_status).toBe('healthy')
  })

  it('degrades on backlog and flags a failure flood as unhealthy', () => {
    expect(mapStatsToDashboard(makeStats({ pending: 60 })).pipeline_status).toBe('degraded')
    expect(mapStatsToDashboard(makeStats({ failed: 60 })).pipeline_status).toBe('unhealthy')
  })
})
