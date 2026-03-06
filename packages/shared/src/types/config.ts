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
export const AIModelConfigSchema = z.object({
  fast: z.string(),
  synthesis: z.string(),
  governance: z.string(),
  intent: z.string(),
  embedding: z.string(),
})

export const AIConfigSchema = z.object({
  litellm_url: z.string().url(),
  models: AIModelConfigSchema,
  monthly_budget: z.object({
    soft_limit_usd: z.number().default(30),
    hard_limit_usd: z.number().default(50),
  }),
})

export type AIConfig = z.infer<typeof AIConfigSchema>

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
