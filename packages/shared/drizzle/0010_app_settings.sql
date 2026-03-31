-- Migration: 0010
-- Generic app settings table (key-value, JSONB values).
-- Seeded with the email sender allowlist for the Cloudflare Email Worker.

CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed the email allowlist with Troy's known addresses
INSERT INTO app_settings (key, value) VALUES (
  'email_allowlist',
  '["troy.davis@hotmail.com","troy.e.davis@gmail.com","tdavis@stratfieldconsulting.com","troy.davis@accesscfa.com","troy@k4jda.net"]'::jsonb
) ON CONFLICT (key) DO NOTHING;
