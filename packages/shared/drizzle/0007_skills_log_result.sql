-- Migration: Add result JSONB column to skills_log
-- Purpose: Store the structured AI output from each skill execution so the
--          Briefs UI can render individual sections (wins, blockers, risks, etc.)
--          without parsing the plain-text output_summary field.
--
-- The column is nullable — existing rows and skills that don't produce
-- structured output are unaffected.

ALTER TABLE skills_log ADD COLUMN IF NOT EXISTS result jsonb;
