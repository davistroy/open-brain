import { pgTable, text, timestamp, integer, real, boolean, jsonb, uuid, index, uniqueIndex } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { customType } from 'drizzle-orm/pg-core'
import { captures } from './core.js'

// pgvector custom type — reuse same definition as core.ts
const vector = customType<{ data: number[]; driverData: string }>({
  dataType() { return 'vector(768)' },
  toDriver(value: number[]): string { return `[${value.join(',')}]` },
  fromDriver(value: string): number[] { return value.slice(1, -1).split(',').map(Number) },
})

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
