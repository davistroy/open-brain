import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EmailDraftService } from '../services/email-draft.js'
import type { Database } from '@open-brain/shared'
import type { HimalayaService, PushoverService } from '@open-brain/shared'

// ---------------------------------------------------------------------------
// Sample data
// ---------------------------------------------------------------------------

const SAMPLE_DRAFT = {
  id: 'draft-uuid-1',
  to_address: 'test@example.com',
  cc_address: null,
  subject: 'Test Subject',
  body: 'Test body content',
  status: 'draft',
  send_mode: 'review-required',
  source: 'api',
  approved_at: null,
  sent_at: null,
  himalaya_message_id: null,
  capture_id: null,
  metadata: null,
  created_at: new Date('2026-04-11T00:00:00Z'),
  updated_at: new Date('2026-04-11T00:00:00Z'),
}

// ---------------------------------------------------------------------------
// Mock helpers
//
// Drizzle chains: .select().from().where().orderBy().limit().offset()
// Each method returns `this` except the terminal which returns Promise<rows>.
// For queries without offset, limit() is the terminal.
// For queries with offset, offset() is the terminal.
// ---------------------------------------------------------------------------

function makeSelectChain(rows: unknown[]) {
  // Create a thenable chain — every method returns the chain,
  // and awaiting the chain resolves to rows.
  const chain: Record<string, any> = {}
  const promise = Promise.resolve(rows)

  for (const method of ['from', 'where', 'orderBy', 'limit', 'offset']) {
    chain[method] = vi.fn().mockReturnValue(chain)
  }

  // Make the chain itself thenable so `await db.select()...limit(1)` works
  chain.then = (resolve: any, reject: any) => promise.then(resolve, reject)
  chain.catch = (reject: any) => promise.catch(reject)

  return chain
}

function makeInsertChain(returning: unknown[] = []) {
  return {
    values: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue(returning),
      onConflictDoUpdate: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue(returning),
      }),
    }),
  }
}

function makeUpdateChain(returning: unknown[] = []) {
  return {
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue(returning),
      }),
    }),
  }
}

/**
 * Create a mock Database.
 * selectRowSets: array of row arrays — each call to db.select() pops the next.
 */
function makeDb(opts: {
  selectRowSets?: unknown[][]
  insertRowSets?: unknown[][]
  updateRowSets?: unknown[][]
} = {}): Database {
  const selectSets = [...(opts.selectRowSets ?? [[SAMPLE_DRAFT], [{ count: 1 }]])]
  const insertSets = [...(opts.insertRowSets ?? [[SAMPLE_DRAFT]])]
  const updateSets = [...(opts.updateRowSets ?? [[SAMPLE_DRAFT]])]

  return {
    select: vi.fn().mockImplementation(() => {
      const rows = selectSets.shift() ?? []
      return makeSelectChain(rows)
    }),
    insert: vi.fn().mockImplementation(() => {
      const rows = insertSets.shift() ?? []
      return makeInsertChain(rows)
    }),
    update: vi.fn().mockImplementation(() => {
      const rows = updateSets.shift() ?? []
      return makeUpdateChain(rows)
    }),
  } as unknown as Database
}

function makeHimalaya(overrides: Partial<HimalayaService> = {}): HimalayaService {
  return {
    isConfigured: true,
    send: vi.fn().mockResolvedValue({ success: true, output: 'msg-id-123' }),
    checkConnection: vi.fn().mockResolvedValue(true),
    ...overrides,
  } as unknown as HimalayaService
}

function makePushover(overrides: Partial<PushoverService> = {}): PushoverService {
  return {
    isConfigured: true,
    send: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as PushoverService
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EmailDraftService', () => {
  let himalaya: HimalayaService
  let pushover: PushoverService

  beforeEach(() => {
    himalaya = makeHimalaya()
    pushover = makePushover()
  })

  describe('create', () => {
    it('inserts a draft with default review-required mode', async () => {
      const db = makeDb({ insertRowSets: [[SAMPLE_DRAFT]] })
      const service = new EmailDraftService(db, himalaya, pushover)

      const result = await service.create({
        to: 'test@example.com',
        subject: 'Hello',
        body: 'Body text',
      })

      expect(result.id).toBe('draft-uuid-1')
      expect(db.insert).toHaveBeenCalled()
    })

    it('sends Pushover notification for review-required drafts', async () => {
      const db = makeDb({ insertRowSets: [[SAMPLE_DRAFT]] })
      const service = new EmailDraftService(db, himalaya, pushover)

      await service.create({
        to: 'test@example.com',
        subject: 'Hello',
        body: 'Body text',
        sendMode: 'review-required',
      })

      expect(pushover.send).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Email Draft for Review',
        }),
      )
    })

    it('does not send Pushover for auto-send drafts (sends immediately instead)', async () => {
      const sentDraft = { ...SAMPLE_DRAFT, status: 'sent', send_mode: 'auto-send', sent_at: new Date() }
      // insert: first for draft, second for outbound capture
      // select: for get() inside send()
      // update: first for send status, second for linking capture
      const db = makeDb({
        insertRowSets: [[SAMPLE_DRAFT], [{ id: 'capture-1' }]],
        selectRowSets: [[SAMPLE_DRAFT]],
        updateRowSets: [[sentDraft], [sentDraft]],
      })
      const service = new EmailDraftService(db, himalaya, pushover)

      await service.create({
        to: 'test@example.com',
        subject: 'Hello',
        body: 'Body text',
        sendMode: 'auto-send',
      })

      expect(pushover.send).not.toHaveBeenCalled()
      expect(himalaya.send).toHaveBeenCalled()
    })
  })

  describe('list', () => {
    it('returns paginated results', async () => {
      const db = makeDb({
        selectRowSets: [[SAMPLE_DRAFT], [{ count: 1 }]],
      })
      const service = new EmailDraftService(db, himalaya, pushover)

      const result = await service.list()
      expect(result.items).toHaveLength(1)
      expect(result.total).toBe(1)
    })

    it('passes status filter', async () => {
      const db = makeDb({
        selectRowSets: [[SAMPLE_DRAFT], [{ count: 1 }]],
      })
      const service = new EmailDraftService(db, himalaya, pushover)

      await service.list('draft')
      expect(db.select).toHaveBeenCalledTimes(2)
    })
  })

  describe('get', () => {
    it('returns draft by id', async () => {
      const db = makeDb({ selectRowSets: [[SAMPLE_DRAFT]] })
      const service = new EmailDraftService(db, himalaya, pushover)

      const result = await service.get('draft-uuid-1')
      expect(result.id).toBe('draft-uuid-1')
    })

    it('throws NotFoundError for missing draft', async () => {
      const db = makeDb({ selectRowSets: [[]] })
      const service = new EmailDraftService(db, himalaya, pushover)

      await expect(service.get('nonexistent')).rejects.toThrow('not found')
    })
  })

  describe('approve', () => {
    it('sets status to approved', async () => {
      const approved = { ...SAMPLE_DRAFT, status: 'approved', approved_at: new Date() }
      const db = makeDb({
        selectRowSets: [[SAMPLE_DRAFT]],
        updateRowSets: [[approved]],
      })
      const service = new EmailDraftService(db, himalaya, pushover)

      const result = await service.approve('draft-uuid-1')
      expect(result.status).toBe('approved')
    })

    it('throws if draft is not in draft status', async () => {
      const sentDraft = { ...SAMPLE_DRAFT, status: 'sent' }
      const db = makeDb({ selectRowSets: [[sentDraft]] })
      const service = new EmailDraftService(db, himalaya, pushover)

      await expect(service.approve('draft-uuid-1')).rejects.toThrow('Cannot approve')
    })
  })

  describe('reject', () => {
    it('sets status to rejected', async () => {
      const rejected = { ...SAMPLE_DRAFT, status: 'rejected' }
      const db = makeDb({
        selectRowSets: [[SAMPLE_DRAFT]],
        updateRowSets: [[rejected]],
      })
      const service = new EmailDraftService(db, himalaya, pushover)

      const result = await service.reject('draft-uuid-1')
      expect(result.status).toBe('rejected')
    })

    it('throws if draft has already been sent', async () => {
      const sentDraft = { ...SAMPLE_DRAFT, status: 'sent' }
      const db = makeDb({ selectRowSets: [[sentDraft]] })
      const service = new EmailDraftService(db, himalaya, pushover)

      await expect(service.reject('draft-uuid-1')).rejects.toThrow('already been sent')
    })
  })

  describe('send', () => {
    it('sends via Himalaya and updates status', async () => {
      const sentDraft = { ...SAMPLE_DRAFT, status: 'sent', sent_at: new Date() }
      const db = makeDb({
        selectRowSets: [[SAMPLE_DRAFT]],
        updateRowSets: [[sentDraft], [sentDraft]], // send update + capture link update
        insertRowSets: [[{ id: 'capture-1' }]], // outbound capture
      })
      const service = new EmailDraftService(db, himalaya, pushover)

      const result = await service.send('draft-uuid-1')
      expect(result.status).toBe('sent')
      expect(himalaya.send).toHaveBeenCalledWith(
        'test@example.com',
        'Test Subject',
        'Test body content',
        { cc: undefined },
      )
    })

    it('throws if already sent', async () => {
      const sentDraft = { ...SAMPLE_DRAFT, status: 'sent' }
      const db = makeDb({ selectRowSets: [[sentDraft]] })
      const service = new EmailDraftService(db, himalaya, pushover)

      await expect(service.send('draft-uuid-1')).rejects.toThrow('already been sent')
    })

    it('throws if Himalaya not configured', async () => {
      const db = makeDb({ selectRowSets: [[SAMPLE_DRAFT]] })
      himalaya = makeHimalaya({ isConfigured: false })
      const service = new EmailDraftService(db, himalaya, pushover)

      await expect(service.send('draft-uuid-1')).rejects.toThrow('not configured')
    })

    it('marks draft as failed when Himalaya throws', async () => {
      const db = makeDb({
        selectRowSets: [[SAMPLE_DRAFT]],
        updateRowSets: [[{ ...SAMPLE_DRAFT, status: 'failed' }]],
      })
      himalaya = makeHimalaya({
        send: vi.fn().mockRejectedValue(new Error('SMTP connection refused')),
      })
      const service = new EmailDraftService(db, himalaya, pushover)

      await expect(service.send('draft-uuid-1')).rejects.toThrow('SMTP connection refused')
      expect(db.update).toHaveBeenCalled()
    })
  })

  describe('approveThenSend', () => {
    it('approves and then sends in sequence', async () => {
      const approved = { ...SAMPLE_DRAFT, status: 'approved', approved_at: new Date() }
      const sent = { ...approved, status: 'sent', sent_at: new Date() }

      // select: get for approve, get for send
      // update: approve, send, capture link
      const db = makeDb({
        selectRowSets: [[SAMPLE_DRAFT], [approved]],
        updateRowSets: [[approved], [sent], [sent]],
        insertRowSets: [[{ id: 'capture-1' }]],
      })
      const service = new EmailDraftService(db, himalaya, pushover)

      const result = await service.approveThenSend('draft-uuid-1')
      expect(result.status).toBe('sent')
      expect(himalaya.send).toHaveBeenCalled()
    })
  })
})
