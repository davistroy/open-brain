import { http, HttpResponse } from 'msw'

// ---------------------------------------------------------------------------
// Captures — GET /api/v1/captures
// Shape: { items: Capture[], total: number, limit: number, offset: number }
// ---------------------------------------------------------------------------
const mockCaptures = [
  {
    id: 'cap-001',
    content: 'Decided to use Cloudscape Design System for the web-next UI rebuild.',
    capture_type: 'decision',
    brain_view: 'technical',
    source: 'api',
    pipeline_status: 'complete',
    tags: ['ui', 'design-system'],
    metadata: {},
    created_at: '2026-04-20T10:00:00.000Z',
    updated_at: '2026-04-20T10:05:00.000Z',
    deleted_at: null,
  },
  {
    id: 'cap-002',
    content: 'Sailing race this weekend — check NOAA for wind forecast.',
    capture_type: 'task',
    brain_view: 'personal',
    source: 'slack',
    pipeline_status: 'complete',
    tags: ['sailing'],
    metadata: {},
    created_at: '2026-04-19T08:30:00.000Z',
    updated_at: '2026-04-19T08:35:00.000Z',
    deleted_at: null,
  },
]

// ---------------------------------------------------------------------------
// Entities — GET /api/v1/entities
// Shape: { items: Entity[], total: number, limit: number, offset: number }
// ---------------------------------------------------------------------------
const mockEntities = [
  {
    id: 'ent-001',
    name: 'Cloudscape Design System',
    entity_type: 'technology',
    aliases: ['Cloudscape'],
    mention_count: 14,
    last_seen: '2026-04-21T09:00:00.000Z',
    created_at: '2026-04-10T12:00:00.000Z',
  },
  {
    id: 'ent-002',
    name: 'Troy Davis',
    entity_type: 'person',
    aliases: ['Troy'],
    mention_count: 42,
    last_seen: '2026-04-21T09:00:00.000Z',
    created_at: '2026-04-01T00:00:00.000Z',
  },
]

// ---------------------------------------------------------------------------
// Briefs — GET /api/v1/briefs
// M2 introduces the briefs table (migration 0030). Shape is preliminary —
// handlers will be updated when Phase 4 schema lands.
// Shape: { items: Brief[], total: number, limit: number, offset: number }
// ---------------------------------------------------------------------------
const mockBriefs = [
  {
    id: 'brief-001',
    skill_name: 'weekly-brief',
    title: 'Weekly Brief — 2026-04-14 to 2026-04-20',
    body_html: '<h2>Summary</h2><p>Productive week: shipped M1 Cloudscape shell, 33 PRs merged.</p>',
    toc: [{ anchor: 'summary', label: 'Summary', level: 2 }],
    sources: ['cap-001', 'cap-002'],
    refine_options: ['elaborate', 'shorten'],
    created_at: '2026-04-20T06:00:00.000Z',
  },
  {
    id: 'brief-002',
    skill_name: 'daily-sweep-skill',
    title: 'Daily Sweep — 2026-04-20',
    body_html: '<h2>Evening Digest</h2><p>3 decisions captured, 1 task completed.</p>',
    toc: [{ anchor: 'evening-digest', label: 'Evening Digest', level: 2 }],
    sources: ['cap-001'],
    refine_options: ['elaborate'],
    created_at: '2026-04-20T20:00:00.000Z',
  },
]

// ---------------------------------------------------------------------------
// Stats — GET /api/v1/stats
// Shape: { total_captures, by_type, by_view, by_source, pipeline_health }
// ---------------------------------------------------------------------------
const mockStats = {
  total_captures: 1842,
  by_type: {
    decision: 312,
    idea: 287,
    observation: 401,
    task: 198,
    win: 134,
    blocker: 89,
    question: 221,
    reflection: 200,
  },
  by_view: {
    career: 287,
    personal: 398,
    technical: 512,
    'work-internal': 345,
    client: 300,
  },
  by_source: {
    slack: 542,
    voice: 213,
    api: 189,
    document: 412,
    email: 334,
    file: 152,
  },
  pipeline_health: {
    pending: 3,
    processing: 1,
    complete: 1820,
    failed: 18,
  },
}

// ---------------------------------------------------------------------------
// Search — GET /api/v1/search
// Shape: { results: Array<{ capture: Capture, score: number }> }
// ---------------------------------------------------------------------------
const mockSearchResults = {
  results: [
    {
      capture: mockCaptures[0],
      score: 0.91,
    },
    {
      capture: mockCaptures[1],
      score: 0.74,
    },
  ],
}

// ---------------------------------------------------------------------------
// Handler definitions — MSW v2 syntax
// ---------------------------------------------------------------------------
export const handlers = [
  // Captures list
  http.get('/api/v1/captures', () => {
    return HttpResponse.json({
      items: mockCaptures,
      total: mockCaptures.length,
      limit: 20,
      offset: 0,
    })
  }),

  // Single capture by id
  http.get('/api/v1/captures/:id', ({ params }) => {
    const capture = mockCaptures.find(c => c.id === params.id)
    if (!capture) {
      return HttpResponse.json({ error: 'Not found', code: 'NOT_FOUND' }, { status: 404 })
    }
    return HttpResponse.json(capture)
  }),

  // Entities list
  http.get('/api/v1/entities', () => {
    return HttpResponse.json({
      items: mockEntities,
      total: mockEntities.length,
      limit: 20,
      offset: 0,
    })
  }),

  // Single entity by id
  http.get('/api/v1/entities/:id', ({ params }) => {
    const entity = mockEntities.find(e => e.id === params.id)
    if (!entity) {
      return HttpResponse.json({ error: 'Not found', code: 'NOT_FOUND' }, { status: 404 })
    }
    return HttpResponse.json({ entity })
  }),

  // Briefs list (M2 Phase 4 schema — preliminary)
  http.get('/api/v1/briefs', () => {
    return HttpResponse.json({
      items: mockBriefs,
      total: mockBriefs.length,
      limit: 20,
      offset: 0,
    })
  }),

  // Single brief by id
  http.get('/api/v1/briefs/:id', ({ params }) => {
    const brief = mockBriefs.find(b => b.id === params.id)
    if (!brief) {
      return HttpResponse.json({ error: 'Not found', code: 'NOT_FOUND' }, { status: 404 })
    }
    return HttpResponse.json(brief)
  }),

  // PATCH brief — mark read / unread
  http.patch('/api/v1/briefs/:id', ({ params }) => {
    const brief = mockBriefs.find(b => b.id === params.id)
    if (!brief) {
      return HttpResponse.json({ error: 'Not found', code: 'NOT_FOUND' }, { status: 404 })
    }
    return new HttpResponse(null, { status: 204 })
  }),

  // POST brief refine — enqueue async refinement job
  http.post('/api/v1/briefs/:id/refine', ({ params }) => {
    const brief = mockBriefs.find(b => b.id === params.id)
    if (!brief) {
      return HttpResponse.json({ error: 'Not found', code: 'NOT_FOUND' }, { status: 404 })
    }
    return HttpResponse.json({ job_id: `job-refine-${params.id as string}` })
  }),

  // Stats
  http.get('/api/v1/stats', () => {
    return HttpResponse.json(mockStats)
  }),

  // Search
  http.get('/api/v1/search', () => {
    return HttpResponse.json(mockSearchResults)
  }),
]
