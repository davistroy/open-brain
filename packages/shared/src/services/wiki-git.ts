import { simpleGit, type SimpleGit, type LogResult } from 'simple-git'
import { readFile, writeFile, readdir, mkdir, stat } from 'node:fs/promises'
import { join, relative, extname } from 'node:path'
import { existsSync } from 'node:fs'
import { createLogger } from '../lib/logger.js'

const logger = createLogger('wiki-git')

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Standard YAML frontmatter fields for wiki pages. */
export interface WikiFrontmatter {
  title: string
  type: 'entity' | 'concept' | 'source' | 'comparison' | 'synthesis' | 'overview'
  created: string
  updated: string
  source_count?: number
  tags?: string[]
  aliases?: string[]
  [key: string]: unknown
}

/** A parsed wiki page with separated frontmatter and body content. */
export interface WikiPage {
  /** Path relative to wiki root (e.g., "entities/kubernetes.md"). */
  path: string
  /** Parsed YAML frontmatter metadata. */
  frontmatter: WikiFrontmatter
  /** Markdown body content (everything after the frontmatter block). */
  content: string
}

/** Summary entry from git log. */
export interface WikiChange {
  hash: string
  date: string
  message: string
  files: string[]
}

/** Wiki repository health status. */
export interface WikiRepoStatus {
  initialized: boolean
  repoUrl: string
  localPath: string
  pageCount: number
  lastCommitHash: string | null
  lastCommitDate: string | null
  lastCommitMessage: string | null
  error: string | null
}

// ---------------------------------------------------------------------------
// Frontmatter parsing / serialization
// ---------------------------------------------------------------------------

const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

/**
 * Parse YAML frontmatter from a markdown string.
 * Uses simple key-value parsing to avoid a js-yaml dependency in the hot path
 * (js-yaml is available in shared but we keep this self-contained and testable).
 */
export function parseFrontmatter(raw: string): { frontmatter: WikiFrontmatter; content: string } {
  const match = raw.match(FRONTMATTER_REGEX)
  if (!match) {
    return {
      frontmatter: { title: '', type: 'overview', created: '', updated: '' },
      content: raw,
    }
  }

  const yamlBlock = match[1]
  const content = match[2]

  const fm: Record<string, unknown> = {}
  let currentKey = ''
  let inArray = false
  let arrayValues: string[] = []

  for (const line of yamlBlock.split('\n')) {
    const trimmed = line.trim()

    // Array continuation: "  - value"
    if (inArray && trimmed.startsWith('- ')) {
      arrayValues.push(trimmed.slice(2).trim())
      continue
    }

    // If we were in an array, flush it
    if (inArray) {
      fm[currentKey] = arrayValues
      inArray = false
      arrayValues = []
    }

    // Skip empty lines / comments
    if (!trimmed || trimmed.startsWith('#')) continue

    // Key: value pair
    const colonIdx = trimmed.indexOf(':')
    if (colonIdx === -1) continue

    const key = trimmed.slice(0, colonIdx).trim()
    const value = trimmed.slice(colonIdx + 1).trim()

    if (value === '') {
      // Might be start of an array
      currentKey = key
      inArray = true
      arrayValues = []
      continue
    }

    // Inline array: [a, b, c]
    if (value.startsWith('[') && value.endsWith(']')) {
      fm[key] = value
        .slice(1, -1)
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean)
      continue
    }

    // Numeric
    if (/^\d+$/.test(value)) {
      fm[key] = parseInt(value, 10)
      continue
    }

    // Strip quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      fm[key] = value.slice(1, -1)
      continue
    }

    fm[key] = value
  }

  // Flush trailing array
  if (inArray) {
    fm[currentKey] = arrayValues
  }

  return {
    frontmatter: {
      title: (fm.title as string) ?? '',
      type: (fm.type as WikiFrontmatter['type']) ?? 'overview',
      created: (fm.created as string) ?? '',
      updated: (fm.updated as string) ?? '',
      ...(fm.source_count !== undefined ? { source_count: fm.source_count as number } : {}),
      ...(fm.tags ? { tags: fm.tags as string[] } : {}),
      ...(fm.aliases ? { aliases: fm.aliases as string[] } : {}),
      // Preserve any extra fields
      ...Object.fromEntries(Object.entries(fm).filter(([k]) => !['title', 'type', 'created', 'updated', 'source_count', 'tags', 'aliases'].includes(k))),
    },
    content,
  }
}

/**
 * Serialize frontmatter + content back to a markdown string with YAML frontmatter block.
 */
export function serializeFrontmatter(frontmatter: WikiFrontmatter, content: string): string {
  const lines: string[] = ['---']

  for (const [key, value] of Object.entries(frontmatter)) {
    if (value === undefined || value === null) continue

    if (Array.isArray(value)) {
      if (value.length === 0) continue
      lines.push(`${key}:`)
      for (const item of value) {
        lines.push(`  - ${item}`)
      }
    } else {
      lines.push(`${key}: ${value}`)
    }
  }

  lines.push('---')
  lines.push('')

  return lines.join('\n') + content
}

// ---------------------------------------------------------------------------
// WikiGitService
// ---------------------------------------------------------------------------

export interface WikiGitServiceOptions {
  /** Remote repository URL (SSH or HTTPS). */
  repoUrl: string
  /** Local filesystem path for the cloned wiki. */
  localPath: string
}

/**
 * Git-backed wiki storage service.
 *
 * Manages a local clone of a Gitea wiki repository, providing read/write
 * operations with automatic YAML frontmatter parsing and Git commit/push.
 *
 * Concurrency safety: callers (BullMQ workers) must serialize access via
 * queue concurrency=1. This class does NOT implement internal locking.
 */
export class WikiGitService {
  private readonly repoUrl: string
  private readonly localPath: string
  private git: SimpleGit | null = null

  constructor(opts: WikiGitServiceOptions) {
    this.repoUrl = opts.repoUrl
    this.localPath = opts.localPath
  }

  // -------------------------------------------------------------------------
  // Initialization
  // -------------------------------------------------------------------------

  /**
   * Initialize the local wiki repository.
   * Clones if the local path doesn't exist; pulls latest if it does.
   */
  async init(): Promise<void> {
    if (existsSync(join(this.localPath, '.git'))) {
      logger.info({ localPath: this.localPath }, 'Wiki repo exists, pulling latest')
      const git = simpleGit(this.localPath)
      await git.pull('origin', 'main')
      this.git = git
    } else {
      logger.info({ repoUrl: this.repoUrl, localPath: this.localPath }, 'Cloning wiki repo')
      await mkdir(this.localPath, { recursive: true })
      const git = simpleGit()
      await git.clone(this.repoUrl, this.localPath)
      this.git = simpleGit(this.localPath)
    }
  }

  // -------------------------------------------------------------------------
  // Read operations
  // -------------------------------------------------------------------------

  /**
   * Read a wiki page by relative path.
   * @param pagePath - Path relative to wiki root (e.g., "entities/kubernetes.md")
   * @returns Parsed wiki page, or null if the file doesn't exist.
   */
  async readPage(pagePath: string): Promise<WikiPage | null> {
    const fullPath = join(this.localPath, pagePath)

    try {
      const raw = await readFile(fullPath, 'utf-8')
      const { frontmatter, content } = parseFrontmatter(raw)
      return { path: pagePath, frontmatter, content }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return null
      }
      throw err
    }
  }

  /**
   * List all .md files in the wiki, optionally filtered to a directory.
   * Returns parsed frontmatter metadata for each page (content is NOT included
   * to keep memory usage bounded).
   */
  async listPages(directory?: string): Promise<Omit<WikiPage, 'content'>[]> {
    const searchDir = directory ? join(this.localPath, directory) : this.localPath
    const pages: Omit<WikiPage, 'content'>[] = []

    await this.walkDir(searchDir, async (filePath) => {
      if (extname(filePath) !== '.md') return
      // Skip root-level schema/meta files unless explicitly listing root
      const relPath = relative(this.localPath, filePath).replace(/\\/g, '/')

      try {
        const raw = await readFile(filePath, 'utf-8')
        const { frontmatter } = parseFrontmatter(raw)
        pages.push({ path: relPath, frontmatter })
      } catch {
        logger.warn({ filePath }, 'Failed to read wiki page for listing')
      }
    })

    return pages
  }

  /**
   * Get recent changes from git log.
   * @param limit - Maximum number of log entries to return (default: 20).
   */
  async getRecentChanges(limit = 20): Promise<WikiChange[]> {
    this.ensureInitialized()

    const log: LogResult = await this.git!.log({
      maxCount: limit,
      '--stat': null,
    })

    return log.all.map((entry) => ({
      hash: entry.hash,
      date: entry.date,
      message: entry.message,
      files: entry.diff?.files?.map((f) => f.file) ?? [],
    }))
  }

  // -------------------------------------------------------------------------
  // Write operations
  // -------------------------------------------------------------------------

  /**
   * Write a wiki page with YAML frontmatter and markdown content.
   * Creates parent directories if needed. Auto-sets the `updated` field.
   *
   * @param pagePath - Path relative to wiki root (e.g., "entities/kubernetes.md")
   * @param content - Markdown body content (without frontmatter).
   * @param frontmatter - YAML frontmatter metadata.
   * @param commitMessage - Git commit message.
   */
  async writePage(
    pagePath: string,
    content: string,
    frontmatter: WikiFrontmatter,
    commitMessage: string,
  ): Promise<void> {
    this.ensureInitialized()

    const fullPath = join(this.localPath, pagePath)
    const dir = fullPath.substring(0, fullPath.lastIndexOf('/') !== -1 ? fullPath.lastIndexOf('/') : fullPath.lastIndexOf('\\'))

    // Ensure parent directory exists
    await mkdir(dir, { recursive: true })

    // Update the `updated` timestamp
    const updatedFm: WikiFrontmatter = {
      ...frontmatter,
      updated: new Date().toISOString().slice(0, 10),
    }

    const fileContent = serializeFrontmatter(updatedFm, content)
    await writeFile(fullPath, fileContent, 'utf-8')

    // Stage, commit, push
    await this.git!.add(pagePath)
    await this.git!.commit(commitMessage, pagePath)
    await this.git!.push('origin', 'main')

    logger.info({ pagePath, commitMessage }, 'Wiki page written and pushed')
  }

  /**
   * Stage all changes, commit with the given message, and push to origin.
   */
  async commitAndPush(message: string): Promise<void> {
    this.ensureInitialized()

    await this.git!.add('.')
    const result = await this.git!.commit(message)

    if (result.summary.changes === 0) {
      logger.info('No changes to commit')
      return
    }

    await this.git!.push('origin', 'main')
    logger.info({ message, changes: result.summary.changes }, 'Wiki changes committed and pushed')
  }

  // -------------------------------------------------------------------------
  // Health / status
  // -------------------------------------------------------------------------

  /**
   * Get the current status of the wiki repository for health reporting.
   * Returns a snapshot including initialization state, page count, and
   * last commit info. Never throws — returns error details in the result.
   */
  async getStatus(): Promise<WikiRepoStatus> {
    const base: WikiRepoStatus = {
      initialized: this.git !== null,
      repoUrl: this.repoUrl,
      localPath: this.localPath,
      pageCount: 0,
      lastCommitHash: null,
      lastCommitDate: null,
      lastCommitMessage: null,
      error: null,
    }

    if (!this.git) {
      base.error = 'WikiGitService not initialized'
      return base
    }

    try {
      // Get last commit
      const log = await this.git.log({ maxCount: 1 })
      if (log.latest) {
        base.lastCommitHash = log.latest.hash
        base.lastCommitDate = log.latest.date
        base.lastCommitMessage = log.latest.message
      }

      // Count pages (lightweight — just count .md files)
      const pages = await this.listPages()
      base.pageCount = pages.length
    } catch (err) {
      base.error = err instanceof Error ? err.message : String(err)
    }

    return base
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private ensureInitialized(): void {
    if (!this.git) {
      throw new Error('WikiGitService not initialized — call init() first')
    }
  }

  /** Recursively walk a directory, calling `fn` for each file. */
  private async walkDir(dir: string, fn: (filePath: string) => Promise<void>): Promise<void> {
    try {
      const entries = await readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = join(dir, entry.name)
        if (entry.isDirectory()) {
          // Skip .git directory
          if (entry.name === '.git') continue
          await this.walkDir(fullPath, fn)
        } else {
          await fn(fullPath)
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
      throw err
    }
  }
}
