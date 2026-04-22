import { pgTable, text, timestamp, jsonb, uuid, index } from 'drizzle-orm/pg-core'
import { skills_log } from './supporting.js'

// ============================================================
// briefs table — first-class brief domain model (CS2 / migration 0030)
//
// Stores structured AI-generated briefs produced by brief-writing skills:
//   weekly-brief, daily-sweep-skill, morning-brief, monthly-reflection.
//
// body_html is rendered by the unified-stack renderer (Phase 5).
// toc is a JSONB array of TocItem [{id, text, level}].
// sources is a JSONB array of BriefSource [{type, title, excerpt?, capture_id?}].
// refine_options is a JSONB array of preset refinement strings (max 6).
//
// kind CHECK constraint: 'DAILY'|'WEEKLY'|'DOSSIER'|'DECISION'|'PROJECT'|'MONTHLY'
// cover CHECK constraint: 'parchment'|'evening'|'sunrise'|'gold'|'canvas'|'slate'
//
// Canonical TS union types: BriefKind, BriefCover in packages/shared/src/types/brief.ts
// ============================================================
export const briefs = pgTable(
  'briefs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').notNull(),                                                    // 6 values; CHECK in migration 0030; canonical: BriefKind
    cover: text('cover').notNull(),                                                  // 6 values; CHECK in migration 0030; canonical: BriefCover
    title: text('title').notNull(),
    subtitle: text('subtitle'),
    body_html: text('body_html').notNull(),
    toc: jsonb('toc').notNull().default([]),                                         // TocItem[]
    sources: jsonb('sources').notNull().default([]),                                 // BriefSource[]
    refine_options: jsonb('refine_options').notNull().default([]),                   // string[]
    source_skill_log_id: uuid('source_skill_log_id').references(() => skills_log.id), // nullable — originating skill run
    refined_from_id: uuid('refined_from_id'),                                        // self-ref FK; managed at app level (Drizzle can't forward-ref same table cleanly)
    generated_at: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow(),
    read_at: timestamp('read_at', { withTimezone: true }),
    dismissed_at: timestamp('dismissed_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Descending chronological scan (list endpoint default order)
    generated_at_idx: index('briefs_generated_at_idx').on(table.generated_at),
    // Filtered by kind (e.g. "show me all WEEKLY briefs")
    kind_idx: index('briefs_kind_idx').on(table.kind),
    // Unread inbox view — partial index created via SQL migration 0030 (Drizzle cannot emit partial indexes)
    // Refinement chain traversal — partial index created via SQL migration 0030
    // Prevent duplicate briefs from same skill run — partial unique index WHERE source_skill_log_id IS NOT NULL
    // Created via SQL migration 0030 (Drizzle cannot emit partial indexes natively)
    source_skill_log_id_idx: index('briefs_source_skill_log_id_idx').on(table.source_skill_log_id),
  }),
)

// Use BriefRow/NewBriefRow to avoid collision with the semantic Brief interface in packages/shared/src/types/brief.ts
export type BriefRow = typeof briefs.$inferSelect
export type NewBriefRow = typeof briefs.$inferInsert
