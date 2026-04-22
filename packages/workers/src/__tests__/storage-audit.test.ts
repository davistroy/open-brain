import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PushoverService } from '@open-brain/shared'
import { StorageAuditSkill } from '../skills/storage-audit.js'

// ============================================================
// Mock helpers
// ============================================================

function makeMockDb() {
  // Returns results for: pg_database_size, table count, capture count, growth count
  const executeMock = vi.fn()
    .mockResolvedValueOnce({ rows: [{ size_bytes: '536870912' }] })  // 512 MB
    .mockResolvedValueOnce({ rows: [{ count: '15' }] })             // 15 tables
    .mockResolvedValueOnce({ rows: [{ count: '450' }] })            // 450 captures
    .mockResolvedValueOnce({ rows: [{ count: '120' }] })            // 120 captures in 30 days
  return {
    execute: executeMock,
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 'mock-log-id' }]) }),
    }),
  }
}

function makeFailingDb() {
  return {
    execute: vi.fn().mockRejectedValue(new Error('DB connection failed')),
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

/**
 * Mock command executor that returns configurable results per command.
 */
function makeMockExec() {
  return vi.fn(async (cmd: string, args: string[]) => {
    // Redis INFO memory
    if (cmd === 'docker' && args.includes('INFO') && args.includes('memory')) {
      return {
        stdout: 'used_memory:104857600\r\nused_memory_human:100.00M\r\n',
        stderr: '',
      }
    }
    // Redis DBSIZE
    if (cmd === 'docker' && args.includes('DBSIZE')) {
      return { stdout: 'DB 0 has 1234 keys', stderr: '' }
    }
    // du -sb for backups
    if (cmd === 'du' && args[1] === '/backups') {
      return { stdout: '1073741824\t/backups', stderr: '' }
    }
    // du -sb for wiki
    if (cmd === 'du' && args[1] === '/wiki') {
      return { stdout: '52428800\t/wiki', stderr: '' }
    }
    // find for backup files
    if (cmd === 'find' && args[0] === '/backups') {
      return { stdout: 'a.gz\nb.gz\nc.bundle\n', stderr: '' }
    }
    // find for wiki pages
    if (cmd === 'find' && args[0] === '/wiki') {
      return { stdout: 'a.md\nb.md\nc.md\nd.md\ne.md\n', stderr: '' }
    }
    return { stdout: '', stderr: '' }
  })
}

function makeSkill(opts: {
  dbOverride?: any
  pushoverConfigured?: boolean
  execFn?: any
} = {}) {
  const db = opts.dbOverride ?? makeMockDb()
  const pushover = makePushover(opts.pushoverConfigured ?? true)
  const execFn = opts.execFn ?? makeMockExec()

  const skill = new StorageAuditSkill({
    db: db as unknown as import('@open-brain/shared').Database,
    pushover,
    execFn,
  })

  return { skill, db, pushover, execFn }
}

// ============================================================
// Tests
// ============================================================

describe('StorageAuditSkill', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  describe('full audit', () => {
    it('gathers all storage metrics', async () => {
      const { skill } = makeSkill()

      const result = await skill.execute({
        now: new Date('2026-04-12T03:00:00Z'),
        backupDir: '/backups',
        wikiRepoPath: '/wiki',
      })

      // Postgres metrics
      expect(result.metrics.postgres.dbSizeBytes).toBe(536870912)
      expect(result.metrics.postgres.dbSizeHuman).toBe('512.0 MB')
      expect(result.metrics.postgres.tableCount).toBe(15)
      expect(result.metrics.postgres.captureCount).toBe(450)
      expect(result.metrics.postgres.captureGrowthRate).toBe(4)  // 120/30 = 4.0

      // Redis metrics
      expect(result.metrics.redis.usedMemoryBytes).toBe(104857600)
      expect(result.metrics.redis.usedMemoryHuman).toBe('100.00M')
      expect(result.metrics.redis.keyCount).toBe(1234)

      // Backup metrics
      expect(result.metrics.backups.totalSizeBytes).toBe(1073741824)
      expect(result.metrics.backups.fileCount).toBe(3)

      // Wiki metrics
      expect(result.metrics.wiki.repoSizeBytes).toBe(52428800)
      expect(result.metrics.wiki.pageCount).toBe(5)
    })

    it('completes within reasonable time', async () => {
      const { skill } = makeSkill()

      const result = await skill.execute({
        now: new Date('2026-04-12T03:00:00Z'),
        backupDir: '/backups',
        wikiRepoPath: '/wiki',
      })

      expect(result.durationMs).toBeGreaterThanOrEqual(0)
      expect(result.durationMs).toBeLessThan(5000)
    })
  })

  describe('Postgres error resilience', () => {
    it('returns defaults when DB queries fail', async () => {
      const { skill } = makeSkill({ dbOverride: makeFailingDb() })

      const result = await skill.execute({
        now: new Date('2026-04-12T03:00:00Z'),
        backupDir: '/backups',
        wikiRepoPath: '/wiki',
      })

      expect(result.metrics.postgres.dbSizeBytes).toBe(0)
      expect(result.metrics.postgres.dbSizeHuman).toBe('unknown')
      expect(result.metrics.postgres.tableCount).toBe(0)
      expect(result.metrics.postgres.captureCount).toBe(0)
    })
  })

  describe('Redis error resilience', () => {
    it('returns defaults when docker exec fails', async () => {
      const execFn = vi.fn().mockRejectedValue(new Error('docker not found'))
      const { skill } = makeSkill({ execFn })

      const result = await skill.execute({
        now: new Date('2026-04-12T03:00:00Z'),
        backupDir: '/backups',
        wikiRepoPath: '/wiki',
      })

      expect(result.metrics.redis.usedMemoryBytes).toBe(0)
      expect(result.metrics.redis.usedMemoryHuman).toBe('unknown')
    })
  })

  describe('backup/wiki error resilience', () => {
    it('returns defaults when du/find fail', async () => {
      const execFn = vi.fn().mockRejectedValue(new Error('command not found'))
      const dbMock = makeMockDb()
      const { skill } = makeSkill({ dbOverride: dbMock, execFn })

      const result = await skill.execute({
        now: new Date('2026-04-12T03:00:00Z'),
        backupDir: '/backups',
        wikiRepoPath: '/wiki',
      })

      // Postgres should still work (uses db.execute)
      expect(result.metrics.postgres.dbSizeBytes).toBe(536870912)
      // But external commands should return defaults
      expect(result.metrics.redis.usedMemoryBytes).toBe(0)
      expect(result.metrics.backups.totalSizeBytes).toBe(0)
      expect(result.metrics.wiki.repoSizeBytes).toBe(0)
    })
  })

  describe('skills_log', () => {
    it('writes summary to skills_log on completion', async () => {
      const { skill, db } = makeSkill()

      await skill.execute({
        now: new Date('2026-04-12T03:00:00Z'),
        backupDir: '/backups',
        wikiRepoPath: '/wiki',
      })

      expect(db.insert).toHaveBeenCalled()
    })
  })
})
