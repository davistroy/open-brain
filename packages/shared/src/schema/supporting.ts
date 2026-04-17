import { pgTable, text, timestamp, integer, real, boolean, jsonb, uuid, index, uniqueIndex, varchar, bigint } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { captures } from './core.js'
import { vector } from './types.js'

// ============================================================
// entities table
// ============================================================
export const entities = pgTable(
  'entities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    entity_type: text('entity_type').notNull(), // person | org | project | concept | place | tool
    canonical_name: text('canonical_name').notNull(),
    aliases: text('aliases').array().notNull().default(sql`'{}'::text[]`),
    metadata: jsonb('metadata'),
    first_seen_at: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    last_seen_at: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    name_type_idx: uniqueIndex('entities_name_type_idx').on(table.name, table.entity_type),
    entity_type_idx: index('entities_entity_type_idx').on(table.entity_type),
    canonical_name_idx: index('entities_canonical_name_idx').on(table.canonical_name),
  }),
)

// ============================================================
// entity_links table — links entities to captures
// ============================================================
export const entity_links = pgTable(
  'entity_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entity_id: uuid('entity_id').notNull().references(() => entities.id, { onDelete: 'cascade' }),
    capture_id: uuid('capture_id').notNull().references(() => captures.id, { onDelete: 'cascade' }),
    relationship: text('relationship'), // mentioned | authored | referenced | decided_about
    confidence: real('confidence'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    entity_id_idx: index('entity_links_entity_id_idx').on(table.entity_id),
    capture_id_idx: index('entity_links_capture_id_idx').on(table.capture_id),
    entity_capture_idx: uniqueIndex('entity_links_entity_capture_idx').on(table.entity_id, table.capture_id),
  }),
)

// ============================================================
// entity_relationships table — co-occurrence graph between entities
//
// When two or more entities appear in the same capture (via entity_links),
// a relationship row is created or strengthened between each pair.
// Relationships are undirected: entity_id_a < entity_id_b (UUID lexicographic)
// enforces a canonical ordering so (A,B) and (B,A) never duplicate.
//
// co_occurrence_count — incremented each time both entities appear in the same capture.
// weight — derived score used for graph traversal (co_occurrence_count normalized
//          against entity frequency; updated by the link-entities pipeline stage).
// last_seen_at — timestamp of the most recent co-occurring capture.
// ============================================================
export const entity_relationships = pgTable(
  'entity_relationships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entity_id_a: uuid('entity_id_a').notNull().references(() => entities.id, { onDelete: 'cascade' }),
    entity_id_b: uuid('entity_id_b').notNull().references(() => entities.id, { onDelete: 'cascade' }),
    co_occurrence_count: integer('co_occurrence_count').notNull().default(1),
    weight: real('weight').notNull().default(1.0),
    last_seen_at: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Canonical pair ordering enforced at insert time (entity_id_a < entity_id_b)
    entity_pair_idx: uniqueIndex('entity_relationships_pair_idx').on(table.entity_id_a, table.entity_id_b),
    entity_id_a_idx: index('entity_relationships_entity_id_a_idx').on(table.entity_id_a),
    entity_id_b_idx: index('entity_relationships_entity_id_b_idx').on(table.entity_id_b),
    last_seen_at_idx: index('entity_relationships_last_seen_at_idx').on(table.last_seen_at),
  }),
)

// ============================================================
// sessions table — governance and review sessions
// ============================================================
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    session_type: text('session_type').notNull(), // governance | review | planning
    status: text('status').notNull().default('active'), // active | paused | complete | abandoned
    config: jsonb('config'),
    context_capture_ids: text('context_capture_ids').array().notNull().default(sql`'{}'::text[]`),
    summary: text('summary'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    completed_at: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => ({
    session_type_idx: index('sessions_session_type_idx').on(table.session_type),
    status_idx: index('sessions_status_idx').on(table.status),
    created_at_idx: index('sessions_created_at_idx').on(table.created_at),
  }),
)

// ============================================================
// session_messages table — transcript of governance conversations
// ============================================================
export const session_messages = pgTable(
  'session_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    session_id: uuid('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
    role: text('role').notNull(), // user | assistant
    content: text('content').notNull(),
    metadata: jsonb('metadata'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    session_id_idx: index('session_messages_session_id_idx').on(table.session_id),
    created_at_idx: index('session_messages_created_at_idx').on(table.created_at),
  }),
)

// ============================================================
// bets table — explicit predictions / bets tracked over time
// ============================================================
export const bets = pgTable(
  'bets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    statement: text('statement').notNull(),
    confidence: real('confidence').notNull(), // 0.0–1.0
    domain: text('domain'),
    resolution_date: timestamp('resolution_date', { withTimezone: true }),
    resolution: text('resolution'), // correct | incorrect | ambiguous | pending
    resolution_notes: text('resolution_notes'),
    session_id: uuid('session_id').references(() => sessions.id, { onDelete: 'set null' }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    domain_idx: index('bets_domain_idx').on(table.domain),
    resolution_idx: index('bets_resolution_idx').on(table.resolution),
    resolution_date_idx: index('bets_resolution_date_idx').on(table.resolution_date),
  }),
)

// ============================================================
// skills_log table — tracks which AI skills have been applied
// ============================================================
export const skills_log = pgTable(
  'skills_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    skill_name: text('skill_name').notNull(),
    capture_id: uuid('capture_id').references(() => captures.id, { onDelete: 'set null' }),
    session_id: uuid('session_id').references(() => sessions.id, { onDelete: 'set null' }),
    input_summary: text('input_summary'),
    output_summary: text('output_summary'),
    result: jsonb('result'),
    duration_ms: integer('duration_ms'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    skill_name_idx: index('skills_log_skill_name_idx').on(table.skill_name),
    created_at_idx: index('skills_log_created_at_idx').on(table.created_at),
  }),
)

// ============================================================
// triggers table — semantic push notification triggers
// ============================================================
export const triggers = pgTable(
  'triggers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    description: text('description'),
    condition_text: text('condition_text').notNull(), // natural language condition
    embedding: vector('embedding'),                   // vector(768) for semantic matching
    threshold: real('threshold').notNull().default(0.8),
    action: text('action').notNull(),                 // notify | log | create_capture
    action_config: jsonb('action_config'),
    enabled: boolean('enabled').notNull().default(true),
    last_triggered_at: timestamp('last_triggered_at', { withTimezone: true }),
    trigger_count: integer('trigger_count').notNull().default(0),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    name_idx: uniqueIndex('triggers_name_idx').on(table.name),
    enabled_idx: index('triggers_enabled_idx').on(table.enabled),
  }),
)

// ============================================================
// capture_associations table — Hebbian learning (co-access tracking)
//
// When multiple captures appear together in search results,
// an association row is created or strengthened between each pair.
// Associations are undirected: capture_id_a < capture_id_b (UUID lexicographic)
// enforces a canonical ordering so (A,B) and (B,A) never duplicate.
//
// co_access_count — incremented each time both captures appear in the same search.
// weight — Hebbian weight with time decay:
//          weight = co_access_count * exp(-0.005 * hours_since_last_co_access)
// last_co_access — timestamp of the most recent co-access event.
// ============================================================
export const captureAssociations = pgTable(
  'capture_associations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    capture_id_a: uuid('capture_id_a').notNull().references(() => captures.id, { onDelete: 'cascade' }),
    capture_id_b: uuid('capture_id_b').notNull().references(() => captures.id, { onDelete: 'cascade' }),
    co_access_count: integer('co_access_count').notNull().default(1),
    weight: real('weight').notNull().default(1.0),
    last_co_access: timestamp('last_co_access', { withTimezone: true }).notNull().defaultNow(),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Unique constraint enforces one row per ordered (a < b) pair
    pair_idx: uniqueIndex('capture_associations_pair_idx').on(table.capture_id_a, table.capture_id_b),
    capture_id_a_idx: index('capture_associations_capture_id_a_idx').on(table.capture_id_a),
    capture_id_b_idx: index('capture_associations_capture_id_b_idx').on(table.capture_id_b),
    last_co_access_idx: index('capture_associations_last_co_access_idx').on(table.last_co_access),
  }),
)

// ============================================================
// activity_feed table — unified activity feed for dashboard
//
// Application-level inserts from all event sources: capture creation,
// skill completions, pipeline events, entity changes.
// type = capture | skill | pipeline | entity | system
// subtype = more specific event (e.g. capture:created, skill:completed)
// source_id = FK to originating record (not enforced — events survive source deletion)
// ============================================================
export const activity_feed = pgTable(
  'activity_feed',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    type: varchar('type', { length: 32 }).notNull(),
    subtype: varchar('subtype', { length: 64 }),
    timestamp: timestamp('timestamp', { withTimezone: true }).notNull().defaultNow(),
    summary: text('summary').notNull(),
    view: varchar('view', { length: 32 }),
    detail: jsonb('detail'),
    source_id: uuid('source_id'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    timestamp_desc_idx: index('activity_feed_timestamp_desc_idx').on(table.timestamp),
    type_timestamp_idx: index('activity_feed_type_timestamp_idx').on(table.type, table.timestamp),
    view_timestamp_idx: index('activity_feed_view_timestamp_idx').on(table.view, table.timestamp),
  }),
)

// ============================================================
// app_settings table — generic key-value settings store
// ============================================================
export const app_settings = pgTable('app_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

// ============================================================
// mcp_activity table — logs every MCP tool call
//
// Every tool invocation through the MCP server is recorded here
// with the tool name, sanitized parameters, truncated result,
// duration, and optional client identifier.
// ============================================================
export const mcp_activity = pgTable(
  'mcp_activity',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    timestamp: timestamp('timestamp', { withTimezone: true }).notNull().defaultNow(),
    client_id: varchar('client_id', { length: 64 }),
    tool_name: varchar('tool_name', { length: 64 }).notNull(),
    parameters: jsonb('parameters'),
    result_summary: text('result_summary'),
    duration_ms: integer('duration_ms'),
    metadata: jsonb('metadata'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    timestamp_idx: index('mcp_activity_timestamp_idx').on(table.timestamp),
    tool_name_idx: index('mcp_activity_tool_name_idx').on(table.tool_name),
  }),
)

// ============================================================
// backup_log table — legacy, retained for historical rows
//
// Populated by the deleted db-backup / wiki-backup / redis-snapshot
// BullMQ skills prior to consolidation onto scripts/backup.sh
// (Phase G-B.4). Kept in the schema so historical rows remain
// queryable; no new rows are written as of 2026-04-17.
// ============================================================
export const backup_log = pgTable(
  'backup_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    timestamp: timestamp('timestamp', { withTimezone: true }).notNull().defaultNow(),
    backup_type: varchar('backup_type', { length: 16 }).notNull(),  // database | wiki | redis
    file_path: text('file_path'),
    size_bytes: bigint('size_bytes', { mode: 'number' }),
    duration_seconds: integer('duration_seconds'),
    status: varchar('status', { length: 16 }).notNull(),            // success | failed
    error: text('error'),
    pruned_count: integer('pruned_count').notNull().default(0),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    timestamp_desc_idx: index('backup_log_timestamp_desc_idx').on(table.timestamp),
    type_idx: index('backup_log_type_idx').on(table.backup_type),
  }),
)

// ============================================================
// email_drafts table — outbound email composition and sending
//
// Stores draft emails for review-before-send and auto-send workflows.
// Drafts are created by the email-compose skill (LLM) or via API/Slack/MCP.
// Two send modes:
//   review-required — requires explicit approval before sending
//   auto-send       — sent immediately via Himalaya SMTP
//
// Status lifecycle: draft → approved → sent (or draft → rejected, draft → failed)
// Sent emails are also logged as captures with source='email-outbound'.
// ============================================================
export const email_drafts = pgTable(
  'email_drafts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    to_address: text('to_address').notNull(),
    cc_address: text('cc_address'),
    subject: text('subject').notNull(),
    body: text('body').notNull(),
    status: varchar('status', { length: 20 }).notNull().default('draft'),
    send_mode: varchar('send_mode', { length: 20 }).notNull().default('review-required'),
    source: varchar('source', { length: 32 }),
    approved_at: timestamp('approved_at', { withTimezone: true }),
    sent_at: timestamp('sent_at', { withTimezone: true }),
    himalaya_message_id: varchar('himalaya_message_id', { length: 256 }),
    capture_id: uuid('capture_id').references(() => captures.id, { onDelete: 'set null' }),
    metadata: jsonb('metadata'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    status_idx: index('email_drafts_status_idx').on(table.status),
    created_at_idx: index('email_drafts_created_at_idx').on(table.created_at),
  }),
)

// ============================================================
// container_health table — infrastructure health check results
//
// The container-health skill (every 15 min) checks /health on each
// container and writes a row here. Used for consecutive-failure
// alerting and historical uptime queries.
// ============================================================
export const container_health = pgTable(
  'container_health',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    timestamp: timestamp('timestamp', { withTimezone: true }).notNull().defaultNow(),
    container_name: varchar('container_name', { length: 64 }).notNull(),
    healthy: boolean('healthy').notNull(),
    response_ms: integer('response_ms'),
    error: text('error'),
    metadata: jsonb('metadata'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    timestamp_desc_idx: index('container_health_timestamp_desc_idx').on(table.timestamp),
    name_timestamp_idx: index('container_health_name_timestamp_idx').on(table.container_name, table.timestamp),
    // Partial index on unhealthy rows created via SQL migration (Drizzle cannot generate partial indexes)
  }),
)

// ============================================================
// voice_sessions table — Pipecat voice conversation sessions
//
// Each row represents one voice conversation session between the
// user and the AI assistant via Pipecat. The session_key is a
// unique identifier generated by the Pipecat service at session
// start. Transcript is stored as a JSONB array of turns
// [{role, content, timestamp}]. captures_created tracks which
// captures were extracted from the conversation.
// ============================================================
export const voice_sessions = pgTable(
  'voice_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    session_key: varchar('session_key', { length: 64 }).unique().notNull(),
    started_at: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    ended_at: timestamp('ended_at', { withTimezone: true }),
    duration_seconds: integer('duration_seconds'),
    turn_count: integer('turn_count').default(0),
    transcript: jsonb('transcript').default([]),
    summary: text('summary'),
    captures_created: text('captures_created').array().notNull().default(sql`'{}'::text[]`),
    metadata: jsonb('metadata').default({}),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    started_at_desc_idx: index('voice_sessions_started_at_desc_idx').on(table.started_at),
  }),
)
