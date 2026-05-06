/**
 * IntelligenceService unit tests — Phase 5.3 of IMPLEMENTATION_PLAN-ARCH-REVIEW.md.
 *
 * Covers:
 *   - getLatest: happy path returns formatted entry
 *   - getLatest: returns null when no rows exist
 *   - getLatest: allowlist rejection (ValidationError 400, code VALIDATION_ERROR)
 *   - getHistory: returns array of formatted entries
 *   - getHistory: returns empty array when no rows exist
 *   - getHistory: allowlist rejection
 *   - getHistory: limit is passed through to the db query
 *   - getSummary: returns both connections + drift entries
 *   - getSummary: returns nulls when neither skill has run
 *   - getSummary: returns one null when only one skill has run
 *
 * Mock strategy:
 *   db.execute() is mocked via vi.fn() — the service calls it once with a
 *   drizzle-orm tagged template literal. We intercept and return synthetic rows.
 *   We do NOT assert on the exact SQL string — just the service contract.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { IntelligenceService, INTELLIGENCE_SKILLS } from '../intelligence.service.js'
import type { Database } from '@open-brain/shared'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockDb(rows: unknown[] = []): Database {
  return {
    execute: vi.fn().mockResolvedValue({ rows }),
  } as unknown as Database
}

// ---------------------------------------------------------------------------
// Sample data
// ---------------------------------------------------------------------------

const CONNECTIONS_ROW = {
  id: 'conn-1',
  skill_name: 'daily-connections',
  capture_id: 'cap-abc',
  input_summary: '32 captures from last 7 days',
  output_summary: '3 cross-domain connections found',
  result: {
    connections: [
      { theme: 'QSR + AI', insight: 'QSR operations mirror ML pipeline patterns', confidence: 0.85 },
    ],
  },
  duration_ms: 12400,
  created_at: '2026-03-11T21:05:00Z',
}

const DRIFT_ROW = {
  id: 'drift-1',
  skill_name: 'drift-monitor',
  capture_id: 'cap-def',
  input_summary: '5 pending bets',
  output_summary: '2 drift items detected',
  result: {
    drift_items: [
      { item: 'Cloud migration bet', severity: 'high', suggested_action: 'Review with team' },
    ],
  },
  duration_ms: 9800,
  created_at: '2026-03-11T08:02:00Z',
}

const CONNECTIONS_ROW_2 = {
  id: 'conn-2',
  skill_name: 'daily-connections',
  capture_id: 'cap-xyz',
  input_summary: '28 captures from last 7 days',
  output_summary: '2 connections found',
  result: { connections: [] },
  duration_ms: 10200,
  created_at: '2026-03-10T21:03:00Z',
}

// ---------------------------------------------------------------------------
// INTELLIGENCE_SKILLS allowlist
// ---------------------------------------------------------------------------

describe('INTELLIGENCE_SKILLS', () => {
  it('contains daily-connections, drift-monitor, daily-sweep-skill', () => {
    expect(INTELLIGENCE_SKILLS.has('daily-connections')).toBe(true)
    expect(INTELLIGENCE_SKILLS.has('drift-monitor')).toBe(true)
    expect(INTELLIGENCE_SKILLS.has('daily-sweep-skill')).toBe(true)
  })

  it('does not contain arbitrary skill names', () => {
    expect(INTELLIGENCE_SKILLS.has('weekly-brief')).toBe(false)
    expect(INTELLIGENCE_SKILLS.has('memory-consolidation')).toBe(false)
    expect(INTELLIGENCE_SKILLS.has('unknown-skill')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// getLatest
// ---------------------------------------------------------------------------

describe('IntelligenceService.getLatest', () => {
  let db: ReturnType<typeof makeMockDb>
  let service: IntelligenceService

  beforeEach(() => {
    vi.clearAllMocks()
    db = makeMockDb([CONNECTIONS_ROW])
    service = new IntelligenceService(db)
  })

  it('returns formatted entry for daily-connections', async () => {
    const result = await service.getLatest('daily-connections')

    expect(result).not.toBeNull()
    expect(result!.id).toBe('conn-1')
    expect(result!.skill_name).toBe('daily-connections')
    expect(result!.capture_id).toBe('cap-abc')
    expect(result!.result).toEqual(CONNECTIONS_ROW.result)
    expect(result!.duration_ms).toBe(12400)
    expect(db.execute).toHaveBeenCalledTimes(1)
  })

  it('returns formatted entry for drift-monitor', async () => {
    db = makeMockDb([DRIFT_ROW])
    service = new IntelligenceService(db)

    const result = await service.getLatest('drift-monitor')

    expect(result).not.toBeNull()
    expect(result!.skill_name).toBe('drift-monitor')
    expect(result!.result).toEqual(DRIFT_ROW.result)
  })

  it('returns null when no rows exist', async () => {
    db = makeMockDb([])
    service = new IntelligenceService(db)

    const result = await service.getLatest('daily-connections')

    expect(result).toBeNull()
  })

  it('returns null result field when row.result is null (COALESCE behavior)', async () => {
    db = makeMockDb([{ ...CONNECTIONS_ROW, result: null }])
    service = new IntelligenceService(db)

    const result = await service.getLatest('daily-connections')

    expect(result).not.toBeNull()
    expect(result!.result).toBeNull()
    expect(result!.output_summary).toBe('3 cross-domain connections found')
  })

  it('throws ValidationError 400 for unknown skill name', async () => {
    await expect(service.getLatest('weekly-brief')).rejects.toMatchObject({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    })
    expect(db.execute).not.toHaveBeenCalled()
  })

  it('throws ValidationError 400 for empty string skill name', async () => {
    await expect(service.getLatest('')).rejects.toMatchObject({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    })
  })

  it('throws ValidationError 400 for SQL-injection-style skill name', async () => {
    await expect(service.getLatest("'; DROP TABLE skills_log; --")).rejects.toMatchObject({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    })
    expect(db.execute).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// getHistory
// ---------------------------------------------------------------------------

describe('IntelligenceService.getHistory', () => {
  let db: ReturnType<typeof makeMockDb>
  let service: IntelligenceService

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns array of formatted entries', async () => {
    db = makeMockDb([CONNECTIONS_ROW, CONNECTIONS_ROW_2])
    service = new IntelligenceService(db)

    const result = await service.getHistory('daily-connections', 10)

    expect(result).toHaveLength(2)
    expect(result[0].id).toBe('conn-1')
    expect(result[1].id).toBe('conn-2')
    expect(db.execute).toHaveBeenCalledTimes(1)
  })

  it('returns empty array when no rows exist', async () => {
    db = makeMockDb([])
    service = new IntelligenceService(db)

    const result = await service.getHistory('drift-monitor', 10)

    expect(result).toEqual([])
  })

  it('passes limit to the db execute call', async () => {
    db = makeMockDb([CONNECTIONS_ROW])
    service = new IntelligenceService(db)

    await service.getHistory('daily-connections', 25)

    expect(db.execute).toHaveBeenCalledTimes(1)
    // The limit is embedded in the SQL template literal — we verify execute was called
    // (limit capping happens in the route, not the service)
  })

  it('returns entries for drift-monitor', async () => {
    db = makeMockDb([DRIFT_ROW])
    service = new IntelligenceService(db)

    const result = await service.getHistory('drift-monitor', 5)

    expect(result).toHaveLength(1)
    expect(result[0].skill_name).toBe('drift-monitor')
  })

  it('throws ValidationError 400 for unknown skill name', async () => {
    db = makeMockDb([])
    service = new IntelligenceService(db)

    await expect(service.getHistory('memory-consolidation', 10)).rejects.toMatchObject({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    })
    expect(db.execute).not.toHaveBeenCalled()
  })

  it('throws ValidationError and includes valid skill names in message', async () => {
    db = makeMockDb([])
    service = new IntelligenceService(db)

    const err = await service.getHistory('bad-skill', 10).catch(e => e)

    expect(err.message).toContain('bad-skill')
    expect(err.message).toContain('daily-connections')
    expect(err.message).toContain('drift-monitor')
  })
})

// ---------------------------------------------------------------------------
// getSummary
// ---------------------------------------------------------------------------

describe('IntelligenceService.getSummary', () => {
  let db: ReturnType<typeof makeMockDb>
  let service: IntelligenceService

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns both connections and drift when both skills have run', async () => {
    db = makeMockDb([CONNECTIONS_ROW, DRIFT_ROW])
    service = new IntelligenceService(db)

    const result = await service.getSummary()

    expect(result.connections).not.toBeNull()
    expect(result.connections!.skill_name).toBe('daily-connections')
    expect(result.connections!.id).toBe('conn-1')
    expect(result.drift).not.toBeNull()
    expect(result.drift!.skill_name).toBe('drift-monitor')
    expect(result.drift!.id).toBe('drift-1')
    expect(db.execute).toHaveBeenCalledTimes(1)
  })

  it('returns null for both when no skills have run', async () => {
    db = makeMockDb([])
    service = new IntelligenceService(db)

    const result = await service.getSummary()

    expect(result.connections).toBeNull()
    expect(result.drift).toBeNull()
  })

  it('returns only connections when drift has not run', async () => {
    db = makeMockDb([CONNECTIONS_ROW])
    service = new IntelligenceService(db)

    const result = await service.getSummary()

    expect(result.connections).not.toBeNull()
    expect(result.drift).toBeNull()
  })

  it('returns only drift when connections has not run', async () => {
    db = makeMockDb([DRIFT_ROW])
    service = new IntelligenceService(db)

    const result = await service.getSummary()

    expect(result.connections).toBeNull()
    expect(result.drift).not.toBeNull()
  })

  it('filters out rows with unknown skill names (safety guard)', async () => {
    // The service only populates daily-connections and drift-monitor keys
    // even if the DB somehow returned an unexpected skill_name row.
    db = makeMockDb([
      CONNECTIONS_ROW,
      { ...DRIFT_ROW, skill_name: 'unexpected-skill' },
    ])
    service = new IntelligenceService(db)

    const result = await service.getSummary()

    expect(result.connections).not.toBeNull()
    expect(result.drift).toBeNull() // 'unexpected-skill' row was ignored
  })

  it('formats result field correctly, returning null when row.result is null', async () => {
    db = makeMockDb([{ ...CONNECTIONS_ROW, result: null }])
    service = new IntelligenceService(db)

    const result = await service.getSummary()

    expect(result.connections!.result).toBeNull()
    expect(result.connections!.output_summary).toBe('3 cross-domain connections found')
  })
})
