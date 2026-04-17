/**
 * NetWorthChart — hand-rolled SVG multi-line chart for Schwab balance history.
 *
 * Groups `SchwabSnapshotRecord[]` by `account_name`, plots one polyline per
 * account plus a bold Total line. No charting deps.
 */

import { useMemo } from 'react'
import type { SchwabSnapshotRecord } from '@/lib/api'

interface Props {
  snapshots: SchwabSnapshotRecord[]
  height?: number
  width?: number
}

const ACCOUNT_COLORS = [
  { stroke: 'stroke-blue-500', text: 'text-blue-500', hex: '#3b82f6' },
  { stroke: 'stroke-emerald-500', text: 'text-emerald-500', hex: '#10b981' },
  { stroke: 'stroke-purple-500', text: 'text-purple-500', hex: '#a855f7' },
  { stroke: 'stroke-amber-500', text: 'text-amber-500', hex: '#f59e0b' },
  { stroke: 'stroke-pink-500', text: 'text-pink-500', hex: '#ec4899' },
  { stroke: 'stroke-cyan-500', text: 'text-cyan-500', hex: '#06b6d4' },
]

const USD = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  notation: 'compact',
  maximumFractionDigits: 1,
})

const USD_FULL = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
})

interface Point {
  ts: number
  value: number
}

interface Series {
  account: string
  color: (typeof ACCOUNT_COLORS)[number]
  points: Point[]
  current: number
}

function tsOf(iso: string): number {
  const t = new Date(iso).getTime()
  return Number.isNaN(t) ? 0 : t
}

/** Build per-account series + a Total series summing across accounts at each
 * distinct timestamp. */
function buildSeries(snapshots: SchwabSnapshotRecord[]): {
  accounts: Series[]
  total: Series | null
  minValue: number
  maxValue: number
  minTs: number
  maxTs: number
} {
  if (snapshots.length < 2) {
    return {
      accounts: [],
      total: null,
      minValue: 0,
      maxValue: 0,
      minTs: 0,
      maxTs: 0,
    }
  }

  const byAccount = new Map<string, Point[]>()
  for (const s of snapshots) {
    const ts = tsOf(s.created_at)
    if (ts === 0) continue
    const arr = byAccount.get(s.account_name) ?? []
    arr.push({ ts, value: s.account_value })
    byAccount.set(s.account_name, arr)
  }

  const accountNames = Array.from(byAccount.keys()).sort()
  const accounts: Series[] = accountNames.map((name, i) => {
    const pts = (byAccount.get(name) ?? []).sort((a, b) => a.ts - b.ts)
    const current = pts.length ? pts[pts.length - 1].value : 0
    return {
      account: name,
      color: ACCOUNT_COLORS[i % ACCOUNT_COLORS.length],
      points: pts,
      current,
    }
  })

  // Total series — sum across accounts at each distinct timestamp. For a
  // timestamp where an account has no data, we carry forward its most recent
  // value (standard portfolio-total treatment).
  const tsSet = new Set<number>()
  for (const s of accounts) for (const p of s.points) tsSet.add(p.ts)
  const tsSorted = Array.from(tsSet).sort((a, b) => a - b)
  const cursors = accounts.map(() => 0)
  const lastValues = accounts.map(() => 0)
  const totalPoints: Point[] = []
  for (const ts of tsSorted) {
    let sum = 0
    for (let i = 0; i < accounts.length; i++) {
      const pts = accounts[i].points
      while (cursors[i] < pts.length && pts[cursors[i]].ts <= ts) {
        lastValues[i] = pts[cursors[i]].value
        cursors[i]++
      }
      sum += lastValues[i]
    }
    totalPoints.push({ ts, value: sum })
  }
  const totalCurrent = totalPoints.length
    ? totalPoints[totalPoints.length - 1].value
    : 0
  const total: Series = {
    account: 'Total',
    color: { stroke: 'stroke-foreground', text: 'text-foreground', hex: 'currentColor' },
    points: totalPoints,
    current: totalCurrent,
  }

  const allValues = [...accounts.flatMap((s) => s.points.map((p) => p.value)), ...totalPoints.map((p) => p.value)]
  const minValue = Math.min(...allValues)
  const maxValue = Math.max(...allValues)
  const minTs = tsSorted[0] ?? 0
  const maxTs = tsSorted[tsSorted.length - 1] ?? 0

  return { accounts, total, minValue, maxValue, minTs, maxTs }
}

export function NetWorthChart({ snapshots, height = 200, width = 600 }: Props) {
  const series = useMemo(() => buildSeries(snapshots), [snapshots])

  if (!series.total || series.total.points.length < 2) {
    return (
      <div
        className="flex items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground"
        style={{ minHeight: height }}
      >
        Not enough history to chart — need ≥2 snapshots.
      </div>
    )
  }

  // Margins inside the viewBox — room for y-axis labels and x-axis labels.
  const padLeft = 56
  const padRight = 12
  const padTop = 10
  const padBottom = 22
  const plotW = width - padLeft - padRight
  const plotH = height - padTop - padBottom

  const tsRange = Math.max(series.maxTs - series.minTs, 1)
  // Pad value range by 5% top/bottom so lines don't hug the edges.
  const vRange = Math.max(series.maxValue - series.minValue, 1)
  const vMin = series.minValue - vRange * 0.05
  const vMax = series.maxValue + vRange * 0.05
  const vSpan = vMax - vMin

  function x(ts: number): number {
    return padLeft + ((ts - series.minTs) / tsRange) * plotW
  }
  function y(v: number): number {
    return padTop + plotH - ((v - vMin) / vSpan) * plotH
  }

  function toPoints(points: Point[]): string {
    return points.map((p) => `${x(p.ts).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ')
  }

  // Y-axis gridlines: 4 evenly spaced across the value range.
  const gridlines = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const v = vMin + f * vSpan
    return { v, yPos: y(v) }
  })

  // X-axis labels — up to ~6 tick marks across the full span.
  const xTickCount = Math.min(series.total.points.length, 6)
  const xTicks: Array<{ ts: number; label: string }> = []
  if (xTickCount >= 2) {
    for (let i = 0; i < xTickCount; i++) {
      const ts = series.minTs + (i / (xTickCount - 1)) * tsRange
      const d = new Date(ts)
      xTicks.push({
        ts,
        label: d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' }),
      })
    }
  }

  return (
    <div className="space-y-3">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        width="100%"
        height={height}
        role="img"
        aria-label="Account balance history"
      >
        <title>Account balance history</title>
        <desc>
          Line chart of Schwab account balances over time, with a total line
          summing across accounts. Current total: {USD_FULL.format(series.total.current)}.
        </desc>

        {/* Y-axis gridlines + labels */}
        {gridlines.map((g, i) => (
          <g key={`grid-${i}`}>
            <line
              x1={padLeft}
              x2={width - padRight}
              y1={g.yPos}
              y2={g.yPos}
              className="stroke-muted-foreground/20"
              strokeWidth={1}
            />
            <text
              x={padLeft - 6}
              y={g.yPos + 3}
              textAnchor="end"
              className="fill-muted-foreground text-[10px] tabular-nums"
            >
              {USD.format(g.v)}
            </text>
          </g>
        ))}

        {/* X-axis labels */}
        {xTicks.map((t, i) => (
          <text
            key={`xt-${i}`}
            x={x(t.ts)}
            y={height - 6}
            textAnchor="middle"
            className="fill-muted-foreground text-[10px]"
          >
            {t.label}
          </text>
        ))}

        {/* Per-account lines */}
        {series.accounts.map((s) => (
          <polyline
            key={s.account}
            points={toPoints(s.points)}
            className={s.color.stroke}
            fill="none"
            strokeWidth={1.5}
            strokeLinejoin="round"
          />
        ))}

        {/* Bold Total line on top */}
        <polyline
          points={toPoints(series.total.points)}
          className="stroke-foreground"
          fill="none"
          strokeWidth={2.5}
          strokeLinejoin="round"
        />
      </svg>

      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        <li className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="inline-block h-0.5 w-4 bg-foreground"
          />
          <span className="font-medium">Total</span>
          <span className="tabular-nums text-muted-foreground">
            {USD_FULL.format(series.total.current)}
          </span>
        </li>
        {series.accounts.map((s) => (
          <li key={s.account} className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="inline-block h-0.5 w-4"
              style={{ backgroundColor: s.color.hex }}
            />
            <span>{s.account}</span>
            <span className="tabular-nums text-muted-foreground">
              {USD_FULL.format(s.current)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
