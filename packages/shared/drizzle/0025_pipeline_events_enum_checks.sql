-- Migration 0025: CHECK constraints on pipeline_events.stage + pipeline_events.status
--
-- Tightens both columns from unconstrained text to canonical value sets.
-- TS unions in packages/shared/src/types/pipeline-event.ts are source of truth;
-- these CHECKs are DB-level belt-and-suspenders.
--
-- Pre-flight audits (MANDATORY -- see CLAUDE.md "Pre-flight DB audit" rule):
--   SELECT DISTINCT stage, COUNT(*) FROM pipeline_events GROUP BY stage ORDER BY 2 DESC;
--   SELECT DISTINCT status, COUNT(*) FROM pipeline_events GROUP BY status ORDER BY 2 DESC;
--
-- P09b pre-flight (homeserver, 2026-04-19):
--   stage:  embed 50562 / extract_entities 27489 / extract 22108 / received 11054 / link_entities 790
--   status: started 61538 / success 32984 / failed 17481
--
-- Stage canonical set (11 values):
--   5 from DB + 3 from pipeline.yaml config (classify, check_triggers, notify --
--   zero current producers but declared in config, included for forward
--   compatibility) + 3 from document-pipeline.ts code (document-parse,
--   document-chunk, document-embed -- zero DB rows, pipeline hasn't run on
--   homeserver yet).
--
-- Status canonical set (3 values):
--   All producers use exactly these 3 values. The recordStageEvent() function
--   in ingestion-worker.ts already constrains to this union.

ALTER TABLE pipeline_events
  DROP CONSTRAINT IF EXISTS pipeline_events_stage_check;

ALTER TABLE pipeline_events
  ADD CONSTRAINT pipeline_events_stage_check
  CHECK (stage IN (
    'classify',
    'check_triggers',
    'document-chunk',
    'document-embed',
    'document-parse',
    'embed',
    'extract',
    'extract_entities',
    'link_entities',
    'notify',
    'received'
  ));

ALTER TABLE pipeline_events
  DROP CONSTRAINT IF EXISTS pipeline_events_status_check;

ALTER TABLE pipeline_events
  ADD CONSTRAINT pipeline_events_status_check
  CHECK (status IN (
    'started',
    'success',
    'failed'
  ));
