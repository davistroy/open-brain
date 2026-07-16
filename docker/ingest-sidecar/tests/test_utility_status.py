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
