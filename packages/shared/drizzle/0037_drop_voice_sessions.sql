-- Migration: 0037_drop_voice_sessions
-- #298 / D143: remove the dead `voice_sessions` table.
--
-- `voice_sessions` backed the conversational-voice (Pipecat) feature. Its
-- only writer — the `voice-pipecat` service — was already removed (#298/D143),
-- so the table is permanently frozen dead surface (no reads, no writes). This
-- DROP is DESTRUCTIVE: it deletes any remaining (frozen) rows. The table and
-- its index (`voice_sessions_started_at_desc_idx`) go with it via CASCADE.
--
-- This is DISTINCT from the iOS-Shortcut voice-CAPTURE flow, which does NOT
-- use this table and is unaffected.
--
-- Reverse: re-create via 0017_voice_sessions.sql (data is not recoverable).

DROP TABLE IF EXISTS voice_sessions CASCADE;
