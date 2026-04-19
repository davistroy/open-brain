-- Migration 0024: CHECK constraints on captures.capture_type + captures.pipeline_status
--
-- Tightens both columns from unconstrained text to canonical value sets.
-- TS unions in packages/shared/src/types/capture.ts remain source of truth;
-- these CHECKs are DB-level belt-and-suspenders. Mirrors the migration 0022
-- pattern (captures.source — see Entry 089 for the "9th value" precedent).
--
-- Rationale: pgEnum was considered and rejected. ALTER TYPE ADD VALUE commits
-- immediately and removing values requires table-rewriting gymnastics. A CHECK
-- constraint gives 80% of pgEnum's safety with 10% of the maintenance cost —
-- adding a new value is one new migration with DROP + ADD.
--
-- Pre-flight audits (MANDATORY — see CLAUDE.md "Pre-flight DB audit" rule and
-- LAB_NOTEBOOK Entry 102):
--   SELECT capture_type, COUNT(*) FROM captures GROUP BY capture_type ORDER BY 2 DESC;
--   SELECT pipeline_status, COUNT(*) FROM captures GROUP BY pipeline_status ORDER BY 2 DESC;
--
-- P09a pre-flight (homeserver, 2026-04-19):
--   capture_type:    observation 11005 / reflection 51 / decision 3 / task 3 / win 2
--   pipeline_status: complete 11035 / extracted 11 / pending 10 / deleted 8
--
-- Notes on the pipeline_status canonical set (8 values):
--   The phase planner proposed 6 (dropping `extracted` and `chunked`).
--   Pre-flight audit + production-code audit during Gate 3 surfaced two more:
--     - `extracted` — 11 rows in DB (legacy / cold-path; no current producer
--       in code, but historical rows exist). ADDED.
--     - `chunked`  — 0 rows in DB BUT an active producer in
--       packages/workers/src/jobs/document-pipeline.ts:330 via a ternary
--       expression (`chunks.length === 1 ? 'complete' : 'chunked'`). The
--       planner's grep missed this because the literal is not in a
--       `pipeline_status: 'chunked'` keyed-property pattern. Excluding it
--       would 23514-violate every multi-chunk document. ADDED.
--   `received` is referenced ONLY in read filters (stale-captures.ts,
--   daily-sweep.ts) for legacy detection — zero current producers, zero DB
--   rows. Read-only references are unaffected by the CHECK. EXCLUDED.
--
-- If any unexpected value appears in a future audit, STOP and revise the
-- canonical set (TS / Zod / DB / drift-guard, all 4 surfaces) BEFORE applying.

ALTER TABLE captures
  DROP CONSTRAINT IF EXISTS captures_capture_type_check;

ALTER TABLE captures
  ADD CONSTRAINT captures_capture_type_check
  CHECK (capture_type IN (
    'decision',
    'idea',
    'observation',
    'task',
    'win',
    'blocker',
    'question',
    'reflection'
  ));

ALTER TABLE captures
  DROP CONSTRAINT IF EXISTS captures_pipeline_status_check;

ALTER TABLE captures
  ADD CONSTRAINT captures_pipeline_status_check
  CHECK (pipeline_status IN (
    'pending',
    'processing',
    'extracted',
    'embedded',
    'chunked',
    'complete',
    'failed',
    'deleted'
  ));
