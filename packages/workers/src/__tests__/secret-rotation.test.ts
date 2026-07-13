import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PushoverService } from '@open-brain/shared'
import { SecretRotationSkill, parseOperatorActions } from '../skills/secret-rotation.js'
import type { BwsSecret } from '../skills/secret-rotation.js'

// ============================================================
// Mock helpers
// ============================================================

/** Reference "now" for deterministic age calculations. */
const NOW = new Date('2026-04-01T10:00:00Z')

/** A secret last rotated 30 days ago — fresh. */
const FRESH_SECRET: BwsSecret = {
  id: 'secret-1',
  key: 'open-brain-openai-api-key',
  revisionDate: '2026-03-02T10:00:00Z',
  creationDate: '2025-01-01T00:00:00Z',
}

/** A secret last rotated 100 days ago — stale at default 90-day threshold. */
const STALE_SECRET: BwsSecret = {
  id: 'secret-2',
  key: 'dev/open-brain/slack-bot-token',
  revisionDate: '2025-12-23T10:00:00Z',
  creationDate: '2025-01-01T00:00:00Z',
}

/** A secret last rotated exactly 90 days ago — NOT stale (boundary: > not >=). */
const BOUNDARY_SECRET: BwsSecret = {
  id: 'secret-3',
  key: 'dev/open-brain/pushover-token',
  revisionDate: '2026-01-01T10:00:00Z',
  creationDate: '2025-01-01T00:00:00Z',
}

/** A secret last rotated 91 days ago — stale. */
const JUST_STALE_SECRET: BwsSecret = {
  id: 'secret-4',
  key: 'dev/open-brain/webhook-secret',
  revisionDate: '2025-12-31T10:00:00Z',
  creationDate: '2025-01-01T00:00:00Z',
}

/**
 * Creates a mock execFn that returns the given secrets as bws CLI output.
 */
function makeMockExec(secrets: BwsSecret[]) {
  return vi.fn().mockResolvedValue({
    stdout: JSON.stringify(secrets),
    stderr: '',
  })
}

/**
 * Creates a mock execFn that throws (simulates bws CLI failure).
 */
function makeFailingExec(errorMsg = 'bws: command not found') {
  return vi.fn().mockRejectedValue(new Error(errorMsg))
}

function makeMockDb() {
  return {
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
  secrets?: BwsSecret[]
  execFn?: ReturnType<typeof vi.fn>
  pushoverConfigured?: boolean
  readFileFn?: ReturnType<typeof vi.fn>
} = {}) {
  const db = makeMockDb()
  const pushover = makePushover(opts.pushoverConfigured ?? true)
  const execFn = opts.execFn ?? makeMockExec(opts.secrets ?? [])
  // Default: OPERATOR_ACTIONS.md absent (ENOENT) so the RC-19 check skips
  // deterministically and never depends on the ambient filesystem.
  const readFileFn = opts.readFileFn ?? vi.fn().mockRejectedValue(new Error('ENOENT: no such file'))

  const skill = new SecretRotationSkill({
    db: db as unknown as import('@open-brain/shared').Database,
    pushover,
    execFn: execFn as any,
    readFileFn: readFileFn as any,
  })

  return { skill, db, pushover, execFn, readFileFn }
}

/** Build an OPERATOR_ACTIONS.md fixture with the given Open-Actions rows. */
function makeRegister(rows: Array<{ id: string; action: string; due: string; status: string }>): string {
  const body = rows
    .map((r) => `| ${r.id} | ${r.action} | ${r.due} | Troy | Plan | ${r.status} |`)
    .join('\n')
  return `# Operator Actions — Dated Register

## Open Actions

| ID | Action | Due | Owner | Source | Status |
|----|--------|-----|-------|--------|--------|
${body}

## Completed Actions

| ID | Action | Completed | Source |
|----|--------|-----------|--------|
| OA-DONE | already done thing | 2020-01-01 | Plan |
`
}

// ============================================================
// Tests
// ============================================================

describe('SecretRotationSkill', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  describe('age calculation', () => {
    it('calculates correct age for a fresh secret', () => {
      const { skill } = makeSkill()
      const result = skill.calculateAge(FRESH_SECRET, NOW, 90)

      expect(result.ageDays).toBe(30)
      expect(result.stale).toBe(false)
      expect(result.key).toBe('open-brain-openai-api-key')
    })

    it('calculates correct age for a stale secret', () => {
      const { skill } = makeSkill()
      const result = skill.calculateAge(STALE_SECRET, NOW, 90)

      // Dec 23 to Apr 1 = 99 days
      expect(result.ageDays).toBe(99)
      expect(result.stale).toBe(true)
    })

    it('treats exactly 90 days as NOT stale (threshold is >90, not >=90)', () => {
      const { skill } = makeSkill()
      const result = skill.calculateAge(BOUNDARY_SECRET, NOW, 90)

      expect(result.ageDays).toBe(90)
      expect(result.stale).toBe(false)
    })

    it('treats 91 days as stale', () => {
      const { skill } = makeSkill()
      const result = skill.calculateAge(JUST_STALE_SECRET, NOW, 90)

      expect(result.ageDays).toBe(91)
      expect(result.stale).toBe(true)
    })

    it('respects custom maxAgeDays threshold', () => {
      const { skill } = makeSkill()
      // 30-day secret should be stale at a 20-day threshold
      const result = skill.calculateAge(FRESH_SECRET, NOW, 20)

      expect(result.ageDays).toBe(30)
      expect(result.stale).toBe(true)
    })
  })

  describe('all secrets fresh', () => {
    it('returns no stale secrets when all are within threshold', async () => {
      const { skill } = makeSkill({ secrets: [FRESH_SECRET, BOUNDARY_SECRET] })

      const result = await skill.execute({ maxAgeDays: 90, now: NOW })

      expect(result.totalSecrets).toBe(2)
      expect(result.staleSecrets).toHaveLength(0)
      expect(result.freshSecrets).toBe(2)
      expect(result.alertSent).toBe(false)
    })

    it('does not send Pushover when no secrets are stale', async () => {
      const { skill, pushover } = makeSkill({ secrets: [FRESH_SECRET] })

      await skill.execute({ now: NOW })

      expect(pushover.send).not.toHaveBeenCalled()
    })
  })

  describe('stale secrets detected', () => {
    it('identifies stale secrets and sends alert', async () => {
      const { skill, pushover } = makeSkill({
        secrets: [FRESH_SECRET, STALE_SECRET, JUST_STALE_SECRET],
      })

      const result = await skill.execute({ maxAgeDays: 90, now: NOW })

      expect(result.totalSecrets).toBe(3)
      expect(result.staleSecrets).toHaveLength(2)
      expect(result.freshSecrets).toBe(1)
      expect(result.alertSent).toBe(true)

      // Verify stale secret keys
      const staleKeys = result.staleSecrets.map((s) => s.key)
      expect(staleKeys).toContain('dev/open-brain/slack-bot-token')
      expect(staleKeys).toContain('dev/open-brain/webhook-secret')

      // Verify Pushover was called with rotation reminder
      expect(pushover.send).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Open Brain: Secret Rotation Reminder',
          priority: 0,
        }),
      )
    })

    it('does not send alert when Pushover is not configured', async () => {
      const { skill, pushover } = makeSkill({
        secrets: [STALE_SECRET],
        pushoverConfigured: false,
      })

      const result = await skill.execute({ maxAgeDays: 90, now: NOW })

      expect(result.staleSecrets).toHaveLength(1)
      expect(result.alertSent).toBe(false)
      expect(pushover.send).not.toHaveBeenCalled()
    })

    it('alert message includes secret key names and ages but no values', async () => {
      const { skill, pushover } = makeSkill({
        secrets: [STALE_SECRET],
      })

      await skill.execute({ maxAgeDays: 90, now: NOW })

      const call = (pushover.send as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(call.message).toContain('dev/open-brain/slack-bot-token')
      expect(call.message).toContain('days')
      expect(call.message).toContain('Rotate these keys')
      // Should NOT contain any secret values
      expect(call.message).not.toContain('sk-')
      expect(call.message).not.toContain('xoxb-')
    })
  })

  describe('bws CLI failure', () => {
    it('returns error result when bws command fails', async () => {
      const execFn = makeFailingExec('bws: command not found')
      const { skill } = makeSkill({ execFn })

      const result = await skill.execute()

      expect(result.totalSecrets).toBe(0)
      expect(result.staleSecrets).toHaveLength(0)
      expect(result.alertSent).toBe(false)
      expect(result.error).toContain('bws: command not found')
    })

    it('returns error result when bws returns invalid JSON', async () => {
      const execFn = vi.fn().mockResolvedValue({ stdout: 'not json', stderr: '' })
      const { skill } = makeSkill({ execFn })

      const result = await skill.execute()

      expect(result.totalSecrets).toBe(0)
      expect(result.error).toBeDefined()
    })

    it('returns error result when bws returns non-array JSON', async () => {
      const execFn = vi.fn().mockResolvedValue({ stdout: '{"error": "unauthorized"}', stderr: '' })
      const { skill } = makeSkill({ execFn })

      const result = await skill.execute()

      expect(result.totalSecrets).toBe(0)
      expect(result.error).toContain('did not return an array')
    })

    it('writes error to skills_log on CLI failure', async () => {
      const execFn = makeFailingExec('connection refused')
      const { skill, db } = makeSkill({ execFn })

      await skill.execute()

      expect(db.insert).toHaveBeenCalledTimes(1)
    })
  })

  describe('empty secret list', () => {
    it('handles zero secrets gracefully', async () => {
      const { skill } = makeSkill({ secrets: [] })

      const result = await skill.execute()

      expect(result.totalSecrets).toBe(0)
      expect(result.staleSecrets).toHaveLength(0)
      expect(result.freshSecrets).toBe(0)
      expect(result.alertSent).toBe(false)
      expect(result.error).toBeUndefined()
    })
  })

  describe('bws CLI invocation', () => {
    it('calls bws with correct arguments', async () => {
      const execFn = makeMockExec([])
      const { skill } = makeSkill({ execFn })

      await skill.execute({ bwsBinary: '/usr/local/bin/bws' })

      expect(execFn).toHaveBeenCalledWith(
        '/usr/local/bin/bws',
        ['secret', 'list'],
        expect.objectContaining({ timeout: 30_000 }),
      )
    })

    it('uses BWS_PATH env var as default binary path', async () => {
      const execFn = makeMockExec([])
      const { skill } = makeSkill({ execFn })

      const originalBwsPath = process.env.BWS_PATH
      process.env.BWS_PATH = '/custom/path/bws'
      try {
        await skill.execute()
        expect(execFn).toHaveBeenCalledWith(
          '/custom/path/bws',
          ['secret', 'list'],
          expect.anything(),
        )
      } finally {
        if (originalBwsPath !== undefined) {
          process.env.BWS_PATH = originalBwsPath
        } else {
          delete process.env.BWS_PATH
        }
      }
    })
  })

  describe('skills_log', () => {
    it('writes summary to skills_log on success', async () => {
      const { skill, db } = makeSkill({ secrets: [FRESH_SECRET, STALE_SECRET] })

      await skill.execute({ maxAgeDays: 90, now: NOW })

      expect(db.insert).toHaveBeenCalledTimes(1)
    })

    it('writes summary to skills_log on failure', async () => {
      const execFn = makeFailingExec()
      const { skill, db } = makeSkill({ execFn })

      await skill.execute()

      expect(db.insert).toHaveBeenCalledTimes(1)
    })
  })

  describe('custom threshold', () => {
    it('uses custom maxAgeDays', async () => {
      // FRESH_SECRET is 30 days old. With a 20-day threshold it should be stale.
      const { skill } = makeSkill({ secrets: [FRESH_SECRET] })

      const result = await skill.execute({ maxAgeDays: 20 })

      expect(result.staleSecrets).toHaveLength(1)
      expect(result.staleSecrets[0].key).toBe('open-brain-openai-api-key')
    })
  })

  // ============================================================
  // RC-19: operator-action reminders
  // ============================================================

  describe('operator actions (RC-19)', () => {
    it('flags an overdue action and sends a priority-1 Pushover', async () => {
      const readFileFn = vi.fn().mockResolvedValue(
        makeRegister([{ id: 'OA-1', action: 'Deploy migration 0036', due: '2026-03-01', status: 'OPEN' }]),
      )
      const { skill, pushover } = makeSkill({ secrets: [FRESH_SECRET], readFileFn })

      const result = await skill.execute({ now: NOW }) // NOW = 2026-04-01, so 2026-03-01 is overdue

      expect(result.operatorActions.checked).toBe(true)
      expect(result.operatorActions.overdue.map((a) => a.id)).toEqual(['OA-1'])
      expect(result.operatorActions.alertSent).toBe(true)
      expect(pushover.send).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Open Brain: Operator Actions Due', priority: 1 }),
      )
      const call = (pushover.send as ReturnType<typeof vi.fn>).mock.calls.find(
        (c) => c[0].title === 'Open Brain: Operator Actions Due',
      )!
      expect(call[0].message).toContain('OVERDUE')
      expect(call[0].message).toContain('OA-1')
    })

    it('flags an approaching (within 7 days) action at priority 0', async () => {
      const readFileFn = vi.fn().mockResolvedValue(
        makeRegister([{ id: 'OA-2', action: 'Flip repo private', due: '2026-04-05', status: 'OPEN' }]),
      )
      const { skill, pushover } = makeSkill({ secrets: [], readFileFn })

      const result = await skill.execute({ now: NOW, approachingDays: 7 }) // 2026-04-05 is 4 days out

      expect(result.operatorActions.approaching.map((a) => a.id)).toEqual(['OA-2'])
      expect(result.operatorActions.overdue).toHaveLength(0)
      expect(pushover.send).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Open Brain: Operator Actions Due', priority: 0 }),
      )
    })

    it('does not flag a far-future action', async () => {
      const readFileFn = vi.fn().mockResolvedValue(
        makeRegister([{ id: 'OA-3', action: 'Quarterly review', due: '2026-09-30', status: 'OPEN' }]),
      )
      const { skill, pushover } = makeSkill({ secrets: [], readFileFn })

      const result = await skill.execute({ now: NOW })

      expect(result.operatorActions.overdue).toHaveLength(0)
      expect(result.operatorActions.approaching).toHaveLength(0)
      expect(result.operatorActions.alertSent).toBe(false)
      expect(pushover.send).not.toHaveBeenCalled()
    })

    it('skips DONE and BLOCKED rows even if their Due is overdue', async () => {
      const readFileFn = vi.fn().mockResolvedValue(
        makeRegister([
          { id: 'OA-4', action: 'done thing', due: '2026-01-01', status: 'DONE 2026-01-02' },
          { id: 'OA-5', action: 'blocked thing', due: '2026-01-01', status: 'BLOCKED (waiting on vendor)' },
        ]),
      )
      const { skill, pushover } = makeSkill({ secrets: [], readFileFn })

      const result = await skill.execute({ now: NOW })

      expect(result.operatorActions.overdue).toHaveLength(0)
      expect(pushover.send).not.toHaveBeenCalled()
    })

    it('never flags an undated ("next restart window") Due', async () => {
      const readFileFn = vi.fn().mockResolvedValue(
        makeRegister([{ id: 'OA-6', action: 'add shm_size', due: 'next restart window', status: 'OPEN' }]),
      )
      const { skill } = makeSkill({ secrets: [], readFileFn })

      const result = await skill.execute({ now: NOW })

      expect(result.operatorActions.overdue).toHaveLength(0)
      expect(result.operatorActions.approaching).toHaveLength(0)
    })

    it('completes gracefully when OPERATOR_ACTIONS.md is absent', async () => {
      const readFileFn = vi.fn().mockRejectedValue(new Error('ENOENT: no such file'))
      const { skill, pushover } = makeSkill({ secrets: [FRESH_SECRET], readFileFn })

      const result = await skill.execute({ now: NOW })

      expect(result.operatorActions.checked).toBe(false)
      expect(result.operatorActions.alertSent).toBe(false)
      expect(result.totalSecrets).toBe(1) // secret check still ran
      expect(result.error).toBeUndefined()
      expect(pushover.send).not.toHaveBeenCalled()
    })

    it('checks operator actions even when the bws query fails', async () => {
      const readFileFn = vi.fn().mockResolvedValue(
        makeRegister([{ id: 'OA-7', action: 'overdue thing', due: '2026-03-01', status: 'OPEN' }]),
      )
      const execFn = makeFailingExec('bws: command not found')
      const { skill, pushover } = makeSkill({ execFn, readFileFn })

      const result = await skill.execute({ now: NOW })

      expect(result.error).toContain('bws: command not found')
      expect(result.operatorActions.overdue.map((a) => a.id)).toEqual(['OA-7'])
      expect(pushover.send).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Open Brain: Operator Actions Due' }),
      )
    })

    describe('parseOperatorActions', () => {
      it('parses Open-Actions rows and ignores the Completed table', () => {
        const md = makeRegister([
          { id: 'OA-1', action: 'first', due: '2026-05-01', status: 'OPEN' },
          { id: 'OA-2', action: 'second', due: '2026-06-01', status: 'IN PROGRESS' },
        ])
        const rows = parseOperatorActions(md)

        expect(rows.map((r) => r.id)).toEqual(['OA-1', 'OA-2'])
        expect(rows[0].dueDate?.toISOString()).toBe('2026-05-01T00:00:00.000Z')
        expect(rows.every((r) => r.owner === 'Troy')).toBe(true)
      })

      it('returns [] when there is no Open Actions section', () => {
        expect(parseOperatorActions('# Nothing here\n\nsome prose')).toEqual([])
      })

      it('sets dueDate null for non-date Due cells', () => {
        const md = makeRegister([{ id: 'OA-X', action: 'x', due: 'next restart window', status: 'OPEN' }])
        expect(parseOperatorActions(md)[0].dueDate).toBeNull()
      })
    })
  })
})
