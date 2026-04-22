import { pgTable, text, timestamp, uuid, index, date } from 'drizzle-orm/pg-core'
import { captures } from './core.js'
import { entities } from './supporting.js'

// ============================================================
// commitments table — directional obligation tracking (CS2 / migration 0031)
//
// Tracks forward-looking obligations extracted from captures by the
// extract-commitments pipeline job. Each row represents a single commitment:
// something owed by the user, something the user is waiting on, or an
// unresolved obligation pending classification.
//
// status CHECK constraint: 'pending' | 'owed_by_user' | 'waiting_on' | 'resolved'
// Maps to Cloudscape Board 4-column layout:
//   pending      → Pending column (unclassified / needs attention)
//   owed_by_user → "You owe" column (user has an outgoing obligation)
//   waiting_on   → "Waiting on" column (user is waiting for another party)
//   resolved     → Resolved column (obligation fulfilled or cancelled)
//
// Canonical TS union: CommitmentStatus in packages/shared/src/types/commitment.ts
// ============================================================
export const commitments = pgTable(
  'commitments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    capture_id: uuid('capture_id').notNull().references(() => captures.id, { onDelete: 'cascade' }),
    entity_id: uuid('entity_id').references(() => entities.id, { onDelete: 'set null' }),
    text: text('text').notNull(),
    due_date: date('due_date'),                                                         // nullable — not all commitments have explicit deadlines
    status: text('status').notNull().default('pending'),                                // 4 values; CHECK in migration 0031; canonical: CommitmentStatus
    resolved_at: timestamp('resolved_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Entity + status: primary lookup for entity-scoped commitment views
    entity_status_idx: index('commitments_entity_status_idx').on(table.entity_id, table.status),
    // Capture lookup: find all commitments extracted from a specific capture
    capture_id_idx: index('commitments_capture_id_idx').on(table.capture_id),
    // Status + due_date: overdue detection and calendar sorting
    status_due_date_idx: index('commitments_status_due_date_idx').on(table.status, table.due_date),
  }),
)

export type CommitmentRow = typeof commitments.$inferSelect
export type NewCommitmentRow = typeof commitments.$inferInsert
