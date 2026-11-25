-- dr-seed.sql — synthetic seed for scripts/test-restore-e2e.sh (item 7.2).
-- ~5,000 captures with random vector(768) embeddings and synthetic text. Nothing here is
-- real data. Sized so the captures heap exceeds min_parallel_table_scan_size (8 MB):
-- each row carries ~1.7 KB of INLINE, incompressible text (md5 chains; repeat() would be
-- compressed by TOAST and shrink the heap to ~2 MB; the 3 KB vector itself is toasted), so a CREATE INDEX ... USING hnsw is planned with
-- parallel workers and needs a ~509 MB DSM segment at maintenance_work_mem = 512MB.
-- Run with PGOPTIONS='-c max_parallel_maintenance_workers=0' in a 64 MB /dev/shm container
-- (the HNSW index already exists from init-schema.sql, so every insert maintains it).
INSERT INTO captures (content, content_hash, capture_type, brain_view, source, tags,
                      embedding, pipeline_status, source_metadata)
SELECT
  'synthetic capture ' || g || ' ' ||
    (SELECT string_agg(md5(g::text || ':' || i::text), '') FROM generate_series(1, 52) i),
  md5('dr-seed-' || g::text),
  (ARRAY['decision','idea','observation','task','win','blocker','question','reflection'])[1 + g % 8],
  (ARRAY['career','personal','technical','work-internal','client'])[1 + g % 5],
  (ARRAY['slack','voice','api','document','mcp','email','file','consolidation','system'])[1 + g % 9],
  ARRAY['seed', 't' || (g % 7)],
  -- g * 0 makes the subselect depend on g, so it is evaluated once per row.
  (SELECT array_agg(random() + i * 0 + g * 0)::vector(768) FROM generate_series(1, 768) i),
  'complete',
  jsonb_build_object('seed', true, 'n', g)
FROM generate_series(1, 5000) g;

ANALYZE captures;
