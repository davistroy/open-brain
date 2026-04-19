import { describe, it, expect, vi, beforeEach } from 'vitest'
import { join } from 'node:path'
import { MemoryConsolidationSkill } from '../skills/memory-consolidation.js'
import type { MemoryConsolidationOptions, ConsolidationLLMOutput } from '../skills/memory-consolidation.js'
import { PushoverService } from '@open-brain/shared'
import type { LLMGatewayService } from '@open-brain/shared'
import { _resetBaseSkillAutonomyCacheForTest } from '../skills/base-skill.js'

// Prompt templates live at <repo-root>/config/prompts/
const REPO_PROMPTS_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'config', 'prompts')

// ---------------------------------------------------------------------------
// Mock memory-consolidation-query module
// ---------------------------------------------------------------------------

vi.mock('../skills/memory-consolidation-query.js', () => ({
  findConsolidationCandidates: vi.fn(),
}))

import { findConsolidationCandidates } from '../skills/memory-consolidation-query.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SAMPLE_CLUSTER = {
  captureIds: ['cap-uuid-1', 'cap-uuid-2', 'cap-uuid-3'],
  avgSimilarity: 0.95,
  minSimilarity: 0.93,
}

const SAMPLE_CAPTURE_ROWS = [
  {
    id: 'cap-uuid-1',
    content: 'Open Brain voice pipeline end-to-end complete — Apple Watch to Postgres.',
    capture_type: 'win',
    brain_view: 'technical',
    source: 'voice',
    tags: ['open-brain'],
    created_at: '2026-04-01T10:00:00.000Z',
  },
  {
    id: 'cap-uuid-2',
    content: 'Voice pipeline from Watch to database is working end to end.',
    capture_type: 'win',
    brain_view: 'technical',
    source: 'slack',
    tags: ['open-brain', 'voice'],
    created_at: '2026-04-02T11:00:00.000Z',
  },
  {
    id: 'cap-uuid-3',
    content: 'Confirmed voice-to-Postgres pipeline is live and performant.',
    capture_type: 'observation',
    brain_view: 'technical',
    source: 'api',
    tags: ['voice'],
    created_at: '2026-04-03T09:00:00.000Z',
  },
]

const SAMPLE_LLM_OUTPUT: ConsolidationLLMOutput = {
  should_merge: true,
  merged_content: 'Open Brain voice pipeline confirmed end-to-end from Apple Watch to Postgres, performant and live.',
  merged_tags: ['open-brain', 'voice'],
  merge_rationale: 'All three captures describe the same event — voice pipeline completion.',
}

const EMPTY_QUERY_RESULT = {
  clusters: [],
  totalPairsFound: 0,
  totalClustersFound: 0,
  durationMs: 10,
}

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function makeMockPushover(configured = false) {
  const svc = new PushoverService({ appToken: 'tok', userKey: 'usr', onError: 'throw' })
  if (!configured) {
    Object.defineProperty(svc, 'isConfigured', { get: () => false })
  }
  vi.spyOn(svc, 'send').mockResolvedValue(undefined)
  return svc
}

function makeMockGateway(llmResponse: ConsolidationLLMOutput | string = SAMPLE_LLM_OUTPUT): LLMGatewayService {
  const responseText = typeof llmResponse === 'string'
    ? llmResponse
    : JSON.stringify(llmResponse)
  return {
    completeByTask: vi.fn().mockResolvedValue(responseText),
  } as unknown as LLMGatewayService
}

function makeMockOpenAI(llmResponse: ConsolidationLLMOutput = SAMPLE_LLM_OUTPUT) {
  return {
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [{ message: { content: JSON.stringify(llmResponse) } }],
          usage: { prompt_tokens: 500, completion_tokens: 200 },
        }),
      },
    },
  }
}

/**
 * Build a minimal DB mock for memory-consolidation.
 * - execute: returns SAMPLE_CAPTURE_ROWS for loadCaptures SQL call
 * - insert: handles skills_log writes
 */
function makeMockDb(captureRows = SAMPLE_CAPTURE_ROWS) {
  return {
    execute: vi.fn().mockResolvedValue({ rows: captureRows }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    }),
  }
}

/**
 * Builds a MemoryConsolidationSkill with mocked LLM gateway and DB.
 */
function makeSkillWithGateway(opts: {
  captureRows?: typeof SAMPLE_CAPTURE_ROWS
  llmResponse?: ConsolidationLLMOutput | string
  coreApiResponse?: { ok: boolean; json?: object }
} = {}) {
  const db = makeMockDb(opts.captureRows ?? SAMPLE_CAPTURE_ROWS)
  const gateway = makeMockGateway(opts.llmResponse ?? SAMPLE_LLM_OUTPUT)
  const pushover = makeMockPushover(false)

  const fetchResponse = opts.coreApiResponse ?? { ok: true, json: { id: 'new-consolidated-cap-id' } }
  // URL-aware fetch mock: autonomy settings call returns partner level; all other calls use coreApiResponse
  const mockFetch = vi.fn().mockImplementation((url: string) => {
    if (url.includes('/api/v1/settings/autonomy_level')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ value: 'partner' }),
        text: vi.fn().mockResolvedValue(''),
      })
    }
    return Promise.resolve({
      ok: fetchResponse.ok,
      status: fetchResponse.ok ? 200 : 500,
      json: vi.fn().mockResolvedValue(fetchResponse.json ?? {}),
      text: vi.fn().mockResolvedValue(''),
    })
  })
  vi.stubGlobal('fetch', mockFetch)

  const skill = new MemoryConsolidationSkill({
    db: db as unknown as import('@open-brain/shared').Database,
    promptsDir: REPO_PROMPTS_DIR,
    coreApiUrl: 'http://localhost:3000',
    pushover,
    llmGateway: gateway,
  })

  return { skill, db, gateway, pushover, mockFetch }
}

/**
 * Builds a MemoryConsolidationSkill with litellmClient (test-compat fallback, no gateway).
 */
function makeSkillWithLitellm(opts: {
  captureRows?: typeof SAMPLE_CAPTURE_ROWS
  llmResponse?: ConsolidationLLMOutput
} = {}) {
  const db = makeMockDb(opts.captureRows ?? SAMPLE_CAPTURE_ROWS)
  const mockLitellm = makeMockOpenAI(opts.llmResponse ?? SAMPLE_LLM_OUTPUT)
  const pushover = makeMockPushover(false)

  // URL-aware fetch mock: autonomy settings call returns partner level; all other calls return litellm cap id
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
    if (url.includes('/api/v1/settings/autonomy_level')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ value: 'partner' }),
        text: vi.fn().mockResolvedValue(''),
      })
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ id: 'new-litellm-cap-id' }),
      text: vi.fn().mockResolvedValue(''),
    })
  }))

  const skill = new MemoryConsolidationSkill({
    db: db as unknown as import('@open-brain/shared').Database,
    promptsDir: REPO_PROMPTS_DIR,
    coreApiUrl: 'http://localhost:3000',
    pushover,
  })

  // @ts-ignore — private field, injected for test compat
  skill.litellmClient = mockLitellm

  return { skill, db, mockLitellm, pushover }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MemoryConsolidationSkill', () => {
  beforeEach(() => {
    _resetBaseSkillAutonomyCacheForTest()
    vi.restoreAllMocks()
    vi.mocked(findConsolidationCandidates).mockResolvedValue({
      clusters: [SAMPLE_CLUSTER],
      totalPairsFound: 3,
      totalClustersFound: 1,
      durationMs: 50,
    })
  })

  // ----------------------------------------------------------
  // Gateway path — happy path (Work Item 8 test case 1)
  // ----------------------------------------------------------

  describe('execute — via LLMGateway', () => {
    it('calls completeByTask with search_synthesis task key when gateway injected', async () => {
      const { skill, gateway } = makeSkillWithGateway()
      await skill.execute()

      const spy = vi.mocked(gateway.completeByTask)
      expect(spy).toHaveBeenCalledOnce()
      expect(spy.mock.calls[0][1]).toBe('search_synthesis')
    })

    it('returns MemoryConsolidationResult with shouldMerge=true and newCaptureId when LLM says merge', async () => {
      const { skill } = makeSkillWithGateway()
      const result = await skill.execute()

      expect(result.totalMerged).toBe(1)
      expect(result.totalSkipped).toBe(0)
      expect(result.totalErrors).toBe(0)
      expect(result.clusterResults).toHaveLength(1)
      expect(result.clusterResults[0].shouldMerge).toBe(true)
      expect(result.clusterResults[0].newCaptureId).toBe('new-consolidated-cap-id')
    })

    it('returns shouldMerge=false and skips merge when LLM says should_merge: false (test case 2)', async () => {
      const noMergeResponse: ConsolidationLLMOutput = {
        should_merge: false,
        merged_content: '',
        merged_tags: [],
        merge_rationale: 'Captures discuss similar topic but are complementary, not duplicates.',
      }
      const { skill } = makeSkillWithGateway({ llmResponse: noMergeResponse })
      const result = await skill.execute()

      expect(result.totalMerged).toBe(0)
      expect(result.totalSkipped).toBe(1)
      expect(result.clusterResults[0].shouldMerge).toBe(false)
      expect(result.clusterResults[0].newCaptureId).toBeNull()
    })

    it('does not call LLM when clusters array is empty (test case 4)', async () => {
      vi.mocked(findConsolidationCandidates).mockResolvedValue(EMPTY_QUERY_RESULT)
      const { skill, gateway } = makeSkillWithGateway()
      const result = await skill.execute()

      expect(vi.mocked(gateway.completeByTask)).not.toHaveBeenCalled()
      expect(result.totalMerged).toBe(0)
      expect(result.clusterResults).toHaveLength(0)
    })

    it('returns should_merge=false safely when LLM returns invalid JSON (test case 3)', async () => {
      const { skill, gateway } = makeSkillWithGateway({ llmResponse: 'This is not JSON at all!' })
      const result = await skill.execute()

      // Should not throw — parseLLMOutput safety valve returns should_merge: false
      expect(result.totalMerged).toBe(0)
      expect(result.totalSkipped).toBe(1)
      expect(result.clusterResults[0].shouldMerge).toBe(false)
      expect(result.clusterResults[0].mergeRationale).toContain('LLM output not valid JSON')
    })

    it('result structure has all required MemoryConsolidationResult fields (test case 5 — structural regression)', async () => {
      const { skill } = makeSkillWithGateway()
      const result = await skill.execute()

      expect(result).toHaveProperty('queryResult')
      expect(result).toHaveProperty('clusterResults')
      expect(result).toHaveProperty('totalMerged')
      expect(result).toHaveProperty('totalSkipped')
      expect(result).toHaveProperty('totalErrors')
      expect(result).toHaveProperty('durationMs')
      expect(result).toHaveProperty('notificationSent')
      expect(result.durationMs).toBeGreaterThanOrEqual(0)
      expect(result.queryResult.totalPairsFound).toBe(3)
    })
  })

  // ----------------------------------------------------------
  // litellmClient fallback path (test-compat)
  // ----------------------------------------------------------

  describe('execute — via litellmClient fallback', () => {
    it('calls litellm when no llmGateway is injected', async () => {
      const { skill, mockLitellm } = makeSkillWithLitellm()
      await skill.execute()

      const spy = mockLitellm.chat.completions.create as ReturnType<typeof vi.fn>
      expect(spy).toHaveBeenCalledOnce()
    })

    it('returns correct merged result via litellm path', async () => {
      const { skill } = makeSkillWithLitellm()
      const result = await skill.execute()

      expect(result.totalMerged).toBe(1)
      expect(result.clusterResults[0].shouldMerge).toBe(true)
    })
  })

  // ----------------------------------------------------------
  // skills_log write
  // ----------------------------------------------------------

  describe('skills_log integration', () => {
    it('writes a skills_log entry after execution', async () => {
      const { skill, db } = makeSkillWithGateway()
      await skill.execute()

      expect(db.insert).toHaveBeenCalled()
    })
  })

  // ----------------------------------------------------------
  // Autonomy gate (P05)
  // ----------------------------------------------------------

  describe('autonomy gate', () => {
    beforeEach(() => {
      _resetBaseSkillAutonomyCacheForTest()
      vi.restoreAllMocks()
      vi.mocked(findConsolidationCandidates).mockResolvedValue(EMPTY_QUERY_RESULT)
    })

    it('gates at observe level (minimum_autonomy = assist)', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({ value: 'observe' }),
      } as unknown as Response)
      const skill = new MemoryConsolidationSkill({
        db: makeMockDb([]) as unknown as import('@open-brain/shared').Database,
        promptsDir: REPO_PROMPTS_DIR,
        coreApiUrl: 'http://localhost:3000',
      })

      const result = await skill.execute()

      expect(result.status).toBe('gated')
      expect(result.durationMs).toBe(0)
    })

    it('runs at assist level (meets minimum_autonomy = assist)', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({ value: 'assist' }),
      } as unknown as Response)
      const skill = new MemoryConsolidationSkill({
        db: makeMockDb([]) as unknown as import('@open-brain/shared').Database,
        promptsDir: REPO_PROMPTS_DIR,
        coreApiUrl: 'http://localhost:3000',
      })

      const result = await skill.execute()

      expect(result.status).toBeUndefined()
    })

    it('runs at partner level (exceeds minimum_autonomy = assist)', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({ value: 'partner' }),
      } as unknown as Response)
      const skill = new MemoryConsolidationSkill({
        db: makeMockDb([]) as unknown as import('@open-brain/shared').Database,
        promptsDir: REPO_PROMPTS_DIR,
        coreApiUrl: 'http://localhost:3000',
      })

      const result = await skill.execute()

      expect(result.status).toBeUndefined()
    })
  })
})
