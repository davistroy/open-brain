import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock @slack/web-api before importing the service
const mockConversationsList = vi.fn()
const mockConversationsHistory = vi.fn()
const mockConversationsArchive = vi.fn()

vi.mock('@slack/web-api', () => ({
  WebClient: vi.fn().mockImplementation(() => ({
    conversations: {
      list: mockConversationsList,
      history: mockConversationsHistory,
      archive: mockConversationsArchive,
    },
  })),
}))

import { SlackChannelService } from '../services/slack-channel.js'

describe('SlackChannelService', () => {
  let service: SlackChannelService

  beforeEach(() => {
    vi.clearAllMocks()
    service = new SlackChannelService('xoxp-test-token')
  })

  describe('listChannels', () => {
    it('returns channels with activity metadata', async () => {
      const now = Date.now()
      const twoDaysAgoTs = ((now - 2 * 86400 * 1000) / 1000).toString()

      mockConversationsList.mockResolvedValueOnce({
        channels: [
          {
            id: 'C001',
            name: 'general',
            num_members: 15,
            is_archived: false,
            topic: { value: 'General discussion' },
            purpose: { value: 'Company-wide channel' },
          },
          {
            id: 'C002',
            name: 'archived-channel',
            num_members: 3,
            is_archived: true,
            topic: { value: '' },
            purpose: { value: '' },
          },
        ],
        response_metadata: { next_cursor: '' },
      })

      // conversations.history is only called for non-archived channels
      mockConversationsHistory.mockResolvedValueOnce({
        messages: [{ ts: twoDaysAgoTs }],
      })

      const channels = await service.listChannels()

      expect(channels).toHaveLength(2)

      // First channel — active, has recent message
      expect(channels[0].id).toBe('C001')
      expect(channels[0].name).toBe('general')
      expect(channels[0].member_count).toBe(15)
      expect(channels[0].is_archived).toBe(false)
      expect(channels[0].last_activity).toBeTruthy()
      expect(channels[0].days_inactive).toBeGreaterThanOrEqual(1)
      expect(channels[0].days_inactive).toBeLessThanOrEqual(3)
      expect(channels[0].topic).toBe('General discussion')
      expect(channels[0].purpose).toBe('Company-wide channel')

      // Second channel — archived, no history fetched
      expect(channels[1].id).toBe('C002')
      expect(channels[1].name).toBe('archived-channel')
      expect(channels[1].is_archived).toBe(true)
      expect(channels[1].last_activity).toBeNull()
      expect(channels[1].days_inactive).toBe(0)

      // conversations.history should only be called once (for the non-archived channel)
      expect(mockConversationsHistory).toHaveBeenCalledTimes(1)
      expect(mockConversationsHistory).toHaveBeenCalledWith({
        channel: 'C001',
        limit: 1,
      })
    })

    it('handles pagination via next_cursor', async () => {
      mockConversationsList
        .mockResolvedValueOnce({
          channels: [
            { id: 'C001', name: 'page1-channel', num_members: 5, is_archived: false },
          ],
          response_metadata: { next_cursor: 'cursor_page2' },
        })
        .mockResolvedValueOnce({
          channels: [
            { id: 'C002', name: 'page2-channel', num_members: 3, is_archived: false },
          ],
          response_metadata: { next_cursor: '' },
        })

      // History for each non-archived channel
      mockConversationsHistory
        .mockResolvedValueOnce({ messages: [] })
        .mockResolvedValueOnce({ messages: [] })

      const channels = await service.listChannels()

      expect(channels).toHaveLength(2)
      expect(channels[0].name).toBe('page1-channel')
      expect(channels[1].name).toBe('page2-channel')
      expect(mockConversationsList).toHaveBeenCalledTimes(2)
      expect(mockConversationsList).toHaveBeenNthCalledWith(2, expect.objectContaining({
        cursor: 'cursor_page2',
      }))
    })

    it('handles channels with no messages (null last_activity)', async () => {
      mockConversationsList.mockResolvedValueOnce({
        channels: [
          { id: 'C001', name: 'empty-channel', num_members: 1, is_archived: false },
        ],
        response_metadata: { next_cursor: '' },
      })

      mockConversationsHistory.mockResolvedValueOnce({
        messages: [],
      })

      const channels = await service.listChannels()

      expect(channels).toHaveLength(1)
      expect(channels[0].last_activity).toBeNull()
      expect(channels[0].days_inactive).toBe(0)
    })

    it('continues if conversations.history fails for a channel', async () => {
      mockConversationsList.mockResolvedValueOnce({
        channels: [
          { id: 'C001', name: 'restricted-channel', num_members: 2, is_archived: false },
          { id: 'C002', name: 'accessible-channel', num_members: 5, is_archived: false },
        ],
        response_metadata: { next_cursor: '' },
      })

      const recentTs = (Date.now() / 1000).toString()
      mockConversationsHistory
        .mockRejectedValueOnce(new Error('not_in_channel'))
        .mockResolvedValueOnce({ messages: [{ ts: recentTs }] })

      const channels = await service.listChannels()

      expect(channels).toHaveLength(2)
      // First channel — history failed, defaults
      expect(channels[0].name).toBe('restricted-channel')
      expect(channels[0].last_activity).toBeNull()
      expect(channels[0].days_inactive).toBe(0)
      // Second channel — history succeeded
      expect(channels[1].name).toBe('accessible-channel')
      expect(channels[1].last_activity).toBeTruthy()
    })

    it('skips channels without id or name', async () => {
      mockConversationsList.mockResolvedValueOnce({
        channels: [
          { id: undefined, name: 'no-id' },
          { id: 'C001', name: undefined },
          { id: 'C002', name: 'valid', num_members: 1, is_archived: false },
        ],
        response_metadata: { next_cursor: '' },
      })

      mockConversationsHistory.mockResolvedValueOnce({ messages: [] })

      const channels = await service.listChannels()

      expect(channels).toHaveLength(1)
      expect(channels[0].name).toBe('valid')
    })

    it('handles empty topic and purpose as undefined', async () => {
      mockConversationsList.mockResolvedValueOnce({
        channels: [
          {
            id: 'C001',
            name: 'no-meta',
            num_members: 0,
            is_archived: false,
            topic: { value: '' },
            purpose: { value: '' },
          },
        ],
        response_metadata: { next_cursor: '' },
      })

      mockConversationsHistory.mockResolvedValueOnce({ messages: [] })

      const channels = await service.listChannels()

      expect(channels[0].topic).toBeUndefined()
      expect(channels[0].purpose).toBeUndefined()
    })

    it('defaults num_members to 0 when missing', async () => {
      mockConversationsList.mockResolvedValueOnce({
        channels: [
          { id: 'C001', name: 'no-members', is_archived: true },
        ],
        response_metadata: { next_cursor: '' },
      })

      const channels = await service.listChannels()

      expect(channels[0].member_count).toBe(0)
    })

    it('handles empty channels list from Slack', async () => {
      mockConversationsList.mockResolvedValueOnce({
        channels: [],
        response_metadata: { next_cursor: '' },
      })

      const channels = await service.listChannels()

      expect(channels).toHaveLength(0)
    })

    it('handles undefined channels response', async () => {
      mockConversationsList.mockResolvedValueOnce({
        response_metadata: { next_cursor: '' },
      })

      const channels = await service.listChannels()

      expect(channels).toHaveLength(0)
    })
  })

  describe('archiveChannel', () => {
    it('archives a channel and returns result', async () => {
      mockConversationsArchive.mockResolvedValueOnce({ ok: true })

      const result = await service.archiveChannel('C001')

      expect(result.ok).toBe(true)
      expect(result.channel_id).toBe('C001')
      expect(result.archived_at).toBeTruthy()
      expect(mockConversationsArchive).toHaveBeenCalledWith({ channel: 'C001' })
    })

    it('throws when Slack API returns an error', async () => {
      mockConversationsArchive.mockRejectedValueOnce(new Error('already_archived'))

      await expect(service.archiveChannel('C001')).rejects.toThrow('already_archived')
    })
  })
})
