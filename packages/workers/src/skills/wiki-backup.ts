import { execFile, type ExecFileOptions } from 'node:child_process'
import { stat, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Database } from '@open-brain/shared'
import { backup_log, logger } from '@open-brain/shared'
import { BaseSkill } from './base-skill.js'
import type { BaseResult, BaseSkillOpts } from './types.js'
import { pruneBackups, DEFAULT_RETENTION } from '../lib/backup-retention.js'
import type { RetentionPolicy } from '../lib/backup-retention.js'

function execFileAsync(cmd: string, args: string[], opts: ExecFileOptions = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) return reject(err)
      resolve({ stdout: String(stdout), stderr: String(stderr) })
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

export interface WikiBackupResult extends BaseResult {
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

/**
 * Apply retention policy to wiki backups (.bundle files).
 * Delegates to shared pruneBackups utility.
 */
export async function applyRetention(
  backupDir: string,
  retention: RetentionPolicy = DEFAULT_RETENTION,
): Promise<number> {
  return pruneBackups(backupDir, '.bundle', retention, '[wiki-backup]')
}

// ============================================================
// WikiBackupSkill
// ============================================================

export interface WikiBackupSkillOpts extends BaseSkillOpts {
  backupDir?: string
  wikiRepoPath?: string
}

export class WikiBackupSkill extends BaseSkill<WikiBackupOptions, WikiBackupResult> {
  private backupDir: string
  private wikiRepoPath: string

  constructor(opts: WikiBackupSkillOpts) {
    super('wiki-backup', opts)
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
      await this.logBackupResult(result)
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
        durationMs: durationSeconds * 1000,
      }

      await this.logBackupResult(result)

      const sizeMB = (sizeBytes / (1024 * 1024)).toFixed(1)
      await this.sendNotification(
        'Open Brain: Wiki Backup Complete',
        `Bundle: ${filename}\nSize: ${sizeMB} MB\nDuration: ${durationSeconds}s\nPruned: ${prunedCount} old backups`,
        -1,
      )

      logger.info({ filePath, sizeBytes, durationSeconds, prunedCount }, '[wiki-backup] backup complete')

      return result
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      const result = this.failResult(startMs, errorMsg, filePath)
      await this.logBackupResult(result)
      await this.sendNotification(
        'Open Brain: Wiki Backup FAILED',
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
    const durationSeconds = Math.round((Date.now() - startMs) / 1000)
    return {
      status: 'failed',
      filePath: filePath ?? null,
      sizeBytes: 0,
      durationSeconds,
      prunedCount: 0,
      error,
      durationMs: durationSeconds * 1000,
    }
  }

  private async logBackupResult(result: WikiBackupResult): Promise<void> {
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

    await super.logResult(
      result,
      'wiki git bundle backup',
      `status:${result.status} | size:${result.sizeBytes} | duration:${result.durationSeconds}s | pruned:${result.prunedCount}`,
    )
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
