import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PushoverService } from '@open-brain/shared'

// ============================================================
// Mocks — declared before any imports that use them
// ============================================================

const mockExecFile = vi.fn((_cmd: string, _args: string[], _opts: any, cb: Function) => {
  if (cb) cb(null, Buffer.from('fake-dump-data'), '')
})

vi.mock('node:child_process', () => ({
  execFile: (...args: any[]) => mockExecFile(...args),
}))

const mockStat = vi.fn().mockResolvedValue({ size: 1024 * 1024 })
const mockReaddir = vi.fn().mockResolvedValue([] as string[])
const mockUnlink = vi.fn().mockResolvedValue(undefined)
const mockMkdir = vi.fn().mockResolvedValue(undefined)
const mockWriteFile = vi.fn().mockResolvedValue(undefined)

vi.mock('node:fs/promises', () => ({
  stat: (...args: any[]) => mockStat(...args),
  readdir: (...args: any[]) => mockReaddir(...args),
  unlink: (...args: any[]) => mockUnlink(...args),
  mkdir: (...args: any[]) => mockMkdir(...args),
  writeFile: (...args: any[]) => mockWriteFile(...args),
}))

// ============================================================
// Imports (after mocks)
// ============================================================

import { DbBackupSkill, applyRetention } from '../skills/db-backup.js'

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

  const skill = new DbBackupSkill({
    db: db as unknown as import('@open-brain/shared').Database,
    pushover,
    backupDir: '/tmp/test-backups/database',
    containerName: 'test-postgres',
    dbName: 'testdb',
    dbUser: 'testuser',
    useDocker: true,
  })

  return { skill, db, pushover }
}

// ============================================================
// Tests
// ============================================================

describe('DbBackupSkill', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockStat.mockResolvedValue({ size: 1024 * 1024 })
    mockReaddir.mockResolvedValue([])
    mockUnlink.mockResolvedValue(undefined)
    mockMkdir.mockResolvedValue(undefined)
    mockWriteFile.mockResolvedValue(undefined)
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      if (cb) cb(null, Buffer.from('fake-dump-data'), '')
    })
  })

  describe('execute — success path', () => {
    it('returns status success with file info', async () => {
      const { skill } = makeSkill()
      const result = await skill.execute()

      expect(result.status).toBe('success')
      expect(result.filePath).toMatch(/test-backups[/\\]database[/\\]/)
      expect(result.filePath).toContain('.sql.gz')
      expect(result.sizeBytes).toBe(1024 * 1024)
      expect(result.durationSeconds).toBeGreaterThanOrEqual(0)
    })

    it('logs to backup_log and skills_log tables', async () => {
      const { skill, db } = makeSkill()
      await skill.execute()

      expect(db.insert).toHaveBeenCalledTimes(2)
    })

    it('sends success Pushover notification with low priority', async () => {
      const { skill, pushover } = makeSkill()
      await skill.execute()

      expect(pushover.send).toHaveBeenCalledWith(
        expect.objectContaining({
          title: expect.stringContaining('Database Backup Complete'),
          priority: -1,
        }),
      )
    })

    it('does not send Pushover when not configured', async () => {
      const { skill, pushover } = makeSkill({ pushoverConfigured: false })
      await skill.execute()

      expect(pushover.send).not.toHaveBeenCalled()
    })

    it('includes file size and duration in notification', async () => {
      const { skill, pushover } = makeSkill()
      await skill.execute()

      const sendCall = (pushover.send as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(sendCall.message).toContain('MB')
      expect(sendCall.message).toContain('Duration')
    })
  })

  describe('execute — failure path', () => {
    it('returns status failed on exec error', async () => {
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
        if (cb) cb(new Error('pg_dump failed: connection refused'), '', '')
      })

      const { skill } = makeSkill()
      const result = await skill.execute()

      expect(result.status).toBe('failed')
      expect(result.error).toContain('pg_dump failed')
    })

    it('sends high-priority Pushover on failure', async () => {
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
        if (cb) cb(new Error('connection refused'), '', '')
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

  describe('skills_log write failure is non-fatal', () => {
    it('completes even if skills_log insert fails', async () => {
      const { skill, db } = makeSkill()
      const insertMock = db.insert as ReturnType<typeof vi.fn>
      insertMock
        .mockReturnValueOnce({ values: vi.fn().mockResolvedValue(undefined) })
        .mockReturnValueOnce({ values: vi.fn().mockRejectedValue(new Error('DB write failed')) })

      const result = await skill.execute()
      expect(result.status).toBe('success')
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

describe('applyRetention', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockReaddir.mockResolvedValue([])
    mockUnlink.mockResolvedValue(undefined)
  })

  it('returns 0 when directory is empty', async () => {
    const pruned = await applyRetention('/tmp/test-backups')
    expect(pruned).toBe(0)
  })

  it('returns 0 when fewer files than retention limit', async () => {
    mockReaddir.mockResolvedValue([
      'openbrain_2026-04-10T02-00-00.sql.gz',
      'openbrain_2026-04-09T02-00-00.sql.gz',
    ])

    const pruned = await applyRetention('/tmp/test-backups', { daily: 7, weekly: 4, monthly: 3 })
    expect(pruned).toBe(0)
  })

  it('prunes files beyond daily retention limit', async () => {
    const files = []
    for (let i = 0; i < 10; i++) {
      const day = String(10 - i).padStart(2, '0')
      files.push(`openbrain_2026-04-${day}T02-00-00.sql.gz`)
    }
    mockReaddir.mockResolvedValue(files)

    const pruned = await applyRetention('/tmp/test-backups', { daily: 7, weekly: 0, monthly: 0 })
    expect(pruned).toBe(3) // 10 - 7 = 3
  })

  it('returns 0 when readdir fails', async () => {
    mockReaddir.mockRejectedValue(new Error('ENOENT'))

    const pruned = await applyRetention('/tmp/nonexistent')
    expect(pruned).toBe(0)
  })

  it('keeps Sunday backups for weekly retention', async () => {
    // 2026-04-05 is a Sunday, 2026-04-12 is a Sunday
    mockReaddir.mockResolvedValue([
      'openbrain_2026-04-12T02-00-00.sql.gz', // Sunday
      'openbrain_2026-04-11T02-00-00.sql.gz',
      'openbrain_2026-04-10T02-00-00.sql.gz',
      'openbrain_2026-04-09T02-00-00.sql.gz',
      'openbrain_2026-04-08T02-00-00.sql.gz',
      'openbrain_2026-04-07T02-00-00.sql.gz',
      'openbrain_2026-04-06T02-00-00.sql.gz',
      'openbrain_2026-04-05T02-00-00.sql.gz', // Sunday
      'openbrain_2026-04-04T02-00-00.sql.gz',
      'openbrain_2026-04-03T02-00-00.sql.gz',
    ])

    // daily=3 keeps top 3, weekly=4 also keeps Sundays
    const pruned = await applyRetention('/tmp/test-backups', { daily: 3, weekly: 4, monthly: 0 })
    // Keep: 04-12, 04-11, 04-10 (daily) + 04-05 (weekly, Sunday)
    // 04-12 is also Sunday — counted in both. 4 kept, 6 pruned
    expect(pruned).toBe(6)
  })
})
