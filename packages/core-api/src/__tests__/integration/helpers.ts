/**
 * Integration test helper utilities — seed data, cleanup, and request helpers.
 *
 * Provides factory functions for creating test captures, entities, and other
 * domain objects directly via the database (bypassing the API) for fast setup,
 * plus API request helpers for testing HTTP endpoints via the Hono app.
 */

import { randomUUID } from 'node:crypto'
import { createHash } from 'node:crypto'
import type { Hono } from 'hono'
import {
  captures,
  entities,
  entity_links,
  sessions,
  bets,
} from '@open-brain/shared'
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

// ---------------------------------------------------------------------------
// Factory: Test entities
// ---------------------------------------------------------------------------

export interface TestEntityInput {
  name?: string
  entity_type?: string
  canonical_name?: string
  aliases?: string[]
  metadata?: Record<string, unknown> | null
}

/**
 * Insert an entity directly into the database.
 */
export async function createTestEntity(
  overrides: TestEntityInput = {},
): Promise<Record<string, unknown>> {
  const db = getTestDb()
  const name = overrides.name ?? `Entity-${randomUUID().slice(0, 8)}`

  const [row] = await db
    .insert(entities)
    .values({
      name,
      entity_type: overrides.entity_type ?? 'concept',
      canonical_name: overrides.canonical_name ?? name.toLowerCase(),
      aliases: overrides.aliases ?? [],
      metadata: overrides.metadata ?? null,
    })
    .returning()

  return row as unknown as Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Factory: Link entity to capture
// ---------------------------------------------------------------------------

/**
 * Create an entity_link joining an entity to a capture.
 */
export async function linkEntityToCapture(
  entityId: string,
  captureId: string,
  relationship = 'mentioned',
  confidence = 0.9,
): Promise<Record<string, unknown>> {
  const db = getTestDb()

  const [row] = await db
    .insert(entity_links)
    .values({
      entity_id: entityId,
      capture_id: captureId,
      relationship,
      confidence,
    })
    .returning()

  return row as unknown as Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Factory: Test bets
// ---------------------------------------------------------------------------

export interface TestBetInput {
  statement?: string
  confidence?: number
  domain?: string
  resolution_date?: Date | null
  resolution?: string | null
}

export async function createTestBet(
  overrides: TestBetInput = {},
): Promise<Record<string, unknown>> {
  const db = getTestDb()

  const [row] = await db
    .insert(bets)
    .values({
      statement: overrides.statement ?? `Bet ${randomUUID().slice(0, 8)}`,
      confidence: overrides.confidence ?? 0.7,
      domain: overrides.domain ?? 'technical',
      resolution_date: overrides.resolution_date ?? null,
      resolution: overrides.resolution ?? null,
    })
    .returning()

  return row as unknown as Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Factory: Test sessions
// ---------------------------------------------------------------------------

export interface TestSessionInput {
  session_type?: string
  status?: string
  config?: Record<string, unknown> | null
}

export async function createTestSession(
  overrides: TestSessionInput = {},
): Promise<Record<string, unknown>> {
  const db = getTestDb()

  const [row] = await db
    .insert(sessions)
    .values({
      session_type: overrides.session_type ?? 'governance',
      status: overrides.status ?? 'active',
      config: overrides.config ?? null,
    })
    .returning()

  return row as unknown as Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Seed: Create a batch of captures for common test scenarios
// ---------------------------------------------------------------------------

export interface SeedDataResult {
  captures: Record<string, unknown>[]
  entities: Record<string, unknown>[]
  links: Record<string, unknown>[]
}

/**
 * Seed a representative dataset: multiple captures across brain views and types,
 * a few entities, and entity-capture links. Useful for search and stats tests.
 */
export async function seedTestData(): Promise<SeedDataResult> {
  const captureData = [
    { content: 'Decided to migrate the database to PostgreSQL for better JSON support', capture_type: 'decision', brain_view: 'technical', source: 'api' },
    { content: 'New idea for automating the weekly brief generation using LLMs', capture_type: 'idea', brain_view: 'technical', source: 'slack' },
    { content: 'The quarterly revenue target was exceeded by 15 percent', capture_type: 'win', brain_view: 'career', source: 'api' },
    { content: 'Blocked on getting API access to the vendor platform', capture_type: 'blocker', brain_view: 'work-internal', source: 'voice' },
    { content: 'Observed that the team velocity increased after adopting daily standups', capture_type: 'observation', brain_view: 'career', source: 'api' },
    { content: 'Task to review and update the disaster recovery documentation', capture_type: 'task', brain_view: 'technical', source: 'api' },
    { content: 'How should we handle multi-tenancy in the new architecture?', capture_type: 'question', brain_view: 'technical', source: 'slack' },
    { content: 'Reflecting on the trade-offs between speed and quality in delivery', capture_type: 'reflection', brain_view: 'personal', source: 'voice' },
  ]

  const createdCaptures: Record<string, unknown>[] = []
  for (const data of captureData) {
    const capture = await createTestCapture(data)
    createdCaptures.push(capture)
  }

  // Create entities
  const entityData = [
    { name: 'PostgreSQL', entity_type: 'tool', canonical_name: 'postgresql' },
    { name: 'LLM', entity_type: 'concept', canonical_name: 'llm' },
    { name: 'Weekly Brief', entity_type: 'project', canonical_name: 'weekly brief' },
  ]

  const createdEntities: Record<string, unknown>[] = []
  for (const data of entityData) {
    const entity = await createTestEntity(data)
    createdEntities.push(entity)
  }

  // Link entities to captures
  const createdLinks: Record<string, unknown>[] = []
  // PostgreSQL → decision capture
  createdLinks.push(
    await linkEntityToCapture(
      createdEntities[0].id as string,
      createdCaptures[0].id as string,
      'mentioned',
      0.95,
    ),
  )
  // LLM → idea capture
  createdLinks.push(
    await linkEntityToCapture(
      createdEntities[1].id as string,
      createdCaptures[1].id as string,
      'mentioned',
      0.9,
    ),
  )
  // Weekly Brief → idea capture
  createdLinks.push(
    await linkEntityToCapture(
      createdEntities[2].id as string,
      createdCaptures[1].id as string,
      'referenced',
      0.85,
    ),
  )

  return {
    captures: createdCaptures,
    entities: createdEntities,
    links: createdLinks,
  }
}

// ---------------------------------------------------------------------------
// HTTP request helpers — make requests against the Hono test app
// ---------------------------------------------------------------------------

/** Default headers for integration test requests. Uses X-Open-Brain-Caller
 *  so each test run gets its own rate-limit bucket (avoids 429s). */
const DEFAULT_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  'X-Open-Brain-Caller': 'integration-test',
}

/**
 * Make a GET request to the test app.
 */
export async function testGet(
  app: Hono,
  path: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  const req = new Request(`http://localhost${path}`, {
    method: 'GET',
    headers: { ...DEFAULT_HEADERS, ...headers },
  })
  return app.fetch(req)
}

/**
 * Make a POST request to the test app with a JSON body.
 */
export async function testPost(
  app: Hono,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  const req = new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { ...DEFAULT_HEADERS, ...headers },
    body: JSON.stringify(body),
  })
  return app.fetch(req)
}

/**
 * Make a PATCH request to the test app with a JSON body.
 */
export async function testPatch(
  app: Hono,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  const req = new Request(`http://localhost${path}`, {
    method: 'PATCH',
    headers: { ...DEFAULT_HEADERS, ...headers },
    body: JSON.stringify(body),
  })
  return app.fetch(req)
}

/**
 * Make a DELETE request to the test app.
 */
export async function testDelete(
  app: Hono,
  path: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  const req = new Request(`http://localhost${path}`, {
    method: 'DELETE',
    headers: { ...DEFAULT_HEADERS, ...headers },
  })
  return app.fetch(req)
}
