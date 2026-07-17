"""Unit tests for scripts/lib/power_csv_parse.py (#286 Cobb EMC power ingest).

Pure-stdlib parser → no third-party deps beyond pytest. Mirrors
test_gas_bill_parse.py's bootstrap (scripts/ is not a package, so we put it on
sys.path) and its plain-assert style.
"""

import sys
from datetime import UTC, datetime
from pathlib import Path

# scripts/lib is not a package — add scripts/ to sys.path (test is 3 levels deep).
_SCRIPTS_DIR = Path(__file__).resolve().parents[3] / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from lib.power_csv_parse import merge_daily, parse_power_csv  # noqa: E402

HEADER = "StartUnixMillis,EndUnixMillis,WattHours,CostInCents,MeterName"


def _ms(year, month, day, hour=12, minute=0, tz=UTC):
    """Unix millis for a given wall-clock time (default UTC) — computed, never hardcoded."""
    return int(datetime(year, month, day, hour, minute, tzinfo=tz).timestamp() * 1000)


def test_parses_basic_single_day():
    start = _ms(2026, 3, 10, 12, 0)
    end = start + 15 * 60 * 1000
    text = f"{HEADER}\n{start},{end},250,45,METER1\n{start},{end},750,105,METER1\n"
    result = parse_power_csv(text)
    # 250 + 750 = 1000 Wh = 1.0 kWh ; 45 + 105 = 150 cents = $1.50
    assert set(result.keys()) == {"2026-03-10"}
    day = result["2026-03-10"]
    assert day["kwh"] == 1.0
    assert day["cost_estimate"] == 1.5
    assert day["interval_count"] == 2.0


def test_wh_to_kwh_and_cents_to_dollars():
    start = _ms(2026, 3, 10, 9, 0)
    text = f"{HEADER}\n{start},{start},1000,100,M\n"
    day = parse_power_csv(text)["2026-03-10"]
    assert day["kwh"] == 1.0  # 1000 Wh -> 1 kWh
    assert day["cost_estimate"] == 1.0  # 100 cents -> $1


def test_multiple_days_separate_buckets():
    d1 = _ms(2026, 3, 10, 8, 0)
    d2 = _ms(2026, 3, 11, 8, 0)
    text = f"{HEADER}\n{d1},{d1},500,60,M\n{d2},{d2},1500,180,M\n"
    result = parse_power_csv(text)
    assert set(result.keys()) == {"2026-03-10", "2026-03-11"}
    assert result["2026-03-10"]["kwh"] == 0.5
    assert result["2026-03-11"]["kwh"] == 1.5


def test_timezone_buckets_by_local_date():
    # 2026-01-01 04:30 UTC is 2025-12-31 23:30 in America/New_York (UTC-5).
    start = _ms(2026, 1, 1, 4, 30)
    text = f"{HEADER}\n{start},{start},1000,100,M\n"
    et = parse_power_csv(text, tz_name="America/New_York")
    assert set(et.keys()) == {"2025-12-31"}
    # Same input bucketed in UTC lands on 2026-01-01.
    utc = parse_power_csv(text, tz_name="UTC")
    assert set(utc.keys()) == {"2026-01-01"}


def test_skips_unparseable_rows_keeps_valid():
    start = _ms(2026, 3, 10, 8, 0)
    text = (
        f"{HEADER}\n"
        f"{start},{start},1000,100,M\n"
        f"{start},{start},not-a-number,100,M\n"  # bad WattHours -> skipped
        f",{start},500,50,M\n"  # missing StartUnixMillis -> skipped
    )
    day = parse_power_csv(text)["2026-03-10"]
    assert day["kwh"] == 1.0
    assert day["interval_count"] == 1.0


def test_missing_required_columns_returns_empty():
    text = "Foo,Bar\n1,2\n"
    assert parse_power_csv(text) == {}


def test_header_only_returns_empty():
    assert parse_power_csv(f"{HEADER}\n") == {}


def test_negative_wh_kept_for_net_metering():
    start = _ms(2026, 6, 15, 13, 0)
    text = f"{HEADER}\n{start},{start},-500,0,M\n{start},{start},1500,0,M\n"
    day = parse_power_csv(text)["2026-06-15"]
    assert day["kwh"] == 1.0  # (-500 + 1500) / 1000


def test_tolerates_thousands_separators():
    start = _ms(2026, 3, 10, 8, 0)
    text = f'{HEADER}\n{start},{start},"1,250",100,M\n'
    day = parse_power_csv(text)["2026-03-10"]
    assert day["kwh"] == 1.25


def test_merge_daily_sums_same_date():
    a = {"2026-03-10": {"kwh": 1.0, "cost_estimate": 1.0, "interval_count": 2.0}}
    b = {
        "2026-03-10": {"kwh": 0.5, "cost_estimate": 0.5, "interval_count": 1.0},
        "2026-03-11": {"kwh": 2.0, "cost_estimate": 2.0, "interval_count": 4.0},
    }
    merged = merge_daily(a, b)
    assert merged["2026-03-10"]["kwh"] == 1.5
    assert merged["2026-03-10"]["cost_estimate"] == 1.5
    assert merged["2026-03-11"]["kwh"] == 2.0
