import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Database } from '@open-brain/shared'

// ---------------------------------------------------------------------------
// Mock DB
// ---------------------------------------------------------------------------

function makeDb(): Database {
  return {
    execute: vi.fn().mockResolvedValue({ rows: [] }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([]),
      }),
    }),
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      offset: vi.fn().mockResolvedValue([]),
    }),
  } as unknown as Database
}

// ---------------------------------------------------------------------------
// buildEmailComposeTools tests
// ---------------------------------------------------------------------------

describe('buildEmailComposeTools', () => {
  // Import after mocks are set up
  let buildEmailComposeTools: typeof import('../skills/email-compose.js').buildEmailComposeTools

  beforeEach(async () => {
    vi.resetModules()
    const mod = await import('../skills/email-compose.js')
    buildEmailComposeTools = mod.buildEmailComposeTools
  })

  it('returns 3 tools: search_brain, get_entity, draft_email', () => {
    const db = makeDb()
    const tools = buildEmailComposeTools(db, 'http://localhost:3000')

    expect(tools).toHaveLength(3)
    expect(tools.map((t) => t.name)).toEqual(['search_brain', 'get_entity', 'draft_email'])
  })

  describe('search_brain tool', () => {
    it('returns "No results found." when DB returns empty rows', async () => {
      const db = makeDb()
      const tools = buildEmailComposeTools(db, 'http://localhost:3000')
      const searchTool = tools.find((t) => t.name === 'search_brain')!

      const result = await searchTool.execute({ query: 'test query' })
      expect(result).toBe('No results found.')
      expect(db.execute).toHaveBeenCalled()
    })

    it('returns formatted results when captures exist', async () => {
      const db = makeDb()
      ;(db.execute as any).mockResolvedValue({
        rows: [
          {
            id: 'cap-1',
            content: 'Meeting with John about Project X',
            capture_type: 'observation',
            brain_view: 'work-internal',
            source: 'slack',
            tags: ['meeting'],
            created_at: '2026-04-10T12:00:00Z',
          },
        ],
      })

      const tools = buildEmailComposeTools(db, 'http://localhost:3000')
      const searchTool = tools.find((t) => t.name === 'search_brain')!

      const result = await searchTool.execute({ query: 'project' })
      expect(result).toContain('Meeting with John')
      expect(result).toContain('observation/work-internal')
    })
  })

  describe('get_entity tool', () => {
    it('returns "No entity found" when DB returns empty', async () => {
      const db = makeDb()
      const tools = buildEmailComposeTools(db, 'http://localhost:3000')
      const entityTool = tools.find((t) => t.name === 'get_entity')!

      const result = await entityTool.execute({ name: 'Unknown Person' })
      expect(result).toContain('No entity found')
    })

    it('returns entity details when found', async () => {
      const db = makeDb()
      ;(db.execute as any).mockResolvedValue({
        rows: [
          {
            name: 'John Smith',
            entity_type: 'person',
            canonical_name: 'john smith',
            aliases: [],
            metadata: { email: 'john@example.com' },
            mention_count: '5',
          },
        ],
      })

      const tools = buildEmailComposeTools(db, 'http://localhost:3000')
      const entityTool = tools.find((t) => t.name === 'get_entity')!

      const result = await entityTool.execute({ name: 'John' })
      expect(result).toContain('John Smith')
      expect(result).toContain('person')
      expect(result).toContain('5 mentions')
    })
  })

  describe('draft_email tool', () => {
    it('returns error when required fields are missing', async () => {
      const db = makeDb()
      const tools = buildEmailComposeTools(db, 'http://localhost:3000')
      const draftTool = tools.find((t) => t.name === 'draft_email')!

      const result = await draftTool.execute({ to: '', subject: '', body: '' })
      expect(result).toContain('Error')
    })

    it('calls core API to create draft', async () => {
      const db = makeDb()
      const tools = buildEmailComposeTools(db, 'http://localhost:3000')
      const draftTool = tools.find((t) => t.name === 'draft_email')!

      // Mock global fetch
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({ id: 'new-draft-1', status: 'draft', send_mode: 'review-required' }),
      })
      vi.stubGlobal('fetch', mockFetch)

      const result = await draftTool.execute({
        to: 'recipient@example.com',
        subject: 'Test email',
        body: 'Hello, this is a test.',
      })

      expect(result).toContain('Draft created successfully')
      expect(result).toContain('new-draft-1')
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3000/api/v1/email/drafts',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
          }),
        }),
      )

      vi.unstubAllGlobals()
    })

    it('returns error when API call fails', async () => {
      const db = makeDb()
      const tools = buildEmailComposeTools(db, 'http://localhost:3000')
      const draftTool = tools.find((t) => t.name === 'draft_email')!

      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: vi.fn().mockResolvedValue('Internal server error'),
      })
      vi.stubGlobal('fetch', mockFetch)

      const result = await draftTool.execute({
        to: 'recipient@example.com',
        subject: 'Test',
        body: 'Hello',
      })

      expect(result).toContain('Error creating draft')
      expect(result).toContain('500')

      vi.unstubAllGlobals()
    })
  })
})
