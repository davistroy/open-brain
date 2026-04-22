/**
 * Central SSE → TanStack Query invalidation map.
 *
 * Maps each SSE event type to the query key arrays that should be invalidated
 * when that event arrives. This is the single place to wire new screens into
 * the live-update system: add the screen's query key here and it receives
 * automatic invalidation for free.
 *
 * Dynamic keys: entries may contain the placeholder string '{captureId}'.
 * SseProvider replaces that placeholder with `evt.data.capture_id` at
 * runtime before dispatching `queryClient.invalidateQueries()`.
 *
 * Ref: CS1 investigation items 1.3 + 4.7 / work item 3.2
 */

import type { SseEventType } from './sse-client'

/** A single query key segment — matches TanStack Query's QueryKey element type. */
type KeySegment = string

/** Static or dynamic query key. Dynamic entries may include '{captureId}'. */
type QueryKeyTemplate = KeySegment[]

/** Map from SSE event type to the list of query key templates to invalidate. */
export type SseInvalidationMap = Record<SseEventType, QueryKeyTemplate[]>

export const SSE_INVALIDATION_MAP: SseInvalidationMap = {
  capture_created: [['captures'], ['dashboard'], ['entities']],
  pipeline_complete: [['capture', '{captureId}'], ['dashboard']],
  skill_complete: [['briefs'], ['dashboard']],
  brief_created: [['briefs'], ['dashboard']],
  bet_expiring: [], // unused in M2
  'upload:status': [], // unused in M2
}

/**
 * Resolve a query key template into a concrete TanStack Query key.
 *
 * Replaces '{captureId}' with the value of `evt.data.capture_id` (if present).
 * Other placeholders are left as-is so future keys can extend this pattern.
 */
export function resolveQueryKey(
  template: QueryKeyTemplate,
  captureId: string | undefined,
): QueryKeyTemplate {
  return template.map((segment) => {
    if (segment === '{captureId}') {
      return captureId ?? segment // fall back to literal if id is missing
    }
    return segment
  })
}
