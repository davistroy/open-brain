-- Migration 0023: admin_audit table
-- Records every /admin/reset-data attempt: request (token), execution (wipe), blocked (CSRF/bad-token).
-- This table is intentionally EXCLUDED from the reset-data TRUNCATE list.

CREATE TABLE IF NOT EXISTS admin_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type VARCHAR(32) NOT NULL,
  actor TEXT NOT NULL,
  confirmation_phrase TEXT,
  tables_affected TEXT[],
  outcome VARCHAR(16) NOT NULL,
  error_detail TEXT,
  backup_path TEXT,
  origin TEXT,
  ip_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS admin_audit_event_type_idx ON admin_audit(event_type);
CREATE INDEX IF NOT EXISTS admin_audit_actor_idx ON admin_audit(actor);
CREATE INDEX IF NOT EXISTS admin_audit_created_at_idx ON admin_audit(created_at);
