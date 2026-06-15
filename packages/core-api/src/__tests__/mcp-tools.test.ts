import { describe, it, expect, vi, beforeEach } from 'vitest'
import { searchBrainTool } from '../mcp/tools/search-brain.js'
import { listCapturesTool } from '../mcp/tools/list-captures.js'
import { brainStatsTool } from '../mcp/tools/brain-stats.js'
import { captureThoughtTool } from '../mcp/tools/capture-thought.js'
import { getEntityTool } from '../mcp/tools/get-entity.js'
import { listEntitiesTool } from '../mcp/tools/list-entities.js'
import { getWeeklyBriefTool } from '../mcp/tools/get-weekly-brief.js'
import { getCaptureTool } from '../mcp/tools/get-capture.js'

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

const mockRelatedCapture = {
  id: 'r1234567-89ab-cdef-0123-456789abcdef',
  content: 'Related restaurant operations finding',
  content_raw: null,
  content_hash: 'def',
  embedding: null,
  capture_type: 'observation',
  brain_view: 'work-internal',
  source: 'api',
  tags: ['restaurant'],
  pipeline_status: 'complete',
  captured_at: new Date('2026-02-02T14:00:00Z'),
  created_at: new Date('2026-02-02T14:00:00Z'),
  updated_at: new Date('2026-02-02T14:00:00Z'),
}

const mockSearchService = {
  search: vi.fn().mockResolvedValue([
    { capture: mockCapture, score: 0.85, ftsScore: 0.8, vectorScore: 0.9 },
  ]),
  searchWithRelated: vi.fn().mockResolvedValue({
    results: [
      { capture: mockCapture, score: 0.85, ftsScore: 0.8, vectorScore: 0.9 },
    ],
    relatedResults: [
      { capture: mockRelatedCapture, score: 0.62 },
    ],
  }),
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
  beforeEach(() => { vi.clearAllMocks() })

  it('returns formatted results', async () => {
    const result = await searchBrainTool(
      { query: 'QSR pricing', limit: 10, threshold: 0.0, include_related: true },
      mockSearchService as any,
    )
    expect(result).toContain('QSR pricing')
    expect(result).toContain('85%')
    expect(result).toContain('DECISION')
    expect(result).toContain(mockCapture.id)
  })

  it('returns no results message when nothing found', async () => {
    mockSearchService.searchWithRelated.mockResolvedValueOnce({ results: [], relatedResults: [] })
    const result = await searchBrainTool(
      { query: 'nonexistent', limit: 10, threshold: 0.0, include_related: true },
      mockSearchService as any,
    )
    expect(result).toContain('No captures found')
  })

  it('calls SearchService.searchWithRelated with correct params', async () => {
    await searchBrainTool(
      { query: 'test', limit: 5, threshold: 0.0, brain_view: 'technical', days: 7, include_related: true },
      mockSearchService as any,
    )
    expect(mockSearchService.searchWithRelated).toHaveBeenCalledWith('test', expect.objectContaining({
      limit: 5,
      brainViews: ['technical'],
      includeRelated: true,
    }))
  })

  it('filters by source when source_filter provided', async () => {
    const result = await searchBrainTool(
      { query: 'test', limit: 10, threshold: 0.0, source_filter: 'api', include_related: true },
      mockSearchService as any,
    )
    // Source is 'slack', filter is 'api' — should return no results
    expect(result).toContain('No captures found')
  })

  it('filters by tag_filter: only captures with ALL requested tags pass', async () => {
    // mockCapture has tags ['qsr', 'pricing'] — matches tag_filter ['qsr']
    const resultMatch = await searchBrainTool(
      { query: 'test', limit: 10, threshold: 0.0, tag_filter: ['qsr'], include_related: true },
      mockSearchService as any,
    )
    expect(resultMatch).toContain(mockCapture.id)
    expect(resultMatch).not.toContain('No captures found')

    // tag_filter ['qsr', 'pricing'] — still matches (AND: capture has both)
    mockSearchService.searchWithRelated.mockResolvedValueOnce({
      results: [{ capture: mockCapture, score: 0.85, ftsScore: 0.8, vectorScore: 0.9 }],
      relatedResults: [],
    })
    const resultBothTags = await searchBrainTool(
      { query: 'test', limit: 10, threshold: 0.0, tag_filter: ['qsr', 'pricing'], include_related: true },
      mockSearchService as any,
    )
    expect(resultBothTags).toContain(mockCapture.id)

    // tag_filter ['restaurant'] — mockCapture lacks 'restaurant'; should return no results
    mockSearchService.searchWithRelated.mockResolvedValueOnce({
      results: [{ capture: mockCapture, score: 0.85, ftsScore: 0.8, vectorScore: 0.9 }],
      relatedResults: [],
    })
    const resultNoMatch = await searchBrainTool(
      { query: 'test', limit: 10, threshold: 0.0, tag_filter: ['restaurant'], include_related: true },
      mockSearchService as any,
    )
    expect(resultNoMatch).toContain('No captures found')
  })

  it('includes related captures section when include_related is true', async () => {
    const result = await searchBrainTool(
      { query: 'QSR pricing', limit: 10, threshold: 0.0, include_related: true },
      mockSearchService as any,
    )
    expect(result).toContain('Related captures (via entity graph)')
    expect(result).toContain(mockRelatedCapture.id)
    expect(result).toContain('OBSERVATION')
    expect(result).toContain('62%')
  })

  it('omits related captures section when include_related is false', async () => {
    mockSearchService.searchWithRelated.mockResolvedValueOnce({
      results: [
        { capture: mockCapture, score: 0.85, ftsScore: 0.8, vectorScore: 0.9 },
      ],
      // No relatedResults when includeRelated=false
    })
    const result = await searchBrainTool(
      { query: 'QSR pricing', limit: 10, threshold: 0.0, include_related: false },
      mockSearchService as any,
    )
    expect(result).not.toContain('Related captures')
    expect(result).toContain('DECISION')
  })

  it('omits related section when related results are empty', async () => {
    mockSearchService.searchWithRelated.mockResolvedValueOnce({
      results: [
        { capture: mockCapture, score: 0.85, ftsScore: 0.8, vectorScore: 0.9 },
      ],
      relatedResults: [],
    })
    const result = await searchBrainTool(
      { query: 'QSR pricing', limit: 10, threshold: 0.0, include_related: true },
      mockSearchService as any,
    )
    expect(result).not.toContain('Related captures')
  })

  it('passes includeRelated=false to searchWithRelated when disabled', async () => {
    mockSearchService.searchWithRelated.mockResolvedValueOnce({
      results: [
        { capture: mockCapture, score: 0.85, ftsScore: 0.8, vectorScore: 0.9 },
      ],
    })
    await searchBrainTool(
      { query: 'test', limit: 10, threshold: 0.0, include_related: false },
      mockSearchService as any,
    )
    expect(mockSearchService.searchWithRelated).toHaveBeenCalledWith('test', expect.objectContaining({
      includeRelated: false,
    }))
  })
})

describe('list_captures tool', () => {
  beforeEach(() => { vi.clearAllMocks() })

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
  beforeEach(() => { vi.clearAllMocks() })

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
  beforeEach(() => { vi.clearAllMocks() })

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
  beforeEach(() => { vi.clearAllMocks() })

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
  beforeEach(() => { vi.clearAllMocks() })

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
  beforeEach(() => { vi.clearAllMocks() })

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

  it('returns brief content from result JSONB when available', async () => {
    mockDb.execute.mockResolvedValue({
      rows: [{
        id: 'b1234567-89ab-cdef-0123-456789abcdef',
        skill_name: 'weekly-brief',
        output_summary: 'Truncated summary...',
        result: { content: 'This week you captured 15 items across 3 views...' },
        created_at: '2026-03-01T09:00:00Z',
      }],
    })
    const result = await getWeeklyBriefTool({ weeks_ago: 0 }, mockDb as any)
    expect(result).toContain('Weekly Brief')
    expect(result).toContain('This week you captured')
    // Should prefer result over output_summary
    expect(result).not.toContain('Truncated summary')
  })

  it('falls back to output_summary when result is null', async () => {
    mockDb.execute.mockResolvedValue({
      rows: [{
        id: 'b1234567-89ab-cdef-0123-456789abcdef',
        skill_name: 'weekly-brief',
        output_summary: 'Fallback summary text',
        result: null,
        created_at: '2026-03-01T09:00:00Z',
      }],
    })
    const result = await getWeeklyBriefTool({ weeks_ago: 0 }, mockDb as any)
    expect(result).toContain('Fallback summary text')
  })
})

describe('get_capture tool', () => {
  beforeEach(() => { vi.clearAllMocks() })

  const mockCaptureServiceForGet = {
    getById: vi.fn().mockResolvedValue({
      ...mockCapture,
      source_metadata: { channel: '#general' },
    }),
  }

  it('returns full capture content', async () => {
    mockDb.execute.mockResolvedValue({ rows: [] }) // no linked entities
    const result = await getCaptureTool(
      { id: mockCapture.id },
      mockCaptureServiceForGet as any,
      mockDb as any,
    )
    expect(result).toContain('DECISION')
    expect(result).toContain(mockCapture.id)
    expect(result).toContain(mockCapture.content)
    expect(result).toContain('work-internal')
    expect(result).toContain('qsr, pricing')
  })

  it('includes linked entities when present', async () => {
    mockDb.execute.mockResolvedValue({
      rows: [
        { name: 'Coca-Cola', type: 'organization', relationship: 'mentioned_in' },
        { name: 'Troy Davis', type: 'person', relationship: null },
      ],
    })
    const result = await getCaptureTool(
      { id: mockCapture.id },
      mockCaptureServiceForGet as any,
      mockDb as any,
    )
    expect(result).toContain('Linked Entities')
    expect(result).toContain('Coca-Cola [organization]')
    expect(result).toContain('Troy Davis [person]')
  })

  it('includes source metadata when present', async () => {
    mockDb.execute.mockResolvedValue({ rows: [] })
    const result = await getCaptureTool(
      { id: mockCapture.id },
      mockCaptureServiceForGet as any,
      mockDb as any,
    )
    expect(result).toContain('channel: #general')
  })

  it('handles missing entity table gracefully', async () => {
    mockDb.execute.mockRejectedValue(new Error('relation "entity_links" does not exist'))
    const result = await getCaptureTool(
      { id: mockCapture.id },
      mockCaptureServiceForGet as any,
      mockDb as any,
    )
    // Should not throw, just skip entities section
    expect(result).toContain(mockCapture.content)
    expect(result).not.toContain('Linked Entities')
  })
})
