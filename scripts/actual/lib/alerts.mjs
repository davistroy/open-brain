/**
 * Alert logic (spec §6). The bar is: any single transaction > $500, OR any
 * account balance moving > 5%. This same "notable" set drives BOTH the Pushover
 * and the daily capture, so the two can never disagree (spec §8).
 *
 * Amounts are integer minor units (cents), the Actual API convention — the
 * threshold is passed in the same unit ($500 → 50000).
 */

/**
 * Transactions whose absolute amount STRICTLY exceeds the threshold. Large
 * spends (negative) and large income (positive) are treated alike.
 * @param {Array<{amount: number}>} transactions
 * @param {{ thresholdMinor: number }} opts
 */
export function notableTransactions(transactions, { thresholdMinor }) {
  return transactions.filter((t) => Math.abs(t.amount) > thresholdMinor)
}

/**
 * Accounts whose balance moved more than `pct` since the last run.
 *
 * The balance-move test needs prior state; on the FIRST run there is no
 * baseline, so it returns [] and the caller records state instead of firing N
 * false alerts on day one (spec §6). An account with no prior baseline (new
 * this run) is likewise skipped. A zero→non-zero move counts as an infinite
 * change and is flagged. The comparison is strictly greater than `pct`.
 *
 * @param {Record<string, number>|null} prevMap  id→balance from the last run
 * @param {Array<{id: string, name?: string, balance: number}>} accounts  current
 * @param {{ pct: number }} opts
 * @returns {Array<{ id: string, name?: string, prev: number, curr: number, pctChange: number }>}
 */
export function balanceAlerts(prevMap, accounts, { pct }) {
  if (isFirstRun(prevMap)) return []

  const alerts = []
  for (const acct of accounts) {
    if (!Object.prototype.hasOwnProperty.call(prevMap, acct.id)) continue // no baseline
    const prev = prevMap[acct.id]
    const curr = acct.balance
    const pctChange = prev === 0 ? (curr === 0 ? 0 : Infinity) : (curr - prev) / Math.abs(prev)
    if (Math.abs(pctChange) > pct) {
      alerts.push({ id: acct.id, name: acct.name, prev, curr, pctChange })
    }
  }
  return alerts
}

/**
 * Reduce the current accounts to an id→balance map for persisting run state.
 * @param {Array<{id: string, balance: number}>} accounts
 * @returns {Record<string, number>}
 */
export function toBalanceMap(accounts) {
  const map = {}
  for (const a of accounts) map[a.id] = a.balance
  return map
}

/**
 * True when there is no usable baseline (no state file yet, or an empty map).
 * @param {Record<string, number>|null|undefined} prevMap
 */
export function isFirstRun(prevMap) {
  return !prevMap || Object.keys(prevMap).length === 0
}
