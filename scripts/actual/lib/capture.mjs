/**
 * Build the ONE aggregated daily capture (spec §8). Never per-transaction — the
 * CLAUDE.md aggregation rule; per-tx would flood the pipeline.
 *
 * Content = balances + notable transactions + category rollup + unmatched-payee
 * report, where "notable" is exactly the §6 alert bar — the same set that drives
 * the Pushover, so the two never disagree. The content is date-stamped so a
 * same-day re-run is a duplicate (a 409 from core-api is terminal success).
 *
 * The capture MAY contain amounts and payee names — it goes into Troy's private
 * Postgres, which is the entire point of the job. (The public-repo data rule
 * governs the repo, not the brain; tests here use synthetic data regardless.)
 */

/**
 * Format integer minor units (cents) as a dollar string, e.g. 250000 → "$2,500.00",
 * -5001 → "-$50.01".
 * @param {number} minor
 * @returns {string}
 */
export function formatMoney(minor) {
  const sign = minor < 0 ? '-' : ''
  const abs = Math.abs(minor)
  const dollars = Math.floor(abs / 100)
  const cents = abs % 100
  return `${sign}$${dollars.toLocaleString('en-US')}.${String(cents).padStart(2, '0')}`
}

function formatPct(pctChange) {
  if (!Number.isFinite(pctChange)) return 'new'
  const sign = pctChange > 0 ? '+' : ''
  return `${sign}${(pctChange * 100).toFixed(1)}%`
}

/**
 * @param {{
 *   date: string,
 *   accounts: Array<{id: string, name?: string, balance: number}>,
 *   notableTransactions: Array<{amount: number, payee?: string}>,
 *   balanceAlerts: Array<{name?: string, prev: number, curr: number, pctChange: number}>,
 *   categoryRollup: Array<{category: string, count: number, totalMinor: number}>,
 *   unmatchedPayees: string[],
 *   excluded: { transfer: number, investment: number },
 *   syncFailed: boolean,
 * }} input
 * @returns {{ content: string, source: 'api', capture_type: 'observation', brain_view: 'personal', metadata: object }}
 */
export function buildCapture(input) {
  const {
    date,
    accounts,
    notableTransactions = [],
    balanceAlerts = [],
    categoryRollup = [],
    unmatchedPayees = [],
    excluded = { transfer: 0, investment: 0 },
    syncFailed = false,
  } = input

  const totalMinor = accounts.reduce((sum, a) => sum + a.balance, 0)
  const lines = []

  lines.push(`Actual Budget — daily summary ${date}`)
  lines.push('')

  if (syncFailed) {
    lines.push('⚠️ Bank sync failed — balances and transactions may be stale.')
    lines.push('')
  }

  lines.push(`Total balance: ${formatMoney(totalMinor)} across ${accounts.length} account${accounts.length === 1 ? '' : 's'}`)
  for (const a of accounts) {
    lines.push(`  • ${a.name ?? a.id}: ${formatMoney(a.balance)}`)
  }
  lines.push('')

  if (balanceAlerts.length > 0) {
    lines.push('Balance moves >5%:')
    for (const b of balanceAlerts) {
      lines.push(`  • ${b.name ?? b.id}: ${formatMoney(b.prev)} → ${formatMoney(b.curr)} (${formatPct(b.pctChange)})`)
    }
    lines.push('')
  }

  lines.push(`Notable transactions (>$500): ${notableTransactions.length === 0 ? 'none' : ''}`.trimEnd())
  for (const t of notableTransactions) {
    lines.push(`  • ${t.payee ?? '(no payee)'}: ${formatMoney(t.amount)}`)
  }
  lines.push('')

  if (categoryRollup.length > 0) {
    lines.push('Categorized this run:')
    for (const c of categoryRollup) {
      lines.push(`  • ${c.category}: ${c.count} txn${c.count === 1 ? '' : 's'}, ${formatMoney(c.totalMinor)}`)
    }
  }
  lines.push(`Excluded (never categorized): ${excluded.transfer} transfer, ${excluded.investment} investment-internal`)
  lines.push('')

  if (unmatchedPayees.length === 0) {
    lines.push('All categorizable payees matched a rule (0 unmatched).')
  } else {
    lines.push(`⚠️ ${unmatchedPayees.length} unmatched payee${unmatchedPayees.length === 1 ? '' : 's'} (add rules):`)
    for (const p of unmatchedPayees) lines.push(`  • ${p}`)
  }

  return {
    content: lines.join('\n'),
    source: 'api',
    capture_type: 'observation',
    brain_view: 'personal',
    metadata: {
      pipeline: 'actual-ingest',
      date,
      total_balance_minor: totalMinor,
      account_count: accounts.length,
      notable_count: notableTransactions.length,
      balance_alert_count: balanceAlerts.length,
      unmatched_count: unmatchedPayees.length,
      unmatched_payees: unmatchedPayees,
      excluded,
      sync_failed: syncFailed,
    },
  }
}
