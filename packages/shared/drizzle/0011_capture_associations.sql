-- Migration: 0011_capture_associations
-- Adds capture_associations table for Hebbian learning (co-access tracking).
-- Created: 2026-04-09 (work item 1.1 — Hebbian capture associations)
--
-- Associations are undirected. The canonical form always has
-- capture_id_a < capture_id_b (UUID lexicographic ordering) to prevent
-- duplicate rows for the same pair in reversed order.
-- The co-access tracking worker enforces this ordering at insert time.

CREATE TABLE IF NOT EXISTS "capture_associations" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "capture_id_a"     uuid NOT NULL REFERENCES "captures"("id") ON DELETE CASCADE,
  "capture_id_b"     uuid NOT NULL REFERENCES "captures"("id") ON DELETE CASCADE,
  "co_access_count"  integer NOT NULL DEFAULT 1,
  "weight"           real NOT NULL DEFAULT 1.0,
  "last_co_access"   timestamptz NOT NULL DEFAULT now(),
  "created_at"       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "capture_assoc_ordering" CHECK ("capture_id_a" < "capture_id_b")
);

-- Unique constraint enforces one row per ordered (a < b) pair
CREATE UNIQUE INDEX IF NOT EXISTS "capture_associations_pair_idx"
  ON "capture_associations" ("capture_id_a", "capture_id_b");

CREATE INDEX IF NOT EXISTS "capture_associations_capture_id_a_idx"
  ON "capture_associations" ("capture_id_a");

CREATE INDEX IF NOT EXISTS "capture_associations_capture_id_b_idx"
  ON "capture_associations" ("capture_id_b");

CREATE INDEX IF NOT EXISTS "capture_associations_last_co_access_idx"
  ON "capture_associations" ("last_co_access");
