import { describe, it, expect, vi } from 'vitest'
import { generateContextSummary } from '../mcp/resources/context.js'

describe('generateContextSummary', () => {
  it('returns markdown with section headers when db is empty', async () => {
    const mockDb = {
      execute: vi.fn().mockResolvedValue({ rows: [] }),
    } as any

    const result = await generateContextSummary(mockDb)
    expect(result).toContain('# Open Brain Context')
    expect(result).toContain('## Active Focus Areas')
    expect(result).toContain('## Key Entities')
    expect(result).toContain('## Open Questions')
    expect(result).toContain('## Recent Decisions')
    expect(result).toContain('## Capture Types')
  })

  it('handles database errors gracefully', async () => {
    const mockDb = {
      execute: vi.fn().mockRejectedValue(new Error('connection failed')),
    } as any

    const result = await generateContextSummary(mockDb)
    expect(result).toContain('# Open Brain Context')
    // Should contain fallback text for all sections
    expect(result).toContain('Unable to query')
    // Should NOT throw
  })

  it('formats entity data correctly', async () => {
    let callCount = 0
    const mockDb = {
      execute: vi.fn().mockImplementation(() => {
        callCount++
        if (callCount === 2) {
          // Entity query (second call)
          return { rows: [{ name: 'TestEntity', entity_type: 'person', mention_count: '5', last_seen_at: '2026-04-01T00:00:00Z' }] }
        }
        return { rows: [] }
      }),
    } as any

    const result = await generateContextSummary(mockDb)
    expect(result).toContain('TestEntity')
    expect(result).toContain('person')
    expect(result).toContain('5')
    expect(result).toContain('2026-04-01')
  })

  it('formats brain view counts correctly', async () => {
    let callCount = 0
    const mockDb = {
      execute: vi.fn().mockImplementation(() => {
        callCount++
        if (callCount === 1) {
          // View counts query (first call)
          return { rows: [
            { brain_view: 'technical', count: '12' },
            { brain_view: 'personal', count: '5' },
          ] }
        }
        return { rows: [] }
      }),
    } as any

    const result = await generateContextSummary(mockDb)
    expect(result).toContain('**technical**: 12 captures')
    expect(result).toContain('**personal**: 5 captures')
  })

  it('truncates long content to 200 characters', async () => {
    const longContent = 'A'.repeat(300)
    let callCount = 0
    const mockDb = {
      execute: vi.fn().mockImplementation(() => {
        callCount++
        if (callCount === 3) {
          // Questions query (third call)
          return { rows: [{ content: longContent, created_at: '2026-04-01T10:00:00Z', brain_view: 'technical' }] }
        }
        return { rows: [] }
      }),
    } as any

    const result = await generateContextSummary(mockDb)
    expect(result).toContain('A'.repeat(200) + '...')
    expect(result).not.toContain('A'.repeat(201))
  })

  it('includes date in title header', async () => {
    const mockDb = {
      execute: vi.fn().mockResolvedValue({ rows: [] }),
    } as any

    const result = await generateContextSummary(mockDb)
    // Should contain a date in YYYY-MM-DD format
    expect(result).toMatch(/# Open Brain Context — \d{4}-\d{2}-\d{2}/)
  })

  it('handles partial failures gracefully', async () => {
    let callCount = 0
    const mockDb = {
      execute: vi.fn().mockImplementation(() => {
        callCount++
        // First and third queries succeed, rest fail
        if (callCount === 1) {
          return { rows: [{ brain_view: 'technical', count: '3' }] }
        }
        if (callCount === 3) {
          return { rows: [{ content: 'Why does X?', created_at: '2026-04-01T10:00:00Z', brain_view: 'technical' }] }
        }
        throw new Error('db error')
      }),
    } as any

    const result = await generateContextSummary(mockDb)
    // Successful sections present
    expect(result).toContain('**technical**: 3 captures')
    expect(result).toContain('Why does X?')
    // Failed sections have fallback
    expect(result).toContain('Unable to query entities')
  })
})
