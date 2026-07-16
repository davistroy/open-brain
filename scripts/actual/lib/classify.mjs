/**
 * Classify a single payee against the T0 rules (spec §4.2, §5).
 *
 * The order is load-bearing and encodes the phantom-income invariant (§5):
 * exclusions are evaluated BEFORE any category rule, so a transfer-like or
 * investment-internal payee is NEVER categorized — even if a rule would match.
 * Naive categorization would invent phantom income (card *payments* read as
 * income) and treat brokerage mechanics as spending.
 *
 * Matching is `payee.toLowerCase().includes(key)`; rule keys/exclusions are
 * already lowercased by loadRules. Unmatched payees are reported, never guessed
 * (D141) — they return `null` with reason 'unmatched', which the report surfaces
 * so the operator can add a rule.
 *
 * @param {string} payee resolved payee text (payee_name ?? imported_payee)
 * @param {{ exclude_transfer: string[], exclude_investment: string[], rules: Array<{category: string, match: string[]}> }} rules
 * @returns {{ category: string|null, reason: 'rule'|'transfer'|'investment'|'unmatched' }}
 */
export function classify(payee, rules) {
  const hay = String(payee ?? '').toLowerCase()

  if (rules.exclude_transfer.some((key) => hay.includes(key))) {
    return { category: null, reason: 'transfer' }
  }
  if (rules.exclude_investment.some((key) => hay.includes(key))) {
    return { category: null, reason: 'investment' }
  }
  for (const rule of rules.rules) {
    if (rule.match.some((key) => hay.includes(key))) {
      return { category: rule.category, reason: 'rule' }
    }
  }
  return { category: null, reason: 'unmatched' }
}

/**
 * Resolve the payee text of an Actual transaction: `payee_name` with a fallback
 * to `imported_payee` (spec §4.2). Kept here so the entrypoint and tests agree.
 * @param {{ payee_name?: string, imported_payee?: string }} tx
 * @returns {string}
 */
export function resolvePayee(tx) {
  return (tx?.payee_name ?? tx?.imported_payee ?? '').toString()
}
