/**
 * Database queries for the EmailClassifySkill.
 *
 * All email classification persistence lives here — checking processed state,
 * recording classifications, recording user corrections, and querying
 * summary data for the daily digest and morning brief.
 */

import { eq, and, sql, gte, lte } from 'drizzle-orm'
import {
  email_classifications,
  email_corrections,
  email_daily_summaries,
} from '@open-brain/shared'
import type { Database } from '@open-brain/shared'

// ============================================================
// Dedup check
// ============================================================

/**
 * Check whether a specific email has already been processed by the pipeline.
 * Uses the (provider, message_id) composite index.
 */
export async function isProcessed(
  db: Database,
  provider: string,
  messageId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: email_classifications.id })
    .from(email_classifications)
    .where(
      and(
        eq(email_classifications.provider, provider),
        eq(email_classifications.message_id, messageId),
      ),
    )
    .limit(1)

  return rows.length > 0
}

// ============================================================
// Record classification
// ============================================================

export interface RecordClassificationData {
  messageId: string
  provider: string
  sender: string
  subject: string
  category: string
  confidence: number
  tier: string
  folderId: string | null
  moved: boolean
}

/**
 * Insert a classification result into `email_classifications`.
 */
export async function recordClassification(
  db: Database,
  data: RecordClassificationData,
): Promise<void> {
  await db.insert(email_classifications).values({
    message_id: data.messageId,
    provider: data.provider,
    sender: data.sender,
    subject: (data.subject ?? '').slice(0, 500),
    category: data.category,
    confidence: String(data.confidence),
    tier: data.tier,
    folder_id: data.folderId,
    moved: data.moved,
  })
}

// ============================================================
// Record correction
// ============================================================

export interface RecordCorrectionData {
  messageId: string
  provider: string
  oldCategory: string
  newCategory: string
}

/**
 * Insert a user correction into `email_corrections`.
 * Called when the pipeline detects the user moved an email to a different folder.
 */
export async function recordCorrection(
  db: Database,
  data: RecordCorrectionData,
): Promise<void> {
  await db.insert(email_corrections).values({
    message_id: data.messageId,
    provider: data.provider,
    old_category: data.oldCategory,
    new_category: data.newCategory,
  })
}

// ============================================================
// Summary queries
// ============================================================

export interface OvernightCategory {
  category: string
  count: number
  topSubjects: string[]
}

/**
 * Aggregate classifications since a given timestamp, grouped by category.
 * Returns category counts with up to 3 example subjects per category.
 * Used for the daily digest and morning brief email triage section.
 */
export async function getOvernightSummary(
  db: Database,
  since: Date,
): Promise<OvernightCategory[]> {
  // Step 1: Get category counts
  const countRows = await db
    .select({
      category: email_classifications.category,
      count: sql<number>`COUNT(*)::int`,
    })
    .from(email_classifications)
    .where(gte(email_classifications.processed_at, since))
    .groupBy(email_classifications.category)
    .orderBy(sql`COUNT(*) DESC`)

  // Step 2: For each category, grab top 3 subjects
  const results: OvernightCategory[] = []
  for (const row of countRows) {
    const subjectRows = await db
      .select({ subject: email_classifications.subject })
      .from(email_classifications)
      .where(
        and(
          gte(email_classifications.processed_at, since),
          eq(email_classifications.category, row.category),
        ),
      )
      .orderBy(sql`${email_classifications.processed_at} DESC`)
      .limit(3)

    results.push({
      category: row.category,
      count: row.count,
      topSubjects: subjectRows
        .map((r) => r.subject ?? '')
        .filter((s) => s.length > 0),
    })
  }

  return results
}

export interface DailySummaryRow {
  emailCount: number
  categories: Record<string, number>
  postedToBrain: boolean
}

/**
 * Get the daily summary for a specific date (YYYY-MM-DD).
 * Returns null if no summary exists for that date.
 */
export async function getDailySummary(
  db: Database,
  date: string,
): Promise<DailySummaryRow | null> {
  const rows = await db
    .select({
      email_count: email_daily_summaries.email_count,
      categories: email_daily_summaries.categories,
      posted_to_brain: email_daily_summaries.posted_to_brain,
    })
    .from(email_daily_summaries)
    .where(eq(email_daily_summaries.date, date))
    .limit(1)

  if (rows.length === 0) return null

  const row = rows[0]
  return {
    emailCount: row.email_count,
    categories: (row.categories as Record<string, number>) ?? {},
    postedToBrain: row.posted_to_brain ?? false,
  }
}

/**
 * Upsert the daily summary row and mark it as posted to Open Brain.
 */
export async function markSummaryPosted(
  db: Database,
  date: string,
  emailCount: number,
  categories: Record<string, number>,
  summaryText: string,
): Promise<void> {
  await db
    .insert(email_daily_summaries)
    .values({
      date,
      email_count: emailCount,
      categories,
      summary_text: summaryText,
      posted_to_brain: true,
    })
    .onConflictDoUpdate({
      target: email_daily_summaries.date,
      set: {
        email_count: emailCount,
        categories,
        summary_text: summaryText,
        posted_to_brain: true,
      },
    })
}

/**
 * Get all classifications for a specific date range (for correction detection).
 * Returns message IDs with their provider and assigned category.
 */
export async function getRecentClassifications(
  db: Database,
  since: Date,
  provider: string,
): Promise<Array<{ messageId: string; category: string; folderId: string | null }>> {
  const rows = await db
    .select({
      messageId: email_classifications.message_id,
      category: email_classifications.category,
      folderId: email_classifications.folder_id,
    })
    .from(email_classifications)
    .where(
      and(
        gte(email_classifications.processed_at, since),
        eq(email_classifications.provider, provider),
      ),
    )

  return rows.map((r) => ({
    messageId: r.messageId,
    category: r.category,
    folderId: r.folderId,
  }))
}
