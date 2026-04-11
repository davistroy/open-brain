import { z } from 'zod'

// ============================================================
// Pipeline config schema
// ============================================================
export const PipelineStageSchema = z.object({
  name: z.string(),
  enabled: z.boolean().default(true),
  timeout_ms: z.number().default(30000),
})

export const PipelineConfigSchema = z.object({
  stages: z.array(PipelineStageSchema),
  retry: z.object({
    max_attempts: z.number().default(5),
    backoff_ms: z.array(z.number()).default([30000, 120000, 600000, 1800000, 7200000]),
  }),
  daily_sweep_cron: z.string().default('0 3 * * *'),
})

export type PipelineConfig = z.infer<typeof PipelineConfigSchema>

// ============================================================
// AI routing config schema
// ============================================================

/** Client preference for a model alias */
export type AIClientType = 'anthropic' | 'litellm'

/** Detailed model entry with client routing and cost tracking */
export const AIModelEntrySchema = z.object({
  model: z.string(),
  client: z.enum(['anthropic', 'litellm']).default('litellm'),
  cost_per_1k_input: z.number().default(0),
  cost_per_1k_output: z.number().default(0),
})

export type AIModelEntry = z.infer<typeof AIModelEntrySchema>

/**
 * Accepts either a string (legacy: just the model name, defaults to litellm client)
 * or a full AIModelEntry object. Normalizes to AIModelEntry.
 */
const AIModelValueSchema = z.union([
  z.string().transform((model): z.infer<typeof AIModelEntrySchema> => ({
    model,
    client: 'litellm',
    cost_per_1k_input: 0,
    cost_per_1k_output: 0,
  })),
  AIModelEntrySchema,
])

export const AIModelConfigSchema = z.object({
  fast: AIModelValueSchema,
  synthesis: AIModelValueSchema,
  governance: AIModelValueSchema,
  intent: AIModelValueSchema,
  conversation: AIModelValueSchema.optional(),
  embedding: AIModelValueSchema,
})

export type AIModelConfig = z.infer<typeof AIModelConfigSchema>

/** Known model alias names */
export type AIModelAlias = keyof AIModelConfig

export const AIConfigSchema = z.object({
  litellm_url: z.string().url(),
  models: AIModelConfigSchema,
  monthly_budget: z.object({
    soft_limit_usd: z.number().default(30),
    hard_limit_usd: z.number().default(50),
  }),
})

export type AIConfig = z.infer<typeof AIConfigSchema>

/**
 * Resolve a model alias to the concrete model name string.
 * Works with both legacy (string) and new (object) config formats.
 */
export function resolveModelName(config: AIConfig, alias: string): string {
  const entry = config.models[alias as keyof typeof config.models]
  if (!entry) throw new Error(`Unknown model alias: ${alias}`)
  return entry.model
}

/**
 * Get the full model entry for an alias, including client and cost info.
 */
export function getModelEntry(config: AIConfig, alias: string): AIModelEntry {
  const entry = config.models[alias as keyof typeof config.models]
  if (!entry) throw new Error(`Unknown model alias: ${alias}`)
  return entry
}

// ============================================================
// Brain views config schema
// ============================================================
export const BrainViewConfigSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  default_capture_types: z.array(z.string()).optional(),
})

export const BrainViewsConfigSchema = z.object({
  views: z.array(BrainViewConfigSchema),
})

export type BrainViewsConfig = z.infer<typeof BrainViewsConfigSchema>

// ============================================================
// Notification config schema
// ============================================================
export const NotificationConfigSchema = z.object({
  pushover: z.object({
    enabled: z.boolean().default(false),
    user_key: z.string().optional(),
    app_token: z.string().optional(),
  }),
  weekly_brief: z.object({
    enabled: z.boolean().default(true),
    cron: z.string().default('0 8 * * 1'), // Monday 8am
    brain_views: z.array(z.string()).optional(),
  }),
})

export type NotificationConfig = z.infer<typeof NotificationConfigSchema>
