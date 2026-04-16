import { pgTable, uuid, text, numeric, boolean, timestamp, index, jsonb, integer } from 'drizzle-orm/pg-core'

// ============================================================
// email_classifications table — individual email classification results
//
// Stores every email classified by the email pipeline (replacing
// the Python/SQLite sidecar). Each row = one email processed.
// Indexes support morning brief queries (overnight by category).
// ============================================================
export const email_classifications = pgTable(
  'email_classifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    message_id: text('message_id').notNull(),       // provider-specific message ID
    provider: text('provider').notNull(),             // 'hotmail' | 'gmail'
    sender: text('sender').notNull(),                 // email address
    subject: text('subject'),                         // up to 500 chars
    category: text('category').notNull(),             // classification result
    confidence: numeric('confidence', { precision: 3, scale: 2 }),  // 0.00-1.00
    tier: text('tier').notNull(),                     // 'sender' | 'keyword' | 'jetson' | 'manual'
    folder_id: text('folder_id'),                     // provider folder/label ID
    moved: boolean('moved').default(false),           // whether email was moved/labeled
    processed_at: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    provider_message_idx: index('ec_provider_message_idx').on(table.provider, table.message_id),
    category_processed_idx: index('ec_category_processed_idx').on(table.category, table.processed_at),
    processed_at_idx: index('ec_processed_at_idx').on(table.processed_at),
  }),
)

// ============================================================
// email_corrections table — tracks user corrections (manual folder moves)
//
// When a user manually moves an email to a different folder after
// classification, the correction is recorded here. Used to improve
// classification accuracy over time (feedback loop).
// ============================================================
export const email_corrections = pgTable(
  'email_corrections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    message_id: text('message_id').notNull(),
    provider: text('provider').notNull(),
    old_category: text('old_category').notNull(),
    new_category: text('new_category').notNull(),
    detected_at: timestamp('detected_at', { withTimezone: true }).notNull().defaultNow(),
  },
)

// ============================================================
// email_daily_summaries table — daily email summaries posted to Open Brain
//
// One row per day. Aggregates email counts by category, stores
// summary text, and tracks whether the summary was posted as a
// capture to Open Brain.
// ============================================================
export const email_daily_summaries = pgTable(
  'email_daily_summaries',
  {
    date: text('date').primaryKey(),                  // YYYY-MM-DD
    email_count: integer('email_count').notNull(),
    categories: jsonb('categories'),                   // {category: count} object
    summary_text: text('summary_text'),
    posted_to_brain: boolean('posted_to_brain').default(false),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
)
