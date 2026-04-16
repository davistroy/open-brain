-- Migration 0020: email_classifications, email_corrections, email_daily_summaries
-- Stores email pipeline classification results, user corrections, and daily summaries.
-- Replaces the Python/SQLite sidecar with Postgres-native storage.

CREATE TABLE IF NOT EXISTS email_classifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  sender TEXT NOT NULL,
  subject TEXT,
  category TEXT NOT NULL,
  confidence NUMERIC(3,2),
  tier TEXT NOT NULL,
  folder_id TEXT,
  moved BOOLEAN DEFAULT false,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ec_provider_message_idx
  ON email_classifications (provider, message_id);

CREATE INDEX IF NOT EXISTS ec_category_processed_idx
  ON email_classifications (category, processed_at);

CREATE INDEX IF NOT EXISTS ec_processed_at_idx
  ON email_classifications (processed_at);

CREATE TABLE IF NOT EXISTS email_corrections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  old_category TEXT NOT NULL,
  new_category TEXT NOT NULL,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS email_daily_summaries (
  date TEXT PRIMARY KEY,
  email_count INTEGER NOT NULL,
  categories JSONB,
  summary_text TEXT,
  posted_to_brain BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
