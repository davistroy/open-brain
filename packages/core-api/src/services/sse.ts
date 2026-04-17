// SSE hub service — typed emitters for channels streamed via
// `GET /api/v1/events`. This file intentionally stays thin: the transport
// (pg-notify LISTEN + Hono SSE writer) lives in `lib/pg-notify.ts` and
// `routes/events.ts`. Publishers use the helpers here to get compile-time
// safety on event payloads.
//
// CS3.6 — adds `upload:status` channel. Publishers (CS3.5 ingest-process
// worker, CS3.4 upload route) call `publishUploadStatus()` which validates
// the payload with `UploadStatusEventSchema` and broadcasts via
// `pg_notify('upload_status', ...)`. Consumers are any connected SSE
// clients on `/api/v1/events`; the `routes/events.ts` forwarder re-emits
// the channel as SSE event name `upload:status` per the plan contract.
//
// Channel naming: PostgreSQL LISTEN channel identifiers cannot contain a
// colon unless quoted, so the pg channel is `upload_status` (underscore)
// while the SSE event name sent to browsers is `upload:status` (colon).

import { UploadStatusEventSchema, type UploadStatusEvent } from '@open-brain/shared'
import { pgNotify } from '../lib/pg-notify.js'

/** Pg-notify channel name for upload lifecycle events. */
export const UPLOAD_STATUS_CHANNEL = 'upload_status' as const

/** SSE event name emitted to browser clients. */
export const UPLOAD_STATUS_SSE_EVENT = 'upload:status' as const

/**
 * Broadcast an upload-status event to all connected SSE clients.
 *
 * Validates against the discriminated-union `UploadStatusEventSchema` so
 * that malformed events are rejected at the publisher rather than silently
 * dropped on the subscriber side. Throws on schema failure.
 */
export async function publishUploadStatus(event: UploadStatusEvent): Promise<void> {
  const parsed = UploadStatusEventSchema.parse(event)
  await pgNotify.notify(UPLOAD_STATUS_CHANNEL, parsed as unknown as Record<string, unknown>)
}
