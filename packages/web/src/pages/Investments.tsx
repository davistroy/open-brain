/**
 * Investments — Schwab-focused portfolio view.
 *
 * Deeper than the Schwab tab on /financial: shows allocation donut, net worth
 * trend, and a sortable holdings table. Data comes from `investmentsApi`
 * which composes over `capturesApi` and filters to Schwab snapshots.
 */

import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { ChevronDown, ChevronUp, ArrowUpDown } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { AllocationDonut } from '@/components/AllocationDonut'
import { NetWorthChart } from '@/components/NetWorthChart'
import { investmentsApi } from '@/lib/api'
import type { SchwabSnapshotRecord, SchwabPositionsRecord, SchwabHolding } from '@/lib/api'
import { cn } from '@/lib/utils'

const DEFAULT_ACCOUNTS = ['Contributory', 'Simple IRA', 'Designated Bene Joint']

const USD = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
})

const USD_CENTS = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2,
})

const PCT = new Intl.NumberFormat('en-US', {
  style: 'percent',
  maximumFractionDigits: 2,
})

type SortCol =
  | 'symbol'
  | 'qty'
  | 'market_value'
  | 'cost_basis'
  | 'gain_dollar'
  | 'gain_pct'
  | 'asset_type'

interface SortState {
  col: SortCol
  dir: 'asc' | 'desc'
}

export function Investments() {
  const [searchParams, setSearchParams] = useSearchParams()
  const accountParam = searchParams.get('account') ?? 'All'

  const [balances, setBalances] = useState<SchwabSnapshotRecord[] | null>(null)
  const [history, setHistory] = useState<SchwabSnapshotRecord[] | null>(null)
  const [positions, setPositions] = useState<SchwabPositionsRecord[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  const [sort, setSort] = useState<SortState>({ col: 'market_value', dir: 'desc' })

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setError(null)
      try {
        const [bal, hist, pos] = await Promise.all([
          investmentsApi.latestBalances(),
          investmentsApi.balanceHistory(),
          investmentsApi.latestPositions(),
        ])
        if (cancelled) return
        setBalances(bal)
        setHistory(hist)
        setPositions(pos)
      } catch (e) {
        if (cancelled) return
        setError(e instanceof Error ? e.message : 'Failed to load investment data')
        setBalances([])
        setHistory([])
        setPositions([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [reloadKey])

  // Dynamic account list: union of actual account names + default list.
  const accountNames = useMemo(() => {
    const fromBalances = (balances ?? []).map((b) => b.account_name)
    const fromPositions = (positions ?? []).map((p) => p.account_name)
    const seen = new Set<string>()
    const all: string[] = []
    for (const name of [...DEFAULT_ACCOUNTS, ...fromBalances, ...fromPositions]) {
      if (!seen.has(name)) {
        seen.add(name)
        all.push(name)
      }
    }
    return all
  }, [balances, positions])

  const hasAnyData = (balances?.length ?? 0) > 0 || (positions?.length ?? 0) > 0

  function setAccount(name: string) {
    const next = new URLSearchParams(searchParams)
    if (name === 'All') next.delete('account')
    else next.set('account', name)
    setSearchParams(next, { replace: true })
  }

  // Filter positions + balances by selected account.
  const filteredPositions = useMemo(() => {
    if (!positions) return []
    if (accountParam === 'All') return positions
    return positions.filter((p) => p.account_name === accountParam)
  }, [positions, accountParam])

  const filteredHistory = useMemo(() => {
    if (!history) return []
    if (accountParam === 'All') return history
    return history.filter((h) => h.account_name === accountParam)
  }, [history, accountParam])

  const filteredBalances = useMemo(() => {
    if (!balances) return []
    if (accountParam === 'All') return balances
    return balances.filter((b) => b.account_name === accountParam)
  }, [balances, accountParam])

  // Net worth headline — sum of latest balance snapshots across filter.
  const netWorth = useMemo(
    () => filteredBalances.reduce((sum, b) => sum + b.account_value, 0),
    [filteredBalances],
  )

  // Flatten all holdings (annotated with account_name) for donut + table.
  const allHoldings = useMemo(() => {
    const rows: Array<SchwabHolding & { account_name: string }> = []
    for (const p of filteredPositions) {
      for (const h of p.holdings) {
        rows.push({ ...h, account_name: p.account_name })
      }
    }
    return rows
  }, [filteredPositions])

  // Top gainers / losers (by gain_pct parsed as a float; see api.ts — per-holding
  // gain fields are 0/empty from the pipeline, so this degrades to empty lists
  // for now. Kept in place for when the pipeline emits per-position gain data).
  const gainLoss = useMemo(() => {
    const withGain = allHoldings
      .map((h) => {
        const pctNum = parseFloat(h.gain_pct.replace(/[^0-9.-]/g, '')) || 0
        return { ...h, _gainPct: pctNum }
      })
      .filter((h) => h.gain_dollar !== 0 || h._gainPct !== 0)
    const sorted = [...withGain].sort((a, b) => b._gainPct - a._gainPct)
    return {
      gainers: sorted.slice(0, 3),
      losers: sorted.slice(-3).reverse(),
    }
  }, [allHoldings])

  const sortedHoldings = useMemo(() => {
    const copy = [...allHoldings]
    const dir = sort.dir === 'asc' ? 1 : -1
    copy.sort((a, b) => {
      const av = a[sort.col]
      const bv = b[sort.col]
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir
      return String(av).localeCompare(String(bv)) * dir
    })
    return copy
  }, [allHoldings, sort])

  // Top 10 by market_value — used to flag rows regardless of current sort.
  const top10Ids = useMemo(() => {
    const ranked = [...allHoldings].sort((a, b) => b.market_value - a.market_value)
    return new Set(
      ranked.slice(0, 10).map((h, i) => `${h.symbol}-${h.account_name}-${i}`),
    )
  }, [allHoldings])

  function toggleSort(col: SortCol) {
    setSort((prev) => {
      if (prev.col === col) return { col, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
      return { col, dir: col === 'symbol' || col === 'asset_type' ? 'asc' : 'desc' }
    })
  }

  if (loading) {
    return (
      <div>
        <PageHeader />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <div className="h-64 rounded-lg bg-muted animate-pulse" />
          <div className="h-64 rounded-lg bg-muted animate-pulse" />
          <div className="lg:col-span-2 h-56 rounded-lg bg-muted animate-pulse" />
          <div className="lg:col-span-2 h-64 rounded-lg bg-muted animate-pulse" />
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div>
        <PageHeader />
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive flex items-center justify-between gap-3">
          <div>Failed to load investment data: {error}</div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setReloadKey((k) => k + 1)}
          >
            Retry
          </Button>
        </div>
      </div>
    )
  }

  if (!hasAnyData) {
    return (
      <div>
        <PageHeader />
        <div className="rounded-md border border-dashed py-10 px-6 text-center text-sm text-muted-foreground">
          Drop a Schwab Balances or Positions CSV in{' '}
          <Link to="/ingest" className="text-primary hover:underline">
            Ingest
          </Link>{' '}
          to populate this page.
        </div>
      </div>
    )
  }

  return (
    <div>
      <PageHeader />

      {/* Account picker */}
      <div className="mb-5 flex flex-wrap items-center gap-1 rounded-md border p-1 w-fit">
        {(['All', ...accountNames] as const).map((name) => {
          const active = accountParam === name || (name === 'All' && accountParam === 'All')
          return (
            <button
              key={name}
              type="button"
              onClick={() => setAccount(name)}
              className={cn(
                'px-3 py-1.5 text-sm rounded transition-colors',
                active
                  ? 'bg-primary text-primary-foreground'
                  : 'hover:bg-muted text-muted-foreground',
              )}
            >
              {name}
            </button>
          )
        })}
      </div>

      {/* Row 1 — donut + net worth / gainers / losers */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-5">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Allocation</CardTitle>
          </CardHeader>
          <CardContent>
            <AllocationDonut holdings={allHoldings} size={220} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Net worth</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                {accountParam === 'All' ? 'Across all accounts' : accountParam}
              </div>
              <div className="text-3xl font-semibold tabular-nums mt-1">
                {USD.format(netWorth)}
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                {filteredBalances.length} account snapshot
                {filteredBalances.length === 1 ? '' : 's'}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <GainLossList
                title="Top gainers"
                rows={gainLoss.gainers}
                direction="up"
              />
              <GainLossList
                title="Top losers"
                rows={gainLoss.losers}
                direction="down"
              />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Row 2 — net worth chart */}
      <Card className="mb-5">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Balance history</CardTitle>
        </CardHeader>
        <CardContent>
          <NetWorthChart snapshots={filteredHistory} height={220} />
        </CardContent>
      </Card>

      {/* Row 3 — holdings table */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            Holdings
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {allHoldings.length} position{allHoldings.length === 1 ? '' : 's'}
              {top10Ids.size > 0 && (
                <span className="ml-2">(top 10 by market value highlighted)</span>
              )}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {allHoldings.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              No holdings for this selection.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted-foreground border-b">
                  <tr>
                    <SortableHeader
                      label="Symbol"
                      col="symbol"
                      sort={sort}
                      onSort={toggleSort}
                    />
                    <SortableHeader
                      label="Qty"
                      col="qty"
                      sort={sort}
                      onSort={toggleSort}
                      align="right"
                    />
                    <SortableHeader
                      label="Market value"
                      col="market_value"
                      sort={sort}
                      onSort={toggleSort}
                      align="right"
                    />
                    <SortableHeader
                      label="Cost basis"
                      col="cost_basis"
                      sort={sort}
                      onSort={toggleSort}
                      align="right"
                    />
                    <SortableHeader
                      label="Gain $"
                      col="gain_dollar"
                      sort={sort}
                      onSort={toggleSort}
                      align="right"
                    />
                    <SortableHeader
                      label="Gain %"
                      col="gain_pct"
                      sort={sort}
                      onSort={toggleSort}
                      align="right"
                    />
                    <SortableHeader
                      label="Asset type"
                      col="asset_type"
                      sort={sort}
                      onSort={toggleSort}
                    />
                  </tr>
                </thead>
                <tbody>
                  {sortedHoldings.map((h, i) => {
                    const key = `${h.symbol}-${h.account_name}-${i}`
                    const isTop = [...top10Ids].some((id) =>
                      id.startsWith(`${h.symbol}-${h.account_name}-`),
                    )
                    return (
                      <tr
                        key={key}
                        className={cn(
                          'border-b last:border-0',
                          isTop && 'bg-primary/5',
                        )}
                      >
                        <td className="py-1.5 pr-2">
                          <div className="font-medium">{h.symbol || '—'}</div>
                          <div className="text-xs text-muted-foreground truncate max-w-[18rem]">
                            {h.description}
                          </div>
                        </td>
                        <td className="py-1.5 pr-2 text-right tabular-nums">
                          {h.qty || '—'}
                        </td>
                        <td className="py-1.5 pr-2 text-right tabular-nums">
                          {USD.format(h.market_value)}
                        </td>
                        <td className="py-1.5 pr-2 text-right tabular-nums text-muted-foreground">
                          {h.cost_basis ? USD.format(h.cost_basis) : '—'}
                        </td>
                        <td
                          className={cn(
                            'py-1.5 pr-2 text-right tabular-nums',
                            h.gain_dollar > 0 && 'text-emerald-600 dark:text-emerald-400',
                            h.gain_dollar < 0 && 'text-rose-600 dark:text-rose-400',
                          )}
                        >
                          {h.gain_dollar ? USD_CENTS.format(h.gain_dollar) : '—'}
                        </td>
                        <td
                          className={cn(
                            'py-1.5 pr-2 text-right tabular-nums',
                            h.gain_dollar > 0 && 'text-emerald-600 dark:text-emerald-400',
                            h.gain_dollar < 0 && 'text-rose-600 dark:text-rose-400',
                          )}
                        >
                          {h.gain_pct || '—'}
                        </td>
                        <td className="py-1.5 pr-2 text-xs text-muted-foreground">
                          {h.asset_type}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

export default Investments

// ─── Sub-components ───────────────────────────────────────────────────────

function PageHeader() {
  return (
    <div className="mb-5">
      <h1 className="text-2xl font-bold">Investments</h1>
      <p className="text-sm text-muted-foreground mt-1">
        Schwab balance + positions snapshots.
      </p>
    </div>
  )
}

interface SortableHeaderProps {
  label: string
  col: SortCol
  sort: SortState
  onSort: (col: SortCol) => void
  align?: 'left' | 'right'
}

function SortableHeader({
  label,
  col,
  sort,
  onSort,
  align = 'left',
}: SortableHeaderProps) {
  const active = sort.col === col
  return (
    <th className={cn('py-1.5 pr-2', align === 'right' && 'text-right')}>
      <button
        type="button"
        onClick={() => onSort(col)}
        className={cn(
          'inline-flex items-center gap-1 hover:text-foreground transition-colors',
          align === 'right' && 'flex-row-reverse',
          active && 'text-foreground',
        )}
      >
        <span>{label}</span>
        {active ? (
          sort.dir === 'asc' ? (
            <ChevronUp className="h-3 w-3" />
          ) : (
            <ChevronDown className="h-3 w-3" />
          )
        ) : (
          <ArrowUpDown className="h-3 w-3 opacity-40" />
        )}
      </button>
    </th>
  )
}

interface GainLossRow extends SchwabHolding {
  account_name: string
  _gainPct: number
}

function GainLossList({
  title,
  rows,
  direction,
}: {
  title: string
  rows: GainLossRow[]
  direction: 'up' | 'down'
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
        {title}
      </div>
      {rows.length === 0 ? (
        <div className="text-xs text-muted-foreground">—</div>
      ) : (
        <ul className="space-y-1 text-xs">
          {rows.map((r, i) => (
            <li key={`${r.symbol}-${i}`} className="flex items-center gap-2">
              <span className="font-medium flex-1 truncate">{r.symbol || '—'}</span>
              <span
                className={cn(
                  'tabular-nums',
                  direction === 'up'
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : 'text-rose-600 dark:text-rose-400',
                )}
              >
                {PCT.format(r._gainPct / 100)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
