import { pgTable, text, timestamp, integer, real, boolean, jsonb, uuid, index, uniqueIndex } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { vector } from './types.js'

// ============================================================
// captures table
// ============================================================
export const captures = pgTable(
  'captures',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    content: text('content').notNull(),
    content_hash: text('content_hash').notNull(),
    capture_type: text('capture_type').notNull(), // decision | idea | observation | task | win | blocker | question | reflection
    brain_view: text('brain_view').notNull(),      // career | personal | technical | work-internal | client
    source: text('source').notNull(),              // slack | voice | api | document
    source_metadata: jsonb('source_metadata'),
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
    embedding: vector('embedding'),
    pipeline_status: text('pipeline_status').notNull().default('pending'), // pending | processing | complete | failed
    pipeline_attempts: integer('pipeline_attempts').notNull().default(0),
    pipeline_error: text('pipeline_error'),
    pipeline_completed_at: timestamp('pipeline_completed_at', { withTimezone: true }),
    pre_extracted: jsonb('pre_extracted'),         // entities, topics extracted by ingestion source
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    captured_at: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
    deleted_at: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => ({
    content_hash_idx: uniqueIndex('captures_content_hash_idx').on(table.content_hash),
    capture_type_idx: index('captures_capture_type_idx').on(table.capture_type),
    brain_view_idx: index('captures_brain_view_idx').on(table.brain_view),
    source_idx: index('captures_source_idx').on(table.source),
    pipeline_status_idx: index('captures_pipeline_status_idx').on(table.pipeline_status),
    created_at_idx: index('captures_created_at_idx').on(table.created_at),
    // Partial index for active (non-deleted) captures — WHERE deleted_at IS NULL
    // Created via custom SQL migration (Drizzle cannot generate partial indexes natively)
    // HNSW index for vector similarity search — created via custom SQL migration (Drizzle cannot generate this natively)
    // GIN index for full-text search — also created via custom SQL migration
  }),
)

// ============================================================
// pipeline_events table — audit log for pipeline stages
// ============================================================
export const pipeline_events = pgTable(
  'pipeline_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    capture_id: uuid('capture_id').notNull().references(() => captures.id, { onDelete: 'cascade' }),
    stage: text('stage').notNull(),               // classify | embed | extract | link_entities | check_triggers | notify
    status: text('status').notNull(),             // started | success | failed
    duration_ms: integer('duration_ms'),
    error: text('error'),
    metadata: jsonb('metadata'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    capture_id_idx: index('pipeline_events_capture_id_idx').on(table.capture_id),
    stage_idx: index('pipeline_events_stage_idx').on(table.stage),
    created_at_idx: index('pipeline_events_created_at_idx').on(table.created_at),
  }),
)

// ============================================================
// ai_audit_log table — tracks all LLM/embedding calls
// ============================================================
export const ai_audit_log = pgTable(
  'ai_audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    task_type: text('task_type').notNull(),        // classify | embed | synthesize | govern | intent
    model: text('model').notNull(),
    prompt_tokens: integer('prompt_tokens'),
    completion_tokens: integer('completion_tokens'),
    total_tokens: integer('total_tokens'),
    duration_ms: integer('duration_ms'),
    capture_id: uuid('capture_id').references(() => captures.id, { onDelete: 'set null' }),
    session_id: uuid('session_id'),               // forward ref — sessions table created in supporting tables
    error: text('error'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    task_type_idx: index('ai_audit_log_task_type_idx').on(table.task_type),
    created_at_idx: index('ai_audit_log_created_at_idx').on(table.created_at),
    capture_id_idx: index('ai_audit_log_capture_id_idx').on(table.capture_id),
  }),
)
