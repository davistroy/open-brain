import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { FinancialSummaryCard } from '@/components/FinancialSummaryCard'
import { capturesApi } from '@/lib/api'
import type { Capture, FinancialSourceMetadata, FinancialSourceProvider } from '@/lib/types'
import { isFinancialSourceMetadata } from '@/lib/types'

const PROVIDERS: FinancialSourceProvider[] = [
  'amex',
  'chase',
  'truist',
  'schwab',
  'hsa',
  'paypal',
]

const PROVIDER_LABEL: Record<FinancialSourceProvider, string> = {
  amex: 'Amex',
  chase: 'Chase',
  truist: 'Truist',
  schwab: 'Schwab',
  hsa: 'HSA',
  paypal: 'PayPal',
}

const USD_COMPACT = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  notation: 'compact',
  maximumFractionDigits: 1,
})

interface ProviderStat {
  total: number
  amount: number
}

function isProvider(v: string | null | undefined): v is FinancialSourceProvider {
  return typeof v === 'string' && (PROVIDERS as string[]).includes(v)
}

/**
 * Rough per-provider totaling: sums `total_debit` for bank-like providers and
 * `account_value` / `total_value` for Schwab snapshots. Meant only for the
 * tab-badge glance, not an authoritative number.
 */
function estimateAmount(caps: Capture[]): number {
  let sum = 0
  for (const c of caps) {
    const meta: unknown = c.source_metadata
    if (!isFinancialSourceMetadata(meta)) continue
    const m = meta as FinancialSourceMetadata
    if (m.source_provider === 'schwab') {
      if ('account_value' in m && typeof m.account_value === 'number') sum += m.account_value
      else if ('total_value' in m && typeof m.total_value === 'number') sum += m.total_value
    } else if (typeof m.total_debit === 'number') {
      sum += m.total_debit
    }
  }
  return sum
}

export default function Financial() {
  const [searchParams, setSearchParams] = useSearchParams()
  const tabParam = searchParams.get('tab')
  const activeTab: FinancialSourceProvider = isProvider(tabParam) ? tabParam : 'amex'

  const [stats, setStats] = useState<Record<FinancialSourceProvider, ProviderStat | null>>({
    amex: null,
    chase: null,
    truist: null,
    schwab: null,
    hsa: null,
    paypal: null,
  })
  const [captures, setCaptures] = useState<Capture[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Pre-fetch counts (and a small sample for rough amount) for all providers.
  useEffect(() => {
    let cancelled = false
    async function fetchStats() {
      try {
        const results = await Promise.all(
          PROVIDERS.map((p) =>
            capturesApi
              .list({ source_provider: p, limit: 25 })
              .then((res) => ({ provider: p, total: res.total, data: res.data }))
              .catch(() => ({ provider: p, total: 0, data: [] as Capture[] })),
          ),
        )
        if (cancelled) return
        const next: Record<FinancialSourceProvider, ProviderStat | null> = {
          amex: null,
          chase: null,
          truist: null,
          schwab: null,
          hsa: null,
          paypal: null,
        }
        for (const r of results) {
          next[r.provider] = { total: r.total, amount: estimateAmount(r.data) }
        }
        setStats(next)
      } catch {
        // silent — per-tab fetch below surfaces user-visible errors
      }
    }
    fetchStats()
    return () => {
      cancelled = true
    }
  }, [])

  // Fetch captures for the active tab.
  useEffect(() => {
    let cancelled = false
    async function fetchTab() {
      setLoading(true)
      setError(null)
      try {
        const res = await capturesApi.list({ source_provider: activeTab, limit: 50 })
        if (cancelled) return
        // API already orders DESC by created_at, but normalize just in case.
        const sorted = [...res.data].sort((a, b) =>
          a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0,
        )
        setCaptures(sorted)
      } catch (e) {
        if (cancelled) return
        setError(e instanceof Error ? e.message : 'Failed to load captures')
        setCaptures([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    fetchTab()
    return () => {
      cancelled = true
    }
  }, [activeTab])

  function handleTabChange(v: string) {
    if (!isProvider(v)) return
    const next = new URLSearchParams(searchParams)
    next.set('tab', v)
    setSearchParams(next, { replace: true })
  }

  return (
    <div>
      <div className="mb-5">
        <h1 className="text-2xl font-bold">Financial</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Browse ingested bank, credit, investment, and HSA snapshots.
        </p>
      </div>

      <Tabs value={activeTab} onValueChange={handleTabChange} className="w-full">
        <TabsList className="flex flex-wrap gap-1 h-auto p-1">
          {PROVIDERS.map((p) => {
            const s = stats[p]
            const count = s?.total ?? null
            const amount = s?.amount ?? null
            return (
              <TabsTrigger key={p} value={p} className="gap-2">
                <span>{PROVIDER_LABEL[p]}</span>
                {count !== null && (
                  <span className="text-[10px] text-muted-foreground">
                    · {count}
                    {amount !== null && amount > 0 ? ` · ${USD_COMPACT.format(amount)}` : ''}
                  </span>
                )}
              </TabsTrigger>
            )
          })}
        </TabsList>

        {PROVIDERS.map((p) => (
          <TabsContent key={p} value={p} className="mt-5 focus-visible:outline-none">
            {p === activeTab && (
              <TabPanel
                provider={p}
                captures={captures}
                loading={loading}
                error={error}
              />
            )}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  )
}

function TabPanel({
  provider,
  captures,
  loading,
  error,
}: {
  provider: FinancialSourceProvider
  captures: Capture[]
  loading: boolean
  error: string | null
}) {
  if (loading) {
    return (
      <div className="space-y-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-24 rounded-lg bg-muted animate-pulse" />
        ))}
      </div>
    )
  }

  if (error) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
        Failed to load captures: {error}
      </div>
    )
  }

  if (captures.length === 0) {
    return (
      <div className="rounded-md border border-dashed py-10 px-6 text-center text-sm text-muted-foreground">
        Upload an {PROVIDER_LABEL[provider]} CSV in{' '}
        <Link to="/ingest" className="text-primary hover:underline">
          Ingest
        </Link>{' '}
        to see data here.
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {captures.map((c) => (
        <FinancialSummaryCard key={c.id} capture={c} />
      ))}
    </div>
  )
}

export { Financial }
