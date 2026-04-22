-- Migration 0030: briefs table (CS2 — Cloudscape M2)
-- First-class brief domain model replacing ad-hoc skills_log wrapping.
--
-- Stores structured AI-generated briefs (daily, weekly, dossier, decision,
-- project, monthly) with body_html rendered by the unified-stack renderer
-- (Phase 5), a navigable TOC, source references, and refine options for
-- async single-shot HTML refinement (SSE delivery, ~3s, Option 2).
--
-- Foreign keys:
--   source_skill_log_id → skills_log(id)  — originating skill run (nullable)
--   refined_from_id     → briefs(id)      — self-referential refinement chain
--
-- Rollback: DROP TABLE briefs CASCADE;

CREATE TABLE IF NOT EXISTS briefs (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                 TEXT        NOT NULL,
  cover                TEXT        NOT NULL,
  title                TEXT        NOT NULL,
  subtitle             TEXT,
  body_html            TEXT        NOT NULL,
  toc                  JSONB       NOT NULL DEFAULT '[]',
  sources              JSONB       NOT NULL DEFAULT '[]',
  refine_options       JSONB       NOT NULL DEFAULT '[]',
  source_skill_log_id  UUID        REFERENCES skills_log(id),
  refined_from_id      UUID        REFERENCES briefs(id),
  generated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_at              TIMESTAMPTZ,
  dismissed_at         TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE briefs
  ADD CONSTRAINT briefs_kind_check
  CHECK (kind IN ('DAILY', 'WEEKLY', 'DOSSIER', 'DECISION', 'PROJECT', 'MONTHLY'));

ALTER TABLE briefs
  ADD CONSTRAINT briefs_cover_check
  CHECK (cover IN ('parchment', 'evening', 'sunrise', 'gold', 'canvas', 'slate'));

-- Descending chronological scan (list endpoint default order)
CREATE INDEX IF NOT EXISTS briefs_generated_at_idx
  ON briefs (generated_at DESC);

-- Filtered by kind (e.g. "show me all WEEKLY briefs")
CREATE INDEX IF NOT EXISTS briefs_kind_idx
  ON briefs (kind);

-- Unread inbox view — partial index keeps it small
CREATE INDEX IF NOT EXISTS briefs_unread_idx
  ON briefs (generated_at DESC)
  WHERE read_at IS NULL AND dismissed_at IS NULL;

-- Prevent duplicate briefs from the same skill run
CREATE UNIQUE INDEX IF NOT EXISTS briefs_source_skill_log_id_idx
  ON briefs (source_skill_log_id)
  WHERE source_skill_log_id IS NOT NULL;

-- Refinement chain traversal
CREATE INDEX IF NOT EXISTS briefs_refined_from_id_idx
  ON briefs (refined_from_id)
  WHERE refined_from_id IS NOT NULL;

-- updated_at trigger (set_updated_at function defined in 0001_custom_extensions.sql)
DROP TRIGGER IF EXISTS set_briefs_updated_at ON briefs;
CREATE TRIGGER set_briefs_updated_at
  BEFORE UPDATE ON briefs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
