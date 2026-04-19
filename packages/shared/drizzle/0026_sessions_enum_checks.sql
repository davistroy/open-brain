-- Migration 0026: CHECK constraints on sessions.session_type + sessions.status
--
-- Tightens both columns from unconstrained text to canonical value sets.
-- TS unions in packages/shared/src/types/session.ts are source of truth;
-- these CHECKs are DB-level belt-and-suspenders.
--
-- Pre-flight audits (MANDATORY -- see CLAUDE.md "Pre-flight DB audit" rule):
--   SELECT DISTINCT session_type, COUNT(*) FROM sessions GROUP BY session_type ORDER BY 2 DESC;
--   SELECT DISTINCT status, COUNT(*) FROM sessions GROUP BY status ORDER BY 2 DESC;
--
-- P09c pre-flight (homeserver, 2026-04-19):
--   session_type: governance 3 / planning 1 / review 1
--   status:       complete 3 / active 2
--
-- session_type canonical set (3 values):
--   governance | review | planning
--   All values are actively produced via SessionService.create() and
--   slack-bot board command handler. Route layer (sessions.ts) validates
--   against VALID_TYPES before any write reaches the DB.
--
-- status canonical set (4 values):
--   active | paused | complete | abandoned
--   All 4 values are actively produced by SessionService lifecycle methods.
--   Default on create is 'active'. 'paused' can be resumed within 30 days.
--   'complete' and 'abandoned' are true terminals (no current DB rows for
--   paused/abandoned -- those states haven't been reached in production yet).
--
-- If any unexpected value appears in a future audit, STOP and revise the
-- canonical set (TS union + DB CHECK, both surfaces) BEFORE applying.

ALTER TABLE sessions
  DROP CONSTRAINT IF EXISTS sessions_session_type_check;

ALTER TABLE sessions
  ADD CONSTRAINT sessions_session_type_check
  CHECK (session_type IN (
    'governance',
    'review',
    'planning'
  ));

ALTER TABLE sessions
  DROP CONSTRAINT IF EXISTS sessions_status_check;

ALTER TABLE sessions
  ADD CONSTRAINT sessions_status_check
  CHECK (status IN (
    'active',
    'paused',
    'complete',
    'abandoned'
  ));
