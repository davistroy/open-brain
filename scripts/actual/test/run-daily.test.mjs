import { describe, it, expect, vi } from 'vitest'
import { runDaily } from '../lib/run-daily.mjs'

// Synthetic payees/amounts only (repo is PUBLIC; data rule). Amounts in cents.
const RULES_TEXT = `
exclude_transfer:   [ "acme card payment" ]
exclude_investment: [ "globex brokerage" ]
rules:
  - category: Groceries
    match: [ "umbrella foods" ]
  - category: Fuel
    match: [ "hooli gas" ]
`

function makeApi(overrides = {}) {
  return {
    runBankSync: vi.fn().mockResolvedValue(undefined),
    getAccounts: vi.fn().mockResolvedValue([{ id: 'acc1', name: 'Checking' }]),
    getAccountBalance: vi.fn().mockResolvedValue(250000),
    getPayees: vi.fn().mockResolvedValue([]),
    getCategories: vi.fn().mockResolvedValue([
      { id: 'cat-groc', name: 'Groceries', group_id: 'g1' },
      { id: 'cat-fuel', name: 'Fuel', group_id: 'g1' },
    ]),
    getCategoryGroups: vi.fn().mockResolvedValue([{ id: 'g1', name: 'Everyday', is_income: false }]),
    createCategory: vi.fn().mockResolvedValue('cat-new'),
    getTransactions: vi.fn().mockResolvedValue([]),
    updateTransaction: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

function makeDeps(overrides = {}) {
  const { api: apiOverride, ...rest } = overrides
  return {
    api: apiOverride ?? makeApi(),
    rulesText: RULES_TEXT,
    readState: vi.fn().mockReturnValue(null),
    writeState: vi.fn(),
    postCapture: vi.fn().mockResolvedValue({ ok: true, status: 200 }),
    sendPushover: vi.fn().mockResolvedValue(undefined),
    config: { date: '2026-07-16', startDate: '2026-07-09', endDate: '2026-07-16', thresholdMinor: 50000, pct: 0.05 },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...rest,
  }
}

describe('runDaily', () => {
  it('aborts (throws) when the rules text is missing or malformed', async () => {
    await expect(runDaily(makeDeps({ rulesText: null }))).rejects.toThrow()
    await expect(runDaily(makeDeps({ rulesText: 'rules: not-a-list' }))).rejects.toThrow(/rules/i)
  })

  it('categorizes an uncategorized transaction that matches a rule', async () => {
    const api = makeApi({
      getTransactions: vi.fn().mockResolvedValue([
        { id: 'tx1', account: 'acc1', amount: -3200, category: null, imported_payee: 'UMBRELLA FOODS #7' },
      ]),
    })
    await runDaily(makeDeps({ api }))
    expect(api.updateTransaction).toHaveBeenCalledWith('tx1', { category: 'cat-groc' })
  })

  it('INVARIANT: never categorizes a transfer or investment-internal payee', async () => {
    const api = makeApi({
      getTransactions: vi.fn().mockResolvedValue([
        { id: 'tx1', account: 'acc1', amount: -100000, category: null, imported_payee: 'ACME Card Payment' },
        { id: 'tx2', account: 'acc1', amount: -50000, category: null, imported_payee: 'Globex Brokerage buy' },
      ]),
    })
    await runDaily(makeDeps({ api }))
    expect(api.updateTransaction).not.toHaveBeenCalled()
  })

  it('leaves already-categorized transactions untouched', async () => {
    const api = makeApi({
      getTransactions: vi.fn().mockResolvedValue([
        { id: 'tx1', account: 'acc1', amount: -3200, category: 'cat-groc', imported_payee: 'Umbrella Foods' },
      ]),
    })
    await runDaily(makeDeps({ api }))
    expect(api.updateTransaction).not.toHaveBeenCalled()
  })

  it('resolves the payee name via getPayees (id → name) before classifying', async () => {
    const api = makeApi({
      getPayees: vi.fn().mockResolvedValue([{ id: 'p1', name: 'Hooli Gas' }]),
      getTransactions: vi.fn().mockResolvedValue([
        { id: 'tx1', account: 'acc1', amount: -5000, category: null, payee: 'p1' },
      ]),
    })
    await runDaily(makeDeps({ api }))
    expect(api.updateTransaction).toHaveBeenCalledWith('tx1', { category: 'cat-fuel' })
  })

  it('creates a category that does not exist yet, then uses its new id', async () => {
    const api = makeApi({
      getCategories: vi.fn().mockResolvedValue([]), // Groceries not present
      getTransactions: vi.fn().mockResolvedValue([
        { id: 'tx1', account: 'acc1', amount: -3200, category: null, imported_payee: 'Umbrella Foods' },
      ]),
    })
    await runDaily(makeDeps({ api }))
    expect(api.createCategory).toHaveBeenCalledWith(expect.objectContaining({ name: 'Groceries', group_id: 'g1' }))
    expect(api.updateTransaction).toHaveBeenCalledWith('tx1', { category: 'cat-new' })
  })

  it('continues and reports when runBankSync fails (non-fatal)', async () => {
    const api = makeApi({ runBankSync: vi.fn().mockRejectedValue(new Error('sync down')) })
    const deps = makeDeps({ api })
    await runDaily(deps)
    const posted = deps.postCapture.mock.calls[0][0]
    expect(posted.metadata.sync_failed).toBe(true)
    expect(deps.postCapture).toHaveBeenCalledOnce()
  })

  it('posts exactly one aggregated capture', async () => {
    const deps = makeDeps()
    await runDaily(deps)
    expect(deps.postCapture).toHaveBeenCalledOnce()
    const posted = deps.postCapture.mock.calls[0][0]
    expect(posted.source).toBe('api')
    expect(posted.metadata.pipeline).toBe('actual-ingest')
  })

  it('treats a 409 from core-api as terminal success (no throw)', async () => {
    const deps = makeDeps({ postCapture: vi.fn().mockResolvedValue({ ok: false, status: 409 }) })
    await expect(runDaily(deps)).resolves.not.toThrow()
  })

  it('throws when the capture POST fails with a non-409 error', async () => {
    const deps = makeDeps({ postCapture: vi.fn().mockResolvedValue({ ok: false, status: 502 }) })
    await expect(runDaily(deps)).rejects.toThrow(/502|capture/i)
  })

  it('isolates a per-transaction write failure and re-throws at the end (others still processed)', async () => {
    const api = makeApi({
      getTransactions: vi.fn().mockResolvedValue([
        { id: 'bad', account: 'acc1', amount: -3200, category: null, imported_payee: 'Umbrella Foods' },
        { id: 'good', account: 'acc1', amount: -5000, category: null, imported_payee: 'Hooli Gas' },
      ]),
      updateTransaction: vi
        .fn()
        .mockRejectedValueOnce(new Error('write failed'))
        .mockResolvedValueOnce(undefined),
    })
    const deps = makeDeps({ api })
    await expect(runDaily(deps)).rejects.toThrow(/write failed|categoriz/i)
    // both were attempted despite the first failing
    expect(api.updateTransaction).toHaveBeenCalledTimes(2)
    // and the capture was still posted before the end-of-run throw
    expect(deps.postCapture).toHaveBeenCalledOnce()
  })

  it('never lets a Pushover failure become fatal', async () => {
    const deps = makeDeps({ sendPushover: vi.fn().mockRejectedValue(new Error('pushover down')) })
    await expect(runDaily(deps)).resolves.not.toThrow()
  })

  it('records the current balances as state for the next run', async () => {
    const deps = makeDeps()
    await runDaily(deps)
    expect(deps.writeState).toHaveBeenCalledWith({ acc1: 250000 })
  })

  it('emits no balance alerts on the first run (no baseline)', async () => {
    const deps = makeDeps() // readState → null
    await runDaily(deps)
    expect(deps.postCapture.mock.calls[0][0].metadata.balance_alert_count).toBe(0)
  })
})
