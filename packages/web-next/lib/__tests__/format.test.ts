/**
 * Unit tests for lib/format.ts
 *
 * Time-dependent tests (formatRelativeDate) inject `now` to stay locale-independent.
 * All date arithmetic assumes UTC — dates constructed with ISO strings and UTC timeZone option.
 */

import { describe, it, expect } from 'vitest';
import {
  formatRelativeDate,
  formatDelta,
  formatCount,
  formatCurrency,
  formatDuration,
  truncate,
} from '../format';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a Date `deltaMins` minutes before `anchor` */
function minutesBefore(anchor: Date, deltaMins: number): Date {
  return new Date(anchor.getTime() - deltaMins * 60_000);
}

function hoursBefore(anchor: Date, deltaHours: number): Date {
  return new Date(anchor.getTime() - deltaHours * 3_600_000);
}

function daysBefore(anchor: Date, deltaDays: number): Date {
  return new Date(anchor.getTime() - deltaDays * 86_400_000);
}

// Fixed anchor in UTC so tests are deterministic regardless of host TZ
// 2024-06-15T12:00:00Z — a Saturday in mid-year, clear of daylight-saving edge cases
const NOW = new Date('2024-06-15T12:00:00Z');

// ---------------------------------------------------------------------------
// formatRelativeDate
// ---------------------------------------------------------------------------

describe('formatRelativeDate', () => {
  it('returns "just now" for times < 1 min ago', () => {
    const date = minutesBefore(NOW, 0); // exact same second
    expect(formatRelativeDate(date.toISOString(), NOW)).toBe('just now');
  });

  it('returns "just now" for 45 seconds ago', () => {
    const date = new Date(NOW.getTime() - 45_000);
    expect(formatRelativeDate(date.toISOString(), NOW)).toBe('just now');
  });

  it('returns "14m ago" for 14 minutes ago', () => {
    const date = minutesBefore(NOW, 14);
    expect(formatRelativeDate(date.toISOString(), NOW)).toBe('14m ago');
  });

  it('returns "59m ago" for 59 minutes ago', () => {
    const date = minutesBefore(NOW, 59);
    expect(formatRelativeDate(date.toISOString(), NOW)).toBe('59m ago');
  });

  it('returns "1m ago" for exactly 1 minute ago', () => {
    const date = minutesBefore(NOW, 1);
    expect(formatRelativeDate(date.toISOString(), NOW)).toBe('1m ago');
  });

  it('returns "3h ago" for 3 hours ago', () => {
    const date = hoursBefore(NOW, 3);
    expect(formatRelativeDate(date.toISOString(), NOW)).toBe('3h ago');
  });

  it('returns "23h ago" for 23 hours ago', () => {
    const date = hoursBefore(NOW, 23);
    expect(formatRelativeDate(date.toISOString(), NOW)).toBe('23h ago');
  });

  it('returns "Yesterday" for exactly 1 day ago', () => {
    const date = daysBefore(NOW, 1);
    expect(formatRelativeDate(date.toISOString(), NOW)).toBe('Yesterday');
  });

  it('returns "3d ago" for 3 days ago', () => {
    const date = daysBefore(NOW, 3);
    expect(formatRelativeDate(date.toISOString(), NOW)).toBe('3d ago');
  });

  it('returns "6d ago" for 6 days ago', () => {
    const date = daysBefore(NOW, 6);
    expect(formatRelativeDate(date.toISOString(), NOW)).toBe('6d ago');
  });

  it('returns "Apr 18" for same-year date beyond 7 days', () => {
    // 2024-04-18 is same year as NOW (2024)
    const date = new Date('2024-04-18T08:00:00Z');
    expect(formatRelativeDate(date.toISOString(), NOW)).toBe('Apr 18');
  });

  it('returns "Jun 1" for same year', () => {
    const date = new Date('2024-06-01T00:00:00Z');
    expect(formatRelativeDate(date.toISOString(), NOW)).toBe('Jun 1');
  });

  it('returns "Apr 18, 2023" for prior-year date', () => {
    const date = new Date('2023-04-18T00:00:00Z');
    expect(formatRelativeDate(date.toISOString(), NOW)).toBe('Apr 18, 2023');
  });

  it('handles future date by falling through to absolute display', () => {
    const future = new Date(NOW.getTime() + 60_000); // 1 min in future
    // Should return an absolute date string, not crash
    const result = formatRelativeDate(future.toISOString(), NOW);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// formatDelta
// ---------------------------------------------------------------------------

describe('formatDelta', () => {
  it('returns ◆ and "0%" when values are equal', () => {
    const r = formatDelta(100, 100);
    expect(r.sign).toBe('◆');
    expect(r.arrow).toBe('◆');
    expect(r.text).toBe('0%');
  });

  it('returns ◆ for both zero', () => {
    const r = formatDelta(0, 0);
    expect(r.sign).toBe('◆');
    expect(r.text).toBe('0%');
  });

  it('returns ▲ "+100%" for doubling', () => {
    const r = formatDelta(50, 100);
    expect(r.sign).toBe('▲');
    expect(r.text).toBe('+100%');
  });

  it('returns ▼ "-50%" for halving', () => {
    const r = formatDelta(100, 50);
    expect(r.sign).toBe('▼');
    expect(r.text).toBe('-50%');
  });

  it('returns ▲ "+25%" for 25% increase', () => {
    const r = formatDelta(80, 100);
    expect(r.sign).toBe('▲');
    expect(r.text).toBe('+25%');
  });

  it('rounds percentage to nearest integer', () => {
    // 1/3 ≈ 33.33% → +33%
    const r = formatDelta(300, 400);
    expect(r.text).toBe('+33%');
  });

  it('returns ▲ "+∞%" when previous is 0 and current is positive', () => {
    const r = formatDelta(0, 50);
    expect(r.sign).toBe('▲');
    expect(r.text).toBe('+∞%');
  });

  it('returns ▼ "-∞%" when previous is 0 and current is negative', () => {
    const r = formatDelta(0, -50);
    expect(r.sign).toBe('▼');
    expect(r.text).toBe('-∞%');
  });

  it('handles negative previous correctly', () => {
    // previous -100, current -50 → improvement (less negative) → ▲ +50%
    const r = formatDelta(-100, -50);
    expect(r.sign).toBe('▲');
    expect(r.text).toBe('+50%');
  });

  it('arrow equals sign for all variants', () => {
    for (const [prev, curr] of [[0, 0], [10, 20], [20, 10]] as [number, number][]) {
      const r = formatDelta(prev, curr);
      expect(r.arrow).toBe(r.sign);
    }
  });
});

// ---------------------------------------------------------------------------
// formatCount
// ---------------------------------------------------------------------------

describe('formatCount', () => {
  it('returns plain number for small values', () => {
    expect(formatCount(217)).toBe('217');
    expect(formatCount(0)).toBe('0');
    expect(formatCount(999)).toBe('999');
  });

  it('formats 1,000 as "1k"', () => {
    expect(formatCount(1_000)).toBe('1k');
  });

  it('formats 1,200 as "1.2k"', () => {
    expect(formatCount(1_200)).toBe('1.2k');
  });

  it('formats 999,900 as "999.9k"', () => {
    expect(formatCount(999_900)).toBe('999.9k');
  });

  it('formats 1,000,000 as "1M"', () => {
    expect(formatCount(1_000_000)).toBe('1M');
  });

  it('formats 1,400,000 as "1.4M"', () => {
    expect(formatCount(1_400_000)).toBe('1.4M');
  });

  it('preserves sign for negative values', () => {
    expect(formatCount(-1_200)).toBe('-1.2k');
    expect(formatCount(-500)).toBe('-500');
  });

  it('strips trailing .0 decimal', () => {
    expect(formatCount(2_000)).toBe('2k');
    expect(formatCount(3_000_000)).toBe('3M');
  });
});

// ---------------------------------------------------------------------------
// formatCurrency
// ---------------------------------------------------------------------------

describe('formatCurrency', () => {
  it('formats small amounts with two decimal places', () => {
    expect(formatCurrency(4.82)).toBe('$4.82');
    expect(formatCurrency(0)).toBe('$0.00');
    expect(formatCurrency(1)).toBe('$1.00');
  });

  it('formats amounts just below 10K with two decimals', () => {
    expect(formatCurrency(9_999.99)).toBe('$9,999.99');
  });

  it('formats 10K and above in compact K form', () => {
    expect(formatCurrency(10_000)).toBe('$10K');
    expect(formatCurrency(12_400)).toBe('$12.4K');
    expect(formatCurrency(100_000)).toBe('$100K');
  });

  it('strips trailing .0 in compact form', () => {
    expect(formatCurrency(20_000)).toBe('$20K');
  });

  it('handles negative amounts below 10K', () => {
    expect(formatCurrency(-4.82)).toBe('-$4.82');
  });

  it('handles negative amounts in compact form', () => {
    expect(formatCurrency(-12_400)).toBe('-$12.4K');
  });

  it('formats very large amounts compactly', () => {
    expect(formatCurrency(1_000_000)).toBe('$1000K');
  });
});

// ---------------------------------------------------------------------------
// formatDuration
// ---------------------------------------------------------------------------

describe('formatDuration', () => {
  it('returns "0s" for zero ms', () => {
    expect(formatDuration(0)).toBe('0s');
  });

  it('returns "0s" for negative ms', () => {
    expect(formatDuration(-1000)).toBe('0s');
  });

  it('returns seconds for < 60s', () => {
    expect(formatDuration(30_000)).toBe('30s');
    expect(formatDuration(1_000)).toBe('1s');
    expect(formatDuration(59_000)).toBe('59s');
  });

  it('returns minutes for 1–59 min', () => {
    expect(formatDuration(60_000)).toBe('1 min');
    expect(formatDuration(4 * 60_000)).toBe('4 min');
    expect(formatDuration(59 * 60_000)).toBe('59 min');
  });

  it('returns hours for ≥ 60 min', () => {
    expect(formatDuration(60 * 60_000)).toBe('1 hr');
    expect(formatDuration(2 * 60 * 60_000)).toBe('2 hr');
    expect(formatDuration(72 * 60 * 60_000)).toBe('72 hr');
  });

  it('floors sub-unit remainders', () => {
    // 1 min 45 s → still "1 min"
    expect(formatDuration(60_000 + 45_000)).toBe('1 min');
    // 1 hr 30 min → still "1 hr"
    expect(formatDuration(3_600_000 + 1_800_000)).toBe('1 hr');
  });

  it('handles very small ms (< 1s) as 0s', () => {
    expect(formatDuration(500)).toBe('0s');
    expect(formatDuration(999)).toBe('0s');
  });
});

// ---------------------------------------------------------------------------
// truncate
// ---------------------------------------------------------------------------

describe('truncate', () => {
  it('returns string unchanged when length ≤ n', () => {
    expect(truncate('hello', 10)).toBe('hello');
    expect(truncate('hello', 5)).toBe('hello');
  });

  it('appends ellipsis when string exceeds n', () => {
    expect(truncate('hello world', 5)).toBe('hello…');
  });

  it('handles n = 1', () => {
    expect(truncate('abc', 1)).toBe('a…');
  });

  it('returns empty string when n < 1', () => {
    expect(truncate('anything', 0)).toBe('');
    expect(truncate('anything', -5)).toBe('');
  });

  it('handles empty string input', () => {
    expect(truncate('', 10)).toBe('');
    expect(truncate('', 0)).toBe('');
  });

  it('handles exact boundary (length === n)', () => {
    expect(truncate('abc', 3)).toBe('abc');
  });

  it('handles unicode characters gracefully', () => {
    const str = 'Hello 🌊 World';
    const result = truncate(str, 7);
    expect(result).toBe('Hello 🌊…');
  });

  it('handles very large n efficiently', () => {
    const str = 'short';
    expect(truncate(str, 1_000_000)).toBe('short');
  });
});
