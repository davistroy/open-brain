import { loadRules } from './rules.mjs'
import { classify } from './classify.mjs'
import { notableTransactions, balanceAlerts, toBalanceMap } from './alerts.mjs'
import { buildCapture } from './capture.mjs'

/**
 * Orchestrate one daily run (spec §1, §8, §9). All I/O is injected so the
 * money-correctness logic — the §5 phantom-income invariant, per-item fault
 * isolation, 409-as-success, sync-failure-continues — is unit-testable without
 * a live Actual instance or core-api. The thin `actual-daily.mjs` wraps this
 * with real `@actual-app/api`, fetch, fs, and env.
 *
 * @param {{
 *   api: object,                    // @actual-app/api surface (see actual-daily.mjs)
 *   rulesText: string|null,         // contents of config/payee-rules.yaml
 *   readState: () => Record<string,number>|null,
 *   writeState: (map: Record<string,number>) => void,
 *   postCapture: (capture: object) => Promise<{ok: boolean, status: number}>,
 *   sendPushover: (title: string, message: string) => Promise<void>,
 *   config: { date: string, startDate: string, endDate: string, thresholdMinor: number, pct: number, categoryGroupName?: string },
 *   logger?: { info: Function, warn: Function, error: Function },
 * }} deps
 */
export async function runDaily(deps) {
  const { api, rulesText, readState, writeState, postCapture, sendPushover, config } = deps
  const log = deps.logger ?? { info() {}, warn() {}, error() {} }

  // §4.3 — a missing or malformed rules file ABORTS. Never degrade to a
  // silent "categorize everything" on a run that still reports success (#275).
  if (rulesText === null || rulesText === undefined || String(rulesText).trim() === '') {
    throw new Error('payee rules file is empty or missing — aborting (spec §4.3)')
  }
  const rules = loadRules(rulesText)

  // 1. Refresh from the bank. Failure is reported, not fatal (§9).
  let syncFailed = false
  try {
    await api.runBankSync()
  } catch (err) {
    syncFailed = true
    log.warn(`runBankSync failed (${err.message}) — continuing with existing data`)
  }

  // 2. Accounts + balances.
  const rawAccounts = await api.getAccounts()
  const accounts = []
  for (const a of rawAccounts) {
    if (a.closed) continue
    accounts.push({ id: a.id, name: a.name, balance: await api.getAccountBalance(a.id) })
  }

  // 3. Balance-move alerts (first run has no baseline → none).
  const prevState = readState()
  const balAlerts = balanceAlerts(prevState, accounts, { pct: config.pct })

  // 4. Payee id→name map, so classification sees the display name.
  const payeesById = new Map()
  for (const p of await api.getPayees()) payeesById.set(p.id, p.name)

  // 5. Category name→id map (created lazily on first use of a new name).
  const categoriesByName = new Map()
  for (const c of await api.getCategories()) categoriesByName.set(c.category ?? c.name, c.id)
  let cachedGroups = null
  const resolveCategoryId = async (name) => {
    if (categoriesByName.has(name)) return categoriesByName.get(name)
    if (!cachedGroups) cachedGroups = await api.getCategoryGroups()
    const group =
      cachedGroups.find((g) => g.name === config.categoryGroupName) ??
      cachedGroups.find((g) => !g.is_income) ??
      cachedGroups[0]
    if (!group) throw new Error(`cannot create category "${name}": no category group exists`)
    const id = await api.createCategory({ name, group_id: group.id })
    categoriesByName.set(name, id)
    return id
  }

  // 6. Classify + categorize uncategorized transactions. Per-item fault
  //    isolation: collect write errors, keep going, re-throw at the end (§9).
  const allTx = []
  const rollup = new Map() // category → { count, totalMinor }
  const unmatchedPayees = []
  const excluded = { transfer: 0, investment: 0 }
  const writeErrors = []

  for (const acct of accounts) {
    const txns = await api.getTransactions(acct.id, config.startDate, config.endDate)
    for (const tx of txns) {
      const payeeName = tx.payee_name ?? payeesById.get(tx.payee) ?? tx.imported_payee ?? ''
      allTx.push({ amount: tx.amount, payee: payeeName })

      if (tx.category != null) continue // already categorized — never touch

      const { category, reason } = classify(payeeName, rules)
      if (reason === 'transfer') { excluded.transfer++; continue }
      if (reason === 'investment') { excluded.investment++; continue }
      if (reason === 'unmatched') {
        if (payeeName && !unmatchedPayees.includes(payeeName)) unmatchedPayees.push(payeeName)
        continue
      }
      // reason === 'rule'
      try {
        const categoryId = await resolveCategoryId(category)
        await api.updateTransaction(tx.id, { category: categoryId })
        const r = rollup.get(category) ?? { count: 0, totalMinor: 0 }
        r.count++
        r.totalMinor += tx.amount
        rollup.set(category, r)
      } catch (err) {
        writeErrors.push({ txId: tx.id, message: err.message })
        log.error(`failed to categorize tx ${tx.id}: ${err.message}`)
      }
    }
  }

  // 7. Build the single aggregated capture (the notable set drives Pushover too).
  const notable = notableTransactions(allTx, { thresholdMinor: config.thresholdMinor })
  const categoryRollup = [...rollup.entries()].map(([category, r]) => ({ category, ...r }))
  const capture = buildCapture({
    date: config.date,
    accounts,
    notableTransactions: notable,
    balanceAlerts: balAlerts,
    categoryRollup,
    unmatchedPayees,
    excluded,
    syncFailed,
  })

  // 8. Ingest. A 409 is terminal success (date-stamped duplicate); any other
  //    non-2xx aborts the run (non-zero exit → cron log retains it).
  const res = await postCapture(capture)
  if (!res.ok && res.status !== 409) {
    throw new Error(`capture POST failed: HTTP ${res.status}`)
  }
  if (res.status === 409) log.info('capture already exists for today (409) — treating as success')

  // 9. Pushover — never fatal (§9).
  try {
    await sendPushover(pushoverTitle(capture), pushoverMessage(capture))
  } catch (err) {
    log.warn(`Pushover notification failed (${err.message}) — non-fatal`)
  }

  // 10. Persist balances for the next run's move detection.
  writeState(toBalanceMap(accounts))

  // 11. Now surface any categorization write failures.
  if (writeErrors.length > 0) {
    throw new Error(`categorization failed for ${writeErrors.length} transaction(s): ${writeErrors.map((e) => e.txId).join(', ')}`)
  }

  return { capture, syncFailed, categorized: categoryRollup, unmatchedPayees, excluded }
}

function pushoverTitle(capture) {
  const flags = []
  if (capture.metadata.sync_failed) flags.push('sync failed')
  if (capture.metadata.unmatched_count > 0) flags.push(`${capture.metadata.unmatched_count} unmatched`)
  return flags.length ? `Actual daily — ${flags.join(', ')}` : 'Actual daily summary'
}

function pushoverMessage(capture) {
  return capture.content
}
