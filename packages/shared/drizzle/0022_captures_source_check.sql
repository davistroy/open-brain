-- Migration 0022: CHECK constraint on captures.source
--
-- Tightens captures.source from unconstrained text to one of 8 canonical values.
-- The TS union CaptureSource in packages/shared/src/types/capture.ts remains the
-- source of truth; this CHECK is a DB-level belt-and-suspenders.
--
-- Rationale: pgEnum was considered and rejected. ALTER TYPE ADD VALUE commits
-- immediately and removing values requires table-rewriting gymnastics. A CHECK
-- constraint gives 80% of pgEnum's safety with 10% of the maintenance cost —
-- adding a new source is one new migration with DROP + ADD.
--
-- Pre-flight audit required before applying: verify every distinct value in
-- production captures.source is in the 8-value allowlist.
--   SELECT source, COUNT(*) FROM captures GROUP BY source ORDER BY source;
--
-- If any unexpected value appears, STOP and investigate before applying.

ALTER TABLE captures
  DROP CONSTRAINT IF EXISTS captures_source_check;

ALTER TABLE captures
  ADD CONSTRAINT captures_source_check
  CHECK (source IN (
    'slack',
    'voice',
    'api',
    'document',
    'mcp',
    'email',
    'file',
    'consolidation',
    'system'
  ));
