-- Migration: 0035_retention_audit
-- RC-4: event-table retention — creates the audit table that records each
-- automated deletion pass by the data-retention-prune workers job.
--
-- retention_audit is a DB-internal housekeeping table — it is intentionally
-- NOT modelled in the Drizzle schema (the app never queries it via ORM; only
-- the data-retention-prune job writes to it via raw SQL).  Like content_tsvector,
-- it is an operational artifact rather than an application data column.
--
-- admin_audit is NEVER in the prune list — it is the permanent audit trail for
-- /admin/reset-data operations and must survive any data wipe.  That invariant
-- is enforced at the code level in data-retention-prune.ts and asserted by
-- data-retention-prune.test.ts.
--
-- Idempotent (CREATE TABLE IF NOT EXISTS) — safe to re-apply on top of the
-- regenerated init-schema snapshot.
--
-- Rollback: DROP TABLE IF EXISTS retention_audit;

CREATE TABLE IF NOT EXISTS retention_audit (
  id             uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  table_name     text         NOT NULL,
  deleted_count  bigint       NOT NULL,
  cutoff         timestamptz  NOT NULL,
  ran_at         timestamptz  NOT NULL DEFAULT now()
);

-- Index for recent-run lookups and monitoring queries.
CREATE INDEX IF NOT EXISTS retention_audit_ran_at_idx
  ON retention_audit (ran_at DESC);
