import { sql } from 'drizzle-orm'
import type { Database, HeartbeatInput, HeartbeatRecord } from '@open-brain/shared'
import { HEARTBEAT_PREFIX, heartbeatKey, parseHeartbeat, upsertHeartbeat, logger } from '@open-brain/shared'

// ============================================================
// Heartbeat store for workers (item 3.3). The record shape and merge rules live
// in @open-brain/shared so the core-api route writes the identical JSON.
// ============================================================

/**
 * Record one run for `source`. Keeps `last_success_at` when `ok` is false and
 * stores at most 5 errors. Never throws: a heartbeat write must not fail the run
 * it describes.
 */
export async function recordHeartbeat(
  db: Database,
  source: string,
  input: HeartbeatInput,
  now: Date = new Date(),
): Promise<HeartbeatRecord | null> {
  try {
    return await upsertHeartbeat(db, source, input, now)
  } catch (err) {
    logger.warn({ err, source }, '[heartbeat] write failed')
    return null
  }
}

/** All heartbeat records keyed by source name. Database errors propagate. */
export async function readHeartbeats(db: Database): Promise<Map<string, HeartbeatRecord>> {
  const res = await db.execute<{ key: string; value: unknown }>(
    sql`SELECT key, value FROM app_settings WHERE key LIKE ${HEARTBEAT_PREFIX + '%'}`,
  )
  const out = new Map<string, HeartbeatRecord>()
  for (const row of res?.rows ?? []) {
    if (typeof row?.key !== 'string') continue
    const rec = parseHeartbeat(row.value)
    if (rec) out.set(row.key.slice(HEARTBEAT_PREFIX.length), rec)
  }
  return out
}

/**
 * Write a baseline record dated `now` for every expected source that has none, so
 * each threshold counts from the first run after deploy (a writer that never ships
 * turns stale instead of staying unseen). `ON CONFLICT DO NOTHING` makes it
 * race-safe. Returns the sources baselined. Database errors propagate.
 */
export async function ensureHeartbeatBaseline(
  db: Database,
  sources: readonly string[],
  now: Date,
  existing?: Map<string, HeartbeatRecord>,
): Promise<string[]> {
  const have = existing ?? (await readHeartbeats(db))
  const nowIso = now.toISOString()
  const baselined: string[] = []
  for (const source of sources) {
    if (have.has(source)) continue
    const record: HeartbeatRecord = { last_attempt_at: nowIso, last_success_at: nowIso, ok: true, errors: [], meta: { baseline: true } }
    await db.execute(sql`
      INSERT INTO app_settings (key, value, updated_at)
      VALUES (${heartbeatKey(source)}, ${JSON.stringify(record)}::jsonb, now())
      ON CONFLICT (key) DO NOTHING
    `)
    baselined.push(source)
  }
  return baselined
}
