-- Migration: 0009
-- Push search filters (brain_view, capture_type, date range) into SQL functions.
-- Previously these filters were applied in-memory in SearchService after
-- overfetching 5x rows. Now Postgres applies them via WHERE clauses, letting
-- indexes do the work and eliminating overfetch.

-- ---------------------------------------------------------------------------
-- 1. hybrid_search — add optional filter parameters
-- ---------------------------------------------------------------------------
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


-- ---------------------------------------------------------------------------
-- 2. fts_only_search — add optional filter parameters
-- ---------------------------------------------------------------------------
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
