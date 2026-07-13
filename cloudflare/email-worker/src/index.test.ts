import { describe, it, expect } from 'vitest'
import {
  isTransientStatus,
  buildAllowlistUrl,
  parseAllowlistEntries,
  isSenderAllowed,
  stripSignature,
  normalizeWhitespace,
  buildCaptureContent,
} from './index'

// INT-M3 contract: 5xx from core-api is transient (Cloudflare retries delivery),
// 4xx is permanent (setReject). These cases pin the boundary.
describe('isTransientStatus', () => {
  it('treats 500 as transient', () => {
    expect(isTransientStatus(500)).toBe(true)
  })

  it('treats 499 as non-transient', () => {
    expect(isTransientStatus(499)).toBe(false)
  })

  it('treats 200 as non-transient', () => {
    expect(isTransientStatus(200)).toBe(false)
  })
})

describe('isSenderAllowed', () => {
  const allowlist = ['troy@example.com', '@trusted-domain.com']

  it('matches an exact email address', () => {
    expect(isSenderAllowed('troy@example.com', allowlist)).toBe(true)
  })

  it('matches an @domain entry against any sender on that domain', () => {
    expect(isSenderAllowed('someone@trusted-domain.com', allowlist)).toBe(true)
  })

  it('matches case-insensitively', () => {
    expect(isSenderAllowed('TROY@EXAMPLE.COM', allowlist)).toBe(true)
  })

  it('rejects a sender not on the allowlist', () => {
    expect(isSenderAllowed('stranger@evil.com', allowlist)).toBe(false)
  })
})

describe('parseAllowlistEntries', () => {
  it('returns the value array when present', () => {
    expect(parseAllowlistEntries({ value: ['a@b.com'] })).toEqual(['a@b.com'])
  })

  it('falls back to an empty array when value is absent (?? [])', () => {
    expect(parseAllowlistEntries({})).toEqual([])
  })
})

describe('buildAllowlistUrl', () => {
  it('derives the settings URL from a captures URL without a trailing slash', () => {
    expect(buildAllowlistUrl('https://brain.troy-davis.com/api/v1/captures')).toBe(
      'https://brain.troy-davis.com/api/v1/settings/email_allowlist'
    )
  })

  it('derives the settings URL from a captures URL with a trailing slash', () => {
    expect(buildAllowlistUrl('https://brain.troy-davis.com/api/v1/captures/')).toBe(
      'https://brain.troy-davis.com/api/v1/settings/email_allowlist'
    )
  })
})

describe('stripSignature', () => {
  it('strips content after a standard "-- " delimiter', () => {
    const text = 'Hello there\n-- \nSent from my iPhone'
    expect(stripSignature(text)).toBe('Hello there')
  })

  it('leaves text unchanged when no signature delimiter is present', () => {
    expect(stripSignature('Just a plain message')).toBe('Just a plain message')
  })
})

describe('normalizeWhitespace', () => {
  it('collapses 3+ newlines to a single blank line and trims', () => {
    const text = '  Para one\n\n\n\nPara two  '
    expect(normalizeWhitespace(text)).toBe('Para one\n\nPara two')
  })
})

describe('buildCaptureContent', () => {
  it('prefixes the body with a Subject header when subject is present', () => {
    expect(buildCaptureContent('Hello', 'Body text')).toBe('Subject: Hello\n\nBody text')
  })

  it('omits the Subject header when subject is empty', () => {
    expect(buildCaptureContent('', 'Body text')).toBe('Body text')
  })
})
