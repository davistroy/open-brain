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

function loadOne<T>(filePath: string, schema: z.ZodType<T>): T {
  if (!existsSync(filePath)) {
    throw new Error(`Config file not found: ${filePath}`)
  }
  const raw = parseYaml(filePath)
  return schema.parse(raw)
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
        const value = loadOne(join(this.configDir, file), schema as z.ZodType)
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
}
