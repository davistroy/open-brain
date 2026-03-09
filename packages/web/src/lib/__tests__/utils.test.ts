import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { cn, formatRelativeTime, truncate } from '../utils'

describe('cn', () => {
  it('merges class names', () => {
    expect(cn('foo', 'bar')).toBe('foo bar')
  })

  it('handles conditional classes', () => {
    expect(cn('base', false && 'nope', 'end')).toBe('base end')
  })

  it('deduplicates conflicting tailwind classes', () => {
    // tailwind-merge should keep the last one
    const result = cn('text-red-500', 'text-blue-500')
    expect(result).toBe('text-blue-500')
  })

  it('returns empty string for no inputs', () => {
    expect(cn()).toBe('')
  })
})

describe('truncate', () => {
  it('returns the string unchanged if within maxLen', () => {
    expect(truncate('hello', 10)).toBe('hello')
  })

  it('returns the string unchanged when exactly equal to maxLen', () => {
    expect(truncate('hello', 5)).toBe('hello')
  })

  it('truncates and appends ellipsis when over maxLen', () => {
    expect(truncate('hello world', 8)).toBe('hello w\u2026')
  })

  it('handles empty string', () => {
    expect(truncate('', 5)).toBe('')
  })

  it('truncates very short maxLen', () => {
    const result = truncate('abcdef', 3)
    expect(result).toBe('ab\u2026')
    expect(result.length).toBe(3)
  })
})

describe('formatRelativeTime', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns "just now" for timestamps under 60 seconds ago', () => {
    const now = new Date('2026-03-06T12:00:00Z')
    vi.setSystemTime(now)
    const thirtySecondsAgo = new Date('2026-03-06T11:59:30Z')
    expect(formatRelativeTime(thirtySecondsAgo)).toBe('just now')
  })

  it('returns minutes ago for timestamps 1-59 minutes ago', () => {
    const now = new Date('2026-03-06T12:00:00Z')
    vi.setSystemTime(now)
    const fiveMinutesAgo = new Date('2026-03-06T11:55:00Z')
    expect(formatRelativeTime(fiveMinutesAgo)).toBe('5m ago')
  })

  it('returns hours ago for timestamps 1-23 hours ago', () => {
    const now = new Date('2026-03-06T12:00:00Z')
    vi.setSystemTime(now)
    const threeHoursAgo = new Date('2026-03-06T09:00:00Z')
    expect(formatRelativeTime(threeHoursAgo)).toBe('3h ago')
  })

  it('returns days ago for timestamps 1-6 days ago', () => {
    const now = new Date('2026-03-06T12:00:00Z')
    vi.setSystemTime(now)
    const twoDaysAgo = new Date('2026-03-04T12:00:00Z')
    expect(formatRelativeTime(twoDaysAgo)).toBe('2d ago')
  })

  it('returns days ago for timestamps 7+ days ago', () => {
    const now = new Date('2026-03-06T12:00:00Z')
    vi.setSystemTime(now)
    const oldDate = new Date('2026-02-01T12:00:00Z')
    const result = formatRelativeTime(oldDate)
    expect(result).toBe('33d ago')
  })

  it('accepts a string date argument', () => {
    const now = new Date('2026-03-06T12:00:00Z')
    vi.setSystemTime(now)
    expect(formatRelativeTime('2026-03-06T11:55:00Z')).toBe('5m ago')
  })
})
