/**
 * Integration test: access-stats job — batch UPSERT + canonical pair ordering.
 *
 * Calls processAccessStatsJob() directly against real Postgres (docker-compose.test.yml).
 * BullMQ plumbing is already E2E-tested by pipeline.test.ts — this test focuses
 * on the batch-UPSERT correctness, canonical pair ordering, and second-call accumulation.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { eq, and, inArray } from 'drizzle-orm'
import { captures, captureAssociations } from '@open-brain/shared'
import { initTestDatabase, teardownTestDatabase, getTestDb } from './setup.js'
import { cleanDatabase, createTestCapture } from './helpers.js'
import { processAccessStatsJob } from '../../jobs/update-access-stats.js'

beforeAll(async () => { await initTestDatabase() })
afterAll(async () => { await teardownTestDatabase() })
beforeEach(async () => { await cleanDatabase() })

describe('access-stats integration', () => {
  it('populates access_count and capture_associations with canonical ordering', async () => {
    const db = getTestDb()
    const c1 = await createTestCapture({ content: 'Access test A' })
    const c2 = await createTestCapture({ content: 'Access test B' })
    const captureIds = [c1.id as string, c2.id as string]
    const accessedAt = new Date().toISOString()

    await processAccessStatsJob({ captureIds, accessedAt }, db)

    // access_count incremented for both
    const rows = await db.select({ id: captures.id, access_count: captures.access_count })
      .from(captures).where(inArray(captures.id, captureIds))
    for (const r of rows) expect(r.access_count).toBeGreaterThanOrEqual(1)

    // capture_associations: canonical (a < b) ordering
    const [idA, idB] = captureIds[0] < captureIds[1]
      ? [captureIds[0], captureIds[1]]
      : [captureIds[1], captureIds[0]]
    const [assoc] = await db.select().from(captureAssociations)
      .where(and(
        eq(captureAssociations.capture_id_a, idA),
        eq(captureAssociations.capture_id_b, idB),
      ))
    expect(assoc).toBeDefined()
    expect(assoc.co_access_count).toBe(1)
    expect(Number(assoc.weight)).toBeCloseTo(1.0)

    // Second call: co_access_count should increment, weight recomputed
    await processAccessStatsJob({ captureIds, accessedAt: new Date().toISOString() }, db)
    const [assoc2] = await db.select({ co_access_count: captureAssociations.co_access_count })
      .from(captureAssociations)
      .where(and(
        eq(captureAssociations.capture_id_a, idA),
        eq(captureAssociations.capture_id_b, idB),
      ))
    expect(assoc2.co_access_count).toBe(2)
  })
})
