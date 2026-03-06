-- Migration: 0003_entity_relationships
-- Adds entity_relationships table for the entity co-occurrence graph.
-- Created: 2026-03-05 (work item 12.2 — Entity graph relationships)
--
-- Relationships are undirected. The canonical form always has
-- entity_id_a < entity_id_b (UUID lexicographic ordering) to prevent
-- duplicate rows for the same pair in reversed order.
-- The link-entities pipeline stage enforces this ordering at insert time.

CREATE TABLE IF NOT EXISTS "entity_relationships" (
  "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "entity_id_a"         uuid NOT NULL REFERENCES "entities"("id") ON DELETE CASCADE,
  "entity_id_b"         uuid NOT NULL REFERENCES "entities"("id") ON DELETE CASCADE,
  "co_occurrence_count" integer NOT NULL DEFAULT 1,
  "weight"              real NOT NULL DEFAULT 1.0,
  "last_seen_at"        timestamptz NOT NULL DEFAULT now(),
  "created_at"          timestamptz NOT NULL DEFAULT now(),
  "updated_at"          timestamptz NOT NULL DEFAULT now()
);

-- Unique constraint enforces one row per ordered (a < b) pair
CREATE UNIQUE INDEX IF NOT EXISTS "entity_relationships_pair_idx"
  ON "entity_relationships" ("entity_id_a", "entity_id_b");

CREATE INDEX IF NOT EXISTS "entity_relationships_entity_id_a_idx"
  ON "entity_relationships" ("entity_id_a");

CREATE INDEX IF NOT EXISTS "entity_relationships_entity_id_b_idx"
  ON "entity_relationships" ("entity_id_b");

CREATE INDEX IF NOT EXISTS "entity_relationships_last_seen_at_idx"
  ON "entity_relationships" ("last_seen_at");
