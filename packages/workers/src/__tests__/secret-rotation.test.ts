import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PushoverService } from '@open-brain/shared'
import { SecretRotationSkill } from '../skills/secret-rotation.js'
import type { BwsSecret } from '../skills/secret-rotation.js'

const mocks = vi.hoisted(() => ({
  recordHeartbeat: vi.fn(),
  raiseAlert: vi.fn(),
}))
vi.mock('../lib/heartbeat.js', () => ({ recordHeartbeat: mocks.recordHeartbeat }))
vi.mock('../lib/alert-state.js', () => ({
  raiseAlert: mocks.raiseAlert,
  legacyPushEnabled: () => true,
}))

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
} = {}) {
  const db = makeMockDb()
  const pushover = makePushover(opts.pushoverConfigured ?? true)
  const execFn = opts.execFn ?? makeMockExec(opts.secrets ?? [])

  const skill = new SecretRotationSkill({
    db: db as unknown as import('@open-brain/shared').Database,
    pushover,
    execFn: execFn as any,
  })

  return { skill, db, pushover, execFn }
}

// ============================================================
// Tests
// ============================================================

describe('SecretRotationSkill', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    mocks.recordHeartbeat.mockReset().mockResolvedValue(null)
    mocks.raiseAlert.mockReset().mockResolvedValue({ action: 'notify', sent: true })
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
      expect(call.message).toContain('(99d)')
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
  // Item 3.6: unavailable check raises, heartbeat, bounded summary
  // ============================================================

  describe('check unavailable (3.6)', () => {
    it('raises secret-check-unavailable once and writes heartbeat ok:false when bws fails', async () => {
      const { skill } = makeSkill({ execFn: makeFailingExec('spawn bws ENOENT') })

      const result = await skill.execute({ now: NOW })

      expect(result.error).toContain('spawn bws ENOENT')
      const bad = mocks.raiseAlert.mock.calls.filter((c) => c[1].bad === true)
      expect(bad).toHaveLength(1)
      expect(bad[0][1]).toMatchObject({ key: 'secret-check-unavailable', severity: 'warning', bad: true })
      expect(mocks.recordHeartbeat).toHaveBeenCalledTimes(1)
      expect(mocks.recordHeartbeat).toHaveBeenCalledWith(
        expect.anything(),
        'secret-rotation',
        expect.objectContaining({ ok: false, errors: [expect.stringContaining('spawn bws ENOENT')] }),
      )
    })

    it('writes heartbeat ok:true with meta.totalSecrets and clears the alert on success', async () => {
      const { skill } = makeSkill({ secrets: [FRESH_SECRET, STALE_SECRET] })

      const result = await skill.execute({ now: NOW })

      expect(result.totalSecrets).toBeGreaterThan(0)
      expect(mocks.recordHeartbeat).toHaveBeenCalledWith(
        expect.anything(),
        'secret-rotation',
        expect.objectContaining({ ok: true, meta: expect.objectContaining({ totalSecrets: 2 }) }),
      )
      expect(mocks.raiseAlert).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ key: 'secret-check-unavailable', bad: false }),
      )
    })

    it('keeps a bounded summary under 300 characters with 40 stale secrets', async () => {
      const many: BwsSecret[] = Array.from({ length: 40 }, (_, i) => ({
        id: `id-${i}`,
        key: `dev/open-brain/some-rather-long-secret-name-number-${i}`,
        revisionDate: `2025-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z`,
        creationDate: '2024-01-01T00:00:00Z',
      }))
      const { skill, pushover } = makeSkill({ secrets: many })

      const result = await skill.execute({ now: NOW })

      expect(result.staleSecrets).toHaveLength(40)
      const msg = (pushover.send as ReturnType<typeof vi.fn>).mock.calls[0][0].message as string
      expect(msg.length).toBeLessThan(300)
      expect(msg).toContain('40')
      // 5 oldest only
      expect(msg).toContain('number-0')
      expect(msg).not.toContain('number-39')
    })

    it('reads no operator-action register and sends no operator-action push', async () => {
      const { skill, pushover } = makeSkill({ secrets: [FRESH_SECRET] })

      const result = await skill.execute({ now: NOW })

      expect(result).not.toHaveProperty('operatorActions')
      expect(pushover.send).not.toHaveBeenCalled()
    })
  })
})
