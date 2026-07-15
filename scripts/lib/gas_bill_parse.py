"""Gas South bill usage parser — pure text -> usage numbers, no PDF library.

Extracted from utility-pipeline.py's ``_parse_gas_bill_pdf`` (#275) so the
parsing logic is unit-testable with zero third-party dependencies. The caller
owns PDF text extraction (PyMuPDF); this module owns the text -> numbers step.

Why the original label-based regexes could never work
-----------------------------------------------------
The bill's "How We Calculated Your Gas Charges" section is a TABLE. PyMuPDF's
``get_text()`` emits it as a flat sequence of standalone lines — every column
header first, then every value — so a label is NEVER adjacent to its number::

    CCFs          <- header
    Used
    Therm
    Factor
    Therms
    Used
    ...
    06/01/2026    <- values start here
    06/30/2026
    29
    43
    63
    =
    20            <- CCFs Used
    X
    1.033         <- Therm Factor
    =
    20.66         <- Therms Used
    X
    0.65          <- Rate per Therm
    =
    13.43         <- Gas Charges

Patterns like ``(\\d+)\\s*CCFs?`` assume "20 CCFs" adjacency — true of the web
portal's rendering, false of the extracted PDF text. They matched nothing, and
because the miss degraded to a WARNING the bill amount still stored fine with
usage silently NULL.

What we anchor on instead
-------------------------
The value row carries its own arithmetic, which is far more stable than any
label text::

    Ending - Beginning = CCFs x ThermFactor = Therms x Rate = GasCharges
              63 - 43  =  20  x   1.033     = 20.66  x 0.65 =   13.43

We match that ``= N X N = N X N = N`` shape and then re-check the arithmetic,
so a column-order change breaks loudly instead of silently yielding wrong
numbers. Verified against 4 real bills (2026-04 .. 2026-07); all arithmetic
self-checks passed.
"""

from __future__ import annotations

import logging
import re
from typing import Any

log = logging.getLogger(__name__)

# Relative tolerance for the self-check. The bill rounds each column to 2dp, so
# recomputing from rounded inputs drifts slightly; 1% absorbs rounding without
# tolerating a genuine column mix-up.
_ARITHMETIC_TOLERANCE = 0.01

_NUM = r"[\d,]+(?:\.\d+)?"

# The usage row's arithmetic: "= <ccfs> X <factor> = <therms> X <rate> = <charges>".
# Values arrive newline-separated (see module docstring), so \s* spans lines.
_USAGE_ROW_RE = re.compile(
    rf"=\s*(?P<ccfs>{_NUM})"
    rf"\s*[Xx]\s*(?P<factor>{_NUM})"
    rf"\s*=\s*(?P<therms>{_NUM})"
    rf"\s*[Xx]\s*(?P<rate>{_NUM})"
    rf"\s*=\s*(?P<charges>{_NUM})"
)

EMPTY_RESULT: dict[str, Any] = {
    "ccfs": None,
    "therm_factor": None,
    "therms": None,
    "rate_per_therm": None,
}


def _to_float(raw: str) -> float:
    """Parse a bill number, tolerating thousands separators ("1,043" -> 1043.0)."""
    return float(raw.replace(",", ""))


def _close(actual: float, expected: float) -> bool:
    """Relative comparison that stays sane when expected is 0."""
    if expected == 0:
        return abs(actual) < 0.01
    return abs(actual - expected) / abs(expected) <= _ARITHMETIC_TOLERANCE


def parse_usage_rows(text: str) -> list[dict[str, float]]:
    """Return every usage row found, each self-checked against its own arithmetic.

    A bill normally has exactly one row, but can carry more than one when the
    rate changes mid-cycle. Rows whose arithmetic does not reconcile are dropped
    and logged — a mismatch means the column mapping is wrong, and wrong usage
    numbers are worse than none.
    """
    rows: list[dict[str, float]] = []

    for match in _USAGE_ROW_RE.finditer(text):
        row = {name: _to_float(value) for name, value in match.groupdict().items()}

        if not _close(row["ccfs"] * row["factor"], row["therms"]):
            log.warning(
                "Gas bill usage row rejected — ccfs x factor != therms "
                f"({row['ccfs']} x {row['factor']} != {row['therms']}). "
                "Bill layout may have changed."
            )
            continue
        if not _close(row["therms"] * row["rate"], row["charges"]):
            log.warning(
                "Gas bill usage row rejected — therms x rate != charges "
                f"({row['therms']} x {row['rate']} != {row['charges']}). "
                "Bill layout may have changed."
            )
            continue

        rows.append(row)

    return rows


def parse_gas_bill_text(text: str) -> dict[str, Any]:
    """Extract ``ccfs`` / ``therm_factor`` / ``therms`` / ``rate_per_therm`` from bill text.

    Values are None when no usable row is found, which the caller must treat as a
    failure rather than a zero — see utility-pipeline's cmd_gas.

    Multi-row bills are summed. Factor and rate are then reported as the
    *effective* values implied by the totals (therms/ccfs and charges/therms)
    rather than an arbitrary row's, so they stay consistent with the summed usage.
    """
    rows = parse_usage_rows(text)
    if not rows:
        return dict(EMPTY_RESULT)

    total_ccfs = sum(r["ccfs"] for r in rows)
    total_therms = sum(r["therms"] for r in rows)
    total_charges = sum(r["charges"] for r in rows)

    if len(rows) == 1:
        factor: float | None = rows[0]["factor"]
        rate: float | None = rows[0]["rate"]
    else:
        log.info(
            f"Gas bill has {len(rows)} usage rows — summing usage, deriving effective factor/rate"
        )
        factor = round(total_therms / total_ccfs, 4) if total_ccfs else None
        rate = round(total_charges / total_therms, 4) if total_therms else None

    return {
        "ccfs": total_ccfs,
        "therm_factor": factor,
        "therms": round(total_therms, 2),
        "rate_per_therm": rate,
    }
