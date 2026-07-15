"""Unit tests for ``scripts/lib/gas_bill_parse.py``.

These defend **#275** — gas bills stored a dollar amount but NULL therms for the
entire life of the gas path.

Two failures stacked:

* The parser's regexes (``(\\d+)\\s*CCFs?``, first-match ``(\\d+\\.?\\d*)\\s*therms?``)
  assumed the label sits next to its number, which is how the **web portal**
  renders the bill — but PyMuPDF extracts the PDF's usage TABLE as a flat run of
  standalone lines, headers first, values after. The labels are never adjacent to
  the numbers, so all four regexes matched nothing on every real bill.
* The miss degraded to a WARNING, so the run still exited 0 with ``status: ok``
  while silently storing NULL usage. Nobody could see it, and the gas path was
  unreachable behind three upstream blockers anyway (LAB_NOTEBOOK 190-199), so
  the parser was never once executed against a real bill before shipping.

``TABLE_TEXT`` below reproduces the real extracted layout (values from the
2026-07-06 bill, verified against the live portal). ``test_rejects_portal_style_text``
pins the specific wrong assumption so it cannot come back.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

# scripts/lib is not packaged; make `import lib.gas_bill_parse` resolve from the
# repo root regardless of pytest's cwd (mirrors conftest's trigger_server hack).
_SCRIPTS_DIR = Path(__file__).resolve().parents[3] / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from lib.gas_bill_parse import parse_gas_bill_text, parse_usage_rows  # noqa: E402

# Exactly how PyMuPDF emits the "How We Calculated Your Gas Charges" table:
# every column header first, then the value row. 63 - 43 = 20 x 1.033 = 20.66
# x 0.65 = 13.43 — the real 2026-07-06 bill.
TABLE_TEXT = """How We Calculated Your Gas Charges
Meter Start
Meter End
Days of
Service
Beginning
Read
Ending
Read
CCFs
Used
Therm
Factor
Therms
Used
Rate per
Therm
Gas
Charges
06/01/2026
06/30/2026
29
43
63
=
20
X
1.033
=
20.66
X
0.65
=
13.43
"""


def test_parses_real_bill_layout():
    """The canonical case: the layout that made every old regex return None."""
    result = parse_gas_bill_text(TABLE_TEXT)

    assert result["ccfs"] == 20.0
    assert result["therm_factor"] == 1.033
    assert result["therms"] == 20.66
    assert result["rate_per_therm"] == 0.65


def test_rejects_portal_style_text():
    """Label-adjacent text is the PORTAL's rendering, not the PDF's.

    The old regexes were written against this shape. Asserting we find nothing
    here documents that adjacency is not what the PDF gives us — if a future
    change "fixes" the parser by matching this, it has regressed to #275.
    """
    portal_text = "Usage: 20 CCFs at therm factor 1.033 = 20.66 therms @ $0.65/therm"

    assert parse_gas_bill_text(portal_text) == {
        "ccfs": None,
        "therm_factor": None,
        "therms": None,
        "rate_per_therm": None,
    }


def test_missing_usage_returns_none_not_zero():
    """A bill with no usage row yields None. cmd_gas treats None as a failure;
    a 0.0 would silently look like 'used no gas' and store a real-looking row."""
    result = parse_gas_bill_text("Statement\nAmount Due\n73.03\nThank you\n")

    assert result == {
        "ccfs": None,
        "therm_factor": None,
        "therms": None,
        "rate_per_therm": None,
    }


@pytest.mark.parametrize(
    ("ccfs", "factor", "therms", "rate", "charges"),
    [
        (20, 1.033, 20.66, 0.65, 13.43),  # 2026-07-06
        (31, 1.023, 31.71, 0.65, 20.62),  # 2026-06-04
        (32, 1.031, 32.99, 0.65, 21.44),  # 2026-05-05
        (66, 1.034, 68.24, 0.65, 44.36),  # 2026-04-03
    ],
)
def test_all_four_real_bills(ccfs, factor, therms, rate, charges):
    """Every real bill available when #275 was fixed, verified live end-to-end."""
    text = f"=\n{ccfs}\nX\n{factor}\n=\n{therms}\nX\n{rate}\n=\n{charges}\n"
    result = parse_gas_bill_text(text)

    assert result["ccfs"] == float(ccfs)
    assert result["therms"] == therms
    assert result["therm_factor"] == factor
    assert result["rate_per_therm"] == rate


def test_rejects_row_whose_arithmetic_does_not_reconcile():
    """The self-check is the guard against a silent column remap.

    If Gas South reorders the table, the regex may still match but the numbers
    land in the wrong fields. Wrong usage is worse than none, so the row is
    dropped rather than stored.
    """
    # 20 x 1.033 = 20.66, not 99.99 — therms cannot belong to this row.
    bogus = "=\n20\nX\n1.033\n=\n99.99\nX\n0.65\n=\n64.99\n"

    assert parse_usage_rows(bogus) == []
    assert parse_gas_bill_text(bogus)["therms"] is None


def test_multi_row_bill_sums_usage_and_derives_effective_rate():
    """A mid-cycle rate change splits the bill into two rows; usage is the total."""
    two_rows = (
        "=\n10\nX\n1.0\n=\n10.0\nX\n0.50\n=\n5.0\n"  # 10 therms @ $0.50
        "=\n30\nX\n1.0\n=\n30.0\nX\n0.70\n=\n21.0\n"  # 30 therms @ $0.70
    )
    result = parse_gas_bill_text(two_rows)

    assert result["ccfs"] == 40.0
    assert result["therms"] == 40.0
    # Effective rate = total charges / total therms = 26.0 / 40.0 — not either
    # row's rate, and consistent with the summed usage.
    assert result["rate_per_therm"] == 0.65


def test_tolerates_thousands_separators():
    """Reads/CCFs cross 1,000 on a big month; "1,043" must not parse as 1.0."""
    text = "=\n1,000\nX\n1.0\n=\n1,000.0\nX\n0.65\n=\n650.0\n"
    result = parse_gas_bill_text(text)

    assert result["ccfs"] == 1000.0
    assert result["therms"] == 1000.0
