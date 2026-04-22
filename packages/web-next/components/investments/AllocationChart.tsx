'use client';

/**
 * AllocationChart — Investments page charts, three sections:
 *   "allocation" — SVG donut by asset_type (from latest positions)
 *   "networth"   — net worth headline + account breakdown table
 *   "history"    — SVG sparkline of account_value over time (balance history)
 *
 * All three use the same raw captures prop received from the RSC page.
 * Account filter is URL-driven via useSearchParams.
 *
 * No external charting library — pure SVG so bundle stays minimal.
 */

import { useMemo } from 'react';
import { useSearchParams } from 'next/navigation';
import type { Capture } from '@/lib/types';

// ---------------------------------------------------------------------------
// Inline Schwab metadata types + type guards (same as HoldingsTable — both
// files are standalone to keep component coupling minimal).
// ---------------------------------------------------------------------------

interface SchwabPositionsMeta {
  source_provider: 'schwab';
  type: 'schwab_position_snapshot';
  account_mask: string;
  account_type?: string;
  as_of: string;
  total_value: number;
  asset_types: Record<string, { count: number; mkt_val: number }>;
  positions: Array<{
    symbol?: string;
    mkt_val?: number | null;
    asset_type?: string;
    [key: string]: unknown;
  }>;
}

interface SchwabBalanceMeta {
  source_provider: 'schwab';
  type: 'schwab_balance_snapshot';
  account_mask: string;
  account_type?: string;
  as_of: string;
  account_value: number;
  cash: number;
  market_value: number;
  day_change: number;
  day_change_pct: string;
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
// Helpers
// ---------------------------------------------------------------------------

function tsOf(iso: string): number {
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/** Build mask → account_type from positions captures. */
function buildNameIndex(captures: Capture[]): Map<string, string> {
  const idx = new Map<string, string>();
  for (const c of captures) {
    const meta = (c as unknown as { source_metadata?: unknown }).source_metadata;
    if (!isSchwabPositionsMeta(meta)) continue;
    const mask = meta.account_mask;
    const atype = meta.account_type?.trim();
    if (mask && atype && !idx.has(mask)) idx.set(mask, atype);
  }
  return idx;
}

function resolveName(mask: string, idx: Map<string, string>): string {
  return idx.get(mask) ?? (mask ? `••${mask}` : 'Unknown');
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

const USD = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

const USD_SHORT = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  notation: 'compact',
  maximumFractionDigits: 1,
});

// ---------------------------------------------------------------------------
// Design token colours for donut slices (book-cloth palette + accents)
// ---------------------------------------------------------------------------

const SLICE_COLORS = [
  '#4a3728', // book-cloth
  '#c4572a', // terracotta
  '#7a6055', // book-cloth mid
  '#d4855a', // terracotta light
  '#a09080', // warm gray
  '#3d6b52', // forest accent
  '#b5a090', // cloud warm
  '#8b5e3c', // copper
];

// ---------------------------------------------------------------------------
// AllocationDonut — SVG donut chart by asset_type
// ---------------------------------------------------------------------------

interface AllocationSlice {
  label: string;
  value: number;
  color: string;
}

function AllocationDonut({
  slices,
  size = 200,
}: {
  slices: AllocationSlice[];
  size?: number;
}) {
  const total = slices.reduce((s, x) => s + x.value, 0);
  if (total === 0) return null;

  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.36;
  const hole = size * 0.22;

  // Build SVG path arcs
  let cumAngle = -Math.PI / 2;
  const paths = slices.map((slice) => {
    const sweep = (slice.value / total) * 2 * Math.PI;
    const x1 = cx + r * Math.cos(cumAngle);
    const y1 = cy + r * Math.sin(cumAngle);
    const x2 = cx + r * Math.cos(cumAngle + sweep);
    const y2 = cy + r * Math.sin(cumAngle + sweep);
    const xi1 = cx + hole * Math.cos(cumAngle);
    const yi1 = cy + hole * Math.sin(cumAngle);
    const xi2 = cx + hole * Math.cos(cumAngle + sweep);
    const yi2 = cy + hole * Math.sin(cumAngle + sweep);
    const largeArc = sweep > Math.PI ? 1 : 0;
    const d = [
      `M ${x1} ${y1}`,
      `A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2}`,
      `L ${xi2} ${yi2}`,
      `A ${hole} ${hole} 0 ${largeArc} 0 ${xi1} ${yi1}`,
      'Z',
    ].join(' ');
    cumAngle += sweep;
    return { d, color: slice.color, label: slice.label, value: slice.value };
  });

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-label="Asset allocation donut chart"
      role="img"
    >
      {paths.map((p, i) => (
        <path key={i} d={p.d} fill={p.color} opacity={0.9}>
          <title>
            {p.label}: {USD.format(p.value)} ({((p.value / total) * 100).toFixed(1)}%)
          </title>
        </path>
      ))}
      {/* Center hole */}
      <circle cx={cx} cy={cy} r={hole} fill="var(--color-bg-container, #faf7f2)" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// SparkLine — minimal SVG line chart for balance history
// ---------------------------------------------------------------------------

interface SparkPoint {
  x: number;
  value: number;
}

function SparkLine({ points, width = 600, height = 160 }: { points: SparkPoint[]; width?: number; height?: number }) {
  if (points.length < 2) return null;

  const minV = Math.min(...points.map((p) => p.value));
  const maxV = Math.max(...points.map((p) => p.value));
  const rangeV = maxV - minV || 1;
  const minX = Math.min(...points.map((p) => p.x));
  const maxX = Math.max(...points.map((p) => p.x));
  const rangeX = maxX - minX || 1;

  const PAD = { t: 12, b: 24, l: 8, r: 8 };
  const plotW = width - PAD.l - PAD.r;
  const plotH = height - PAD.t - PAD.b;

  const toScreen = (p: SparkPoint) => ({
    sx: PAD.l + ((p.x - minX) / rangeX) * plotW,
    sy: PAD.t + plotH - ((p.value - minV) / rangeV) * plotH,
  });

  const screenPts = points.map(toScreen);
  const polyline = screenPts.map((p) => `${p.sx},${p.sy}`).join(' ');

  // Fill area
  const fill = [
    `${screenPts[0].sx},${PAD.t + plotH}`,
    ...screenPts.map((p) => `${p.sx},${p.sy}`),
    `${screenPts[screenPts.length - 1].sx},${PAD.t + plotH}`,
  ].join(' ');

  return (
    <svg
      width="100%"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-label="Balance history chart"
      role="img"
    >
      <defs>
        <linearGradient id="spark-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#4a3728" stopOpacity="0.15" />
          <stop offset="100%" stopColor="#4a3728" stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={fill} fill="url(#spark-fill)" />
      <polyline points={polyline} fill="none" stroke="#4a3728" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      {/* Min/max labels */}
      <text x={PAD.l} y={PAD.t + plotH + 14} fontSize="9" fill="#a09080" textAnchor="start">
        {USD_SHORT.format(minV)}
      </text>
      <text x={width - PAD.r} y={PAD.t + plotH + 14} fontSize="9" fill="#a09080" textAnchor="end">
        {USD_SHORT.format(maxV)}
      </text>
    </svg>
  );
}

// ---------------------------------------------------------------------------
// AllocationChart — exported component, section-switched
// ---------------------------------------------------------------------------

export interface AllocationChartProps {
  captures: Capture[];
  /** Which section to render: allocation donut, net worth summary, or history chart */
  section: 'allocation' | 'networth' | 'history';
}

export function AllocationChart({ captures, section }: AllocationChartProps) {
  const searchParams = useSearchParams();
  const accountParam = searchParams.get('account') ?? 'All';

  const nameIndex = useMemo(() => buildNameIndex(captures), [captures]);

  // Latest balance per account (keyed by mask)
  const balancesByAccount = useMemo(() => {
    const map = new Map<string, { name: string; value: number; day_change: number; day_change_pct: string; created_at: string }>();
    for (const c of captures) {
      const meta = (c as unknown as { source_metadata?: unknown }).source_metadata;
      if (!isSchwabBalanceMeta(meta)) continue;
      const name = meta.account_type?.trim() || resolveName(meta.account_mask, nameIndex);
      const existing = map.get(name);
      if (!existing || tsOf(c.created_at) > tsOf(existing.created_at)) {
        map.set(name, {
          name,
          value: meta.account_value ?? 0,
          day_change: meta.day_change ?? 0,
          day_change_pct: meta.day_change_pct ?? '',
          created_at: c.created_at,
        });
      }
    }
    return map;
  }, [captures, nameIndex]);

  // Filtered balance accounts
  const filteredBalances = useMemo(() => {
    const all = Array.from(balancesByAccount.values());
    if (accountParam === 'All') return all;
    return all.filter((b) => b.name === accountParam);
  }, [balancesByAccount, accountParam]);

  // Net worth
  const netWorth = useMemo(
    () => filteredBalances.reduce((s, b) => s + b.value, 0),
    [filteredBalances],
  );

  // Latest positions — asset_type breakdown for donut
  const assetTypeSlices = useMemo(() => {
    if (section !== 'allocation') return [];
    const totals = new Map<string, number>();

    for (const c of captures) {
      const meta = (c as unknown as { source_metadata?: unknown }).source_metadata;
      if (!isSchwabPositionsMeta(meta)) continue;
      const name = meta.account_type?.trim() || resolveName(meta.account_mask, nameIndex);
      if (accountParam !== 'All' && name !== accountParam) continue;

      // Use asset_types aggregate if present (avoids per-position loop)
      if (meta.asset_types && typeof meta.asset_types === 'object') {
        for (const [atype, { mkt_val }] of Object.entries(meta.asset_types)) {
          totals.set(atype, (totals.get(atype) ?? 0) + (mkt_val ?? 0));
        }
      } else {
        for (const p of meta.positions) {
          const atype = p.asset_type ?? 'Unknown';
          const val = typeof p.mkt_val === 'number' ? p.mkt_val : 0;
          totals.set(atype, (totals.get(atype) ?? 0) + val);
        }
      }
    }

    return Array.from(totals.entries())
      .filter(([, v]) => v > 0)
      .sort(([, a], [, b]) => b - a)
      .map(([label, value], i) => ({
        label,
        value,
        color: SLICE_COLORS[i % SLICE_COLORS.length],
      }));
  }, [captures, accountParam, nameIndex, section]);

  // Balance history for sparkline (sorted ascending)
  const historyPoints = useMemo(() => {
    if (section !== 'history') return [];
    const rows: { x: number; value: number }[] = [];
    for (const c of captures) {
      const meta = (c as unknown as { source_metadata?: unknown }).source_metadata;
      if (!isSchwabBalanceMeta(meta)) continue;
      const name = meta.account_type?.trim() || resolveName(meta.account_mask, nameIndex);
      if (accountParam !== 'All' && name !== accountParam) continue;
      rows.push({ x: tsOf(c.created_at), value: meta.account_value ?? 0 });
    }
    rows.sort((a, b) => a.x - b.x);
    return rows;
  }, [captures, accountParam, nameIndex, section]);

  // ---------------------------------------------------------------------------
  // Render by section
  // ---------------------------------------------------------------------------

  if (section === 'allocation') {
    return (
      <div className="bg-bg-container border border-cloud-light">
        <div className="px-[18px] py-[12px] border-b border-cloud-light">
          <div className="font-display text-[15px] font-normal tracking-[-0.005em] text-text-heading">
            Allocation
          </div>
          <div className="text-[12px] text-text-body-secondary font-light mt-[2px]">
            {accountParam === 'All' ? 'All accounts' : accountParam} — by asset type
          </div>
        </div>
        <div className="px-[18px] py-[16px]">
          {assetTypeSlices.length === 0 ? (
            <div className="font-mono text-[11px] text-text-body-secondary py-[12px]">
              No position data.
            </div>
          ) : (
            <div className="flex flex-col sm:flex-row items-start gap-[18px]">
              <AllocationDonut slices={assetTypeSlices} size={160} />
              {/* Legend */}
              <ul className="space-y-[6px] min-w-0 flex-1">
                {assetTypeSlices.map((s) => {
                  const total = assetTypeSlices.reduce((a, x) => a + x.value, 0);
                  const pct = total > 0 ? ((s.value / total) * 100).toFixed(1) : '0.0';
                  return (
                    <li key={s.label} className="flex items-center gap-[8px]">
                      <span
                        className="w-[10px] h-[10px] shrink-0 inline-block"
                        style={{ background: s.color }}
                        aria-hidden="true"
                      />
                      <span className="font-mono text-[10.5px] text-text-body-secondary flex-1 truncate">
                        {s.label}
                      </span>
                      <span className="font-mono text-[10.5px] text-text-heading tabular-nums">
                        {pct}%
                      </span>
                      <span className="font-mono text-[10px] text-text-body-secondary tabular-nums">
                        {USD_SHORT.format(s.value)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (section === 'networth') {
    return (
      <div className="bg-bg-container border border-cloud-light">
        <div className="px-[18px] py-[12px] border-b border-cloud-light">
          <div className="font-display text-[15px] font-normal tracking-[-0.005em] text-text-heading">
            Net worth
          </div>
          <div className="text-[12px] text-text-body-secondary font-light mt-[2px]">
            {accountParam === 'All' ? 'Across all accounts' : accountParam}
          </div>
        </div>
        <div className="px-[18px] py-[16px]">
          {filteredBalances.length === 0 ? (
            <div className="font-mono text-[11px] text-text-body-secondary py-[12px]">
              No balance snapshots.
            </div>
          ) : (
            <div>
              {/* Big headline */}
              <div className="font-display text-[32px] font-normal tracking-[-0.03em] text-text-heading tabular-nums mb-[4px]">
                {USD.format(netWorth)}
              </div>
              <div className="font-mono text-[10.5px] text-text-body-secondary mb-[16px]">
                {filteredBalances.length} account snapshot{filteredBalances.length === 1 ? '' : 's'}
              </div>

              {/* Per-account breakdown */}
              <table className="w-full">
                <tbody>
                  {filteredBalances
                    .sort((a, b) => b.value - a.value)
                    .map((b) => (
                      <tr key={b.name} className="border-t border-cloud-light first:border-0">
                        <td className="py-[6px] font-mono text-[11px] text-text-body-secondary">
                          {b.name}
                        </td>
                        <td className="py-[6px] text-right font-mono text-[12px] text-text-heading tabular-nums">
                          {USD.format(b.value)}
                        </td>
                        <td
                          className={[
                            'py-[6px] pl-[12px] text-right font-mono text-[11px] tabular-nums',
                            b.day_change >= 0 ? 'text-[#2d7a50]' : 'text-terracotta',
                          ].join(' ')}
                        >
                          {b.day_change !== 0 && (
                            <>
                              {b.day_change > 0 ? '+' : ''}
                              {USD_SHORT.format(b.day_change)}
                            </>
                          )}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    );
  }

  // section === 'history'
  return (
    <div className="bg-bg-container border border-cloud-light">
      <div className="px-[18px] py-[12px] border-b border-cloud-light">
        <div className="font-display text-[15px] font-normal tracking-[-0.005em] text-text-heading">
          Balance history
        </div>
        <div className="text-[12px] text-text-body-secondary font-light mt-[2px]">
          {accountParam === 'All' ? 'All accounts' : accountParam} — account value over time
        </div>
      </div>
      <div className="px-[18px] py-[16px]">
        {historyPoints.length < 2 ? (
          <div className="font-mono text-[11px] text-text-body-secondary py-[12px]">
            Not enough history snapshots to draw a chart. Upload more Schwab balance CSVs to populate this.
          </div>
        ) : (
          <SparkLine points={historyPoints} height={180} />
        )}
      </div>
    </div>
  );
}
