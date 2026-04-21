import { describe, it, expect, vi, beforeEach } from 'vitest'
import { BaseSkill, _resetBaseSkillAutonomyCacheForTest } from '../skills/base-skill.js'
import type { BaseResult, BaseSkillOpts } from '../skills/types.js'
import type { AutonomyLevel } from '@open-brain/shared'

// ============================================================
// Test subclasses
// ============================================================

interface GateInput {
  value: string
}

interface GateResult extends BaseResult {
  value: string
}

/** Ungated — no static minimum_autonomy declared */
class UngatedSkill extends BaseSkill<GateInput, GateResult> {
  constructor(opts: BaseSkillOpts) {
    super('ungated-skill', opts)
  }

  protected async run(input: GateInput): Promise<GateResult> {
    return { value: input.value, durationMs: 0 }
  }
}

/** Gated at 'assist' */
class AssistGatedSkill extends BaseSkill<GateInput, GateResult> {
  static minimum_autonomy: AutonomyLevel = 'assist'

  constructor(opts: BaseSkillOpts) {
    super('assist-gated-skill', opts)
  }

  protected async run(input: GateInput): Promise<GateResult> {
    return { value: input.value, durationMs: 0 }
  }
}

/** Gated at 'advise' */
class AdviseGatedSkill extends BaseSkill<GateInput, GateResult> {
  static minimum_autonomy: AutonomyLevel = 'advise'

  constructor(opts: BaseSkillOpts) {
    super('advise-gated-skill', opts)
  }

  protected async run(input: GateInput): Promise<GateResult> {
    return { value: input.value, durationMs: 0 }
  }
}

/** Gated at 'observe' — always allowed */
class ObserveGatedSkill extends BaseSkill<GateInput, GateResult> {
  static minimum_autonomy: AutonomyLevel = 'observe'

  constructor(opts: BaseSkillOpts) {
    super('observe-gated-skill', opts)
  }

  protected async run(input: GateInput): Promise<GateResult> {
    return { value: input.value, durationMs: 0 }
  }
}

// ============================================================
// Mock helpers
// ============================================================

function makeDb() {
  return {
    execute: vi.fn().mockResolvedValue({ rows: [] }),
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 'mock-log-id' }]) }) }),
  }
}

function makeSkillOpts(): BaseSkillOpts {
  return { db: makeDb() as unknown as import('@open-brain/shared').Database }
}

function mockFetchAutonomy(level: string) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    json: vi.fn().mockResolvedValue({ value: level }),
  } as unknown as Response)
}

function mockFetchAutonomyError() {
  return vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('fetch failed'))
}

// ============================================================
// Tests
// ============================================================

describe('BaseSkill autonomy gate', () => {
  beforeEach(() => {
    _resetBaseSkillAutonomyCacheForTest()
    vi.restoreAllMocks()
  })

  it('runs ungated when static minimum_autonomy is absent (no fetch called)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const skill = new UngatedSkill(makeSkillOpts())

    const result = await skill.execute({ value: 'hello' })

    expect(result.value).toBe('hello')
    expect(result.status).toBeUndefined()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('returns gated result when current level < minimum (observe < assist)', async () => {
    mockFetchAutonomy('observe')
    const skill = new AssistGatedSkill(makeSkillOpts())

    const result = await skill.execute({ value: 'test' })

    expect(result.status).toBe('gated')
    expect(result.durationMs).toBe(0)
    expect((result as unknown as Record<string, unknown>).currentAutonomyLevel).toBe('observe')
    expect((result as unknown as Record<string, unknown>).requiredAutonomyLevel).toBe('assist')
    // run() was NOT called — no value
    expect(result.value).toBeUndefined()
  })

  it('runs when current level equals minimum (assist == assist)', async () => {
    mockFetchAutonomy('assist')
    const skill = new AssistGatedSkill(makeSkillOpts())

    const result = await skill.execute({ value: 'equal' })

    expect(result.status).toBeUndefined()
    expect(result.value).toBe('equal')
  })

  it('runs when current level exceeds minimum (advise > assist)', async () => {
    mockFetchAutonomy('advise')
    const skill = new AssistGatedSkill(makeSkillOpts())

    const result = await skill.execute({ value: 'above' })

    expect(result.status).toBeUndefined()
    expect(result.value).toBe('above')
  })

  it('gates correctly for advise minimum (assist < advise)', async () => {
    mockFetchAutonomy('assist')
    const skill = new AdviseGatedSkill(makeSkillOpts())

    const result = await skill.execute({ value: 'should-gate' })

    expect(result.status).toBe('gated')
    expect((result as unknown as Record<string, unknown>).currentAutonomyLevel).toBe('assist')
    expect((result as unknown as Record<string, unknown>).requiredAutonomyLevel).toBe('advise')
  })

  it('never gates when minimum_autonomy = observe (always-safe)', async () => {
    mockFetchAutonomy('observe')
    const skill = new ObserveGatedSkill(makeSkillOpts())

    const result = await skill.execute({ value: 'always-runs' })

    expect(result.status).toBeUndefined()
    expect(result.value).toBe('always-runs')
  })

  it('caches the autonomy level for 5 minutes (fetch called exactly once for two execute calls)', async () => {
    const fetchSpy = mockFetchAutonomy('assist')
    const skill = new AssistGatedSkill(makeSkillOpts())

    // Two execute calls — cache should prevent second fetch
    await skill.execute({ value: 'first' })
    await skill.execute({ value: 'second' })

    expect(fetchSpy.mock.calls.length).toBe(1)
  })

  it('defaults to observe when fetch fails (throw → observe → gates when minimum > observe)', async () => {
    mockFetchAutonomyError()
    const skill = new AssistGatedSkill(makeSkillOpts())

    // fetch throws → defaults to 'observe' → assist > observe → gated
    const result = await skill.execute({ value: 'fail' })

    expect(result.status).toBe('gated')
    expect((result as unknown as Record<string, unknown>).currentAutonomyLevel).toBe('observe')
  })
})
