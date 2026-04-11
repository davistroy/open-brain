-- Migration 0014: Activity feed table
-- Unified activity feed for dashboard — captures, skills, pipeline, entity events

CREATE TABLE IF NOT EXISTS activity_feed (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type VARCHAR(32) NOT NULL,        -- capture | skill | pipeline | entity | system
  subtype VARCHAR(64),              -- e.g. capture:created, skill:completed, pipeline:stage_complete
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  summary TEXT NOT NULL,
  view VARCHAR(32),                 -- brain view (career | personal | technical | work-internal | client)
  detail JSONB,                     -- type-specific payload
  source_id UUID,                   -- FK to the originating record (capture, skill_log, etc.)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Primary query pattern: reverse-chronological feed
CREATE INDEX IF NOT EXISTS activity_feed_timestamp_desc_idx ON activity_feed (timestamp DESC);

-- Filter by type + time range
CREATE INDEX IF NOT EXISTS activity_feed_type_timestamp_idx ON activity_feed (type, timestamp DESC);

-- Filter by brain view + time range
CREATE INDEX IF NOT EXISTS activity_feed_view_timestamp_idx ON activity_feed (view, timestamp DESC) WHERE view IS NOT NULL;
