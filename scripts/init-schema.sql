-- Open Brain — Full Schema Init
-- Run against fresh openbrain database

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS captures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  capture_type TEXT NOT NULL,
  brain_view TEXT NOT NULL,
  source TEXT NOT NULL,
  source_metadata JSONB,
  tags TEXT[] NOT NULL DEFAULT '{}'::text[],
  embedding vector(768),
  pipeline_status TEXT NOT NULL DEFAULT 'pending',
  pipeline_attempts INTEGER NOT NULL DEFAULT 0,
  pipeline_error TEXT,
  pipeline_completed_at TIMESTAMPTZ,
  pre_extracted JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  access_count INTEGER NOT NULL DEFAULT 0,
  last_accessed_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS captures_content_hash_idx ON captures(content_hash);
CREATE INDEX IF NOT EXISTS captures_capture_type_idx ON captures(capture_type);
CREATE INDEX IF NOT EXISTS captures_brain_view_idx ON captures(brain_view);
CREATE INDEX IF NOT EXISTS captures_source_idx ON captures(source);
CREATE INDEX IF NOT EXISTS captures_pipeline_status_idx ON captures(pipeline_status);
CREATE INDEX IF NOT EXISTS captures_created_at_idx ON captures(created_at);

CREATE TABLE IF NOT EXISTS pipeline_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  capture_id UUID NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  status TEXT NOT NULL,
  duration_ms INTEGER,
  error TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS pipeline_events_capture_id_idx ON pipeline_events(capture_id);
CREATE INDEX IF NOT EXISTS pipeline_events_stage_idx ON pipeline_events(stage);
CREATE INDEX IF NOT EXISTS pipeline_events_created_at_idx ON pipeline_events(created_at);

CREATE TABLE IF NOT EXISTS ai_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_type TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  total_tokens INTEGER,
  duration_ms INTEGER,
  capture_id UUID REFERENCES captures(id) ON DELETE SET NULL,
  session_id UUID,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ai_audit_log_task_type_idx ON ai_audit_log(task_type);
CREATE INDEX IF NOT EXISTS ai_audit_log_created_at_idx ON ai_audit_log(created_at);
CREATE INDEX IF NOT EXISTS ai_audit_log_capture_id_idx ON ai_audit_log(capture_id);

CREATE TABLE IF NOT EXISTS entities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  aliases TEXT[] NOT NULL DEFAULT '{}'::text[],
  metadata JSONB,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS entities_name_type_idx ON entities(name, entity_type);
CREATE INDEX IF NOT EXISTS entities_entity_type_idx ON entities(entity_type);
CREATE INDEX IF NOT EXISTS entities_canonical_name_idx ON entities(canonical_name);

CREATE TABLE IF NOT EXISTS entity_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  capture_id UUID NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
  relationship TEXT,
  confidence REAL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS entity_links_entity_id_idx ON entity_links(entity_id);
CREATE INDEX IF NOT EXISTS entity_links_capture_id_idx ON entity_links(capture_id);
CREATE UNIQUE INDEX IF NOT EXISTS entity_links_entity_capture_idx ON entity_links(entity_id, capture_id);

CREATE TABLE IF NOT EXISTS entity_relationships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id_a UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  entity_id_b UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  co_occurrence_count INTEGER NOT NULL DEFAULT 1,
  weight REAL NOT NULL DEFAULT 1.0,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS entity_relationships_pair_idx ON entity_relationships(entity_id_a, entity_id_b);
CREATE INDEX IF NOT EXISTS entity_relationships_entity_id_a_idx ON entity_relationships(entity_id_a);
CREATE INDEX IF NOT EXISTS entity_relationships_entity_id_b_idx ON entity_relationships(entity_id_b);
CREATE INDEX IF NOT EXISTS entity_relationships_last_seen_at_idx ON entity_relationships(last_seen_at);

CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  config JSONB,
  context_capture_ids TEXT[] NOT NULL DEFAULT '{}'::text[],
  summary TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS sessions_session_type_idx ON sessions(session_type);
CREATE INDEX IF NOT EXISTS sessions_status_idx ON sessions(status);
CREATE INDEX IF NOT EXISTS sessions_created_at_idx ON sessions(created_at);

CREATE TABLE IF NOT EXISTS session_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS session_messages_session_id_idx ON session_messages(session_id);
CREATE INDEX IF NOT EXISTS session_messages_created_at_idx ON session_messages(created_at);

CREATE TABLE IF NOT EXISTS bets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  statement TEXT NOT NULL,
  confidence REAL NOT NULL,
  domain TEXT,
  resolution_date TIMESTAMPTZ,
  resolution TEXT,
  resolution_notes TEXT,
  session_id UUID REFERENCES sessions(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS bets_domain_idx ON bets(domain);
CREATE INDEX IF NOT EXISTS bets_resolution_idx ON bets(resolution);
CREATE INDEX IF NOT EXISTS bets_resolution_date_idx ON bets(resolution_date);

CREATE TABLE IF NOT EXISTS skills_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_name TEXT NOT NULL,
  capture_id UUID REFERENCES captures(id) ON DELETE SET NULL,
  session_id UUID REFERENCES sessions(id) ON DELETE SET NULL,
  input_summary TEXT,
  output_summary TEXT,
  duration_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS skills_log_skill_name_idx ON skills_log(skill_name);
CREATE INDEX IF NOT EXISTS skills_log_created_at_idx ON skills_log(created_at);

CREATE TABLE IF NOT EXISTS triggers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  condition_text TEXT NOT NULL,
  embedding vector(768),
  threshold REAL NOT NULL DEFAULT 0.8,
  action TEXT NOT NULL,
  action_config JSONB,
  enabled BOOLEAN NOT NULL DEFAULT true,
  last_triggered_at TIMESTAMPTZ,
  trigger_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS triggers_name_idx ON triggers(name);
CREATE INDEX IF NOT EXISTS triggers_enabled_idx ON triggers(enabled);

-- HNSW indexes for vector similarity search
CREATE INDEX IF NOT EXISTS captures_embedding_hnsw_idx ON captures USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
CREATE INDEX IF NOT EXISTS triggers_embedding_hnsw_idx ON triggers USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

-- Full-text search GIN index
CREATE INDEX IF NOT EXISTS captures_content_fts_idx ON captures USING gin (to_tsvector('english', content));

-- updated_at trigger function
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_captures_updated_at ON captures;
CREATE TRIGGER set_captures_updated_at BEFORE UPDATE ON captures FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS set_entities_updated_at ON entities;
CREATE TRIGGER set_entities_updated_at BEFORE UPDATE ON entities FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS set_sessions_updated_at ON sessions;
CREATE TRIGGER set_sessions_updated_at BEFORE UPDATE ON sessions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS set_bets_updated_at ON bets;
CREATE TRIGGER set_bets_updated_at BEFORE UPDATE ON bets FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS set_triggers_updated_at ON triggers;
CREATE TRIGGER set_triggers_updated_at BEFORE UPDATE ON triggers FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Search functions (matches migration chain: 0002 + 0006 + 0009)
CREATE OR REPLACE FUNCTION hybrid_search(
  query_text             text,
  query_embedding        vector(768),
  match_count            int,
  fts_weight             float DEFAULT 1.0,
  vector_weight          float DEFAULT 1.0,
  filter_brain_views     text[] DEFAULT NULL,
  filter_capture_types   text[] DEFAULT NULL,
  filter_date_from       timestamptz DEFAULT NULL,
  filter_date_to         timestamptz DEFAULT NULL
)
RETURNS TABLE (
  capture_id   uuid,
  rrf_score    float,
  fts_score    float,
  vector_score float
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  k int := 60;
BEGIN
  RETURN QUERY
  WITH fts_ranked AS (
    SELECT
      c.id AS capture_id,
      ts_rank_cd(
        to_tsvector('english', c.content),
        plainto_tsquery('english', query_text)
      )::float AS fts_score,
      ROW_NUMBER() OVER (
        ORDER BY ts_rank_cd(
          to_tsvector('english', c.content),
          plainto_tsquery('english', query_text)
        ) DESC
      ) AS fts_rank
    FROM captures c
    WHERE
      c.embedding IS NOT NULL
      AND c.deleted_at IS NULL
      AND to_tsvector('english', c.content) @@ plainto_tsquery('english', query_text)
      AND (filter_brain_views IS NULL OR c.brain_view = ANY(filter_brain_views))
      AND (filter_capture_types IS NULL OR c.capture_type = ANY(filter_capture_types))
      AND (filter_date_from IS NULL OR c.captured_at >= filter_date_from)
      AND (filter_date_to IS NULL OR c.captured_at <= filter_date_to)
  ),
  vector_ranked AS (
    SELECT
      c.id AS capture_id,
      (1.0 - (c.embedding <=> query_embedding))::float AS vector_score,
      ROW_NUMBER() OVER (
        ORDER BY c.embedding <=> query_embedding ASC
      ) AS vector_rank
    FROM captures c
    WHERE
      c.embedding IS NOT NULL
      AND c.deleted_at IS NULL
      AND (filter_brain_views IS NULL OR c.brain_view = ANY(filter_brain_views))
      AND (filter_capture_types IS NULL OR c.capture_type = ANY(filter_capture_types))
      AND (filter_date_from IS NULL OR c.captured_at >= filter_date_from)
      AND (filter_date_to IS NULL OR c.captured_at <= filter_date_to)
  ),
  fused AS (
    SELECT
      COALESCE(f.capture_id, v.capture_id) AS capture_id,
      (
        COALESCE(fts_weight    * (1.0 / (k + COALESCE(f.fts_rank,    2147483647))), 0.0) +
        COALESCE(vector_weight * (1.0 / (k + COALESCE(v.vector_rank, 2147483647))), 0.0)
      )::float AS rrf_score,
      COALESCE(f.fts_score,    0.0)::float AS fts_score,
      COALESCE(v.vector_score, 0.0)::float AS vector_score
    FROM fts_ranked    f
    FULL OUTER JOIN vector_ranked v USING (capture_id)
  )
  SELECT
    fused.capture_id,
    fused.rrf_score,
    fused.fts_score,
    fused.vector_score
  FROM fused
  ORDER BY fused.rrf_score DESC
  LIMIT match_count;
END;
$$;

-- actr_temporal_score
CREATE OR REPLACE FUNCTION actr_temporal_score(
  base_score      float,
  created_at      timestamptz,
  temporal_weight float DEFAULT 0.0
)
RETURNS float
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  decay_rate    float := 0.01;
  hours_since   float;
  decay         float;
BEGIN
  IF temporal_weight = 0.0 THEN
    RETURN base_score;
  END IF;
  hours_since := GREATEST(EXTRACT(EPOCH FROM (NOW() - created_at)) / 3600.0, 0.0);
  decay := EXP(-decay_rate * SQRT(hours_since));
  RETURN base_score * decay * temporal_weight + base_score * (1.0 - temporal_weight);
END;
$$;

-- update_capture_embedding
CREATE OR REPLACE FUNCTION update_capture_embedding(
  capture_id uuid,
  embedding  vector(768)
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE captures
  SET
    embedding       = update_capture_embedding.embedding,
    pipeline_status = 'embedded',
    updated_at      = NOW()
  WHERE id = update_capture_embedding.capture_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'capture not found: %', capture_id;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION vector_search(
  query_embedding vector(768),
  match_limit integer DEFAULT 20,
  similarity_threshold real DEFAULT 0.0
)
RETURNS TABLE (
  id uuid,
  content text,
  capture_type text,
  brain_view text,
  source text,
  tags text[],
  created_at timestamptz,
  captured_at timestamptz,
  similarity real
) AS $$
  SELECT c.id, c.content, c.capture_type, c.brain_view, c.source, c.tags, c.created_at, c.captured_at,
    (1 - (c.embedding <=> query_embedding))::real AS similarity
  FROM captures c
  WHERE c.embedding IS NOT NULL AND c.deleted_at IS NULL AND (1 - (c.embedding <=> query_embedding)) >= similarity_threshold
  ORDER BY c.embedding <=> query_embedding
  LIMIT match_limit;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION fts_search(
  query_text text,
  match_limit integer DEFAULT 20
)
RETURNS TABLE (
  id uuid,
  content text,
  capture_type text,
  brain_view text,
  source text,
  tags text[],
  created_at timestamptz,
  captured_at timestamptz,
  rank real
) AS $$
  SELECT c.id, c.content, c.capture_type, c.brain_view, c.source, c.tags, c.created_at, c.captured_at,
    ts_rank(to_tsvector('english', c.content), plainto_tsquery('english', query_text))::real AS rank
  FROM captures c
  WHERE to_tsvector('english', c.content) @@ plainto_tsquery('english', query_text) AND c.deleted_at IS NULL
  ORDER BY rank DESC
  LIMIT match_limit;
$$ LANGUAGE sql STABLE;

-- fts_only_search (for search_mode='fts', no embedding required)
CREATE OR REPLACE FUNCTION fts_only_search(
  query_text             text,
  match_count            int,
  filter_brain_views     text[] DEFAULT NULL,
  filter_capture_types   text[] DEFAULT NULL,
  filter_date_from       timestamptz DEFAULT NULL,
  filter_date_to         timestamptz DEFAULT NULL
)
RETURNS TABLE (
  capture_id   uuid,
  rrf_score    float,
  fts_score    float,
  vector_score float
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  k int := 60;
BEGIN
  RETURN QUERY
  WITH fts_ranked AS (
    SELECT
      c.id AS capture_id,
      ts_rank_cd(
        to_tsvector('english', c.content),
        plainto_tsquery('english', query_text)
      )::float AS fts_score,
      ROW_NUMBER() OVER (
        ORDER BY ts_rank_cd(
          to_tsvector('english', c.content),
          plainto_tsquery('english', query_text)
        ) DESC
      ) AS fts_rank
    FROM captures c
    WHERE
      c.deleted_at IS NULL
      AND to_tsvector('english', c.content) @@ plainto_tsquery('english', query_text)
      AND (filter_brain_views IS NULL OR c.brain_view = ANY(filter_brain_views))
      AND (filter_capture_types IS NULL OR c.capture_type = ANY(filter_capture_types))
      AND (filter_date_from IS NULL OR c.captured_at >= filter_date_from)
      AND (filter_date_to IS NULL OR c.captured_at <= filter_date_to)
  )
  SELECT
    fts_ranked.capture_id,
    (1.0 / (k + fts_ranked.fts_rank))::float AS rrf_score,
    fts_ranked.fts_score,
    0.0::float AS vector_score
  FROM fts_ranked
  ORDER BY fts_ranked.fts_score DESC
  LIMIT match_count;
END;
$$;

SELECT 'Schema initialization complete' AS result;
