"""
Unit tests for P19 financial account monitoring functions.

Tests cover:
  1. load_monitoring_config({}) → full defaults
  2. load_monitoring_config with partial override → one key changed, rest default
  3. detect_balance_anomalies with 10 synthetic rows → sigma flag
  4. detect_balance_anomalies with 3 rows (< min_history) → returns []
  5. cmd_account_monitoring with fresh in-memory DB (no prior rows) → no crash

External services (Plaid, Pushover, capture API, bws) are patched out entirely.
All tests operate on in-memory SQLite and pure Python arithmetic.
"""

import importlib
import sqlite3
import sys
import types
from datetime import date, timedelta
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

# ---------------------------------------------------------------------------
# Bootstrapping: financial-pipeline.py imports plaid and lib.capture_api which
# are not installed in the test environment.  We stub them out before import.
# ---------------------------------------------------------------------------

def _make_stub(name: str) -> types.ModuleType:
    """Create a minimal stub module (and any parent packages) in sys.modules."""
    parts = name.split(".")
    for i in range(1, len(parts) + 1):
        qname = ".".join(parts[:i])
        if qname not in sys.modules:
            mod = types.ModuleType(qname)
            sys.modules[qname] = mod
    return sys.modules[name]


# Stub plaid and plaid sub-modules referenced at module level
for _plaid_mod in [
    "plaid",
    "plaid.api",
    "plaid.api.plaid_api",
    "plaid.model",
    "plaid.model.accounts_balance_get_request",
    "plaid.model.transactions_sync_request",
    "plaid.model.investments_holdings_get_request",
    "plaid.Environment",
]:
    _make_stub(_plaid_mod)

# lib.capture_api stub — post_capture must be a callable
_lib_pkg = _make_stub("lib")
_capture_api_mod = _make_stub("lib.capture_api")
_capture_api_mod.post_capture = MagicMock(return_value=True)  # type: ignore[attr-defined]

# yaml is a real dependency (pyyaml) — no stub needed.
# requests is only used by utility-pipeline; financial-pipeline uses urllib only.

# Now import financial-pipeline as a module (sys.path must include scripts/).
_scripts_dir = str(Path(__file__).resolve().parent.parent)
if _scripts_dir not in sys.path:
    sys.path.insert(0, _scripts_dir)

# Reload guard: clear any prior import so stubs take effect.
if "financial-pipeline" in sys.modules:
    del sys.modules["financial-pipeline"]
if "financial_pipeline" in sys.modules:
    del sys.modules["financial_pipeline"]

# financial-pipeline.py uses a hyphen in its filename; use importlib.
_loader = importlib.util.spec_from_file_location(
    "financial_pipeline",
    Path(_scripts_dir) / "financial-pipeline.py",
)
assert _loader is not None and _loader.loader is not None
_fp_module = importlib.util.module_from_spec(_loader)
sys.modules["financial_pipeline"] = _fp_module
_loader.loader.exec_module(_fp_module)  # type: ignore[union-attr]

# Pull the functions under test into the local namespace for readability.
load_monitoring_config = _fp_module.load_monitoring_config
detect_balance_anomalies = _fp_module.detect_balance_anomalies
cmd_account_monitoring = _fp_module.cmd_account_monitoring
_MONITORING_DEFAULTS = _fp_module._MONITORING_DEFAULTS


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_db() -> sqlite3.Connection:
    """Return a fresh in-memory SQLite connection with the financial schema."""
    conn = sqlite3.connect(":memory:")
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS daily_balances (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date TEXT,
            account_id TEXT,
            current_balance REAL,
            available_balance REAL,
            credit_limit REAL,
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS holdings (
            date TEXT NOT NULL,
            security_id TEXT NOT NULL,
            name TEXT,
            ticker TEXT,
            quantity REAL,
            close_price REAL,
            value REAL,
            type TEXT,
            account_id TEXT,
            PRIMARY KEY (date, security_id)
        );

        CREATE TABLE IF NOT EXISTS accounts (
            id TEXT PRIMARY KEY,
            plaid_item_id TEXT,
            plaid_access_token_key TEXT,
            name TEXT,
            type TEXT,
            institution TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS transactions (
            id TEXT PRIMARY KEY,
            account_id TEXT,
            date TEXT,
            amount REAL,
            merchant TEXT,
            plaid_category TEXT,
            ob_category TEXT,
            pending BOOLEAN DEFAULT 0,
            raw_json TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        );
    """)
    conn.commit()
    return conn


def _insert_balance(conn, account_id: str, balance: float, days_ago: int = 0) -> None:
    """Insert a synthetic daily_balances row."""
    day = (date.today() - timedelta(days=days_ago)).isoformat()
    conn.execute(
        "INSERT INTO daily_balances (date, account_id, current_balance, available_balance, credit_limit) "
        "VALUES (?, ?, ?, ?, ?)",
        (day, account_id, balance, balance, 0.0),
    )
    conn.commit()


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestLoadMonitoringConfig:
    """Tests for load_monitoring_config()."""

    def test_empty_config_returns_full_defaults(self):
        """load_monitoring_config({}) must return every default key."""
        result = load_monitoring_config({})
        for key, default_val in _MONITORING_DEFAULTS.items():
            assert key in result, f"Missing key: {key}"
            assert result[key] == default_val, (
                f"Key {key!r}: expected {default_val!r}, got {result[key]!r}"
            )

    def test_partial_override_preserves_other_defaults(self):
        """One overridden key must not affect unrelated keys."""
        cfg = {"monitoring": {"balance_drop_pct": 15.0}}
        result = load_monitoring_config(cfg)

        # Overridden key
        assert result["balance_drop_pct"] == 15.0

        # All other keys remain at defaults
        for key, default_val in _MONITORING_DEFAULTS.items():
            if key == "balance_drop_pct":
                continue
            assert result[key] == default_val, (
                f"Key {key!r} should be default {default_val!r}, got {result[key]!r}"
            )


class TestDetectBalanceAnomalies:
    """Tests for detect_balance_anomalies()."""

    def _mcfg(self, **overrides):
        cfg = dict(_MONITORING_DEFAULTS)
        cfg.update(overrides)
        return cfg

    def test_sigma_flag_with_ten_history_rows(self):
        """Balance far from mean must produce an alert string.

        History has some variance (values cluster around $1,000 with small noise)
        so std > 0.  Today's balance of $5,000 is many sigmas above the mean.
        """
        conn = _make_db()
        account_id = "test_checking"

        # Insert 10 rows of history — small variation so std is non-zero but small
        # Values: 980, 990, 1000, 1010, 1020, 980, 1000, 1000, 1010, 990
        history_values = [980.0, 990.0, 1000.0, 1010.0, 1020.0,
                          980.0, 1000.0, 1000.0, 1010.0, 990.0]
        for i, val in enumerate(history_values, start=1):
            _insert_balance(conn, account_id, val, days_ago=i)

        # Today's balance is $5,000 — many sigmas above the ~$998 mean
        today_balance = 5000.0

        mcfg = self._mcfg(anomaly_sigma=2.5, anomaly_min_history_days=7)
        alerts = detect_balance_anomalies(conn, account_id, today_balance, mcfg)

        assert len(alerts) == 1, f"Expected 1 alert, got {alerts}"
        assert "test_checking" in alerts[0]
        assert "\u03c3" in alerts[0]  # sigma symbol in message
        conn.close()

    def test_insufficient_history_returns_empty_list(self):
        """Fewer than anomaly_min_history_days rows → must return []."""
        conn = _make_db()
        account_id = "test_savings"

        # Only 3 rows — below the default min of 7
        for i in range(1, 4):
            _insert_balance(conn, account_id, 2000.0, days_ago=i)

        today_balance = 50000.0  # wildly anomalous, but history too sparse
        mcfg = self._mcfg(anomaly_min_history_days=7)
        alerts = detect_balance_anomalies(conn, account_id, today_balance, mcfg)

        assert alerts == [], f"Expected empty list, got {alerts}"
        conn.close()

    def test_within_threshold_returns_empty_list(self):
        """Balance within 2.5σ of mean must return []."""
        conn = _make_db()
        account_id = "test_stable"

        # 10 rows all at $1,000
        for i in range(1, 11):
            _insert_balance(conn, account_id, 1000.0, days_ago=i)

        # Today is $1,050 — tiny deviation from a near-zero std
        # std is 0 (all same), so anomaly detection skips
        today_balance = 1050.0
        mcfg = self._mcfg(anomaly_sigma=2.5, anomaly_min_history_days=7)
        alerts = detect_balance_anomalies(conn, account_id, today_balance, mcfg)
        assert alerts == []
        conn.close()


class TestCmdAccountMonitoringColdDb:
    """Tests for cmd_account_monitoring() against a fresh database."""

    def test_cold_db_no_crash(self):
        """With no prior balance rows, cmd_account_monitoring must return gracefully."""
        conn = _make_db()
        cfg = {}  # minimal config — no accounts, no monitoring block

        # Patch send_pushover_alert and _post_capture to prevent any I/O
        with (
            patch.object(_fp_module, "send_pushover_alert", return_value=True) as mock_push,
            patch.object(_fp_module, "_post_capture", return_value=True) as mock_post,
        ):
            # Must not raise — returns None on "no balance data for today"
            result = cmd_account_monitoring(cfg, conn)
            assert result is None

            # No Pushover and no capture should be posted when there is no data
            mock_push.assert_not_called()
            mock_post.assert_not_called()

        conn.close()

    def test_today_balances_present_posts_capture(self):
        """With today's balance data and no threshold breaches, a capture is posted."""
        conn = _make_db()
        today_str = date.today().isoformat()

        # Insert one balance row for today
        conn.execute(
            "INSERT INTO daily_balances (date, account_id, current_balance, available_balance, credit_limit) "
            "VALUES (?, ?, ?, ?, ?)",
            (today_str, "truist", 5000.0, 5000.0, 0.0),
        )
        conn.commit()

        cfg = {
            "monitoring": {"post_daily_capture": True},
            "accounts": {"truist": {"name": "Truist Checking", "type": "checking"}},
        }

        with (
            patch.object(_fp_module, "send_pushover_alert", return_value=True) as mock_push,
            patch.object(_fp_module, "_post_capture", return_value=True) as mock_post,
        ):
            cmd_account_monitoring(cfg, conn)

            # post_daily_capture=True → capture must be posted
            mock_post.assert_called_once()
            call_kwargs = mock_post.call_args[0]  # positional args: (cfg, content, meta, ...)
            meta = call_kwargs[2]
            assert meta["type"] == "financial_monitoring"
            assert meta["date"] == today_str

            # No threshold breaches → no Pushover
            mock_push.assert_not_called()

        conn.close()
