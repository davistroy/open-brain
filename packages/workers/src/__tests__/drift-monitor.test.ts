import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest'
import { join } from 'node:path'
import { DriftMonitorSkill, parseOutput } from '../skills/drift-monitor.js'
import type { DriftMonitorOutput, DriftMonitorResult, DriftMonitorOptions } from '../skills/drift-monitor.js'
import {
  queryPendingBets,
  queryBetActivity,
  queryEntityFrequency,
  queryGovernanceCommitments,
  formatPendingBets,
  formatGovernanceCommitments,
  formatEntityFrequency,
  fmtDate,
  DEFAULT_BET_ACTIVITY_DAYS,
  DEFAULT_COMMITMENT_DAYS,
  DEFAULT_ENTITY_WINDOW_DAYS,
} from '../skills/drift-monitor-query.js'
import type {
  PendingBet,
  BetWithActivity,
  EntityFrequency,
  GovernanceCommitment,
} from '../skills/drift-monitor-query.js'
import { PushoverService } from '../services/pushover.js'

// Prompt templates live at <repo-root>/config/prompts/
const REPO_PROMPTS_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'config', 'prompts')

// ============================================================
// Fixtures
// ============================================================

const SAMPLE_PENDING_BETS: PendingBet[] = [
  {
    id: 'bet-1',
    statement: 'NovaBurger will adopt centralized ordering by Q2',
    confidence: 75,
    domain: 'client',
    resolution_date: '2026-06-30',
    created_at: '2026-02-15T10:00:00Z',
  },
  {
    id: 'bet-2',
    statement: 'Open Brain will replace all manual note-taking within 3 months',
    confidence: 60,
    domain: 'technical',
    resolution_date: null,
    created_at: '2026-01-10T08:00:00Z',
  },
]

const SAMPLE_BETS_WITH_ACTIVITY: BetWithActivity[] = [
  {
    ...SAMPLE_PENDING_BETS[0],
    recent_capture_count: 0,
    days_since_last_mention: null,
  },
  {
    ...SAMPLE_PENDING_BETS[1],
    recent_capture_count: 3,
    days_since_last_mention: 2,
  },
]

const SAMPLE_ENTITY_FREQUENCY: EntityFrequency[] = [
  {
    entity_id: 'ent-1',
    entity_name: 'SD-WAN',
    entity_type: 'technology',
    current_count: 1,
    previous_count: 5,
    change_pct: -80,
  },
  {
    entity_id: 'ent-2',
    entity_name: 'Stratfield',
    entity_type: 'organization',
    current_count: 0,
    previous_count: 3,
    change_pct: -100,
  },
]

const SAMPLE_GOVERNANCE_COMMITMENTS: GovernanceCommitment[] = [
  {
    session_id: 'sess-001-abcdef',
    session_date: '2026-02-28T15:30:00Z',
    summary: 'Reviewed capacity planning and agreed to weekly check-ins.',
    closing_message: 'Action items: 1. Review Stratfield capacity model weekly. 2. Update client pipeline tracker.',
  },
]

const SAMPLE_DRIFT_OUTPUT: DriftMonitorOutput = {
  summary: 'NovaBurger bet silent 18 days — resolution date approaching with no activity.',
  drift_items: [
    {
      item_type: 'bet',
      item_name: 'NovaBurger will adopt centralized ordering by Q2',
      severity: 'high',
      days_silent: 18,
      reason: 'Zero captures mentioning NovaBurger in the last 18 days.',
      suggested_action: 'Schedule a check-in on NovaBurger project status.',
    },
    {
      item_type: 'commitment',
      item_name: 'Review Stratfield capacity model weekly',
      severity: 'medium',
      days_silent: 12,
      reason: 'No captures tagged capacity or mentioning Stratfield since 2026-02-27.',
      suggested_action: 'Run the Stratfield capacity review now and capture findings.',
    },
    {
      item_type: 'entity',
      item_name: 'SD-WAN',
      severity: 'low',
      days_silent: 8,
      reason: 'SD-WAN mentions dropped from 5/week to 1/week.',
      suggested_action: 'Check if SD-WAN work is complete or just deprioritized.',
    },
  ],
  overall_health: 'significant_drift',
}

// ============================================================
// Mock helpers
// ============================================================

/**
 * Build a mock database that returns specified data for sequential execute() calls.
 * Call order: queryPendingBets, then N queryBetActivity calls, then queryGovernanceCommitments,
 * then queryEntityFrequency.
 */
function makeMockDb(opts: {
  pendingBets?: PendingBet[]
  betActivityRows?: Array<{ recent_count: string; days_since: string | null }>
  commitments?: GovernanceCommitment[]
  entityFrequency?: Array<{
    entity_id: string
    entity_name: string
    entity_type: string
    current_count: string
    previous_count: string
  }>
} = {}) {
  const pendingBets = opts.pendingBets ?? SAMPLE_PENDING_BETS
  const betActivityRow = opts.betActivityRows ?? [
    { recent_count: '0', days_since: null },
    { recent_count: '3', days_since: '2' },
  ]
  const commitments = opts.commitments ?? SAMPLE_GOVERNANCE_COMMITMENTS
  const entityFreq = opts.entityFrequency ?? [
    { entity_id: 'ent-1', entity_name: 'SD-WAN', entity_type: 'technology', current_count: '1', previous_count: '5' },
    { entity_id: 'ent-2', entity_name: 'Stratfield', entity_type: 'organization', current_count: '0', previous_count: '3' },
  ]

  let callCount = 0
  const betCount = pendingBets.length

  return {
    execute: vi.fn().mockImplementation(() => {
      callCount++
      // Call 1: queryPendingBets
      if (callCount === 1) return Promise.resolve({ rows: pendingBets })
      // Calls 2..(1+betCount): queryBetActivity for each bet
      if (callCount <= 1 + betCount) {
        const betIdx = callCount - 2
        return Promise.resolve({ rows: [betActivityRow[betIdx] ?? { recent_count: '0', days_since: null }] })
      }
      // Next call: queryGovernanceCommitments
      if (callCount === 2 + betCount) return Promise.resolve({ rows: commitments })
      // Next call: queryEntityFrequency
      return Promise.resolve({ rows: entityFreq })
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    }),
  }
}

function makeMockOpenAI(jsonOutput: DriftMonitorOutput = SAMPLE_DRIFT_OUTPUT) {
  return {
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [{ message: { content: JSON.stringify(jsonOutput) } }],
          usage: { prompt_tokens: 400, completion_tokens: 200, total_tokens: 600 },
        }),
      },
    },
  }
}

function makePushoverService(configured = true) {
  const svc = new PushoverService('fake-token', 'fake-user')
  if (!configured) {
    Object.defineProperty(svc, 'isConfigured', { get: () => false })
  }
  vi.spyOn(svc, 'send').mockResolvedValue(undefined)
  return svc
}

function makeSkill(opts: {
  pendingBets?: PendingBet[]
  betActivityRows?: Array<{ recent_count: string; days_since: string | null }>
  commitments?: GovernanceCommitment[]
  entityFrequency?: Array<{
    entity_id: string
    entity_name: string
    entity_type: string
    current_count: string
    previous_count: string
  }>
  driftOutput?: DriftMonitorOutput
  pushoverConfigured?: boolean
  promptsDir?: string
  coreApiResponse?: { ok: boolean; json?: object; status?: number }
} = {}) {
  const db = makeMockDb({
    pendingBets: opts.pendingBets,
    betActivityRows: opts.betActivityRows,
    commitments: opts.commitments,
    entityFrequency: opts.entityFrequency,
  })
  const mockLitellm = makeMockOpenAI(opts.driftOutput ?? SAMPLE_DRIFT_OUTPUT)
  const pushover = makePushoverService(opts.pushoverConfigured ?? true)

  const fetchResponse = opts.coreApiResponse ?? { ok: true, json: { id: 'saved-drift-id' } }
  const mockFetch = vi.fn().mockResolvedValue({
    ok: fetchResponse.ok,
    status: fetchResponse.status ?? (fetchResponse.ok ? 200 : 500),
    json: vi.fn().mockResolvedValue(fetchResponse.json ?? {}),
    text: vi.fn().mockResolvedValue(''),
  })

  const skill = new DriftMonitorSkill({
    db: db as unknown as import('@open-brain/shared').Database,
    promptsDir: opts.promptsDir ?? REPO_PROMPTS_DIR,
    coreApiUrl: 'http://localhost:3000',
    pushover,
  })

  // Replace internal litellmClient
  // @ts-ignore — accessing private field for testing
  skill.litellmClient = mockLitellm

  // Replace global fetch
  vi.stubGlobal('fetch', mockFetch)

  return { skill, db, mockLitellm, pushover, mockFetch }
}

// ============================================================
// Tests: parseOutput
// ============================================================

describe('parseOutput', () => {
  it('parses valid JSON into DriftMonitorOutput', () => {
    const raw = JSON.stringify(SAMPLE_DRIFT_OUTPUT)
    const result = parseOutput(raw)
    expect(result.summary).toBe(SAMPLE_DRIFT_OUTPUT.summary)
    expect(result.drift_items).toHaveLength(3)
    expect(result.drift_items[0].item_type).toBe('bet')
    expect(result.drift_items[0].severity).toBe('high')
    expect(result.overall_health).toBe('significant_drift')
  })

  it('strips markdown code fences before parsing', () => {
    const raw = '```json\n' + JSON.stringify(SAMPLE_DRIFT_OUTPUT) + '\n```'
    const result = parseOutput(raw)
    expect(result.summary).toBe(SAMPLE_DRIFT_OUTPUT.summary)
    expect(result.drift_items).toHaveLength(3)
  })

  it('strips code fences without language specifier', () => {
    const raw = '```\n' + JSON.stringify(SAMPLE_DRIFT_OUTPUT) + '\n```'
    const result = parseOutput(raw)
    expect(result.summary).toBe(SAMPLE_DRIFT_OUTPUT.summary)
  })

  it('returns fallback for completely invalid JSON', () => {
    const raw = 'This is not JSON at all, sorry.'
    const result = parseOutput(raw)
    expect(result.summary).toBe('This is not JSON at all, sorry.')
    expect(result.drift_items).toEqual([])
    expect(result.overall_health).toBe('healthy')
  })

  it('truncates raw text to 150 chars for fallback summary', () => {
    const raw = 'A'.repeat(300)
    const result = parseOutput(raw)
    expect(result.summary).toHaveLength(150)
  })

  it('handles missing summary field gracefully', () => {
    const raw = JSON.stringify({ drift_items: [], overall_health: 'healthy' })
    const result = parseOutput(raw)
    expect(result.summary).toBe('(no summary)')
  })

  it('handles missing drift_items array gracefully', () => {
    const raw = JSON.stringify({ summary: 'Test', overall_health: 'healthy' })
    const result = parseOutput(raw)
    expect(result.drift_items).toEqual([])
  })

  it('handles missing overall_health gracefully', () => {
    const raw = JSON.stringify({ summary: 'Test', drift_items: [] })
    const result = parseOutput(raw)
    expect(result.overall_health).toBe('healthy')
  })

  it('provides defaults for malformed drift items', () => {
    const raw = JSON.stringify({
      summary: 'Test',
      drift_items: [
        { item_type: 'bogus', item_name: 42, severity: 'extreme', days_silent: 'many', reason: null, suggested_action: 123 },
      ],
      overall_health: 'healthy',
    })
    const result = parseOutput(raw)
    expect(result.drift_items).toHaveLength(1)
    expect(result.drift_items[0].item_type).toBe('entity') // default for invalid type
    expect(result.drift_items[0].item_name).toBe('(unnamed)')
    expect(result.drift_items[0].severity).toBe('low') // default for invalid severity
    expect(result.drift_items[0].days_silent).toBe(0) // default for non-number
    expect(result.drift_items[0].reason).toBe('')
    expect(result.drift_items[0].suggested_action).toBe('')
  })

  it('handles invalid overall_health by defaulting to healthy', () => {
    const raw = JSON.stringify({ summary: 'Test', drift_items: [], overall_health: 'catastrophic' })
    const result = parseOutput(raw)
    expect(result.overall_health).toBe('healthy')
  })

  it('validates all valid overall_health values', () => {
    for (const health of ['healthy', 'minor_drift', 'significant_drift', 'critical_drift'] as const) {
      const raw = JSON.stringify({ summary: 'T', drift_items: [], overall_health: health })
      expect(parseOutput(raw).overall_health).toBe(health)
    }
  })

  it('validates all valid severity values', () => {
    for (const severity of ['high', 'medium', 'low'] as const) {
      const raw = JSON.stringify({
        summary: 'T',
        drift_items: [{ item_type: 'bet', item_name: 'X', severity, days_silent: 5, reason: 'r', suggested_action: 'a' }],
        overall_health: 'healthy',
      })
      expect(parseOutput(raw).drift_items[0].severity).toBe(severity)
    }
  })

  it('validates all valid item_type values', () => {
    for (const item_type of ['bet', 'commitment', 'entity'] as const) {
      const raw = JSON.stringify({
        summary: 'T',
        drift_items: [{ item_type, item_name: 'X', severity: 'low', days_silent: 1, reason: 'r', suggested_action: 'a' }],
        overall_health: 'healthy',
      })
      expect(parseOutput(raw).drift_items[0].item_type).toBe(item_type)
    }
  })

  it('handles empty string input', () => {
    const result = parseOutput('')
    expect(result.drift_items).toEqual([])
    expect(result.overall_health).toBe('healthy')
  })

  it('skips non-object items in drift_items array', () => {
    const raw = JSON.stringify({
      summary: 'Test',
      drift_items: ['string-item', 42, null, { item_type: 'bet', item_name: 'Real', severity: 'low', days_silent: 1, reason: 'r', suggested_action: 'a' }],
      overall_health: 'healthy',
    })
    const result = parseOutput(raw)
    expect(result.drift_items).toHaveLength(1)
    expect(result.drift_items[0].item_name).toBe('Real')
  })
})

// ============================================================
// Tests: query module — fmtDate
// ============================================================

describe('fmtDate', () => {
  it('formats a Date as YYYY-MM-DD', () => {
    expect(fmtDate(new Date('2026-03-10T14:30:00Z'))).toBe('2026-03-10')
  })

  it('handles year boundaries', () => {
    expect(fmtDate(new Date('2025-12-31T23:59:59Z'))).toBe('2025-12-31')
  })
})

// ============================================================
// Tests: query module — queryPendingBets
// ============================================================

describe('queryPendingBets', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('calls db.execute and returns pending bets', async () => {
    const mockDb = { execute: vi.fn().mockResolvedValue({ rows: SAMPLE_PENDING_BETS }) }
    const result = await queryPendingBets(mockDb as any)
    expect(mockDb.execute).toHaveBeenCalledOnce()
    expect(result).toEqual(SAMPLE_PENDING_BETS)
  })

  it('returns empty array when no pending bets', async () => {
    const mockDb = { execute: vi.fn().mockResolvedValue({ rows: [] }) }
    const result = await queryPendingBets(mockDb as any)
    expect(result).toEqual([])
  })

  it('returns empty array on db error', async () => {
    const mockDb = { execute: vi.fn().mockRejectedValue(new Error('relation does not exist')) }
    const result = await queryPendingBets(mockDb as any)
    expect(result).toEqual([])
  })
})

// ============================================================
// Tests: query module — queryBetActivity
// ============================================================

describe('queryBetActivity', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('returns bet with recent activity data', async () => {
    const mockDb = { execute: vi.fn().mockResolvedValue({ rows: [{ recent_count: '5', days_since: '3' }] }) }
    const result = await queryBetActivity(mockDb as any, SAMPLE_PENDING_BETS[0], 14)
    expect(result.id).toBe('bet-1')
    expect(result.recent_capture_count).toBe(5)
    expect(result.days_since_last_mention).toBe(3)
  })

  it('returns zero activity when no matching captures', async () => {
    const mockDb = { execute: vi.fn().mockResolvedValue({ rows: [{ recent_count: '0', days_since: null }] }) }
    const result = await queryBetActivity(mockDb as any, SAMPLE_PENDING_BETS[0], 14)
    expect(result.recent_capture_count).toBe(0)
    expect(result.days_since_last_mention).toBeNull()
  })

  it('returns zero activity on db error', async () => {
    const mockDb = { execute: vi.fn().mockRejectedValue(new Error('connection failed')) }
    const result = await queryBetActivity(mockDb as any, SAMPLE_PENDING_BETS[0], 14)
    expect(result.recent_capture_count).toBe(0)
    expect(result.days_since_last_mention).toBeNull()
    // Preserves original bet data
    expect(result.statement).toBe(SAMPLE_PENDING_BETS[0].statement)
  })

  it('rounds days_since to nearest integer', async () => {
    const mockDb = { execute: vi.fn().mockResolvedValue({ rows: [{ recent_count: '1', days_since: '4.7' }] }) }
    const result = await queryBetActivity(mockDb as any, SAMPLE_PENDING_BETS[0], 14)
    expect(result.days_since_last_mention).toBe(5) // Math.round(4.7) === 5
  })

  it('handles empty rows array', async () => {
    const mockDb = { execute: vi.fn().mockResolvedValue({ rows: [] }) }
    const result = await queryBetActivity(mockDb as any, SAMPLE_PENDING_BETS[0], 14)
    expect(result.recent_capture_count).toBe(0)
    expect(result.days_since_last_mention).toBeNull()
  })
})

// ============================================================
// Tests: query module — queryEntityFrequency
// ============================================================

describe('queryEntityFrequency', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('returns entities with frequency decline', async () => {
    const mockDb = {
      execute: vi.fn().mockResolvedValue({
        rows: [
          { entity_id: 'e1', entity_name: 'SD-WAN', entity_type: 'technology', current_count: '1', previous_count: '5' },
        ],
      }),
    }
    const result = await queryEntityFrequency(mockDb as any, 7)
    expect(result).toHaveLength(1)
    expect(result[0].entity_name).toBe('SD-WAN')
    expect(result[0].current_count).toBe(1)
    expect(result[0].previous_count).toBe(5)
    expect(result[0].change_pct).toBe(-80)
  })

  it('returns empty array when no declining entities', async () => {
    const mockDb = { execute: vi.fn().mockResolvedValue({ rows: [] }) }
    const result = await queryEntityFrequency(mockDb as any, 7)
    expect(result).toEqual([])
  })

  it('returns empty array on db error', async () => {
    const mockDb = { execute: vi.fn().mockRejectedValue(new Error('relation does not exist')) }
    const result = await queryEntityFrequency(mockDb as any, 7)
    expect(result).toEqual([])
  })

  it('calculates change_pct correctly for complete drop to zero', async () => {
    const mockDb = {
      execute: vi.fn().mockResolvedValue({
        rows: [
          { entity_id: 'e1', entity_name: 'Ghost', entity_type: 'topic', current_count: '0', previous_count: '4' },
        ],
      }),
    }
    const result = await queryEntityFrequency(mockDb as any, 7)
    expect(result[0].change_pct).toBe(-100)
  })
})

// ============================================================
// Tests: query module — queryGovernanceCommitments
// ============================================================

describe('queryGovernanceCommitments', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('returns governance commitments from completed sessions', async () => {
    const mockDb = { execute: vi.fn().mockResolvedValue({ rows: SAMPLE_GOVERNANCE_COMMITMENTS }) }
    const result = await queryGovernanceCommitments(mockDb as any, 30)
    expect(mockDb.execute).toHaveBeenCalledOnce()
    expect(result).toEqual(SAMPLE_GOVERNANCE_COMMITMENTS)
    expect(result[0].session_id).toBe('sess-001-abcdef')
  })

  it('returns empty array when no governance sessions in window', async () => {
    const mockDb = { execute: vi.fn().mockResolvedValue({ rows: [] }) }
    const result = await queryGovernanceCommitments(mockDb as any, 30)
    expect(result).toEqual([])
  })

  it('returns empty array on db error', async () => {
    const mockDb = { execute: vi.fn().mockRejectedValue(new Error('relation does not exist')) }
    const result = await queryGovernanceCommitments(mockDb as any, 30)
    expect(result).toEqual([])
  })
})

// ============================================================
// Tests: query module — formatPendingBets
// ============================================================

describe('formatPendingBets', () => {
  it('formats bets with activity data as plain text', () => {
    const result = formatPendingBets(SAMPLE_BETS_WITH_ACTIVITY)
    expect(result).toContain('NovaBurger will adopt centralized ordering by Q2')
    expect(result).toContain('NO recent captures mentioning this bet')
    expect(result).toContain('confidence: 75')
    expect(result).toContain('resolution date: 2026-06-30')
  })

  it('shows recent capture count when bet has activity', () => {
    const result = formatPendingBets(SAMPLE_BETS_WITH_ACTIVITY)
    expect(result).toContain('3 recent captures, last mention 2 days ago')
  })

  it('returns placeholder for empty bets array', () => {
    const result = formatPendingBets([])
    expect(result).toBe('(no pending bets)')
  })

  it('includes domain in bracket prefix', () => {
    const result = formatPendingBets(SAMPLE_BETS_WITH_ACTIVITY)
    expect(result).toContain('[client]')
    expect(result).toContain('[technical]')
  })

  it('uses "general" for null domain', () => {
    const bet: BetWithActivity = {
      ...SAMPLE_PENDING_BETS[0],
      domain: null,
      recent_capture_count: 0,
      days_since_last_mention: null,
    }
    const result = formatPendingBets([bet])
    expect(result).toContain('[general]')
  })

  it('shows question mark for null days_since_last_mention', () => {
    const bet: BetWithActivity = {
      ...SAMPLE_PENDING_BETS[0],
      recent_capture_count: 2,
      days_since_last_mention: null,
    }
    const result = formatPendingBets([bet])
    expect(result).toContain('last mention ? days ago')
  })
})

// ============================================================
// Tests: query module — formatGovernanceCommitments
// ============================================================

describe('formatGovernanceCommitments', () => {
  it('formats commitments with session info, summary, and closing message', () => {
    const result = formatGovernanceCommitments(SAMPLE_GOVERNANCE_COMMITMENTS)
    expect(result).toContain('Session sess-001')
    expect(result).toContain('2026-02-28')
    expect(result).toContain('Summary: Reviewed capacity planning')
    expect(result).toContain('Closing message: Action items:')
  })

  it('returns placeholder for empty commitments array', () => {
    const result = formatGovernanceCommitments([])
    expect(result).toBe('(no governance sessions in window)')
  })

  it('handles null summary and closing_message', () => {
    const commitment: GovernanceCommitment = {
      session_id: 'sess-002',
      session_date: '2026-03-01T10:00:00Z',
      summary: null,
      closing_message: null,
    }
    const result = formatGovernanceCommitments([commitment])
    expect(result).toContain('Session sess-002')
    expect(result).not.toContain('Summary:')
    expect(result).not.toContain('Closing message:')
  })

  it('truncates long summaries at 300 chars', () => {
    const commitment: GovernanceCommitment = {
      session_id: 'sess-003',
      session_date: '2026-03-01T10:00:00Z',
      summary: 'X'.repeat(500),
      closing_message: null,
    }
    const result = formatGovernanceCommitments([commitment])
    // The formatted line should contain at most 300 chars of the summary
    expect(result).toContain('Summary: ' + 'X'.repeat(300))
    expect(result).not.toContain('X'.repeat(301))
  })

  it('truncates long closing messages at 500 chars', () => {
    const commitment: GovernanceCommitment = {
      session_id: 'sess-004',
      session_date: '2026-03-01T10:00:00Z',
      summary: null,
      closing_message: 'Y'.repeat(700),
    }
    const result = formatGovernanceCommitments([commitment])
    expect(result).toContain('Closing message: ' + 'Y'.repeat(500))
    expect(result).not.toContain('Y'.repeat(501))
  })
})

// ============================================================
// Tests: query module — formatEntityFrequency
// ============================================================

describe('formatEntityFrequency', () => {
  it('formats entities with frequency decline data', () => {
    const result = formatEntityFrequency(SAMPLE_ENTITY_FREQUENCY)
    expect(result).toContain('SD-WAN (technology): 5 mentions (previous window)')
    expect(result).toContain('1 mentions (current window)')
    expect(result).toContain('-80% change')
    expect(result).toContain('Stratfield (organization)')
    expect(result).toContain('-100% change')
  })

  it('returns placeholder for empty entity frequency array', () => {
    const result = formatEntityFrequency([])
    expect(result).toBe('(no significant entity frequency declines detected)')
  })

  it('formats change percentage without decimals', () => {
    const entities: EntityFrequency[] = [
      { entity_id: 'e1', entity_name: 'Test', entity_type: 'topic', current_count: 1, previous_count: 3, change_pct: -66.66666 },
    ]
    const result = formatEntityFrequency(entities)
    expect(result).toContain('-67% change')
  })
})

// ============================================================
// Tests: query module — constants
// ============================================================

describe('constants', () => {
  it('DEFAULT_BET_ACTIVITY_DAYS is 14', () => {
    expect(DEFAULT_BET_ACTIVITY_DAYS).toBe(14)
  })

  it('DEFAULT_COMMITMENT_DAYS is 30', () => {
    expect(DEFAULT_COMMITMENT_DAYS).toBe(30)
  })

  it('DEFAULT_ENTITY_WINDOW_DAYS is 7', () => {
    expect(DEFAULT_ENTITY_WINDOW_DAYS).toBe(7)
  })
})

// ============================================================
// Tests: DriftMonitorSkill — execute happy path
// ============================================================

describe('DriftMonitorSkill', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  describe('execute — happy path', () => {
    it('returns a DriftMonitorResult with drift items and overall health', async () => {
      const { skill } = makeSkill()
      const result = await skill.execute()

      expect(result.output.summary).toBe(SAMPLE_DRIFT_OUTPUT.summary)
      expect(result.output.drift_items).toHaveLength(3)
      expect(result.output.overall_health).toBe('significant_drift')
      expect(result.durationMs).toBeGreaterThan(0)
    })

    it('returns savedCaptureId from Core API response', async () => {
      const { skill } = makeSkill()
      const result = await skill.execute()
      expect(result.savedCaptureId).toBe('saved-drift-id')
    })

    it('sends Pushover notification when severity >= medium items exist', async () => {
      const { skill, pushover } = makeSkill()
      await skill.execute()

      expect(pushover.send).toHaveBeenCalledWith(
        expect.objectContaining({
          title: expect.stringContaining('Drift Monitor'),
          priority: 1, // high priority because there's a high-severity drift item
        }),
      )
      // Verify message contains summary and drift item lines
      const sendCall = (pushover.send as unknown as MockInstance).mock.calls[0][0]
      expect(sendCall.message).toContain(SAMPLE_DRIFT_OUTPUT.summary)
      expect(sendCall.message).toContain('HIGH')
      expect(sendCall.message).toContain('NovaBurger')
    })

    it('uses priority 0 when no high-severity items, only medium', async () => {
      const mediumOnlyOutput: DriftMonitorOutput = {
        summary: 'Some drift detected.',
        drift_items: [
          { item_type: 'commitment', item_name: 'Review capacity', severity: 'medium', days_silent: 10, reason: 'No follow-up', suggested_action: 'Review now' },
        ],
        overall_health: 'minor_drift',
      }
      const { skill, pushover } = makeSkill({ driftOutput: mediumOnlyOutput })
      await skill.execute()

      expect(pushover.send).toHaveBeenCalledWith(
        expect.objectContaining({ priority: 0 }),
      )
    })

    it('saves drift report back to brain via Core API POST', async () => {
      const { skill, mockFetch } = makeSkill()
      await skill.execute()

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3000/api/v1/captures',
        expect.objectContaining({ method: 'POST' }),
      )

      // Verify capture body
      const fetchBody = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(fetchBody.capture_type).toBe('reflection')
      expect(fetchBody.brain_view).toBe('personal')
      expect(fetchBody.tags).toEqual(['drift', 'skill-output'])
      expect(fetchBody.metadata.source_metadata.generator).toBe('drift-monitor-skill')
      expect(fetchBody.metadata.source_metadata.overall_health).toBe('significant_drift')
    })

    it('writes a skills_log entry', async () => {
      const { skill, db } = makeSkill()
      await skill.execute()

      const insertSpy = db.insert as MockInstance
      expect(insertSpy).toHaveBeenCalled()
      const valuesSpy = insertSpy.mock.results[0].value.values as MockInstance
      const logEntry = valuesSpy.mock.calls[0][0]
      expect(logEntry.skill_name).toBe('drift-monitor')
      expect(logEntry.input_summary).toContain('bets')
      expect(logEntry.input_summary).toContain('commitments')
      expect(logEntry.output_summary).toContain('health:')
      expect(logEntry.output_summary).toContain('drift_items:')
      expect(logEntry.result).toBeDefined()
    })

    it('calls LLM with drift_monitor_v1 template variables substituted', async () => {
      const { skill, mockLitellm } = makeSkill()
      await skill.execute()

      const createSpy = mockLitellm.chat.completions.create as MockInstance
      const callArgs = createSpy.mock.calls[0][0]
      const prompt: string = callArgs.messages[0].content

      // Template vars should be substituted
      expect(prompt).not.toContain('{{analysis_date}}')
      expect(prompt).not.toContain('{{pending_bets}}')
      expect(prompt).not.toContain('{{governance_commitments}}')
      expect(prompt).not.toContain('{{entity_frequency}}')

      // Should contain actual bet content
      expect(prompt).toContain('NovaBurger')
    })

    it('respects custom option parameters', async () => {
      const { skill, db } = makeSkill()
      await skill.execute({ betActivityDays: 30, commitmentDays: 60, entityWindowDays: 14 })

      // db.execute called for queries
      expect(db.execute).toHaveBeenCalled()
    })

    it('uses the provided modelAlias in LLM call', async () => {
      const { skill, mockLitellm } = makeSkill()
      await skill.execute({ modelAlias: 'custom-model' })

      const createSpy = mockLitellm.chat.completions.create as MockInstance
      const callArgs = createSpy.mock.calls[0][0]
      expect(callArgs.model).toBe('custom-model')
    })
  })

  // ----------------------------------------------------------
  // No data to analyze
  // ----------------------------------------------------------

  describe('execute — no data to analyze', () => {
    it('returns empty output and skips LLM call when no bets, commitments, or entities', async () => {
      const { skill, mockLitellm } = makeSkill({
        pendingBets: [],
        commitments: [],
        entityFrequency: [],
      })
      const result = await skill.execute()

      expect(result.output.summary).toContain('no drift detected')
      expect(result.output.drift_items).toEqual([])
      expect(result.output.overall_health).toBe('healthy')
      expect(result.savedCaptureId).toBeNull()
      expect(result.notificationSent).toBe(false)
      expect(mockLitellm.chat.completions.create).not.toHaveBeenCalled()
    })

    it('still writes a skills_log entry when no data found', async () => {
      const { skill, db } = makeSkill({
        pendingBets: [],
        commitments: [],
        entityFrequency: [],
      })
      await skill.execute()

      expect(db.insert).toHaveBeenCalled()
      const valuesSpy = (db.insert as MockInstance).mock.results[0].value.values as MockInstance
      const logEntry = valuesSpy.mock.calls[0][0]
      expect(logEntry.output_summary).toContain('Skipped')
    })
  })

  // ----------------------------------------------------------
  // No drift items returned by LLM (all clear)
  // ----------------------------------------------------------

  describe('execute — all clear (no drift items)', () => {
    it('does NOT send Pushover when drift_items is empty', async () => {
      const allClearOutput: DriftMonitorOutput = {
        summary: 'All tracked items are active — no drift detected.',
        drift_items: [],
        overall_health: 'healthy',
      }
      const { skill, pushover } = makeSkill({ driftOutput: allClearOutput })
      await skill.execute()
      expect(pushover.send).not.toHaveBeenCalled()
    })

    it('returns notificationSent: false when no medium/high items', async () => {
      const allClearOutput: DriftMonitorOutput = {
        summary: 'All tracked items are active.',
        drift_items: [],
        overall_health: 'healthy',
      }
      const { skill } = makeSkill({ driftOutput: allClearOutput })
      const result = await skill.execute()
      expect(result.notificationSent).toBe(false)
    })
  })

  // ----------------------------------------------------------
  // Only low-severity drift items (no notification)
  // ----------------------------------------------------------

  describe('execute — only low-severity drift items', () => {
    it('does NOT send Pushover when only low-severity items exist', async () => {
      const lowOnlyOutput: DriftMonitorOutput = {
        summary: 'Minor declines detected.',
        drift_items: [
          { item_type: 'entity', item_name: 'SD-WAN', severity: 'low', days_silent: 5, reason: 'Slight decline', suggested_action: 'Monitor' },
        ],
        overall_health: 'healthy',
      }
      const { skill, pushover } = makeSkill({ driftOutput: lowOnlyOutput })
      await skill.execute()
      expect(pushover.send).not.toHaveBeenCalled()
    })
  })

  // ----------------------------------------------------------
  // Delivery failures (non-fatal)
  // ----------------------------------------------------------

  describe('delivery — non-fatal failures', () => {
    it('continues if Pushover delivery fails', async () => {
      const { skill, pushover } = makeSkill()
      vi.spyOn(pushover, 'send').mockRejectedValue(new Error('Pushover API down'))

      const result = await skill.execute()
      expect(result.output.summary).toBe(SAMPLE_DRIFT_OUTPUT.summary)
      // notificationSent should be false because the catch block returns false
      expect(result.notificationSent).toBe(false)
    })

    it('continues if Core API save-back fails', async () => {
      const { skill } = makeSkill({ coreApiResponse: { ok: false, status: 500 } })

      const result = await skill.execute()
      expect(result.output.summary).toBe(SAMPLE_DRIFT_OUTPUT.summary)
      expect(result.savedCaptureId).toBeNull()
    })

    it('continues if skills_log insert fails', async () => {
      const { skill, db } = makeSkill()
      ;(db.insert as MockInstance).mockReturnValue({
        values: vi.fn().mockRejectedValue(new Error('DB write failed')),
      })

      const result = await skill.execute()
      expect(result.output.drift_items).toHaveLength(3)
    })
  })

  // ----------------------------------------------------------
  // Notification configuration
  // ----------------------------------------------------------

  describe('notification configuration', () => {
    it('skips Pushover if not configured', async () => {
      const { skill, pushover } = makeSkill({ pushoverConfigured: false })
      await skill.execute()
      expect(pushover.send).not.toHaveBeenCalled()
    })
  })

  // ----------------------------------------------------------
  // LLM timeout
  // ----------------------------------------------------------

  describe('execute — LLM timeout', () => {
    it('propagates LLM timeout error', async () => {
      const { skill, mockLitellm } = makeSkill()
      ;(mockLitellm.chat.completions.create as MockInstance).mockRejectedValue(new Error('Request timed out'))

      await expect(skill.execute()).rejects.toThrow('Request timed out')
    })
  })
})

// ============================================================
// Tests: executeDriftMonitor top-level function
// ============================================================

describe('executeDriftMonitor', () => {
  it('is exported and callable (delegates to DriftMonitorSkill)', async () => {
    const { executeDriftMonitor } = await import('../skills/drift-monitor.js')
    expect(typeof executeDriftMonitor).toBe('function')
  })
})

// ============================================================
// Tests: Worker dispatcher — drift-monitor case routing
// ============================================================

describe('skill-execution worker — drift-monitor dispatch', () => {
  it('drift-monitor case imports executeDriftMonitor correctly', async () => {
    const mod = await import('../skills/drift-monitor.js')
    expect(typeof mod.executeDriftMonitor).toBe('function')
    expect(typeof mod.DriftMonitorSkill).toBe('function')
    expect(typeof mod.parseOutput).toBe('function')
  })

  it('skill-execution worker module can be loaded without error', async () => {
    // Verify the dispatcher module imports drift-monitor
    const mod = await import('../jobs/skill-execution.js')
    expect(typeof mod.createSkillExecutionWorker).toBe('function')
  })
})
