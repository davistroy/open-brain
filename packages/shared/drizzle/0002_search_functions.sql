-- migration: 0002
-- Search SQL functions: hybrid_search (FTS + vector cosine with RRF), actr_temporal_score, update_capture_embedding
-- These are raw SQL migrations — no Drizzle schema changes.

-- ---------------------------------------------------------------------------
-- 1. hybrid_search
--    Combines full-text search (FTS) and vector cosine similarity via
--    Reciprocal Rank Fusion (RRF).
--
--    Algorithm:
--      - FTS lane: rank rows by ts_rank_cd(to_tsvector('english', content), plainto_tsquery('english', query_text))
--      - Vector lane: rank rows by (embedding <=> query_embedding) ASC (cosine distance)
--      - RRF fusion: rrf_score = 1/(k + rank_fts) + 1/(k + rank_vector), k=60
--      - Return top match_count rows ordered by rrf_score DESC
--
--    Parameters:
--      query_text      — plain search string, converted to tsquery internally
--      query_embedding — 768-dimensional query embedding (vector(768))
--      match_count     — maximum rows to return
--      fts_weight      — multiplier applied to the FTS RRF lane (default 1.0)
--      vector_weight   — multiplier applied to the vector RRF lane (default 1.0)
--
--    Notes:
--      - Only captures with embedding IS NOT NULL and deleted_at IS NULL are searched.
--        We do NOT filter on pipeline_status so that captures in 'embedded' state
--        (before entity extraction completes) are still searchable.
--      - plainto_tsquery is used for safe handling of plain-text user queries.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION hybrid_search(
  query_text      text,
  query_embedding vector(768),
  match_count     int,
  fts_weight      float DEFAULT 1.0,
  vector_weight   float DEFAULT 1.0
)
RETURNS TABLE (
  capture_id  uuid,
  rrf_score   float,
  fts_score   float,
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
      AND to_tsvector('english', c.content) @@ plainplainto_tsquery('english', query_text)
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
-- 2. actr_temporal_score
--    Applies ACT-R-inspired temporal decay to a base similarity score.
--
--    Formula:
--      if temporal_weight = 0.0 → returns base_score unchanged (cold-start safe)
--      otherwise:
--        hours_since = EXTRACT(EPOCH FROM (NOW() - created_at)) / 3600
--        decay       = exp(-decay_rate * sqrt(hours_since))
--        result      = base_score * decay * temporal_weight
--                    + base_score * (1 - temporal_weight)
--
--    The default temporal_weight = 0.0 means pure semantic ordering at launch.
--    As search history builds, callers can ramp temporal_weight toward 1.0.
--
--    decay_rate is fixed at 0.01 (gentle decay; a capture from 1 week ago
--    retains ~85% of its decay factor; from 1 year ago ~27%).
-- ---------------------------------------------------------------------------
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
  -- Cold-start shortcut: temporal_weight = 0 → pure base_score
  IF temporal_weight = 0.0 THEN
    RETURN base_score;
  END IF;

  hours_since := GREATEST(
    EXTRACT(EPOCH FROM (NOW() - created_at)) / 3600.0,
    0.0
  );

  decay := EXP(-decay_rate * SQRT(hours_since));

  RETURN base_score * decay * temporal_weight
       + base_score * (1.0 - temporal_weight);
END;
$$;


-- ---------------------------------------------------------------------------
-- 3. update_capture_embedding
--    Atomically writes an embedding and marks the capture as embedded.
--    Sets pipeline_status = 'embedded' (intermediate status between
--    'processing' and 'complete'; the extract/link stages set 'complete').
-- ---------------------------------------------------------------------------
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
