import { z } from 'zod'

const CAPTURE_TYPES = ['decision', 'idea', 'observation', 'task', 'win', 'blocker', 'question', 'reflection'] as const
const CAPTURE_SOURCES = ['slack', 'voice', 'api', 'document'] as const

export const createCaptureSchema = z.object({
  content: z.string().min(1).max(50000),
  capture_type: z.enum(CAPTURE_TYPES),
  brain_view: z.string().min(1), // validated at runtime against ConfigService
  source: z.enum(CAPTURE_SOURCES).default('api'),
  metadata: z.object({
    source_metadata: z.record(z.unknown()).optional(),
    tags: z.array(z.string()).optional().default([]),
    pre_extracted: z.object({
      entities: z.array(z.object({ name: z.string(), type: z.string() })).optional(),
      topics: z.array(z.string()).optional(),
      sentiment: z.enum(['positive', 'negative', 'neutral']).optional(),
    }).optional(),
    captured_at: z.string().datetime().optional(),
  }).optional(),
})

export const updateCaptureSchema = z.object({
  tags: z.array(z.string()).optional(),
  brain_view: z.string().min(1).optional(),
  metadata_overrides: z.record(z.unknown()).optional(),
})

export const listCapturesSchema = z.object({
  limit: z.coerce.number().min(1).max(100).default(20),
  offset: z.coerce.number().min(0).default(0),
  brain_view: z.string().optional(),
  capture_type: z.enum(CAPTURE_TYPES).optional(),
  source: z.enum(CAPTURE_SOURCES).optional(),
  tags: z.string().transform((v: string) => v.split(',')).optional(), // comma-separated query param
  date_from: z.string().datetime().optional(),
  date_to: z.string().datetime().optional(),
  pipeline_status: z.string().optional(),
})

export type CreateCaptureInput = z.infer<typeof createCaptureSchema>
export type UpdateCaptureInput = z.infer<typeof updateCaptureSchema>
export type ListCapturesQuery = z.infer<typeof listCapturesSchema>
