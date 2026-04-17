import { z } from 'zod'

// ============================================================
// Ingest / file-upload API contracts
//
// Zod schemas covering the HTTP surface for CS3 (dashboard
// Wave 1 upload backend). These schemas describe:
//   - upload request metadata + response
//   - list query + list response rows
//   - manual "process inbox now" trigger
//   - BullMQ `ingest-process` job payload
//   - SSE `upload:status` events
//   - sidecar `/process` response envelope
//
// Drizzle table definitions for `file_uploads` live in
// `supporting.ts` (owned by CS3.2). This file is Zod-only.
// ============================================================

// ---------- Primitives ----------

/** Allowed sources — matches the bind-mount subfolder + sidecar container. */
export const IngestSourceTypeSchema = z.enum(['financial', 'utility'])
export type IngestSourceType = z.infer<typeof IngestSourceTypeSchema>

/** Lifecycle of a single file upload row. Mirrors the `file_upload_status` PG enum. */
export const FileUploadStatusSchema = z.enum([
  'pending',
  'processing',
  'parsed',
  'failed',
])
export type FileUploadStatus = z.infer<typeof FileUploadStatusSchema>

// ---------- Upload request / response ----------

/**
 * Metadata posted alongside the multipart file body. All fields optional:
 * when omitted, the core-api `ingest-router` derives `source_type` and
 * `parser_hint` from the filename (and optional header-byte sniff).
 */
export const UploadFileMetadataSchema = z.object({
  filename: z.string().min(1).max(512).optional(),
  size_bytes: z.number().int().nonnegative().optional(),
  mime_type: z.string().max(255).optional(),
  source_type: IngestSourceTypeSchema.optional(),
  parser_hint: z.string().min(1).max(64).optional(),
})
export type UploadFileMetadata = z.infer<typeof UploadFileMetadataSchema>

/** Response from `POST /api/v1/ingest/upload`. */
export const UploadFileResponseSchema = z.object({
  upload_id: z.string().uuid(),
  status: FileUploadStatusSchema,
  filename: z.string(),
  size_bytes: z.number().int().nonnegative(),
  source_type: IngestSourceTypeSchema,
  parser_hint: z.string().nullable(),
  destination_path: z.string(),
  uploaded_at: z.string().datetime(),
})
export type UploadFileResponse = z.infer<typeof UploadFileResponseSchema>

// ---------- List uploads ----------

/** Query params for `GET /api/v1/ingest/uploads`. */
export const ListUploadsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().nonnegative().default(0),
  status: FileUploadStatusSchema.optional(),
  source_type: IngestSourceTypeSchema.optional(),
})
export type ListUploadsQuery = z.infer<typeof ListUploadsQuerySchema>

/** Capture-id + short title snippet joined onto a file upload row for the UI. */
export const UploadCaptureSummarySchema = z.object({
  id: z.string().uuid(),
  title_snippet: z.string(),
})
export type UploadCaptureSummary = z.infer<typeof UploadCaptureSummarySchema>

/** Single row returned by the list endpoint. */
export const FileUploadRowSchema = z.object({
  id: z.string().uuid(),
  filename: z.string(),
  size_bytes: z.number().int().nonnegative(),
  mime_type: z.string().nullable(),
  source_type: IngestSourceTypeSchema,
  parser_hint: z.string().nullable(),
  destination_path: z.string(),
  uploaded_at: z.string().datetime(),
  status: FileUploadStatusSchema,
  capture_ids: z.array(z.string().uuid()),
  captures: z.array(UploadCaptureSummarySchema).default([]),
  error_message: z.string().nullable(),
  processed_at: z.string().datetime().nullable(),
  duration_ms: z.number().int().nonnegative().nullable(),
})
export type FileUploadRow = z.infer<typeof FileUploadRowSchema>

/** Envelope for the paginated list response. */
export const ListUploadsResponseSchema = z.object({
  uploads: z.array(FileUploadRowSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
})
export type ListUploadsResponse = z.infer<typeof ListUploadsResponseSchema>

// ---------- Single upload fetch ----------

/** Path param for `GET /api/v1/ingest/uploads/:id`. */
export const GetUploadParamsSchema = z.object({
  id: z.string().uuid(),
})
export type GetUploadParams = z.infer<typeof GetUploadParamsSchema>

// ---------- Process-now trigger ----------

/** Query params for `POST /api/v1/ingest/process-now`. */
export const ProcessNowQuerySchema = z.object({
  source: IngestSourceTypeSchema.optional(),
})
export type ProcessNowQuery = z.infer<typeof ProcessNowQuerySchema>

/** Response from `POST /api/v1/ingest/process-now`. */
export const ProcessNowResponseSchema = z.object({
  source: IngestSourceTypeSchema,
  enqueued: z.boolean(),
  message: z.string().optional(),
})
export type ProcessNowResponse = z.infer<typeof ProcessNowResponseSchema>

// ---------- BullMQ job payload ----------

/** Payload for the `ingest-process` BullMQ job. */
export const IngestProcessJobDataSchema = z.object({
  upload_id: z.string().uuid(),
  source_type: IngestSourceTypeSchema,
  destination_path: z.string(),
  parser_hint: z.string().nullable().optional(),
})
export type IngestProcessJobData = z.infer<typeof IngestProcessJobDataSchema>

// ---------- Sidecar /process response ----------

/** Envelope returned by the sidecar trigger_server on `POST /process`. */
export const SidecarProcessResponseSchema = z.object({
  status: z.enum(['ok', 'error']),
  captures_posted: z.array(z.string().uuid()).default([]),
  errors: z.array(z.string()).default([]),
  duration_ms: z.number().int().nonnegative(),
})
export type SidecarProcessResponse = z.infer<typeof SidecarProcessResponseSchema>

// ---------- SSE upload:status events ----------

const UploadEventBaseSchema = z.object({
  upload_id: z.string().uuid(),
  filename: z.string(),
  source_type: IngestSourceTypeSchema,
  at: z.string().datetime(),
})

export const UploadStartedEventSchema = UploadEventBaseSchema.extend({
  type: z.literal('started'),
  size_bytes: z.number().int().nonnegative(),
})
export type UploadStartedEvent = z.infer<typeof UploadStartedEventSchema>

export const UploadProgressEventSchema = UploadEventBaseSchema.extend({
  type: z.literal('progress'),
  status: FileUploadStatusSchema,
  message: z.string().optional(),
})
export type UploadProgressEvent = z.infer<typeof UploadProgressEventSchema>

export const UploadCompletedEventSchema = UploadEventBaseSchema.extend({
  type: z.literal('completed'),
  status: z.literal('parsed'),
  capture_ids: z.array(z.string().uuid()).default([]),
  duration_ms: z.number().int().nonnegative(),
})
export type UploadCompletedEvent = z.infer<typeof UploadCompletedEventSchema>

export const UploadFailedEventSchema = UploadEventBaseSchema.extend({
  type: z.literal('failed'),
  status: z.literal('failed'),
  error_message: z.string(),
  duration_ms: z.number().int().nonnegative().optional(),
})
export type UploadFailedEvent = z.infer<typeof UploadFailedEventSchema>

/** Discriminated union of SSE `upload:status` events. */
export const UploadStatusEventSchema = z.discriminatedUnion('type', [
  UploadStartedEventSchema,
  UploadProgressEventSchema,
  UploadCompletedEventSchema,
  UploadFailedEventSchema,
])
export type UploadStatusEvent = z.infer<typeof UploadStatusEventSchema>
