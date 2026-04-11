import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { registerActivityRoutes } from '../routes/activity.js'
import type { ActivityFeedService, ActivityFeedRecord, ActivityFeedPage } from '../services/activity-feed.js'

// ---------------------------------------------------------------------------
// Mock pg-notify
// ---------------------------------------------------------------------------
vi.mock('../lib/pg-notify.js', () => ({
  pgNotify: {
    notify: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockReturnValue(() => {}),
    start: vi.fn(),
    stop: vi.fn(),
  },
}))

// ---------------------------------------------------------------------------
// Mock ActivityFeedService
// ---------------------------------------------------------------------------

const mockList = vi.fn()

function createMockService(): ActivityFeedService {
  return {
    insert: vi.fn(),
    insertCapture: vi.fn(),
    insertSkill: vi.fn(),
    insertPipeline: vi.fn(),
    insertEntity: vi.fn(),
    list: mockList,
  } as unknown as ActivityFeedService
}

function makeRecord(overrides: Partial<ActivityFeedRecord> = {}): ActivityFeedRecord {
  return {
    id: 'act-1',
    type: 'capture',
    subtype: 'created',
    timestamp: new Date('2026-04-10T12:00:00Z'),
    summary: 'New idea from api: test content',
    view: 'technical',
    detail: { capture_type: 'idea' },
    source_id: 'cap-1',
    created_at: new Date('2026-04-10T12:00:00Z'),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Activity routes', () => {
  let app: Hono

  beforeEach(() => {
    vi.clearAllMocks()
    app = new Hono()
    registerActivityRoutes(app, createMockService())
  })

  describe('GET /api/v1/activity/feed', () => {
    it('returns paginated feed with defaults', async () => {
      const page: ActivityFeedPage = {
        items: [makeRecord()],
        total: 1,
      }
      mockList.mockResolvedValue(page)

      const res = await app.request('/api/v1/activity/feed')
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.items).toHaveLength(1)
      expect(body.total).toBe(1)
      expect(body.limit).toBe(50)
      expect(body.offset).toBe(0)
    })

    it('passes type filter', async () => {
      mockList.mockResolvedValue({ items: [], total: 0 })

      await app.request('/api/v1/activity/feed?type=skill')

      expect(mockList).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'skill' }),
        50,
        0,
      )
    })

    it('passes view filter', async () => {
      mockList.mockResolvedValue({ items: [], total: 0 })

      await app.request('/api/v1/activity/feed?view=career')

      expect(mockList).toHaveBeenCalledWith(
        expect.objectContaining({ view: 'career' }),
        50,
        0,
      )
    })

    it('passes since filter as Date', async () => {
      mockList.mockResolvedValue({ items: [], total: 0 })

      await app.request('/api/v1/activity/feed?since=2026-04-01T00:00:00Z')

      expect(mockList).toHaveBeenCalledWith(
        expect.objectContaining({ since: expect.any(Date) }),
        50,
        0,
      )
    })

    it('ignores invalid since date', async () => {
      mockList.mockResolvedValue({ items: [], total: 0 })

      await app.request('/api/v1/activity/feed?since=not-a-date')

      expect(mockList).toHaveBeenCalledWith(
        expect.not.objectContaining({ since: expect.anything() }),
        50,
        0,
      )
    })

    it('respects limit and offset params', async () => {
      mockList.mockResolvedValue({ items: [], total: 0 })

      await app.request('/api/v1/activity/feed?limit=10&offset=20')

      expect(mockList).toHaveBeenCalledWith(expect.any(Object), 10, 20)
    })

    it('caps limit at 200', async () => {
      mockList.mockResolvedValue({ items: [], total: 0 })

      await app.request('/api/v1/activity/feed?limit=500')

      expect(mockList).toHaveBeenCalledWith(expect.any(Object), 200, 0)
    })

    it('combines multiple filters', async () => {
      mockList.mockResolvedValue({ items: [], total: 0 })

      await app.request('/api/v1/activity/feed?type=capture&view=technical&since=2026-04-01T00:00:00Z')

      expect(mockList).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'capture', view: 'technical', since: expect.any(Date) }),
        50,
        0,
      )
    })
  })

  describe('GET /api/v1/activity/feed/stream', () => {
    it('returns SSE content type', async () => {
      // SSE streams stay open; we just verify the headers and initial event
      const res = await app.request('/api/v1/activity/feed/stream')
      expect(res.status).toBe(200)
      expect(res.headers.get('Content-Type')).toBe('text/event-stream')
      expect(res.headers.get('Cache-Control')).toBe('no-cache')
    })
  })
})
