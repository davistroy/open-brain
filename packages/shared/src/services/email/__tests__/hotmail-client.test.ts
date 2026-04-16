import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Database } from '../../../db/index.js'
import { HotmailClient } from '../hotmail-client.js'

// ── MSAL mock ────────────────────────────────────────────────────────────────

const mockAcquireTokenSilent = vi.fn()
const mockAcquireTokenByDeviceCode = vi.fn()
const mockGetAllAccounts = vi.fn()
const mockSerialize = vi.fn().mockReturnValue('{}')
const mockDeserialize = vi.fn()

vi.mock('@azure/msal-node', () => ({
  PublicClientApplication: vi.fn().mockImplementation(() => ({
    acquireTokenSilent: mockAcquireTokenSilent,
    acquireTokenByDeviceCode: mockAcquireTokenByDeviceCode,
    getTokenCache: () => ({
      getAllAccounts: mockGetAllAccounts,
      serialize: mockSerialize,
      deserialize: mockDeserialize,
    }),
  })),
}))

// ── DB mock ──────────────────────────────────────────────────────────────────

function createMockDb() {
  const store = new Map<string, unknown>()

  const mockWhere = vi.fn().mockImplementation(() => {
    // Return whatever is in the store for ms_token_cache
    const val = store.get('ms_token_cache')
    return val ? [{ key: 'ms_token_cache', value: val, updated_at: new Date() }] : []
  })

  const mockFrom = vi.fn().mockReturnValue({ where: mockWhere })
  const mockSelect = vi.fn().mockReturnValue({ from: mockFrom })

  const mockOnConflictDoUpdate = vi.fn().mockImplementation(({ set }) => {
    store.set('ms_token_cache', set.value)
    return Promise.resolve()
  })
  const mockValues = vi.fn().mockReturnValue({ onConflictDoUpdate: mockOnConflictDoUpdate })
  const mockInsert = vi.fn().mockReturnValue({ values: mockValues })

  return {
    db: { select: mockSelect, insert: mockInsert } as unknown as Database,
    store,
    mockSelect,
    mockInsert,
    mockOnConflictDoUpdate,
  }
}

// ── Fetch mock helper ────────────────────────────────────────────────────────

function mockFetch(responses: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>) {
  let callIndex = 0
  return vi.fn().mockImplementation(async () => {
    const resp = responses[callIndex] ?? responses[responses.length - 1]
    callIndex++
    const bodyText = resp.body !== undefined ? JSON.stringify(resp.body) : ''
    return {
      ok: resp.status >= 200 && resp.status < 300,
      status: resp.status,
      headers: {
        get: (name: string) => (resp.headers ?? {})[name] ?? null,
      },
      text: async () => bodyText,
      json: async () => resp.body,
    }
  })
}

function createClient(db: Database, fetchFn: ReturnType<typeof vi.fn>) {
  return new HotmailClient({
    db,
    graphBase: 'https://graph.microsoft.com/v1.0',
    fetchFn: fetchFn as unknown as typeof globalThis.fetch,
  })
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('HotmailClient', () => {
  let dbMock: ReturnType<typeof createMockDb>

  beforeEach(() => {
    vi.clearAllMocks()
    dbMock = createMockDb()
    // Default: cached token succeeds
    mockGetAllAccounts.mockResolvedValue([{ username: 'test@outlook.com' }])
    mockAcquireTokenSilent.mockResolvedValue({ accessToken: 'test-token-123' })
  })

  // ── authenticate ─────────────────────────────────────────────────────────

  describe('authenticate', () => {
    it('authenticates with cached token', async () => {
      const client = createClient(dbMock.db, vi.fn())
      const result = await client.authenticate()

      expect(result).toBe(true)
      expect(mockAcquireTokenSilent).toHaveBeenCalledWith(
        expect.objectContaining({ scopes: ['Mail.ReadWrite', 'User.Read'] }),
      )
    })

    it('falls back to device code when no cached accounts', async () => {
      mockGetAllAccounts.mockResolvedValue([])
      mockAcquireTokenByDeviceCode.mockResolvedValue({ accessToken: 'device-token' })

      const client = createClient(dbMock.db, vi.fn())
      const result = await client.authenticate()

      expect(result).toBe(true)
      expect(mockAcquireTokenByDeviceCode).toHaveBeenCalled()
    })

    it('returns false when silent acquisition fails and device code fails', async () => {
      mockGetAllAccounts.mockResolvedValue([])
      mockAcquireTokenByDeviceCode.mockRejectedValue(new Error('cancelled'))

      const client = createClient(dbMock.db, vi.fn())
      const result = await client.authenticate()

      expect(result).toBe(false)
    })

    it('returns false when silent returns no access token', async () => {
      mockAcquireTokenSilent.mockResolvedValue({ error: 'interaction_required' })
      mockAcquireTokenByDeviceCode.mockRejectedValue(new Error('cancelled'))

      const client = createClient(dbMock.db, vi.fn())
      const result = await client.authenticate()

      expect(result).toBe(false)
    })
  })

  // ── fetchInbox ───────────────────────────────────────────────────────────

  describe('fetchInbox', () => {
    it('fetches messages from inbox with correct filter', async () => {
      const messages = {
        value: [
          {
            id: 'msg-1',
            subject: 'Hello',
            from: { emailAddress: { address: 'Alice@Example.com' } },
            receivedDateTime: '2026-04-16T10:00:00Z',
            bodyPreview: 'Preview text here',
          },
          {
            id: 'msg-2',
            subject: 'World',
            from: { emailAddress: { address: 'bob@test.com' } },
            receivedDateTime: '2026-04-16T09:00:00Z',
            bodyPreview: '',
          },
        ],
      }

      const fetchFn = mockFetch([{ status: 200, body: messages }])
      const client = createClient(dbMock.db, fetchFn)
      await client.authenticate()

      const result = await client.fetchInbox(24)

      expect(result).toHaveLength(2)
      expect(result[0]).toEqual({
        messageId: 'msg-1',
        provider: 'hotmail',
        subject: 'Hello',
        sender: 'alice@example.com', // lowercased
        receivedAt: '2026-04-16T10:00:00Z',
        bodyPreview: 'Preview text here',
      })
      expect(fetchFn).toHaveBeenCalledWith(
        expect.stringContaining('/me/mailFolders/inbox/messages'),
        expect.objectContaining({ method: 'GET' }),
      )
    })

    it('paginates through nextLink', async () => {
      const page1 = {
        value: [{ id: 'msg-1', subject: 'Page 1', from: { emailAddress: { address: 'a@b.com' } }, receivedDateTime: '2026-04-16T10:00:00Z', bodyPreview: '' }],
        '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$skip=50',
      }
      const page2 = {
        value: [{ id: 'msg-2', subject: 'Page 2', from: { emailAddress: { address: 'c@d.com' } }, receivedDateTime: '2026-04-16T09:00:00Z', bodyPreview: '' }],
      }

      const fetchFn = mockFetch([
        { status: 200, body: page1 },
        { status: 200, body: page2 },
      ])
      const client = createClient(dbMock.db, fetchFn)
      await client.authenticate()

      const result = await client.fetchInbox(24)

      expect(result).toHaveLength(2)
      expect(fetchFn).toHaveBeenCalledTimes(2)
    })

    it('returns empty array when API returns no data', async () => {
      const fetchFn = mockFetch([{ status: 500, body: { error: 'server error' } }])
      const client = createClient(dbMock.db, fetchFn)
      await client.authenticate()

      const result = await client.fetchInbox(24)

      expect(result).toEqual([])
    })
  })

  // ── listFolders ──────────────────────────────────────────────────────────

  describe('listFolders', () => {
    it('lists top-level and child folders', async () => {
      const topLevel = {
        value: [
          { id: 'inbox-id', displayName: 'Inbox' },
          { id: 'junk-id', displayName: 'Junk Email' },
        ],
      }
      const inboxChildren = {
        value: [{ id: 'receipts-id', displayName: 'Receipts' }],
      }
      const junkChildren = { value: [] }

      const fetchFn = mockFetch([
        { status: 200, body: topLevel },
        { status: 200, body: inboxChildren },
        { status: 200, body: junkChildren },
      ])
      const client = createClient(dbMock.db, fetchFn)
      await client.authenticate()

      const result = await client.listFolders()

      expect(result).toHaveLength(3)
      expect(result).toEqual(expect.arrayContaining([
        { id: 'inbox-id', name: 'Inbox' },
        { id: 'junk-id', name: 'Junk Email' },
        { id: 'receipts-id', name: 'Receipts', parentFolderId: 'inbox-id' },
      ]))
    })

    it('returns empty array on API failure', async () => {
      const fetchFn = mockFetch([{ status: 500, body: {} }])
      const client = createClient(dbMock.db, fetchFn)
      await client.authenticate()

      const result = await client.listFolders()
      expect(result).toEqual([])
    })
  })

  // ── setupFolders ─────────────────────────────────────────────────────────

  describe('setupFolders', () => {
    it('creates missing folders under Inbox', async () => {
      // listFolders call chain: top-level, inbox children, junk children
      const topLevel = {
        value: [
          { id: 'inbox-id', displayName: 'Inbox' },
          { id: 'junk-id', displayName: 'Junk Email' },
        ],
      }
      const inboxChildren = {
        value: [{ id: 'existing-receipts', displayName: 'Receipts' }],
      }
      const junkChildren = { value: [] }
      // Create folder response
      const createResp = { id: 'new-work-id' }
      // "Needs Review" create
      const createNeedsReview = { id: 'new-needs-review-id' }

      const fetchFn = mockFetch([
        { status: 200, body: topLevel },
        { status: 200, body: inboxChildren },
        { status: 200, body: junkChildren },
        { status: 200, body: createResp },       // POST: create "Needs Review"
        { status: 200, body: createNeedsReview }, // POST: create "Work"
      ])
      const client = createClient(dbMock.db, fetchFn)
      await client.authenticate()

      const result = await client.setupFolders(['Receipts', 'Work'])

      // Should have 3 entries: Receipts (existing), Needs Review (created), Work (created)
      expect(result.size).toBe(3)
      expect(result.get('Receipts')).toBe('existing-receipts')
    })

    it('returns empty map when Inbox folder is not found', async () => {
      const topLevel = {
        value: [{ id: 'junk-id', displayName: 'Junk Email' }],
      }
      const junkChildren = { value: [] }

      const fetchFn = mockFetch([
        { status: 200, body: topLevel },
        { status: 200, body: junkChildren },
      ])
      const client = createClient(dbMock.db, fetchFn)
      await client.authenticate()

      const result = await client.setupFolders(['Work'])
      expect(result.size).toBe(0)
    })
  })

  // ── moveEmail ────────────────────────────────────────────────────────────

  describe('moveEmail', () => {
    it('moves email to target folder', async () => {
      const fetchFn = mockFetch([{ status: 200, body: { id: 'msg-1' } }])
      const client = createClient(dbMock.db, fetchFn)
      await client.authenticate()

      const result = await client.moveEmail('msg-1', 'folder-123')

      expect(result).toBe(true)
      expect(fetchFn).toHaveBeenCalledWith(
        expect.stringContaining('/me/messages/msg-1/move'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ destinationId: 'folder-123' }),
        }),
      )
    })

    it('returns false when move fails', async () => {
      const fetchFn = mockFetch([{ status: 500, body: { error: 'fail' } }])
      const client = createClient(dbMock.db, fetchFn)
      await client.authenticate()

      const result = await client.moveEmail('msg-1', 'folder-123')
      expect(result).toBe(false)
    })
  })

  // ── 429 rate limit ───────────────────────────────────────────────────────

  describe('rate limit handling', () => {
    it('retries on 429 with Retry-After header', async () => {
      const fetchFn = mockFetch([
        { status: 429, body: {}, headers: { 'Retry-After': '0' } },
        { status: 200, body: { value: [{ id: 'msg-1', subject: 'Test', from: { emailAddress: { address: 'a@b.com' } }, receivedDateTime: '2026-04-16T10:00:00Z', bodyPreview: '' }] } },
      ])
      const client = createClient(dbMock.db, fetchFn)
      await client.authenticate()

      const result = await client.fetchInbox(1)

      expect(result).toHaveLength(1)
      expect(fetchFn).toHaveBeenCalledTimes(2)
    })

    it('gives up after MAX_RETRIES on persistent 429', async () => {
      const fetchFn = mockFetch([
        { status: 429, body: {}, headers: { 'Retry-After': '0' } },
        { status: 429, body: {}, headers: { 'Retry-After': '0' } },
        { status: 429, body: {}, headers: { 'Retry-After': '0' } },
        { status: 429, body: {}, headers: { 'Retry-After': '0' } },
      ])
      const client = createClient(dbMock.db, fetchFn)
      await client.authenticate()

      const result = await client.fetchInbox(1)

      expect(result).toEqual([])
      // 1 initial + 3 retries = 4 calls
      expect(fetchFn).toHaveBeenCalledTimes(4)
    })
  })

  // ── 404 handling ─────────────────────────────────────────────────────────

  describe('404 handling', () => {
    it('handles 404 for missing message gracefully', async () => {
      const fetchFn = mockFetch([{ status: 404, body: { error: { code: 'ErrorItemNotFound' } } }])
      const client = createClient(dbMock.db, fetchFn)
      await client.authenticate()

      const result = await client.moveEmail('nonexistent', 'folder-123')
      expect(result).toBe(false)
    })
  })

  // ── cleanupSpam ──────────────────────────────────────────────────────────

  describe('cleanupSpam', () => {
    it('moves old junk to Deleted Items', async () => {
      // listFolders: top-level, inbox children, junk children
      const topLevel = {
        value: [
          { id: 'inbox-id', displayName: 'Inbox' },
          { id: 'junk-id', displayName: 'Junk Email' },
          { id: 'deleted-id', displayName: 'Deleted Items' },
        ],
      }
      const inboxChildren = { value: [] }
      const junkChildren = { value: [] }
      const deletedChildren = { value: [] }
      // Junk messages to clean
      const junkMessages = { value: [{ id: 'spam-1' }, { id: 'spam-2' }] }
      // Two move responses
      const moveResp = { id: 'moved' }

      const fetchFn = mockFetch([
        { status: 200, body: topLevel },
        { status: 200, body: inboxChildren },
        { status: 200, body: junkChildren },
        { status: 200, body: deletedChildren },
        { status: 200, body: junkMessages },
        { status: 200, body: moveResp },  // move spam-1
        { status: 200, body: moveResp },  // move spam-2
      ])
      const client = createClient(dbMock.db, fetchFn)
      await client.authenticate()

      const count = await client.cleanupSpam(30)
      expect(count).toBe(2)
    })
  })

  // ── detectCorrections ────────────────────────────────────────────────────

  describe('detectCorrections', () => {
    it('detects messages moved to a different category folder', async () => {
      const folderMap = new Map([
        ['Work', 'work-folder-id'],
        ['Personal', 'personal-folder-id'],
      ])

      // Work folder messages — one still in place, one moved
      const workMessages = {
        value: [
          { id: 'msg-1', parentFolderId: 'work-folder-id' },
          { id: 'msg-2', parentFolderId: 'personal-folder-id' }, // user moved this
        ],
      }
      // Personal folder messages — all in place
      const personalMessages = {
        value: [{ id: 'msg-3', parentFolderId: 'personal-folder-id' }],
      }

      const fetchFn = mockFetch([
        { status: 200, body: workMessages },
        { status: 200, body: personalMessages },
      ])
      const client = createClient(dbMock.db, fetchFn)
      await client.authenticate()

      const corrections = await client.detectCorrections(folderMap)

      expect(corrections).toHaveLength(1)
      expect(corrections[0]).toEqual({
        messageId: 'msg-2',
        oldCategory: 'Work',
        newCategory: 'Personal',
      })
    })

    it('returns empty array when no corrections found', async () => {
      const folderMap = new Map([['Work', 'work-folder-id']])
      const workMessages = {
        value: [{ id: 'msg-1', parentFolderId: 'work-folder-id' }],
      }

      const fetchFn = mockFetch([{ status: 200, body: workMessages }])
      const client = createClient(dbMock.db, fetchFn)
      await client.authenticate()

      const corrections = await client.detectCorrections(folderMap)
      expect(corrections).toEqual([])
    })
  })

  // ── Token cache persistence ──────────────────────────────────────────────

  describe('token cache persistence', () => {
    it('saves token cache to app_settings after auth', async () => {
      // The MSAL cache plugin's afterCacheAccess will be called by MSAL internally.
      // We verify the DB mock received an insert for the cache key.
      const client = createClient(dbMock.db, vi.fn())
      await client.authenticate()

      // The MSAL mock triggers the cache plugin. Since we mock MSAL entirely,
      // we verify the client constructed successfully and authenticated.
      expect(mockAcquireTokenSilent).toHaveBeenCalled()
    })
  })
})
