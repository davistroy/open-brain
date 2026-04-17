/**
 * AllocationDonut — hand-rolled SVG donut chart for Schwab holdings.
 *
 * Groups holdings by `asset_type`, computes percent share by market_value,
 * and renders one sector per group. Zero deps (no recharts).
 */

import { useMemo } from 'react'

interface Holding {
  symbol: string
  market_value: number
  asset_type: string
}

interface Props {
  holdings: Holding[]
  size?: number
}

/** Tailwind fill classes keyed by asset_type bucket. */
const ASSET_COLORS: Record<string, string> = {
  equity: 'fill-blue-500',
  'equity (domestic)': 'fill-blue-500',
  'equity (international)': 'fill-sky-500',
  etf: 'fill-cyan-500',
  'mutual fund': 'fill-cyan-500',
  'fixed income': 'fill-emerald-500',
  bond: 'fill-emerald-500',
  cash: 'fill-amber-500',
  'cash & cash investments': 'fill-amber-500',
  option: 'fill-purple-500',
  alternative: 'fill-pink-500',
  other: 'fill-slate-500',
  unknown: 'fill-slate-500',
}

const FALLBACK_COLORS = [
  'fill-blue-500',
  'fill-emerald-500',
  'fill-amber-500',
  'fill-purple-500',
  'fill-pink-500',
  'fill-cyan-500',
  'fill-rose-500',
  'fill-slate-500',
]

function colorFor(assetType: string, idx: number): string {
  const key = assetType.toLowerCase()
  return ASSET_COLORS[key] ?? FALLBACK_COLORS[idx % FALLBACK_COLORS.length]
}

const USD = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
})

const USD_COMPACT = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  notation: 'compact',
  maximumFractionDigits: 1,
})

interface Slice {
  assetType: string
  value: number
  pct: number
  colorClass: string
}

/** Build an SVG arc `d` path for the sector from `startAngle` to `endAngle`
 * (radians, 0 at 12 o'clock, clockwise), with inner/outer radii. */
function arcPath(
  cx: number,
  cy: number,
  rOuter: number,
  rInner: number,
  startAngle: number,
  endAngle: number,
): string {
  // Full circle — emit two half arcs so browsers render it correctly.
  if (endAngle - startAngle >= Math.PI * 2 - 1e-6) {
    const midAngle = startAngle + Math.PI
    return [
      arcPath(cx, cy, rOuter, rInner, startAngle, midAngle - 1e-4),
      arcPath(cx, cy, rOuter, rInner, midAngle, startAngle + Math.PI * 2 - 1e-4),
    ].join(' ')
  }

  const sx = cx + rOuter * Math.sin(startAngle)
  const sy = cy - rOuter * Math.cos(startAngle)
  const ex = cx + rOuter * Math.sin(endAngle)
  const ey = cy - rOuter * Math.cos(endAngle)

  const sxi = cx + rInner * Math.sin(endAngle)
  const syi = cy - rInner * Math.cos(endAngle)
  const exi = cx + rInner * Math.sin(startAngle)
  const eyi = cy - rInner * Math.cos(startAngle)

  const largeArc = endAngle - startAngle > Math.PI ? 1 : 0

  return [
    `M ${sx} ${sy}`,
    `A ${rOuter} ${rOuter} 0 ${largeArc} 1 ${ex} ${ey}`,
    `L ${sxi} ${syi}`,
    `A ${rInner} ${rInner} 0 ${largeArc} 0 ${exi} ${eyi}`,
    'Z',
  ].join(' ')
}

export function AllocationDonut({ holdings, size = 240 }: Props) {
  const { slices, total } = useMemo(() => {
    const byType = new Map<string, number>()
    for (const h of holdings) {
      if (!h || !Number.isFinite(h.market_value) || h.market_value <= 0) continue
      const key = h.asset_type || 'Unknown'
      byType.set(key, (byType.get(key) ?? 0) + h.market_value)
    }
    const sum = Array.from(byType.values()).reduce((a, b) => a + b, 0)
    const entries = Array.from(byType.entries()).sort((a, b) => b[1] - a[1])
    const sl: Slice[] = entries.map(([assetType, value], i) => ({
      assetType,
      value,
      pct: sum > 0 ? value / sum : 0,
      colorClass: colorFor(assetType, i),
    }))
    return { slices: sl, total: sum }
  }, [holdings])

  if (slices.length === 0) {
    return (
      <div
        className="flex items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground"
        style={{ minHeight: size }}
      >
        No holdings data.
      </div>
    )
  }

  const cx = size / 2
  const cy = size / 2
  const rOuter = size / 2 - 6
  const rInner = rOuter * 0.58

  let angle = 0
  const rendered = slices.map((s, i) => {
    const start = angle
    const end = angle + s.pct * Math.PI * 2
    angle = end
    const d = arcPath(cx, cy, rOuter, rInner, start, end)
    return (
      <path
        key={`${s.assetType}-${i}`}
        d={d}
        className={`${s.colorClass} stroke-background`}
        strokeWidth={1.5}
      >
        <title>
          {s.assetType}: {USD.format(s.value)} ({(s.pct * 100).toFixed(1)}%)
        </title>
      </path>
    )
  })

  return (
    <div className="flex flex-col sm:flex-row items-center gap-5">
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label="Portfolio allocation by asset type"
      >
        <title>Portfolio allocation by asset type</title>
        <desc>
          Donut chart showing percent of portfolio market value per asset type.
          Total portfolio value: {USD.format(total)}.
        </desc>
        {rendered}
        <text
          x={cx}
          y={cy - 4}
          textAnchor="middle"
          className="fill-foreground text-xs font-medium"
        >
          Total
        </text>
        <text
          x={cx}
          y={cy + 14}
          textAnchor="middle"
          className="fill-foreground text-base font-semibold tabular-nums"
        >
          {USD_COMPACT.format(total)}
        </text>
      </svg>

      <ul className="flex-1 w-full space-y-1.5 text-sm">
        {slices.map((s, i) => (
          <li
            key={`${s.assetType}-${i}`}
            className="flex items-center gap-2"
          >
            <svg width={12} height={12} aria-hidden="true">
              <rect width={12} height={12} rx={2} className={s.colorClass} />
            </svg>
            <span className="flex-1 truncate" title={s.assetType}>
              {s.assetType}
            </span>
            <span className="tabular-nums text-muted-foreground">
              {(s.pct * 100).toFixed(1)}%
            </span>
            <span className="w-20 text-right tabular-nums">
              {USD_COMPACT.format(s.value)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
