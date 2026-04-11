-- Migration 0013: Add client tracking columns to ai_audit_log
-- Supports dual-client routing (Anthropic SDK + LiteLLM/OpenAI SDK)

ALTER TABLE ai_audit_log
  ADD COLUMN IF NOT EXISTS client_used VARCHAR(32) DEFAULT 'litellm',
  ADD COLUMN IF NOT EXISTS cost_usd NUMERIC(10, 6) DEFAULT NULL;

-- Backfill: all existing rows were litellm
UPDATE ai_audit_log SET client_used = 'litellm' WHERE client_used IS NULL;

-- Index for filtering by client
CREATE INDEX IF NOT EXISTS ai_audit_log_client_used_idx ON ai_audit_log(client_used);
