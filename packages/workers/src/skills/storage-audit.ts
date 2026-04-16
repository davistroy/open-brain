import { sql } from 'drizzle-orm'
import { execFile, type ExecFileOptions } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import type { Database } from '@open-brain/shared'
import { skills_log, logger, PushoverService } from '@open-brain/shared'
import type { WikiGitService } from '@open-brain/shared'

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

export interface StorageAuditOptions {
  /** Override "now" for deterministic testing. */
  now?: Date
  /** Wiki output directory (relative to wiki root). Default: operations/storage-reports */
  wikiDir?: string
  /** Postgres container name. Default: open-brain-postgres */
  postgresContainer?: string
  /** Redis container name. Default: open-brain-redis */
  redisContainer?: string
  /** Database name. Default: openbrain */
  dbName?: string
  /** Database user. Default: openbrain */
  dbUser?: string
  /** Backup directory. Default: /backups */
  backupDir?: string
  /** Wiki repo path. Default: /wiki */
  wikiRepoPath?: string
}

export interface StorageMetrics {
  postgres: {
    dbSizeBytes: number
    dbSizeHuman: string
    tableCount: number
    captureCount: number
    captureGrowthRate: number  // captures per day over last 30 days
  }
  redis: {
    usedMemoryBytes: number
    usedMemoryHuman: string
    keyCount: number
  }
  backups: {
    totalSizeBytes: number
    totalSizeHuman: string
    fileCount: number
  }
  wiki: {
    repoSizeBytes: number
    repoSizeHuman: string
    pageCount: number
  }
}

export interface StorageAuditResult {
  metrics: StorageMetrics
  wikiPageWritten: boolean
  durationMs: number
}

// ============================================================
// Constants
// ============================================================

const DEFAULT_WIKI_DIR = 'operations/storage-reports'
const DEFAULT_POSTGRES_CONTAINER = 'open-brain-postgres'
const DEFAULT_REDIS_CONTAINER = 'open-brain-redis'
const DEFAULT_DB_NAME = 'openbrain'
const DEFAULT_DB_USER = 'openbrain'
const DEFAULT_BACKUP_DIR = '/backups'
const DEFAULT_WIKI_REPO_PATH = '/wiki'

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`
}

// ============================================================
// StorageAuditSkill
// ============================================================

/**
 * StorageAuditSkill — weekly storage report.
 *
 * Runs Sundays at 3 AM. Reports on:
 * - Postgres DB size, table count, capture count + growth rate
 * - Redis memory usage and key count
 * - Backup storage used (all backup dirs combined)
 * - Wiki repo size and page count
 *
 * Writes report to wiki/operations/storage-reports/
 *
 * All external calls (docker exec, du) are wrapped in try/catch
 * so partial failures don't prevent the rest of the report.
 */
export class StorageAuditSkill {
  private db: Database
  private pushover: PushoverService
  private wikiService?: WikiGitService
  private wikiDir: string

  /** Injectable command executor for testing. */
  private execFn: typeof execFileAsync

  constructor(opts: {
    db: Database
    pushover?: PushoverService
    wikiService?: WikiGitService
    wikiDir?: string
    /** Override command executor for testing. */
    execFn?: typeof execFileAsync
  }) {
    this.db = opts.db
    this.pushover = opts.pushover ?? new PushoverService()
    this.wikiService = opts.wikiService
    this.wikiDir = opts.wikiDir ?? DEFAULT_WIKI_DIR
    this.execFn = opts.execFn ?? execFileAsync
  }

  async execute(options: StorageAuditOptions = {}): Promise<StorageAuditResult> {
    const startMs = Date.now()
    const now = options.now ?? new Date()
    const postgresContainer = options.postgresContainer ?? DEFAULT_POSTGRES_CONTAINER
    const redisContainer = options.redisContainer ?? DEFAULT_REDIS_CONTAINER
    const dbName = options.dbName ?? DEFAULT_DB_NAME
    const dbUser = options.dbUser ?? DEFAULT_DB_USER
    const backupDir = options.backupDir ?? DEFAULT_BACKUP_DIR
    const wikiRepoPath = options.wikiRepoPath ?? DEFAULT_WIKI_REPO_PATH

    logger.info('[storage-audit] starting execution')

    // Gather all metrics in parallel where possible
    const [postgres, redis, backups, wiki] = await Promise.all([
      this.getPostgresMetrics(postgresContainer, dbName, dbUser),
      this.getRedisMetrics(redisContainer),
      this.getBackupMetrics(backupDir),
      this.getWikiMetrics(wikiRepoPath),
    ])

    const metrics: StorageMetrics = { postgres, redis, backups, wiki }

    // Write wiki report
    const dateStr = now.toISOString().split('T')[0]
    const wikiPageWritten = await this.writeWikiReport(dateStr, metrics, now)

    const durationMs = Date.now() - startMs

    // Log to skills_log
    await this.logToSkillsLog(metrics, wikiPageWritten, durationMs)

    logger.info(
      { dbSize: postgres.dbSizeHuman, redisMemory: redis.usedMemoryHuman, backupSize: backups.totalSizeHuman, durationMs },
      '[storage-audit] execution complete',
    )

    return { metrics, wikiPageWritten, durationMs }
  }

  // ----------------------------------------------------------
  // Private: Postgres metrics
  // ----------------------------------------------------------

  private async getPostgresMetrics(
    container: string,
    dbName: string,
    dbUser: string,
  ): Promise<StorageMetrics['postgres']> {
    const defaults = { dbSizeBytes: 0, dbSizeHuman: 'unknown', tableCount: 0, captureCount: 0, captureGrowthRate: 0 }

    try {
      // DB size via SQL (more reliable than docker exec)
      const sizeRows = await this.db.execute<{ size_bytes: string }>(sql`
        SELECT pg_database_size(current_database())::text AS size_bytes
      `)
      const dbSizeBytes = Number(sizeRows.rows[0]?.size_bytes ?? 0)

      // Table count
      const tableRows = await this.db.execute<{ count: string }>(sql`
        SELECT COUNT(*)::text AS count
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_type = 'BASE TABLE'
      `)
      const tableCount = Number(tableRows.rows[0]?.count ?? 0)

      // Capture count
      const captureRows = await this.db.execute<{ count: string }>(sql`
        SELECT COUNT(*)::text AS count
        FROM captures
        WHERE deleted_at IS NULL
      `)
      const captureCount = Number(captureRows.rows[0]?.count ?? 0)

      // Growth rate: captures per day over last 30 days
      const growthRows = await this.db.execute<{ count: string }>(sql`
        SELECT COUNT(*)::text AS count
        FROM captures
        WHERE deleted_at IS NULL
          AND created_at >= NOW() - INTERVAL '30 days'
      `)
      const recentCaptures = Number(growthRows.rows[0]?.count ?? 0)
      const captureGrowthRate = Number((recentCaptures / 30).toFixed(1))

      return {
        dbSizeBytes,
        dbSizeHuman: formatBytes(dbSizeBytes),
        tableCount,
        captureCount,
        captureGrowthRate,
      }
    } catch (err) {
      logger.warn({ err }, '[storage-audit] failed to get Postgres metrics')
      return defaults
    }
  }

  // ----------------------------------------------------------
  // Private: Redis metrics
  // ----------------------------------------------------------

  private async getRedisMetrics(container: string): Promise<StorageMetrics['redis']> {
    const defaults = { usedMemoryBytes: 0, usedMemoryHuman: 'unknown', keyCount: 0 }

    try {
      const { stdout } = await this.execFn('docker', [
        'exec', container,
        'redis-cli', 'INFO', 'memory',
      ])

      const memoryMatch = String(stdout).match(/used_memory:(\d+)/)
      const usedMemoryBytes = memoryMatch ? Number(memoryMatch[1]) : 0

      const humanMatch = String(stdout).match(/used_memory_human:(.+)/)
      const usedMemoryHuman = humanMatch ? humanMatch[1].trim() : formatBytes(usedMemoryBytes)

      // Get key count
      const { stdout: dbsizeOut } = await this.execFn('docker', [
        'exec', container,
        'redis-cli', 'DBSIZE',
      ])
      // DBSIZE output: "DB 0 has 1234 keys" — extract the count (not the DB number)
      const keyMatch = String(dbsizeOut).match(/(\d+)\s*key/)
      const keyCount = keyMatch ? Number(keyMatch[1]) : 0

      return { usedMemoryBytes, usedMemoryHuman, keyCount }
    } catch (err) {
      logger.warn({ err }, '[storage-audit] failed to get Redis metrics')
      return defaults
    }
  }

  // ----------------------------------------------------------
  // Private: Backup storage metrics
  // ----------------------------------------------------------

  private async getBackupMetrics(backupDir: string): Promise<StorageMetrics['backups']> {
    const defaults = { totalSizeBytes: 0, totalSizeHuman: 'unknown', fileCount: 0 }

    try {
      const { stdout } = await this.execFn('du', ['-sb', backupDir])
      const sizeMatch = String(stdout).match(/^(\d+)/)
      const totalSizeBytes = sizeMatch ? Number(sizeMatch[1]) : 0

      const { stdout: countOut } = await this.execFn('find', [backupDir, '-type', 'f', '-name', '*.gz', '-o', '-name', '*.bundle', '-o', '-name', '*.rdb'])
      const fileCount = String(countOut).trim().split('\n').filter(Boolean).length

      return { totalSizeBytes, totalSizeHuman: formatBytes(totalSizeBytes), fileCount }
    } catch (err) {
      logger.warn({ err }, '[storage-audit] failed to get backup metrics')
      return defaults
    }
  }

  // ----------------------------------------------------------
  // Private: Wiki repo metrics
  // ----------------------------------------------------------

  private async getWikiMetrics(wikiRepoPath: string): Promise<StorageMetrics['wiki']> {
    const defaults = { repoSizeBytes: 0, repoSizeHuman: 'unknown', pageCount: 0 }

    try {
      const { stdout } = await this.execFn('du', ['-sb', wikiRepoPath])
      const sizeMatch = String(stdout).match(/^(\d+)/)
      const repoSizeBytes = sizeMatch ? Number(sizeMatch[1]) : 0

      const { stdout: countOut } = await this.execFn('find', [wikiRepoPath, '-name', '*.md', '-type', 'f'])
      const pageCount = String(countOut).trim().split('\n').filter(Boolean).length

      return { repoSizeBytes, repoSizeHuman: formatBytes(repoSizeBytes), pageCount }
    } catch (err) {
      logger.warn({ err }, '[storage-audit] failed to get wiki metrics')
      return defaults
    }
  }

  // ----------------------------------------------------------
  // Private: wiki report
  // ----------------------------------------------------------

  private async writeWikiReport(
    dateStr: string,
    metrics: StorageMetrics,
    now: Date,
  ): Promise<boolean> {
    const lines: string[] = []

    lines.push('---')
    lines.push(`title: "Storage Audit ${dateStr}"`)
    lines.push(`created: ${now.toISOString()}`)
    lines.push(`updated: ${now.toISOString()}`)
    lines.push('tags: [storage, operations, infrastructure]')
    lines.push('---')
    lines.push('')
    lines.push(`# Storage Audit — ${dateStr}`)
    lines.push('')

    // Postgres
    lines.push('## PostgreSQL')
    lines.push('')
    lines.push(`| Metric | Value |`)
    lines.push(`|--------|-------|`)
    lines.push(`| Database Size | ${metrics.postgres.dbSizeHuman} |`)
    lines.push(`| Table Count | ${metrics.postgres.tableCount} |`)
    lines.push(`| Active Captures | ${metrics.postgres.captureCount} |`)
    lines.push(`| Capture Growth Rate | ${metrics.postgres.captureGrowthRate}/day (30d avg) |`)
    lines.push('')

    // Redis
    lines.push('## Redis')
    lines.push('')
    lines.push(`| Metric | Value |`)
    lines.push(`|--------|-------|`)
    lines.push(`| Memory Used | ${metrics.redis.usedMemoryHuman} |`)
    lines.push(`| Key Count | ${metrics.redis.keyCount} |`)
    lines.push('')

    // Backups
    lines.push('## Backup Storage')
    lines.push('')
    lines.push(`| Metric | Value |`)
    lines.push(`|--------|-------|`)
    lines.push(`| Total Size | ${metrics.backups.totalSizeHuman} |`)
    lines.push(`| File Count | ${metrics.backups.fileCount} |`)
    lines.push('')

    // Wiki
    lines.push('## Wiki Repository')
    lines.push('')
    lines.push(`| Metric | Value |`)
    lines.push(`|--------|-------|`)
    lines.push(`| Repo Size | ${metrics.wiki.repoSizeHuman} |`)
    lines.push(`| Page Count | ${metrics.wiki.pageCount} |`)
    lines.push('')

    const content = lines.join('\n')
    const pagePath = `${this.wikiDir}/${dateStr}.md`

    // Try wiki service first, fall back to local file
    if (this.wikiService) {
      try {
        const frontmatter = {
          title: `Storage Audit ${dateStr}`,
          type: 'synthesis' as const,
          created: now.toISOString(),
          updated: now.toISOString(),
          tags: ['storage', 'operations', 'infrastructure'],
        }
        await this.wikiService.writePage(
          pagePath,
          content.split('---').slice(2).join('---').trim(),
          frontmatter,
          `storage-audit: ${dateStr} report`,
        )
        return true
      } catch (err) {
        logger.warn({ err }, '[storage-audit] wiki service write failed — falling back to local file')
      }
    }

    // Fallback: write to local wiki directory
    const wikiBase = process.env.WIKI_PATH ?? '/wiki'
    const fullPath = join(wikiBase, pagePath)
    try {
      await mkdir(dirname(fullPath), { recursive: true })
      await writeFile(fullPath, content, 'utf-8')
      return true
    } catch (err) {
      logger.warn({ err, fullPath }, '[storage-audit] failed to write wiki report')
      return false
    }
  }

  // ----------------------------------------------------------
  // Private: skills_log
  // ----------------------------------------------------------

  private async logToSkillsLog(
    metrics: StorageMetrics,
    wikiPageWritten: boolean,
    durationMs: number,
  ): Promise<void> {
    const outputSummary = [
      `db:${metrics.postgres.dbSizeHuman}`,
      `redis:${metrics.redis.usedMemoryHuman}`,
      `backups:${metrics.backups.totalSizeHuman}`,
      `wiki:${metrics.wiki.repoSizeHuman}`,
      `captures:${metrics.postgres.captureCount}`,
      `growth:${metrics.postgres.captureGrowthRate}/day`,
      `wiki_written:${wikiPageWritten}`,
    ].join(' | ')

    try {
      await this.db.insert(skills_log).values({
        skill_name: 'storage-audit',
        input_summary: 'weekly storage audit',
        output_summary: outputSummary,
        duration_ms: durationMs,
      })
    } catch (err) {
      logger.warn({ err }, '[storage-audit] failed to write skills_log entry')
    }
  }
}

// ============================================================
// Entry point for skill-execution worker
// ============================================================

export async function executeStorageAudit(
  db: Database,
  options: StorageAuditOptions = {},
  wikiService?: WikiGitService,
): Promise<StorageAuditResult> {
  const skill = new StorageAuditSkill({
    db,
    wikiService,
  })
  return skill.execute(options)
}
