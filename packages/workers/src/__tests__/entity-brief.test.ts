import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest'
import { join } from 'node:path'
import { EntityBriefSkill, parseEntityBriefOutput } from '../skills/entity-brief.js'
import type { EntityBriefOutput, EntityBriefInput } from '../skills/entity-brief.js'
import type { Database } from '@open-brain/shared'

// Prompt templates live at <repo-root>/config/prompts/
const REPO_PROMPTS_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'config', 'prompts')

// ============================================================
// Fixtures
// ============================================================

const SAMPLE_ENTITY = { id: 'entity-uuid-1', name: 'Sarah Chen', entity_type: 'person' }

const SAMPLE_CAPTURES = [
  {
    id: 'cap-1',
    content: 'Met with Sarah Chen to discuss the Q2 roadmap — aligned on priorities.',
    capture_type: 'observation',
    source: 'api',
    captured_at: new Date('2026-04-15T10:00:00Z'),
  },
  {
    id: 'cap-2',
    content: 'Sarah Chen approved the infrastructure budget for Q2.',
    capture_type: 'decision',
    source: 'slack',
    captured_at: new Date('2026-04-10T14:00:00Z'),
  },
  {
    id: 'cap-3',
    content: 'Sarah Chen asked for a follow-up on the security audit by end of month.',
    capture_type: 'task',
    source: 'voice',
    captured_at: new Date('2026-04-08T09:00:00Z'),
  },
]

const SAMPLE_RELATED_ENTITIES = [
  { id: 'entity-uuid-2', name: 'Open Brain', entity_type: 'project', co_occurrence_count: 3 },
  { id: 'entity-uuid-3', name: 'CGI', entity_type: 'org', co_occurrence_count: 2 },
]

const SAMPLE_OUTPUT: EntityBriefOutput = {
  summary: 'Sarah Chen is a key stakeholder who reviews technical decisions and budget approvals.',
  key_facts: [
    'Approved Q2 infrastructure budget',
    'Requested security audit follow-up by end of month',
    'Aligned on Q2 roadmap priorities',
  ],
  recent_activity: [
    'Discussed Q2 roadmap on 2026-04-15',
    'Approved infrastructure budget on 2026-04-10',
    'Requested security audit follow-up on 2026-04-08',
  ],
  open_threads: [
    'Security audit follow-up due end of April',
  ],
  relationship_context: 'Professional — stakeholder who reviews technical decisions and approves budgets.',
  signals: [
    'Increasing involvement in infrastructure decisions',
  ],
}

// ============================================================
// Mock helpers
// ============================================================

/** Build a mock DB that sequences entity → captures → related entities queries. */
function makeMockDb(opts: {
  entity?: typeof SAMPLE_ENTITY | null
  captures?: typeof SAMPLE_CAPTURES
  relatedEntities?: typeof SAMPLE_RELATED_ENTITIES
  briefInsertId?: string | null
  logInsertId?: string
} = {}) {
  const {
    entity = SAMPLE_ENTITY,
    captures = SAMPLE_CAPTURES,
    relatedEntities = SAMPLE_RELATED_ENTITIES,
    briefInsertId = 'brief-uuid-1',
    logInsertId = 'log-uuid-1',
  } = opts

  let executeCallCount = 0

  // Sequence insert calls: first call = briefs table, second call = skills_log
  let insertCallCount = 0
  const smartInsert = vi.fn().mockImplementation(() => {
    insertCallCount++
    if (insertCallCount === 1) {
      // briefs insert
      return {
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue(
            briefInsertId !== null ? [{ id: briefInsertId }] : [],
          ),
        }),
      }
    }
    // skills_log insert
    return {
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: logInsertId }]),
      }),
    }
  })

  const mockExecute = vi.fn().mockImplementation(() => {
    executeCallCount++
    if (executeCallCount === 1) {
      // Entity fetch
      return Promise.resolve({ rows: entity ? [entity] : [] })
    }
    if (executeCallCount === 2) {
      // Captures fetch
      return Promise.resolve({ rows: captures })
    }
    if (executeCallCount === 3) {
      // Related entities fetch
      return Promise.resolve({ rows: relatedEntities })
    }
    return Promise.resolve({ rows: [] })
  })

  return {
    execute: mockExecute,
    insert: smartInsert,
  }
}

function makeMockLLM(output: EntityBriefOutput = SAMPLE_OUTPUT) {
  return {
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [{ message: { content: JSON.stringify(output) } }],
          usage: { prompt_tokens: 800, completion_tokens: 400, total_tokens: 1200 },
        }),
      },
    },
  }
}

function makeSkill(opts: {
  entity?: typeof SAMPLE_ENTITY | null
  captures?: typeof SAMPLE_CAPTURES
  relatedEntities?: typeof SAMPLE_RELATED_ENTITIES
  llmOutput?: EntityBriefOutput
  briefInsertId?: string | null
  promptsDir?: string
} = {}) {
  const db = makeMockDb({
    entity: 'entity' in opts ? opts.entity : SAMPLE_ENTITY,
    captures: opts.captures ?? SAMPLE_CAPTURES,
    relatedEntities: opts.relatedEntities ?? SAMPLE_RELATED_ENTITIES,
    briefInsertId: 'briefInsertId' in opts ? opts.briefInsertId : 'brief-uuid-1',
  })

  const mockLLM = makeMockLLM(opts.llmOutput ?? SAMPLE_OUTPUT)

  const skill = new EntityBriefSkill({
    db: db as unknown as Database,
    promptsDir: opts.promptsDir ?? REPO_PROMPTS_DIR,
    coreApiUrl: 'http://localhost:3000',
  })

  // Inject mock LLM client
  // @ts-expect-error — accessing private field for testing
  skill.litellmClient = mockLLM

  return { skill, db, mockLLM }
}

const SAMPLE_INPUT: EntityBriefInput = {
  entityId: SAMPLE_ENTITY.id,
  entityName: SAMPLE_ENTITY.name,
  entityType: SAMPLE_ENTITY.entity_type,
}

// ============================================================
// Tests: parseEntityBriefOutput
// ============================================================

describe('parseEntityBriefOutput', () => {
  it('parses valid JSON into EntityBriefOutput', () => {
    const raw = JSON.stringify(SAMPLE_OUTPUT)
    const result = parseEntityBriefOutput(raw)
    expect(result.summary).toBe(SAMPLE_OUTPUT.summary)
    expect(result.key_facts).toHaveLength(3)
    expect(result.open_threads).toHaveLength(1)
    expect(result.signals).toHaveLength(1)
  })

  it('strips markdown code fences before parsing', () => {
    const raw = '```json\n' + JSON.stringify(SAMPLE_OUTPUT) + '\n```'
    const result = parseEntityBriefOutput(raw)
    expect(result.summary).toBe(SAMPLE_OUTPUT.summary)
  })

  it('strips code fences without language specifier', () => {
    const raw = '```\n' + JSON.stringify(SAMPLE_OUTPUT) + '\n```'
    const result = parseEntityBriefOutput(raw)
    expect(result.summary).toBe(SAMPLE_OUTPUT.summary)
  })

  it('falls back to raw text as summary on invalid JSON', () => {
    const result = parseEntityBriefOutput('not JSON at all')
    expect(result.summary).toBe('not JSON at all')
    expect(result.key_facts).toEqual([])
    expect(result.signals).toEqual([])
  })

  it('returns empty summary string for empty input', () => {
    const result = parseEntityBriefOutput('')
    expect(result.summary).toBe('(no summary)')
  })

  it('handles missing fields gracefully', () => {
    const raw = JSON.stringify({ summary: 'Just a summary' })
    const result = parseEntityBriefOutput(raw)
    expect(result.summary).toBe('Just a summary')
    expect(result.key_facts).toEqual([])
    expect(result.recent_activity).toEqual([])
    expect(result.open_threads).toEqual([])
    expect(result.relationship_context).toBe('')
    expect(result.signals).toEqual([])
  })

  it('filters non-string items from array fields', () => {
    const raw = JSON.stringify({
      ...SAMPLE_OUTPUT,
      key_facts: ['valid', 42, null, 'also valid'],
    })
    const result = parseEntityBriefOutput(raw)
    expect(result.key_facts).toEqual(['valid', 'also valid'])
  })

  it('defaults summary when missing', () => {
    const raw = JSON.stringify({ key_facts: ['fact1'] })
    const result = parseEntityBriefOutput(raw)
    expect(result.summary).toBe('(no summary)')
  })
})

// ============================================================
// Tests: EntityBriefSkill — happy path
// ============================================================

describe('EntityBriefSkill', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  describe('execute — happy path (entity with captures)', () => {
    it('returns EntityBriefResult with correct fields', async () => {
      const { skill } = makeSkill()
      const result = await skill.execute(SAMPLE_INPUT)

      expect(result.entityId).toBe(SAMPLE_ENTITY.id)
      expect(result.entityName).toBe(SAMPLE_ENTITY.name)
      expect(result.captureCount).toBe(SAMPLE_CAPTURES.length)
      expect(result.generated).toBe(true)
      expect(result.briefId).toBe('brief-uuid-1')
      expect(result.durationMs).toBeGreaterThanOrEqual(0)
    })

    it('fetches entity, captures, and related entities from DB', async () => {
      const { skill, db } = makeSkill()
      await skill.execute(SAMPLE_INPUT)

      // execute called 3 times: entity + captures + related entities
      expect(db.execute).toHaveBeenCalledTimes(3)
    })

    it('calls LLM with prompt containing entity name and capture count', async () => {
      const { skill, mockLLM } = makeSkill()
      await skill.execute(SAMPLE_INPUT)

      const createSpy = mockLLM.chat.completions.create as MockInstance
      expect(createSpy).toHaveBeenCalledOnce()
      const prompt: string = createSpy.mock.calls[0][0].messages[0].content
      expect(prompt).toContain('Sarah Chen')
      expect(prompt).toContain('3') // capture count
    })

    it('inserts a DOSSIER brief row', async () => {
      const { skill, db } = makeSkill()
      await skill.execute(SAMPLE_INPUT)

      const insertSpy = db.insert as MockInstance
      // First insert call is briefs
      const firstCall = insertSpy.mock.calls[0]
      // The table arg should be the briefs table object
      expect(firstCall).toBeDefined()

      // Verify values passed to briefs insert contain DOSSIER kind
      const valuesSpy = insertSpy.mock.results[0].value.values as MockInstance
      const briefValues = valuesSpy.mock.calls[0][0]
      expect(briefValues.kind).toBe('DOSSIER')
      expect(briefValues.cover).toBe('canvas')
      expect(briefValues.title).toContain('Sarah Chen')
      expect(briefValues.body_html).toBeTruthy()
    })

    it('writes a skills_log entry', async () => {
      const { skill, db } = makeSkill()
      await skill.execute(SAMPLE_INPUT)

      // Second insert call is skills_log
      const insertSpy = db.insert as MockInstance
      expect(insertSpy.mock.calls.length).toBeGreaterThanOrEqual(2)
      const logValuesSpy = insertSpy.mock.results[1].value.values as MockInstance
      const logEntry = logValuesSpy.mock.calls[0][0]
      expect(logEntry.skill_name).toBe('entity-brief')
      expect(logEntry.input_summary).toContain(SAMPLE_ENTITY.id)
    })

    it('includes sources from captures in brief row', async () => {
      const { skill, db } = makeSkill()
      await skill.execute(SAMPLE_INPUT)

      const insertSpy = db.insert as MockInstance
      const valuesSpy = insertSpy.mock.results[0].value.values as MockInstance
      const briefValues = valuesSpy.mock.calls[0][0]
      expect(Array.isArray(briefValues.sources)).toBe(true)
      expect(briefValues.sources.length).toBeGreaterThan(0)
    })

    it('includes DOSSIER refine_options in brief row', async () => {
      const { skill, db } = makeSkill()
      await skill.execute(SAMPLE_INPUT)

      const insertSpy = db.insert as MockInstance
      const valuesSpy = insertSpy.mock.results[0].value.values as MockInstance
      const briefValues = valuesSpy.mock.calls[0][0]
      expect(briefValues.refine_options).toContain('Focus on recent')
      expect(briefValues.refine_options).toContain('Focus on decisions')
      expect(briefValues.refine_options).toContain('Key relationships only')
    })
  })

  // ──────────────────────────────────────────────────────────────
  // Entity not found
  // ──────────────────────────────────────────────────────────────

  describe('execute — entity not found', () => {
    it('returns generated:false with briefId null', async () => {
      const { skill } = makeSkill({ entity: null })
      const result = await skill.execute(SAMPLE_INPUT)

      expect(result.generated).toBe(false)
      expect(result.briefId).toBeNull()
      expect(result.captureCount).toBe(0)
    })

    it('still writes a skills_log entry', async () => {
      const { skill, db } = makeSkill({ entity: null })
      await skill.execute(SAMPLE_INPUT)

      const insertSpy = db.insert as MockInstance
      expect(insertSpy).toHaveBeenCalled()
    })

    it('does not call LLM when entity is not found', async () => {
      const { skill, mockLLM } = makeSkill({ entity: null })
      await skill.execute(SAMPLE_INPUT)

      const createSpy = mockLLM.chat.completions.create as MockInstance
      expect(createSpy).not.toHaveBeenCalled()
    })
  })

  // ──────────────────────────────────────────────────────────────
  // 0 captures (entity exists but no linked captures)
  // ──────────────────────────────────────────────────────────────

  describe('execute — entity with 0 captures', () => {
    it('returns generated:true with a minimal brief', async () => {
      const { skill } = makeSkill({ captures: [] })
      const result = await skill.execute(SAMPLE_INPUT)

      expect(result.captureCount).toBe(0)
      expect(result.generated).toBe(true)
      expect(result.briefId).toBe('brief-uuid-1')
    })

    it('does not call LLM for 0-capture case', async () => {
      const { skill, mockLLM } = makeSkill({ captures: [] })
      await skill.execute(SAMPLE_INPUT)

      const createSpy = mockLLM.chat.completions.create as MockInstance
      expect(createSpy).not.toHaveBeenCalled()
    })

    it('inserts a DOSSIER brief even with 0 captures', async () => {
      const { skill, db } = makeSkill({ captures: [] })
      await skill.execute(SAMPLE_INPUT)

      const insertSpy = db.insert as MockInstance
      const valuesSpy = insertSpy.mock.results[0].value.values as MockInstance
      const briefValues = valuesSpy.mock.calls[0][0]
      expect(briefValues.kind).toBe('DOSSIER')
    })

    it('does not query related entities when 0 captures', async () => {
      const { skill, db } = makeSkill({ captures: [] })
      await skill.execute(SAMPLE_INPUT)

      // Only 2 execute calls: entity + captures (no related entities when captureCount === 0)
      expect(db.execute).toHaveBeenCalledTimes(2)
    })
  })

  // ──────────────────────────────────────────────────────────────
  // Non-fatal failures
  // ──────────────────────────────────────────────────────────────

  describe('execute — non-fatal brief insert failure', () => {
    it('returns generated:false but does not throw when brief insert fails', async () => {
      const { skill, db } = makeSkill({ briefInsertId: null })
      const result = await skill.execute(SAMPLE_INPUT)

      // briefId will be null since insert returned empty array
      expect(result.briefId).toBeNull()
      expect(result.generated).toBe(false)
      // Should still complete without throwing
      expect(result.durationMs).toBeGreaterThanOrEqual(0)
    })
  })

  describe('execute — non-fatal skills_log failure', () => {
    it('continues if logResult throws', async () => {
      const { skill, db } = makeSkill()
      // Override second insert call (skills_log) to reject
      let callCount = 0
      ;(db.insert as MockInstance).mockImplementation(() => {
        callCount++
        if (callCount === 1) {
          return {
            values: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{ id: 'brief-uuid-1' }]),
            }),
          }
        }
        return {
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockRejectedValue(new Error('DB write failed')),
          }),
        }
      })

      const result = await skill.execute(SAMPLE_INPUT)
      // Skill completes even when log insert fails
      expect(result.entityId).toBe(SAMPLE_ENTITY.id)
    })
  })

  // ──────────────────────────────────────────────────────────────
  // LLM failure propagation
  // ──────────────────────────────────────────────────────────────

  describe('execute — LLM failure', () => {
    it('propagates LLM errors', async () => {
      const { skill, mockLLM } = makeSkill()
      ;(mockLLM.chat.completions.create as MockInstance).mockRejectedValue(
        new Error('LLM timeout'),
      )

      await expect(skill.execute(SAMPLE_INPUT)).rejects.toThrow('LLM timeout')
    })
  })

  // ──────────────────────────────────────────────────────────────
  // LLM Gateway path
  // ──────────────────────────────────────────────────────────────

  describe('execute — LLM gateway path', () => {
    it('uses llmGateway.completeByTask when gateway is provided', async () => {
      const db = makeMockDb()
      const mockGateway = {
        completeByTask: vi.fn().mockResolvedValue(JSON.stringify(SAMPLE_OUTPUT)),
      }

      const skill = new EntityBriefSkill({
        db: db as unknown as Database,
        promptsDir: REPO_PROMPTS_DIR,
        // @ts-expect-error — partial mock
        llmGateway: mockGateway,
      })

      const result = await skill.execute(SAMPLE_INPUT)

      expect(mockGateway.completeByTask).toHaveBeenCalledOnce()
      const [prompt, taskKey] = mockGateway.completeByTask.mock.calls[0]
      expect(taskKey).toBe('search_synthesis')
      expect(prompt).toContain('Sarah Chen')
      expect(result.generated).toBe(true)
    })
  })

  // ──────────────────────────────────────────────────────────────
  // minimum_autonomy gate
  // ──────────────────────────────────────────────────────────────

  describe('autonomy gate', () => {
    it('declares minimum_autonomy of observe', () => {
      expect(EntityBriefSkill.minimum_autonomy).toBe('observe')
    })
  })
})

// ============================================================
// Tests: executeEntityBrief top-level function
// ============================================================

describe('executeEntityBrief', () => {
  it('is exported and callable', async () => {
    const { executeEntityBrief } = await import('../skills/entity-brief.js')
    expect(typeof executeEntityBrief).toBe('function')
  })
})
