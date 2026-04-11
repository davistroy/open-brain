import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PushoverService } from '@open-brain/shared'

// ============================================================
// Mocks — declared before any imports that use them
// ============================================================

const mockExecFile = vi.fn((_cmd: string, _args: string[], _opts: any, cb: Function) => {
  if (cb) cb(null, '', '')
})

vi.mock('node:child_process', () => ({
  execFile: (...args: any[]) => mockExecFile(...args),
}))

const mockStat = vi.fn().mockResolvedValue({ size: 512 * 1024 })
const mockReaddir = vi.fn().mockResolvedValue([] as string[])
const mockUnlink = vi.fn().mockResolvedValue(undefined)
const mockMkdir = vi.fn().mockResolvedValue(undefined)

vi.mock('node:fs/promises', () => ({
  stat: (...args: any[]) => mockStat(...args),
  readdir: (...args: any[]) => mockReaddir(...args),
  unlink: (...args: any[]) => mockUnlink(...args),
  mkdir: (...args: any[]) => mockMkdir(...args),
}))

// ============================================================
// Imports (after mocks)
// ============================================================

import { WikiBackupSkill, applyRetention } from '../skills/wiki-backup.js'

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

  const skill = new WikiBackupSkill({
    db: db as unknown as import('@open-brain/shared').Database,
    pushover,
    backupDir: '/tmp/test-backups/wiki',
    wikiRepoPath: '/tmp/test-wiki',
  })

  return { skill, db, pushover }
}

// ============================================================
// Tests
// ============================================================

describe('WikiBackupSkill', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockStat.mockResolvedValue({ size: 512 * 1024 })
    mockReaddir.mockResolvedValue([])
    mockUnlink.mockResolvedValue(undefined)
    mockMkdir.mockResolvedValue(undefined)
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      if (cb) cb(null, '', '')
    })
  })

  describe('execute — success path', () => {
    it('returns status success with file info', async () => {
      const { skill } = makeSkill()
      const result = await skill.execute()

      expect(result.status).toBe('success')
      expect(result.filePath).toMatch(/test-backups[/\\]wiki[/\\]/)
      expect(result.filePath).toContain('.bundle')
      expect(result.sizeBytes).toBe(512 * 1024)
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
          title: expect.stringContaining('Wiki Backup Complete'),
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
    it('returns status failed on git bundle error', async () => {
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
        if (cb) cb(new Error('git bundle failed: not a git repository'), '', '')
      })

      const { skill } = makeSkill()
      const result = await skill.execute()

      expect(result.status).toBe('failed')
      expect(result.error).toContain('git bundle failed')
    })

    it('sends high-priority Pushover on failure', async () => {
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
        if (cb) cb(new Error('not a git repository'), '', '')
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

describe('wiki applyRetention', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockReaddir.mockResolvedValue([])
    mockUnlink.mockResolvedValue(undefined)
  })

  it('returns 0 when directory is empty', async () => {
    const pruned = await applyRetention('/tmp/test-backups')
    expect(pruned).toBe(0)
  })

  it('prunes .bundle files beyond retention limit', async () => {
    const files = []
    for (let i = 0; i < 10; i++) {
      const day = String(10 - i).padStart(2, '0')
      files.push(`wiki_2026-04-${day}T02-15-00.bundle`)
    }
    mockReaddir.mockResolvedValue(files)

    const pruned = await applyRetention('/tmp/test-backups')
    // daily=7, with some Sunday/monthly overlap, expect at least 1 pruned
    expect(pruned).toBeGreaterThanOrEqual(1)
  })

  it('returns 0 when readdir fails', async () => {
    mockReaddir.mockRejectedValue(new Error('ENOENT'))

    const pruned = await applyRetention('/tmp/nonexistent')
    expect(pruned).toBe(0)
  })
})
