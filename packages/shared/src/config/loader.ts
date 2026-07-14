import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { z } from 'zod'
import { createLogger } from '../lib/logger.js'
import {
  PipelineConfigSchema,
  AIConfigSchema,
  BrainViewsConfigSchema,
  NotificationConfigSchema,
  type PipelineConfig,
  type AIConfig,
  type BrainViewsConfig,
  type NotificationConfig,
  type ModelTierEntry,
  type TaskRoutingConfig,
} from '../types/config.js'
import { validateAiRoutingConfig } from '../services/ai-config-schema.js'

const logger = createLogger('config-service')

export interface LoadedConfigs {
  pipeline: PipelineConfig
  ai: AIConfig
  brainViews: BrainViewsConfig
  notifications: NotificationConfig
}

export interface ReloadResult {
  file: string
  success: boolean
  error?: string
}

function parseYaml(filePath: string): unknown {
  const content = readFileSync(filePath, 'utf8')
  return yaml.load(content)
}

function loadOne<S extends z.ZodTypeAny>(filePath: string, schema: S): z.output<S> {
  if (!existsSync(filePath)) {
    throw new Error(`Config file not found: ${filePath}`)
  }
  const raw = parseYaml(filePath)
  return schema.parse(raw) as z.output<S>
}

export class ConfigService {
  private configDir: string
  private configs: LoadedConfigs | null = null

  constructor(configDir: string) {
    this.configDir = configDir
  }

  /**
   * Validate task_routing: warn if any task references a tier key not present in model_tiers.
   * Non-fatal -- logs warnings but does not throw.
   */
  private validateTaskRouting(aiConfig: AIConfig): void {
    if (!aiConfig.task_routing || !aiConfig.model_tiers) return
    for (const [task, tierKey] of Object.entries(aiConfig.task_routing)) {
      if (!aiConfig.model_tiers[tierKey]) {
        logger.warn(
          { task, tierKey },
          `task_routing references non-existent tier '${tierKey}' for task '${task}'`,
        )
      }
    }
  }

  /**
   * Load all config files. Throws on first validation error (fail-fast at startup).
   */
  load(): void {
    this.configs = {
      pipeline: loadOne(join(this.configDir, 'pipeline.yaml'), PipelineConfigSchema),
      ai: loadOne(join(this.configDir, 'ai-routing.yaml'), AIConfigSchema),
      brainViews: loadOne(join(this.configDir, 'brain-views.yaml'), BrainViewsConfigSchema),
      notifications: loadOne(join(this.configDir, 'notifications.yaml'), NotificationConfigSchema),
    }
    validateAiRoutingConfig(this.configs.ai)
  }

  /**
   * Reload all config files. On error, keeps previous valid config and returns error details.
   */
  reload(): ReloadResult[] {
    const results: ReloadResult[] = []
    // SA-5: snapshot the current ai config so a semantically-invalid hot-reload
    // can be rolled back to the last-known-good instead of taking effect.
    const prevAi = this.configs?.ai
    const files = [
      { key: 'pipeline' as const, file: 'pipeline.yaml', schema: PipelineConfigSchema },
      { key: 'ai' as const, file: 'ai-routing.yaml', schema: AIConfigSchema },
      { key: 'brainViews' as const, file: 'brain-views.yaml', schema: BrainViewsConfigSchema },
      { key: 'notifications' as const, file: 'notifications.yaml', schema: NotificationConfigSchema },
    ]

    for (const { key, file, schema } of files) {
      try {
        const value = loadOne(join(this.configDir, file), schema as z.ZodTypeAny)
        if (this.configs) {
          ;(this.configs as unknown as Record<string, unknown>)[key] = value
        }
        results.push({ file, success: true })
      } catch (err) {
        results.push({
          file,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // SA-5: run the SAME throwing validator load() uses (validateAiRoutingConfig),
    // but NON-fatally — a bad hot-reload must reject and keep the previous config,
    // never crash the running process. Schema validation happened in the loop
    // above; this catches semantic errors the weak validateTaskRouting only warned
    // about (missing tier, non-existent fallback, cost-blind paid tier).
    if (this.configs) {
      try {
        validateAiRoutingConfig(this.configs.ai)
      } catch (err) {
        if (prevAi) (this.configs as unknown as Record<string, unknown>).ai = prevAi
        const msg = err instanceof Error ? err.message : String(err)
        const aiResult = results.find((r) => r.file === 'ai-routing.yaml')
        if (aiResult) {
          aiResult.success = false
          aiResult.error = msg
        } else {
          results.push({ file: 'ai-routing.yaml', success: false, error: msg })
        }
        logger.error(
          { err },
          'ai-routing.yaml reload rejected — kept previous config (semantic validation failed)',
        )
      }
      // Keep the warn-level tier check for finer detail on the (now valid) config.
      this.validateTaskRouting(this.configs.ai)
    }

    return results
  }

  get<K extends keyof LoadedConfigs>(key: K): LoadedConfigs[K] {
    if (!this.configs) {
      throw new Error('ConfigService not loaded. Call load() first.')
    }
    return this.configs[key]
  }

  getBrainViews(): string[] {
    return this.get('brainViews').views.map(v => v.name)
  }

  getNotificationsConfig(): NotificationConfig {
    return this.get('notifications')
  }

  /**
   * Get a model tier entry by tier key (e.g., 't0_local', 't1_fast', 't2_quality').
   * Returns undefined if model_tiers is not configured or the key is unknown.
   */
  getModelTier(tierKey: string): ModelTierEntry | undefined {
    const aiConfig = this.get('ai')
    return aiConfig.model_tiers?.[tierKey]
  }

  /**
   * Get the tier key for a given task name, then resolve to the full tier entry.
   * Returns undefined if task_routing or model_tiers is not configured,
   * or if the task or its mapped tier is unknown.
   */
  getTaskTier(taskName: string): ModelTierEntry | undefined {
    const aiConfig = this.get('ai')
    const tierKey = aiConfig.task_routing?.[taskName]
    if (!tierKey) return undefined
    return aiConfig.model_tiers?.[tierKey]
  }

  /**
   * Get the tier key string for a given task name.
   * Returns undefined if task_routing is not configured or the task is unknown.
   */
  getTaskTierKey(taskName: string): string | undefined {
    const aiConfig = this.get('ai')
    return aiConfig.task_routing?.[taskName]
  }

  /**
   * Get all task routing mappings.
   * Returns undefined if task_routing is not configured.
   */
  getTaskRouting(): TaskRoutingConfig | undefined {
    return this.get('ai').task_routing
  }

  /**
   * Check if three-tier routing is configured.
   */
  hasThreeTierRouting(): boolean {
    const aiConfig = this.get('ai')
    return !!(aiConfig.model_tiers && aiConfig.task_routing)
  }

  /**
   * Get the monthly budget limits from AI config.
   */
  getMonthlyBudget(): { soft_limit_usd: number; hard_limit_usd: number } {
    return this.get('ai').monthly_budget
  }
}
