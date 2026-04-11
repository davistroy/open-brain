-- Migration 0015: Backup log table
-- Tracks database, wiki, and Redis backup operations for the infrastructure backup skills.

CREATE TABLE IF NOT EXISTS backup_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  backup_type VARCHAR(16) NOT NULL,       -- database | wiki | redis
  file_path TEXT,
  size_bytes BIGINT,
  duration_seconds INTEGER,
  status VARCHAR(16) NOT NULL,            -- success | failed
  error TEXT,
  pruned_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Primary query pattern: reverse-chronological log
CREATE INDEX IF NOT EXISTS backup_log_timestamp_desc_idx ON backup_log (timestamp DESC);

-- Filter by backup type
CREATE INDEX IF NOT EXISTS backup_log_type_idx ON backup_log (backup_type);
