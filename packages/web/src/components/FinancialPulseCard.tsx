import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { TrendingUp, ArrowUp, ArrowDown, Minus } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { capturesApi } from '@/lib/api';
import type { Capture } from '@/lib/types';
import { isFinancialSourceMetadata } from '@/lib/types';

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 30;
const FINANCIAL_TYPE_SUFFIX = '_activity';

const currency = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

const currencyCompact = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

/**
 * Inclusive-match predicate: accepts captures whose `source_metadata` is
 * either a recognized `FinancialSourceMetadata` (per the strict discriminated
 * union) OR simply carries a `type` field shaped like `*_activity`. The
 * latter catches shapes the stricter predicate may not yet recognize.
 */
function isFinancialLike(meta: unknown): boolean {
  if (!meta || typeof meta !== 'object') return false;
  if (isFinancialSourceMetadata(meta)) return true;
  const t = (meta as { type?: unknown }).type;
  return typeof t === 'string' && t.endsWith(FINANCIAL_TYPE_SUFFIX);
}

/**
 * Pull a numeric spend value from a financial capture's metadata.
 * Prefers `total_debit` (the Python pipeline's canonical key), falls back to
 * `total_amount` if present.
 */
function extractSpend(meta: Record<string, unknown>): number {
  const debit = meta.total_debit;
  if (typeof debit === 'number' && Number.isFinite(debit)) return debit;
  const amount = meta.total_amount;
  if (typeof amount === 'number' && Number.isFinite(amount)) return amount;
  return 0;
}

/** ISO day key (YYYY-MM-DD) in local time. */
function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

interface MerchantAgg {
  name: string;
  amount: number;
}

/**
 * Aggregate top merchants across a set of financial captures. Accepts either
 * a `top_merchants` object (`{ name: { amount, count } }`) or a
 * `top_transactions` array (`[{ description, amount }]`). Returns the top 3
 * merchants by summed absolute spend.
 */
function aggregateMerchants(captures: Capture[]): MerchantAgg[] {
  const totals = new Map<string, number>();

  for (const c of captures) {
    const meta = c.source_metadata;
    if (!meta || typeof meta !== 'object') continue;

    const topMerchants = (meta as Record<string, unknown>).top_merchants;
    if (topMerchants && typeof topMerchants === 'object' && !Array.isArray(topMerchants)) {
      for (const [name, v] of Object.entries(topMerchants as Record<string, unknown>)) {
        if (!v || typeof v !== 'object') continue;
        const amt = (v as { amount?: unknown }).amount;
        if (typeof amt === 'number' && Number.isFinite(amt)) {
          totals.set(name, (totals.get(name) ?? 0) + Math.abs(amt));
        }
      }
      continue;
    }

    const topTxns = (meta as Record<string, unknown>).top_transactions;
    if (Array.isArray(topTxns)) {
      for (const t of topTxns) {
        if (!t || typeof t !== 'object') continue;
        const name =
          (t as { merchant?: unknown }).merchant ??
          (t as { description?: unknown }).description;
        const amt = (t as { amount?: unknown }).amount;
        if (typeof name === 'string' && typeof amt === 'number' && Number.isFinite(amt)) {
          totals.set(name, (totals.get(name) ?? 0) + Math.abs(amt));
        }
      }
    }
  }

  return Array.from(totals.entries())
    .map(([name, amount]) => ({ name, amount }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 3);
}

/** Build a fixed-length array of daily totals covering the last N days. */
function dailyTotals(captures: Capture[], days: number, now: Date): number[] {
  const buckets = new Map<string, number>();
  for (const c of captures) {
    const created = new Date(c.created_at);
    const key = dayKey(created);
    const meta = c.source_metadata as Record<string, unknown> | undefined;
    const spend = meta ? extractSpend(meta) : 0;
    buckets.set(key, (buckets.get(key) ?? 0) + Math.abs(spend));
  }

  const out: number[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * MS_PER_DAY);
    out.push(buckets.get(dayKey(d)) ?? 0);
  }
  return out;
}

/**
 * Build SVG polyline points for a sparkline. Normalizes values to the given
 * viewBox height (with a 2px vertical inset so the stroke isn't clipped).
 */
function sparklinePoints(values: number[], width: number, height: number): string {
  if (values.length === 0) return '';
  const max = Math.max(...values, 1); // avoid /0
  const inset = 2;
  const usable = height - inset * 2;
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  return values
    .map((v, i) => {
      const x = i * step;
      const y = height - inset - (v / max) * usable;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

// ----------------------------------------------------------------------------
// Component
// ----------------------------------------------------------------------------

export function FinancialPulseCard(): JSX.Element {
  const navigate = useNavigate();
  const [captures, setCaptures] = useState<Capture[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // 400 captures covers two 30-day windows (current + prior) across all
    // providers at one daily capture per provider.
    capturesApi
      .list({
        brain_view: 'personal',
        capture_type: 'observation',
        limit: 100,
      })
      .then((res) => {
        if (cancelled) return;
        setCaptures(res.data);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setCaptures([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const { current, prior, delta, topMerchants, sparkPoints, hasAny } = useMemo(() => {
    const now = new Date();
    const currentCutoff = now.getTime() - WINDOW_DAYS * MS_PER_DAY;
    const priorCutoff = now.getTime() - 2 * WINDOW_DAYS * MS_PER_DAY;

    const all = captures ?? [];
    const financial = all.filter((c) => isFinancialLike(c.source_metadata));

    const currentCaps: Capture[] = [];
    const priorCaps: Capture[] = [];
    for (const c of financial) {
      const t = new Date(c.created_at).getTime();
      if (t >= currentCutoff) currentCaps.push(c);
      else if (t >= priorCutoff) priorCaps.push(c);
    }

    const sumSpend = (caps: Capture[]) =>
      caps.reduce((acc, c) => {
        const meta = c.source_metadata as Record<string, unknown> | undefined;
        return acc + (meta ? Math.abs(extractSpend(meta)) : 0);
      }, 0);

    const currentTotal = sumSpend(currentCaps);
    const priorTotal = sumSpend(priorCaps);

    // MoM percent change. If prior is zero and current is positive, treat as
    // "new activity" (null delta → show neutral dash).
    let deltaPct: number | null = null;
    if (priorTotal > 0) {
      deltaPct = ((currentTotal - priorTotal) / priorTotal) * 100;
    }

    const merchants = aggregateMerchants(currentCaps);
    const daily = dailyTotals(currentCaps, WINDOW_DAYS, now);
    const points = sparklinePoints(daily, 120, 30);

    return {
      current: currentTotal,
      prior: priorTotal,
      delta: deltaPct,
      topMerchants: merchants,
      sparkPoints: points,
      hasAny: financial.length > 0,
    };
  }, [captures]);

  // ---------- render: loading ----------
  if (captures === null) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <TrendingUp className="h-4 w-4" />
            Financial pulse
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="h-8 w-32 bg-muted animate-pulse rounded" />
          <div className="h-[30px] w-full bg-muted animate-pulse rounded" />
          <div className="h-4 w-48 bg-muted animate-pulse rounded" />
        </CardContent>
      </Card>
    );
  }

  // ---------- render: empty ----------
  if (!hasAny || current === 0) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <TrendingUp className="h-4 w-4" />
            Financial pulse
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            No financial activity in the last 30 days.
          </p>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              navigate('/ingest');
            }}
            className="mt-2 text-xs text-primary underline-offset-2 hover:underline focus:outline-none focus:ring-2 focus:ring-ring rounded"
          >
            Ingest a CSV
          </button>
          {error ? (
            <p className="mt-2 text-xs text-destructive" role="alert">
              {error}
            </p>
          ) : null}
        </CardContent>
      </Card>
    );
  }

  // ---------- render: populated ----------
  const DeltaIcon =
    delta === null ? Minus : delta > 0 ? ArrowUp : delta < 0 ? ArrowDown : Minus;
  const deltaColor =
    delta === null
      ? 'text-muted-foreground'
      : delta > 0
        ? 'text-red-500 dark:text-red-400' // more spend = bad
        : delta < 0
          ? 'text-green-600 dark:text-green-400'
          : 'text-muted-foreground';
  const deltaLabel =
    delta === null
      ? prior === 0
        ? 'new activity vs prior 30d'
        : 'vs prior 30d'
      : `${Math.abs(delta).toFixed(1)}% vs prior 30d`;

  return (
    <Card
      role="button"
      tabIndex={0}
      onClick={() => navigate('/financial')}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          navigate('/financial');
        }
      }}
      className={cn(
        'cursor-pointer transition hover:bg-accent/50',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
      )}
      aria-label="Financial pulse — last 30 days"
    >
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <TrendingUp className="h-4 w-4" />
          Financial pulse
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-baseline gap-3">
          <span className="text-2xl font-semibold tabular-nums">
            {currency.format(current)}
          </span>
          <span className={cn('flex items-center gap-1 text-xs', deltaColor)}>
            <DeltaIcon className="h-3 w-3" />
            {deltaLabel}
          </span>
        </div>

        <div className="text-primary">
          <svg
            viewBox="0 0 120 30"
            className="h-[30px] w-full"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <polyline
              points={sparkPoints}
              stroke="currentColor"
              fill="none"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>

        {topMerchants.length > 0 ? (
          <p className="text-xs text-muted-foreground truncate">
            <span className="font-medium text-foreground">Top merchants:</span>{' '}
            {topMerchants
              .map((m) => `${m.name} ${currencyCompact.format(m.amount)}`)
              .join(', ')}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
