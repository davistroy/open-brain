-- Migration 0028: lab_results table for structured lab report extraction (P20a)
-- Pre-assigned slot to avoid conflict with P22a (0029).
-- Table is Python-accessed only (scripts/lab-report-extract.py + P20b synthesis).
-- Drizzle schema NOT updated — TypeScript never queries this table.

CREATE TABLE IF NOT EXISTS lab_results (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id         text        NOT NULL,           -- SHA-256(basename + collection_date)
  source_file       text        NOT NULL,           -- original filename (not full path)
  layout            text        NOT NULL,           -- 'quest' | 'labcorp' | 'hospital' | 'generic'
  collection_date   date        NOT NULL,
  ordering_provider text,
  test_name         text        NOT NULL,
  test_code         text,                           -- LOINC or lab-specific code when present
  raw_value         text        NOT NULL,           -- exactly as printed in PDF
  numeric_value     float,
  units             text,
  ref_range_text    text,                           -- raw range string: "1.00-2.50" or "<10.0"
  ref_low           float,
  ref_high          float,
  ref_comparator    text,                           -- '<' | '>' | null
  lab_flag          text,                           -- raw flag from PDF: 'H' | 'L' | 'A' | 'C' | null
  derived_flag      text,                           -- computed: 'HIGH' | 'LOW' | 'ABNORMAL' | 'NORMAL' | null
  extracted_at      timestamptz NOT NULL DEFAULT now(),

  UNIQUE (report_id, test_name)                     -- idempotent re-extraction
);

CREATE INDEX idx_lab_results_collection_date ON lab_results (collection_date DESC);
CREATE INDEX idx_lab_results_report_id       ON lab_results (report_id);
CREATE INDEX idx_lab_results_test_name       ON lab_results (test_name);
