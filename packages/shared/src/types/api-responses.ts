/**
 * Canonical response contracts for core-api endpoints (IA-M3).
 *
 * These types describe what core-api ACTUALLY returns on the wire — server-side
 * field names, JSON-serialized (dates are ISO strings). They are the single
 * source of truth for the two endpoints whose envelopes/field-names slack-bot
 * re-maps to its own internal shapes. Typing the raw responses against these
 * types means a server-side field rename breaks slack-bot's typecheck instead
 * of silently drifting at runtime.
 *
 * Scope is deliberately minimal — only the endpoints that back the
 * hand-maintained slack-bot shims (`items→captures`, entity field renames).
 * This is NOT a full OpenAPI surface (out of scope); response types cover the
 * shims first.
 *
 * NOTE: web-next and mobile deliberately do NOT import `@open-brain/shared`
 * (they keep their own drift-guard tests over locally-mirrored types), so these
 * contracts are consumed by shared + slack-bot + core-api only.
 */

/**
 * Generic paginated list envelope. Every list endpoint on core-api returns
 * this shape: a page of `items` plus the pagination cursor that produced it.
 */
export interface PaginatedResponse<T> {
  items: T[]
  total: number
  limit: number
  offset: number
}

/**
 * A capture row as returned inside the `GET /api/v1/captures` list envelope.
 * (The single-capture `GET /api/v1/captures/:id` route returns a richer record;
 * this is only the list projection.)
 */
export interface CaptureListItem {
  id: string
  content: string
  capture_type: string
  brain_view: string
  source: string
  created_at: string
}

/** `GET /api/v1/captures` response envelope. */
export type CaptureListResponse = PaginatedResponse<CaptureListItem>

/**
 * An entity row as returned by core-api (server field names).
 *
 * The server uses `entity_type` (not `type`) and `mention_count` (not
 * `capture_count`). slack-bot re-maps these to its own internal field names;
 * sourcing the raw shape from here makes that remap type-checked against the
 * server contract.
 */
export interface EntityListItem {
  id: string
  name: string
  entity_type: string
  aliases: string[]
  mention_count: number
  last_seen_at?: string
  created_at?: string
}

/** `GET /api/v1/entities` (list) response envelope. */
export type EntityListResponse = PaginatedResponse<EntityListItem>

/** `GET /api/v1/entities?name=…` (single-entity lookup) response envelope. */
export interface EntityByNameResponse {
  entity: EntityListItem
}
