/**
 * Integration test helper utilities for the workers package.
 * Provides capture creation and database cleanup functions.
 */

import { randomUUID } from 'node:crypto'
import { createHash } from 'node:crypto'
import { captures, pipeline_events } from '@open-brain/shared'
import { getTestDb, getTestPool } from './setup.js'

// ---------------------------------------------------------------------------
// Database cleanup
// ---------------------------------------------------------------------------

/** Tables to TRUNCATE in dependency order (CASCADE handles FK references). */
const TRUNCATE_TABLES = [
  'pipeline_events',
  'ai_audit_log',
  'entity_links',
  'entity_relationships',
  'session_messages',
  'skills_log',
  'bets',
  'sessions',
  'entities',
  'captures',
  'triggers',
] as const

/**
 * TRUNCATE all user data tables. Preserves schema, indexes, and functions.
 * Call in `beforeEach` or `afterEach` to isolate tests.
 */
export async function cleanDatabase(): Promise<void> {
  const pool = getTestPool()
  await pool.query(`TRUNCATE ${TRUNCATE_TABLES.join(', ')} CASCADE`)
}

// ---------------------------------------------------------------------------
// Content hash helper (mirrors shared/src/utils/hash.ts)
// ---------------------------------------------------------------------------

function contentHash(text: string): string {
  return createHash('sha256').update(text.trim().toLowerCase()).digest('hex')
}

// ---------------------------------------------------------------------------
// Factory: Test captures
// ---------------------------------------------------------------------------

export interface TestCaptureInput {
  content?: string
  capture_type?: string
  brain_view?: string
  source?: string
  source_metadata?: Record<string, unknown> | null
  tags?: string[]
  pipeline_status?: string
  captured_at?: Date
  embedding?: number[] | null
}

/**
 * Insert a capture directly into the database.
 * Returns the full row as inserted.
 */
export async function createTestCapture(
  overrides: TestCaptureInput = {},
): Promise<Record<string, unknown>> {
  const db = getTestDb()
  const content = overrides.content ?? `Test capture ${randomUUID().slice(0, 8)}`
  const hash = contentHash(content)

  const [row] = await db
    .insert(captures)
    .values({
      content,
      content_hash: hash,
      capture_type: overrides.capture_type ?? 'idea',
      brain_view: overrides.brain_view ?? 'technical',
      source: overrides.source ?? 'api',
      source_metadata: overrides.source_metadata ?? null,
      tags: overrides.tags ?? [],
      pipeline_status: overrides.pipeline_status ?? 'pending',
      captured_at: overrides.captured_at ?? new Date(),
      embedding: overrides.embedding ?? null,
    })
    .returning()

  return row as unknown as Record<string, unknown>
}
