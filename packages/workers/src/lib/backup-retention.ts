import { readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { logger } from '@open-brain/shared'

// ============================================================
// Types
// ============================================================

export interface RetentionPolicy {
  /** Keep N most recent daily backups */
  daily: number
  /** Keep N most recent weekly backups (Sunday) */
  weekly: number
  /** Keep N most recent monthly backups (1st of month) */
  monthly: number
}

export interface BackupFileInfo {
  name: string
  path: string
  date: Date
}

export interface PruneResult {
  pruned: number
  kept: number
  errors: number
}

// ============================================================
// Constants
// ============================================================

export const DEFAULT_RETENTION: RetentionPolicy = {
  daily: 7,
  weekly: 4,
  monthly: 3,
}

// ============================================================
// Date parsing
// ============================================================

/**
 * Parse a backup filename to extract its date.
 * Expected format: any prefix containing YYYY-MM-DDTHH-MM-SS
 * (colons in ISO timestamps are replaced with hyphens for filesystem safety)
 */
export function parseBackupDate(filename: string): Date | null {
  const match = filename.match(/(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})/)
  if (!match) return null
  // Convert T-separated time back to colons for Date parsing
  const dateStr = match[1].replace(/T(\d{2})-(\d{2})-(\d{2})/, 'T$1:$2:$3')
  const date = new Date(dateStr)
  return isNaN(date.getTime()) ? null : date
}

// ============================================================
// Retention classification
// ============================================================

/**
 * Given a sorted (newest-first) list of backup files, determine which to keep
 * based on the retention policy: N daily, N weekly (Sunday), N monthly (1st).
 * A single backup can satisfy multiple retention slots.
 *
 * Returns the Set of filenames to keep.
 */
export function classifyRetained(
  backups: BackupFileInfo[],
  retention: RetentionPolicy,
): Set<string> {
  const keep = new Set<string>()

  // Daily: keep N most recent
  for (let i = 0; i < Math.min(retention.daily, backups.length); i++) {
    keep.add(backups[i].name)
  }

  // Weekly: keep N most recent Sunday backups
  const sundays = backups.filter(b => b.date.getDay() === 0)
  for (let i = 0; i < Math.min(retention.weekly, sundays.length); i++) {
    keep.add(sundays[i].name)
  }

  // Monthly: keep N most recent 1st-of-month backups
  const firsts = backups.filter(b => b.date.getDate() === 1)
  for (let i = 0; i < Math.min(retention.monthly, firsts.length); i++) {
    keep.add(firsts[i].name)
  }

  return keep
}

// ============================================================
// Main prune function
// ============================================================

/**
 * Scan a backup directory, apply the retention policy, and delete files
 * that are not retained. Files must match the given extension to be
 * considered (e.g., '.sql.gz', '.bundle', '.rdb').
 *
 * Returns the number of files pruned.
 */
export async function pruneBackups(
  backupDir: string,
  extension: string,
  retention: RetentionPolicy = DEFAULT_RETENTION,
  logPrefix = '[backup-retention]',
): Promise<number> {
  let files: string[]
  try {
    files = await readdir(backupDir)
  } catch {
    return 0
  }

  const backups: BackupFileInfo[] = files
    .filter(f => f.endsWith(extension))
    .map(f => ({ name: f, path: join(backupDir, f), date: parseBackupDate(f)! }))
    .filter(b => b.date !== null)
    .sort((a, b) => b.date.getTime() - a.date.getTime()) // newest first

  if (backups.length === 0) return 0

  const keep = classifyRetained(backups, retention)

  // Delete files not in the keep set
  let pruned = 0
  for (const backup of backups) {
    if (!keep.has(backup.name)) {
      try {
        await unlink(backup.path)
        pruned++
        logger.info({ file: backup.name }, `${logPrefix} pruned old backup`)
      } catch (err) {
        logger.warn({ file: backup.name, err }, `${logPrefix} failed to prune backup`)
      }
    }
  }

  return pruned
}
