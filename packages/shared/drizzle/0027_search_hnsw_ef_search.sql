-- Migration: 0027_search_hnsw_ef_search
-- Adds LIMIT push-down inside vector_ranked and fts_ranked CTEs in hybrid_search().
--
-- Root cause: without LIMIT inside vector_ranked, Postgres materializes all
-- embedded captures (ranked by cosine distance) before the FULL OUTER JOIN.
-- At 100K+ captures this is a full table scan through the HNSW index.
-- With LIMIT match_count*4, pgvector's HNSW scan gets an early-stop bound.
--
-- Overquery factor = 4: match_count is typically 10 -> LIMIT 40.
-- This gives the vector lane enough candidates for RRF fusion while
-- keeping the HNSW traversal bounded at ef_search (60) nodes.
--
-- Pre-flight corpus (2026-04-19, homeserver):
--   total_captures=11064, embedded=11043, hnsw_index=43MB, pgvector=0.8.2
--
-- This migration is safe to apply while the system is live.
-- hybrid_search() is a CREATE OR REPLACE; no table schema changes.
-- No data migration required.
--
-- Rollback: re-apply packages/shared/drizzle/0009_search_filter_params.sql
-- which contains the previous CREATE OR REPLACE FUNCTION hybrid_search().

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
    ORDER BY ts_rank_cd(
      to_tsvector('english', c.content),
      plainto_tsquery('english', query_text)
    ) DESC
    LIMIT match_count * 4   -- overquery: GIN+tsquery prunes first, LIMIT handles pathological common-term cases
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
    ORDER BY c.embedding <=> query_embedding ASC  -- explicit ORDER required for HNSW push-down
    LIMIT match_count * 4                          -- overquery: gives HNSW scan an early-stop bound
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
