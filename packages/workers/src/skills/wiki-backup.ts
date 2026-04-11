import { execFile } from 'node:child_process'
import { stat, readdir, unlink, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Database } from '@open-brain/shared'
import { backup_log, skills_log, logger, PushoverService } from '@open-brain/shared'

function execFileAsync(cmd: string, args: string[], opts: Record<string, unknown> = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts as any, (err, stdout, stderr) => {
      if (err) return reject(err)
      resolve({ stdout: stdout as string, stderr: stderr as string })
    })
  })
}

// ============================================================
// Types
// ============================================================

export interface WikiBackupOptions {
  /** Backup output directory. Default: /backups/wiki */
  backupDir?: string
  /** Path to the wiki git repository. Default: /data/wiki */
  wikiRepoPath?: string
}

export interface WikiBackupResult {
  status: 'success' | 'failed'
  filePath: string | null
  sizeBytes: number
  durationSeconds: number
  prunedCount: number
  error?: string
}

// ============================================================
// Constants
// ============================================================

const DEFAULT_BACKUP_DIR = '/backups/wiki'
const DEFAULT_WIKI_REPO = '/data/wiki'

const RETENTION = {
  daily: 7,
  weekly: 4,
  monthly: 3,
}

// ============================================================
// Retention logic (same policy as db-backup)
// ============================================================

function parseBackupDate(filename: string): Date | null {
  const match = filename.match(/(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})/)
  if (!match) return null
  const dateStr = match[1].replace(/T(\d{2})-(\d{2})-(\d{2})/, 'T$1:$2:$3')
  const date = new Date(dateStr)
  return isNaN(date.getTime()) ? null : date
}

export async function applyRetention(backupDir: string): Promise<number> {
  let files: string[]
  try {
    files = await readdir(backupDir)
  } catch {
    return 0
  }

  const backups = files
    .filter(f => f.endsWith('.bundle'))
    .map(f => ({ name: f, path: join(backupDir, f), date: parseBackupDate(f)! }))
    .filter(b => b.date !== null)
    .sort((a, b) => b.date.getTime() - a.date.getTime())

  if (backups.length === 0) return 0

  const keep = new Set<string>()

  // Daily
  for (let i = 0; i < Math.min(RETENTION.daily, backups.length); i++) {
    keep.add(backups[i].name)
  }

  // Weekly (Sundays)
  const sundays = backups.filter(b => b.date.getDay() === 0)
  for (let i = 0; i < Math.min(RETENTION.weekly, sundays.length); i++) {
    keep.add(sundays[i].name)
  }

  // Monthly (1st of month)
  const firsts = backups.filter(b => b.date.getDate() === 1)
  for (let i = 0; i < Math.min(RETENTION.monthly, firsts.length); i++) {
    keep.add(firsts[i].name)
  }

  let pruned = 0
  for (const backup of backups) {
    if (!keep.has(backup.name)) {
      try {
        await unlink(backup.path)
        pruned++
        logger.info({ file: backup.name }, '[wiki-backup] pruned old backup')
      } catch (err) {
        logger.warn({ file: backup.name, err }, '[wiki-backup] failed to prune backup')
      }
    }
  }

  return pruned
}

// ============================================================
// WikiBackupSkill
// ============================================================

export class WikiBackupSkill {
  private db: Database
  private pushover: PushoverService
  private backupDir: string
  private wikiRepoPath: string

  constructor(opts: {
    db: Database
    pushover?: PushoverService
    backupDir?: string
    wikiRepoPath?: string
  }) {
    this.db = opts.db
    this.pushover = opts.pushover ?? new PushoverService()
    this.backupDir = opts.backupDir ?? DEFAULT_BACKUP_DIR
    this.wikiRepoPath = opts.wikiRepoPath ?? DEFAULT_WIKI_REPO
  }

  async execute(options: WikiBackupOptions = {}): Promise<WikiBackupResult> {
    const startMs = Date.now()
    const backupDir = options.backupDir ?? this.backupDir
    const wikiRepoPath = options.wikiRepoPath ?? this.wikiRepoPath

    logger.info({ backupDir, wikiRepoPath }, '[wiki-backup] starting wiki backup')

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
    const filename = `wiki_${ts}.bundle`
    const filePath = join(backupDir, filename)

    try {
      // Create git bundle containing all refs
      await execFileAsync('git', [
        '-C', wikiRepoPath,
        'bundle', 'create', filePath,
        '--all',
      ], {
        timeout: 120_000, // 2 minutes
      })

      // Get file size
      const stats = await stat(filePath)
      const sizeBytes = stats.size
      const durationSeconds = Math.round((Date.now() - startMs) / 1000)

      // Apply retention
      const prunedCount = await applyRetention(backupDir)

      const result: WikiBackupResult = {
        status: 'success',
        filePath,
        sizeBytes,
        durationSeconds,
        prunedCount,
      }

      await this.logResult(result)

      const sizeMB = (sizeBytes / (1024 * 1024)).toFixed(1)
      await this.notify(
        'Wiki Backup Complete',
        `Bundle: ${filename}\nSize: ${sizeMB} MB\nDuration: ${durationSeconds}s\nPruned: ${prunedCount} old backups`,
        -1,
      )

      logger.info({ filePath, sizeBytes, durationSeconds, prunedCount }, '[wiki-backup] backup complete')

      return result
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      const result = this.failResult(startMs, errorMsg, filePath)
      await this.logResult(result)
      await this.notify(
        'Wiki Backup FAILED',
        `Error: ${errorMsg.slice(0, 500)}`,
        1,
      )
      return result
    }
  }

  // ----------------------------------------------------------
  // Private helpers
  // ----------------------------------------------------------

  private failResult(startMs: number, error: string, filePath?: string): WikiBackupResult {
    logger.error({ error }, '[wiki-backup] backup failed')
    return {
      status: 'failed',
      filePath: filePath ?? null,
      sizeBytes: 0,
      durationSeconds: Math.round((Date.now() - startMs) / 1000),
      prunedCount: 0,
      error,
    }
  }

  private async logResult(result: WikiBackupResult): Promise<void> {
    try {
      await this.db.insert(backup_log).values({
        backup_type: 'wiki',
        file_path: result.filePath,
        size_bytes: result.sizeBytes,
        duration_seconds: result.durationSeconds,
        status: result.status,
        error: result.error ?? null,
        pruned_count: result.prunedCount,
      })
    } catch (err) {
      logger.warn({ err }, '[wiki-backup] failed to write backup_log entry')
    }

    try {
      await this.db.insert(skills_log).values({
        skill_name: 'wiki-backup',
        input_summary: 'wiki git bundle backup',
        output_summary: `status:${result.status} | size:${result.sizeBytes} | duration:${result.durationSeconds}s | pruned:${result.prunedCount}`,
        duration_ms: result.durationSeconds * 1000,
      })
    } catch (err) {
      logger.warn({ err }, '[wiki-backup] failed to write skills_log entry')
    }
  }

  private async notify(title: string, message: string, priority: -2 | -1 | 0 | 1 | 2): Promise<void> {
    if (!this.pushover.isConfigured) return
    try {
      await this.pushover.send({ title: `Open Brain: ${title}`, message, priority })
    } catch (err) {
      logger.warn({ err }, '[wiki-backup] Pushover notification failed')
    }
  }
}

// ============================================================
// Entry point for skill-execution worker
// ============================================================

export async function executeWikiBackup(
  db: Database,
  options: WikiBackupOptions = {},
): Promise<WikiBackupResult> {
  const skill = new WikiBackupSkill({
    db,
    backupDir: options.backupDir ?? process.env.BACKUP_DIR_WIKI ?? DEFAULT_BACKUP_DIR,
    wikiRepoPath: options.wikiRepoPath ?? process.env.WIKI_REPO_PATH ?? DEFAULT_WIKI_REPO,
  })
  return skill.execute(options)
}
