/**
 * Unit coverage for the fakeEmbed pseudo-embedding fixture (QA-5 / plan 6.4).
 *
 * Pure-function tests — no DB, no network. Lives under integration/fixtures/
 * alongside the fixture it tests, so it runs as part of
 * `test:integration` (vitest.config.integration.ts includes
 * `src/__tests__/integration/**\/*.test.ts`), but it does not depend on
 * initTestDatabase()/getTestApp() and needs no docker-compose services.
 */

import { describe, it, expect } from 'vitest'
import { fakeEmbed } from './fake-embed.js'

describe('fakeEmbed', () => {
  it('returns a 768-dimension vector', () => {
    const vec = fakeEmbed('hello world')
    expect(vec).toHaveLength(768)
    expect(vec.every((v) => typeof v === 'number' && Number.isFinite(v))).toBe(true)
  })

  it('is L2-normalized (unit length)', () => {
    const vec = fakeEmbed('a unit vector please')
    const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0))
    expect(norm).toBeCloseTo(1, 10)
  })

  it('is deterministic — same text produces a byte-identical vector', () => {
    const a = fakeEmbed('deterministic input')
    const b = fakeEmbed('deterministic input')
    expect(a).toEqual(b)
  })

  it('produces distinct vectors for distinct text (non-degenerate)', () => {
    const a = fakeEmbed('the quick brown fox')
    const b = fakeEmbed('jumps over the lazy dog')
    expect(a).not.toEqual(b)

    // Cosine similarity should be far from 1 (not the same direction) for
    // two unrelated strings — high-dimensional random unit vectors land
    // near-orthogonal, so similarity should be small in magnitude.
    const dot = a.reduce((sum, v, i) => sum + v * b[i], 0)
    expect(Math.abs(dot)).toBeLessThan(0.3)
  })

  it('never degenerates to the zero vector (unlike the old stub)', () => {
    const vec = fakeEmbed('')
    const normSq = vec.reduce((sum, v) => sum + v * v, 0)
    expect(normSq).toBeGreaterThan(0)
  })
})
