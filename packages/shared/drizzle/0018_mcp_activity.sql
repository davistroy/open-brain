-- Migration 0014: MCP activity logging table
-- Tracks every MCP tool call with parameters, duration, and result summary

CREATE TABLE IF NOT EXISTS mcp_activity (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
  client_id VARCHAR(64),
  tool_name VARCHAR(64) NOT NULL,
  parameters JSONB,
  result_summary TEXT,
  duration_ms INTEGER,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS mcp_activity_timestamp_idx ON mcp_activity(timestamp DESC);
CREATE INDEX IF NOT EXISTS mcp_activity_tool_name_idx ON mcp_activity(tool_name);
