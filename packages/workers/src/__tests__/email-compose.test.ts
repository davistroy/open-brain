import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Database, ConfigService } from '@open-brain/shared'
import { _resetBaseSkillAutonomyCacheForTest } from '../skills/base-skill.js'

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
// Mock @open-brain/shared — intercept runAgent so no real Anthropic client is hit.
// ---------------------------------------------------------------------------

const runAgentMock = vi.fn()

vi.mock('@open-brain/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@open-brain/shared')>()
  return {
    ...actual,
    runAgent: runAgentMock,
  }
})

// ---------------------------------------------------------------------------
// Fake ConfigService — returns a minimal AIConfig with task_routing + model_tiers.
// ---------------------------------------------------------------------------

function makeConfigService(taskModel: string, tierKey = 't2_quality'): ConfigService {
  return {
    get: vi.fn((slice: string) => {
      if (slice === 'ai') {
        return {
          models: {},
          task_routing: { email_compose: tierKey },
          model_tiers: {
            [tierKey]: {
              model: taskModel,
              provider: 'anthropic',
              timeout_tier: 'extended',
            },
          },
        }
      }
      return undefined
    }),
  } as unknown as ConfigService
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

// ---------------------------------------------------------------------------
// EmailComposeSkill tests — model resolution via resolveTaskModel
// ---------------------------------------------------------------------------

describe('EmailComposeSkill model resolution', () => {
  let EmailComposeSkill: typeof import('../skills/email-compose.js').EmailComposeSkill
  let ModelResolverError: typeof import('@open-brain/shared').ModelResolverError

  beforeEach(async () => {
    vi.resetModules()
    runAgentMock.mockReset()
    // Stub fetch so autonomy gate (minimum_autonomy='advise') passes for all model-resolution tests
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ value: 'partner' }),
    } as unknown as Response)
    const skillMod = await import('../skills/email-compose.js')
    EmailComposeSkill = skillMod.EmailComposeSkill
    const sharedMod = await import('@open-brain/shared')
    ModelResolverError = sharedMod.ModelResolverError
  })

  it('resolves model from ai-routing.yaml task_routing at init and passes it to runAgent', async () => {
    const db = makeDb()
    const configService = makeConfigService('claude-sonnet-4-6')

    runAgentMock.mockResolvedValue({
      iterations: 1,
      toolCalls: [],
      finalMessage: { role: 'assistant', content: [] },
      stopReason: 'end_turn',
      totalTokens: { input: 10, output: 10 },
    })

    const skill = new EmailComposeSkill({
      db,
      configService,
      anthropicClient: {} as never,
    })

    await skill.execute({ instruction: 'Email Alice about the deck' })

    expect(runAgentMock).toHaveBeenCalledTimes(1)
    const [, , , runAgentOpts] = runAgentMock.mock.calls[0]
    expect(runAgentOpts.model).toBe('claude-sonnet-4-6')
  })

  it('uses the configured tier model even when options.model is omitted at execute time', async () => {
    const db = makeDb()
    const configService = makeConfigService('claude-opus-99')

    runAgentMock.mockResolvedValue({
      iterations: 1,
      toolCalls: [],
      finalMessage: { role: 'assistant', content: [] },
      stopReason: 'end_turn',
      totalTokens: { input: 10, output: 10 },
    })

    const skill = new EmailComposeSkill({
      db,
      configService,
      anthropicClient: {} as never,
    })

    await skill.execute({ instruction: 'test' })

    const [, , , runAgentOpts] = runAgentMock.mock.calls[0]
    expect(runAgentOpts.model).toBe('claude-opus-99')
  })

  it('throws ModelResolverError at construction when task_routing lacks email_compose', () => {
    const db = makeDb()
    // Config without email_compose in task_routing
    const brokenConfig = {
      get: vi.fn((slice: string) => {
        if (slice === 'ai') {
          return {
            models: {},
            task_routing: {},
            model_tiers: { t2_quality: { model: 'x', provider: 'anthropic', timeout_tier: 'extended' } },
          }
        }
        return undefined
      }),
    } as unknown as ConfigService

    expect(() => new EmailComposeSkill({ db, configService: brokenConfig })).toThrow(ModelResolverError)
  })

  it('throws at execute() when neither configService nor options.model is supplied', async () => {
    const db = makeDb()
    const skill = new EmailComposeSkill({ db, anthropicClient: {} as never })

    await expect(skill.execute({ instruction: 'hi' })).rejects.toBeInstanceOf(ModelResolverError)
    // runAgent should never be invoked on this failure path
    expect(runAgentMock).not.toHaveBeenCalled()
  })

  it('allows options.model to override the init-time resolved model', async () => {
    const db = makeDb()
    const configService = makeConfigService('claude-sonnet-4-6')

    runAgentMock.mockResolvedValue({
      iterations: 1,
      toolCalls: [],
      finalMessage: { role: 'assistant', content: [] },
      stopReason: 'end_turn',
      totalTokens: { input: 10, output: 10 },
    })

    const skill = new EmailComposeSkill({
      db,
      configService,
      anthropicClient: {} as never,
    })

    await skill.execute({ instruction: 'test', model: 'claude-override-xyz' })

    const [, , , runAgentOpts] = runAgentMock.mock.calls[0]
    expect(runAgentOpts.model).toBe('claude-override-xyz')
  })
})

// ---------------------------------------------------------------------------
// EmailComposeSkill autonomy gate (P05)
// Uses vi.resetModules() like the model-resolution tests to get a fresh module
// instance. Fetch is set up per-test to control the autonomy level.
// ---------------------------------------------------------------------------

describe('EmailComposeSkill autonomy gate', () => {
  let EmailComposeSkill: typeof import('../skills/email-compose.js').EmailComposeSkill
  let resetAutonomyCache: () => void

  beforeEach(async () => {
    vi.resetModules()
    runAgentMock.mockReset()
    const skillMod = await import('../skills/email-compose.js')
    EmailComposeSkill = skillMod.EmailComposeSkill
    const baseSkillMod = await import('../skills/base-skill.js')
    resetAutonomyCache = baseSkillMod._resetBaseSkillAutonomyCacheForTest
    resetAutonomyCache()
    vi.restoreAllMocks()
  })

  function makeEmailSkill() {
    return new EmailComposeSkill({
      db: makeDb(),
      configService: makeConfigService('claude-sonnet-4-6'),
      anthropicClient: {} as never,
    })
  }

  it('gates at observe level (minimum_autonomy = advise)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ value: 'observe' }),
    } as unknown as Response)
    const skill = makeEmailSkill()

    const result = await skill.execute({ instruction: 'send email' })

    expect(result.status).toBe('gated')
    expect(result.durationMs).toBe(0)
    expect(runAgentMock).not.toHaveBeenCalled()
  })

  it('gates at assist level (minimum_autonomy = advise, assist < advise)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ value: 'assist' }),
    } as unknown as Response)
    const skill = makeEmailSkill()

    const result = await skill.execute({ instruction: 'send email' })

    expect(result.status).toBe('gated')
    expect(result.durationMs).toBe(0)
    expect(runAgentMock).not.toHaveBeenCalled()
  })

  it('runs at advise level (meets minimum_autonomy = advise)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ value: 'advise' }),
    } as unknown as Response)
    runAgentMock.mockResolvedValue({
      iterations: 1,
      toolCalls: [],
      finalMessage: { role: 'assistant', content: [] },
      stopReason: 'end_turn',
      totalTokens: { input: 10, output: 10 },
    })
    const skill = makeEmailSkill()

    const result = await skill.execute({ instruction: 'send email' })

    expect(result.status).toBeUndefined()
    expect(runAgentMock).toHaveBeenCalledOnce()
  })

  it('runs at partner level (exceeds minimum_autonomy = advise)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ value: 'partner' }),
    } as unknown as Response)
    runAgentMock.mockResolvedValue({
      iterations: 1,
      toolCalls: [],
      finalMessage: { role: 'assistant', content: [] },
      stopReason: 'end_turn',
      totalTokens: { input: 10, output: 10 },
    })
    const skill = makeEmailSkill()

    const result = await skill.execute({ instruction: 'send email' })

    expect(result.status).toBeUndefined()
    expect(runAgentMock).toHaveBeenCalledOnce()
  })
})

