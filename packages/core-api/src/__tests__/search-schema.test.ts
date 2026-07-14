import { describe, it, expect } from 'vitest'
import { searchSchema } from '../schemas/search.js'

describe('searchSchema', () => {
  it('accepts a valid minimal query with defaults', () => {
    const parsed = searchSchema.parse({ query: 'hello' })
    expect(parsed.limit).toBe(10)
    expect(parsed.offset).toBe(0)
    expect(parsed.search_mode).toBe('hybrid')
  })

  describe('offset cap (PE-M1)', () => {
    it('accepts offset at the 450 boundary', () => {
      const parsed = searchSchema.parse({ query: 'x', offset: 450 })
      expect(parsed.offset).toBe(450)
    })

    it('rejects offset above 450', () => {
      const result = searchSchema.safeParse({ query: 'x', offset: 451 })
      expect(result.success).toBe(false)
    })

    it('rejects a very large offset that would materialize the whole table', () => {
      const result = searchSchema.safeParse({ query: 'x', offset: 100_000 })
      expect(result.success).toBe(false)
    })

    it('rejects a negative offset', () => {
      expect(searchSchema.safeParse({ query: 'x', offset: -1 }).success).toBe(false)
    })
  })

  it('still caps limit at 50', () => {
    expect(searchSchema.safeParse({ query: 'x', limit: 51 }).success).toBe(false)
    expect(searchSchema.parse({ query: 'x', limit: 50 }).limit).toBe(50)
  })
})
