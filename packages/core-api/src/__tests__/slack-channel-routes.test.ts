import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'

// Mock bullmq Queue
vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation((name: string) => ({
    name,
    clean: vi.fn().mockResolvedValue([]),
    getJobCounts: vi.fn().mockResolvedValue({
      active: 0, waiting: 0, completed: 0, failed: 0, delayed: 0,
    }),
  })),
}))

// Mock @bull-board/* to avoid needing serve-static
vi.mock('@bull-board/api', () => ({
  createBullBoard: vi.fn(),
}))
vi.mock('@bull-board/api/bullMQAdapter', () => ({
  BullMQAdapter: vi.fn(),
}))
vi.mock('@bull-board/hono', () => ({
  HonoAdapter: vi.fn().mockImplementation(() => ({
    setBasePath: vi.fn(),
    registerPlugin: vi.fn().mockReturnValue(new Hono()),
  })),
}))
vi.mock('@hono/node-server/serve-static', () => ({
  serveStatic: vi.fn(),
}))

// Mock SlackChannelService
const mockListChannels = vi.fn()
const mockArchiveChannel = vi.fn()

vi.mock('../services/slack-channel.js', () => ({
  SlackChannelService: vi.fn().mockImplementation(() => ({
    listChannels: mockListChannels,
    archiveChannel: mockArchiveChannel,
  })),
}))

// Mock ConfigService
const mockConfigService = {
  reload: vi.fn().mockReturnValue([{ file: 'test.yaml', success: true }]),
  get: vi.fn(),
} as any

describe('Slack Channel Routes — with SLACK_USER_TOKEN', () => {
  let app: Hono
  const originalEnv = process.env.SLACK_USER_TOKEN

  beforeEach(async () => {
    vi.clearAllMocks()
    process.env.SLACK_USER_TOKEN = 'xoxp-test-token'

    // Must re-import after setting env var since createAdminRouter reads process.env at call time
    vi.resetModules()

    // Re-mock everything after resetModules
    vi.doMock('bullmq', () => ({
      Queue: vi.fn().mockImplementation((name: string) => ({
        name,
        clean: vi.fn().mockResolvedValue([]),
        getJobCounts: vi.fn().mockResolvedValue({
          active: 0, waiting: 0, completed: 0, failed: 0, delayed: 0,
        }),
      })),
    }))
    vi.doMock('@bull-board/api', () => ({ createBullBoard: vi.fn() }))
    vi.doMock('@bull-board/api/bullMQAdapter', () => ({ BullMQAdapter: vi.fn() }))
    vi.doMock('@bull-board/hono', () => ({
      HonoAdapter: vi.fn().mockImplementation(() => ({
        setBasePath: vi.fn(),
        registerPlugin: vi.fn().mockReturnValue(new Hono()),
      })),
    }))
    vi.doMock('@hono/node-server/serve-static', () => ({ serveStatic: vi.fn() }))
    vi.doMock('../services/slack-channel.js', () => ({
      SlackChannelService: vi.fn().mockImplementation(() => ({
        listChannels: mockListChannels,
        archiveChannel: mockArchiveChannel,
      })),
    }))

    const { createAdminRouter } = await import('../routes/admin.js')
    app = new Hono()
    const adminRouter = createAdminRouter({
      configService: mockConfigService,
      redisConnection: { host: 'localhost', port: 6379 },
    })
    app.route('/api/v1/admin', adminRouter)
  })

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.SLACK_USER_TOKEN = originalEnv
    } else {
      delete process.env.SLACK_USER_TOKEN
    }
  })

  describe('GET /admin/slack/channels', () => {
    it('returns channel list on success', async () => {
      const mockChannels = [
        {
          id: 'C001',
          name: 'general',
          member_count: 10,
          last_activity: '2026-03-10T00:00:00.000Z',
          days_inactive: 2,
          topic: 'General talk',
          purpose: 'Main channel',
          is_archived: false,
        },
      ]
      mockListChannels.mockResolvedValueOnce(mockChannels)

      const res = await app.request('/api/v1/admin/slack/channels')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.channels).toHaveLength(1)
      expect(body.channels[0].id).toBe('C001')
      expect(body.channels[0].name).toBe('general')
      expect(body.channels[0].member_count).toBe(10)
    })

    it('returns empty array when no channels', async () => {
      mockListChannels.mockResolvedValueOnce([])

      const res = await app.request('/api/v1/admin/slack/channels')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.channels).toEqual([])
    })

    it('returns 500 when Slack API fails', async () => {
      mockListChannels.mockRejectedValueOnce(new Error('invalid_auth'))

      const res = await app.request('/api/v1/admin/slack/channels')
      expect(res.status).toBe(500)
      const body = await res.json()
      expect(body.error).toBe('Failed to list Slack channels')
      expect(body.message).toContain('invalid_auth')
    })
  })

  describe('POST /admin/slack/channels/:id/archive', () => {
    it('archives a channel successfully', async () => {
      mockArchiveChannel.mockResolvedValueOnce({
        ok: true,
        channel_id: 'C001',
        archived_at: '2026-03-12T00:00:00.000Z',
      })

      const res = await app.request('/api/v1/admin/slack/channels/C001/archive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.ok).toBe(true)
      expect(body.channel_id).toBe('C001')
      expect(body.archived_at).toBeTruthy()
      expect(mockArchiveChannel).toHaveBeenCalledWith('C001')
    })

    it('returns 500 when archive fails', async () => {
      mockArchiveChannel.mockRejectedValueOnce(new Error('already_archived'))

      const res = await app.request('/api/v1/admin/slack/channels/C001/archive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(500)
      const body = await res.json()
      expect(body.error).toBe('Failed to archive Slack channel')
      expect(body.message).toContain('already_archived')
    })
  })
})

describe('Slack Channel Routes — without any Slack token', () => {
  let app: Hono
  const originalUserToken = process.env.SLACK_USER_TOKEN
  const originalBotToken = process.env.SLACK_BOT_TOKEN

  beforeEach(async () => {
    vi.clearAllMocks()
    delete process.env.SLACK_USER_TOKEN
    delete process.env.SLACK_BOT_TOKEN
    vi.resetModules()

    // Re-mock after resetModules
    vi.doMock('bullmq', () => ({
      Queue: vi.fn().mockImplementation((name: string) => ({
        name,
        clean: vi.fn().mockResolvedValue([]),
        getJobCounts: vi.fn().mockResolvedValue({
          active: 0, waiting: 0, completed: 0, failed: 0, delayed: 0,
        }),
      })),
    }))
    vi.doMock('@bull-board/api', () => ({ createBullBoard: vi.fn() }))
    vi.doMock('@bull-board/api/bullMQAdapter', () => ({ BullMQAdapter: vi.fn() }))
    vi.doMock('@bull-board/hono', () => ({
      HonoAdapter: vi.fn().mockImplementation(() => ({
        setBasePath: vi.fn(),
        registerPlugin: vi.fn().mockReturnValue(new Hono()),
      })),
    }))
    vi.doMock('@hono/node-server/serve-static', () => ({ serveStatic: vi.fn() }))
    vi.doMock('../services/slack-channel.js', () => ({
      SlackChannelService: vi.fn().mockImplementation(() => ({
        listChannels: mockListChannels,
        archiveChannel: mockArchiveChannel,
      })),
    }))

    const { createAdminRouter } = await import('../routes/admin.js')
    app = new Hono()
    const adminRouter = createAdminRouter({
      configService: mockConfigService,
    })
    app.route('/api/v1/admin', adminRouter)
  })

  afterEach(() => {
    if (originalUserToken !== undefined) {
      process.env.SLACK_USER_TOKEN = originalUserToken
    } else {
      delete process.env.SLACK_USER_TOKEN
    }
    if (originalBotToken !== undefined) {
      process.env.SLACK_BOT_TOKEN = originalBotToken
    } else {
      delete process.env.SLACK_BOT_TOKEN
    }
  })

  it('GET /admin/slack/channels returns 503 when no token is available', async () => {
    const res = await app.request('/api/v1/admin/slack/channels')
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.error).toBe('Service unavailable')
    expect(body.message).toContain('Slack token')
  })

  it('POST /admin/slack/channels/:id/archive returns 503 when no token is available', async () => {
    const res = await app.request('/api/v1/admin/slack/channels/C001/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.error).toBe('Service unavailable')
    expect(body.message).toContain('Slack token')
  })
})
