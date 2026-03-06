ALTER TABLE captures ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS captures_deleted_at_idx ON captures (deleted_at) WHERE deleted_at IS NULL;
UPDATE captures SET deleted_at = updated_at WHERE pipeline_status = 'deleted';
