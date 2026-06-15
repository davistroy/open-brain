-- Migration 0033: schema correctness (DA-L3 + DA-L5 + legacy search-overload cleanup)
--
-- DA-L3: captures_content_hash_idx is a FULL unique index, so a soft-deleted
--   capture permanently reserves its content_hash — identical content can never
--   be re-ingested even after the original is soft-deleted. Make it a PARTIAL
--   unique index (WHERE deleted_at IS NULL) so only LIVE captures enforce
--   uniqueness; soft-deleted content becomes re-ingestable. Live-duplicate
--   detection (23505 -> ConflictError in capture.ts) is preserved.
--
-- DA-L5: email_classifications (provider, message_id) is only a NON-unique
--   index, so the same provider message can be classified-and-stored more than
--   once. Replace it with a UNIQUE index after a one-time dedup pre-flight.
--
-- Cleanup: migration 0009 (search_filter_params) added FILTERED overloads of
--   hybrid_search()/fts_only_search() but never dropped the original short-arg
--   overloads, so production carries two of each. The app (services/search.ts)
--   only ever calls the filtered forms; the short forms are dead and also create
--   an overload-resolution ambiguity. Drop them. Surfaced by the Phase 5
--   init-schema regeneration (DA-H1).
--
-- Idempotency / ordering: DROP-then-CREATE / DROP IF EXISTS throughout, and this
-- is the LAST migration to touch these objects. In the CI parity build
-- (init-schema + ALL migrations), 0020 re-creates the non-unique
-- ec_provider_message_idx and 0002/0006/0009/0027 re-create the search functions;
-- 0033 runs afterward and removes the redundant ones, so the final state matches
-- init-schema alone.

-- ---------------------------------------------------------------------------
-- DA-L3: partial-unique content_hash index
-- ---------------------------------------------------------------------------
DROP INDEX IF EXISTS captures_content_hash_idx;
CREATE UNIQUE INDEX IF NOT EXISTS captures_content_hash_idx
  ON captures (content_hash)
  WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- DA-L5: email_classifications UNIQUE(provider, message_id)
-- ---------------------------------------------------------------------------
-- Dedup pre-flight: keep the most-recent row per (provider, message_id),
-- tie-breaking on physical ctid. No-op on a clean / empty table.
DELETE FROM email_classifications a
USING email_classifications b
WHERE a.provider = b.provider
  AND a.message_id = b.message_id
  AND (
    a.processed_at < b.processed_at
    OR (a.processed_at = b.processed_at AND a.ctid < b.ctid)
  );

-- Replace the non-unique lookup index with a unique one (a UNIQUE index also
-- serves the (provider, message_id) lookup, so no separate index is needed).
DROP INDEX IF EXISTS ec_provider_message_idx;
CREATE UNIQUE INDEX IF NOT EXISTS ec_provider_message_uniq
  ON email_classifications (provider, message_id);

-- ---------------------------------------------------------------------------
-- Drop dead pre-0009 search-function overloads (the app calls only the filtered forms)
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS hybrid_search(text, vector, integer, double precision, double precision);
DROP FUNCTION IF EXISTS fts_only_search(text, integer);
