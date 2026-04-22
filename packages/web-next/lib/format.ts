/**
 * Pure presentation-layer formatters for web-next.
 * No external dependencies — Intl built-ins only.
 * All functions are pure (no side effects, no external state).
 *
 * Design glyphs: ▲ U+25B2 / ▼ U+25BC / ◆ U+25C6 (from M1 mock data — do not substitute).
 */

// ---------------------------------------------------------------------------
// formatRelativeDate
// ---------------------------------------------------------------------------

/**
 * Returns a compact relative date string.
 *
 * Rules (all evaluated relative to `now`, injected for testability):
 *   < 1 min      → "just now"
 *   < 60 min     → "14m ago"
 *   < 24 h       → "3h ago"
 *   yesterday    → "Yesterday"
 *   < 7 days     → "3d ago"
 *   same year    → "Apr 18"
 *   older        → "Apr 18, 2024"
 */
export function formatRelativeDate(iso: string, _now?: Date): string {
  const now = _now ?? new Date();
  const date = new Date(iso);
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);

  if (diffMs < 0) {
    // Future date — fall through to absolute display
  } else if (diffMins < 1) {
    return 'just now';
  } else if (diffMins < 60) {
    return `${diffMins}m ago`;
  } else if (diffHours < 24) {
    return `${diffHours}h ago`;
  } else if (diffDays === 1) {
    return 'Yesterday';
  } else if (diffDays < 7) {
    return `${diffDays}d ago`;
  }

  // Absolute: "Apr 18" or "Apr 18, 2024"
  const sameYear = date.getFullYear() === now.getFullYear();
  const options: Intl.DateTimeFormatOptions = sameYear
    ? { month: 'short', day: 'numeric', timeZone: 'UTC' }
    : { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' };
  return new Intl.DateTimeFormat('en-US', options).format(date);
}

// ---------------------------------------------------------------------------
// formatDelta
// ---------------------------------------------------------------------------

export type DeltaResult = {
  /** ▲ increase / ▼ decrease / ◆ no change */
  sign: '▲' | '▼' | '◆';
  /** Directional arrow character (same as sign for compat) */
  arrow: string;
  /** Human-readable percentage string, e.g. "+12%" or "0%" */
  text: string;
};

/**
 * Computes direction and percentage change between two numbers.
 * Returns structured result so UI can colour sign and text independently.
 *
 * Edge cases:
 *   previous === 0 && current === 0 → ◆ "0%"
 *   previous === 0 && current !== 0 → ▲/▼ (treat as +∞/-∞) → "+∞%" / "-∞%"
 */
export function formatDelta(previous: number, current: number): DeltaResult {
  if (previous === current) {
    return { sign: '◆', arrow: '◆', text: '0%' };
  }

  if (previous === 0) {
    const sign = current > 0 ? '▲' : '▼';
    const text = current > 0 ? '+∞%' : '-∞%';
    return { sign, arrow: sign, text };
  }

  const pct = ((current - previous) / Math.abs(previous)) * 100;
  const rounded = Math.round(Math.abs(pct));

  if (current > previous) {
    const text = `+${rounded}%`;
    return { sign: '▲', arrow: '▲', text };
  } else {
    const text = `-${rounded}%`;
    return { sign: '▼', arrow: '▼', text };
  }
}

// ---------------------------------------------------------------------------
// formatCount
// ---------------------------------------------------------------------------

/**
 * Compact count formatter.
 *   < 1,000      → "217"
 *   ≥ 1,000      → "1.2k" (one decimal, trailing zero stripped)
 *   ≥ 1,000,000  → "1.4M"
 *
 * Negative numbers preserved: "-1.2k".
 */
export function formatCount(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';

  if (abs >= 1_000_000) {
    const val = abs / 1_000_000;
    return `${sign}${_compactDecimal(val)}M`;
  }
  if (abs >= 1_000) {
    const val = abs / 1_000;
    return `${sign}${_compactDecimal(val)}k`;
  }
  return `${n}`;
}

// ---------------------------------------------------------------------------
// formatCurrency
// ---------------------------------------------------------------------------

/**
 * Dollar amount formatter.
 *   < 10,000     → "$4.82"  (two decimal places via Intl)
 *   ≥ 10,000     → "$12.4K" (compact, one decimal, K suffix)
 *
 * Negative: "-$4.82".
 */
export function formatCurrency(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';

  if (abs >= 10_000) {
    const val = abs / 1_000;
    return `${sign}$${_compactDecimal(val)}K`;
  }

  const formatted = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.abs(n));

  // Intl already prefixes '$'; re-attach sign for negatives
  return sign ? `-${formatted}` : formatted;
}

// ---------------------------------------------------------------------------
// formatDuration
// ---------------------------------------------------------------------------

/**
 * Compact duration from milliseconds.
 *   < 1 s     → "0s"
 *   < 60 s    → "30s"
 *   < 60 min  → "4 min"
 *   ≥ 60 min  → "2 hr"
 *
 * Always non-negative (negative ms → "0s").
 */
export function formatDuration(ms: number): string {
  if (ms <= 0) return '0s';

  const totalSeconds = Math.floor(ms / 1_000);
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 60) return `${totalMinutes} min`;

  const hours = Math.floor(ms / 3_600_000);
  return `${hours} hr`;
}

// ---------------------------------------------------------------------------
// truncate
// ---------------------------------------------------------------------------

/**
 * Truncates `str` to at most `n` Unicode code points, appending "…" if truncated.
 * If the code-point count <= n, returned unchanged.
 * `n` must be ≥ 1; if n < 1 returns empty string.
 *
 * Uses Array.from() to iterate code points so surrogate pairs (emoji, etc.)
 * are counted and sliced as single characters, not split across UTF-16 units.
 */
export function truncate(str: string, n: number): string {
  if (n < 1) return '';
  const codePoints = Array.from(str);
  if (codePoints.length <= n) return str;
  return codePoints.slice(0, n).join('') + '…';
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** One decimal place, trailing ".0" stripped: 1.0 → "1", 1.2 → "1.2" */
function _compactDecimal(val: number): string {
  const fixed = val.toFixed(1);
  return fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed;
}
