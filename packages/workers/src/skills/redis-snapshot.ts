import { execFile } from 'node:child_process'
import { stat, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Database } from '@open-brain/shared'
import { backup_log, skills_log, logger, PushoverService } from '@open-brain/shared'
import { pruneBackups, DEFAULT_RETENTION } from '../lib/backup-retention.js'
import type { RetentionPolicy } from '../lib/backup-retention.js'

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

export interface RedisSnapshotOptions {
  /** Backup output directory. Default: /backups/redis */
  backupDir?: string
  /** Redis container name for docker exec. Default: open-brain-redis */
  containerName?: string
  /** Path to dump.rdb inside the Redis container. Default: /data/dump.rdb */
  rdbPathInContainer?: string
}

export interface RedisSnapshotResult {
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

const DEFAULT_BACKUP_DIR = '/backups/redis'
const DEFAULT_CONTAINER = 'open-brain-redis'
const DEFAULT_RDB_PATH = '/data/dump.rdb'

/**
 * Apply retention policy to Redis snapshots (.rdb files).
 * Now uses the full daily/weekly/monthly retention policy (standardized
 * across all backup skills) instead of the previous simple count-based approach.
 */
export async function applyRetention(
  backupDir: string,
  retention: RetentionPolicy = DEFAULT_RETENTION,
): Promise<number> {
  return pruneBackups(backupDir, '.rdb', retention, '[redis-snapshot]')
}

// ============================================================
// RedisSnapshotSkill
// ============================================================

export class RedisSnapshotSkill {
  private db: Database
  private pushover: PushoverService
  private backupDir: string
  private containerName: string
  private rdbPathInContainer: string

  constructor(opts: {
    db: Database
    pushover?: PushoverService
    backupDir?: string
    containerName?: string
    rdbPathInContainer?: string
  }) {
    this.db = opts.db
    this.pushover = opts.pushover ?? new PushoverService()
    this.backupDir = opts.backupDir ?? DEFAULT_BACKUP_DIR
    this.containerName = opts.containerName ?? DEFAULT_CONTAINER
    this.rdbPathInContainer = opts.rdbPathInContainer ?? DEFAULT_RDB_PATH
  }

  async execute(options: RedisSnapshotOptions = {}): Promise<RedisSnapshotResult> {
    const startMs = Date.now()
    const backupDir = options.backupDir ?? this.backupDir
    const containerName = options.containerName ?? this.containerName
    const rdbPathInContainer = options.rdbPathInContainer ?? this.rdbPathInContainer

    logger.info({ backupDir, containerName }, '[redis-snapshot] starting Redis snapshot')

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
    const filename = `redis_${ts}.rdb`
    const filePath = join(backupDir, filename)

    try {
      // Trigger BGSAVE inside the Redis container
      await execFileAsync('docker', [
        'exec', containerName,
        'redis-cli', 'BGSAVE',
      ], {
        timeout: 30_000, // 30 seconds
      })

      // Wait briefly for BGSAVE to complete (Redis writes asynchronously)
      // Check LASTSAVE timestamp to confirm completion
      let lastSave: number | null = null
      const beforeSave = Date.now()
      for (let attempt = 0; attempt < 10; attempt++) {
        const { stdout } = await execFileAsync('docker', [
          'exec', containerName,
          'redis-cli', 'LASTSAVE',
        ], { timeout: 10_000 })

        const timestamp = parseInt(stdout.trim(), 10)
        if (!isNaN(timestamp)) {
          // LASTSAVE returns Unix timestamp; check if it's recent (within 30s)
          if (timestamp * 1000 >= beforeSave - 1000) {
            lastSave = timestamp
            break
          }
        }

        // Wait 500ms before retrying
        await new Promise(resolve => setTimeout(resolve, 500))
      }

      if (lastSave === null) {
        logger.warn('[redis-snapshot] could not confirm BGSAVE completion — proceeding with copy')
      }

      // Copy the RDB file out of the container
      await execFileAsync('docker', [
        'cp',
        `${containerName}:${rdbPathInContainer}`,
        filePath,
      ], {
        timeout: 60_000, // 1 minute
      })

      // Get file size
      const stats = await stat(filePath)
      const sizeBytes = stats.size
      const durationSeconds = Math.round((Date.now() - startMs) / 1000)

      // Apply retention
      const prunedCount = await applyRetention(backupDir)

      const result: RedisSnapshotResult = {
        status: 'success',
        filePath,
        sizeBytes,
        durationSeconds,
        prunedCount,
      }

      await this.logResult(result)

      const sizeMB = (sizeBytes / (1024 * 1024)).toFixed(1)
      await this.notify(
        'Redis Snapshot Complete',
        `Snapshot: ${filename}\nSize: ${sizeMB} MB\nDuration: ${durationSeconds}s\nPruned: ${prunedCount} old snapshots`,
        -1,
      )

      logger.info({ filePath, sizeBytes, durationSeconds, prunedCount }, '[redis-snapshot] snapshot complete')

      return result
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      const result = this.failResult(startMs, errorMsg, filePath)
      await this.logResult(result)
      await this.notify(
        'Redis Snapshot FAILED',
        `Error: ${errorMsg.slice(0, 500)}`,
        1,
      )
      return result
    }
  }

  // ----------------------------------------------------------
  // Private helpers
  // ----------------------------------------------------------

  private failResult(startMs: number, error: string, filePath?: string): RedisSnapshotResult {
    logger.error({ error }, '[redis-snapshot] snapshot failed')
    return {
      status: 'failed',
      filePath: filePath ?? null,
      sizeBytes: 0,
      durationSeconds: Math.round((Date.now() - startMs) / 1000),
      prunedCount: 0,
      error,
    }
  }

  private async logResult(result: RedisSnapshotResult): Promise<void> {
    try {
      await this.db.insert(backup_log).values({
        backup_type: 'redis',
        file_path: result.filePath,
        size_bytes: result.sizeBytes,
        duration_seconds: result.durationSeconds,
        status: result.status,
        error: result.error ?? null,
        pruned_count: result.prunedCount,
      })
    } catch (err) {
      logger.warn({ err }, '[redis-snapshot] failed to write backup_log entry')
    }

    try {
      await this.db.insert(skills_log).values({
        skill_name: 'redis-snapshot',
        input_summary: 'Redis BGSAVE + copy',
        output_summary: `status:${result.status} | size:${result.sizeBytes} | duration:${result.durationSeconds}s | pruned:${result.prunedCount}`,
        duration_ms: result.durationSeconds * 1000,
      })
    } catch (err) {
      logger.warn({ err }, '[redis-snapshot] failed to write skills_log entry')
    }
  }

  private async notify(title: string, message: string, priority: -2 | -1 | 0 | 1 | 2): Promise<void> {
    if (!this.pushover.isConfigured) return
    try {
      await this.pushover.send({ title: `Open Brain: ${title}`, message, priority })
    } catch (err) {
      logger.warn({ err }, '[redis-snapshot] Pushover notification failed')
    }
  }
}

// ============================================================
// Entry point for skill-execution worker
// ============================================================

export async function executeRedisSnapshot(
  db: Database,
  options: RedisSnapshotOptions = {},
): Promise<RedisSnapshotResult> {
  const skill = new RedisSnapshotSkill({
    db,
    backupDir: options.backupDir ?? process.env.BACKUP_DIR_REDIS ?? DEFAULT_BACKUP_DIR,
    containerName: options.containerName ?? process.env.REDIS_CONTAINER ?? DEFAULT_CONTAINER,
    rdbPathInContainer: options.rdbPathInContainer ?? DEFAULT_RDB_PATH,
  })
  return skill.execute(options)
}
