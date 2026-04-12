import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PushoverService } from '@open-brain/shared'

// ============================================================
// Mocks — declared before any imports that use them
// ============================================================

const mockExecFile = vi.fn((_cmd: string, _args: string[], _opts: any, cb: Function) => {
  if (cb) cb(null, String(Math.floor(Date.now() / 1000)), '')
})

vi.mock('node:child_process', () => ({
  execFile: (...args: any[]) => mockExecFile(...(args as [any, any, any, any])),
}))

const mockStat = vi.fn().mockResolvedValue({ size: 256 * 1024 })
const mockReaddir = vi.fn().mockResolvedValue([] as string[])
const mockUnlink = vi.fn().mockResolvedValue(undefined)
const mockMkdir = vi.fn().mockResolvedValue(undefined)
const mockCopyFile = vi.fn().mockResolvedValue(undefined)

vi.mock('node:fs/promises', () => ({
  stat: (...args: any[]) => mockStat(...args),
  readdir: (...args: any[]) => mockReaddir(...args),
  unlink: (...args: any[]) => mockUnlink(...args),
  mkdir: (...args: any[]) => mockMkdir(...args),
  copyFile: (...args: any[]) => mockCopyFile(...args),
}))

// ============================================================
// Imports (after mocks)
// ============================================================

import { RedisSnapshotSkill, applyRetention } from '../skills/redis-snapshot.js'

// ============================================================
// Helpers
// ============================================================

function makeMockDb() {
  return {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    }),
    execute: vi.fn().mockResolvedValue({ rows: [] }),
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

function makeSkill(opts: { pushoverConfigured?: boolean } = {}) {
  const db = makeMockDb()
  const pushover = makePushover(opts.pushoverConfigured ?? true)

  const skill = new RedisSnapshotSkill({
    db: db as unknown as import('@open-brain/shared').Database,
    pushover,
    backupDir: '/tmp/test-backups/redis',
    containerName: 'test-redis',
    rdbPathInContainer: '/data/dump.rdb',
  })

  return { skill, db, pushover }
}

// ============================================================
// Tests
// ============================================================

describe('RedisSnapshotSkill', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockStat.mockResolvedValue({ size: 256 * 1024 })
    mockReaddir.mockResolvedValue([])
    mockUnlink.mockResolvedValue(undefined)
    mockMkdir.mockResolvedValue(undefined)
    mockCopyFile.mockResolvedValue(undefined)
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      if (cb) cb(null, String(Math.floor(Date.now() / 1000)), '')
    })
  })

  describe('execute — success path', () => {
    it('returns status success with file info', async () => {
      const { skill } = makeSkill()
      const result = await skill.execute()

      expect(result.status).toBe('success')
      expect(result.filePath).toMatch(/test-backups[/\\]redis[/\\]/)
      expect(result.filePath).toContain('.rdb')
      expect(result.sizeBytes).toBe(256 * 1024)
      expect(result.durationSeconds).toBeGreaterThanOrEqual(0)
    })

    it('logs to backup_log and skills_log', async () => {
      const { skill, db } = makeSkill()
      await skill.execute()

      expect(db.insert).toHaveBeenCalledTimes(2)
    })

    it('sends success Pushover notification', async () => {
      const { skill, pushover } = makeSkill()
      await skill.execute()

      expect(pushover.send).toHaveBeenCalledWith(
        expect.objectContaining({
          title: expect.stringContaining('Redis Snapshot Complete'),
          priority: -1,
        }),
      )
    })

    it('does not send Pushover when not configured', async () => {
      const { skill, pushover } = makeSkill({ pushoverConfigured: false })
      await skill.execute()

      expect(pushover.send).not.toHaveBeenCalled()
    })
  })

  describe('execute — failure path', () => {
    it('returns status failed on docker exec error', async () => {
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
        if (cb) cb(new Error('redis-cli: connection refused'), '', '')
      })

      const { skill } = makeSkill()
      const result = await skill.execute()

      expect(result.status).toBe('failed')
      expect(result.error).toContain('connection refused')
    })

    it('sends high-priority Pushover on failure', async () => {
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
        if (cb) cb(new Error('redis-cli: connection refused'), '', '')
      })

      const { skill, pushover } = makeSkill()
      await skill.execute()

      expect(pushover.send).toHaveBeenCalledWith(
        expect.objectContaining({
          title: expect.stringContaining('FAILED'),
          priority: 1,
        }),
      )
    })
  })

  describe('execute — mkdir failure', () => {
    it('returns failed when backup directory cannot be created', async () => {
      mockMkdir.mockRejectedValueOnce(new Error('EACCES'))

      const { skill } = makeSkill()
      const result = await skill.execute()

      expect(result.status).toBe('failed')
      expect(result.error).toContain('Failed to create backup directory')
    })
  })

  describe('result shape', () => {
    it('has all required properties', async () => {
      const { skill } = makeSkill()
      const result = await skill.execute()

      expect(result).toHaveProperty('status')
      expect(result).toHaveProperty('filePath')
      expect(result).toHaveProperty('sizeBytes')
      expect(result).toHaveProperty('durationSeconds')
      expect(result).toHaveProperty('prunedCount')
    })
  })
})

describe('redis applyRetention', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockReaddir.mockResolvedValue([])
    mockUnlink.mockResolvedValue(undefined)
  })

  it('returns 0 when directory is empty', async () => {
    const pruned = await applyRetention('/tmp/test-backups')
    expect(pruned).toBe(0)
  })

  it('prunes .rdb files beyond daily retention limit', async () => {
    // Use dates that avoid Sundays and 1st-of-month to isolate daily behavior
    // 2026-04-06 (Mon) through 2026-04-15 (Wed) — no Sundays except 04-12
    const files = []
    for (let i = 0; i < 10; i++) {
      const day = String(15 - i).padStart(2, '0')
      files.push(`redis_2026-04-${day}T02-30-00.rdb`)
    }
    mockReaddir.mockResolvedValue(files)

    // daily=7, weekly=4 (04-12 is Sunday, kept by weekly), monthly=0
    const pruned = await applyRetention('/tmp/test-backups', { daily: 7, weekly: 0, monthly: 0 })
    expect(pruned).toBe(3) // 10 - 7 = 3
  })

  it('returns 0 when readdir fails', async () => {
    mockReaddir.mockRejectedValue(new Error('ENOENT'))

    const pruned = await applyRetention('/tmp/nonexistent')
    expect(pruned).toBe(0)
  })

  it('keeps all files when count is within retention limits', async () => {
    mockReaddir.mockResolvedValue([
      'redis_2026-04-10T02-30-00.rdb',
      'redis_2026-04-09T02-30-00.rdb',
      'redis_2026-04-08T02-30-00.rdb',
    ])

    const pruned = await applyRetention('/tmp/test-backups', { daily: 7, weekly: 4, monthly: 3 })
    expect(pruned).toBe(0)
  })

  it('uses standardized 7/4/3 retention by default', async () => {
    // 5 files, all within daily=7 limit
    mockReaddir.mockResolvedValue([
      'redis_2026-04-10T02-30-00.rdb',
      'redis_2026-04-09T02-30-00.rdb',
      'redis_2026-04-08T02-30-00.rdb',
      'redis_2026-04-07T02-30-00.rdb',
      'redis_2026-04-06T02-30-00.rdb',
    ])

    const pruned = await applyRetention('/tmp/test-backups')
    expect(pruned).toBe(0)
  })
})
