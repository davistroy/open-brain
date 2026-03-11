-- Migration: Add access_count and last_accessed_at columns to captures
-- Purpose: Support ACT-R temporal decay scoring. The update-access-stats worker
--          increments access_count and sets last_accessed_at for captures returned
--          in search results. Without these columns the worker crashes at runtime.
--
-- Both columns are safe to add to existing data:
--   access_count defaults to 0 (NOT NULL)
--   last_accessed_at is nullable (NULL = never accessed)

ALTER TABLE captures ADD COLUMN IF NOT EXISTS access_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE captures ADD COLUMN IF NOT EXISTS last_accessed_at TIMESTAMPTZ;
