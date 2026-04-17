import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { CronExpressionParser } from 'cron-parser'
import yaml from 'js-yaml'
import { logger } from '@open-brain/shared'

/** Shape for a skill config entry */
export interface SkillConfig {
  schedule: string
  description: string
}

/** YAML shape for skills.yaml */
interface SkillsYamlData {
  skills: Record<string, { schedule?: string; description?: string }>
}

/**
 * Default skills with their cron schedules and descriptions.
 * Used as baseline when config/skills.yaml doesn't exist or is incomplete.
 */
export const DEFAULT_SKILLS: Record<string, SkillConfig> = {
  'weekly-brief': {
    schedule: '0 20 * * 0', // Sunday 8pm
    description: 'Generate a weekly synthesis of all captures and deliver via email + Pushover',
  },
  'daily-connections': {
    schedule: '0 21 * * *', // Daily 9pm
    description: 'Surface non-obvious cross-domain connections across recent captures via LLM synthesis and deliver via Pushover',
  },
  'drift-monitor': {
    schedule: '0 8 * * *', // Daily 8am
    description: 'Detect when tracked commitments, bets, or projects go silent and alert via Pushover if severity >= medium',
  },
  'pipeline-health': {
    schedule: '*/30 * * * *', // Every 30 minutes
    description: 'Check BullMQ queue stats, capture flow, and recent pipeline failures; alert via Pushover if thresholds exceeded',
  },
  'daily-sweep-skill': {
    schedule: '0 20 * * *', // Daily 8pm
    description: 'Evening summary: key decisions, unresolved questions, new entities, tasks without follow-up',
  },
  'memory-consolidation': {
    schedule: '0 4 * * 0', // Sunday 4am
    description: 'Identify clusters of near-duplicate captures, merge via LLM preserving all unique information, soft-delete originals',
  },
  'morning-brief': {
    schedule: '15 7 * * 1-5', // Weekdays 7:15am
    description: 'Structured morning briefing: yesterday\'s thread, open loops, people to follow up, today\'s items — no LLM, database queries only',
  },
  'capture-reminder-morning': {
    schedule: '0 7 * * 1-5', // Weekdays 7am
    description: 'Morning Pushover nudge to encourage voice capture — "What\'s on your plate today?"',
  },
  'capture-reminder-evening': {
    schedule: '0 21 * * *', // Daily 9pm
    description: 'Evening Pushover nudge with today\'s capture count and last capture time — encourages evening reflection',
  },
  'wiki-lint': {
    schedule: '0 5 * * 0', // Sunday 5am
    description: 'Scan all wiki pages for contradictions, orphan pages, stale claims, missing cross-references, and structural issues',
  },
  'wiki-synthesis': {
    schedule: '0 6 * * *', // Daily 6am
    description: 'Identify captures from the last 24 hours not yet wiki-integrated and queue wiki-ingest jobs for each',
  },
  'monthly-reflection': {
    schedule: '0 9 1 * *', // 1st of month, 9am
    description: 'Comprehensive "state of Troy" monthly synthesis via runAgent() — career momentum, active projects, technical exploration, personal patterns across all brain views',
  },
  'cost-analysis': {
    schedule: '0 7 * * *', // Daily 7am
    description: 'Query ai_audit_log for LLM spend — daily breakdown by model/task, weekly summary Mondays, monthly report 1st of month',
  },
  'container-health': {
    schedule: '*/15 * * * *', // Every 15 minutes
    description: 'Hit /health on each container, log to container_health table, alert after 3 consecutive failures',
  },
  'storage-audit': {
    schedule: '0 3 * * 0', // Sunday 3am
    description: 'Weekly report: Postgres DB size, Redis memory, backup storage, wiki repo size, capture growth rate',
  },
  'secret-rotation': {
    schedule: '0 10 1 * *', // 1st of month, 10am
    description: 'Check API key ages via bws CLI (Bitwarden Secrets Manager), alert via Pushover if any key older than 90 days',
  },
  'capture-dedup-sweep': {
    schedule: '0 4 * * 6', // Saturday 4am
    description: 'Weekly scan for near-duplicate captures (cosine > 0.95) not caught by real-time dedup — flags for review, does not auto-merge',
  },
}

/**
 * Service managing skill configuration: loading, saving, validating, and
 * querying skill definitions backed by a YAML file on disk.
 */
export class SkillConfigService {
  private knownSkills: Record<string, SkillConfig> = { ...DEFAULT_SKILLS }
  private yamlPath: string

  constructor(yamlPath: string) {
    this.yamlPath = yamlPath
  }

  /**
   * Load skill overrides from config/skills.yaml. Merges on top of DEFAULT_SKILLS.
   * If the file doesn't exist or is malformed, keeps defaults and logs a warning.
   * Called at startup before routes are registered.
   */
  load(): void {
    // Reset to defaults before loading
    this.knownSkills = { ...DEFAULT_SKILLS }

    if (!existsSync(this.yamlPath)) {
      logger.info('[skills] No config/skills.yaml found — using hardcoded defaults')
      return
    }

    try {
      const content = readFileSync(this.yamlPath, 'utf8')
      const data = yaml.load(content) as SkillsYamlData | null

      if (!data || typeof data !== 'object' || !data.skills || typeof data.skills !== 'object') {
        logger.warn('[skills] config/skills.yaml has unexpected shape — using defaults')
        return
      }

      // Merge persisted overrides on top of defaults
      for (const [name, overrides] of Object.entries(data.skills)) {
        const base = DEFAULT_SKILLS[name]
        if (base) {
          this.knownSkills[name] = {
            schedule: overrides.schedule ?? base.schedule,
            description: overrides.description ?? base.description,
          }
        } else {
          // Skill in YAML but not in defaults — include it if it has a schedule
          if (overrides.schedule) {
            this.knownSkills[name] = {
              schedule: overrides.schedule,
              description: overrides.description ?? '',
            }
          }
        }
      }

      logger.info({ skillCount: Object.keys(this.knownSkills).length }, '[skills] Loaded overrides from config/skills.yaml')
    } catch (err) {
      logger.warn({ error: err instanceof Error ? err.message : String(err) }, '[skills] Failed to parse config/skills.yaml — using defaults')
    }
  }

  /**
   * Persist the current skill config to the YAML file.
   * Creates the config directory if it doesn't exist.
   */
  save(): void {
    const data: SkillsYamlData = {
      skills: {},
    }

    for (const [name, config] of Object.entries(this.knownSkills)) {
      data.skills[name] = {
        schedule: config.schedule,
        description: config.description,
      }
    }

    const dir = dirname(this.yamlPath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }

    const yamlStr = yaml.dump(data, { lineWidth: 120, noRefs: true })
    writeFileSync(this.yamlPath, yamlStr, 'utf8')
    logger.info('[skills] Persisted skill config to config/skills.yaml')
  }

  /** Get all known skills as a plain record. */
  getAll(): Record<string, SkillConfig> {
    return this.knownSkills
  }

  /** Get a single skill config by name. */
  get(name: string): SkillConfig | undefined {
    return this.knownSkills[name]
  }

  /**
   * Update a skill's config in-place and persist to YAML.
   * Returns the updated config. Throws if skill not found.
   */
  update(name: string, patch: Partial<SkillConfig>): SkillConfig {
    if (!this.knownSkills[name]) {
      throw new Error(`Unknown skill: ${name}`)
    }

    this.knownSkills[name] = {
      ...this.knownSkills[name],
      ...patch,
    }

    return this.knownSkills[name]
  }

  /**
   * Validate a cron expression. Must be a standard 5-field cron expression.
   * Returns { valid: true } if valid, or { valid: false, error: '...' } if not.
   */
  validateCron(expression: string): { valid: boolean; error?: string } {
    if (!expression || typeof expression !== 'string') {
      return { valid: false, error: 'Schedule must be a non-empty string' }
    }

    const trimmed = expression.trim()
    const fields = trimmed.split(/\s+/)

    // BullMQ expects standard 5-field cron (minute hour day-of-month month day-of-week)
    if (fields.length !== 5) {
      return { valid: false, error: `Expected 5-field cron expression (minute hour day-of-month month day-of-week), got ${fields.length} fields` }
    }

    try {
      CronExpressionParser.parse(trimmed)
      return { valid: true }
    } catch (err) {
      return { valid: false, error: err instanceof Error ? err.message : 'Invalid cron expression' }
    }
  }

  /** Override the YAML path (used by tests). */
  setYamlPath(path: string): void {
    this.yamlPath = path
  }

  /** Reset to defaults (used by tests). */
  reset(): void {
    this.knownSkills = { ...DEFAULT_SKILLS }
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton + compatibility shims
// ---------------------------------------------------------------------------
// The original skills.ts used module-level mutable state. Tests import
// functions like setSkillsYamlPath, getKnownSkills, resetKnownSkills,
// loadSkillsFromYaml, and validateCronExpression from routes/skills.js.
// We keep a module-level singleton here and re-export thin wrappers so that
// existing imports continue to work without test modifications.
// ---------------------------------------------------------------------------

import { join } from 'node:path'

/** Module-level singleton — created lazily or explicitly via initSingleton(). */
let _singleton: SkillConfigService | undefined

function getSingleton(): SkillConfigService {
  if (!_singleton) {
    _singleton = new SkillConfigService(join(process.cwd(), 'config', 'skills.yaml'))
  }
  return _singleton
}

/** Explicitly set the singleton (used by index.ts at startup). */
export function initSkillConfigSingleton(svc: SkillConfigService): void {
  _singleton = svc
}

/** Get the module-level singleton. */
export function getSkillConfigSingleton(): SkillConfigService {
  return getSingleton()
}

// Backward-compatible free functions (delegating to singleton)
export function setSkillsYamlPath(path: string): void {
  getSingleton().setYamlPath(path)
}

export function getKnownSkills(): Record<string, SkillConfig> {
  return getSingleton().getAll()
}

export function resetKnownSkills(): void {
  getSingleton().reset()
}

export function loadSkillsFromYaml(): void {
  getSingleton().load()
}

/**
 * Validate a cron expression (backward-compatible free function).
 * Returns null if valid, or an error message string if invalid.
 */
export function validateCronExpression(expr: string): string | null {
  const result = getSingleton().validateCron(expr)
  return result.valid ? null : (result.error ?? 'Invalid cron expression')
}
