import { describe, it, expect } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { pgUuidArray } from '../lib/pg-uuid-array.js'

const render = (frag: ReturnType<typeof sql>) => new PgDialect().sqlToQuery(frag)

describe('pgUuidArray', () => {
  it('renders a proper ARRAY[...]::uuid[] literal, NOT a row cast', () => {
    // The bug being fixed: `ANY(${jsArray}::uuid[])` renders `($1,$2,$3)::uuid[]`
    // (a record cast) which errors "cannot cast type record to uuid[]".
    const { sql: text, params } = render(sql`el.capture_id = ANY(${pgUuidArray(['a', 'b', 'c'])})`)

    expect(text).toContain('ARRAY[')
    expect(text).toContain('::uuid[]')
    // Must NOT be a parenthesised row constructor cast to uuid[].
    expect(text).not.toMatch(/\(\$\d+,\s*\$\d+[^)]*\)::uuid\[\]/)
    expect(params).toEqual(['a', 'b', 'c'])
  })

  it('handles a single id', () => {
    const { sql: text, params } = render(pgUuidArray(['only-one']))
    expect(text).toContain('ARRAY[')
    expect(text).toContain('::uuid[]')
    expect(params).toEqual(['only-one'])
  })

  it('handles an empty array', () => {
    const { sql: text, params } = render(pgUuidArray([]))
    expect(text).toBe('ARRAY[]::uuid[]')
    expect(params).toEqual([])
  })
})
