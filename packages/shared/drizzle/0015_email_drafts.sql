-- Migration 0015: Email drafts table
-- Stores outbound email drafts for review-before-send and auto-send workflows.
-- Used by HimalayaService for SMTP sending and email-compose skill for LLM composition.

CREATE TABLE IF NOT EXISTS email_drafts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  to_address TEXT NOT NULL,
  cc_address TEXT,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'draft',          -- draft | approved | sent | rejected | failed
  send_mode VARCHAR(20) NOT NULL DEFAULT 'review-required', -- review-required | auto-send
  source VARCHAR(32),                                   -- skill | slack | mcp | api
  approved_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  himalaya_message_id VARCHAR(256),
  capture_id UUID REFERENCES captures(id) ON DELETE SET NULL,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Primary query: list drafts by status (pending review, sent history)
CREATE INDEX IF NOT EXISTS email_drafts_status_idx ON email_drafts (status);

-- Chronological listing and cleanup
CREATE INDEX IF NOT EXISTS email_drafts_created_at_idx ON email_drafts (created_at DESC);
