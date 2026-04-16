import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { GmailClient, GmailApiError } from '../gmail-client.js'

// ---------------------------------------------------------------------------
// Mock google-auth-library
// ---------------------------------------------------------------------------

const mockSetCredentials = vi.fn()
const mockRefreshAccessToken = vi.fn()

vi.mock('google-auth-library', () => ({
  OAuth2Client: vi.fn().mockImplementation(() => ({
    setCredentials: mockSetCredentials,
    refreshAccessToken: mockRefreshAccessToken,
  })),
}))

// ---------------------------------------------------------------------------
// Mock fetch — sequential response queue
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch

/**
 * Mock fetch that consumes responses in order.
 * Each call returns the next response in the queue.
 */
function mockFetchSequential(responses: Array<{ status: number; body: unknown }>) {
  let callIndex = 0
  const mockFetch = vi.fn().mockImplementation(async (_url: string, _opts?: RequestInit) => {
    const r = responses[callIndex] ?? { status: 404, body: {} }
    callIndex++
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    }
  })
  globalThis.fetch = mockFetch as unknown as typeof fetch
  return mockFetch
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeGmailClient(settingsMap: Record<string, unknown> = {}) {
  const insertValues = vi.fn()
  const onConflict = vi.fn().mockResolvedValue(undefined)
  insertValues.mockReturnValue({ onConflictDoUpdate: onConflict })

  const db = {
    select: vi.fn(),
    insert: vi.fn().mockReturnValue({ values: insertValues }),
    _onConflict: onConflict,
  }

  // Each select().from().where() chain resolves based on the settings map.
  // We use a counter to handle sequential loadSetting calls.
  let callIndex = 0
  const callKeys: string[] = []

  db.select.mockImplementation(() => ({
    from: vi.fn().mockImplementation(() => ({
      where: vi.fn().mockImplementation(() => {
        const key = callKeys[callIndex] ?? null
        callIndex++
        if (key && key in settingsMap) {
          return Promise.resolve([{ key, value: settingsMap[key], updated_at: new Date() }])
        }
        return Promise.resolve([])
      }),
    })),
  }))

  return {
    client: new GmailClient({ db: db as unknown as import('../../../db/index.js').Database, apiDelayMs: 0 }),
    db,
    expectSettingsQueries: (keys: string[]) => {
      callIndex = 0
      callKeys.length = 0
      callKeys.push(...keys)
    },
    onConflict,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GmailClient', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  // ── Authentication ────────────────────────────────────────────────────

  describe('authenticate', () => {
    it('returns false when no credentials in app_settings', async () => {
      const { client, expectSettingsQueries } = makeGmailClient({})
      expectSettingsQueries(['gmail_credentials'])

      const result = await client.authenticate()
      expect(result).toBe(false)
    })

    it('returns false when no cached token in app_settings', async () => {
      const creds = { client_id: 'test-id', client_secret: 'test-secret', redirect_uris: ['http://localhost'] }
      const { client, expectSettingsQueries } = makeGmailClient({ gmail_credentials: creds })
      expectSettingsQueries(['gmail_credentials', 'gmail_token_cache'])

      const result = await client.authenticate()
      expect(result).toBe(false)
    })

    it('authenticates successfully with valid cached token', async () => {
      const creds = { client_id: 'test-id', client_secret: 'test-secret', redirect_uris: ['http://localhost'] }
      const token = {
        access_token: 'valid-access-token',
        refresh_token: 'refresh-token',
        expiry_date: Date.now() + 60 * 60 * 1000,
      }

      const { client, expectSettingsQueries } = makeGmailClient({
        gmail_credentials: creds,
        gmail_token_cache: token,
      })
      expectSettingsQueries(['gmail_credentials', 'gmail_token_cache'])

      const result = await client.authenticate()
      expect(result).toBe(true)
      expect(mockSetCredentials).toHaveBeenCalledWith(token)
    })

    it('refreshes expired token and persists new token', async () => {
      const creds = { client_id: 'test-id', client_secret: 'test-secret', redirect_uris: ['http://localhost'] }
      const expiredToken = {
        access_token: 'expired-token',
        refresh_token: 'refresh-token',
        expiry_date: Date.now() - 60 * 1000,
      }
      const newToken = {
        access_token: 'new-access-token',
        refresh_token: 'refresh-token',
        expiry_date: Date.now() + 60 * 60 * 1000,
      }

      mockRefreshAccessToken.mockResolvedValueOnce({ credentials: newToken })

      const { client, expectSettingsQueries, onConflict } = makeGmailClient({
        gmail_credentials: creds,
        gmail_token_cache: expiredToken,
      })
      expectSettingsQueries(['gmail_credentials', 'gmail_token_cache'])

      const result = await client.authenticate()
      expect(result).toBe(true)
      expect(mockRefreshAccessToken).toHaveBeenCalled()
      expect(onConflict).toHaveBeenCalled()
    })

    it('returns false when token expired and no refresh_token', async () => {
      const creds = { client_id: 'test-id', client_secret: 'test-secret', redirect_uris: ['http://localhost'] }
      const expiredToken = {
        access_token: 'expired-token',
        expiry_date: Date.now() - 60 * 1000,
      }

      const { client, expectSettingsQueries } = makeGmailClient({
        gmail_credentials: creds,
        gmail_token_cache: expiredToken,
      })
      expectSettingsQueries(['gmail_credentials', 'gmail_token_cache'])

      const result = await client.authenticate()
      expect(result).toBe(false)
    })

    it('handles nested installed credentials format', async () => {
      const creds = {
        installed: {
          client_id: 'nested-id',
          client_secret: 'nested-secret',
          redirect_uris: ['http://localhost'],
        },
      }
      const token = {
        access_token: 'valid-token',
        refresh_token: 'refresh',
        expiry_date: Date.now() + 60 * 60 * 1000,
      }

      const { client, expectSettingsQueries } = makeGmailClient({
        gmail_credentials: creds,
        gmail_token_cache: token,
      })
      expectSettingsQueries(['gmail_credentials', 'gmail_token_cache'])

      const result = await client.authenticate()
      expect(result).toBe(true)
    })
  })

  // ── Fetch Inbox ───────────────────────────────────────────────────────

  describe('fetchInbox', () => {
    function authenticatedClient() {
      const creds = { client_id: 'id', client_secret: 'secret', redirect_uris: ['http://localhost'] }
      const token = { access_token: 'test-token', expiry_date: Date.now() + 3600000 }
      const helper = makeGmailClient({ gmail_credentials: creds, gmail_token_cache: token })
      helper.expectSettingsQueries(['gmail_credentials', 'gmail_token_cache'])
      return helper
    }

    it('fetches and parses inbox messages', async () => {
      const { client } = authenticatedClient()
      await client.authenticate()

      mockFetchSequential([
        // list messages
        { status: 200, body: { messages: [{ id: 'msg1', threadId: 'thread1' }] } },
        // get message detail
        {
          status: 200,
          body: {
            id: 'msg1',
            snippet: 'Hello world preview text',
            internalDate: String(Date.now()),
            payload: {
              headers: [
                { name: 'From', value: 'John Doe <john@example.com>' },
                { name: 'Subject', value: 'Test Email' },
              ],
            },
          },
        },
      ])

      const emails = await client.fetchInbox(24)

      expect(emails).toHaveLength(1)
      expect(emails[0]).toMatchObject({
        messageId: 'msg1',
        provider: 'gmail',
        sender: 'john@example.com',
        subject: 'Test Email',
        bodyPreview: 'Hello world preview text',
      })
    })

    it('handles empty inbox', async () => {
      const { client } = authenticatedClient()
      await client.authenticate()

      mockFetchSequential([
        { status: 200, body: { resultSizeEstimate: 0 } },
      ])

      const emails = await client.fetchInbox(24)
      expect(emails).toHaveLength(0)
    })

    it('extracts sender from bare email address (no angle brackets)', async () => {
      const { client } = authenticatedClient()
      await client.authenticate()

      mockFetchSequential([
        { status: 200, body: { messages: [{ id: 'msg2', threadId: 't2' }] } },
        {
          status: 200,
          body: {
            id: 'msg2',
            snippet: '',
            internalDate: String(Date.now()),
            payload: {
              headers: [
                { name: 'From', value: 'plain@example.com' },
                { name: 'Subject', value: 'Plain sender' },
              ],
            },
          },
        },
      ])

      const emails = await client.fetchInbox(1)
      expect(emails[0].sender).toBe('plain@example.com')
    })

    it('paginates through multiple pages', async () => {
      const { client } = authenticatedClient()
      await client.authenticate()

      mockFetchSequential([
        // Page 1 list
        {
          status: 200,
          body: {
            messages: [{ id: 'msg1', threadId: 't1' }],
            nextPageToken: 'page2token',
          },
        },
        // Page 1 message detail
        {
          status: 200,
          body: {
            id: 'msg1',
            snippet: 'First',
            internalDate: String(Date.now()),
            payload: { headers: [{ name: 'From', value: 'a@b.com' }, { name: 'Subject', value: 'A' }] },
          },
        },
        // Page 2 list (no nextPageToken = last page)
        {
          status: 200,
          body: {
            messages: [{ id: 'msg2', threadId: 't2' }],
          },
        },
        // Page 2 message detail
        {
          status: 200,
          body: {
            id: 'msg2',
            snippet: 'Second',
            internalDate: String(Date.now()),
            payload: { headers: [{ name: 'From', value: 'c@d.com' }, { name: 'Subject', value: 'B' }] },
          },
        },
      ])

      const emails = await client.fetchInbox(24)
      expect(emails).toHaveLength(2)
    })
  })

  // ── Label Management ──────────────────────────────────────────────────

  describe('listFolders', () => {
    it('returns labels as EmailFolder objects', async () => {
      const creds = { client_id: 'id', client_secret: 'secret', redirect_uris: ['http://localhost'] }
      const token = { access_token: 'test-token', expiry_date: Date.now() + 3600000 }
      const { client, expectSettingsQueries } = makeGmailClient({ gmail_credentials: creds, gmail_token_cache: token })
      expectSettingsQueries(['gmail_credentials', 'gmail_token_cache'])
      await client.authenticate()

      mockFetchSequential([
        {
          status: 200,
          body: {
            labels: [
              { id: 'Label_1', name: 'Financial', type: 'user' },
              { id: 'INBOX', name: 'INBOX', type: 'system' },
            ],
          },
        },
      ])

      const folders = await client.listFolders()
      expect(folders).toHaveLength(2)
      expect(folders[0]).toEqual({ id: 'Label_1', name: 'Financial' })
    })
  })

  describe('setupFolders', () => {
    it('creates missing labels and returns category map', async () => {
      const creds = { client_id: 'id', client_secret: 'secret', redirect_uris: ['http://localhost'] }
      const token = { access_token: 'test-token', expiry_date: Date.now() + 3600000 }
      const { client, expectSettingsQueries } = makeGmailClient({ gmail_credentials: creds, gmail_token_cache: token })
      expectSettingsQueries(['gmail_credentials', 'gmail_token_cache'])
      await client.authenticate()

      mockFetchSequential([
        // listLabels GET
        {
          status: 200,
          body: {
            labels: [{ id: 'existing_id', name: 'Financial', type: 'user' }],
          },
        },
        // Create "Needs Review" label POST
        { status: 200, body: { id: 'new_needs_review', name: 'Needs Review' } },
        // Create "Shopping" label POST
        { status: 200, body: { id: 'new_shopping', name: 'Shopping' } },
      ])

      const result = await client.setupFolders(['Financial', 'Shopping'])

      expect(result.get('Financial')).toBe('existing_id')
      expect(result.has('Needs Review')).toBe(true)
      expect(result.has('Shopping')).toBe(true)
    })
  })

  // ── Move Email ────────────────────────────────────────────────────────

  describe('moveEmail', () => {
    it('applies label and removes INBOX label', async () => {
      const creds = { client_id: 'id', client_secret: 'secret', redirect_uris: ['http://localhost'] }
      const token = { access_token: 'test-token', expiry_date: Date.now() + 3600000 }
      const { client, expectSettingsQueries } = makeGmailClient({ gmail_credentials: creds, gmail_token_cache: token })
      expectSettingsQueries(['gmail_credentials', 'gmail_token_cache'])
      await client.authenticate()

      const mockFetch = mockFetchSequential([
        { status: 200, body: { id: 'msg1', labelIds: ['Label_1'] } },
      ])

      const result = await client.moveEmail('msg1', 'Label_1')

      expect(result).toBe(true)
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/messages/msg1/modify'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ addLabelIds: ['Label_1'], removeLabelIds: ['INBOX'] }),
        }),
      )
    })

    it('returns false on API error', async () => {
      const creds = { client_id: 'id', client_secret: 'secret', redirect_uris: ['http://localhost'] }
      const token = { access_token: 'test-token', expiry_date: Date.now() + 3600000 }
      const { client, expectSettingsQueries } = makeGmailClient({ gmail_credentials: creds, gmail_token_cache: token })
      expectSettingsQueries(['gmail_credentials', 'gmail_token_cache'])
      await client.authenticate()

      mockFetchSequential([
        { status: 403, body: { error: { message: 'Insufficient permissions' } } },
      ])

      const result = await client.moveEmail('msg1', 'Label_1')
      expect(result).toBe(false)
    })
  })

  // ── Spam Cleanup ──────────────────────────────────────────────────────

  describe('cleanupSpam', () => {
    it('trashes old spam messages and returns count', async () => {
      const creds = { client_id: 'id', client_secret: 'secret', redirect_uris: ['http://localhost'] }
      const token = { access_token: 'test-token', expiry_date: Date.now() + 3600000 }
      const { client, expectSettingsQueries } = makeGmailClient({ gmail_credentials: creds, gmail_token_cache: token })
      expectSettingsQueries(['gmail_credentials', 'gmail_token_cache'])
      await client.authenticate()

      mockFetchSequential([
        // List spam messages
        {
          status: 200,
          body: {
            messages: [
              { id: 'spam1', threadId: 's1' },
              { id: 'spam2', threadId: 's2' },
            ],
          },
        },
        // Trash spam1
        { status: 200, body: { id: 'spam1' } },
        // Trash spam2
        { status: 200, body: { id: 'spam2' } },
      ])

      const count = await client.cleanupSpam(30)
      expect(count).toBe(2)
    })

    it('returns 0 when no spam found', async () => {
      const creds = { client_id: 'id', client_secret: 'secret', redirect_uris: ['http://localhost'] }
      const token = { access_token: 'test-token', expiry_date: Date.now() + 3600000 }
      const { client, expectSettingsQueries } = makeGmailClient({ gmail_credentials: creds, gmail_token_cache: token })
      expectSettingsQueries(['gmail_credentials', 'gmail_token_cache'])
      await client.authenticate()

      mockFetchSequential([
        { status: 200, body: { resultSizeEstimate: 0 } },
      ])

      const count = await client.cleanupSpam(30)
      expect(count).toBe(0)
    })
  })

  // ── API Error Handling ────────────────────────────────────────────────

  describe('GmailApiError', () => {
    it('preserves status code and response body', () => {
      const err = new GmailApiError('test error', 429, '{"error": "rate limited"}')
      expect(err.statusCode).toBe(429)
      expect(err.responseBody).toBe('{"error": "rate limited"}')
      expect(err.name).toBe('GmailApiError')
      expect(err.message).toBe('test error')
    })
  })

  // ── Correction Detection ──────────────────────────────────────────────

  describe('checkMessageLabel', () => {
    it('returns null when label is still present (no correction)', async () => {
      const creds = { client_id: 'id', client_secret: 'secret', redirect_uris: ['http://localhost'] }
      const token = { access_token: 'test-token', expiry_date: Date.now() + 3600000 }
      const { client, expectSettingsQueries } = makeGmailClient({ gmail_credentials: creds, gmail_token_cache: token })
      expectSettingsQueries(['gmail_credentials', 'gmail_token_cache'])
      await client.authenticate()

      mockFetchSequential([
        { status: 200, body: { id: 'msg1', labelIds: ['Label_1', 'INBOX'] } },
      ])

      const labelMap = new Map([['Financial', 'Label_1']])
      const result = await client.checkMessageLabel('msg1', 'Label_1', labelMap)
      expect(result).toBeNull()
    })

    it('returns new category when label was changed by user', async () => {
      const creds = { client_id: 'id', client_secret: 'secret', redirect_uris: ['http://localhost'] }
      const token = { access_token: 'test-token', expiry_date: Date.now() + 3600000 }
      const { client, expectSettingsQueries } = makeGmailClient({ gmail_credentials: creds, gmail_token_cache: token })
      expectSettingsQueries(['gmail_credentials', 'gmail_token_cache'])
      await client.authenticate()

      mockFetchSequential([
        { status: 200, body: { id: 'msg1', labelIds: ['Label_2'] } },
      ])

      const labelToCategory = new Map([
        ['Label_1', 'Financial'],
        ['Label_2', 'Shopping'],
      ])
      const result = await client.checkMessageLabel('msg1', 'Label_1', labelToCategory)
      expect(result).toBe('Shopping')
    })

    it('returns unknown when label changed but new label not recognized', async () => {
      const creds = { client_id: 'id', client_secret: 'secret', redirect_uris: ['http://localhost'] }
      const token = { access_token: 'test-token', expiry_date: Date.now() + 3600000 }
      const { client, expectSettingsQueries } = makeGmailClient({ gmail_credentials: creds, gmail_token_cache: token })
      expectSettingsQueries(['gmail_credentials', 'gmail_token_cache'])
      await client.authenticate()

      mockFetchSequential([
        { status: 200, body: { id: 'msg1', labelIds: ['UNREAD'] } },
      ])

      const labelToCategory = new Map([['Label_1', 'Financial']])
      const result = await client.checkMessageLabel('msg1', 'Label_1', labelToCategory)
      expect(result).toBe('unknown')
    })

    it('returns null on API error (graceful degradation)', async () => {
      const creds = { client_id: 'id', client_secret: 'secret', redirect_uris: ['http://localhost'] }
      const token = { access_token: 'test-token', expiry_date: Date.now() + 3600000 }
      const { client, expectSettingsQueries } = makeGmailClient({ gmail_credentials: creds, gmail_token_cache: token })
      expectSettingsQueries(['gmail_credentials', 'gmail_token_cache'])
      await client.authenticate()

      mockFetchSequential([
        { status: 404, body: { error: { message: 'Not found' } } },
      ])

      const labelToCategory = new Map([['Label_1', 'Financial']])
      const result = await client.checkMessageLabel('msg1', 'Label_1', labelToCategory)
      expect(result).toBeNull()
    })
  })
})
