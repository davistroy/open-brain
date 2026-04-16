/**
 * Loads email classification rules from email-categories.yaml.
 *
 * Normalizes sender rules (lowercase), keyword rules (lowercase),
 * and builds the full categories set from all groups.
 */

import { readFileSync } from 'node:fs'
import yaml from 'js-yaml'
import { logger } from '../../lib/logger.js'

export interface EmailRules {
  /** Group name -> list of category names */
  groups: Record<string, string[]>
  /** Lowercase domain or email -> category */
  senderRules: Map<string, string>
  /** Category -> list of lowercase keywords */
  keywordRules: Map<string, string[]>
  /** All valid category names (from groups) */
  categories: Set<string>
  /** Confidence threshold for auto-move (default 0.85) */
  autoMoveThreshold: number
  /** Jetson LLM config (informational — actual routing via ai-routing.yaml) */
  jetson: { baseUrl: string; model: string; maxTokens: number; temperature: number }
  /** Protected folder names that should never be touched */
  protectedFolders: string[]
  /** Max age in days for spam cleanup */
  spamMaxAgeDays: number
}

interface RawConfig {
  groups: Record<string, string[]>
  sender_rules: Record<string, string>
  keyword_rules: Record<string, string[]>
  protected_folders?: string[]
  spam_max_age_days?: number
  auto_move_threshold?: number
  jetson?: {
    base_url?: string
    model?: string
    max_completion_tokens?: number
    temperature?: number
  }
}

/**
 * Load and normalize email classification rules from a YAML config file.
 *
 * - Sender rules are lowercased for case-insensitive matching
 * - Keyword lists are lowercased for case-insensitive matching
 * - Categories set is built from all group values
 */
export function loadEmailRules(configPath: string): EmailRules {
  const raw = readFileSync(configPath, 'utf-8')
  const cfg = yaml.load(raw) as RawConfig

  if (!cfg.groups || !cfg.sender_rules || !cfg.keyword_rules) {
    throw new Error(`Invalid email-categories.yaml: missing required sections (groups, sender_rules, keyword_rules)`)
  }

  // Build categories set from all groups
  const categories = new Set<string>()
  for (const cats of Object.values(cfg.groups)) {
    for (const cat of cats) {
      categories.add(cat)
    }
  }

  // Normalize sender rules: lowercase keys
  const senderRules = new Map<string, string>()
  for (const [key, value] of Object.entries(cfg.sender_rules)) {
    senderRules.set(key.toLowerCase(), value)
  }

  // Normalize keyword rules: lowercase keywords
  const keywordRules = new Map<string, string[]>()
  for (const [category, keywords] of Object.entries(cfg.keyword_rules)) {
    keywordRules.set(category, keywords.map((kw) => kw.toLowerCase()))
  }

  const jcfg = cfg.jetson ?? {}

  const rules: EmailRules = {
    groups: cfg.groups,
    senderRules,
    keywordRules,
    categories,
    autoMoveThreshold: cfg.auto_move_threshold ?? 0.85,
    jetson: {
      baseUrl: jcfg.base_url ?? 'http://192.168.10.58:8080/v1',
      model: jcfg.model ?? 'qwen3.5-4b',
      maxTokens: jcfg.max_completion_tokens ?? 256,
      temperature: jcfg.temperature ?? 0.1,
    },
    protectedFolders: cfg.protected_folders ?? [],
    spamMaxAgeDays: cfg.spam_max_age_days ?? 30,
  }

  logger.info(
    {
      categories: categories.size,
      senderRules: senderRules.size,
      keywordRules: keywordRules.size,
      autoMoveThreshold: rules.autoMoveThreshold,
    },
    `Loaded email rules: ${categories.size} categories, ${senderRules.size} sender rules, ${keywordRules.size} keyword rule sets`,
  )

  return rules
}
