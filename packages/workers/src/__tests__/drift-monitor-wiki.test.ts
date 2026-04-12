import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest'
import { join } from 'node:path'
import { DriftMonitorSkill, buildDriftMarkdown } from '../skills/drift-monitor.js'
import type { DriftMonitorOutput } from '../skills/drift-monitor.js'
import type { PendingBet, BetWithActivity, GovernanceCommitment } from '../skills/drift-monitor-query.js'
import { PushoverService } from '../services/pushover.js'
import type { WikiGitService } from '@open-brain/shared'

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
  ],
  overall_health: 'significant_drift',
}

// ============================================================
// Mock helpers
// ============================================================

function makeMockDb() {
  let callCount = 0
  return {
    execute: vi.fn().mockImplementation(() => {
      callCount++
      if (callCount === 1) return Promise.resolve({ rows: SAMPLE_PENDING_BETS })
      if (callCount === 2) return Promise.resolve({ rows: [{ recent_count: '0', days_since: null }] })
      if (callCount === 3) return Promise.resolve({ rows: [{ session_id: 'sess-001', session_date: '2026-02-28T15:30:00Z', summary: 'Test', closing_message: 'Action items' }] })
      return Promise.resolve({ rows: [{ entity_id: 'e1', entity_name: 'SD-WAN', entity_type: 'technology', current_count: '1', previous_count: '5' }] })
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

function makeMockWikiService(shouldFail = false): WikiGitService {
  return {
    init: vi.fn().mockResolvedValue(undefined),
    readPage: vi.fn().mockResolvedValue(null),
    listPages: vi.fn().mockResolvedValue([]),
    getRecentChanges: vi.fn().mockResolvedValue([]),
    writePage: shouldFail
      ? vi.fn().mockRejectedValue(new Error('Git push failed'))
      : vi.fn().mockResolvedValue(undefined),
    commitAndPush: vi.fn().mockResolvedValue(undefined),
  } as unknown as WikiGitService
}

function makeSkill(opts: {
  wikiService?: WikiGitService
  driftOutput?: DriftMonitorOutput
} = {}) {
  const db = makeMockDb()
  const mockLitellm = makeMockOpenAI(opts.driftOutput ?? SAMPLE_DRIFT_OUTPUT)
  const pushover = new PushoverService('fake-token', 'fake-user')
  vi.spyOn(pushover, 'send').mockResolvedValue(undefined)

  const mockFetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue({ id: 'saved-drift-id' }),
    text: vi.fn().mockResolvedValue(''),
  })
  vi.stubGlobal('fetch', mockFetch)

  const skill = new DriftMonitorSkill({
    db: db as unknown as import('@open-brain/shared').Database,
    promptsDir: REPO_PROMPTS_DIR,
    coreApiUrl: 'http://localhost:3000',
    pushover,
    wikiService: opts.wikiService,
  })

  // Replace internal litellmClient
  // @ts-ignore — accessing private field for testing
  skill.litellmClient = mockLitellm

  return { skill, db, mockLitellm, pushover, mockFetch }
}

// ============================================================
// Tests: buildDriftMarkdown
// ============================================================

describe('buildDriftMarkdown', () => {
  it('produces a markdown drift report with title and health', () => {
    const md = buildDriftMarkdown(SAMPLE_DRIFT_OUTPUT, '2026-04-10')
    expect(md).toContain('# Drift Report — 2026-04-10')
    expect(md).toContain('**Overall health:** significant drift')
    expect(md).toContain(SAMPLE_DRIFT_OUTPUT.summary)
  })

  it('groups drift items by severity', () => {
    const md = buildDriftMarkdown(SAMPLE_DRIFT_OUTPUT, '2026-04-10')
    expect(md).toContain('### High Severity')
    expect(md).toContain('### Medium Severity')
    expect(md).toContain('**NovaBurger will adopt centralized ordering by Q2** (bet)')
    expect(md).toContain('**Review Stratfield capacity model weekly** (commitment)')
  })

  it('shows "no drift items detected" when empty', () => {
    const emptyOutput: DriftMonitorOutput = {
      summary: 'All clear.',
      drift_items: [],
      overall_health: 'healthy',
    }
    const md = buildDriftMarkdown(emptyOutput, '2026-04-10')
    expect(md).toContain('No drift items detected')
    expect(md).not.toContain('## Drift Items')
  })

  it('includes suggested actions for each drift item', () => {
    const md = buildDriftMarkdown(SAMPLE_DRIFT_OUTPUT, '2026-04-10')
    expect(md).toContain('Suggested action: Schedule a check-in')
    expect(md).toContain('Suggested action: Run the Stratfield capacity review')
  })

  it('includes silent days for each drift item', () => {
    const md = buildDriftMarkdown(SAMPLE_DRIFT_OUTPUT, '2026-04-10')
    expect(md).toContain('Silent: 18 days')
    expect(md).toContain('Silent: 12 days')
  })
})

// ============================================================
// Tests: DriftMonitorSkill — wiki integration
// ============================================================

describe('DriftMonitorSkill — wiki integration', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('writes drift report to wiki when wikiService is provided', async () => {
    const wikiService = makeMockWikiService()
    const { skill } = makeSkill({ wikiService })
    await skill.execute()

    expect(wikiService.writePage).toHaveBeenCalledOnce()
    const callArgs = (wikiService.writePage as unknown as MockInstance).mock.calls[0]
    // pagePath should be operations/drift-reports/YYYY-MM-DD.md
    expect(callArgs[0]).toMatch(/^operations\/drift-reports\/\d{4}-\d{2}-\d{2}\.md$/)
    // content should contain the drift report
    expect(callArgs[1]).toContain('# Drift Report')
    // frontmatter
    expect(callArgs[2].title).toContain('Drift Report')
    expect(callArgs[2].type).toBe('overview')
    expect(callArgs[2].tags).toContain('drift')
    expect(callArgs[2].tags).toContain('operations')
    // commit message
    expect(callArgs[3]).toContain('drift-monitor:')
    expect(callArgs[3]).toContain('significant drift')
  })

  it('skips wiki write when wikiService is not provided', async () => {
    const { skill } = makeSkill({ wikiService: undefined })
    const result = await skill.execute()
    // Should complete successfully without wiki — the result still has output
    expect(result.output.summary).toBe(SAMPLE_DRIFT_OUTPUT.summary)
  })

  it('continues execution when wiki write fails', async () => {
    const wikiService = makeMockWikiService(true) // shouldFail = true
    const { skill } = makeSkill({ wikiService })
    const result = await skill.execute()

    // Wiki failed but execution continued
    expect(wikiService.writePage).toHaveBeenCalledOnce()
    expect(result.output.summary).toBe(SAMPLE_DRIFT_OUTPUT.summary)
    expect(result.savedCaptureId).toBe('saved-drift-id')
  })

  it('does not write wiki when no data to analyze', async () => {
    const wikiService = makeMockWikiService()
    const db = {
      execute: vi.fn()
        .mockResolvedValueOnce({ rows: [] })  // no pending bets
        .mockResolvedValueOnce({ rows: [] })  // no commitments
        .mockResolvedValueOnce({ rows: [] }), // no entity frequency
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockResolvedValue(undefined),
      }),
    }

    const skill = new DriftMonitorSkill({
      db: db as unknown as import('@open-brain/shared').Database,
      promptsDir: REPO_PROMPTS_DIR,
      coreApiUrl: 'http://localhost:3000',
      wikiService,
    })

    await skill.execute()
    expect(wikiService.writePage).not.toHaveBeenCalled()
  })

  it('includes wiki status in skills_log output summary', async () => {
    const wikiService = makeMockWikiService()
    const { skill, db } = makeSkill({ wikiService })
    await skill.execute()

    const insertSpy = db.insert as MockInstance
    expect(insertSpy).toHaveBeenCalled()
    const valuesSpy = insertSpy.mock.results[0].value.values as MockInstance
    const logEntry = valuesSpy.mock.calls[0][0]
    expect(logEntry.output_summary).toContain('wiki: true')
  })

  it('frontmatter includes overall_health and drift_item_count', async () => {
    const wikiService = makeMockWikiService()
    const { skill } = makeSkill({ wikiService })
    await skill.execute()

    const callArgs = (wikiService.writePage as unknown as MockInstance).mock.calls[0]
    const frontmatter = callArgs[2]
    expect(frontmatter.overall_health).toBe('significant_drift')
    expect(frontmatter.drift_item_count).toBe(2)
  })
})
