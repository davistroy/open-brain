/**
 * Pipeline event stage -- the processing step being tracked.
 * Canonical set (P09b / migration 0025 / issue #119). Lockstep across:
 *
 *   - This TS union (canonical source of truth)
 *   - DB CHECK: pipeline_events_stage_check (migration 0025)
 *
 * Values fall into two groups:
 *   - Standard pipeline stages (from config/pipeline.yaml):
 *     classify, embed, extract, link_entities, check_triggers, notify
 *   - Implementation-specific stages (from actual worker code):
 *     received (ingestion entry), extract_entities (entity extraction),
 *     document-parse, document-chunk, document-embed (document pipeline)
 *
 * Adding a value -> update BOTH surfaces (TS union + DB CHECK) in lockstep.
 * ALSO run a pre-flight SELECT DISTINCT audit before tightening.
 */
export type PipelineEventStage =
  | 'classify'
  | 'check_triggers'
  | 'document-chunk'
  | 'document-embed'
  | 'document-parse'
  | 'embed'
  | 'extract'
  | 'extract_entities'
  | 'link_entities'
  | 'notify'
  | 'received'

/**
 * Pipeline event status -- the outcome of a stage invocation.
 * Canonical 3-value set (P09b / migration 0025 / issue #119). Lockstep across:
 *
 *   - This TS union (canonical source of truth)
 *   - DB CHECK: pipeline_events_status_check (migration 0025)
 *
 * Adding a value -> update BOTH surfaces in lockstep.
 */
export type PipelineEventStatus = 'started' | 'success' | 'failed'
