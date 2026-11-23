import { sql } from 'drizzle-orm'
import type { Database } from '../db/index.js'

// ============================================================
// Per-source heartbeats (remediation item 3.3)
//
// Each source records `{ last_attempt_at, last_success_at, ok, errors, meta }`
// in `app_settings` under `heartbeat:<source>`. Writers: workers skills (via
// workers/src/lib/heartbeat.ts) and host-cron sidecars (via the core-api route
// POST /api/v1/internal/heartbeat/:source). Both go through `upsertHeartbeat`
// so the stored shape cannot diverge. These keys are written through the
// database layer only; they are NOT in the settings API whitelists.
// ============================================================

export const HEARTBEAT_PREFIX = 'heartbeat:'
export const MAX_HEARTBEAT_ERRORS = 5
const MAX_ERROR_LENGTH = 300
/** Serialized `meta` above this is dropped, so a caller cannot park bulk data in settings. */
const MAX_META_BYTES = 2048

export interface HeartbeatRecord {
  last_attempt_at: string
  /** Null until the first successful run. Kept across failed runs. */
  last_success_at: string | null
  ok: boolean
  errors: string[]
  meta: Record<string, unknown>
}

export interface HeartbeatInput {
  ok: boolean
  errors?: readonly string[]
  meta?: Record<string, unknown>
}

export function heartbeatKey(source: string): string {
  return `${HEARTBEAT_PREFIX}${source}`
}

/** Parse a stored value (jsonb object or JSON string). Null when absent or malformed. */
export function parseHeartbeat(raw: unknown): HeartbeatRecord | null {
  let v = raw
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v)
    } catch {
      return null
    }
  }
  if (typeof v !== 'object' || v === null) return null
  const o = v as Record<string, unknown>
  if (typeof o.last_attempt_at !== 'string' || typeof o.ok !== 'boolean') return null
  return {
    last_attempt_at: o.last_attempt_at,
    last_success_at: typeof o.last_success_at === 'string' ? o.last_success_at : null,
    ok: o.ok,
    errors: Array.isArray(o.errors) ? o.errors.filter((e): e is string => typeof e === 'string') : [],
    meta: typeof o.meta === 'object' && o.meta !== null && !Array.isArray(o.meta) ? (o.meta as Record<string, unknown>) : {},
  }
}

/**
 * Pure merge: `last_success_at` advances only when `input.ok`; a failed run keeps
 * the previous value. At most 5 errors, each truncated. Meta over 2 KB is dropped.
 */
export function mergeHeartbeat(prev: HeartbeatRecord | null, input: HeartbeatInput, now: Date): HeartbeatRecord {
  const nowIso = now.toISOString()
  const errors = (input.errors ?? []).slice(0, MAX_HEARTBEAT_ERRORS).map((e) => String(e).slice(0, MAX_ERROR_LENGTH))
  let meta: Record<string, unknown> = input.meta ?? {}
  try {
    if (JSON.stringify(meta).length > MAX_META_BYTES) meta = {}
  } catch {
    meta = {}
  }
  return {
    last_attempt_at: nowIso,
    last_success_at: input.ok ? nowIso : (prev?.last_success_at ?? null),
    ok: input.ok,
    errors: input.ok ? [] : errors,
    meta,
  }
}

/** Read one source's heartbeat. Database errors propagate. */
export async function readHeartbeat(db: Database, source: string): Promise<HeartbeatRecord | null> {
  const res = await db.execute<{ value: unknown }>(sql`SELECT value FROM app_settings WHERE key = ${heartbeatKey(source)}`)
  return parseHeartbeat(res?.rows?.[0]?.value)
}

/** Read-merge-upsert one source's heartbeat and return the stored record. Database errors propagate. */
export async function upsertHeartbeat(
  db: Database,
  source: string,
  input: HeartbeatInput,
  now: Date = new Date(),
): Promise<HeartbeatRecord> {
  const prev = await readHeartbeat(db, source)
  const record = mergeHeartbeat(prev, input, now)
  await db.execute(sql`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (${heartbeatKey(source)}, ${JSON.stringify(record)}::jsonb, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
  `)
  return record
}
