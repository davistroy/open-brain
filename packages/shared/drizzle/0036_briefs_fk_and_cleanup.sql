-- Migration: 0036_briefs_fk_and_cleanup
-- DA-1 / A135: the `briefs_source_skill_log_id_fkey` constraint (origin
-- 0030_briefs.sql:25, init-schema.sql:1816) has no ON DELETE action, so any
-- brief referencing a >60d skills_log row blocks that row's DELETE with
-- SQLSTATE 23503. Briefs are never pruned, so this recurs every Sunday in
-- the data-retention-prune job (failing in production since 2026-07-05).
--
-- Fix: drop and re-add the constraint with ON DELETE SET NULL.
-- source_skill_log_id is nullable, and the partial unique index
-- `WHERE source_skill_log_id IS NOT NULL` tolerates multiple NULLs, so
-- SET NULL is safe and preserves the brief row (no data loss).
--
-- DA-7: fold in the drop of the dead fts_search(text, integer) function —
-- defined only in the init-schema snapshot (was :130-133), zero TS callers.
-- The live search functions are fts_only_search() and hybrid_search();
-- do NOT touch either.
--
-- Idempotent under ON_ERROR_STOP=1 (DROP CONSTRAINT/FUNCTION IF EXISTS).
--
-- Rollback: ALTER TABLE briefs DROP CONSTRAINT IF EXISTS
-- briefs_source_skill_log_id_fkey; ALTER TABLE briefs ADD CONSTRAINT
-- briefs_source_skill_log_id_fkey FOREIGN KEY (source_skill_log_id)
-- REFERENCES skills_log(id); -- fts_search is not restored (dead code).

ALTER TABLE briefs
  DROP CONSTRAINT IF EXISTS briefs_source_skill_log_id_fkey;

ALTER TABLE briefs
  ADD CONSTRAINT briefs_source_skill_log_id_fkey
  FOREIGN KEY (source_skill_log_id)
  REFERENCES skills_log(id)
  ON DELETE SET NULL;

DROP FUNCTION IF EXISTS public.fts_search(text, integer);
