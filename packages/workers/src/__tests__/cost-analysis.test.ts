import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PushoverService } from '@open-brain/shared'
import { CostAnalysisSkill } from '../skills/cost-analysis.js'

// ============================================================
// Mock helpers
// ============================================================

const SAMPLE_SPEND_ROWS = [
  { model: 'gpt-5.4', task_type: 'synthesis', call_count: '15', total_tokens: '50000', cost_usd: '1.500000' },
  { model: 'gpt-5.4', task_type: 'classify', call_count: '30', total_tokens: '10000', cost_usd: '0.300000' },
  { model: 'text-embedding-3-large', task_type: 'embed', call_count: '50', total_tokens: '80000', cost_usd: '0.100000' },
]

function makeMockDb(spendRows = SAMPLE_SPEND_ROWS) {
  return {
    execute: vi.fn().mockResolvedValue({ rows: spendRows }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 'mock-log-id' }]) }),
    }),
  }
}

function makePushover(configured = true) {
  const svc = new PushoverService('fake-token', 'fake-user')
  if (!configured) {
    Object.defineProperty(svc, 'isConfigured', { get: () => false })
  }
  vi.spyOn(svc, 'send').mockResolvedValue(undefined)
  return svc
}

function makeSkill(opts: {
  spendRows?: typeof SAMPLE_SPEND_ROWS
  pushoverConfigured?: boolean
} = {}) {
  const db = makeMockDb(opts.spendRows ?? SAMPLE_SPEND_ROWS)
  const pushover = makePushover(opts.pushoverConfigured ?? true)

  const skill = new CostAnalysisSkill({
    db: db as unknown as import('@open-brain/shared').Database,
    pushover,
    // No wiki service — tests don't need it; report write will fall back to local file (which may fail, that's fine)
  })

  return { skill, db, pushover }
}

// ============================================================
// Tests
// ============================================================

describe('CostAnalysisSkill', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  describe('daily report', () => {
    it('returns daily summary with correct aggregation', async () => {
      const { skill } = makeSkill()
      // Use a Wednesday to avoid weekly/monthly logic
      const wednesday = new Date('2026-04-08T07:00:00Z') // Wednesday

      const result = await skill.execute({ now: wednesday })

      expect(result.type).toBe('daily')
      expect(result.summary.totalCost).toBeCloseTo(1.9, 1)
      expect(result.summary.totalCalls).toBe(95)
      expect(result.summary.totalTokens).toBe(140000)
      expect(result.summary.byModel).toHaveLength(3)
    })

    it('does not send alert when spend is below threshold', async () => {
      const { skill, pushover } = makeSkill()
      const wednesday = new Date('2026-04-08T07:00:00Z')

      const result = await skill.execute({ now: wednesday, dailyAlertThreshold: 5.00 })

      expect(result.alertSent).toBe(false)
      expect(pushover.send).not.toHaveBeenCalled()
    })

    it('sends alert when daily spend exceeds threshold', async () => {
      const { skill, pushover } = makeSkill()
      const wednesday = new Date('2026-04-08T07:00:00Z')

      const result = await skill.execute({ now: wednesday, dailyAlertThreshold: 1.00 })

      expect(result.alertSent).toBe(true)
      expect(pushover.send).toHaveBeenCalledTimes(1)
      expect(pushover.send).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Open Brain: Daily AI Spend Alert',
        }),
      )
    })

    it('does not send alert when Pushover is not configured', async () => {
      const { skill, pushover } = makeSkill({ pushoverConfigured: false })
      const wednesday = new Date('2026-04-08T07:00:00Z')

      const result = await skill.execute({ now: wednesday, dailyAlertThreshold: 0.01 })

      expect(result.alertSent).toBe(false)
      expect(pushover.send).not.toHaveBeenCalled()
    })
  })

  describe('weekly report (Monday)', () => {
    it('includes weekly summary on Mondays', async () => {
      const { skill, db } = makeSkill()
      const monday = new Date('2026-04-13T07:00:00Z') // Monday

      const result = await skill.execute({ now: monday })

      expect(result.type).toBe('weekly')
      expect(result.weeklySummary).toBeDefined()
      // DB execute called multiple times: daily query + weekly query + skills_log insert
      expect(db.execute).toHaveBeenCalledTimes(2) // daily + weekly
    })

    it('does not include weekly summary on non-Mondays', async () => {
      const { skill } = makeSkill()
      const tuesday = new Date('2026-04-14T07:00:00Z') // Tuesday

      const result = await skill.execute({ now: tuesday })

      expect(result.weeklySummary).toBeUndefined()
    })
  })

  describe('monthly report (1st of month)', () => {
    it('includes monthly summary on 1st of month', async () => {
      const { skill, db } = makeSkill()
      const firstOfMonth = new Date('2026-05-01T07:00:00Z') // 1st, Thursday

      const result = await skill.execute({ now: firstOfMonth })

      expect(result.type).toBe('monthly')
      expect(result.monthlySummary).toBeDefined()
      // daily + monthly = 2 execute calls
      expect(db.execute).toHaveBeenCalledTimes(2)
    })
  })

  describe('empty spend data', () => {
    it('handles zero spend gracefully', async () => {
      const { skill } = makeSkill({ spendRows: [] })
      const wednesday = new Date('2026-04-08T07:00:00Z')

      const result = await skill.execute({ now: wednesday })

      expect(result.summary.totalCost).toBe(0)
      expect(result.summary.totalCalls).toBe(0)
      expect(result.summary.byModel).toHaveLength(0)
      expect(result.alertSent).toBe(false)
    })
  })

  describe('skills_log', () => {
    it('writes to skills_log on completion', async () => {
      const { skill, db } = makeSkill()
      const wednesday = new Date('2026-04-08T07:00:00Z')

      await skill.execute({ now: wednesday })

      expect(db.insert).toHaveBeenCalled()
    })
  })

  describe('DB error resilience', () => {
    it('returns empty summary when ai_audit_log query fails', async () => {
      const db = {
        execute: vi.fn().mockRejectedValue(new Error('DB connection failed')),
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 'mock-log-id' }]) }),
        }),
      }
      const skill = new CostAnalysisSkill({
        db: db as unknown as import('@open-brain/shared').Database,
      })

      const result = await skill.execute({ now: new Date('2026-04-08T07:00:00Z') })

      expect(result.summary.totalCost).toBe(0)
      expect(result.summary.byModel).toHaveLength(0)
    })
  })
})
