-- Migration: 0032_spreading_activation_deleted_filter
-- Fixes SE-6: spreading_activation() leaked soft-deleted captures via entity graph.
-- CREATE OR REPLACE is idempotent — safe to re-run.
--
-- Change: hop1 and hop2 CTEs now join against captures to filter deleted_at IS NULL
-- before returning capture_ids. This prevents soft-deleted captures from appearing
-- in spreading activation results regardless of their entity links.

CREATE OR REPLACE FUNCTION spreading_activation(
  seed_capture_ids UUID[],
  max_hops INT DEFAULT 2,
  max_related INT DEFAULT 10
)
RETURNS TABLE(capture_id UUID, activation_score REAL, hop_count INT)
LANGUAGE plpgsql STABLE PARALLEL SAFE
AS $$
BEGIN
  RETURN QUERY

  WITH
  -- Step 1: Get entities linked to seed captures (with their confidence scores)
  seed_entities AS (
    SELECT DISTINCT
      el.entity_id,
      el.confidence
    FROM entity_links el
    WHERE el.capture_id = ANY(seed_capture_ids)
      AND el.confidence IS NOT NULL
      AND el.confidence > 0
  ),

  -- Hop 1: From seed entities, find other captures linked to those same entities.
  -- Join captures to exclude soft-deleted rows (SE-6).
  hop1 AS (
    SELECT
      el.capture_id AS cid,
      -- Score = SUM(seed_link_confidence * target_link_confidence) / 1
      SUM(
        COALESCE(se.confidence, 1.0) * COALESCE(el.confidence, 1.0)
      )::REAL AS score,
      1 AS hops
    FROM seed_entities se
    JOIN entity_links el ON el.entity_id = se.entity_id
    JOIN captures c ON c.id = el.capture_id AND c.deleted_at IS NULL
    WHERE el.capture_id <> ALL(seed_capture_ids)
    GROUP BY el.capture_id
  ),

  -- Hop 2 (only if max_hops >= 2):
  -- From seed entities, traverse entity_relationships to find related entities,
  -- then find captures linked to those related entities.
  -- Join captures to exclude soft-deleted rows (SE-6).
  hop2 AS (
    SELECT
      el.capture_id AS cid,
      -- Score = SUM(seed_confidence * relationship_weight * target_confidence) / 2
      SUM(
        COALESCE(se.confidence, 1.0)
        * COALESCE(er.weight, 1.0)
        * COALESCE(el.confidence, 1.0)
      )::REAL / 2.0 AS score,
      2 AS hops
    FROM seed_entities se
    -- Traverse entity_relationships in both directions (undirected graph)
    JOIN entity_relationships er
      ON er.entity_id_a = se.entity_id OR er.entity_id_b = se.entity_id
    -- Get the "other" entity in the relationship
    JOIN entity_links el
      ON el.entity_id = CASE
        WHEN er.entity_id_a = se.entity_id THEN er.entity_id_b
        ELSE er.entity_id_a
      END
    JOIN captures c ON c.id = el.capture_id AND c.deleted_at IS NULL
    WHERE max_hops >= 2
      -- Exclude seed captures
      AND el.capture_id <> ALL(seed_capture_ids)
      -- Exclude entities we already found directly (those are hop 1)
      AND el.entity_id NOT IN (SELECT entity_id FROM seed_entities)
    GROUP BY el.capture_id
  ),

  -- Combine hops, deduplicate: keep best score per capture, prefer lower hop count
  combined AS (
    SELECT cid, score, hops FROM hop1
    UNION ALL
    SELECT cid, score, hops FROM hop2
  ),

  ranked AS (
    SELECT
      c.cid,
      SUM(c.score)::REAL AS total_score,
      MIN(c.hops) AS min_hops
    FROM combined c
    GROUP BY c.cid
    ORDER BY total_score DESC
    LIMIT max_related
  )

  SELECT
    r.cid AS capture_id,
    r.total_score AS activation_score,
    r.min_hops AS hop_count
  FROM ranked r;
END;
$$;
