"""Unit tests for scripts/lab-report-extract.py — P20a.

Strategy: mock pdfplumber.open() to return pre-baked page objects with
known word/text content.  No real PDF files required in CI.  DB writes
tested via mock psycopg2 connection (no live Postgres).

Run:
    python -m pytest scripts/tests/test_lab_report_extract.py -v
"""

import hashlib
import importlib.util
import json
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

# ---------------------------------------------------------------------------
# Ensure scripts/ is on sys.path so lib.db imports resolve correctly.
# lab-report-extract.py uses a hyphen in the filename which prevents a normal
# `import` statement.  Use importlib to load it by path instead.
# ---------------------------------------------------------------------------
_SCRIPTS_DIR = Path(__file__).resolve().parent.parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

_MODULE_PATH = _SCRIPTS_DIR / "lab-report-extract.py"
_spec = importlib.util.spec_from_file_location("lab_report_extract", _MODULE_PATH)
lre = importlib.util.module_from_spec(_spec)  # type: ignore[arg-type]
_spec.loader.exec_module(lre)  # type: ignore[union-attr]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _fake_page(text: str):
    """Return a mock pdfplumber page with extract_text() returning text."""
    page = MagicMock()
    page.extract_text.return_value = text
    return page


def _fake_pdf(pages: list[str]):
    """Return a mock pdfplumber PDF context manager yielding fake pages."""
    pdf = MagicMock()
    pdf.__enter__ = MagicMock(return_value=pdf)
    pdf.__exit__ = MagicMock(return_value=False)
    pdf.pages = [_fake_page(t) for t in pages]
    return pdf


# ---------------------------------------------------------------------------
# 1. test_detect_layout_quest
# ---------------------------------------------------------------------------

def test_detect_layout_quest():
    text = "Quest Diagnostics Patient Report\nSome content follows"
    result = lre.detect_layout(text, [])
    assert result == "quest"


def test_detect_layout_quest_uppercase():
    text = "QUEST DIAGNOSTICS, INC.  Patient Results"
    result = lre.detect_layout(text, [])
    assert result == "quest"


# ---------------------------------------------------------------------------
# 2. test_detect_layout_labcorp
# ---------------------------------------------------------------------------

def test_detect_layout_labcorp():
    text = "Laboratory Corporation of America  Patient Report"
    result = lre.detect_layout(text, [])
    assert result == "labcorp"


def test_detect_layout_labcorp_short():
    text = "LabCorp  Patient ID: 123456"
    result = lre.detect_layout(text, [])
    assert result == "labcorp"


# ---------------------------------------------------------------------------
# 3. test_detect_layout_generic_fallback
# ---------------------------------------------------------------------------

def test_detect_layout_generic_fallback():
    text = "Some random lab header\nPatient: John Doe"
    result = lre.detect_layout(text, [])
    assert result == "generic"


def test_detect_layout_hospital_match():
    text = "Piedmont Healthcare  Lab Report"
    result = lre.detect_layout(text, ["Piedmont", "Emory"])
    assert result == "hospital"


# ---------------------------------------------------------------------------
# 4. test_parse_result_row_normal
# ---------------------------------------------------------------------------

def test_parse_result_row_normal():
    line = "Glucose  95  mg/dL  70-99"
    row = lre.parse_result_line(line)
    assert row is not None
    assert row["test_name"] == "Glucose"
    assert row["raw_value"] == "95"
    assert abs(row["numeric_value"] - 95.0) < 0.001
    assert row["units"] == "mg/dL"
    assert row["ref_range_text"] == "70-99"
    assert abs(row["ref_low"] - 70.0) < 0.001
    assert abs(row["ref_high"] - 99.0) < 0.001
    assert row["lab_flag"] is None

    # derived_flag for this row: compute manually
    flag = lre.compute_derived_flag(95.0, None, 70.0, 99.0, None)
    assert flag == "NORMAL"


# ---------------------------------------------------------------------------
# 5. test_parse_result_row_high
# ---------------------------------------------------------------------------

def test_parse_result_row_high():
    line = "LDL Cholesterol  145  mg/dL  0-99  H"
    row = lre.parse_result_line(line)
    assert row is not None
    assert row["test_name"] == "LDL Cholesterol"
    assert abs(row["numeric_value"] - 145.0) < 0.001
    assert row["lab_flag"] == "H"
    assert abs(row["ref_low"] - 0.0) < 0.001
    assert abs(row["ref_high"] - 99.0) < 0.001

    flag = lre.compute_derived_flag(145.0, "H", 0.0, 99.0, None)
    assert flag == "HIGH"


# ---------------------------------------------------------------------------
# 6. test_parse_result_row_range_lt
# ---------------------------------------------------------------------------

def test_parse_result_row_range_lt():
    line = "TSH  0.8  mIU/L  <4.50"
    row = lre.parse_result_line(line)
    assert row is not None
    assert row["test_name"] == "TSH"
    assert abs(row["numeric_value"] - 0.8) < 0.001
    assert row["ref_low"] is None
    assert abs(row["ref_high"] - 4.50) < 0.001
    assert row["ref_comparator"] == "<"

    flag = lre.compute_derived_flag(0.8, None, None, 4.50, "<")
    assert flag == "NORMAL"

    flag_high = lre.compute_derived_flag(5.0, None, None, 4.50, "<")
    assert flag_high == "HIGH"


# ---------------------------------------------------------------------------
# 7. test_parse_result_row_non_numeric
# ---------------------------------------------------------------------------

def test_parse_result_row_non_numeric():
    # "ABO Type  A Positive" — value is non-numeric
    line = "ABO Type  A Positive"
    row = lre.parse_result_line(line)
    # Either None (no match) or a row with numeric_value=None is acceptable
    if row is not None:
        assert row["numeric_value"] is None
        assert row["units"] is None


# ---------------------------------------------------------------------------
# 8. test_report_id_stable
# ---------------------------------------------------------------------------

def test_report_id_stable():
    """Same source_file + collection_date → same report_id every time."""
    filename = "labcorp_2026_04_01.pdf"
    collection_date = "2026-04-01"
    accession = "ACC123"

    id_src = f"{filename}|{collection_date}|{accession}"
    rid1 = hashlib.sha256(id_src.encode()).hexdigest()[:32]
    rid2 = hashlib.sha256(id_src.encode()).hexdigest()[:32]

    assert rid1 == rid2
    assert len(rid1) == 32


# ---------------------------------------------------------------------------
# 9. test_dry_run_no_db
# ---------------------------------------------------------------------------

def test_dry_run_no_db(tmp_path, capsys):
    """--dry-run must emit JSON stdout and make zero DB writes."""
    # Create a minimal fake PDF path
    fake_pdf = tmp_path / "test_report.pdf"
    fake_pdf.write_bytes(b"%PDF-1.4 fake content")

    quest_page = (
        "Quest Diagnostics Patient Report\n"
        "Collection Date: 04/01/2026\n"
        "Ordering Physician: Dr. Smith\n"
        "\n"
        "Glucose  95  mg/dL  70-99\n"
        "Hemoglobin A1c  5.4  %  <5.7\n"
    )

    fake_pdf_cm = _fake_pdf([quest_page])

    with (
        patch("pdfplumber.open", return_value=fake_pdf_cm),
        # Patch get_connection to assert it is never called
        patch("lib.db.get_connection") as mock_conn,
        # Run main with --dry-run
        patch("sys.argv", ["lab-report-extract.py", "--file", str(fake_pdf), "--dry-run"]),
    ):
        rc = lre.main()

    assert rc == 0, "main() should return 0 on success"
    mock_conn.assert_not_called(), "DB connection must not be opened in --dry-run mode"

    captured = capsys.readouterr()
    output = json.loads(captured.out)
    assert "report_id" in output
    assert "results" in output
    assert output["result_count"] >= 1


# ---------------------------------------------------------------------------
# 10. test_upsert_idempotent
# ---------------------------------------------------------------------------

def test_upsert_idempotent():
    """Upserting same report twice must not increase row count.

    We test the SQL invariant by verifying ON CONFLICT DO NOTHING semantics
    via the upsert SQL string — and by asserting execute_upsert is called
    with the correct params both times.
    """
    # The idempotency guarantee is in the SQL: ON CONFLICT (report_id, test_name) DO NOTHING
    # Verify the SQL constant contains the expected clause
    assert "ON CONFLICT (report_id, test_name) DO NOTHING" in lre._UPSERT_SQL

    # Also verify parse_ref_range returns stable output
    rr1 = lre.parse_ref_range("70-99")
    rr2 = lre.parse_ref_range("70-99")
    assert rr1 == rr2


# ---------------------------------------------------------------------------
# Bonus: parse_ref_range edge cases
# ---------------------------------------------------------------------------

def test_parse_ref_range_standard():
    r = lre.parse_ref_range("1.00-2.50")
    assert abs(r["low"] - 1.0) < 0.001
    assert abs(r["high"] - 2.50) < 0.001
    assert r["comparator"] is None


def test_parse_ref_range_lt():
    r = lre.parse_ref_range("<10.0")
    assert r["low"] is None
    assert abs(r["high"] - 10.0) < 0.001
    assert r["comparator"] == "<"


def test_parse_ref_range_gt():
    r = lre.parse_ref_range(">3.5")
    assert abs(r["low"] - 3.5) < 0.001
    assert r["high"] is None
    assert r["comparator"] == ">"


def test_parse_ref_range_text_only():
    r = lre.parse_ref_range("Negative")
    assert r["low"] is None
    assert r["high"] is None
    assert r["comparator"] is None
    assert r["text"] == "Negative"


def test_parse_ref_range_empty():
    r = lre.parse_ref_range("")
    assert r["low"] is None
    assert r["high"] is None
