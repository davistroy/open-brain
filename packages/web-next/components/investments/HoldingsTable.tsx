'use client';

/**
 * HoldingsTable — sortable positions table for the Investments page.
 *
 * Receives raw Schwab captures from the RSC page, extracts the latest
 * positions snapshot per account, flattens into individual holdings rows,
 * then renders a sortable table.
 *
 * Columns: Symbol, Qty, Market Value, Cost Basis, Gain $, Gain %, Asset Type.
 * Top-10 holdings by market value are highlighted.
 * Gainers/losers strip shown above the table.
 *
 * Account filter is URL-driven: useSearchParams reads ?account=<name>.
 * The AccountPicker updates the URL so filtering is shareable + survives
 * page refresh.
 */

import { useMemo, useState, useCallback } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { ChevronDown, ChevronUp, ArrowUpDown, TrendingUp, TrendingDown, BarChart3 } from 'lucide-react';
import { EmptyState } from '@/components/design-system/EmptyState';
import type { Capture } from '@/lib/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SchwabHolding {
  symbol: string;
  description: string;
  qty: number;
  price: number;
  market_value: number;
  cost_basis: number;
  gain_dollar: number;
  gain_pct: string;
  asset_type: string;
}

interface PositionsRecord {
  capture_id: string;
  created_at: string;
  account_name: string;
  account_mask: string;
  as_of: string;
  total_value: number;
  holdings: SchwabHolding[];
}

type SortCol =
  | 'symbol'
  | 'qty'
  | 'market_value'
  | 'cost_basis'
  | 'gain_dollar'
  | 'gain_pct'
  | 'asset_type';

interface SortState {
  col: SortCol;
  dir: 'asc' | 'desc';
}

// ---------------------------------------------------------------------------
// Schwab metadata type guards (inline — avoids importing from /web)
// ---------------------------------------------------------------------------

interface SchwabPositionsMeta {
  source_provider: 'schwab';
  type: 'schwab_position_snapshot';
  account_id: string;
  account_mask: string;
  account_type?: string;
  as_of: string;
  total_value: number;
  cost_basis?: number | null;
  gain_dollar?: number | null;
  gain_pct?: string;
  positions: Array<{
    symbol?: string;
    description?: string;
    qty?: number | null;
    price?: number | null;
    mkt_val?: number | null;
    cost_basis?: number | null;
    gain_dollar?: number | null;
    gain_pct?: string;
    asset_type?: string;
    [key: string]: unknown;
  }>;
  asset_types: Record<string, { count: number; mkt_val: number }>;
  account_name_index?: Record<string, string>;
}

interface SchwabBalanceMeta {
  source_provider: 'schwab';
  type: 'schwab_balance_snapshot';
  account_mask: string;
  account_type?: string;
}

function isSchwabPositionsMeta(meta: unknown): meta is SchwabPositionsMeta {
  if (!meta || typeof meta !== 'object') return false;
  const m = meta as Record<string, unknown>;
  return m['source_provider'] === 'schwab' && m['type'] === 'schwab_position_snapshot';
}

function isSchwabBalanceMeta(meta: unknown): meta is SchwabBalanceMeta {
  if (!meta || typeof meta !== 'object') return false;
  const m = meta as Record<string, unknown>;
  return m['source_provider'] === 'schwab' && m['type'] === 'schwab_balance_snapshot';
}

// ---------------------------------------------------------------------------
// Data transformation helpers
// ---------------------------------------------------------------------------

function tsOf(iso: string): number {
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Build a mask → account_type lookup from position captures.
 * Positions carry account_type; balances don't — join on mask.
 */
function buildAccountNameIndex(captures: Capture[]): Map<string, string> {
  const idx = new Map<string, string>();
  for (const c of captures) {
    const meta = (c as unknown as { source_metadata?: unknown }).source_metadata;
    if (!isSchwabPositionsMeta(meta)) continue;
    const mask = meta.account_mask;
    const atype = meta.account_type?.trim();
    if (mask && atype && !idx.has(mask)) {
      idx.set(mask, atype);
    }
  }
  return idx;
}

function resolveAccountName(mask: string, nameIndex: Map<string, string>): string {
  return nameIndex.get(mask) ?? (mask ? `••${mask}` : 'Unknown');
}

function extractPositionsRecords(captures: Capture[]): PositionsRecord[] {
  const nameIndex = buildAccountNameIndex(captures);
  const byAccount = new Map<string, PositionsRecord>();

  for (const c of captures) {
    const meta = (c as unknown as { source_metadata?: unknown }).source_metadata;
    if (!isSchwabPositionsMeta(meta)) continue;

    const accountName =
      meta.account_type?.trim() || resolveAccountName(meta.account_mask, nameIndex);

    const holdings: SchwabHolding[] = (meta.positions ?? []).map((p) => ({
      symbol: p.symbol ?? '',
      description: p.description ?? '',
      qty: typeof p.qty === 'number' ? p.qty : 0,
      price: typeof p.price === 'number' ? p.price : 0,
      market_value: typeof p.mkt_val === 'number' ? p.mkt_val : 0,
      cost_basis: typeof p.cost_basis === 'number' ? p.cost_basis : 0,
      gain_dollar: typeof p.gain_dollar === 'number' ? p.gain_dollar : 0,
      gain_pct: typeof p.gain_pct === 'string' ? p.gain_pct : '',
      asset_type: p.asset_type ?? 'Unknown',
    }));

    const rec: PositionsRecord = {
      capture_id: c.id,
      created_at: c.created_at,
      account_name: accountName,
      account_mask: meta.account_mask,
      as_of: meta.as_of,
      total_value: meta.total_value ?? 0,
      holdings,
    };

    const existing = byAccount.get(accountName);
    if (!existing || tsOf(rec.created_at) > tsOf(existing.created_at)) {
      byAccount.set(accountName, rec);
    }
  }

  return Array.from(byAccount.values()).sort((a, b) =>
    a.account_name.localeCompare(b.account_name),
  );
}

/** Derive all unique account names present across positions + balances. */
function extractAccountNames(captures: Capture[]): string[] {
  const nameIndex = buildAccountNameIndex(captures);
  const seen = new Set<string>();
  const names: string[] = [];

  for (const c of captures) {
    const meta = (c as unknown as { source_metadata?: unknown }).source_metadata;
    if (!meta || typeof meta !== 'object') continue;
    const m = meta as Record<string, unknown>;
    if (m['source_provider'] !== 'schwab') continue;

    let name: string | undefined;
    if (isSchwabPositionsMeta(meta)) {
      name = meta.account_type?.trim() || resolveAccountName(meta.account_mask, nameIndex);
    } else if (isSchwabBalanceMeta(meta)) {
      name = meta.account_type?.trim() || resolveAccountName(meta.account_mask, nameIndex);
    }

    if (name && !seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }

  return names.sort((a, b) => a.localeCompare(b));
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

const USD = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

const USD_CENTS = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2,
});

// ---------------------------------------------------------------------------
// AccountPicker
// ---------------------------------------------------------------------------

function AccountPicker({
  accounts,
  active,
  onSelect,
}: {
  accounts: string[];
  active: string;
  onSelect: (name: string) => void;
}) {
  if (accounts.length === 0) return null;

  return (
    <div
      className="flex flex-wrap items-center gap-[6px] mb-[18px]"
      role="group"
      aria-label="Filter by account"
    >
      {(['All', ...accounts] as string[]).map((name) => {
        const isActive = active === name || (name === 'All' && active === 'All');
        return (
          <button
            key={name}
            type="button"
            onClick={() => onSelect(name)}
            className={[
              'px-[12px] py-[5px] text-[12px] border font-body tracking-[0.005em]',
              'transition-colors duration-[120ms] cursor-pointer',
              isActive
                ? 'bg-book-cloth border-book-cloth text-ivory-light'
                : 'bg-bg-container border-cloud-medium text-text-body-secondary hover:text-text-body hover:border-cloud-dark',
            ].join(' ')}
          >
            {name}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SortableHeader
// ---------------------------------------------------------------------------

function SortableHeader({
  label,
  col,
  sort,
  onSort,
  align = 'left',
}: {
  label: string;
  col: SortCol;
  sort: SortState;
  onSort: (col: SortCol) => void;
  align?: 'left' | 'right';
}) {
  const active = sort.col === col;
  return (
    <th
      className={[
        'py-[8px] pr-[8px] border-b border-cloud-light',
        'font-mono text-[10px] tracking-[0.05em] uppercase text-text-body-secondary font-normal',
        align === 'right' ? 'text-right' : 'text-left',
      ].join(' ')}
    >
      <button
        type="button"
        onClick={() => onSort(col)}
        className={[
          'inline-flex items-center gap-[4px]',
          align === 'right' ? 'flex-row-reverse' : '',
          'hover:text-text-body transition-colors duration-[100ms] cursor-pointer',
          active ? 'text-text-body' : '',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        <span>{label}</span>
        {active ? (
          sort.dir === 'asc' ? (
            <ChevronUp size={10} strokeWidth={1.5} />
          ) : (
            <ChevronDown size={10} strokeWidth={1.5} />
          )
        ) : (
          <ArrowUpDown size={10} strokeWidth={1.5} className="opacity-40" />
        )}
      </button>
    </th>
  );
}

// ---------------------------------------------------------------------------
// GainLossList — top gainers / losers strip
// ---------------------------------------------------------------------------

interface GainRow extends SchwabHolding {
  account_name: string;
  _gainPct: number;
}

function GainLossList({
  title,
  rows,
  direction,
}: {
  title: string;
  rows: GainRow[];
  direction: 'up' | 'down';
}) {
  return (
    <div>
      <div className="flex items-center gap-[6px] mb-[8px]">
        {direction === 'up' ? (
          <TrendingUp size={12} strokeWidth={1.5} className="text-[#2d7a50]" />
        ) : (
          <TrendingDown size={12} strokeWidth={1.5} className="text-terracotta" />
        )}
        <span className="font-mono text-[10px] tracking-[0.05em] uppercase text-text-body-secondary">
          {title}
        </span>
      </div>
      {rows.length === 0 ? (
        <div className="font-mono text-[11px] text-text-body-secondary">—</div>
      ) : (
        <ul className="space-y-[4px]">
          {rows.map((r, i) => (
            <li
              key={`${r.symbol}-${i}`}
              className="flex items-center gap-[8px] justify-between"
            >
              <span className="font-mono text-[12px] text-text-heading font-normal">
                {r.symbol || '—'}
              </span>
              <span
                className={[
                  'font-mono text-[11px] tabular-nums',
                  direction === 'up' ? 'text-[#2d7a50]' : 'text-terracotta',
                ].join(' ')}
              >
                {r._gainPct > 0 ? '+' : ''}
                {r._gainPct.toFixed(2)}%
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// HoldingsTable — main export
// ---------------------------------------------------------------------------

interface HoldingsTableProps {
  captures: Capture[];
}

export function HoldingsTable({ captures }: HoldingsTableProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const accountParam = searchParams.get('account') ?? 'All';

  const [sort, setSort] = useState<SortState>({ col: 'market_value', dir: 'desc' });

  const accountNames = useMemo(() => extractAccountNames(captures), [captures]);
  const allPositions = useMemo(() => extractPositionsRecords(captures), [captures]);

  const filteredPositions = useMemo(() => {
    if (accountParam === 'All') return allPositions;
    return allPositions.filter((p) => p.account_name === accountParam);
  }, [allPositions, accountParam]);

  const allHoldings = useMemo(() => {
    const rows: Array<SchwabHolding & { account_name: string }> = [];
    for (const p of filteredPositions) {
      for (const h of p.holdings) {
        rows.push({ ...h, account_name: p.account_name });
      }
    }
    return rows;
  }, [filteredPositions]);

  const gainLoss = useMemo(() => {
    const withGain = allHoldings
      .map((h) => {
        const pctNum = parseFloat(h.gain_pct.replace(/[^0-9.-]/g, '')) || 0;
        return { ...h, _gainPct: pctNum };
      })
      .filter((h) => h.gain_dollar !== 0 || h._gainPct !== 0);
    const sorted = [...withGain].sort((a, b) => b._gainPct - a._gainPct);
    return {
      gainers: sorted.slice(0, 3),
      losers: sorted.slice(-3).reverse(),
    };
  }, [allHoldings]);

  const top10Set = useMemo(() => {
    const ranked = [...allHoldings].sort((a, b) => b.market_value - a.market_value);
    return new Set(ranked.slice(0, 10).map((h) => `${h.symbol}__${h.account_name}`));
  }, [allHoldings]);

  const sortedHoldings = useMemo(() => {
    const copy = [...allHoldings];
    const dir = sort.dir === 'asc' ? 1 : -1;
    copy.sort((a, b) => {
      const av = a[sort.col as keyof SchwabHolding];
      const bv = b[sort.col as keyof SchwabHolding];
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
    return copy;
  }, [allHoldings, sort]);

  const toggleSort = useCallback((col: SortCol) => {
    setSort((prev) => {
      if (prev.col === col) return { col, dir: prev.dir === 'asc' ? 'desc' : 'asc' };
      const defaultDesc = col !== 'symbol' && col !== 'asset_type';
      return { col, dir: defaultDesc ? 'desc' : 'asc' };
    });
  }, []);

  const handleAccountSelect = useCallback(
    (name: string) => {
      const next = new URLSearchParams(searchParams.toString());
      if (name === 'All') next.delete('account');
      else next.set('account', name);
      router.replace(`?${next.toString()}`, { scroll: false });
    },
    [router, searchParams],
  );

  if (captures.length === 0) {
    return (
      <EmptyState
        icon={BarChart3}
        title="No investment data"
        description="Drop a Schwab Balances or Positions CSV in Ingest to populate this page."
      />
    );
  }

  return (
    <div>
      {/* Account filter */}
      <AccountPicker
        accounts={accountNames}
        active={accountParam}
        onSelect={handleAccountSelect}
      />

      {/* Gainers / losers strip */}
      {(gainLoss.gainers.length > 0 || gainLoss.losers.length > 0) && (
        <div className="grid grid-cols-2 gap-[18px] mb-[18px] bg-bg-container border border-cloud-light px-[18px] py-[14px]">
          <GainLossList title="Top gainers" rows={gainLoss.gainers} direction="up" />
          <GainLossList title="Top losers" rows={gainLoss.losers} direction="down" />
        </div>
      )}

      {/* Holdings table */}
      <div className="bg-bg-container border border-cloud-light">
        <div className="px-[18px] py-[12px] border-b border-cloud-light flex items-baseline gap-[8px]">
          <span className="font-display text-[15px] font-normal tracking-[-0.005em] text-text-heading">
            Holdings
          </span>
          <span className="font-mono text-[10.5px] text-text-body-secondary">
            {allHoldings.length} position{allHoldings.length === 1 ? '' : 's'}
            {top10Set.size > 0 && <span className="ml-[8px]">top 10 highlighted</span>}
          </span>
        </div>

        {allHoldings.length === 0 ? (
          <EmptyState
            title="No holdings for this account"
            description="Select a different account or upload a Schwab positions CSV."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <SortableHeader label="Symbol" col="symbol" sort={sort} onSort={toggleSort} />
                  <SortableHeader label="Qty" col="qty" sort={sort} onSort={toggleSort} align="right" />
                  <SortableHeader label="Market value" col="market_value" sort={sort} onSort={toggleSort} align="right" />
                  <SortableHeader label="Cost basis" col="cost_basis" sort={sort} onSort={toggleSort} align="right" />
                  <SortableHeader label="Gain $" col="gain_dollar" sort={sort} onSort={toggleSort} align="right" />
                  <SortableHeader label="Gain %" col="gain_pct" sort={sort} onSort={toggleSort} align="right" />
                  <SortableHeader label="Asset type" col="asset_type" sort={sort} onSort={toggleSort} />
                </tr>
              </thead>
              <tbody>
                {sortedHoldings.map((h, i) => {
                  const key = `${h.symbol}__${h.account_name}__${i}`;
                  const isTop = top10Set.has(`${h.symbol}__${h.account_name}`);
                  const gainColor =
                    h.gain_dollar > 0
                      ? 'text-[#2d7a50]'
                      : h.gain_dollar < 0
                        ? 'text-terracotta'
                        : 'text-text-body-secondary';

                  return (
                    <tr
                      key={key}
                      className={[
                        'border-b border-cloud-light last:border-0',
                        isTop ? 'bg-[#faf3ed]' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                    >
                      {/* Symbol + description */}
                      <td className="px-[8px] py-[8px] pl-[18px]">
                        <div className="font-mono text-[12px] text-text-heading font-normal">
                          {h.symbol || '—'}
                        </div>
                        <div className="text-[11px] text-text-body-secondary font-light truncate max-w-[260px]">
                          {h.description}
                        </div>
                      </td>
                      {/* Qty */}
                      <td className="px-[8px] py-[8px] text-right font-mono text-[12px] text-text-body tabular-nums">
                        {h.qty ? h.qty.toLocaleString('en-US') : '—'}
                      </td>
                      {/* Market value */}
                      <td className="px-[8px] py-[8px] text-right font-mono text-[12px] text-text-heading tabular-nums">
                        {USD.format(h.market_value)}
                      </td>
                      {/* Cost basis */}
                      <td className="px-[8px] py-[8px] text-right font-mono text-[12px] text-text-body-secondary tabular-nums">
                        {h.cost_basis ? USD.format(h.cost_basis) : '—'}
                      </td>
                      {/* Gain $ */}
                      <td className={`px-[8px] py-[8px] text-right font-mono text-[12px] tabular-nums ${gainColor}`}>
                        {h.gain_dollar ? USD_CENTS.format(h.gain_dollar) : '—'}
                      </td>
                      {/* Gain % */}
                      <td className={`px-[8px] py-[8px] text-right font-mono text-[12px] tabular-nums ${gainColor}`}>
                        {h.gain_pct || '—'}
                      </td>
                      {/* Asset type */}
                      <td className="px-[8px] py-[8px] pr-[18px] font-mono text-[10.5px] text-text-body-secondary uppercase tracking-[0.03em]">
                        {h.asset_type}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
