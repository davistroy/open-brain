import { useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import type { Capture, FinancialSourceMetadata, FinancialSourceProvider } from '@/lib/types'
import {
  isFinancialSourceMetadata,
  isSchwabBalanceMetadata,
  isSchwabPositionsMetadata,
} from '@/lib/types'

const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })

const PROVIDER_BADGE: Record<FinancialSourceProvider, string> = {
  amex: 'bg-blue-500/10 text-blue-700 dark:text-blue-300 border-blue-500/20',
  chase: 'bg-indigo-500/10 text-indigo-700 dark:text-indigo-300 border-indigo-500/20',
  truist: 'bg-teal-500/10 text-teal-700 dark:text-teal-300 border-teal-500/20',
  schwab: 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/20',
  hsa: 'bg-green-500/10 text-green-700 dark:text-green-300 border-green-500/20',
  paypal: 'bg-purple-500/10 text-purple-700 dark:text-purple-300 border-purple-500/20',
}

const PROVIDER_LABEL: Record<FinancialSourceProvider, string> = {
  amex: 'Amex',
  chase: 'Chase',
  truist: 'Truist',
  schwab: 'Schwab',
  hsa: 'HSA',
  paypal: 'PayPal',
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

/**
 * Bank-like metadata inspection: the discriminated union's bank variants
 * (amex/chase/truist/hsa/paypal) share `by_category`, `total_debit`,
 * `transaction_count`, and `date_range`.
 */
function isBankLike(
  meta: FinancialSourceMetadata,
): meta is Exclude<FinancialSourceMetadata, import('@/lib/types').SchwabBalanceMetadata | import('@/lib/types').SchwabPositionsMetadata> {
  return meta.source_provider !== 'schwab'
}

/**
 * Optional fields the Python pipeline may attach to bank-like metadata but
 * which aren't in the strict type. We read them defensively.
 */
interface TopTransaction {
  date?: string
  merchant?: string
  description?: string
  amount?: number
  category?: string
}

interface TopMerchant {
  name?: string
  merchant?: string
  total?: number
  count?: number
}

function readTopTransactions(raw: Record<string, unknown>): TopTransaction[] {
  const t = raw.top_transactions
  return Array.isArray(t) ? (t as TopTransaction[]).slice(0, 10) : []
}

function readTopMerchants(raw: Record<string, unknown>): TopMerchant[] {
  const m = raw.top_merchants
  return Array.isArray(m) ? (m as TopMerchant[]).slice(0, 10) : []
}

export function FinancialSummaryCard({ capture }: { capture: Capture }) {
  const [expanded, setExpanded] = useState(false)
  const meta = capture.source_metadata

  if (!isFinancialSourceMetadata(meta)) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Financial capture — {formatDate(capture.created_at)}</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          No structured summary —{' '}
          <a href={`/timeline?id=${capture.id}`} className="text-primary hover:underline">
            open capture in Timeline
          </a>
          .
        </CardContent>
      </Card>
    )
  }

  const provider = meta.source_provider
  const badgeClass = PROVIDER_BADGE[provider]
  const providerLabel = PROVIDER_LABEL[provider]

  // Header summary varies by branch
  let headerRange = ''
  let headerTotal = ''
  let headerCount = ''

  if (isSchwabBalanceMetadata(meta)) {
    headerRange = `As of ${formatDate(meta.as_of)}`
    headerTotal = USD.format(meta.account_value ?? 0)
    headerCount = meta.account_mask ? `••${meta.account_mask}` : ''
  } else if (isSchwabPositionsMetadata(meta)) {
    headerRange = `As of ${formatDate(meta.as_of)}`
    headerTotal = USD.format(meta.total_value ?? 0)
    headerCount = `${meta.positions?.length ?? 0} positions`
  } else if (isBankLike(meta)) {
    const start = meta.date_range?.start ?? null
    const end = meta.date_range?.end ?? null
    headerRange = `${formatDate(start)} → ${formatDate(end)}`
    // For bank statements "total" = total debit (outflow); credit separately.
    headerTotal = USD.format(meta.total_debit ?? 0)
    headerCount = `${meta.transaction_count ?? 0} txns`
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2 mb-1">
              <span
                className={cn(
                  'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium',
                  badgeClass,
                )}
              >
                {providerLabel}
              </span>
              <span className="text-xs text-muted-foreground">{headerRange}</span>
            </div>
            <CardTitle className="text-base flex items-baseline gap-3 flex-wrap">
              <span>{headerTotal}</span>
              {headerCount && (
                <span className="text-sm font-normal text-muted-foreground">{headerCount}</span>
              )}
            </CardTitle>
            <div className="text-xs text-muted-foreground mt-1">
              Captured {formatDate(capture.created_at)}
            </div>
          </div>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border bg-background hover:bg-muted shrink-0"
            aria-label={expanded ? 'Collapse' : 'Expand'}
          >
            {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </button>
        </div>
      </CardHeader>

      {expanded && (
        <CardContent className="pt-0 space-y-5">
          {isSchwabBalanceMetadata(meta) && <SchwabBalanceBody meta={meta} />}
          {isSchwabPositionsMetadata(meta) && <SchwabPositionsBody meta={meta} />}
          {isBankLike(meta) && <BankLikeBody meta={meta} />}
        </CardContent>
      )}
    </Card>
  )
}

// ─── Schwab balance ───────────────────────────────────────────────────────

function SchwabBalanceBody({ meta }: { meta: import('@/lib/types').SchwabBalanceMetadata }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
      <Stat label="Account value" value={USD.format(meta.account_value ?? 0)} />
      <Stat label="Cash" value={USD.format(meta.cash ?? 0)} />
      <Stat label="Market value" value={USD.format(meta.market_value ?? 0)} />
      <Stat
        label="Day change"
        value={`${USD.format(meta.day_change ?? 0)}${meta.day_change_pct ? ` (${meta.day_change_pct})` : ''}`}
      />
    </div>
  )
}

// ─── Schwab positions ─────────────────────────────────────────────────────

function SchwabPositionsBody({ meta }: { meta: import('@/lib/types').SchwabPositionsMetadata }) {
  const positions = Array.isArray(meta.positions) ? meta.positions.slice(0, 20) : []
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
        <Stat label="Total value" value={USD.format(meta.total_value ?? 0)} />
        {meta.cost_basis != null && (
          <Stat label="Cost basis" value={USD.format(meta.cost_basis)} />
        )}
        {meta.gain_dollar != null && (
          <Stat
            label="Gain"
            value={`${USD.format(meta.gain_dollar)}${meta.gain_pct ? ` (${meta.gain_pct})` : ''}`}
          />
        )}
        <Stat label="Account" value={meta.account_mask ? `••${meta.account_mask}` : '—'} />
      </div>

      {positions.length > 0 && (
        <div>
          <h4 className="text-sm font-semibold mb-2">Holdings</h4>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground border-b">
                <tr>
                  <th className="py-1.5 pr-2">Symbol</th>
                  <th className="py-1.5 pr-2">Description</th>
                  <th className="py-1.5 pr-2 text-right">Qty</th>
                  <th className="py-1.5 pr-2 text-right">Price</th>
                  <th className="py-1.5 pr-2 text-right">Market value</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((p, i) => (
                  <tr key={i} className="border-b last:border-0">
                    <td className="py-1.5 pr-2 font-medium">{p.symbol ?? '—'}</td>
                    <td className="py-1.5 pr-2 text-muted-foreground truncate max-w-[18rem]">
                      {p.description ?? ''}
                    </td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">
                      {p.qty != null ? p.qty : '—'}
                    </td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">
                      {p.price != null ? USD.format(p.price) : '—'}
                    </td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">
                      {p.mkt_val != null ? USD.format(p.mkt_val) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Bank-like (amex, chase, truist, hsa, paypal) ─────────────────────────

function BankLikeBody({
  meta,
}: {
  meta: Exclude<
    FinancialSourceMetadata,
    import('@/lib/types').SchwabBalanceMetadata | import('@/lib/types').SchwabPositionsMetadata
  >
}) {
  const byCategory = meta.by_category ?? {}
  const categoryRows = Object.entries(byCategory)
    .map(([name, agg]) => ({
      name,
      amount: Math.abs((agg?.debit ?? 0) + (agg?.credit ?? 0)),
      debit: agg?.debit ?? 0,
      credit: agg?.credit ?? 0,
      count: agg?.count ?? 0,
    }))
    .sort((a, b) => b.amount - a.amount)

  const maxAmount = categoryRows.reduce((m, r) => Math.max(m, r.amount), 0) || 1

  const rawMeta = meta as unknown as Record<string, unknown>
  const topTransactions = readTopTransactions(rawMeta)
  const topMerchants = readTopMerchants(rawMeta)

  return (
    <div className="space-y-5">
      {/* Summary stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
        <Stat label="Debits" value={USD.format(meta.total_debit ?? 0)} />
        <Stat label="Credits" value={USD.format(meta.total_credit ?? 0)} />
        <Stat label="Net" value={USD.format(meta.net ?? 0)} />
        <Stat label="Transactions" value={String(meta.transaction_count ?? 0)} />
      </div>

      {/* Category breakdown */}
      {categoryRows.length > 0 && (
        <div>
          <h4 className="text-sm font-semibold mb-2">Category breakdown</h4>
          <div className="space-y-1.5">
            {categoryRows.map((row) => {
              const pct = (row.amount / maxAmount) * 100
              return (
                <div key={row.name} className="flex items-center gap-3 text-xs">
                  <div className="w-32 shrink-0 truncate" title={row.name}>
                    {row.name}
                  </div>
                  <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full bg-primary"
                      style={{ width: `${Math.max(pct, 2)}%` }}
                    />
                  </div>
                  <div className="w-24 text-right tabular-nums">{USD.format(row.amount)}</div>
                  <div className="w-10 text-right tabular-nums text-muted-foreground">
                    {row.count}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Top transactions */}
      {topTransactions.length > 0 && (
        <div>
          <h4 className="text-sm font-semibold mb-2">Top transactions</h4>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground border-b">
                <tr>
                  <th className="py-1.5 pr-2">Date</th>
                  <th className="py-1.5 pr-2">Merchant</th>
                  <th className="py-1.5 pr-2 text-right">Amount</th>
                  <th className="py-1.5 pr-2">Category</th>
                </tr>
              </thead>
              <tbody>
                {topTransactions.map((t, i) => (
                  <tr key={i} className="border-b last:border-0">
                    <td className="py-1.5 pr-2 whitespace-nowrap">{formatDate(t.date)}</td>
                    <td className="py-1.5 pr-2 truncate max-w-[20rem]">
                      {t.merchant ?? t.description ?? '—'}
                    </td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">
                      {t.amount != null ? USD.format(t.amount) : '—'}
                    </td>
                    <td className="py-1.5 pr-2 text-xs text-muted-foreground">
                      {t.category ?? ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Top merchants */}
      {topMerchants.length > 0 && (
        <div>
          <h4 className="text-sm font-semibold mb-2">Top merchants</h4>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground border-b">
                <tr>
                  <th className="py-1.5 pr-2 w-10">#</th>
                  <th className="py-1.5 pr-2">Merchant</th>
                  <th className="py-1.5 pr-2 text-right">Total</th>
                  <th className="py-1.5 pr-2 text-right">Count</th>
                </tr>
              </thead>
              <tbody>
                {topMerchants.map((m, i) => (
                  <tr key={i} className="border-b last:border-0">
                    <td className="py-1.5 pr-2 text-muted-foreground">{i + 1}</td>
                    <td className="py-1.5 pr-2">{m.name ?? m.merchant ?? '—'}</td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">
                      {m.total != null ? USD.format(m.total) : '—'}
                    </td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">
                      {m.count != null ? m.count : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border bg-muted/30 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-sm font-semibold tabular-nums">{value}</div>
    </div>
  )
}
