import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { z } from 'zod'
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
   * Load all config files. Throws on first validation error (fail-fast at startup).
   */
  load(): void {
    this.configs = {
      pipeline: loadOne(join(this.configDir, 'pipeline.yaml'), PipelineConfigSchema),
      ai: loadOne(join(this.configDir, 'ai-routing.yaml'), AIConfigSchema),
      brainViews: loadOne(join(this.configDir, 'brain-views.yaml'), BrainViewsConfigSchema),
      notifications: loadOne(join(this.configDir, 'notifications.yaml'), NotificationConfigSchema),
    }
  }

  /**
   * Reload all config files. On error, keeps previous valid config and returns error details.
   */
  reload(): ReloadResult[] {
    const results: ReloadResult[] = []
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
          // @ts-ignore — dynamic key assignment
          this.configs[key] = value
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
}
