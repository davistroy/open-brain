import { describe, it, expect } from 'vitest'
import { contentHash } from '../hash.js'

describe('contentHash', () => {
  it('returns a 64-char hex string', () => {
    expect(contentHash('hello')).toMatch(/^[a-f0-9]{64}$/)
  })

  it('normalizes whitespace before hashing', () => {
    expect(contentHash('  hello   world  ')).toBe(contentHash('hello world'))
    expect(contentHash('hello\n\nworld')).toBe(contentHash('hello world'))
    expect(contentHash('hello\t\tworld')).toBe(contentHash('hello world'))
  })

  it('normalizes case before hashing', () => {
    expect(contentHash('Hello World')).toBe(contentHash('hello world'))
    expect(contentHash('HELLO')).toBe(contentHash('hello'))
  })

  it('produces different hashes for different content', () => {
    expect(contentHash('foo')).not.toBe(contentHash('bar'))
  })

  it('is deterministic', () => {
    const text = 'The quick brown fox jumps over the lazy dog'
    expect(contentHash(text)).toBe(contentHash(text))
  })
})
