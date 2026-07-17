"""Parse electric-usage-downloader CSV exports into daily kWh + cost aggregates.

WHY this exists (mirrors lib/gas_bill_parse.py):
  The utility pipeline's power path (#286, Cobb EMC) ingests interval-usage CSVs
  produced by tedpearson/electric-usage-downloader (which reverse-engineers the
  NISC SmartHub API that Cobb EMC runs) OR a manual Green Button CSV export. Both
  emit the same interval schema. Turning those intervals into daily kWh/cost is
  pure, deterministic arithmetic — a **T0** step (no LLM) — so it lives here as a
  standalone, unit-testable module with ZERO third-party dependencies (stdlib
  `csv` + `zoneinfo`). The caller (utility-pipeline.py `cmd_power_summary`) owns
  file discovery and the SQLite upsert; this module owns CSV text -> daily numbers.

CSV contract (electric-usage-downloader / SmartHub interval export):
    StartUnixMillis, EndUnixMillis, WattHours, CostInCents, MeterName
  WattHours / 1000  -> kWh ;  CostInCents / 100 -> dollars.
  Intervals are 15-minute; a "day" is the LOCAL date (utility rates + the user's
  mental model are local), so timestamps are bucketed in `tz_name` (default ET).

Unlike gas_bill_parse (which arithmetic-anchors because the bill PDF is label-less),
the CSV has a header row, so column-keyed parsing via csv.DictReader is reliable.
The guard here is numeric validation + the **empty-result-is-failure** contract:
`parse_power_csv` returns `{}` when no usable row is found, and the caller MUST
treat that as an error (append to _JSON_ERRORS), never a silent clean run — the
#275 lesson (a parse miss must never degrade to a run that still reports status ok).
"""

from __future__ import annotations

import csv
import io
import logging
from datetime import UTC, datetime
from typing import Any
from zoneinfo import ZoneInfo

log = logging.getLogger("utility-pipeline.power_csv")

DEFAULT_TZ = "America/New_York"

# A usable row needs at minimum a start timestamp and an energy value.
_REQUIRED_COLS = ("StartUnixMillis", "WattHours")


def _to_float(raw: str | None) -> float | None:
    """Parse a CSV cell to float, tolerating thousands separators. None on failure."""
    if raw is None:
        return None
    s = raw.strip().replace(",", "")
    if not s:
        return None
    try:
        return float(s)
    except ValueError:
        return None


def parse_power_csv(text: str, tz_name: str = DEFAULT_TZ) -> dict[str, dict[str, float]]:
    """Aggregate one electric-usage-downloader CSV into per-local-date totals.

    Returns a dict keyed by ``'YYYY-MM-DD'`` (local date in ``tz_name``) whose
    values are ``{'kwh': float, 'cost_estimate': float, 'interval_count': float}``.
    Interval WattHours are summed per day (/1000 -> kWh); CostInCents summed
    (/100 -> dollars). Negative WattHours (net-metering export) are kept signed.

    Rows with an unparseable ``StartUnixMillis`` or ``WattHours`` are skipped and
    logged. Returns ``{}`` when the header lacks the required columns OR no usable
    row is found — the CALLER MUST treat an empty result as a failure.
    """
    try:
        tz = ZoneInfo(tz_name)
    except Exception:
        log.warning("power_csv: unknown timezone %r, falling back to UTC", tz_name)
        tz = UTC

    reader = csv.DictReader(io.StringIO(text))
    fields = reader.fieldnames
    if not fields or not all(col in fields for col in _REQUIRED_COLS):
        log.error("power_csv: missing required columns %s (got %s)", _REQUIRED_COLS, fields)
        return {}

    agg: dict[str, dict[str, float]] = {}
    total = 0
    skipped = 0
    for row in reader:
        total += 1
        start_ms = _to_float(row.get("StartUnixMillis"))
        wh = _to_float(row.get("WattHours"))
        if start_ms is None or wh is None:
            skipped += 1
            continue
        cents = _to_float(row.get("CostInCents")) or 0.0
        day = datetime.fromtimestamp(start_ms / 1000.0, tz).strftime("%Y-%m-%d")
        bucket = agg.setdefault(day, {"kwh": 0.0, "cost_estimate": 0.0, "interval_count": 0.0})
        bucket["kwh"] += wh / 1000.0
        bucket["cost_estimate"] += cents / 100.0
        bucket["interval_count"] += 1.0

    if skipped:
        log.warning("power_csv: skipped %d of %d unparseable rows", skipped, total)

    # Round to sensible precision so repeated upserts are stable.
    for bucket in agg.values():
        bucket["kwh"] = round(bucket["kwh"], 3)
        bucket["cost_estimate"] = round(bucket["cost_estimate"], 2)
    return agg


def merge_daily(
    into: dict[str, dict[str, float]], more: dict[str, dict[str, float]]
) -> dict[str, dict[str, float]]:
    """Merge a second per-date aggregate into the first (summing same-date days).

    Lets the caller fold many CSV files (the tool writes one per day, but a
    re-download can overlap) into a single per-date view before upserting.
    """
    for day, vals in more.items():
        bucket = into.setdefault(day, {"kwh": 0.0, "cost_estimate": 0.0, "interval_count": 0.0})
        bucket["kwh"] = round(bucket["kwh"] + vals.get("kwh", 0.0), 3)
        bucket["cost_estimate"] = round(bucket["cost_estimate"] + vals.get("cost_estimate", 0.0), 2)
        bucket["interval_count"] += vals.get("interval_count", 0.0)
    return into


# Canonical empty result — importable so callers/tests share the shape.
EMPTY_RESULT: dict[str, dict[str, Any]] = {}
