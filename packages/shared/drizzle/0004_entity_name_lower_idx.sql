-- Entity name lookup indexes for case-insensitive resolution without full table scans.
-- Supports Tier 1 (name/canonical_name) lookups in resolveOrCreateEntity.
CREATE INDEX IF NOT EXISTS entities_entity_type_lower_name_idx ON entities (entity_type, lower(name));
CREATE INDEX IF NOT EXISTS entities_entity_type_lower_canonical_idx ON entities (entity_type, lower(canonical_name));
