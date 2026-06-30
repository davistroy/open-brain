-- Migration: 0034_content_tsvector
-- PE-M2 (ADR-0003 change set CS-7): stop recomputing to_tsvector() per row.
--
-- hybrid_search() and fts_only_search() called `to_tsvector('english', c.content)`
-- up to 4× per candidate row (SELECT, window ORDER BY, WHERE @@, outer ORDER BY).
-- This adds a STORED generated tsvector column + GIN index and points both FTS
-- functions at the precomputed column, so ranking reads the index/column instead
-- of re-tokenizing content on every search.
--
-- content_tsvector is a DB-internal column for the SQL FTS functions only — it is
-- intentionally NOT modeled in the Drizzle schema (the app never selects it, and
-- adding it would bloat `SELECT * FROM captures`, the PE-L2 concern). It is an
-- index-like artifact, like the HNSW index, not an application data column.
--
-- to_tsvector('english'::regconfig, content) is the IMMUTABLE 2-arg form, required
-- for a GENERATED ALWAYS ... STORED expression. The old expression GIN index
-- (captures_content_fts_idx) becomes redundant and is dropped.
--
-- Idempotent (IF [NOT] EXISTS + CREATE OR REPLACE) so it is a clean no-op when the
-- migration chain is re-applied on top of the regenerated init-schema snapshot.
--
-- Rollback: DROP the column (CASCADE drops its index) and restore the 0027/0009
-- function bodies + the captures_content_fts_idx expression index.

-- 1. Stored, generated tsvector column.
ALTER TABLE captures
  ADD COLUMN IF NOT EXISTS content_tsvector tsvector
  GENERATED ALWAYS AS (to_tsvector('english'::regconfig, content)) STORED;

-- 2. GIN index on the stored column.
CREATE INDEX IF NOT EXISTS captures_content_tsvector_idx
  ON captures USING gin (content_tsvector);

-- 3. Drop the now-redundant expression index.
DROP INDEX IF EXISTS captures_content_fts_idx;

-- 4. hybrid_search() — use the stored column (was migration 0027).
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
        c.content_tsvector,
        plainto_tsquery('english', query_text)
      )::float AS fts_score,
      ROW_NUMBER() OVER (
        ORDER BY ts_rank_cd(
          c.content_tsvector,
          plainto_tsquery('english', query_text)
        ) DESC
      ) AS fts_rank
    FROM captures c
    WHERE
      c.embedding IS NOT NULL
      AND c.deleted_at IS NULL
      AND c.content_tsvector @@ plainto_tsquery('english', query_text)
      AND (filter_brain_views IS NULL OR c.brain_view = ANY(filter_brain_views))
      AND (filter_capture_types IS NULL OR c.capture_type = ANY(filter_capture_types))
      AND (filter_date_from IS NULL OR c.captured_at >= filter_date_from)
      AND (filter_date_to IS NULL OR c.captured_at <= filter_date_to)
    ORDER BY ts_rank_cd(
      c.content_tsvector,
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

-- 5. fts_only_search() — use the stored column (was migration 0009).
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
        c.content_tsvector,
        plainto_tsquery('english', query_text)
      )::float AS fts_score,
      ROW_NUMBER() OVER (
        ORDER BY ts_rank_cd(
          c.content_tsvector,
          plainto_tsquery('english', query_text)
        ) DESC
      ) AS fts_rank
    FROM captures c
    WHERE
      c.deleted_at IS NULL
      AND c.content_tsvector @@ plainto_tsquery('english', query_text)
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
