import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EmailClassifySkill } from '../skills/email-classify.js'
import type { EmailClassifyOptions, EmailClassifySkillOpts } from '../skills/email-classify.js'
import { PushoverService } from '../services/pushover.js'
import type { EmailProvider, EmailMessage, EmailFolder } from '@open-brain/shared'
import { EmailClassifier } from '@open-brain/shared'
import type { EmailRules } from '@open-brain/shared'

// ============================================================
// Test fixtures
// ============================================================

const HOTMAIL_EMAILS: EmailMessage[] = [
  {
    messageId: 'hm-001',
    provider: 'hotmail',
    sender: 'noreply@amazon.com',
    subject: 'Your Amazon order has shipped',
    receivedAt: '2026-04-16T03:00:00Z',
    bodyPreview: 'Your package is on its way...',
  },
  {
    messageId: 'hm-002',
    provider: 'hotmail',
    sender: 'newsletter@techcrunch.com',
    subject: 'Daily Tech News Digest',
    receivedAt: '2026-04-16T04:00:00Z',
    bodyPreview: 'Top stories from today...',
  },
  {
    messageId: 'hm-003',
    provider: 'hotmail',
    sender: 'unknown@random.com',
    subject: 'Something ambiguous',
    receivedAt: '2026-04-16T04:30:00Z',
    bodyPreview: 'Hello, I wanted to discuss...',
  },
]

const GMAIL_EMAILS: EmailMessage[] = [
  {
    messageId: 'gm-001',
    provider: 'gmail',
    sender: 'billing@utilities.com',
    subject: 'Your monthly utility bill',
    receivedAt: '2026-04-16T02:00:00Z',
    bodyPreview: 'Your statement is ready...',
  },
]

const TEST_RULES: EmailRules = {
  groups: {
    shopping: ['Shopping & Orders'],
    newsletters: ['Newsletters'],
    utilities: ['Utilities & Bills'],
  },
  senderRules: new Map([
    ['noreply@amazon.com', 'Shopping & Orders'],
    ['billing@utilities.com', 'Utilities & Bills'],
  ]),
  keywordRules: new Map([
    ['Newsletters', ['digest', 'newsletter', 'weekly']],
  ]),
  categories: new Set(['Shopping & Orders', 'Newsletters', 'Utilities & Bills', 'Needs Review']),
  autoMoveThreshold: 0.85,
  jetson: {
    baseUrl: 'http://192.168.10.58:8080/v1',
    model: 'qwen3.5-4b',
    maxTokens: 256,
    temperature: 0.1,
  },
  protectedFolders: ['Inbox', 'Sent Items'],
  spamMaxAgeDays: 30,
}

// ============================================================
// Mock helpers
// ============================================================

function makeFolderMap(cats: string[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const cat of cats) {
    map.set(cat, `folder-${cat.toLowerCase().replace(/\s+/g, '-')}`)
  }
  map.set('Needs Review', 'folder-needs-review')
  return map
}

function makeMockProvider(opts: {
  emails?: EmailMessage[]
  authSuccess?: boolean
  moveSuccess?: boolean
} = {}): EmailProvider {
  const emails = opts.emails ?? []
  const authSuccess = opts.authSuccess ?? true
  const moveSuccess = opts.moveSuccess ?? true
  const folderMap = makeFolderMap([...TEST_RULES.categories])

  return {
    authenticate: vi.fn().mockResolvedValue(authSuccess),
    fetchInbox: vi.fn().mockResolvedValue(emails),
    listFolders: vi.fn().mockResolvedValue([]),
    setupFolders: vi.fn().mockResolvedValue(folderMap),
    moveEmail: vi.fn().mockResolvedValue(moveSuccess),
    cleanupSpam: vi.fn().mockResolvedValue(0),
    detectCorrections: vi.fn().mockResolvedValue([]),
  }
}

function makeMockDb() {
  /**
   * Creates a deeply-chainable mock that resolves to `resolveValue`
   * regardless of what Drizzle chain methods are called.
   * Every method returns the same chainable proxy so that
   * .select().from().where().groupBy().orderBy() all work.
   */
  function chainable(resolveValue: unknown = []): Record<string, any> {
    const obj: Record<string, any> = {}
    const methods = [
      'select', 'from', 'where', 'groupBy', 'orderBy',
      'limit', 'offset', 'innerJoin', 'leftJoin',
    ]
    for (const m of methods) {
      obj[m] = vi.fn().mockReturnValue(obj)
    }
    // When awaited (thenable), resolve with the value
    obj.then = (resolve: (v: unknown) => void) => Promise.resolve(resolveValue).then(resolve)
    return obj
  }

  const selectMock = vi.fn().mockImplementation(() => chainable([]))

  const insertMock = vi.fn().mockImplementation(() => ({
    values: vi.fn().mockImplementation(() => ({
      onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
      then: (resolve: (v: unknown) => void) => Promise.resolve(undefined).then(resolve),
    })),
  }))

  return {
    insert: insertMock,
    select: selectMock,
    execute: vi.fn().mockResolvedValue({ rows: [] }),
  }
}

function makeMockLLMGateway() {
  return {
    completeByTask: vi.fn().mockResolvedValue(
      'Today saw 4 emails across Shopping, Newsletters, and Utilities categories. ' +
      'One order shipped from Amazon. No immediate action items.',
    ),
  }
}

function makePushoverService(configured = true) {
  const svc = new PushoverService('fake-token', 'fake-user')
  if (!configured) {
    Object.defineProperty(svc, 'isConfigured', { get: () => false })
  }
  vi.spyOn(svc, 'send').mockResolvedValue(undefined)
  return svc
}

function makeSkill(opts: {
  hotmailEmails?: EmailMessage[]
  gmailEmails?: EmailMessage[]
  hotmailAuth?: boolean
  gmailAuth?: boolean
  noHotmail?: boolean
  noGmail?: boolean
  pushoverConfigured?: boolean
  withLLM?: boolean
} = {}) {
  const db = makeMockDb()
  const pushover = makePushoverService(opts.pushoverConfigured ?? true)
  const classifier = new EmailClassifier(TEST_RULES, null)
  const llmGateway = opts.withLLM ? makeMockLLMGateway() : null

  const hotmailClient = opts.noHotmail
    ? null
    : makeMockProvider({
        emails: opts.hotmailEmails ?? HOTMAIL_EMAILS,
        authSuccess: opts.hotmailAuth ?? true,
      })
  const gmailClient = opts.noGmail
    ? null
    : makeMockProvider({
        emails: opts.gmailEmails ?? GMAIL_EMAILS,
        authSuccess: opts.gmailAuth ?? true,
      })

  const skillOpts: EmailClassifySkillOpts = {
    db: db as any,
    pushover,
    hotmailClient,
    gmailClient,
    classifier,
    llmGateway: llmGateway as any,
    rules: TEST_RULES,
    coreApiUrl: 'http://localhost:3000',
  }

  const skill = new EmailClassifySkill(skillOpts)

  return { skill, db, pushover, hotmailClient, gmailClient, classifier, llmGateway }
}

// ============================================================
// Tests
// ============================================================

describe('EmailClassifySkill', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    // Mock fetch globally for capture posting
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: () => Promise.resolve({ id: 'cap-123', pipeline_status: 'pending', created_at: new Date().toISOString() }),
      text: () => Promise.resolve(''),
    })
  })

  // ────────────────────────────────────────────────────────────
  // Basic pipeline execution
  // ────────────────────────────────────────────────────────────

  it('classifies emails from both providers', async () => {
    const { skill } = makeSkill()

    const result = await skill.execute({ providers: ['hotmail', 'gmail'] })

    // Hotmail: 3 emails (amazon=sender match, techcrunch=keyword match, random=needs review)
    expect(result.hotmail.classified).toBe(3)
    // Gmail: 1 email (utilities=sender match)
    expect(result.gmail.classified).toBe(1)
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('processes only requested providers', async () => {
    const { skill, gmailClient } = makeSkill()

    const result = await skill.execute({ providers: ['hotmail'] })

    expect(result.hotmail.classified).toBe(3)
    expect(result.gmail.classified).toBe(0)
    // Gmail client should not have been called
    expect(gmailClient?.authenticate).not.toHaveBeenCalled()
  })

  // ────────────────────────────────────────────────────────────
  // Skip already-processed emails
  // ────────────────────────────────────────────────────────────

  it('skips already-processed emails', async () => {
    const { skill, db } = makeSkill()

    // Override select to return a row for hm-001 (already processed)
    let selectCallCount = 0
    db.select = vi.fn().mockImplementation(() => {
      selectCallCount++
      // First select call is isProcessed for hm-001 -> found (skip it)
      // Subsequent calls resolve to empty (not processed / summary queries)
      const resolveValue = selectCallCount === 1 ? [{ id: 'existing-row' }] : []

      const obj: Record<string, any> = {}
      const methods = [
        'select', 'from', 'where', 'groupBy', 'orderBy',
        'limit', 'offset', 'innerJoin', 'leftJoin',
      ]
      for (const m of methods) {
        obj[m] = vi.fn().mockReturnValue(obj)
      }
      obj.then = (resolve: (v: unknown) => void) =>
        Promise.resolve(resolveValue).then(resolve)
      return obj
    })

    const result = await skill.execute({ providers: ['hotmail'] })

    expect(result.hotmail.skipped).toBe(1)
    expect(result.hotmail.classified).toBe(2)
  })

  // ────────────────────────────────────────────────────────────
  // Folder organization: above threshold vs "Needs Review"
  // ────────────────────────────────────────────────────────────

  it('moves emails above threshold to correct folders', async () => {
    const { skill, hotmailClient } = makeSkill()

    await skill.execute({ providers: ['hotmail'] })

    // Amazon (sender match, confidence 1.0) should be moved
    expect(hotmailClient?.moveEmail).toHaveBeenCalled()
  })

  it('routes low-confidence emails to Needs Review', async () => {
    const { skill } = makeSkill()

    const result = await skill.execute({ providers: ['hotmail'] })

    // hm-003 from unknown@random.com: no sender rule, no keyword match,
    // no LLM configured -> falls through to "Needs Review" (confidence 0.0)
    expect(result.hotmail.needsReview).toBeGreaterThanOrEqual(1)
  })

  // ────────────────────────────────────────────────────────────
  // Dry run mode
  // ────────────────────────────────────────────────────────────

  it('classifies but does not move in dry run mode', async () => {
    const { skill, hotmailClient, gmailClient } = makeSkill()

    const result = await skill.execute({
      providers: ['hotmail', 'gmail'],
      dryRun: true,
    })

    // Emails are classified
    expect(result.hotmail.classified).toBe(3)
    expect(result.gmail.classified).toBe(1)

    // But none are moved
    expect(result.hotmail.moved).toBe(0)
    expect(result.gmail.moved).toBe(0)
    expect(hotmailClient?.moveEmail).not.toHaveBeenCalled()
    expect(gmailClient?.moveEmail).not.toHaveBeenCalled()

    // No spam cleanup in dry run
    expect(hotmailClient?.cleanupSpam).not.toHaveBeenCalled()
    expect(gmailClient?.cleanupSpam).not.toHaveBeenCalled()

    // No summary posted in dry run
    expect(result.summaryPosted).toBe(false)
  })

  // ────────────────────────────────────────────────────────────
  // Daily summary generation
  // ────────────────────────────────────────────────────────────

  it('posts daily summary as capture when not dry run', async () => {
    const { skill, db, llmGateway } = makeSkill({ withLLM: true })

    // The pipeline flow makes these select() calls in order:
    //   1..3 = isProcessed checks (one per hotmail email) -> return []
    //   4    = getRecentClassifications (corrections) -> return []
    //   5    = getDailySummary check -> return [] (not posted yet)
    //   6    = getOvernightSummary category counts -> must return data
    //   7+   = getOvernightSummary per-category subject queries -> return subjects
    let selectCallIdx = 0
    db.select = vi.fn().mockImplementation(() => {
      selectCallIdx++
      let resolveValue: unknown[] = []

      // Call 6: overnight category aggregation (groupBy query)
      if (selectCallIdx === 6) {
        resolveValue = [
          { category: 'Shopping & Orders', count: 1 },
          { category: 'Newsletters', count: 1 },
          { category: 'Needs Review', count: 1 },
        ]
      }
      // Call 7+: per-category subject queries
      if (selectCallIdx >= 7 && selectCallIdx <= 9) {
        resolveValue = [{ subject: 'Test email subject' }]
      }

      const obj: Record<string, any> = {}
      const methods = [
        'select', 'from', 'where', 'groupBy', 'orderBy',
        'limit', 'offset', 'innerJoin', 'leftJoin',
      ]
      for (const m of methods) {
        obj[m] = vi.fn().mockReturnValue(obj)
      }
      obj.then = (resolve: (v: unknown) => void) =>
        Promise.resolve(resolveValue).then(resolve)
      return obj
    })

    await skill.execute({ providers: ['hotmail'] })

    // Should have called fetch to post capture
    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:3000/api/v1/captures',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'X-Open-Brain-Caller': 'email-classify',
        }),
      }),
    )

    // A.5 Test 1: LLM gateway must be invoked with the 'email_daily_digest' task name
    // (not the legacy 'synthesis' alias that caused A59 401s).
    expect(llmGateway?.completeByTask).toHaveBeenCalledWith(
      expect.any(String),
      'email_daily_digest',
      expect.objectContaining({ maxTokens: 1024 }),
    )

    // A.5 Test 2: the capture POST body must include capture_type: 'observation'
    // plus the expected content/source/source_metadata shape.
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>
    const capturePostCall = fetchMock.mock.calls.find(
      ([url]) => typeof url === 'string' && url.endsWith('/api/v1/captures'),
    )
    expect(capturePostCall).toBeDefined()
    const [, init] = capturePostCall!
    const parsedBody = JSON.parse((init as RequestInit).body as string)
    expect(parsedBody).toMatchObject({
      capture_type: 'observation',
      source: 'email',
      source_metadata: expect.objectContaining({ type: 'daily_digest' }),
    })
    expect(typeof parsedBody.content).toBe('string')
    expect(parsedBody.content).toContain('[Email Daily Digest]')
  })

  // ────────────────────────────────────────────────────────────
  // Auth failure handling
  // ────────────────────────────────────────────────────────────

  it('handles auth failure gracefully and continues with next provider', async () => {
    const { skill } = makeSkill({
      hotmailAuth: false,
      gmailAuth: true,
    })

    // Should not throw — hotmail fails auth, gmail succeeds
    const result = await skill.execute({ providers: ['hotmail', 'gmail'] })

    // Hotmail: no emails processed (auth failed)
    expect(result.hotmail.classified).toBe(0)
    // Gmail: processed normally
    expect(result.gmail.classified).toBe(1)
  })

  // ────────────────────────────────────────────────────────────
  // Empty inbox
  // ────────────────────────────────────────────────────────────

  it('handles empty inbox gracefully', async () => {
    const { skill } = makeSkill({
      hotmailEmails: [],
      gmailEmails: [],
    })

    const result = await skill.execute()

    expect(result.hotmail.classified).toBe(0)
    expect(result.gmail.classified).toBe(0)
    expect(result.hotmail.moved).toBe(0)
    expect(result.gmail.moved).toBe(0)
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  // ────────────────────────────────────────────────────────────
  // No client configured
  // ────────────────────────────────────────────────────────────

  it('skips providers with no client configured', async () => {
    const { skill } = makeSkill({ noHotmail: true, noGmail: true })

    const result = await skill.execute()

    expect(result.hotmail.classified).toBe(0)
    expect(result.gmail.classified).toBe(0)
  })

  // ────────────────────────────────────────────────────────────
  // Notification behavior
  // ────────────────────────────────────────────────────────────

  it('sends Pushover notification when emails are classified', async () => {
    const { skill, pushover } = makeSkill()

    await skill.execute({ providers: ['hotmail'] })

    expect(pushover.send).toHaveBeenCalledWith(
      expect.objectContaining({
        title: expect.stringContaining('Email Pipeline'),
        message: expect.stringContaining('Hotmail:'),
      }),
    )
  })

  it('does not send notification when no emails processed', async () => {
    const { skill, pushover } = makeSkill({
      hotmailEmails: [],
      gmailEmails: [],
    })

    await skill.execute()

    expect(pushover.send).not.toHaveBeenCalled()
  })

  // ────────────────────────────────────────────────────────────
  // Classification tiering
  // ────────────────────────────────────────────────────────────

  it('uses sender rules for known senders (T0)', async () => {
    // Amazon email should classify via sender rule
    const { skill } = makeSkill({
      hotmailEmails: [HOTMAIL_EMAILS[0]], // just the amazon email
    })

    const result = await skill.execute({ providers: ['hotmail'] })

    expect(result.hotmail.classified).toBe(1)
    // Sender rule match -> confidence 1.0 -> moved (above 0.85 threshold)
    expect(result.hotmail.moved).toBe(1)
    expect(result.hotmail.needsReview).toBe(0)
  })

  it('uses keyword rules for subject match (T0)', async () => {
    const { skill } = makeSkill({
      hotmailEmails: [HOTMAIL_EMAILS[1]], // techcrunch digest
    })

    const result = await skill.execute({ providers: ['hotmail'] })

    expect(result.hotmail.classified).toBe(1)
    // Keyword match -> confidence = min(0.5 + 0.15, 0.9) = 0.65 -> below 0.85 -> Needs Review
    expect(result.hotmail.needsReview).toBe(1)
  })

  it('falls through to Needs Review when no rules match', async () => {
    const { skill } = makeSkill({
      hotmailEmails: [HOTMAIL_EMAILS[2]], // unknown@random.com
    })

    const result = await skill.execute({ providers: ['hotmail'] })

    expect(result.hotmail.classified).toBe(1)
    expect(result.hotmail.needsReview).toBe(1)
  })

  // ────────────────────────────────────────────────────────────
  // Result structure
  // ────────────────────────────────────────────────────────────

  it('returns correctly structured result', async () => {
    const { skill } = makeSkill()

    const result = await skill.execute()

    expect(result).toHaveProperty('hotmail')
    expect(result).toHaveProperty('gmail')
    expect(result).toHaveProperty('corrections')
    expect(result).toHaveProperty('summaryPosted')
    expect(result).toHaveProperty('durationMs')

    expect(result.hotmail).toHaveProperty('classified')
    expect(result.hotmail).toHaveProperty('moved')
    expect(result.hotmail).toHaveProperty('needsReview')
    expect(result.hotmail).toHaveProperty('skipped')
    expect(result.hotmail).toHaveProperty('errors')
  })
})
