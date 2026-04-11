import { execFile } from 'node:child_process'
import { stat, readdir, unlink, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Database } from '@open-brain/shared'
import { backup_log, skills_log, logger, PushoverService } from '@open-brain/shared'

function execFileAsync(cmd: string, args: string[], opts: Record<string, unknown> = {}): Promise<{ stdout: string | Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts as any, (err, stdout, stderr) => {
      if (err) return reject(err)
      resolve({ stdout: stdout as string | Buffer, stderr: stderr as string })
    })
  })
}

// ============================================================
// Types
// ============================================================

export interface DbBackupOptions {
  /** Backup output directory. Default: /backups/database */
  backupDir?: string
  /** Postgres container name for docker exec. Default: open-brain-postgres */
  containerName?: string
  /** Database name. Default: openbrain */
  dbName?: string
  /** Database user. Default: openbrain */
  dbUser?: string
  /** Skip docker exec and use pg_dump directly (for testing). Default: false */
  useDocker?: boolean
}

export interface DbBackupResult {
  status: 'success' | 'failed'
  filePath: string | null
  sizeBytes: number
  durationSeconds: number
  prunedCount: number
  error?: string
}

export interface RetentionPolicy {
  daily: number   // keep N most recent daily backups
  weekly: number  // keep N most recent weekly backups (Sunday)
  monthly: number // keep N most recent monthly backups (1st of month)
}

// ============================================================
// Constants
// ============================================================

const DEFAULT_BACKUP_DIR = '/backups/database'
const DEFAULT_CONTAINER = 'open-brain-postgres'
const DEFAULT_DB_NAME = 'openbrain'
const DEFAULT_DB_USER = 'openbrain'

const DEFAULT_RETENTION: RetentionPolicy = {
  daily: 7,
  weekly: 4,
  monthly: 3,
}

// ============================================================
// Retention logic
// ============================================================

interface BackupFile {
  name: string
  path: string
  date: Date
}

/**
 * Parse backup filename to extract date.
 * Expected format: openbrain_YYYY-MM-DDTHH-MM-SS.sql.gz
 */
function parseBackupDate(filename: string): Date | null {
  const match = filename.match(/(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})/)
  if (!match) return null
  // Convert T-separated time back to colons for Date parsing
  const dateStr = match[1].replace(/T(\d{2})-(\d{2})-(\d{2})/, 'T$1:$2:$3')
  const date = new Date(dateStr)
  return isNaN(date.getTime()) ? null : date
}

/**
 * Apply retention policy: keep N daily, N weekly (Sunday), N monthly (1st).
 * A single backup can satisfy multiple retention slots (e.g., the 1st of a month
 * counts for daily, weekly if Sunday, and monthly). Files not retained are deleted.
 *
 * Returns the number of files pruned.
 */
export async function applyRetention(
  backupDir: string,
  retention: RetentionPolicy = DEFAULT_RETENTION,
): Promise<number> {
  let files: string[]
  try {
    files = await readdir(backupDir)
  } catch {
    return 0
  }

  const backups: BackupFile[] = files
    .filter(f => f.endsWith('.sql.gz'))
    .map(f => ({ name: f, path: join(backupDir, f), date: parseBackupDate(f)! }))
    .filter(b => b.date !== null)
    .sort((a, b) => b.date.getTime() - a.date.getTime()) // newest first

  if (backups.length === 0) return 0

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

  // Delete files not in the keep set
  let pruned = 0
  for (const backup of backups) {
    if (!keep.has(backup.name)) {
      try {
        await unlink(backup.path)
        pruned++
        logger.info({ file: backup.name }, '[db-backup] pruned old backup')
      } catch (err) {
        logger.warn({ file: backup.name, err }, '[db-backup] failed to prune backup')
      }
    }
  }

  return pruned
}

// ============================================================
// DbBackupSkill
// ============================================================

export class DbBackupSkill {
  private db: Database
  private pushover: PushoverService
  private backupDir: string
  private containerName: string
  private dbName: string
  private dbUser: string
  private useDocker: boolean

  constructor(opts: {
    db: Database
    pushover?: PushoverService
    backupDir?: string
    containerName?: string
    dbName?: string
    dbUser?: string
    useDocker?: boolean
  }) {
    this.db = opts.db
    this.pushover = opts.pushover ?? new PushoverService()
    this.backupDir = opts.backupDir ?? DEFAULT_BACKUP_DIR
    this.containerName = opts.containerName ?? DEFAULT_CONTAINER
    this.dbName = opts.dbName ?? DEFAULT_DB_NAME
    this.dbUser = opts.dbUser ?? DEFAULT_DB_USER
    this.useDocker = opts.useDocker ?? true
  }

  async execute(options: DbBackupOptions = {}): Promise<DbBackupResult> {
    const startMs = Date.now()
    const backupDir = options.backupDir ?? this.backupDir
    const containerName = options.containerName ?? this.containerName
    const dbName = options.dbName ?? this.dbName
    const dbUser = options.dbUser ?? this.dbUser
    const useDocker = options.useDocker ?? this.useDocker

    logger.info({ backupDir, containerName, dbName }, '[db-backup] starting database backup')

    // Ensure backup directory exists
    try {
      await mkdir(backupDir, { recursive: true })
    } catch (err) {
      const result = this.failResult(startMs, `Failed to create backup directory: ${err}`)
      await this.logResult(result)
      return result
    }

    // Generate filename with timestamp
    const now = new Date()
    const ts = now.toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, '')
    const filename = `${dbName}_${ts}.sql.gz`
    const filePath = join(backupDir, filename)

    try {
      // Execute pg_dump | gzip via docker exec
      if (useDocker) {
        await execFileAsync('docker', [
          'exec', containerName,
          'bash', '-c',
          `pg_dump -U ${dbUser} -d ${dbName} --no-owner --no-privileges | gzip`,
        ], {
          maxBuffer: 512 * 1024 * 1024, // 512 MB — large dumps
          timeout: 600_000, // 10 minutes
          encoding: 'buffer',
        }).then(async ({ stdout }) => {
          const { writeFile } = await import('node:fs/promises')
          await writeFile(filePath, stdout)
        })
      } else {
        // Direct pg_dump (for environments where Docker exec isn't available)
        await execFileAsync('bash', [
          '-c',
          `pg_dump -U ${dbUser} -d ${dbName} --no-owner --no-privileges | gzip > "${filePath}"`,
        ], {
          maxBuffer: 512 * 1024 * 1024,
          timeout: 600_000,
        })
      }

      // Get file size
      const stats = await stat(filePath)
      const sizeBytes = stats.size
      const durationSeconds = Math.round((Date.now() - startMs) / 1000)

      // Apply retention
      const prunedCount = await applyRetention(backupDir)

      const result: DbBackupResult = {
        status: 'success',
        filePath,
        sizeBytes,
        durationSeconds,
        prunedCount,
      }

      // Log to backup_log table
      await this.logResult(result)

      // Send success notification
      const sizeMB = (sizeBytes / (1024 * 1024)).toFixed(1)
      await this.notify(
        'Database Backup Complete',
        `Backup: ${filename}\nSize: ${sizeMB} MB\nDuration: ${durationSeconds}s\nPruned: ${prunedCount} old backups`,
        -1, // low priority
      )

      logger.info({ filePath, sizeBytes, durationSeconds, prunedCount }, '[db-backup] backup complete')

      return result
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      const result = this.failResult(startMs, errorMsg, filePath)
      await this.logResult(result)
      await this.notify(
        'Database Backup FAILED',
        `Error: ${errorMsg.slice(0, 500)}`,
        1, // high priority
      )
      return result
    }
  }

  // ----------------------------------------------------------
  // Private helpers
  // ----------------------------------------------------------

  private failResult(startMs: number, error: string, filePath?: string): DbBackupResult {
    logger.error({ error }, '[db-backup] backup failed')
    return {
      status: 'failed',
      filePath: filePath ?? null,
      sizeBytes: 0,
      durationSeconds: Math.round((Date.now() - startMs) / 1000),
      prunedCount: 0,
      error,
    }
  }

  private async logResult(result: DbBackupResult): Promise<void> {
    try {
      await this.db.insert(backup_log).values({
        backup_type: 'database',
        file_path: result.filePath,
        size_bytes: result.sizeBytes,
        duration_seconds: result.durationSeconds,
        status: result.status,
        error: result.error ?? null,
        pruned_count: result.prunedCount,
      })
    } catch (err) {
      logger.warn({ err }, '[db-backup] failed to write backup_log entry')
    }

    try {
      await this.db.insert(skills_log).values({
        skill_name: 'db-backup',
        input_summary: 'database backup',
        output_summary: `status:${result.status} | size:${result.sizeBytes} | duration:${result.durationSeconds}s | pruned:${result.prunedCount}`,
        duration_ms: result.durationSeconds * 1000,
      })
    } catch (err) {
      logger.warn({ err }, '[db-backup] failed to write skills_log entry')
    }
  }

  private async notify(title: string, message: string, priority: -2 | -1 | 0 | 1 | 2): Promise<void> {
    if (!this.pushover.isConfigured) return
    try {
      await this.pushover.send({ title: `Open Brain: ${title}`, message, priority })
    } catch (err) {
      logger.warn({ err }, '[db-backup] Pushover notification failed')
    }
  }
}

// ============================================================
// Entry point for skill-execution worker
// ============================================================

export async function executeDbBackup(
  db: Database,
  options: DbBackupOptions = {},
): Promise<DbBackupResult> {
  const skill = new DbBackupSkill({
    db,
    backupDir: options.backupDir ?? process.env.BACKUP_DIR_DATABASE ?? DEFAULT_BACKUP_DIR,
    containerName: options.containerName ?? process.env.POSTGRES_CONTAINER ?? DEFAULT_CONTAINER,
    dbName: options.dbName ?? process.env.POSTGRES_DB ?? DEFAULT_DB_NAME,
    dbUser: options.dbUser ?? process.env.POSTGRES_USER ?? DEFAULT_DB_USER,
    useDocker: options.useDocker ?? true,
  })
  return skill.execute(options)
}
