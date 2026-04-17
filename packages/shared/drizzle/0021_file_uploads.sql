-- Migration 0021: file_uploads — upload backend for CS3 (Waves 2026-04-17)
-- Tracks browser/API file uploads landing in the ingest bind-mount, their routing
-- decision (source_type + parser_hint), and the BullMQ-driven processing status
-- through to the captures the sidecar pipeline produces.

-- ENUM: file_upload_status
-- Postgres has no CREATE TYPE IF NOT EXISTS, so guard with a DO block.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'file_upload_status') THEN
    CREATE TYPE file_upload_status AS ENUM ('pending', 'processing', 'parsed', 'failed');
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS file_uploads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  filename TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  mime_type TEXT,
  source_type TEXT NOT NULL,              -- 'financial' | 'utility'
  parser_hint TEXT,                        -- e.g. 'amex' when auto-detected; null if unknown
  destination_path TEXT NOT NULL,          -- path inside container volume
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status file_upload_status NOT NULL DEFAULT 'pending',
  capture_ids UUID[] DEFAULT '{}',
  error_message TEXT,
  processed_at TIMESTAMPTZ,
  duration_ms INTEGER
);

-- Chronological listing for the dashboard Uploads feed
CREATE INDEX IF NOT EXISTS idx_file_uploads_uploaded_at
  ON file_uploads (uploaded_at DESC);

-- Partial index for the worker/reconciliation queries (in-flight rows only)
CREATE INDEX IF NOT EXISTS idx_file_uploads_status
  ON file_uploads (status)
  WHERE status IN ('pending', 'processing');
