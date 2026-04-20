#!/usr/bin/env python3
"""
Lab Report Extractor for Open Brain — P20a.

T0 (pure Python) PDF → structured lab_results rows in Postgres.
No LLM calls.  P20b handles synthesis → capture POST.

Usage:
    python scripts/lab-report-extract.py --file <path.pdf>          # extract + upsert
    python scripts/lab-report-extract.py --file <path.pdf> --dry-run # JSON stdout, no DB write
    python scripts/lab-report-extract.py --list                      # show all stored reports
    python scripts/lab-report-extract.py --status                    # DB row counts + last run
"""

import argparse
import hashlib
import json
import logging
import os
import re
import sys
from datetime import date, datetime
from pathlib import Path
from typing import Any, Optional

import yaml

# ---------------------------------------------------------------------------
# Path wiring — works both locally (scripts/ in sys.path[0]) and inside
# Docker sidecar (/app/lib/ after COPY).
# ---------------------------------------------------------------------------
_SCRIPT_DIR = Path(__file__).resolve().parent
_REPO_ROOT = _SCRIPT_DIR.parent
sys.path.insert(0, str(_SCRIPT_DIR))

from lib.db import execute_upsert, get_connection  # noqa: E402

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
sys.stdout.reconfigure(line_buffering=True)
sys.stderr.reconfigure(line_buffering=True)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("lab-report-extract")

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
_DEFAULT_CONFIG_PATH = _REPO_ROOT / "config" / "lab-report.yaml"


def load_config(config_path: Optional[Path] = None) -> dict:
    path = config_path or _DEFAULT_CONFIG_PATH
    if path.exists():
        with path.open() as f:
            return yaml.safe_load(f) or {}
    log.warning("Config not found at %s — using defaults", path)
    return {}


# ---------------------------------------------------------------------------
# Layout detection
# ---------------------------------------------------------------------------

def detect_layout(first_page_text: str, hospital_names: list[str]) -> str:
    """Classify PDF layout from the first 200 characters of page 1.

    Order: Quest → LabCorp → hospital → generic
    """
    header = first_page_text[:200].lower()
    if "quest diagnostics" in header or re.search(r"\bquest\b", header):
        return "quest"
    if "laboratory corporation" in header or "labcorp" in header:
        return "labcorp"
    for name in hospital_names:
        if name.lower() in header:
            return "hospital"
    return "generic"


# ---------------------------------------------------------------------------
# Metadata extraction
# ---------------------------------------------------------------------------

# Collection date: look for common label patterns in the full page text.
_DATE_LABELS = re.compile(
    r"(?:collection\s+date|collected|specimen\s+date|date\s+collected|"
    r"date\s+of\s+service|report\s+date)[:\s]+([0-9]{1,2}[/\-\.][0-9]{1,2}[/\-\.][0-9]{2,4}"
    r"|[A-Za-z]+\s+\d{1,2},\s+\d{4})",
    re.IGNORECASE,
)

# Ordering provider
_PROVIDER_LABELS = re.compile(
    r"(?:ordering\s+physician|ordering\s+provider|referred\s+by|physician)[:\s]+([A-Za-z ,\.]+)",
    re.IGNORECASE,
)

# Accession number
_ACCESSION_LABELS = re.compile(
    r"(?:accession\s+(?:number|#|no\.?)|specimen\s+id|requisition)[:\s]+([A-Z0-9\-]+)",
    re.IGNORECASE,
)


def parse_date(raw: str, date_formats: list[str]) -> Optional[date]:
    """Try each format in order; return first parse that succeeds."""
    raw = raw.strip()
    for fmt in date_formats:
        try:
            return datetime.strptime(raw, fmt).date()
        except ValueError:
            continue
    return None


def extract_metadata(full_text: str, date_formats: list[str]) -> dict:
    """Extract report-level metadata from raw page text."""
    meta: dict[str, Any] = {
        "collection_date": None,
        "ordering_provider": None,
        "lab_accession": None,
    }

    m = _DATE_LABELS.search(full_text)
    if m:
        parsed = parse_date(m.group(1), date_formats)
        meta["collection_date"] = parsed

    m = _PROVIDER_LABELS.search(full_text)
    if m:
        meta["ordering_provider"] = m.group(1).strip()[:120]

    m = _ACCESSION_LABELS.search(full_text)
    if m:
        meta["lab_accession"] = m.group(1).strip()[:60]

    return meta


# ---------------------------------------------------------------------------
# Reference range parsing
# ---------------------------------------------------------------------------

def parse_ref_range(raw: str) -> dict:
    """Normalise a reference range string.

    Handles:
      "1.00-2.50"   → {low: 1.0, high: 2.5, comparator: None, text: raw}
      "<10.0"       → {low: None, high: 10.0, comparator: '<', text: raw}
      ">3.5"        → {low: 3.5, high: None, comparator: '>', text: raw}
      "Negative"    → {low: None, high: None, comparator: None, text: raw}
    """
    result = {"low": None, "high": None, "comparator": None, "text": raw}
    if not raw or not raw.strip():
        return result

    s = raw.strip()

    # Range: "1.00 - 2.50" or "1.00-2.50"
    m = re.match(r"^([\d\.]+)\s*[-–]\s*([\d\.]+)$", s)
    if m:
        try:
            result["low"] = float(m.group(1))
            result["high"] = float(m.group(2))
        except ValueError:
            pass
        return result

    # Less-than: "<10.0" or "< 10"
    m = re.match(r"^<\s*([\d\.]+)$", s)
    if m:
        try:
            result["high"] = float(m.group(1))
            result["comparator"] = "<"
        except ValueError:
            pass
        return result

    # Greater-than: ">3.5" or "> 3.5"
    m = re.match(r"^>\s*([\d\.]+)$", s)
    if m:
        try:
            result["low"] = float(m.group(1))
            result["comparator"] = ">"
        except ValueError:
            pass
        return result

    # Anything else (e.g. "Negative", "Reactive", "See note") — text only
    return result


# ---------------------------------------------------------------------------
# Derived flag computation
# ---------------------------------------------------------------------------

def compute_derived_flag(
    numeric_value: Optional[float],
    lab_flag: Optional[str],
    ref_low: Optional[float],
    ref_high: Optional[float],
    ref_comparator: Optional[str],
    custom_threshold: Optional[dict] = None,
) -> Optional[str]:
    """Compute derived_flag from numeric_value vs reference bounds.

    Returns 'HIGH' | 'LOW' | 'ABNORMAL' | 'NORMAL' | None.
    'ABNORMAL' is used when lab_flag is present but derivation is ambiguous.
    None is returned when there is insufficient data to compute.
    """
    # No numeric value → can't compute
    if numeric_value is None:
        if lab_flag in ("A", "C"):
            return "ABNORMAL"
        return None

    # Apply custom threshold overrides (physician-specific targets)
    effective_low = ref_low
    effective_high = ref_high
    if custom_threshold:
        if "low" in custom_threshold:
            effective_low = float(custom_threshold["low"])
        if "high" in custom_threshold:
            effective_high = float(custom_threshold["high"])

    # Evaluate bounds
    if ref_comparator == "<":
        # Value should be < high bound
        if effective_high is not None:
            if numeric_value >= effective_high:
                return "HIGH"
            return "NORMAL"
    elif ref_comparator == ">":
        # Value should be > low bound
        if effective_low is not None:
            if numeric_value <= effective_low:
                return "LOW"
            return "NORMAL"
    elif effective_low is not None or effective_high is not None:
        if effective_high is not None and numeric_value > effective_high:
            return "HIGH"
        if effective_low is not None and numeric_value < effective_low:
            return "LOW"
        if effective_low is not None or effective_high is not None:
            return "NORMAL"

    # No bounds available — fall back to lab_flag
    if lab_flag == "H":
        return "HIGH"
    if lab_flag == "L":
        return "LOW"
    if lab_flag in ("A", "C"):
        return "ABNORMAL"

    return None


# ---------------------------------------------------------------------------
# Row parsing
# ---------------------------------------------------------------------------

# Patterns to extract: test_name, value, units, ref_range, flag from a line.
# Quest / LabCorp use tab or multi-space separated columns.
# Handles both "Glucose  95  mg/dL  70-99  " and "Glucose  95 mg/dL  70-99 H"
_RESULT_ROW = re.compile(
    r"^(?P<name>[A-Za-z][A-Za-z0-9 ,\(\)\-/\.%]+?)"  # test name
    r"\s{2,}"                                           # 2+ spaces as column separator
    r"(?P<value>[<>]?[\d\.]+|[A-Za-z][A-Za-z0-9 \+\-]*)"  # value
    r"(?:\s+(?P<units>[a-zA-Z/%µ][a-zA-Z0-9/%µ\.\-\*^²³]*))?"  # optional units
    r"(?:\s+(?P<ref>[0-9<>\-\.\s]+|[A-Za-z][A-Za-z ]+))?"      # optional ref range
    r"(?:\s+(?P<flag>[HLAC]))?$",                               # optional flag
    re.IGNORECASE,
)

# Test code: some labs prepend a LOINC-style code "12345-6  Test Name  ..."
_CODE_PREFIX = re.compile(r"^(\d{4,6}-\d)\s+(.+)$")


def _try_float(s: Optional[str]) -> Optional[float]:
    if s is None:
        return None
    s = s.strip()
    try:
        return float(s)
    except (ValueError, TypeError):
        return None


def parse_result_line(line: str) -> Optional[dict]:
    """Attempt to parse a single text line as a lab result row.

    Returns a dict with keys: test_name, test_code, raw_value, numeric_value,
    units, ref_range_text, lab_flag, plus parsed ref range fields.
    Returns None if the line doesn't look like a result row.
    """
    line = line.strip()
    if not line or len(line) < 5:
        return None

    # Strip LOINC-style code prefix
    test_code = None
    m_code = _CODE_PREFIX.match(line)
    if m_code:
        test_code = m_code.group(1)
        line = m_code.group(2)

    m = _RESULT_ROW.match(line)
    if not m:
        return None

    test_name = m.group("name").strip()
    raw_value = (m.group("value") or "").strip()
    units = (m.group("units") or "").strip() or None
    ref_str = (m.group("ref") or "").strip() or None
    lab_flag = (m.group("flag") or "").strip().upper() or None

    if not test_name or not raw_value:
        return None

    numeric_value = _try_float(raw_value)
    ref_parsed = parse_ref_range(ref_str or "")

    return {
        "test_name": test_name,
        "test_code": test_code,
        "raw_value": raw_value,
        "numeric_value": numeric_value,
        "units": units,
        "ref_range_text": ref_str,
        "ref_low": ref_parsed["low"],
        "ref_high": ref_parsed["high"],
        "ref_comparator": ref_parsed["comparator"],
        "lab_flag": lab_flag,
    }


# ---------------------------------------------------------------------------
# PDF extraction
# ---------------------------------------------------------------------------

def extract_pdf(pdf_path: Path, cfg: dict) -> dict:
    """Extract all lab result rows from a PDF file.

    Streams pages one at a time (AC-6 memory constraint).

    Returns:
        {
          "source_file": str,
          "layout": str,
          "report_id": str,
          "collection_date": str | None,
          "ordering_provider": str | None,
          "lab_accession": str | None,
          "results": [{ test_name, raw_value, numeric_value, ... }, ...]
        }
    """
    try:
        import pdfplumber
    except ImportError:
        raise RuntimeError(
            "pdfplumber is not installed. "
            "Run: pip install -r scripts/requirements-lab.txt"
        )

    hospital_names = cfg.get("hospital_names", [])
    date_formats = cfg.get("date_formats", ["%m/%d/%Y", "%m/%d/%y", "%Y-%m-%d"])
    custom_thresholds = cfg.get("custom_thresholds") or {}

    results: list[dict] = []
    full_text_pages: list[str] = []
    layout: Optional[str] = None

    with pdfplumber.open(str(pdf_path)) as pdf:
        for page_num, page in enumerate(pdf.pages):
            # Stream page text — never hold all pages simultaneously
            page_text = page.extract_text() or ""
            full_text_pages.append(page_text)

            if page_num == 0:
                layout = detect_layout(page_text, hospital_names)

            # Parse each line of this page
            for line in page_text.splitlines():
                row = parse_result_line(line)
                if row:
                    results.append(row)

    # Combine page texts for metadata extraction only (then release)
    full_text = "\n".join(full_text_pages)
    del full_text_pages  # release

    meta = extract_metadata(full_text, date_formats)
    del full_text  # release

    collection_date = meta["collection_date"]
    lab_accession = meta["lab_accession"]

    # Stable report_id: hash of (basename + collection_date string)
    # This is deterministic: re-extracting the same file → same report_id.
    id_src = f"{pdf_path.name}|{collection_date!s}|{lab_accession or ''}"
    report_id = hashlib.sha256(id_src.encode()).hexdigest()[:32]

    collection_date_str = collection_date.isoformat() if collection_date else None

    # Compute derived flags and apply custom thresholds
    for row in results:
        threshold = None
        for key, val in custom_thresholds.items():
            if key.lower() == row["test_name"].lower():
                threshold = val
                break
        row["derived_flag"] = compute_derived_flag(
            row["numeric_value"],
            row["lab_flag"],
            row["ref_low"],
            row["ref_high"],
            row["ref_comparator"],
            threshold,
        )

    return {
        "source_file": pdf_path.name,
        "layout": layout or "generic",
        "report_id": report_id,
        "collection_date": collection_date_str,
        "ordering_provider": meta["ordering_provider"],
        "lab_accession": lab_accession,
        "results": results,
    }


# ---------------------------------------------------------------------------
# DB upsert
# ---------------------------------------------------------------------------

_UPSERT_SQL = """
INSERT INTO lab_results (
  report_id, source_file, layout, collection_date, ordering_provider,
  test_name, test_code, raw_value, numeric_value, units,
  ref_range_text, ref_low, ref_high, ref_comparator,
  lab_flag, derived_flag
) VALUES (
  %s, %s, %s, %s, %s,
  %s, %s, %s, %s, %s,
  %s, %s, %s, %s,
  %s, %s
)
ON CONFLICT (report_id, test_name) DO NOTHING
"""


def upsert_results(extracted: dict) -> int:
    """Write extracted results to the lab_results table.

    Returns count of rows passed to upsert (actual inserts may be fewer
    due to ON CONFLICT DO NOTHING idempotency).
    """
    rows = []
    for r in extracted["results"]:
        rows.append((
            extracted["report_id"],
            extracted["source_file"],
            extracted["layout"],
            extracted["collection_date"],
            extracted["ordering_provider"],
            r["test_name"],
            r.get("test_code"),
            r["raw_value"],
            r.get("numeric_value"),
            r.get("units"),
            r.get("ref_range_text"),
            r.get("ref_low"),
            r.get("ref_high"),
            r.get("ref_comparator"),
            r.get("lab_flag"),
            r.get("derived_flag"),
        ))

    if not rows:
        log.warning("No result rows extracted — nothing to upsert")
        return 0

    conn = get_connection()
    try:
        count = execute_upsert(conn, _UPSERT_SQL, rows)
        log.info("Upserted %d rows for report %s", count, extracted["report_id"])
        return count
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# --list / --status commands
# ---------------------------------------------------------------------------

def cmd_list() -> None:
    """Print all distinct reports stored in lab_results."""
    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT report_id, source_file, layout, collection_date,
                       COUNT(*) AS result_count
                FROM lab_results
                GROUP BY report_id, source_file, layout, collection_date
                ORDER BY collection_date DESC NULLS LAST
                """
            )
            rows = cur.fetchall()
    finally:
        conn.close()

    if not rows:
        print("No lab reports stored.")
        return

    print(f"{'Date':<12}  {'Layout':<10}  {'Tests':>6}  {'File'}")
    print("-" * 70)
    for report_id, source_file, layout, coll_date, count in rows:
        date_str = str(coll_date) if coll_date else "unknown"
        print(f"{date_str:<12}  {layout:<10}  {count:>6}  {source_file}")


def cmd_status() -> None:
    """Print DB row counts and last extraction timestamp."""
    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM lab_results")
            (total_rows,) = cur.fetchone()

            cur.execute("SELECT MAX(extracted_at) FROM lab_results")
            (last_run,) = cur.fetchone()

            cur.execute("SELECT COUNT(DISTINCT report_id) FROM lab_results")
            (report_count,) = cur.fetchone()
    finally:
        conn.close()

    print(f"lab_results table:")
    print(f"  Reports:    {report_count}")
    print(f"  Total rows: {total_rows}")
    print(f"  Last run:   {last_run or 'never'}")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Extract structured lab results from PDF reports into Postgres."
    )
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--file", metavar="PATH", help="Path to lab report PDF")
    group.add_argument("--list", action="store_true", help="Show all stored reports")
    group.add_argument("--status", action="store_true", help="DB row counts + last run")

    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print JSON extraction result to stdout; make no DB writes",
    )
    parser.add_argument(
        "--config",
        metavar="PATH",
        help="Override config file path (default: config/lab-report.yaml)",
    )
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    config_path = Path(args.config) if args.config else None
    cfg = load_config(config_path)

    if args.list:
        cmd_list()
        return 0

    if args.status:
        cmd_status()
        return 0

    # --file
    pdf_path = Path(args.file)
    if not pdf_path.exists():
        log.error("File not found: %s", pdf_path)
        return 1

    log.info("Extracting %s", pdf_path.name)
    extracted = extract_pdf(pdf_path, cfg)

    result_count = len(extracted["results"])
    log.info(
        "Detected layout=%s, collection_date=%s, %d result rows",
        extracted["layout"],
        extracted["collection_date"],
        result_count,
    )

    if args.dry_run:
        # Emit JSON to stdout — P20b reads this for orchestration
        out = {
            "report_id": extracted["report_id"],
            "source_file": extracted["source_file"],
            "layout": extracted["layout"],
            "collection_date": extracted["collection_date"],
            "ordering_provider": extracted["ordering_provider"],
            "result_count": result_count,
            "results": extracted["results"],
        }
        print(json.dumps(out, indent=2, default=str))
        return 0

    count = upsert_results(extracted)
    log.info("Done. %d rows processed.", count)
    return 0


if __name__ == "__main__":
    sys.exit(main())
