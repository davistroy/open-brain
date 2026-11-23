import type { Hono } from 'hono'
import { AppError, ValidationError, upsertHeartbeat, logger, type Database } from '@open-brain/shared'

// ============================================================
// Internal heartbeat route (remediation item 3.3)
//
//   POST /api/v1/internal/heartbeat/:source
//   Headers: X-Open-Brain-Caller: utility-pipeline | actual-pipeline
//   Body:    { "ok": boolean, "errors"?: string[], "meta"?: object }
//   200 {source, record}  400 unknown source / bad body  403 other caller
//
// Writes `app_settings` `heartbeat:<source>` via the database layer; the key is
// NOT in the settings API whitelists. Both callers are already in
// BYPASS_CALLERS, so rate-limit.ts is unchanged. web-next's proxy overwrites the
// caller header to `web-next-public`, so a public request is rejected here (403).
// ============================================================

/** Sources a host-cron sidecar may report. In-stack sources write via workers. */
export const HEARTBEAT_ROUTE_SOURCES = new Set(['gas', 'actual'])
/** Callers allowed to post a heartbeat. */
export const HEARTBEAT_ROUTE_CALLERS = new Set(['utility-pipeline', 'actual-pipeline'])

export function registerHeartbeatRoutes(app: Hono, db: Database): void {
  app.post('/api/v1/internal/heartbeat/:source', async (c) => {
    const caller = c.req.header('x-open-brain-caller') ?? ''
    if (!HEARTBEAT_ROUTE_CALLERS.has(caller)) {
      throw new AppError('Caller not allowed to post heartbeats', 403, 'FORBIDDEN')
    }

    const source = c.req.param('source')
    if (!HEARTBEAT_ROUTE_SOURCES.has(source)) {
      throw new ValidationError(`Unknown heartbeat source: ${source}`)
    }

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      throw new ValidationError('Invalid JSON body')
    }
    const b = (typeof body === 'object' && body !== null && !Array.isArray(body) ? body : {}) as Record<string, unknown>
    if (typeof b.ok !== 'boolean') throw new ValidationError('ok (boolean) is required')
    if (b.errors !== undefined && !(Array.isArray(b.errors) && b.errors.every((e) => typeof e === 'string'))) {
      throw new ValidationError('errors must be an array of strings')
    }
    if (b.meta !== undefined && (typeof b.meta !== 'object' || b.meta === null || Array.isArray(b.meta))) {
      throw new ValidationError('meta must be an object')
    }

    const record = await upsertHeartbeat(db, source, {
      ok: b.ok,
      errors: b.errors as string[] | undefined,
      meta: b.meta as Record<string, unknown> | undefined,
    })
    logger.info({ source, caller, ok: record.ok }, '[heartbeat] recorded')
    return c.json({ source, record })
  })
}
