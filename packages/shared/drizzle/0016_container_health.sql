-- Migration 0016: Container health tracking table
-- Stores health check results for each container, queried by the container-health skill.
-- Indexes optimized for: reverse-chronological queries, per-container history, and unhealthy-only scans.

CREATE TABLE IF NOT EXISTS container_health (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  container_name VARCHAR(64) NOT NULL,
  healthy BOOLEAN NOT NULL,
  response_ms INTEGER,
  error TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Primary query: most recent health checks across all containers
CREATE INDEX IF NOT EXISTS container_health_timestamp_desc_idx ON container_health (timestamp DESC);

-- Per-container history: "show me the last N checks for core-api"
CREATE INDEX IF NOT EXISTS container_health_name_timestamp_idx ON container_health (container_name, timestamp DESC);

-- Partial index: only unhealthy rows — fast consecutive-failure lookups
CREATE INDEX IF NOT EXISTS container_health_unhealthy_idx ON container_health (container_name, timestamp DESC) WHERE healthy = false;
