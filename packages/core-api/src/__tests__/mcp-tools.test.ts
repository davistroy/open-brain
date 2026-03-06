import { describe, it, expect, vi, beforeEach } from 'vitest'
import { searchBrainTool } from '../mcp/tools/search-brain.js'
import { listCapturesTool } from '../mcp/tools/list-captures.js'
import { brainStatsTool } from '../mcp/tools/brain-stats.js'
import { captureThoughtTool } from '../mcp/tools/capture-thought.js'
import { getEntityTool } from '../mcp/tools/get-entity.js'
import { listEntitiesTool } from '../mcp/tools/list-entities.js'
import { getWeeklyBriefTool } from '../mcp/tools/get-weekly-brief.js'

// ---------- Mocks ----------

const mockCapture = {
  id: 'c1234567-89ab-cdef-0123-456789abcdef',
  content: 'QSR pricing strategy discussion with client',
  content_raw: null,
  content_hash: 'abc',
  embedding: null,
  capture_type: 'decision',
  brain_view: 'work-internal',
  source: 'slack',
  tags: ['qsr', 'pricing'],
  pipeline_status: 'complete',
  captured_at: new Date('2026-02-01T10:00:00Z'),
  created_at: new Date('2026-02-01T10:00:00Z'),
  updated_at: new Date('2026-02-01T10:00:00Z'),
}

const mockSearchService = {
  search: vi.fn().mockResolvedValue([
    { capture: mockCapture, score: 0.85, ftsScore: 0.8, vectorScore: 0.9 },
  ]),
}

const mockCaptureService = {
  list: vi.fn().mockResolvedValue({ items: [mockCapture], total: 1 }),
  create: vi.fn().mockResolvedValue({
    ...mockCapture,
    id: 'new-capture-id',
    pipeline_status: 'pending',
  }),
  getStats: vi.fn().mockResolvedValue({
    total_captures: 42,
    by_source: { slack: 30, api: 10, voice: 2 },
    by_type: { decision: 10, idea: 15, observation: 17 },
    by_view: { 'work-internal': 20, technical: 12, personal: 10 },
    pipeline_health: { complete: 38, pending: 2, processing: 1, failed: 1 },
    total_entities: 0,
  }),
}

const mockConfigService = {
  getBrainViews: vi.fn().mockReturnValue(['career', 'personal', 'technical', 'work-internal', 'client']),
}

const mockDb = {
  execute: vi.fn(),
}

// ---------- Tests ----------

describe('search_brain tool', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns formatted results', async () => {
    const result = await searchBrainTool(
      { query: 'QSR pricing', limit: 10, threshold: 0.0 },
      mockSearchService as any,
    )
    expect(result).toContain('QSR pricing')
    expect(result).toContain('85%')
    expect(result).toContain('DECISION')
    expect(result).toContain(mockCapture.id)
  })

  it('returns no results message when nothing found', async () => {
    mockSearchService.search.mockResolvedValueOnce([])
    const result = await searchBrainTool(
      { query: 'nonexistent', limit: 10, threshold: 0.0 },
      mockSearchService as any,
    )
    expect(result).toContain('No captures found')
  })

  it('calls SearchService.search with correct params', async () => {
    await searchBrainTool(
      { query: 'test', limit: 5, threshold: 0.0, brain_view: 'technical', days: 7 },
      mockSearchService as any,
    )
    expect(mockSearchService.search).toHaveBeenCalledWith('test', expect.objectContaining({
      limit: 5,
      brainViews: ['technical'],
    }))
  })

  it('filters by source when source_filter provided', async () => {
    const result = await searchBrainTool(
      { query: 'test', limit: 10, threshold: 0.0, source_filter: 'api' },
      mockSearchService as any,
    )
    // Source is 'slack', filter is 'api' — should return no results
    expect(result).toContain('No captures found')
  })
})

describe('list_captures tool', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns formatted capture list', async () => {
    const result = await listCapturesTool({ limit: 20 }, mockCaptureService as any)
    expect(result).toContain('DECISION')
    expect(result).toContain(mockCapture.id)
    expect(result).toContain('1 of 1 total')
  })

  it('returns no captures message when empty', async () => {
    mockCaptureService.list.mockResolvedValueOnce({ items: [], total: 0 })
    const result = await listCapturesTool({ limit: 20 }, mockCaptureService as any)
    expect(result).toContain('No captures found')
  })

  it('shows all pipeline statuses (not filtered to complete)', async () => {
    const pendingCapture = { ...mockCapture, pipeline_status: 'pending' }
    mockCaptureService.list.mockResolvedValueOnce({ items: [pendingCapture], total: 1 })
    const result = await listCapturesTool({ limit: 20 }, mockCaptureService as any)
    expect(result).toContain('pending')
  })
})

describe('brain_stats tool', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns formatted statistics', async () => {
    const result = await brainStatsTool({ period: 'all' }, mockCaptureService as any)
    expect(result).toContain('Brain Statistics')
    expect(result).toContain('42')
    expect(result).toContain('slack: 30')
    expect(result).toContain('complete:   38')
    expect(result).toContain('failed:     1')
  })

  it('includes period in output', async () => {
    const result = await brainStatsTool({ period: 'week' }, mockCaptureService as any)
    expect(result).toContain('week')
  })
})

describe('capture_thought tool', () => {
  beforeEach(() => vi.clearAllMocks())

  it('creates a capture and returns confirmation', async () => {
    const result = await captureThoughtTool(
      { content: 'New idea about QSR ops', tags: ['qsr'], brain_view: 'work-internal' },
      mockCaptureService as any,
      mockConfigService as any,
    )
    expect(result).toContain('Captured successfully')
    expect(result).toContain('new-capture-id')
    expect(result).toContain('pipeline')
  })

  it('uses default brain_view when provided view is invalid', async () => {
    await captureThoughtTool(
      { content: 'test', brain_view: 'invalid-view' },
      mockCaptureService as any,
      mockConfigService as any,
    )
    expect(mockCaptureService.create).toHaveBeenCalledWith(expect.objectContaining({
      brain_view: 'career', // first valid view
    }))
  })

  it('uses mcp as source', async () => {
    await captureThoughtTool(
      { content: 'test' },
      mockCaptureService as any,
      mockConfigService as any,
    )
    expect(mockCaptureService.create).toHaveBeenCalledWith(expect.objectContaining({
      source: 'mcp',
    }))
  })
})

describe('get_entity tool', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns entity not available message when entities table missing', async () => {
    mockDb.execute.mockRejectedValue(new Error('relation "entities" does not exist'))
    const result = await getEntityTool({ name: 'Coca-Cola' }, mockDb as any)
    expect(result).toContain('not yet available')
  })

  it('returns not found message when entity missing', async () => {
    mockDb.execute.mockResolvedValue({ rows: [] })
    const result = await getEntityTool({ name: 'Unknown Person' }, mockDb as any)
    expect(result).toContain('No entity found')
  })

  it('returns entity details when found', async () => {
    mockDb.execute.mockResolvedValue({
      rows: [{
        id: 'e1234567-89ab-cdef-0123-456789abcdef',
        name: 'Coca-Cola',
        entity_type: 'organization',
        mention_count: 15,
        last_seen_at: '2026-02-01T10:00:00Z',
      }],
    })
    const result = await getEntityTool({ name: 'Coca-Cola' }, mockDb as any)
    expect(result).toContain('Coca-Cola')
    expect(result).toContain('organization')
    expect(result).toContain('15')
  })
})

describe('list_entities tool', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns not available message when entities table missing', async () => {
    mockDb.execute.mockRejectedValue(new Error('relation "entities" does not exist'))
    const result = await listEntitiesTool({ sort_by: 'mention_count', limit: 20 }, mockDb as any)
    expect(result).toContain('not yet available')
  })

  it('returns no entities message when empty', async () => {
    mockDb.execute.mockResolvedValue({ rows: [] })
    const result = await listEntitiesTool({ sort_by: 'mention_count', limit: 20 }, mockDb as any)
    expect(result).toContain('No entities found')
  })
})

describe('get_weekly_brief tool', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns not available message when skills_log table missing', async () => {
    mockDb.execute.mockRejectedValue(new Error('relation "skills_log" does not exist'))
    const result = await getWeeklyBriefTool({ weeks_ago: 0 }, mockDb as any)
    expect(result).toContain('not yet available')
  })

  it('returns no briefs message when table empty', async () => {
    mockDb.execute.mockResolvedValue({ rows: [] })
    const result = await getWeeklyBriefTool({ weeks_ago: 0 }, mockDb as any)
    expect(result).toContain('No weekly briefs generated yet')
  })

  it('returns brief content when found', async () => {
    mockDb.execute.mockResolvedValue({
      rows: [{
        id: 'b1234567-89ab-cdef-0123-456789abcdef',
        skill_name: 'weekly-brief',
        output: { content: 'This week you captured 15 items across 3 views...' },
        created_at: '2026-03-01T09:00:00Z',
      }],
    })
    const result = await getWeeklyBriefTool({ weeks_ago: 0 }, mockDb as any)
    expect(result).toContain('Weekly Brief')
    expect(result).toContain('This week you captured')
  })
})
