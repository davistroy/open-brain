"""Honest-status tests for ``scripts/utility-pipeline.py`` (WI-1.1).

These defend the defect that unifies **#284, #285 and #286**: *the failure and
its invisibility shipped in the same commit.*

``main()`` computes::

    "status": "ok" if exit_code == 0 and not _JSON_ERRORS else "error"

``cmd_gas`` appends to ``_JSON_ERRORS`` when it cannot parse a bill (the #275
fix). ``cmd_water`` and ``cmd_power_summary`` **never do** — every one of their
failure paths ``return``s after a bare ``log.error``/``log.info``. So a water
401, an unparseable payload, and a missing power binary were all indistinguish-
able from an idle run, and the sidecar reported ``status: "ok"`` for three
months while storing zero rows.

That is exactly the signal Entry 200 killed for gas:

    a parse miss must never degrade to a WARNING on a run that still reports
    ``status: ok`` — that combination is what hid this for months

These tests assert the *observability* of failure, not the fixes themselves.
Cobb Water's B2C OIDC auth (#285) and Cobb EMC's unbuilt CSV parser (#286) are
separate, operator-gated work. The point here is that when they fail, the run
says so.
"""

from __future__ import annotations

import importlib.util
import sqlite3
import sys
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

# utility-pipeline.py is not packaged and its filename has a hyphen, so a plain
# `import` cannot reach it. Load it by path, the way the sidecar image runs it.
_SCRIPTS_DIR = Path(__file__).resolve().parents[3] / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

_SPEC = importlib.util.spec_from_file_location(
    "utility_pipeline", _SCRIPTS_DIR / "utility-pipeline.py"
)
assert _SPEC is not None and _SPEC.loader is not None
up = importlib.util.module_from_spec(_SPEC)
sys.modules["utility_pipeline"] = up
_SPEC.loader.exec_module(up)


@pytest.fixture(autouse=True)
def _clear_errors() -> Iterator[None]:
    """`_JSON_ERRORS` is module-global — isolate every test from its neighbours."""
    up._JSON_ERRORS.clear()
    yield
    up._JSON_ERRORS.clear()


@pytest.fixture
def conn() -> Iterator[sqlite3.Connection]:
    """In-memory DB carrying the real `water_readings` DDL.

    `init_db()` can't be reused: it writes to `PIPE_DIR`/`DB_PATH` on disk. Mirror
    just the table `cmd_water` touches — it queries `water_readings` after the
    insert loop, so a bare `:memory:` connection raises `no such table` before the
    assertion under test is ever reached.
    """
    c = sqlite3.connect(":memory:")
    c.executescript(
        """
        CREATE TABLE IF NOT EXISTS water_readings (
            date TEXT PRIMARY KEY,
            quantity_tgal REAL,
            meter_serial TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        );
        """
    )
    yield c
    c.close()


WATER_CFG: dict[str, Any] = {
    "water": {
        "api_url": "https://example.invalid/api",
        "account_id": "TEST-ACCOUNT",
        "service_id": "TEST-SERVICE",
    }
}


class _Resp:
    """Minimal stand-in for requests.Response."""

    def __init__(self, status_code: int, payload: Any = None, text: str = ""):
        self.status_code = status_code
        self._payload = payload
        self.text = text

    def json(self) -> Any:
        if self._payload is None:
            raise ValueError("no json")
        return self._payload


def _status(exit_code: int = 0) -> str:
    """Mirror main()'s computation — the thing the trigger server reports."""
    return "ok" if exit_code == 0 and not up._JSON_ERRORS else "error"


# --------------------------------------------------------------------------
# cmd_water — every failure path must be visible
# --------------------------------------------------------------------------


def test_water_401_reports_error_not_ok(monkeypatch, conn):
    """#285's actual production symptom: a 401 that reported success."""
    monkeypatch.setattr(up.requests, "get", lambda *a, **k: _Resp(401, text="Unauthorized"))

    up.cmd_water(WATER_CFG, conn)

    assert up._JSON_ERRORS, "a 401 must record an error, not return silently"
    assert _status() == "error"


def test_water_network_failure_reports_error(monkeypatch, conn):
    def _boom(*a, **k):
        raise up.requests.exceptions.RequestException("connection refused")

    monkeypatch.setattr(up.requests, "get", _boom)

    up.cmd_water(WATER_CFG, conn)

    assert up._JSON_ERRORS
    assert _status() == "error"


def test_water_non_200_reports_error(monkeypatch, conn):
    monkeypatch.setattr(up.requests, "get", lambda *a, **k: _Resp(503, text="upstream down"))

    up.cmd_water(WATER_CFG, conn)

    assert up._JSON_ERRORS
    assert _status() == "error"


def test_water_unparseable_json_reports_error(monkeypatch, conn):
    monkeypatch.setattr(up.requests, "get", lambda *a, **k: _Resp(200, payload=None, text="<html>"))

    up.cmd_water(WATER_CFG, conn)

    assert up._JSON_ERRORS
    assert _status() == "error"


def test_water_unexpected_structure_reports_error(monkeypatch, conn):
    """A 200 whose shape matches none of the guessed wrapper keys."""
    monkeypatch.setattr(
        up.requests, "get", lambda *a, **k: _Resp(200, payload={"somethingElse": []})
    )

    up.cmd_water(WATER_CFG, conn)

    assert up._JSON_ERRORS
    assert _status() == "error"


def test_water_zero_parsed_from_nonempty_payload_reports_error(monkeypatch, conn):
    """The trap that would survive an auth fix.

    #285's parser guesses field names that match **nothing** in the real
    payload, so every row is skipped and it logs "0 new readings stored" on a
    clean run. Authenticating without fixing the parser converts a loud 401
    into a silent zero. A payload we clearly received but could not parse is an
    **error**, not an idle run.
    """
    monkeypatch.setattr(
        up.requests,
        "get",
        lambda *a, **k: _Resp(200, payload=[{"startDate": "2026-07-01", "totalConsumption": 10.0}]),
    )

    up.cmd_water(WATER_CFG, conn)

    assert up._JSON_ERRORS, "received rows but parsed none => error, not a clean run"
    assert _status() == "error"


# --------------------------------------------------------------------------
# cmd_power_summary — a missing binary must not look idle
# --------------------------------------------------------------------------


def test_power_missing_data_dir_reports_error(tmp_path, conn):
    """#286: the Dockerfile's `|| true` meant the binary was never installed.

    Nothing invokes it, so the data dir never appears, and the run returned at
    `log.info` — not even a warning. A configured-but-absent power path is a
    failure.
    """
    missing = tmp_path / "definitely-not-here"
    up.cmd_power_summary({"power": {"data_dir": str(missing)}}, conn)

    assert up._JSON_ERRORS
    assert _status() == "error"


def test_power_no_csv_files_reports_error(tmp_path, conn):
    """The dir exists but the tool produced nothing — still a failure."""
    empty = tmp_path / "electric-usage"
    empty.mkdir()

    up.cmd_power_summary({"power": {"data_dir": str(empty)}}, conn)

    assert up._JSON_ERRORS
    assert _status() == "error"


# --------------------------------------------------------------------------
# Guard the invariant itself
# --------------------------------------------------------------------------


def test_status_is_ok_only_when_no_errors():
    assert _status(0) == "ok"
    up._JSON_ERRORS.append("something broke")
    assert _status(0) == "error", "_JSON_ERRORS must force status=error"


# --------------------------------------------------------------------------
# Gas (remediation 3.4) — every failure recorded, exit status, heartbeat
# --------------------------------------------------------------------------

GAS_CFG: dict[str, Any] = {
    "gas": {
        "api_url": "https://example.invalid/oas/api",
        "auth_url": "https://auth.example.invalid",
        "client_id": "TEST-CLIENT",
        "account_number": "TEST-ACCT",
    }
}


@pytest.fixture
def gas_conn() -> Iterator[sqlite3.Connection]:
    c = sqlite3.connect(":memory:")
    c.executescript(
        """
        CREATE TABLE gas_readings (
            date TEXT PRIMARY KEY,
            bill_amount REAL,
            ccfs REAL,
            therm_factor REAL,
            therms REAL,
            rate_per_therm REAL,
            created_at TEXT DEFAULT (datetime('now'))
        );
        """
    )
    yield c
    c.close()


def _fake_secrets(monkeypatch, user: str = "fake-user", pw: str = "fake-pw") -> None:
    monkeypatch.setattr(up, "get_bws_secret", lambda key: user if "USER" in key.upper() else pw)


def _logged_in(monkeypatch) -> None:
    monkeypatch.setattr(up, "_gas_south_login", lambda cfg: "fake-token")


_ACTIVITY = [
    {
        "ActivityType": "Bill",
        "ActivityDate": "2026-01-15T00:00:00",
        "ActivityAmount": 12.5,
        "Url": "https://example.invalid/bill.pdf",
    }
]


def test_gas_unreachable_api_records_error(monkeypatch, gas_conn):
    _logged_in(monkeypatch)

    def _boom(*a, **k):
        raise up.requests.exceptions.RequestException("connection refused")

    monkeypatch.setattr(up.requests, "get", _boom)
    up.cmd_gas(GAS_CFG, gas_conn)
    assert up._JSON_ERRORS
    assert _status() == "error"


def test_gas_billing_401_records_error(monkeypatch, gas_conn):
    _logged_in(monkeypatch)
    monkeypatch.setattr(up.requests, "get", lambda *a, **k: _Resp(401, text="no"))
    up.cmd_gas(GAS_CFG, gas_conn)
    assert up._JSON_ERRORS


def test_gas_billing_non_200_records_error(monkeypatch, gas_conn):
    _logged_in(monkeypatch)
    monkeypatch.setattr(up.requests, "get", lambda *a, **k: _Resp(503, text="down"))
    up.cmd_gas(GAS_CFG, gas_conn)
    assert up._JSON_ERRORS


def test_gas_billing_bad_json_records_error(monkeypatch, gas_conn):
    _logged_in(monkeypatch)
    monkeypatch.setattr(up.requests, "get", lambda *a, **k: _Resp(200, payload=None, text="<h>"))
    up.cmd_gas(GAS_CFG, gas_conn)
    assert up._JSON_ERRORS


def test_gas_billing_unexpected_structure_records_error(monkeypatch, gas_conn):
    _logged_in(monkeypatch)
    monkeypatch.setattr(up.requests, "get", lambda *a, **k: _Resp(200, payload={"other": 1}))
    up.cmd_gas(GAS_CFG, gas_conn)
    assert up._JSON_ERRORS


def test_gas_login_failure_records_error(monkeypatch, gas_conn):
    """The login helper returns None; cmd_gas must not return silently."""
    _fake_secrets(monkeypatch)
    monkeypatch.setattr(up.requests, "post", lambda *a, **k: _Resp(400, payload={"title": "x"}))
    up.cmd_gas(GAS_CFG, gas_conn)
    assert len(up._JSON_ERRORS) == 1


@pytest.mark.parametrize(
    "post",
    [
        lambda *a, **k: (_ for _ in ()).throw(up.requests.exceptions.RequestException("down")),
        lambda *a, **k: _Resp(200, payload=None, text="<html>"),
        lambda *a, **k: _Resp(400, payload={"ErrorCode": "BAD", "ErrorMessage": "nope"}),
        lambda *a, **k: _Resp(400, payload={"title": "Bad Request"}),
        lambda *a, **k: _Resp(200, payload={"Accounts": []}),
    ],
    ids=["network", "non-json", "rejected", "rejected-no-code", "no-token"],
)
def test_gas_login_each_failure_path_records_one_error(monkeypatch, post):
    _fake_secrets(monkeypatch)
    monkeypatch.setattr(up.requests, "post", post)
    assert up._gas_south_login(GAS_CFG) is None
    assert len(up._JSON_ERRORS) == 1
    # No credential material in the recorded message.
    assert "fake-user" not in up._JSON_ERRORS[0]
    assert "fake-pw" not in up._JSON_ERRORS[0]


def test_gas_login_missing_credentials_records_error(monkeypatch):
    _fake_secrets(monkeypatch, user="", pw="")
    assert up._gas_south_login(GAS_CFG) is None
    assert len(up._JSON_ERRORS) == 1


def test_gas_null_therms_row_is_fetched_again(monkeypatch, gas_conn):
    gas_conn.execute(
        "INSERT INTO gas_readings (date, bill_amount, therms) VALUES ('2026-01-15', 1.0, NULL)"
    )
    _logged_in(monkeypatch)
    calls: list[str] = []

    class _PdfResp(_Resp):
        content = b"x" * 200

    def _get2(url, *a, **k):
        calls.append(url)
        if url.endswith("bill.pdf"):
            return _PdfResp(200)
        return _Resp(200, payload=_ACTIVITY)

    monkeypatch.setattr(up.requests, "get", _get2)
    monkeypatch.setattr(
        up,
        "_parse_gas_bill_pdf",
        lambda b: {"ccfs": 10.0, "therm_factor": 1.0, "therms": 10.0, "rate_per_therm": 1.0},
    )
    up.cmd_gas(GAS_CFG, gas_conn)

    assert any(u.endswith("bill.pdf") for u in calls), "NULL-therms row must be re-fetched"
    row = gas_conn.execute("SELECT therms, bill_amount FROM gas_readings").fetchall()
    assert row == [(10.0, 12.5)], "row updated in place, not duplicated"


def test_gas_row_with_therms_is_skipped(monkeypatch, gas_conn):
    gas_conn.execute(
        "INSERT INTO gas_readings (date, bill_amount, therms) VALUES ('2026-01-15', 1.0, 9.0)"
    )
    _logged_in(monkeypatch)
    calls: list[str] = []

    def _get(url, *a, **k):
        calls.append(url)
        return _Resp(200, payload=_ACTIVITY)

    monkeypatch.setattr(up.requests, "get", _get)
    up.cmd_gas(GAS_CFG, gas_conn)
    assert not any(u.endswith("bill.pdf") for u in calls)
    assert not up._JSON_ERRORS


def test_post_capture_failure_recorded_without_json_output(monkeypatch):
    monkeypatch.setattr(up, "_JSON_OUTPUT_MODE", False)
    monkeypatch.setattr(up, "_post_capture_unwrapped", lambda *a, **k: False)
    assert up._post_capture_raw({}, "content", {}) is False
    assert up._JSON_ERRORS


# -- main(): exit code + heartbeat -----------------------------------------


def _run_main(monkeypatch, tmp_path, argv, cmd_gas, heartbeat_ok: bool = True):
    beats: list[dict[str, Any]] = []
    c = sqlite3.connect(":memory:")
    monkeypatch.setattr(sys, "argv", ["utility-pipeline.py", *argv])
    monkeypatch.setattr(up, "init_db", lambda: c)
    monkeypatch.setattr(up, "load_config", lambda: {})
    monkeypatch.setattr(up, "cmd_gas", cmd_gas)

    def _hb(cfg, source, ok, errors=None, meta=None, caller=None):
        beats.append({"source": source, "ok": ok, "errors": errors, "meta": meta})
        return heartbeat_ok

    monkeypatch.setattr(up, "post_heartbeat", _hb)
    code = 0
    try:
        up.main()
    except SystemExit as e:
        code = int(e.code or 0)
    return code, beats


def test_main_exits_1_on_recorded_error_without_json_output(monkeypatch, tmp_path):
    def _fail(cfg, conn):
        up._JSON_ERRORS.append("gas fetch failed")

    code, beats = _run_main(monkeypatch, tmp_path, ["--gas"], _fail)
    assert code == 1
    assert beats == [
        {"source": "gas", "ok": False, "errors": ["gas fetch failed"], "meta": beats[0]["meta"]}
    ]


def test_main_clean_run_exits_0_and_posts_ok_heartbeat(monkeypatch, tmp_path):
    code, beats = _run_main(monkeypatch, tmp_path, ["--gas"], lambda cfg, conn: None)
    assert code == 0
    assert len(beats) == 1 and beats[0]["ok"] is True and beats[0]["source"] == "gas"


def test_main_heartbeat_carries_only_first_five_errors(monkeypatch, tmp_path):
    def _fail(cfg, conn):
        up._JSON_ERRORS.extend(f"e{i}" for i in range(8))

    _, beats = _run_main(monkeypatch, tmp_path, ["--gas"], _fail)
    assert beats[0]["errors"] == [f"e{i}" for i in range(5)]


def test_main_heartbeat_meta_has_latest_bill_date_only(monkeypatch, tmp_path):
    def _ok(cfg, conn):
        conn.execute(
            "CREATE TABLE IF NOT EXISTS gas_readings (date TEXT PRIMARY KEY, bill_amount REAL, "
            "ccfs REAL, therm_factor REAL, therms REAL, rate_per_therm REAL)"
        )
        conn.execute("INSERT INTO gas_readings (date, bill_amount) VALUES ('2026-01-15', 5.0)")

    _, beats = _run_main(monkeypatch, tmp_path, ["--gas"], _ok)
    assert beats[0]["meta"] == {"latest_bill_date": "2026-01-15"}


def test_main_heartbeat_failure_records_error_and_exits_1(monkeypatch, tmp_path):
    code, _ = _run_main(
        monkeypatch, tmp_path, ["--gas"], lambda cfg, conn: None, heartbeat_ok=False
    )
    assert code == 1
    assert any("heartbeat" in e for e in up._JSON_ERRORS)


def test_main_does_not_post_heartbeat_when_gas_not_requested(monkeypatch, tmp_path):
    c = sqlite3.connect(":memory:")
    beats: list[Any] = []
    monkeypatch.setattr(sys, "argv", ["utility-pipeline.py", "--water"])
    monkeypatch.setattr(up, "init_db", lambda: c)
    monkeypatch.setattr(up, "load_config", lambda: {})
    monkeypatch.setattr(up, "cmd_water", lambda cfg, conn: None)
    monkeypatch.setattr(up, "post_heartbeat", lambda *a, **k: beats.append(1) or True)
    up.main()
    assert beats == []


# -- capture_api.post_heartbeat --------------------------------------------


def test_post_heartbeat_url_headers_body(monkeypatch):
    from lib import capture_api

    seen: dict[str, Any] = {}

    def _post(url, **kw):
        seen["url"] = url
        seen.update(kw)
        return _Resp(200, payload={"source": "gas", "record": {}})

    monkeypatch.delenv("CAPTURE_API_URL", raising=False)
    monkeypatch.delenv("CAPTURE_API_CALLER", raising=False)
    monkeypatch.setattr(capture_api.requests, "post", _post)
    cfg = {"capture_api": {"url": "http://core-api:3000/api/v1/captures"}}
    ok = capture_api.post_heartbeat(
        cfg, "gas", False, ["boom"], {"latest_bill_date": "2026-01-15"}, "utility-pipeline"
    )
    assert ok is True
    assert seen["url"] == "http://core-api:3000/api/v1/internal/heartbeat/gas"
    assert seen["headers"]["X-Open-Brain-Caller"] == "utility-pipeline"
    assert seen["json"] == {
        "ok": False,
        "errors": ["boom"],
        "meta": {"latest_bill_date": "2026-01-15"},
    }


def test_post_heartbeat_omits_empty_optional_fields(monkeypatch):
    from lib import capture_api

    seen: dict[str, Any] = {}
    monkeypatch.setattr(
        capture_api.requests,
        "post",
        lambda url, **kw: seen.update(kw) or _Resp(200, payload={}),
    )
    monkeypatch.setenv("CAPTURE_API_URL", "http://core-api:3000/api/v1/captures/")
    assert capture_api.post_heartbeat({}, "gas", True, caller="utility-pipeline") is True
    assert seen["json"] == {"ok": True}


@pytest.mark.parametrize("status", [400, 403, 500])
def test_post_heartbeat_non_200_returns_false(monkeypatch, status):
    from lib import capture_api

    monkeypatch.setenv("CAPTURE_API_URL", "http://core-api:3000/api/v1/captures")
    monkeypatch.setattr(capture_api.requests, "post", lambda *a, **k: _Resp(status, text="no"))
    assert capture_api.post_heartbeat({}, "gas", True, caller="utility-pipeline") is False


def test_post_heartbeat_network_failure_returns_false(monkeypatch):
    from lib import capture_api

    def _boom(*a, **k):
        raise capture_api.requests.exceptions.RequestException("down")

    monkeypatch.setenv("CAPTURE_API_URL", "http://core-api:3000/api/v1/captures")
    monkeypatch.setattr(capture_api.requests, "post", _boom)
    assert capture_api.post_heartbeat({}, "gas", True, caller="utility-pipeline") is False
