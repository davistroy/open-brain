import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  assembleContext,
  formatCapture,
  fmtDate,
  queryCaptures,
  VIEW_ORDER,
  CHARS_PER_TOKEN,
  DEFAULT_TOKEN_BUDGET,
} from '../skills/weekly-brief-query.js'
import type { CaptureRecord } from '@open-brain/shared'

// ============================================================
// Fixtures
// ============================================================

function makeCapture(overrides: Partial<CaptureRecord> = {}): CaptureRecord {
  return {
    id: 'cap-1',
    content: 'Test capture content.',
    capture_type: 'observation',
    brain_view: 'technical',
    source: 'api',
    tags: [],
    captured_at: new Date('2026-03-01T10:00:00Z'),
    created_at: new Date('2026-03-01T10:00:00Z'),
    updated_at: new Date('2026-03-01T10:00:00Z'),
    content_hash: 'hash1',
    pipeline_status: 'complete',
    pipeline_attempts: 1,
    ...overrides,
  } as CaptureRecord
}

const MULTI_VIEW_CAPTURES: CaptureRecord[] = [
  makeCapture({ id: 'c1', brain_view: 'career', content: 'Career capture', captured_at: new Date('2026-03-05') }),
  makeCapture({ id: 'c2', brain_view: 'career', content: 'Another career capture', captured_at: new Date('2026-03-04') }),
  makeCapture({ id: 'c3', brain_view: 'client', content: 'Client work capture', captured_at: new Date('2026-03-05') }),
  makeCapture({ id: 'c4', brain_view: 'technical', content: 'Technical capture', captured_at: new Date('2026-03-03') }),
  makeCapture({ id: 'c5', brain_view: 'personal', content: 'Personal note', captured_at: new Date('2026-03-02') }),
  makeCapture({ id: 'c6', brain_view: 'custom-view', content: 'Custom view capture', captured_at: new Date('2026-03-01') }),
]

// ============================================================
// Tests: fmtDate
// ============================================================

describe('fmtDate', () => {
  it('formats a Date as YYYY-MM-DD', () => {
    expect(fmtDate(new Date('2026-03-10T14:30:00Z'))).toBe('2026-03-10')
  })

  it('handles year boundaries', () => {
    expect(fmtDate(new Date('2025-12-31T23:59:59Z'))).toBe('2025-12-31')
  })
})

// ============================================================
// Tests: formatCapture
// ============================================================

describe('formatCapture', () => {
  it('formats a capture with date, type, and content', () => {
    const c = makeCapture({ capture_type: 'win', content: 'Shipped feature X' })
    const result = formatCapture(c)
    expect(result).toContain('[2026-03-01]')
    expect(result).toContain('[win]')
    expect(result).toContain('Shipped feature X')
  })

  it('includes tags when present', () => {
    const c = makeCapture({ tags: ['alpha', 'beta'] })
    const result = formatCapture(c)
    expect(result).toContain('[alpha, beta]')
  })

  it('omits tag brackets when tags are empty', () => {
    const c = makeCapture({ tags: [] })
    const result = formatCapture(c)
    expect(result).not.toContain('[]')
  })

  it('ends with a newline', () => {
    const result = formatCapture(makeCapture())
    expect(result.endsWith('\n')).toBe(true)
  })
})

// ============================================================
// Tests: assembleContext
// ============================================================

describe('assembleContext', () => {
  it('groups captures by brain_view with section headers', () => {
    const { contextText } = assembleContext(MULTI_VIEW_CAPTURES, 100_000)
    expect(contextText).toContain('=== CAREER')
    expect(contextText).toContain('=== CLIENT')
    expect(contextText).toContain('=== TECHNICAL')
    expect(contextText).toContain('=== PERSONAL')
  })

  it('follows VIEW_ORDER for configured views', () => {
    const { contextText } = assembleContext(MULTI_VIEW_CAPTURES, 100_000)
    const careerIdx = contextText.indexOf('=== CAREER')
    const clientIdx = contextText.indexOf('=== CLIENT')
    const technicalIdx = contextText.indexOf('=== TECHNICAL')
    const personalIdx = contextText.indexOf('=== PERSONAL')

    // VIEW_ORDER: career, work-internal, client, technical, personal
    expect(careerIdx).toBeLessThan(clientIdx)
    expect(clientIdx).toBeLessThan(technicalIdx)
    expect(technicalIdx).toBeLessThan(personalIdx)
  })

  it('places unknown views after configured views', () => {
    const { contextText } = assembleContext(MULTI_VIEW_CAPTURES, 100_000)
    const personalIdx = contextText.indexOf('=== PERSONAL')
    const customIdx = contextText.indexOf('=== CUSTOM-VIEW')
    expect(personalIdx).toBeLessThan(customIdx)
  })

  it('returns capturesByView with correct counts', () => {
    const { capturesByView } = assembleContext(MULTI_VIEW_CAPTURES, 100_000)
    expect(capturesByView['career']).toBe(2)
    expect(capturesByView['client']).toBe(1)
    expect(capturesByView['technical']).toBe(1)
    expect(capturesByView['personal']).toBe(1)
    expect(capturesByView['custom-view']).toBe(1)
  })

  it('includes capture count in section header', () => {
    const { contextText } = assembleContext(MULTI_VIEW_CAPTURES, 100_000)
    expect(contextText).toContain('=== CAREER (2 captures) ===')
    expect(contextText).toContain('=== CLIENT (1 captures) ===')
  })

  it('truncates when maxChars is exceeded', () => {
    const largeCaps = Array.from({ length: 50 }, (_, i) =>
      makeCapture({ id: `c-${i}`, brain_view: 'technical', content: 'x'.repeat(200), content_hash: `h-${i}` }),
    )
    // 50 captures * ~220 chars each ≈ 11,000 chars. Budget 500 chars.
    const { contextText } = assembleContext(largeCaps, 500)
    // Should have far fewer than 50 captures in the output
    const matches = contextText.match(/\[observation\]/g)
    expect(matches).toBeTruthy()
    expect(matches!.length).toBeLessThan(50)
  })

  it('returns empty contextText for empty captures', () => {
    const { contextText, capturesByView } = assembleContext([], 100_000)
    expect(contextText).toBe('')
    expect(Object.keys(capturesByView)).toHaveLength(0)
  })

  it('handles captures with null brain_view as "unknown"', () => {
    const cap = makeCapture({ brain_view: undefined as any })
    const { contextText } = assembleContext([cap], 100_000)
    expect(contextText).toContain('=== UNKNOWN')
  })
})

// ============================================================
// Tests: queryCaptures
// ============================================================

describe('queryCaptures', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('calls db.execute with date range filter', async () => {
    const mockDb = {
      execute: vi.fn().mockResolvedValue({ rows: [] }),
    }

    const from = new Date('2026-03-01')
    const to = new Date('2026-03-07')
    const result = await queryCaptures(mockDb as any, from, to)

    expect(mockDb.execute).toHaveBeenCalledOnce()
    expect(result).toEqual([])
  })

  it('returns rows from db result', async () => {
    const captures = [makeCapture()]
    const mockDb = {
      execute: vi.fn().mockResolvedValue({ rows: captures }),
    }

    const result = await queryCaptures(mockDb as any, new Date('2026-03-01'), new Date('2026-03-07'))
    expect(result).toEqual(captures)
  })
})

// ============================================================
// Tests: constants
// ============================================================

describe('constants', () => {
  it('VIEW_ORDER contains all 5 brain views', () => {
    expect(VIEW_ORDER).toEqual(['career', 'work-internal', 'client', 'technical', 'personal'])
  })

  it('CHARS_PER_TOKEN is 4', () => {
    expect(CHARS_PER_TOKEN).toBe(4)
  })

  it('DEFAULT_TOKEN_BUDGET is 50_000', () => {
    expect(DEFAULT_TOKEN_BUDGET).toBe(50_000)
  })
})
