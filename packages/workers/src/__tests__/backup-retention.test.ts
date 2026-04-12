import { describe, it, expect, vi, beforeEach } from 'vitest'

// ============================================================
// Mocks — declared before any imports that use them
// ============================================================

const mockReaddir = vi.fn().mockResolvedValue([] as string[])
const mockUnlink = vi.fn().mockResolvedValue(undefined)

vi.mock('node:fs/promises', () => ({
  readdir: (...args: any[]) => mockReaddir(...args),
  unlink: (...args: any[]) => mockUnlink(...args),
}))

// ============================================================
// Imports (after mocks)
// ============================================================

import {
  pruneBackups,
  parseBackupDate,
  classifyRetained,
  DEFAULT_RETENTION,
} from '../lib/backup-retention.js'
import type { RetentionPolicy, BackupFileInfo } from '../lib/backup-retention.js'

// ============================================================
// Helpers
// ============================================================

function makeBackupInfo(name: string, dateStr: string): BackupFileInfo {
  return {
    name,
    path: `/backups/${name}`,
    date: new Date(dateStr),
  }
}

// ============================================================
// Tests: parseBackupDate
// ============================================================

describe('parseBackupDate', () => {
  it('parses standard backup filename with timestamp', () => {
    const date = parseBackupDate('openbrain_2026-04-10T02-00-00.sql.gz')
    expect(date).not.toBeNull()
    expect(date!.getFullYear()).toBe(2026)
    expect(date!.getMonth()).toBe(3) // April = 3
    expect(date!.getDate()).toBe(10)
    expect(date!.getHours()).toBe(2)
    expect(date!.getMinutes()).toBe(0)
    expect(date!.getSeconds()).toBe(0)
  })

  it('parses wiki bundle filename', () => {
    const date = parseBackupDate('wiki_2026-03-15T14-30-45.bundle')
    expect(date).not.toBeNull()
    expect(date!.getDate()).toBe(15)
    expect(date!.getHours()).toBe(14)
    expect(date!.getMinutes()).toBe(30)
  })

  it('parses redis snapshot filename', () => {
    const date = parseBackupDate('redis_2026-01-01T00-00-00.rdb')
    expect(date).not.toBeNull()
    expect(date!.getMonth()).toBe(0) // January
    expect(date!.getDate()).toBe(1)
  })

  it('returns null for filename without timestamp', () => {
    expect(parseBackupDate('random-file.txt')).toBeNull()
  })

  it('returns null for malformed timestamp', () => {
    expect(parseBackupDate('backup_9999-99-99T99-99-99.sql.gz')).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(parseBackupDate('')).toBeNull()
  })
})

// ============================================================
// Tests: classifyRetained
// ============================================================

describe('classifyRetained', () => {
  it('returns empty set for empty input', () => {
    const result = classifyRetained([], DEFAULT_RETENTION)
    expect(result.size).toBe(0)
  })

  it('keeps N most recent daily backups', () => {
    const backups = Array.from({ length: 10 }, (_, i) => {
      const day = String(10 - i).padStart(2, '0')
      return makeBackupInfo(
        `backup_2026-04-${day}T02-00-00.sql.gz`,
        `2026-04-${day}T02:00:00`,
      )
    })

    const kept = classifyRetained(backups, { daily: 3, weekly: 0, monthly: 0 })
    expect(kept.size).toBe(3)
    expect(kept.has('backup_2026-04-10T02-00-00.sql.gz')).toBe(true)
    expect(kept.has('backup_2026-04-09T02-00-00.sql.gz')).toBe(true)
    expect(kept.has('backup_2026-04-08T02-00-00.sql.gz')).toBe(true)
  })

  it('keeps Sunday backups for weekly retention', () => {
    // 2026-04-05 is a Sunday, 2026-04-12 is a Sunday
    const backups = [
      makeBackupInfo('b_2026-04-12T02-00-00.sql.gz', '2026-04-12T02:00:00'), // Sunday
      makeBackupInfo('b_2026-04-11T02-00-00.sql.gz', '2026-04-11T02:00:00'), // Saturday
      makeBackupInfo('b_2026-04-10T02-00-00.sql.gz', '2026-04-10T02:00:00'), // Friday
      makeBackupInfo('b_2026-04-09T02-00-00.sql.gz', '2026-04-09T02:00:00'), // Thursday
      makeBackupInfo('b_2026-04-05T02-00-00.sql.gz', '2026-04-05T02:00:00'), // Sunday
      makeBackupInfo('b_2026-03-29T02-00-00.sql.gz', '2026-03-29T02:00:00'), // Sunday
    ]

    const kept = classifyRetained(backups, { daily: 1, weekly: 3, monthly: 0 })
    // daily: 04-12 (1)
    // weekly Sundays: 04-12, 04-05, 03-29 (3, but 04-12 overlaps with daily)
    expect(kept.size).toBe(3)
    expect(kept.has('b_2026-04-12T02-00-00.sql.gz')).toBe(true) // daily + weekly
    expect(kept.has('b_2026-04-05T02-00-00.sql.gz')).toBe(true) // weekly
    expect(kept.has('b_2026-03-29T02-00-00.sql.gz')).toBe(true) // weekly
  })

  it('keeps 1st-of-month backups for monthly retention', () => {
    const backups = [
      makeBackupInfo('b_2026-04-10T02-00-00.sql.gz', '2026-04-10T02:00:00'),
      makeBackupInfo('b_2026-04-01T02-00-00.sql.gz', '2026-04-01T02:00:00'), // 1st
      makeBackupInfo('b_2026-03-15T02-00-00.sql.gz', '2026-03-15T02:00:00'),
      makeBackupInfo('b_2026-03-01T02-00-00.sql.gz', '2026-03-01T02:00:00'), // 1st
      makeBackupInfo('b_2026-02-01T02-00-00.sql.gz', '2026-02-01T02:00:00'), // 1st
      makeBackupInfo('b_2026-01-01T02-00-00.sql.gz', '2026-01-01T02:00:00'), // 1st
    ]

    const kept = classifyRetained(backups, { daily: 1, weekly: 0, monthly: 3 })
    // daily: 04-10 (1)
    // monthly: 04-01, 03-01, 02-01 (3)
    expect(kept.size).toBe(4)
    expect(kept.has('b_2026-04-10T02-00-00.sql.gz')).toBe(true)
    expect(kept.has('b_2026-04-01T02-00-00.sql.gz')).toBe(true)
    expect(kept.has('b_2026-03-01T02-00-00.sql.gz')).toBe(true)
    expect(kept.has('b_2026-02-01T02-00-00.sql.gz')).toBe(true)
  })

  it('a single backup can satisfy daily, weekly, and monthly simultaneously', () => {
    // 2026-03-01 is a Sunday and 1st of month
    const backups = [
      makeBackupInfo('b_2026-03-01T02-00-00.sql.gz', '2026-03-01T02:00:00'),
    ]

    const kept = classifyRetained(backups, { daily: 1, weekly: 1, monthly: 1 })
    expect(kept.size).toBe(1)
    expect(kept.has('b_2026-03-01T02-00-00.sql.gz')).toBe(true)
  })

  it('handles fewer backups than retention limits', () => {
    const backups = [
      makeBackupInfo('b_2026-04-10T02-00-00.sql.gz', '2026-04-10T02:00:00'),
      makeBackupInfo('b_2026-04-09T02-00-00.sql.gz', '2026-04-09T02:00:00'),
    ]

    const kept = classifyRetained(backups, { daily: 7, weekly: 4, monthly: 3 })
    expect(kept.size).toBe(2)
  })
})

// ============================================================
// Tests: pruneBackups
// ============================================================

describe('pruneBackups', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockReaddir.mockResolvedValue([])
    mockUnlink.mockResolvedValue(undefined)
  })

  it('returns 0 for empty directory', async () => {
    const pruned = await pruneBackups('/backups/db', '.sql.gz')
    expect(pruned).toBe(0)
    expect(mockUnlink).not.toHaveBeenCalled()
  })

  it('returns 0 when directory does not exist', async () => {
    mockReaddir.mockRejectedValue(new Error('ENOENT'))
    const pruned = await pruneBackups('/nonexistent', '.sql.gz')
    expect(pruned).toBe(0)
  })

  it('ignores files that do not match the extension', async () => {
    mockReaddir.mockResolvedValue([
      'openbrain_2026-04-10T02-00-00.sql.gz',
      'openbrain_2026-04-09T02-00-00.sql.gz',
      'notes.txt',
      'README.md',
    ])

    const pruned = await pruneBackups('/backups', '.sql.gz', { daily: 7, weekly: 4, monthly: 3 })
    expect(pruned).toBe(0)
  })

  it('ignores files without parseable dates', async () => {
    mockReaddir.mockResolvedValue([
      'backup-latest.sql.gz',
      'openbrain_2026-04-10T02-00-00.sql.gz',
    ])

    const pruned = await pruneBackups('/backups', '.sql.gz', { daily: 7, weekly: 4, monthly: 3 })
    expect(pruned).toBe(0)
  })

  it('prunes files beyond daily retention with no weekly/monthly', async () => {
    const files: string[] = []
    for (let i = 1; i <= 10; i++) {
      const day = String(i).padStart(2, '0')
      files.push(`openbrain_2026-04-${day}T02-00-00.sql.gz`)
    }
    mockReaddir.mockResolvedValue(files)

    const pruned = await pruneBackups('/backups', '.sql.gz', { daily: 7, weekly: 0, monthly: 0 })
    expect(pruned).toBe(3) // 10 - 7 = 3 oldest pruned
    expect(mockUnlink).toHaveBeenCalledTimes(3)
  })

  it('deletes the correct (oldest) files', async () => {
    mockReaddir.mockResolvedValue([
      'openbrain_2026-04-05T02-00-00.sql.gz',
      'openbrain_2026-04-04T02-00-00.sql.gz',
      'openbrain_2026-04-03T02-00-00.sql.gz',
      'openbrain_2026-04-02T02-00-00.sql.gz',
      'openbrain_2026-04-01T02-00-00.sql.gz',
    ])

    await pruneBackups('/backups', '.sql.gz', { daily: 3, weekly: 0, monthly: 0 })

    // Should delete 04-01 and 04-02 (the 2 oldest)
    // Use path-agnostic matching (join produces OS-specific separators)
    const deletedNames = mockUnlink.mock.calls.map((call: any[]) => {
      const p = call[0] as string
      return p.split(/[/\\]/).pop()
    })
    expect(deletedNames).toContain('openbrain_2026-04-01T02-00-00.sql.gz')
    expect(deletedNames).toContain('openbrain_2026-04-02T02-00-00.sql.gz')
    expect(deletedNames).not.toContain('openbrain_2026-04-05T02-00-00.sql.gz')
    expect(deletedNames).not.toContain('openbrain_2026-04-04T02-00-00.sql.gz')
    expect(deletedNames).not.toContain('openbrain_2026-04-03T02-00-00.sql.gz')
  })

  it('uses DEFAULT_RETENTION when no policy provided', async () => {
    // DEFAULT_RETENTION = { daily: 7, weekly: 4, monthly: 3 }
    // With only 5 files, none should be pruned
    const files: string[] = []
    for (let i = 1; i <= 5; i++) {
      const day = String(i).padStart(2, '0')
      files.push(`openbrain_2026-04-${day}T02-00-00.sql.gz`)
    }
    mockReaddir.mockResolvedValue(files)

    const pruned = await pruneBackups('/backups', '.sql.gz')
    expect(pruned).toBe(0)
  })

  it('works with .bundle extension for wiki backups', async () => {
    const files: string[] = []
    for (let i = 1; i <= 10; i++) {
      const day = String(i).padStart(2, '0')
      files.push(`wiki_2026-04-${day}T02-00-00.bundle`)
    }
    mockReaddir.mockResolvedValue(files)

    const pruned = await pruneBackups('/backups/wiki', '.bundle', { daily: 7, weekly: 0, monthly: 0 })
    expect(pruned).toBe(3)
  })

  it('works with .rdb extension for redis snapshots', async () => {
    const files: string[] = []
    for (let i = 1; i <= 10; i++) {
      const day = String(i).padStart(2, '0')
      files.push(`redis_2026-04-${day}T02-00-00.rdb`)
    }
    mockReaddir.mockResolvedValue(files)

    const pruned = await pruneBackups('/backups/redis', '.rdb', { daily: 7, weekly: 0, monthly: 0 })
    expect(pruned).toBe(3)
  })

  it('handles unlink failure gracefully (continues pruning)', async () => {
    mockReaddir.mockResolvedValue([
      'b_2026-04-10T02-00-00.sql.gz',
      'b_2026-04-09T02-00-00.sql.gz',
      'b_2026-04-08T02-00-00.sql.gz',
      'b_2026-04-07T02-00-00.sql.gz',
      'b_2026-04-06T02-00-00.sql.gz',
    ])

    // First unlink fails, second succeeds
    mockUnlink
      .mockRejectedValueOnce(new Error('EPERM'))
      .mockResolvedValueOnce(undefined)

    const pruned = await pruneBackups('/backups', '.sql.gz', { daily: 3, weekly: 0, monthly: 0 })
    // 2 files should be pruned: 04-06 and 04-07
    // But 1 fails, so only 1 successfully pruned
    expect(pruned).toBe(1)
    expect(mockUnlink).toHaveBeenCalledTimes(2)
  })

  describe('full 7/4/3 retention policy scenario', () => {
    it('keeps correct mix of daily, weekly, and monthly backups over 60 days', async () => {
      // Generate 60 days of daily backups: 2026-02-01 through 2026-04-01
      const files: string[] = []
      const startDate = new Date('2026-02-01T02:00:00')
      for (let i = 0; i < 60; i++) {
        const d = new Date(startDate)
        d.setDate(d.getDate() + i)
        const ts = d.toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, '')
        files.push(`db_${ts}.sql.gz`)
      }
      mockReaddir.mockResolvedValue(files)

      const pruned = await pruneBackups('/backups', '.sql.gz', { daily: 7, weekly: 4, monthly: 3 })

      // Count how many were deleted vs kept
      const keptCount = 60 - pruned
      // At least 7 daily kept, plus some weekly/monthly extras
      expect(keptCount).toBeGreaterThanOrEqual(7)
      // Should have pruned a significant number
      expect(pruned).toBeGreaterThan(40)
    })

    it('after 10 daily backups, only 7 most recent remain (acceptance criterion)', async () => {
      // 10 consecutive days, no Sundays or 1st-of-month to trigger weekly/monthly
      // Use 2026-04-06 (Monday) through 2026-04-15 (Wednesday) — no Sundays, no 1st
      const files: string[] = []
      for (let i = 6; i <= 15; i++) {
        const day = String(i).padStart(2, '0')
        files.push(`db_2026-04-${day}T02-00-00.sql.gz`)
      }
      mockReaddir.mockResolvedValue(files)

      await pruneBackups('/backups', '.sql.gz', { daily: 7, weekly: 4, monthly: 3 })

      const deletedNames = mockUnlink.mock.calls.map((call: any[]) => {
        const p = call[0] as string
        return p.split(/[/\\]/).pop()
      })
      expect(deletedNames.length).toBe(3) // 10 - 7
      // Oldest 3 pruned: 04-06, 04-07, 04-08
      expect(deletedNames).toContain('db_2026-04-06T02-00-00.sql.gz')
      expect(deletedNames).toContain('db_2026-04-07T02-00-00.sql.gz')
      expect(deletedNames).toContain('db_2026-04-08T02-00-00.sql.gz')
    })

    it('weekly backups (Sunday) preserved for 4 weeks (acceptance criterion)', async () => {
      // Backups spanning 6 Sundays, daily=1, weekly=4
      // 2026 Sundays in March-April: 3/1, 3/8, 3/15, 3/22, 3/29, 4/5, 4/12
      const files = [
        'db_2026-04-12T02-00-00.sql.gz', // Sunday (most recent)
        'db_2026-04-11T02-00-00.sql.gz', // Saturday
        'db_2026-04-05T02-00-00.sql.gz', // Sunday
        'db_2026-03-29T02-00-00.sql.gz', // Sunday
        'db_2026-03-22T02-00-00.sql.gz', // Sunday
        'db_2026-03-15T02-00-00.sql.gz', // Sunday
        'db_2026-03-08T02-00-00.sql.gz', // Sunday
      ]
      mockReaddir.mockResolvedValue(files)

      await pruneBackups('/backups', '.sql.gz', { daily: 1, weekly: 4, monthly: 0 })

      const deletedNames = mockUnlink.mock.calls.map((call: any[]) => {
        const p = call[0] as string
        return p.split(/[/\\]/).pop()
      })
      // daily: keep 04-12 (1)
      // weekly (Sundays): keep 04-12, 04-05, 03-29, 03-22 (4)
      // Pruned: 03-15, 03-08, and 04-11 (Saturday, not in daily top 1 or weekly)
      expect(deletedNames).toContain('db_2026-03-15T02-00-00.sql.gz')
      expect(deletedNames).toContain('db_2026-03-08T02-00-00.sql.gz')
      expect(deletedNames).toContain('db_2026-04-11T02-00-00.sql.gz')
      expect(deletedNames.length).toBe(3)
    })

    it('monthly backups (1st) preserved for 3 months (acceptance criterion)', async () => {
      // Backups on 1st of each month plus some extras
      const files = [
        'db_2026-04-10T02-00-00.sql.gz',
        'db_2026-04-01T02-00-00.sql.gz', // 1st
        'db_2026-03-15T02-00-00.sql.gz',
        'db_2026-03-01T02-00-00.sql.gz', // 1st
        'db_2026-02-01T02-00-00.sql.gz', // 1st
        'db_2026-01-01T02-00-00.sql.gz', // 1st
        'db_2025-12-01T02-00-00.sql.gz', // 1st
      ]
      mockReaddir.mockResolvedValue(files)

      await pruneBackups('/backups', '.sql.gz', { daily: 1, weekly: 0, monthly: 3 })

      const deletedNames = mockUnlink.mock.calls.map((call: any[]) => {
        const p = call[0] as string
        return p.split(/[/\\]/).pop()
      })
      // daily: keep 04-10 (1)
      // monthly: keep 04-01, 03-01, 02-01 (3)
      // Pruned: 03-15, 01-01, 12-01
      expect(deletedNames).toContain('db_2026-03-15T02-00-00.sql.gz')
      expect(deletedNames).toContain('db_2026-01-01T02-00-00.sql.gz')
      expect(deletedNames).toContain('db_2025-12-01T02-00-00.sql.gz')
      expect(deletedNames.length).toBe(3)
    })
  })
})

// ============================================================
// Tests: DEFAULT_RETENTION constant
// ============================================================

describe('DEFAULT_RETENTION', () => {
  it('has the standard 7/4/3 policy', () => {
    expect(DEFAULT_RETENTION).toEqual({
      daily: 7,
      weekly: 4,
      monthly: 3,
    })
  })
})
