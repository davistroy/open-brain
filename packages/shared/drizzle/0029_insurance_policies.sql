-- Migration: 0029_insurance_policies
-- Adds insurance_policies table for structured policy coverage data.
--
-- Stores extracted coverage data from insurance policy PDFs: health, auto,
-- home, and umbrella policies. Extraction is T0 Python (pdfplumber + regex)
-- via scripts/insurance-policy-extract.py.
--
-- The `coverage` JSONB column stores a flexible coverage tree per policy type:
--   deductibles, out_of_pocket_max, limits, co_insurance, co_pays,
--   exclusions, coverage_types, notes
--
-- No foreign keys to existing tables — standalone reference table.
-- P22b gap analysis will query this table via GET /api/v1/insurance-policies.
--
-- Rollback: DROP TABLE insurance_policies;

CREATE TABLE IF NOT EXISTS insurance_policies (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_number   TEXT,
  provider        TEXT        NOT NULL,
  policy_type     TEXT        NOT NULL,
  effective_date  DATE,
  expiration_date DATE,
  insured_name    TEXT,
  coverage        JSONB       NOT NULL,
  raw_text        TEXT,
  source_file     TEXT,
  extracted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE insurance_policies
  ADD CONSTRAINT insurance_policies_policy_type_check
  CHECK (policy_type IN ('health', 'auto', 'home', 'umbrella'));

CREATE INDEX IF NOT EXISTS insurance_policies_policy_type_idx
  ON insurance_policies (policy_type);

CREATE INDEX IF NOT EXISTS insurance_policies_provider_idx
  ON insurance_policies (provider);

CREATE INDEX IF NOT EXISTS insurance_policies_effective_date_idx
  ON insurance_policies (effective_date);

CREATE UNIQUE INDEX IF NOT EXISTS insurance_policies_source_file_idx
  ON insurance_policies (source_file)
  WHERE source_file IS NOT NULL;
