-- Migration 0031: commitments table + pipeline_events.stage CHECK update
--
-- Creates the commitments domain model (CS2 / Cloudscape M3).
-- Tracks directional obligations extracted from captures by the
-- extract-commitments pipeline job.
--
-- Pre-flight audit (MANDATORY — see CLAUDE.md "Pre-flight DB audit" rule):
--   SELECT DISTINCT stage FROM pipeline_events ORDER BY stage;
--
-- Expected homeserver stages before this migration (from migration 0025):
--   classify, check_triggers, document-chunk, document-embed, document-parse,
--   embed, extract, extract_entities, link_entities, notify, received
--
-- New stage added: extract_commitments (12 values total)
--
-- Rollback: DROP TABLE commitments CASCADE;
--   Followed by re-running migration 0025 to restore the 11-value CHECK.

CREATE TABLE IF NOT EXISTS commitments (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  capture_id   UUID        NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
  entity_id    UUID        REFERENCES entities(id) ON DELETE SET NULL,
  text         TEXT        NOT NULL,
  due_date     DATE,
  status       TEXT        NOT NULL DEFAULT 'pending',
  resolved_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE commitments
  ADD CONSTRAINT commitments_status_check
  CHECK (status IN ('pending', 'owed_by_user', 'waiting_on', 'resolved'));

-- Entity + status: primary lookup for entity-scoped commitment views
CREATE INDEX IF NOT EXISTS commitments_entity_status_idx
  ON commitments (entity_id, status);

-- Capture lookup: find all commitments extracted from a specific capture
CREATE INDEX IF NOT EXISTS commitments_capture_id_idx
  ON commitments (capture_id);

-- Status + due_date: overdue detection and calendar sorting
CREATE INDEX IF NOT EXISTS commitments_status_due_date_idx
  ON commitments (status, due_date);

-- Update pipeline_events.stage CHECK to include 'extract_commitments'
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
    'extract_commitments',
    'extract_entities',
    'link_entities',
    'notify',
    'received'
  ));
