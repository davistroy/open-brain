#!/usr/bin/env python3
"""
Financial Pipeline for Open Brain.

Syncs transactions from Plaid-linked accounts, stores in SQLite, categorizes
via T0 merchant/Plaid category matching, and posts daily summary captures to
the Open Brain API. Runs via cron on open-brain-vm.

Usage:
    python financial-pipeline.py --sync                      # sync transactions
    python financial-pipeline.py --balances                  # daily balance snapshot
    python financial-pipeline.py --daily-summary             # post daily summary capture
    python financial-pipeline.py --sync --daily-summary      # sync + summarize
    python financial-pipeline.py --investments               # weekly investment report (Schwab)
    python financial-pipeline.py --monthly-report            # monthly synthesis (prior month)
    python financial-pipeline.py --process-inbox             # process 401k PDFs + Amazon CSVs from ~/financial-inbox/
    python financial-pipeline.py --status                    # pipeline stats

Cron (daily 6:30 AM):
    30 6 * * * cd ~/open-brain && venv/bin/python scripts/financial-pipeline.py --sync --daily-summary >> ~/logs/financial-pipeline.log 2>&1
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import logging
import os
import re
import sqlite3
import subprocess
import sys
import time
from collections import defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

import yaml

# Shared capture-API helper (CS2.1/CS2.2). Works both in Docker (`/app/lib/`
# after COPY) and locally (`scripts/` is sys.path[0] when running the script
# directly), so `from lib.capture_api import …` resolves in both cases.
from lib.capture_api import post_capture as _post_capture_raw  # noqa: E402

# CS3.9 --json-output support: wrap _post_capture to track results so the
# ingest sidecar (docker/ingest-sidecar/trigger_server.py) can parse a JSON
# summary as the final stdout line. When --json-output is NOT set this is a
# transparent passthrough and output is unchanged.
_JSON_OUTPUT_MODE = False
_JSON_CAPTURES_POSTED: list[str] = []
_JSON_ERRORS: list[str] = []


def _post_capture(
    cfg: dict[str, Any],
    content: str,
    source_metadata: dict[str, Any],
    capture_type: str = "observation",
    brain_view: str = "personal",
) -> bool:
    ok = _post_capture_raw(
        cfg, content, source_metadata, capture_type=capture_type, brain_view=brain_view
    )
    if _JSON_OUTPUT_MODE:
        if ok:
            # Content preview is a stable, human-readable id — the helper
            # does not return the capture UUID.
            _JSON_CAPTURES_POSTED.append(content[:80])
        else:
            _JSON_ERRORS.append(f"post_capture failed: {content[:80]}")
    return ok


sys.stdout.reconfigure(line_buffering=True)
sys.stderr.reconfigure(line_buffering=True)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("financial-pipeline")

# --- Paths & constants ---
# All directory paths accept env-var overrides so the same script works in
# both the VM environment (home-dir defaults) and the Docker sidecar where
# paths are mounted at known locations.
PIPE_DIR = Path(os.environ.get("FINANCIAL_PIPE_DIR", str(Path.home() / ".financial-pipeline")))
DB_PATH = PIPE_DIR / "financial.db"
CONFIG_DIR_ENV = os.environ.get("FINANCIAL_CONFIG_DIR")
CONFIG_BASE = (
    Path(CONFIG_DIR_ENV)
    if CONFIG_DIR_ENV
    else Path(__file__).resolve().parent.parent / "config" / "financial"
)
CONFIG_PATH = CONFIG_BASE / "plaid-config.yaml"
MERCHANTS_PATH = CONFIG_BASE / "merchants.yaml"


# ── Config ───────────────────────────────────────────────────────────────────


def load_config() -> dict[str, Any]:
    """Load plaid-config.yaml."""
    if not CONFIG_PATH.exists():
        sys.exit(f"Config not found: {CONFIG_PATH}")
    return yaml.safe_load(CONFIG_PATH.read_text())  # type: ignore[no-any-return]


def load_merchants() -> dict | None:
    """Load merchants.yaml if it exists. Returns None if not found."""
    if not MERCHANTS_PATH.exists():
        log.info("merchants.yaml not found — using Plaid categories only")
        return None
    try:
        return yaml.safe_load(MERCHANTS_PATH.read_text())
    except Exception as e:
        log.warning(f"Failed to load merchants.yaml: {e}")
        return None


# ── Secrets ──────────────────────────────────────────────────────────────────

# Cache bws secret list to avoid repeated subprocess calls
_bws_secrets_cache: list | None = None


def _load_bws_secrets() -> list:
    """Load all secrets from Bitwarden Secrets Manager (cached)."""
    global _bws_secrets_cache
    if _bws_secrets_cache is not None:
        return _bws_secrets_cache
    try:
        result = subprocess.run(
            ["bws", "secret", "list"],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode != 0:
            log.error(f"bws failed: {result.stderr.strip()}")
            sys.exit(1)
        _bws_secrets_cache = json.loads(result.stdout)
        return _bws_secrets_cache
    except FileNotFoundError:
        log.error("bws CLI not found. Install it or check PATH.")
        sys.exit(1)
    except subprocess.TimeoutExpired:
        log.error("bws timed out — is BWS_ACCESS_TOKEN set?")
        sys.exit(1)


def get_bws_secret(secret_name: str) -> str:
    """Retrieve a secret value from Bitwarden Secrets Manager via bws CLI."""
    secrets = _load_bws_secrets()
    for s in secrets:
        if s.get("key") == secret_name:
            return s["value"]
    log.error(f"Secret '{secret_name}' not found in Bitwarden Secrets Manager")
    sys.exit(1)


# ── Plaid Client ─────────────────────────────────────────────────────────────


def create_plaid_client(cfg: dict, client_id: str, secret: str):
    """Create Plaid API client for the configured environment."""
    import plaid
    from plaid.api import plaid_api

    env_map = {
        "sandbox": plaid.Environment.Sandbox,
        "development": plaid.Environment.Development,
        "production": plaid.Environment.Production,
    }
    env = cfg.get("environment", "development")
    if env not in env_map:
        sys.exit(f"Invalid Plaid environment: {env}")

    configuration = plaid.Configuration(
        host=env_map[env],
        api_key={
            "clientId": client_id,
            "secret": secret,
        },
    )
    api_client = plaid.ApiClient(configuration)
    return plaid_api.PlaidApi(api_client)


def init_plaid(cfg: dict):
    """Initialize Plaid client using config + Bitwarden secrets."""
    bw_keys = cfg.get("bitwarden_keys", {})
    client_id = get_bws_secret(bw_keys.get("client_id_key", "plaid-client-id"))
    secret_val = get_bws_secret(bw_keys.get("secret_key", "plaid-secret"))
    log.info(f"Plaid credentials loaded (environment: {cfg.get('environment', 'development')})")
    return create_plaid_client(cfg, client_id, secret_val)


def get_access_token(cfg: dict, account_key: str) -> str:
    """Retrieve a Plaid access token for a specific account from Bitwarden.

    The tokens secret is a JSON object mapping account keys to access tokens:
    {"amex": "access-development-xxx", "chase": "access-development-yyy", ...}
    """
    bw_keys = cfg.get("bitwarden_keys", {})
    tokens_raw = get_bws_secret(bw_keys.get("tokens_key", "plaid-access-tokens"))
    try:
        tokens = json.loads(tokens_raw)
    except json.JSONDecodeError:
        log.error("plaid-access-tokens secret is not valid JSON")
        sys.exit(1)
    token = tokens.get(account_key)
    if not token:
        log.error(f"No access token for account '{account_key}' in plaid-access-tokens")
        return ""
    return token


# ── Database ─────────────────────────────────────────────────────────────────


def init_db() -> sqlite3.Connection:
    """Initialize SQLite with financial tables."""
    PIPE_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH), timeout=30)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.executescript("""
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

        CREATE TABLE IF NOT EXISTS sync_cursors (
            account_id TEXT PRIMARY KEY,
            cursor TEXT,
            last_sync TEXT
        );

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

        CREATE INDEX IF NOT EXISTS idx_txn_date ON transactions(date);
        CREATE INDEX IF NOT EXISTS idx_txn_account ON transactions(account_id);
        CREATE INDEX IF NOT EXISTS idx_bal_date ON daily_balances(date);
        CREATE INDEX IF NOT EXISTS idx_holdings_date ON holdings(date);
    """)
    conn.commit()
    return conn


def ensure_account(conn: sqlite3.Connection, account_key: str, cfg_account: dict):
    """Insert or update account record."""
    conn.execute(
        "INSERT OR REPLACE INTO accounts (id, name, type, institution, plaid_access_token_key) "
        "VALUES (?, ?, ?, ?, ?)",
        (
            account_key,
            cfg_account["name"],
            cfg_account["type"],
            cfg_account["institution"],
            account_key,
        ),
    )
    conn.commit()


def get_sync_cursor(conn: sqlite3.Connection, account_id: str) -> str | None:
    """Get stored sync cursor for an account."""
    row = conn.execute(
        "SELECT cursor FROM sync_cursors WHERE account_id = ?", (account_id,)
    ).fetchone()
    return row[0] if row else None


def save_sync_cursor(conn: sqlite3.Connection, account_id: str, cursor: str):
    """Store sync cursor for an account."""
    conn.execute(
        "INSERT OR REPLACE INTO sync_cursors (account_id, cursor, last_sync) "
        "VALUES (?, ?, datetime('now'))",
        (account_id, cursor),
    )
    conn.commit()


def upsert_transaction(conn: sqlite3.Connection, txn: dict, account_id: str, ob_category: str):
    """Insert or update a transaction."""
    plaid_cat = ""
    pfc = txn.get("personal_finance_category")
    if pfc:
        plaid_cat = f"{pfc.get('primary', '')}/{pfc.get('detailed', '')}"

    conn.execute(
        "INSERT OR REPLACE INTO transactions "
        "(id, account_id, date, amount, merchant, plaid_category, ob_category, pending, raw_json, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))",
        (
            txn["transaction_id"],
            account_id,
            txn.get("date", ""),
            txn.get("amount", 0.0),
            txn.get("merchant_name") or txn.get("name", "Unknown"),
            plaid_cat,
            ob_category,
            1 if txn.get("pending") else 0,
            json.dumps(txn, default=str),
        ),
    )


def remove_transaction(conn: sqlite3.Connection, txn_id: str):
    """Remove a transaction (Plaid reports it removed)."""
    conn.execute("DELETE FROM transactions WHERE id = ?", (txn_id,))


# ── T0 Categorization ───────────────────────────────────────────────────────

# Plaid personal_finance_category.primary → Open Brain category
PLAID_CATEGORY_MAP = {
    "FOOD_AND_DRINK": "Dining",
    "GENERAL_MERCHANDISE": "Shopping",
    "TRANSPORTATION": "Gas/Fuel",
    "TRAVEL": "Travel",
    "ENTERTAINMENT": "Entertainment",
    "PERSONAL_CARE": "Shopping",
    "GENERAL_SERVICES": "Professional",
    "GOVERNMENT_AND_NON_PROFIT": "Professional",
    "HOME_IMPROVEMENT": "Household",
    "MEDICAL": "Medical",
    "RENT_AND_UTILITIES": "Utilities",
    "INCOME": "Income",
    "TRANSFER_IN": "Transfers",
    "TRANSFER_OUT": "Transfers",
    "LOAN_PAYMENTS": "Transfers",
    "BANK_FEES": "Transfers",
}


def categorize_transaction(txn: dict, merchants: dict | None) -> str:
    """T0 categorization: exact merchant → pattern → Plaid category → Uncategorized.

    Resolution order:
    1. Exact merchant name match (from merchants.yaml)
    2. Pattern/regex match (from merchants.yaml)
    3. Plaid personal_finance_category mapping
    4. 'Uncategorized' fallback
    """
    merchant_name = (txn.get("merchant_name") or txn.get("name") or "").strip()
    merchant_lower = merchant_name.lower()

    if merchants:
        # 1. Exact match
        exact = merchants.get("exact_matches", {})
        for pattern, category in exact.items():
            if pattern.lower() == merchant_lower:
                return category

        # 2. Pattern match (regex)
        patterns = merchants.get("pattern_matches", {})
        for pattern, category in patterns.items():
            try:
                if re.search(pattern, merchant_name, re.IGNORECASE):
                    return category
            except re.error:
                pass

        # 3. Plaid category map from merchants.yaml (overrides built-in)
        pfc = txn.get("personal_finance_category")
        if pfc:
            yaml_plaid_map = merchants.get("plaid_category_map", {})
            primary = pfc.get("primary", "")
            if primary in yaml_plaid_map:
                return yaml_plaid_map[primary]

    # 3b. Built-in Plaid category map
    pfc = txn.get("personal_finance_category")
    if pfc:
        primary = pfc.get("primary", "")
        if primary in PLAID_CATEGORY_MAP:
            return PLAID_CATEGORY_MAP[primary]

    return "Uncategorized"


# ── Sync ─────────────────────────────────────────────────────────────────────


def sync_account(
    client, conn: sqlite3.Connection, account_key: str, access_token: str, merchants: dict | None
) -> dict:
    """Sync transactions for a single account using /transactions/sync.

    Returns stats dict: {added, modified, removed, error}.
    """
    from plaid.model.transactions_sync_request import TransactionsSyncRequest

    cursor = get_sync_cursor(conn, account_key)
    stats = {"added": 0, "modified": 0, "removed": 0}
    has_more = True

    while has_more:
        try:
            req_kwargs = {"access_token": access_token}
            if cursor:
                req_kwargs["cursor"] = cursor
            request = TransactionsSyncRequest(**req_kwargs)
            response = client.transactions_sync(request)
        except Exception as e:
            error_str = str(e)
            # Handle ITEM_LOGIN_REQUIRED gracefully
            if "ITEM_LOGIN_REQUIRED" in error_str:
                log.warning(
                    f"  {account_key}: bank login required — re-run Plaid Link for this account"
                )
                return {"added": 0, "modified": 0, "removed": 0, "error": "ITEM_LOGIN_REQUIRED"}
            log.error(f"  {account_key}: sync error — {e}")
            return {"added": 0, "modified": 0, "removed": 0, "error": str(e)}

        # Process added transactions
        for txn in response.added:
            txn_dict = txn.to_dict()
            ob_cat = categorize_transaction(txn_dict, merchants)
            upsert_transaction(conn, txn_dict, account_key, ob_cat)
            stats["added"] += 1

        # Process modified transactions
        for txn in response.modified:
            txn_dict = txn.to_dict()
            ob_cat = categorize_transaction(txn_dict, merchants)
            upsert_transaction(conn, txn_dict, account_key, ob_cat)
            stats["modified"] += 1

        # Process removed transactions
        for txn in response.removed:
            txn_id = (
                txn.transaction_id
                if hasattr(txn, "transaction_id")
                else txn.get("transaction_id", "")
            )
            if txn_id:
                remove_transaction(conn, txn_id)
                stats["removed"] += 1

        cursor = response.next_cursor
        has_more = response.has_more
        time.sleep(0.1)  # rate limit courtesy

    conn.commit()
    save_sync_cursor(conn, account_key, cursor)
    return stats


def cmd_sync(cfg: dict, conn: sqlite3.Connection):
    """--sync: Sync transactions for all configured accounts."""
    log.info("=== Transaction Sync ===")

    client = init_plaid(cfg)
    merchants = load_merchants()
    accounts = cfg.get("accounts", {})

    total_stats = {"added": 0, "modified": 0, "removed": 0, "errors": []}

    for account_key, account_cfg in accounts.items():
        ensure_account(conn, account_key, account_cfg)
        access_token = get_access_token(cfg, account_key)
        if not access_token:
            log.warning(f"  {account_key}: no access token — skipping")
            total_stats["errors"].append(account_key)
            continue

        log.info(f"  Syncing {account_key} ({account_cfg['name']})...")
        stats = sync_account(client, conn, account_key, access_token, merchants)

        if "error" in stats:
            total_stats["errors"].append(f"{account_key}: {stats['error']}")
        else:
            total_stats["added"] += stats["added"]
            total_stats["modified"] += stats["modified"]
            total_stats["removed"] += stats["removed"]
        log.info(
            f"    +{stats['added']} added, ~{stats['modified']} modified, -{stats['removed']} removed"
        )

    log.info(
        f"Sync complete: +{total_stats['added']} added, ~{total_stats['modified']} modified, "
        f"-{total_stats['removed']} removed, {len(total_stats['errors'])} errors"
    )
    if total_stats["errors"]:
        for err in total_stats["errors"]:
            log.warning(f"  Error: {err}")


# ── Daily Summary ────────────────────────────────────────────────────────────


def cmd_daily_summary(cfg: dict, conn: sqlite3.Connection):
    """--daily-summary: Aggregate today's transactions and POST capture to Open Brain."""
    log.info("=== Daily Summary ===")

    today = date.today().isoformat()

    # Query today's transactions
    rows = conn.execute(
        "SELECT t.account_id, a.name, t.amount, t.merchant, t.ob_category, t.pending "
        "FROM transactions t LEFT JOIN accounts a ON t.account_id = a.id "
        "WHERE t.date = ? AND t.pending = 0 "
        "ORDER BY t.account_id, t.ob_category",
        (today,),
    ).fetchall()

    if not rows:
        log.info(f"No settled transactions for {today}, skipping summary")
        return

    # Aggregate by account
    by_account = defaultdict(
        lambda: {
            "name": "",
            "total": 0.0,
            "count": 0,
            "categories": defaultdict(lambda: {"total": 0.0, "count": 0}),
        }
    )
    grand_total = 0.0

    for account_id, account_name, amount, _merchant, ob_category, _pending in rows:
        acct = by_account[account_id]
        acct["name"] = account_name or account_id
        acct["total"] += amount
        acct["count"] += 1
        acct["categories"][ob_category]["total"] += amount
        acct["categories"][ob_category]["count"] += 1
        grand_total += amount

    # Format readable text
    lines = [f"Financial Daily -- {today}", ""]
    lines.append(f"Total: {len(rows)} transactions, ${abs(grand_total):,.2f} net")
    lines.append("")

    for account_id, acct in sorted(by_account.items()):
        lines.append(f"{acct['name']}: {acct['count']} transactions, ${abs(acct['total']):,.2f}")
        for cat, cat_data in sorted(
            acct["categories"].items(), key=lambda x: abs(x[1]["total"]), reverse=True
        ):
            lines.append(f"  {cat}: ${abs(cat_data['total']):,.2f} ({cat_data['count']} txns)")
        lines.append("")

    summary_text = "\n".join(lines)
    log.info(f"Summary: {len(rows)} transactions across {len(by_account)} accounts")

    # Build source_metadata
    categories_summary = {}
    for account_id, acct in by_account.items():
        categories_summary[account_id] = {
            "name": acct["name"],
            "total": round(acct["total"], 2),
            "count": acct["count"],
        }

    # POST to Open Brain
    if _post_capture(
        cfg,
        summary_text,
        {
            "type": "financial_daily",
            "date": today,
            "transaction_count": len(rows),
            "grand_total": round(grand_total, 2),
            "accounts": categories_summary,
        },
        capture_type="observation",
        brain_view="personal",
    ):
        log.info(f"Daily summary posted ({len(rows)} transactions)")


# ── Balances ─────────────────────────────────────────────────────────────────

# Account types where Plaid reports positive balances that represent debt (owed)
CREDIT_ACCOUNT_TYPES = {"credit", "loan"}


def fetch_account_balances(client, access_token: str) -> list:
    """Call Plaid /accounts/balance/get and return list of account dicts."""
    from plaid.model.accounts_balance_get_request import AccountsBalanceGetRequest

    request = AccountsBalanceGetRequest(access_token=access_token)
    response = client.accounts_balance_get(request)
    return [acct.to_dict() for acct in response.accounts]


def store_balances(
    conn: sqlite3.Connection,
    today: str,
    account_key: str,
    current: float,
    available: float,
    limit: float,
):
    """Insert a daily balance row (one per account per day)."""
    # Avoid duplicates: delete existing row for this account+date, then insert
    conn.execute(
        "DELETE FROM daily_balances WHERE date = ? AND account_id = ?",
        (today, account_key),
    )
    conn.execute(
        "INSERT INTO daily_balances (date, account_id, current_balance, available_balance, credit_limit) "
        "VALUES (?, ?, ?, ?, ?)",
        (today, account_key, current, available, limit),
    )


# ── Account monitoring helpers ────────────────────────────────────────────────

# Default monitoring thresholds — returned by load_monitoring_config() when
# the YAML block is absent or partially populated.
_MONITORING_DEFAULTS: dict = {
    "balance_drop_pct": 20.0,
    "balance_drop_abs": 500.0,
    "credit_utilization_pct": 80.0,
    "position_change_pct": 10.0,
    "portfolio_drop_pct": 5.0,
    "anomaly_sigma": 2.5,
    "anomaly_min_history_days": 7,
    "net_worth_drop_pct": 5.0,
    "post_capture_on_alert": True,
    "post_daily_capture": True,
}


def load_monitoring_config(cfg: dict) -> dict:
    """Return the monitoring block from config with defaults for any missing key.

    Callers use mcfg['balance_drop_pct'] etc. without guarding for KeyError.
    Safe to call even when cfg has no 'monitoring' key.
    """
    raw = cfg.get("monitoring", {}) if cfg else {}
    result = dict(_MONITORING_DEFAULTS)
    for k, v in raw.items():
        if k in result:
            result[k] = v
    return result


def detect_balance_anomalies(
    conn: sqlite3.Connection,
    account_key: str,
    today_balance: float,
    mcfg: dict,
) -> list[str]:
    """Detect whether today's balance is an outlier vs. trailing 30-day history.

    Returns a list of human-readable alert strings (empty list = no anomaly or
    insufficient history).  Pure arithmetic over SQLite data — no LLM call.

    Algorithm:
    - Query up to 30 days of prior rows (excluding today) for this account.
    - If fewer than anomaly_min_history_days rows exist → return [].
    - Compute mean + population std of current_balance over those rows.
    - If std == 0 (all values identical) → skip (no useful signal).
    - If abs(today - mean) > anomaly_sigma * std → return an alert string.
    """
    sigma_threshold = float(mcfg.get("anomaly_sigma", _MONITORING_DEFAULTS["anomaly_sigma"]))
    min_history = int(
        mcfg.get("anomaly_min_history_days", _MONITORING_DEFAULTS["anomaly_min_history_days"])
    )

    thirty_days_ago = (date.today() - timedelta(days=30)).isoformat()
    today_str = date.today().isoformat()

    rows = conn.execute(
        "SELECT current_balance FROM daily_balances "
        "WHERE account_id = ? AND date >= ? AND date < ? "
        "ORDER BY date DESC",
        (account_key, thirty_days_ago, today_str),
    ).fetchall()

    if len(rows) < min_history:
        return []

    values = [r[0] for r in rows]
    n = len(values)
    mean = sum(values) / n
    variance = sum((v - mean) ** 2 for v in values) / n
    std = variance**0.5

    if std == 0:
        return []

    deviation = abs(today_balance - mean)
    sigmas = deviation / std
    if sigmas > sigma_threshold:
        direction = "above" if today_balance > mean else "below"
        return [
            f"{account_key}: balance ${today_balance:,.2f} is {sigmas:.1f}\u03c3 {direction} "
            f"30-day mean (${mean:,.2f}, std ${std:,.2f})"
        ]
    return []


def send_pushover_alert(cfg: dict, title: str, message: str, priority: int = 0) -> bool:  # noqa: ARG001
    """Send a Pushover notification via urllib (stdlib — no new dependencies).

    Retrieves pushover-user-key and pushover-api-token from Bitwarden Secrets
    Manager using the same get_bws_secret() pattern as Plaid credentials.

    Returns True on HTTP 200, False on any error (logs but never raises).
    priority=1 for anomaly/large-drop alerts; priority=0 for informational.
    """
    import urllib.parse
    import urllib.request

    try:
        user_key = get_bws_secret("pushover-user-key")
        api_token = get_bws_secret("pushover-api-token")
    except SystemExit:
        log.warning("send_pushover_alert: Pushover secrets not found in Bitwarden — skipping")
        return False

    payload = urllib.parse.urlencode(
        {
            "token": api_token,
            "user": user_key,
            "title": title,
            "message": message,
            "priority": priority,
        }
    ).encode("utf-8")

    try:
        req = urllib.request.Request(
            "https://api.pushover.net/1/messages.json",
            data=payload,
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=15) as resp:  # noqa: S310
            if resp.status == 200:
                log.info(f"Pushover alert sent: {title!r}")
                return True
            log.warning(f"Pushover returned HTTP {resp.status}")
            return False
    except Exception as e:  # noqa: BLE001
        log.warning(f"send_pushover_alert: network error — {e}")
        return False


def cmd_account_monitoring(cfg: dict, conn: sqlite3.Connection) -> None:
    """--account-monitoring: Daily account health check.

    Must run AFTER --balances (reads daily_balances rows written by that pass).

    Workflow:
    1. Load monitoring thresholds from config.
    2. Compare today vs. yesterday balances per account.
    3. Check credit utilization for credit/loan accounts.
    4. Detect 30-day anomalies via detect_balance_anomalies().
    5. Compare total net worth today vs. yesterday.
    6. Check investment holdings for large position moves.
    7. Fire Pushover alert (priority=1) if any threshold breached.
    8. Post a monitoring summary capture unconditionally
       (or conditionally per post_daily_capture / post_capture_on_alert config).
    """
    log.info("=== Account Monitoring ===")

    mcfg = load_monitoring_config(cfg)
    today_str = date.today().isoformat()
    yesterday_str = (date.today() - timedelta(days=1)).isoformat()

    # ── 1. Fetch today's and yesterday's balances ────────────────────────────
    today_rows = conn.execute(
        "SELECT account_id, current_balance, available_balance, credit_limit "
        "FROM daily_balances WHERE date = ?",
        (today_str,),
    ).fetchall()

    if not today_rows:
        log.warning("No balance data for today — run --balances first. Skipping monitoring.")
        return

    yesterday_rows = conn.execute(
        "SELECT account_id, current_balance FROM daily_balances WHERE date = ?",
        (yesterday_str,),
    ).fetchall()
    yesterday_map: dict[str, float] = {r[0]: r[1] for r in yesterday_rows}

    # ── 2. Per-account checks ────────────────────────────────────────────────
    alerts: list[str] = []
    anomaly_flags: list[str] = []
    account_lines: list[str] = []

    # Retrieve account type info from config for credit utilization check
    accounts_cfg = cfg.get("accounts", {}) if cfg else {}

    # Build a type map keyed by account_key (may be sub-keyed e.g. amex_abc12345)
    account_type_map: dict[str, str] = {}
    for key, acfg in accounts_cfg.items():
        account_type_map[key] = acfg.get("type", "")

    for account_id, current, available, credit_limit in today_rows:
        # Determine account type — strip sub-key suffix (e.g. amex_abc12345 → amex)
        base_key = account_id.split("_")[0] if "_" in account_id else account_id
        acct_type = account_type_map.get(base_key, account_type_map.get(account_id, ""))

        # Day-over-day delta
        yesterday_balance = yesterday_map.get(account_id)
        if yesterday_balance is not None:
            delta_abs = current - yesterday_balance
            delta_pct = (delta_abs / yesterday_balance * 100) if yesterday_balance != 0 else 0.0

            change_str = f"{delta_abs:+,.2f} ({delta_pct:+.1f}%)"
            line = f"  {account_id}: ${current:,.2f} ({change_str} vs yesterday)"

            # Alert on significant drops (negative delta for non-credit, positive for credit)
            if acct_type in CREDIT_ACCOUNT_TYPES:
                # Credit: rising balance means more debt — use absolute/pct increase as drop
                if delta_abs > mcfg["balance_drop_abs"] or delta_pct > mcfg["balance_drop_pct"]:
                    alerts.append(
                        f"{account_id}: credit balance rose ${delta_abs:,.2f} ({delta_pct:.1f}%) — "
                        f"now ${current:,.2f}"
                    )
                    line += "  *** ALERT"
            else:
                # Depository/investment: falling balance is a drop
                if abs(delta_abs) > mcfg["balance_drop_abs"] and delta_abs < 0:
                    alerts.append(
                        f"{account_id}: balance dropped ${abs(delta_abs):,.2f} "
                        f"({abs(delta_pct):.1f}%) — now ${current:,.2f}"
                    )
                    line += "  *** ALERT"
                elif delta_pct < -mcfg["balance_drop_pct"]:
                    alerts.append(
                        f"{account_id}: balance dropped {abs(delta_pct):.1f}% — now ${current:,.2f}"
                    )
                    line += "  *** ALERT"
        else:
            # First run — no prior data
            line = f"  {account_id}: ${current:,.2f} (no prior data)"

        account_lines.append(line)

        # Credit utilization check
        if acct_type in CREDIT_ACCOUNT_TYPES and credit_limit and credit_limit > 0:
            utilization = (current / credit_limit) * 100
            if utilization > mcfg["credit_utilization_pct"]:
                alerts.append(
                    f"{account_id}: credit utilization {utilization:.1f}% "
                    f"(${current:,.2f} / ${credit_limit:,.2f} limit)"
                )

        # 30-day anomaly detection
        anomaly_hits = detect_balance_anomalies(conn, account_id, current, mcfg)
        anomaly_flags.extend(anomaly_hits)

    # ── 3. Net worth delta ───────────────────────────────────────────────────
    def _compute_net_worth(rows: list) -> float:
        nw = 0.0
        for r in rows:
            acct_id = r[0]
            bal = r[1]
            base_key = acct_id.split("_")[0] if "_" in acct_id else acct_id
            acct_type = account_type_map.get(base_key, account_type_map.get(acct_id, ""))
            if acct_type in CREDIT_ACCOUNT_TYPES:
                nw -= bal
            else:
                nw += bal
        return nw

    today_nw = _compute_net_worth(today_rows)
    yesterday_nw_rows = [
        (aid, bal, 0.0, 0.0) for aid, bal in yesterday_map.items()
    ] if yesterday_map else []
    yesterday_nw = _compute_net_worth(yesterday_nw_rows) if yesterday_nw_rows else None

    nw_line = f"Net Worth: ${today_nw:,.2f}"
    if yesterday_nw is not None:
        nw_delta = today_nw - yesterday_nw
        nw_delta_pct = (nw_delta / abs(yesterday_nw) * 100) if yesterday_nw != 0 else 0.0
        nw_line += f" ({nw_delta:+,.2f}, {nw_delta_pct:+.1f}% vs yesterday)"
        if yesterday_nw != 0 and abs(nw_delta_pct) > mcfg["net_worth_drop_pct"] and nw_delta < 0:
            alerts.append(
                f"Net worth dropped ${abs(nw_delta):,.2f} ({abs(nw_delta_pct):.1f}%) — "
                f"now ${today_nw:,.2f}"
            )

    # ── 4. Investment holdings check ─────────────────────────────────────────
    # Compare holdings for the two most recent distinct dates
    holdings_dates = conn.execute(
        "SELECT DISTINCT date FROM holdings ORDER BY date DESC LIMIT 2"
    ).fetchall()

    if len(holdings_dates) >= 2:
        latest_date = holdings_dates[0][0]
        prior_date = holdings_dates[1][0]

        latest_holdings = {
            r[0]: {"value": r[1], "name": r[2]}
            for r in conn.execute(
                "SELECT security_id, value, name FROM holdings WHERE date = ?",
                (latest_date,),
            ).fetchall()
        }
        prior_holdings = {
            r[0]: r[1]
            for r in conn.execute(
                "SELECT security_id, value FROM holdings WHERE date = ?",
                (prior_date,),
            ).fetchall()
        }

        latest_total = sum(h["value"] or 0 for h in latest_holdings.values())
        prior_total = sum(v or 0 for v in prior_holdings.values())

        # Per-position check
        for security_id, latest in latest_holdings.items():
            prior_value = prior_holdings.get(security_id)
            if prior_value and prior_value > 0:
                change_pct = ((latest["value"] or 0) - prior_value) / prior_value * 100
                if abs(change_pct) > mcfg["position_change_pct"]:
                    name = latest.get("name") or security_id
                    alerts.append(
                        f"Holding {name}: {change_pct:+.1f}% "
                        f"(${prior_value:,.2f} → ${latest['value']:,.2f})"
                    )

        # Portfolio total check
        if prior_total > 0:
            portfolio_change_pct = (latest_total - prior_total) / prior_total * 100
            if portfolio_change_pct < -mcfg["portfolio_drop_pct"]:
                alerts.append(
                    f"Portfolio dropped {abs(portfolio_change_pct):.1f}% "
                    f"(${prior_total:,.2f} → ${latest_total:,.2f})"
                )

    # ── 5. Build capture text ────────────────────────────────────────────────
    status = "ALERTS FIRED" if alerts or anomaly_flags else "OK"
    lines = [
        f"Financial Account Monitor -- {today_str}",
        "",
        f"STATUS: {status}",
        "",
        "Account Balances (vs. yesterday):",
    ]
    lines.extend(account_lines)
    lines.append("")
    lines.append(nw_line)

    if alerts:
        lines.append("")
        lines.append("Alerts:")
        for a in alerts:
            lines.append(f"  {a}")

    if anomaly_flags:
        lines.append("")
        lines.append("Anomaly Flags:")
        for a in anomaly_flags:
            lines.append(f"  {a}")

    capture_text = "\n".join(lines)

    # ── 6. Pushover alert ────────────────────────────────────────────────────
    if alerts or anomaly_flags:
        alert_summary = "\n".join(alerts + anomaly_flags)
        send_pushover_alert(
            cfg,
            title=f"Open Brain: Financial Alert — {today_str}",
            message=alert_summary[:1000],  # Pushover message limit ~1024
            priority=1,
        )

    # ── 7. Post capture ──────────────────────────────────────────────────────
    should_post = mcfg["post_daily_capture"] or (
        mcfg["post_capture_on_alert"] and (alerts or anomaly_flags)
    )
    if should_post:
        _post_capture(
            cfg,
            capture_text,
            {
                "type": "financial_monitoring",
                "date": today_str,
                "status": status,
                "alert_count": len(alerts),
                "anomaly_count": len(anomaly_flags),
                "net_worth": round(today_nw, 2),
            },
            capture_type="observation",
            brain_view="personal",
        )
        log.info(
            f"Account monitoring complete — status={status}, "
            f"alerts={len(alerts)}, anomalies={len(anomaly_flags)}"
        )
    else:
        log.info(
            f"Account monitoring complete — status={status}, no capture posted "
            f"(post_daily_capture=False, no alerts)"
        )


def cmd_balances(cfg: dict, conn: sqlite3.Connection):
    """--balances: Daily balance snapshot for all linked accounts.

    Calls Plaid /accounts/balance/get per account, stores in daily_balances,
    calculates net worth, and POSTs a balance capture to Open Brain.
    """
    log.info("=== Balance Snapshot ===")

    client = init_plaid(cfg)
    accounts_cfg = cfg.get("accounts", {})
    today = date.today().isoformat()

    # Collect balances across all accounts
    balance_rows = []  # list of (account_key, display_name, acct_type, current, available, limit)
    errors = []

    for account_key, account_cfg in accounts_cfg.items():
        access_token = get_access_token(cfg, account_key)
        if not access_token:
            log.warning(f"  {account_key}: no access token -- skipping")
            errors.append(account_key)
            continue

        try:
            plaid_accounts = fetch_account_balances(client, access_token)
        except Exception as e:
            error_str = str(e)
            if "ITEM_LOGIN_REQUIRED" in error_str:
                log.warning(f"  {account_key}: bank login required -- re-run Plaid Link")
                errors.append(f"{account_key}: ITEM_LOGIN_REQUIRED")
            else:
                log.error(f"  {account_key}: balance fetch error -- {e}")
                errors.append(f"{account_key}: {e}")
            continue

        if not plaid_accounts:
            log.warning(f"  {account_key}: no accounts returned from Plaid")
            errors.append(f"{account_key}: no accounts")
            continue

        # Plaid may return multiple sub-accounts per item. Sum them for this
        # logical account, but typically there's one primary account per item.
        for pa in plaid_accounts:
            balances = pa.get("balances", {})
            current = balances.get("current") or 0.0
            available = balances.get("available")  # may be None for credit
            limit = balances.get("limit")  # only for credit accounts
            acct_type = pa.get("type", account_cfg.get("type", ""))
            acct_subtype = pa.get("subtype", "")

            # Build a sub-key if multiple accounts under one item
            sub_key = account_key
            if len(plaid_accounts) > 1:
                sub_key = f"{account_key}_{pa.get('account_id', '')[:8]}"

            store_balances(
                conn,
                today,
                sub_key,
                current,
                available if available is not None else 0.0,
                limit if limit is not None else 0.0,
            )

            balance_rows.append(
                (
                    sub_key,
                    account_cfg["name"],
                    acct_type,
                    acct_subtype,
                    current,
                    available,
                    limit,
                )
            )
            log.info(
                f"  {account_cfg['name']}: current=${current:,.2f}"
                f"{f', available=${available:,.2f}' if available is not None else ''}"
                f"{f', limit=${limit:,.2f}' if limit is not None else ''}"
                f" ({acct_type}/{acct_subtype})"
            )

        time.sleep(0.1)  # rate limit courtesy

    conn.commit()

    if not balance_rows:
        log.warning("No balance data retrieved -- skipping capture")
        return

    # ── Calculate net worth ──────────────────────────────────────────────
    # Plaid returns positive values for credit card balances (amount owed).
    # For net worth: positive for depository/investment, negative for credit/loan.
    net_worth = 0.0
    for _, _, acct_type, _, current, _, _ in balance_rows:
        if acct_type in CREDIT_ACCOUNT_TYPES:
            net_worth -= current  # credit balance is debt: subtract
        else:
            net_worth += current  # depository/investment/other: add

    # ── Format capture text ──────────────────────────────────────────────
    lines = [f"Financial Snapshot -- {today}", ""]

    for (
        account_key,
        display_name,
        acct_type,
        acct_subtype,
        current,
        available,
        limit,
    ) in balance_rows:
        if acct_type in CREDIT_ACCOUNT_TYPES:
            # Show as negative for credit cards, with limit
            line = f"{display_name}: -${current:,.2f}"
            if limit is not None and limit > 0:
                line += f" (limit ${limit:,.2f})"
        else:
            line = f"{display_name}: ${current:,.2f}"
        lines.append(line)

    lines.append("")
    lines.append(f"Net Worth: ${net_worth:,.2f}")

    if errors:
        lines.append("")
        lines.append(f"Errors: {', '.join(str(e) for e in errors)}")

    capture_text = "\n".join(lines)
    log.info(f"Net worth: ${net_worth:,.2f}")

    # ── Build source_metadata ────────────────────────────────────────────
    accounts_meta = {}
    for (
        account_key,
        display_name,
        acct_type,
        acct_subtype,
        current,
        available,
        limit,
    ) in balance_rows:
        accounts_meta[account_key] = {
            "name": display_name,
            "type": acct_type,
            "subtype": acct_subtype,
            "current_balance": round(current, 2),
            "available_balance": round(available, 2) if available is not None else None,
            "credit_limit": round(limit, 2) if limit is not None and limit > 0 else None,
        }

    # ── POST capture to Open Brain ───────────────────────────────────────
    if _post_capture(
        cfg,
        capture_text,
        {
            "type": "balance_snapshot",
            "date": today,
            "net_worth": round(net_worth, 2),
            "account_count": len(balance_rows),
            "accounts": accounts_meta,
        },
        capture_type="observation",
        brain_view="personal",
    ):
        log.info(
            f"Balance snapshot posted ({len(balance_rows)} accounts, net worth ${net_worth:,.2f})"
        )


# ── Future stubs ─────────────────────────────────────────────────────────────


def cmd_investments(cfg: dict, conn: sqlite3.Connection):
    """--investments: Weekly investment report from Schwab via Plaid investments API.

    Retrieves current holdings, stores a snapshot in SQLite, calculates allocation
    by asset type and weekly change vs. 7-days-ago snapshot, and POSTs a summary
    capture to Open Brain.
    """
    from plaid.model.investments_holdings_get_request import InvestmentsHoldingsGetRequest

    log.info("=== Weekly Investment Report ===")

    client = init_plaid(cfg)
    accounts_cfg = cfg.get("accounts", {})
    today = date.today().isoformat()

    # Find investment/brokerage accounts
    investment_keys = [
        key for key, acfg in accounts_cfg.items() if acfg.get("type") in ("brokerage", "investment")
    ]
    if not investment_keys:
        log.warning("No brokerage/investment accounts configured — skipping")
        return

    all_holdings = []  # list of dicts for this snapshot

    for account_key in investment_keys:
        access_token = get_access_token(cfg, account_key)
        if not access_token:
            log.warning(f"  {account_key}: no access token — skipping")
            continue

        try:
            request = InvestmentsHoldingsGetRequest(access_token=access_token)
            response = client.investments_holdings_get(request)
        except Exception as e:
            error_str = str(e)
            if "ITEM_LOGIN_REQUIRED" in error_str:
                log.warning(f"  {account_key}: bank login required — re-run Plaid Link")
            else:
                log.error(f"  {account_key}: investments API error — {e}")
            continue

        # Build security lookup: security_id -> {name, ticker, type}
        sec_map = {}
        for sec in response.securities:
            sd = sec.to_dict()
            sec_map[sd["security_id"]] = {
                "name": sd.get("name") or "Unknown",
                "ticker": sd.get("ticker_symbol") or "",
                "type": sd.get("type") or "unknown",
            }

        for h in response.holdings:
            hd = h.to_dict()
            sec_id = hd.get("security_id", "")
            sec_info = sec_map.get(sec_id, {"name": "Unknown", "ticker": "", "type": "unknown"})
            quantity = hd.get("quantity", 0.0) or 0.0
            close_price = hd.get("institution_price", 0.0) or 0.0
            value = hd.get("institution_value") or (quantity * close_price)

            holding_row = {
                "date": today,
                "security_id": sec_id,
                "name": sec_info["name"],
                "ticker": sec_info["ticker"],
                "quantity": quantity,
                "close_price": close_price,
                "value": value,
                "type": sec_info["type"],
                "account_id": account_key,
            }
            all_holdings.append(holding_row)

        log.info(
            f"  {accounts_cfg[account_key]['name']}: {len(response.holdings)} positions retrieved"
        )
        time.sleep(0.1)  # rate limit courtesy

    if not all_holdings:
        log.warning("No holdings data retrieved — skipping capture")
        return

    # ── Store snapshot in SQLite ─────────────────────────────────────────
    # Delete any existing rows for today (idempotent re-runs)
    conn.execute("DELETE FROM holdings WHERE date = ?", (today,))
    for h in all_holdings:
        conn.execute(
            "INSERT INTO holdings (date, security_id, name, ticker, quantity, close_price, value, type, account_id) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                h["date"],
                h["security_id"],
                h["name"],
                h["ticker"],
                h["quantity"],
                h["close_price"],
                h["value"],
                h["type"],
                h["account_id"],
            ),
        )
    conn.commit()
    log.info(f"  Stored {len(all_holdings)} holdings for {today}")

    # ── Calculate portfolio metrics ──────────────────────────────────────
    total_value = sum(h["value"] for h in all_holdings)

    # Allocation by type
    type_totals = defaultdict(float)
    for h in all_holdings:
        # Normalize Plaid security types to readable buckets
        raw_type = (h["type"] or "unknown").lower()
        if raw_type in ("equity", "stock"):
            bucket = "Stocks"
        elif raw_type in ("fixed income", "bond"):
            bucket = "Bonds"
        elif raw_type in ("etf",):
            bucket = "ETFs"
        elif raw_type in ("cash", "money market", "cash equivalent"):
            bucket = "Cash"
        elif raw_type in ("mutual fund",):
            bucket = "Mutual Funds"
        else:
            bucket = raw_type.title()
        type_totals[bucket] += h["value"]

    allocation = {}
    for bucket, val in sorted(type_totals.items(), key=lambda x: x[1], reverse=True):
        pct = (val / total_value * 100) if total_value > 0 else 0
        allocation[bucket] = {"value": round(val, 2), "pct": round(pct, 1)}

    # ── Weekly change (compare to 7 days ago) ────────────────────────────
    week_ago = (date.today() - timedelta(days=7)).isoformat()

    # Find the closest prior snapshot (on or before 7 days ago)
    prior_row = conn.execute(
        "SELECT date, SUM(value) FROM holdings WHERE date <= ? GROUP BY date ORDER BY date DESC LIMIT 1",
        (week_ago,),
    ).fetchone()

    weekly_delta = None
    weekly_pct = None
    prior_date = None
    if prior_row and prior_row[1] is not None:
        prior_date = prior_row[0]
        prior_total = prior_row[1]
        weekly_delta = total_value - prior_total
        weekly_pct = ((weekly_delta / prior_total) * 100) if prior_total > 0 else 0

    # ── Top holdings by value ────────────────────────────────────────────
    sorted_holdings = sorted(all_holdings, key=lambda h: h["value"], reverse=True)
    top_holdings = sorted_holdings[:10]

    # ── Top movers (weekly change per security) ──────────────────────────
    movers = []
    if prior_date:
        prior_holdings = {}
        for row in conn.execute(
            "SELECT security_id, value FROM holdings WHERE date = ?", (prior_date,)
        ).fetchall():
            prior_holdings[row[0]] = row[1]

        for h in all_holdings:
            prev_val = prior_holdings.get(h["security_id"])
            if prev_val is not None and prev_val > 0:
                change = h["value"] - prev_val
                change_pct = (change / prev_val) * 100
                movers.append(
                    {
                        "name": h["name"],
                        "ticker": h["ticker"],
                        "change": change,
                        "change_pct": change_pct,
                    }
                )

        # Sort by absolute % change, take top 5 movers
        movers.sort(key=lambda m: abs(m["change_pct"]), reverse=True)
        movers = movers[:5]

    # ── Format capture text ──────────────────────────────────────────────
    lines = [f"Weekly Investment Summary -- {today}", ""]

    # Total + weekly change
    total_line = f"Total Portfolio: ${total_value:,.2f}"
    if weekly_delta is not None:
        sign = "+" if weekly_delta >= 0 else ""
        total_line += f" ({sign}${weekly_delta:,.2f} / {sign}{weekly_pct:.1f}% vs {prior_date})"
    else:
        total_line += " (no prior week snapshot for comparison)"
    lines.append(total_line)
    lines.append("")

    # Allocation
    lines.append("Allocation:")
    for bucket, data in sorted(allocation.items(), key=lambda x: x[1]["pct"], reverse=True):
        lines.append(f"  {bucket}: {data['pct']}% (${data['value']:,.2f})")
    lines.append("")

    # Top holdings
    lines.append("Top Holdings:")
    for h in top_holdings:
        ticker_str = f" ({h['ticker']})" if h["ticker"] else ""
        lines.append(
            f"  {h['name']}{ticker_str}: ${h['value']:,.2f} — {h['quantity']:.2f} shares @ ${h['close_price']:,.2f}"
        )
    lines.append("")

    # Top movers
    if movers:
        lines.append("Top Movers (week):")
        for m in movers:
            ticker_str = f" ({m['ticker']})" if m["ticker"] else ""
            sign = "+" if m["change"] >= 0 else ""
            lines.append(
                f"  {m['name']}{ticker_str}: {sign}${m['change']:,.2f} ({sign}{m['change_pct']:.1f}%)"
            )
    else:
        lines.append("Top Movers: (no prior week data for comparison)")

    capture_text = "\n".join(lines)
    log.info(
        f"Portfolio: ${total_value:,.2f}"
        + (
            f", weekly change: {'+' if weekly_delta >= 0 else ''}${weekly_delta:,.2f} ({weekly_pct:+.1f}%)"
            if weekly_delta is not None
            else ""
        )
    )

    # ── POST capture to Open Brain ───────────────────────────────────────
    source_meta = {
        "type": "investment_weekly",
        "date": today,
        "total_value": round(total_value, 2),
        "allocation": allocation,
        "holding_count": len(all_holdings),
    }
    if weekly_delta is not None:
        source_meta["change_value"] = round(weekly_delta, 2)
        source_meta["change_pct"] = round(weekly_pct, 2)
        source_meta["prior_snapshot_date"] = prior_date

    if _post_capture(
        cfg, capture_text, source_meta, capture_type="observation", brain_view="personal"
    ):
        log.info(f"Investment summary posted ({len(all_holdings)} holdings, ${total_value:,.2f})")


def _get_prior_month_range(year: int, month: int) -> tuple:
    """Return (start_date, end_date) ISO strings for the month before year/month."""
    if month == 1:
        py, pm = year - 1, 12
    else:
        py, pm = year, month - 1
    start = f"{py}-{pm:02d}-01"
    end_d = date(py, 12, 31) if pm == 12 else date(py, pm + 1, 1) - timedelta(days=1)
    return start, end_d.isoformat()


def cmd_monthly_report(cfg: dict, conn: sqlite3.Connection):
    """--monthly-report: Monthly financial synthesis via T2 Claude CLI.

    Aggregates all transactions for the PRIOR month, compares MoM and YoY,
    builds a structured prompt for ``claude --print``, and POSTs a comprehensive
    monthly financial report capture to Open Brain.

    Designed to run on the 1st of each month via cron: 0 8 1 * *
    """
    log.info("=== Monthly Financial Report ===")

    today = date.today()
    # Target the PRIOR month (run on April 1 -> report March)
    first_of_current = today.replace(day=1)
    last_of_prior = first_of_current - timedelta(days=1)
    target_year = last_of_prior.year
    target_month = last_of_prior.month
    month_start = f"{target_year}-{target_month:02d}-01"
    month_end = last_of_prior.isoformat()
    month_label = last_of_prior.strftime("%B %Y")

    log.info(f"Reporting period: {month_start} to {month_end} ({month_label})")

    # ── 1. Query all transactions in target month ───────────────────────
    rows = conn.execute(
        "SELECT t.account_id, a.name, t.amount, t.merchant, t.ob_category, t.date "
        "FROM transactions t LEFT JOIN accounts a ON t.account_id = a.id "
        "WHERE t.date >= ? AND t.date <= ? AND t.pending = 0 "
        "ORDER BY t.date, t.account_id",
        (month_start, month_end),
    ).fetchall()

    if not rows:
        log.info(f"No transactions for {month_label} -- skipping monthly report")
        return

    log.info(f"Found {len(rows)} transactions for {month_label}")

    # ── 2. Aggregate ────────────────────────────────────────────────────

    # 2a. Total spend by category
    cat_totals = defaultdict(lambda: {"amount": 0.0, "count": 0})
    for _, _, amount, _, ob_category, _ in rows:
        cat_totals[ob_category]["amount"] += amount
        cat_totals[ob_category]["count"] += 1
    cat_sorted = sorted(cat_totals.items(), key=lambda x: abs(x[1]["amount"]), reverse=True)

    # 2b. Top 10 merchants by total spend
    merchant_totals = defaultdict(lambda: {"amount": 0.0, "count": 0})
    for _, _, amount, merchant, _, _ in rows:
        merchant_totals[merchant]["amount"] += amount
        merchant_totals[merchant]["count"] += 1
    top_merchants = sorted(
        merchant_totals.items(), key=lambda x: abs(x[1]["amount"]), reverse=True
    )[:10]

    # 2c. Transaction count by account
    account_stats = defaultdict(lambda: {"name": "", "count": 0, "total": 0.0})
    for account_id, account_name, amount, _, _, _ in rows:
        account_stats[account_id]["name"] = account_name or account_id
        account_stats[account_id]["count"] += 1
        account_stats[account_id]["total"] += amount

    # 2d. Average transaction size
    total_spend = sum(abs(r[2]) for r in rows)
    avg_txn = total_spend / len(rows) if rows else 0.0

    # 2e. New merchants (first appearance this month vs all prior months)
    current_merchants = set(r[3] for r in rows if r[3])
    prior_merchants_rows = conn.execute(
        "SELECT DISTINCT merchant FROM transactions WHERE date < ? AND merchant IS NOT NULL",
        (month_start,),
    ).fetchall()
    prior_merchants = set(r[0] for r in prior_merchants_rows)
    new_merchants = sorted(current_merchants - prior_merchants)

    # 2f. Large transactions (>$200)
    large_txns = [
        {"date": r[5], "merchant": r[3], "amount": r[2], "category": r[4], "account": r[1] or r[0]}
        for r in rows
        if abs(r[2]) > 200
    ]
    large_txns.sort(key=lambda x: abs(x["amount"]), reverse=True)

    # 2g. Subscription changes (compare recurring merchants to prior month)
    prior_month_start, prior_month_end = _get_prior_month_range(target_year, target_month)
    prior_month_merchants = set(
        r[0]
        for r in conn.execute(
            "SELECT DISTINCT merchant FROM transactions "
            "WHERE date >= ? AND date <= ? AND merchant IS NOT NULL AND pending = 0",
            (prior_month_start, prior_month_end),
        ).fetchall()
    )
    new_subs = sorted(current_merchants - prior_month_merchants) if prior_month_merchants else []
    cancelled_subs = (
        sorted(prior_month_merchants - current_merchants) if prior_month_merchants else []
    )

    # ── 3. MoM comparison ───────────────────────────────────────────────
    prior_rows = conn.execute(
        "SELECT ob_category, SUM(amount) FROM transactions "
        "WHERE date >= ? AND date <= ? AND pending = 0 "
        "GROUP BY ob_category",
        (prior_month_start, prior_month_end),
    ).fetchall()
    prior_cat = {r[0]: r[1] for r in prior_rows}
    has_prior_month = len(prior_rows) > 0
    prior_month_label = datetime(
        target_year if target_month > 1 else target_year - 1,
        target_month - 1 if target_month > 1 else 12,
        1,
    ).strftime("%B %Y")

    mom_comparison = []
    if has_prior_month:
        all_cats = set(dict(cat_sorted).keys()) | set(prior_cat.keys())
        for cat in sorted(all_cats):
            curr = cat_totals[cat]["amount"] if cat in cat_totals else 0.0
            prev = prior_cat.get(cat, 0.0)
            delta = curr - prev
            pct = (delta / abs(prev) * 100) if prev != 0 else 0.0
            mom_comparison.append(
                {
                    "category": cat,
                    "current": round(curr, 2),
                    "prior": round(prev, 2),
                    "delta": round(delta, 2),
                    "pct_change": round(pct, 1),
                }
            )

    # ── 4. YoY comparison ──────────────────────────────────────────────
    yoy_year = target_year - 1
    yoy_start = f"{yoy_year}-{target_month:02d}-01"
    if target_month == 12:
        yoy_end_date = date(yoy_year, 12, 31)
    else:
        yoy_end_date = date(yoy_year, target_month + 1, 1) - timedelta(days=1)
    yoy_end = yoy_end_date.isoformat()

    yoy_rows = conn.execute(
        "SELECT ob_category, SUM(amount) FROM transactions "
        "WHERE date >= ? AND date <= ? AND pending = 0 "
        "GROUP BY ob_category",
        (yoy_start, yoy_end),
    ).fetchall()
    yoy_cat = {r[0]: r[1] for r in yoy_rows}
    has_yoy = len(yoy_rows) > 0

    yoy_comparison = []
    if has_yoy:
        all_cats = set(dict(cat_sorted).keys()) | set(yoy_cat.keys())
        for cat in sorted(all_cats):
            curr = cat_totals[cat]["amount"] if cat in cat_totals else 0.0
            prev_y = yoy_cat.get(cat, 0.0)
            delta = curr - prev_y
            pct = (delta / abs(prev_y) * 100) if prev_y != 0 else 0.0
            yoy_comparison.append(
                {
                    "category": cat,
                    "current": round(curr, 2),
                    "prior_year": round(prev_y, 2),
                    "delta": round(delta, 2),
                    "pct_change": round(pct, 1),
                }
            )

    # ── 5. End-of-month net worth from daily_balances ──────────────────
    net_worth_row = conn.execute(
        "SELECT SUM(CASE WHEN a.type IN ('credit', 'loan') THEN -db.current_balance "
        "ELSE db.current_balance END) "
        "FROM daily_balances db LEFT JOIN accounts a ON db.account_id = a.id "
        "WHERE db.date = (SELECT MAX(date) FROM daily_balances WHERE date <= ?)",
        (month_end,),
    ).fetchone()
    net_worth_eom = (
        round(net_worth_row[0], 2) if net_worth_row and net_worth_row[0] is not None else None
    )

    # ── 6. Build raw data tables for the capture ────────────────────────
    raw_lines = ["--- Raw Data ---", ""]
    raw_lines.append(f"Period: {month_start} to {month_end}")
    raw_lines.append(f"Transactions: {len(rows)}")
    raw_lines.append(f"Total spend: ${total_spend:,.2f}")
    raw_lines.append(f"Average transaction: ${avg_txn:,.2f}")
    if net_worth_eom is not None:
        raw_lines.append(f"End-of-month net worth: ${net_worth_eom:,.2f}")
    raw_lines.append("")

    raw_lines.append("SPEND BY CATEGORY:")
    for cat, data in cat_sorted:
        raw_lines.append(f"  {cat}: ${abs(data['amount']):,.2f} ({data['count']} txns)")

    raw_lines.append("")
    raw_lines.append("TOP 10 MERCHANTS:")
    for merchant, data in top_merchants:
        raw_lines.append(f"  {merchant}: ${abs(data['amount']):,.2f} ({data['count']} txns)")

    raw_lines.append("")
    raw_lines.append("BY ACCOUNT:")
    for _acct_id, data in sorted(account_stats.items()):
        raw_lines.append(f"  {data['name']}: {data['count']} txns, ${abs(data['total']):,.2f}")

    if large_txns:
        raw_lines.append("")
        raw_lines.append("LARGE TRANSACTIONS (>$200):")
        for lt in large_txns:
            raw_lines.append(
                f"  {lt['date']} | {lt['merchant']} | ${abs(lt['amount']):,.2f} | {lt['category']} | {lt['account']}"
            )

    if new_merchants:
        raw_lines.append("")
        raw_lines.append(f"NEW MERCHANTS ({len(new_merchants)}):")
        for nm in new_merchants[:20]:
            amt = abs(merchant_totals[nm]["amount"])
            raw_lines.append(f"  {nm}: ${amt:,.2f}")

    if new_subs or cancelled_subs:
        raw_lines.append("")
        raw_lines.append("SUBSCRIPTION CHANGES:")
        if new_subs:
            raw_lines.append(f"  New: {', '.join(new_subs[:15])}")
        if cancelled_subs:
            raw_lines.append(f"  Gone: {', '.join(cancelled_subs[:15])}")

    if mom_comparison:
        raw_lines.append("")
        raw_lines.append(f"MONTH-OVER-MONTH ({prior_month_label} -> {month_label}):")
        for m in mom_comparison:
            direction = "+" if m["delta"] >= 0 else ""
            raw_lines.append(
                f"  {m['category']}: ${abs(m['current']):,.2f} ({direction}{m['pct_change']}%)"
            )

    if yoy_comparison:
        raw_lines.append("")
        raw_lines.append(
            f"YEAR-OVER-YEAR ({last_of_prior.strftime('%b')} {yoy_year} -> {month_label}):"
        )
        for y in yoy_comparison:
            direction = "+" if y["delta"] >= 0 else ""
            raw_lines.append(
                f"  {y['category']}: ${abs(y['current']):,.2f} ({direction}{y['pct_change']}%)"
            )

    raw_data_text = "\n".join(raw_lines)

    # ── 7. Build Claude CLI prompt (keep under 4000 chars) ─────────────
    pp = []
    pp.append(f"Analyze this monthly financial report for {month_label}.")
    pp.append(
        f"Total: ${total_spend:,.2f} across {len(rows)} transactions, avg ${avg_txn:,.2f}/txn."
    )
    if net_worth_eom is not None:
        pp.append(f"End-of-month net worth: ${net_worth_eom:,.2f}.")
    pp.append("")

    pp.append("SPENDING BY CATEGORY:")
    for cat, data in cat_sorted[:15]:
        pp.append(f"  {cat}: ${abs(data['amount']):,.2f} ({data['count']} txns)")

    pp.append("")
    pp.append("TOP MERCHANTS:")
    for merchant, data in top_merchants:
        pp.append(f"  {merchant}: ${abs(data['amount']):,.2f}")

    if large_txns:
        pp.append("")
        pp.append("LARGE TRANSACTIONS (>$200):")
        for lt in large_txns[:10]:
            pp.append(
                f"  {lt['date']} {lt['merchant']}: ${abs(lt['amount']):,.2f} ({lt['category']})"
            )

    if new_merchants:
        pp.append("")
        pp.append(f"NEW MERCHANTS THIS MONTH: {', '.join(new_merchants[:10])}")

    if new_subs or cancelled_subs:
        pp.append("")
        if new_subs:
            pp.append(f"NEW RECURRING: {', '.join(new_subs[:10])}")
        if cancelled_subs:
            pp.append(f"STOPPED RECURRING: {', '.join(cancelled_subs[:10])}")

    if mom_comparison:
        pp.append("")
        pp.append(f"MOM CHANGES (vs {prior_month_label}):")
        significant = sorted(
            [m for m in mom_comparison if abs(m["delta"]) > 10],
            key=lambda x: abs(x["delta"]),
            reverse=True,
        )
        for m in significant[:10]:
            d = "+" if m["delta"] >= 0 else ""
            pp.append(f"  {m['category']}: {d}${abs(m['delta']):,.2f} ({d}{m['pct_change']}%)")

    if yoy_comparison:
        pp.append("")
        pp.append(f"YOY CHANGES (vs {last_of_prior.strftime('%b')} {yoy_year}):")
        significant_y = sorted(
            [y for y in yoy_comparison if abs(y["delta"]) > 20],
            key=lambda x: abs(x["delta"]),
            reverse=True,
        )
        for y in significant_y[:8]:
            d = "+" if y["delta"] >= 0 else ""
            pp.append(f"  {y['category']}: {d}${abs(y['delta']):,.2f} ({d}{y['pct_change']}%)")

    pp.append("")
    pp.append(
        "Provide: (1) spending pattern analysis, (2) unusual or noteworthy items, "
        "(3) trends vs prior periods, (4) actionable insights or recommendations. "
        "Be specific and reference actual numbers. Keep response under 800 words."
    )

    prompt = "\n".join(pp)
    if len(prompt) > 4000:
        prompt = prompt[:3950] + "\n\n[Data truncated for length. Analyze what is shown above.]"

    log.info(f"Claude CLI prompt: {len(prompt)} chars")

    # ── 8. Call claude --print for T2 synthesis ─────────────────────────
    synthesis = None
    try:
        result = subprocess.run(
            ["claude", "--print", "-p", prompt],
            capture_output=True,
            text=True,
            timeout=120,
        )
        if result.returncode == 0 and result.stdout.strip():
            synthesis = result.stdout.strip()
            log.info(f"Claude synthesis received ({len(synthesis)} chars)")
        else:
            log.warning(f"Claude CLI returned code {result.returncode}: {result.stderr[:200]}")
    except subprocess.TimeoutExpired:
        log.warning("Claude CLI timed out (120s) -- posting raw data without synthesis")
    except FileNotFoundError:
        log.warning("Claude CLI not found -- posting raw data without synthesis")
    except Exception as e:
        log.warning(f"Claude CLI error: {e} -- posting raw data without synthesis")

    # ── 9. Build and POST capture ───────────────────────────────────────
    capture_parts = [f"Monthly Financial Report -- {month_label}", ""]
    if synthesis:
        capture_parts.append(synthesis)
        capture_parts.append("")
    capture_parts.append(raw_data_text)
    capture_text = "\n".join(capture_parts)

    category_totals_meta = {
        cat: {"amount": round(data["amount"], 2), "count": data["count"]}
        for cat, data in cat_sorted
    }

    source_metadata = {
        "type": "financial_monthly",
        "month": f"{target_year}-{target_month:02d}",
        "month_label": month_label,
        "total_spend": round(total_spend, 2),
        "transaction_count": len(rows),
        "avg_transaction": round(avg_txn, 2),
        "category_totals": category_totals_meta,
        "top_merchants": {
            m: {"amount": round(d["amount"], 2), "count": d["count"]} for m, d in top_merchants
        },
        "new_merchant_count": len(new_merchants),
        "large_txn_count": len(large_txns),
        "has_synthesis": synthesis is not None,
    }
    if net_worth_eom is not None:
        source_metadata["net_worth_eom"] = net_worth_eom
    if has_prior_month:
        source_metadata["mom_prior_total"] = round(sum(abs(v) for v in prior_cat.values()), 2)
    if has_yoy:
        source_metadata["yoy_prior_total"] = round(sum(abs(v) for v in yoy_cat.values()), 2)

    if _post_capture(
        cfg, capture_text, source_metadata, capture_type="observation", brain_view="personal"
    ):
        log.info(f"Monthly report posted: {month_label} ({len(rows)} txns, ${total_spend:,.2f})")


INBOX_DIR = Path(os.environ.get("FINANCIAL_INBOX_DIR", str(Path.home() / "financial-inbox")))
PROCESSED_DIR = INBOX_DIR / "processed"


def _parse_401k_pdf(filepath: Path) -> dict | None:
    """Extract balance, contributions, and fund allocation from a 401k ReadySave PDF.

    Returns dict with keys: balance, ytd_employee, ytd_match, funds (list of dicts),
    quarter, year, raw_text. Returns None if parsing fails.
    """
    try:
        import fitz  # PyMuPDF
    except ImportError:
        log.error("PyMuPDF (fitz) not installed — run: pip install PyMuPDF")
        return None

    try:
        doc = fitz.open(str(filepath))
        text = "\n".join(page.get_text() for page in doc)
        doc.close()
    except Exception as e:
        log.error(f"Failed to read PDF {filepath.name}: {e}")
        return None

    if not text.strip():
        log.error(f"PDF {filepath.name} has no extractable text")
        return None

    # Dollar amount pattern: $1,234.56 or $1234.56
    dollar_re = r"\$[\d,]+\.?\d*"

    # Extract total balance — look for common headings
    balance = None
    for pat in [
        r"(?:total\s*(?:account\s*)?(?:balance|value))\s*[:\s]*(" + dollar_re + r")",
        r"(?:account\s*(?:total|balance|value))\s*[:\s]*(" + dollar_re + r")",
        r"(?:ending\s*(?:balance|value))\s*[:\s]*(" + dollar_re + r")",
        r"(?:vested\s*balance)\s*[:\s]*(" + dollar_re + r")",
    ]:
        m = re.search(pat, text, re.IGNORECASE)
        if m:
            balance = m.group(1).replace(",", "").replace("$", "")
            balance = float(balance)
            break

    # Extract YTD contributions
    ytd_employee = None
    ytd_match = None
    for pat in [
        r"(?:employee|your)\s*(?:contributions?|deferrals?)\s*[:\s]*(" + dollar_re + r")",
        r"(?:pre[- ]?tax|401k)\s*(?:contributions?)\s*[:\s]*(" + dollar_re + r")",
    ]:
        m = re.search(pat, text, re.IGNORECASE)
        if m and ytd_employee is None:
            ytd_employee = float(m.group(1).replace(",", "").replace("$", ""))
    for pat in [
        r"(?:employer|company)\s*(?:match|contributions?)\s*[:\s]*(" + dollar_re + r")",
        r"(?:matching)\s*(?:contributions?)\s*[:\s]*(" + dollar_re + r")",
    ]:
        m = re.search(pat, text, re.IGNORECASE)
        if m and ytd_match is None:
            ytd_match = float(m.group(1).replace(",", "").replace("$", ""))

    # Extract fund allocation: lines with a percentage and a dollar amount
    funds = []
    # Pattern: fund name ... XX.XX% ... $X,XXX.XX
    fund_pat = re.compile(
        r"([A-Za-z][A-Za-z0-9 &/\-]{5,50}?)\s+"
        r"(\d{1,3}(?:\.\d{1,2})?)\s*%\s+.*?" + r"(" + dollar_re + r")",
        re.MULTILINE,
    )
    for m in fund_pat.finditer(text):
        name = m.group(1).strip()
        pct = float(m.group(2))
        val = float(m.group(3).replace(",", "").replace("$", ""))
        if pct > 0 and val > 0:
            funds.append({"name": name, "pct": pct, "value": val})

    # Determine quarter/year from text or file mod time
    today = date.today()
    year = today.year
    quarter = (today.month - 1) // 3 + 1
    # Try to find a date in the PDF
    date_m = re.search(
        r"(?:as of|through|ending)\s*(\d{1,2})[/\-](\d{1,2})[/\-](\d{2,4})", text, re.IGNORECASE
    )
    if date_m:
        try:
            y = int(date_m.group(3))
            if y < 100:
                y += 2000
            month = int(date_m.group(1))
            year = y
            quarter = (month - 1) // 3 + 1
        except ValueError:
            pass

    if balance is None:
        log.warning(f"Could not extract balance from {filepath.name} — check PDF format")

    return {
        "balance": balance,
        "ytd_employee": ytd_employee,
        "ytd_match": ytd_match,
        "funds": funds,
        "quarter": quarter,
        "year": year,
        "raw_text": text[:2000],
    }


# ── Bank / credit-card CSV parsers (G-C.1) ──────────────────────────────────
#
# All five parsers return the same result shape so downstream aggregation +
# capture formatting is uniform:
#
#   {
#     "source": "amex" | "chase" | "truist" | "schwab" | "hsa",
#     "account_id": str,                               # last-4 or mask from filename/header
#     "date_range": {"start": "YYYY-MM-DD", "end": "YYYY-MM-DD"},
#     "total_debit": float,                            # money OUT (spend)
#     "total_credit": float,                           # money IN (payments, refunds, deposits)
#     "net": float,                                    # credit − debit
#     "transaction_count": int,
#     "by_category": {name: {"count": int, "amount": float}, ...},
#     "top_transactions": [{"date", "description", "amount", "category"}, ...],
#     "source_file": str,
#   }
#
# `amount` in by_category and top_transactions is always the absolute spend
# value so sorting is meaningful regardless of sign convention. Sign handling
# is per-institution and lives inside each parser.


def _read_csv_robust(filepath: Path, skip_lines: int = 0) -> list[dict] | None:
    """Read a CSV with encoding + dialect sniffing. Returns list of dicts or None."""
    for enc in ("utf-8-sig", "utf-8", "latin-1", "cp1252"):
        try:
            with open(filepath, encoding=enc, newline="") as f:
                for _ in range(skip_lines):
                    f.readline()
                sample = f.read(4096)
                f.seek(0)
                for _ in range(skip_lines):
                    f.readline()
                try:
                    dialect = csv.Sniffer().sniff(sample, delimiters=",\t;|")
                except csv.Error:
                    dialect = csv.excel
                reader = csv.DictReader(f, dialect=dialect)
                rows = list(reader)
            if rows:
                return rows
        except (UnicodeDecodeError, csv.Error):
            continue
        except Exception as e:
            log.error(f"Failed to read CSV {filepath.name}: {e}")
            return None
    return None


def _parse_money(s: str) -> float:
    """Parse a monetary string. Handles $, commas, and parentheses-for-negative.

    Examples:
      "$1,234.56"     -> 1234.56
      "-$1,234.56"    -> -1234.56
      "($137.00)"     -> -137.00
      "25.07"         -> 25.07
      ""              -> 0.0
    """
    if not s:
        return 0.0
    s = s.strip()
    if not s:
        return 0.0
    is_paren_neg = s.startswith("(") and s.endswith(")")
    if is_paren_neg:
        s = s[1:-1]
    clean = re.sub(r"[^\d.\-]", "", s)
    if not clean or clean in ("-", ".", "-."):
        return 0.0
    try:
        val = float(clean)
    except ValueError:
        return 0.0
    return -val if is_paren_neg else val


def _parse_mdy(s: str) -> str | None:
    """Parse MM/DD/YYYY or MM/DD/YYYY-prefixed date strings. Returns ISO YYYY-MM-DD or None.

    Handles Schwab's "04/16/2026 as of 04/15/2026" form by taking the first date.
    """
    if not s:
        return None
    m = re.match(r"(\d{1,2})/(\d{1,2})/(\d{4})", s.strip())
    if not m:
        return None
    mm, dd, yyyy = m.groups()
    try:
        return f"{yyyy}-{int(mm):02d}-{int(dd):02d}"
    except ValueError:
        return None


def _summarize_transactions(
    source: str,
    account_id: str,
    txns: list[dict],
    source_file: str,
    top_n: int = 10,
) -> dict:
    """Given a list of normalized txn dicts, compute aggregates.

    Each txn must have: date (ISO), description, amount (signed float — negative=debit),
    category (str).
    """
    total_debit = 0.0
    total_credit = 0.0
    # by_category tracks BOTH sides so investment-account Sells/Dividends don't
    # drop out of the breakdown. Spending-focused callers sort by debit; net
    # callers sort by (credit − debit).
    by_category: dict = defaultdict(lambda: {"count": 0, "debit": 0.0, "credit": 0.0})
    dates = []
    for t in txns:
        amt = t["amount"]
        cat = t["category"]
        by_category[cat]["count"] += 1
        if amt < 0:
            total_debit += -amt
            by_category[cat]["debit"] += -amt
        elif amt > 0:
            total_credit += amt
            by_category[cat]["credit"] += amt
        if t.get("date"):
            dates.append(t["date"])

    # Top debit transactions only (spend-focused)
    debits = [t for t in txns if t["amount"] < 0]
    debits.sort(key=lambda t: t["amount"])  # most negative first
    top = [
        {
            "date": t["date"],
            "description": (t["description"] or "")[:120],
            "amount": round(-t["amount"], 2),
            "category": t["category"],
        }
        for t in debits[:top_n]
    ]

    return {
        "source": source,
        "account_id": account_id,
        "date_range": {
            "start": min(dates) if dates else None,
            "end": max(dates) if dates else None,
        },
        "total_debit": round(total_debit, 2),
        "total_credit": round(total_credit, 2),
        "net": round(total_credit - total_debit, 2),
        "transaction_count": len(txns),
        "by_category": {
            k: {
                "count": v["count"],
                "debit": round(v["debit"], 2),
                "credit": round(v["credit"], 2),
            }
            for k, v in by_category.items()
        },
        "top_transactions": top,
        "source_file": source_file,
    }


def _parse_amex_csv(filepath: Path) -> dict | None:
    """Parse American Express activity CSV.

    Sign convention: Amex `Amount` is POSITIVE for charges, NEGATIVE for refunds
    and payments. We invert to internal convention (negative = outflow).

    Header: Date,Description,Card Member,Account #,Amount,Extended Details,
            Appears On Your Statement As,Address,City/State,Zip Code,Country,
            Reference,Category
    """
    rows = _read_csv_robust(filepath)
    if not rows:
        log.error(f"Amex CSV {filepath.name} has no parseable rows")
        return None

    txns = []
    account_mask = ""
    for row in rows:
        date = _parse_mdy(row.get("Date", ""))
        desc = (row.get("Description") or "").strip()
        category = (row.get("Category") or "Uncategorized").strip() or "Uncategorized"
        raw_amt = _parse_money(row.get("Amount", ""))
        account_mask = account_mask or (row.get("Account #") or "").strip()
        if not date or not desc:
            continue
        # Amex sign inversion: positive = charge (debit), negative = credit
        txns.append(
            {
                "date": date,
                "description": desc,
                "amount": -raw_amt,
                "category": category,
            }
        )

    if not txns:
        return None

    return _summarize_transactions(
        source="amex",
        account_id=account_mask or "unknown",
        txns=txns,
        source_file=filepath.name,
    )


def _parse_chase_csv(filepath: Path) -> dict | None:
    """Parse Chase credit-card activity CSV.

    Sign convention: Chase `Amount` is NEGATIVE for charges, POSITIVE for
    payments and refunds. Use as-is.

    Header: Transaction Date,Post Date,Description,Category,Type,Amount,Memo
    Account: derived from the filename (e.g., Chase2726_...).
    """
    rows = _read_csv_robust(filepath)
    if not rows:
        return None

    m = re.match(r"chase(\d+)_", filepath.name, re.IGNORECASE)
    account_mask = m.group(1) if m else "unknown"

    txns = []
    for row in rows:
        date = _parse_mdy(row.get("Transaction Date") or row.get("Post Date", ""))
        desc = (row.get("Description") or "").strip()
        category = (row.get("Category") or "Uncategorized").strip() or "Uncategorized"
        amount = _parse_money(row.get("Amount", ""))
        if not date or not desc:
            continue
        txns.append(
            {
                "date": date,
                "description": desc,
                "amount": amount,
                "category": category,
            }
        )

    if not txns:
        return None

    return _summarize_transactions(
        source="chase",
        account_id=account_mask,
        txns=txns,
        source_file=filepath.name,
    )


def _parse_truist_csv(filepath: Path) -> dict | None:
    """Parse Truist checking/savings activity CSV.

    Sign convention: Truist `Amount` uses ($x) notation for negative.
    Already handled by `_parse_money`. Negative = outflow.

    Header: Posted Date,Transaction Date,Transaction Type,Check/Serial #,
            Full description,Merchant name,Category name,Sub-category name,
            Amount,Daily Posted Balance
    Account: from filename (e.g., acct_9675_...).
    """
    rows = _read_csv_robust(filepath)
    if not rows:
        return None

    m = re.match(r"acct_(\d+)_", filepath.name, re.IGNORECASE)
    account_mask = m.group(1) if m else "unknown"

    txns = []
    for row in rows:
        date = _parse_mdy(row.get("Posted Date") or row.get("Transaction Date", ""))
        desc = (row.get("Full description") or row.get("Merchant name") or "").strip()
        category = (row.get("Category name") or "Uncategorized").strip() or "Uncategorized"
        amount = _parse_money(row.get("Amount", ""))
        if not date or not desc:
            continue
        txns.append(
            {
                "date": date,
                "description": desc,
                "amount": amount,
                "category": category,
            }
        )

    if not txns:
        return None

    return _summarize_transactions(
        source="truist",
        account_id=account_mask,
        txns=txns,
        source_file=filepath.name,
    )


def _parse_schwab_csv(filepath: Path) -> dict | None:
    """Parse Schwab brokerage transactions CSV (Contributory IRA, Simple IRA, etc.).

    Sign convention: Schwab `Amount` is signed — negative for Buys/outflows,
    positive for Sells/dividends/interest/deposits.

    Header: Date,Action,Symbol,Description,Quantity,Price,Fees & Comm,Amount
    Account: parsed from filename (e.g., Contributory_XXX252_Transactions_...).

    `Action` is treated as the category (e.g., "Buy", "Sell", "Bank Interest",
    "MoneyLink Transfer") — this is Schwab's own classification and is more
    useful than the ticker symbol for category-level aggregation.
    """
    rows = _read_csv_robust(filepath)
    if not rows:
        return None

    m = re.match(r"(.+?)_XXX(\d+)_Transactions", filepath.name, re.IGNORECASE)
    if m:
        account_type = m.group(1)
        account_mask = f"{account_type}-{m.group(2)}"
    else:
        account_mask = filepath.stem

    txns = []
    for row in rows:
        date = _parse_mdy(row.get("Date", ""))
        action = (row.get("Action") or "Uncategorized").strip() or "Uncategorized"
        symbol = (row.get("Symbol") or "").strip()
        desc_raw = (row.get("Description") or "").strip()
        desc = f"{action} {symbol} {desc_raw}".strip() if symbol else f"{action} {desc_raw}".strip()
        amount = _parse_money(row.get("Amount", ""))
        if not date:
            continue
        txns.append(
            {
                "date": date,
                "description": desc,
                "amount": amount,
                "category": action,
            }
        )

    if not txns:
        return None

    return _summarize_transactions(
        source="schwab",
        account_id=account_mask,
        txns=txns,
        source_file=filepath.name,
    )


def _parse_hsa_csv(filepath: Path) -> dict | None:
    """Parse HSA transactions CSV.

    Sign convention: `Amount` is already signed — negative for withdrawals,
    positive for deposits.

    Header: Transaction Status,Effective Date,Posting Date,Payment Date,Type,
            Description,Amount,Running Balance,Check Number,Claim Payment Method,
            Claim Number
    `Type` ("Deposit" / "Withdrawal") is used as the category.
    """
    rows = _read_csv_robust(filepath)
    if not rows:
        return None

    txns = []
    for row in rows:
        # Only include posted (not pending) transactions
        status = (row.get("Transaction Status") or "").strip().lower()
        if status and status != "posted":
            continue
        date = _parse_mdy(row.get("Effective Date") or row.get("Posting Date", ""))
        desc = (row.get("Description") or "").strip()
        category = (row.get("Type") or "Uncategorized").strip() or "Uncategorized"
        amount = _parse_money(row.get("Amount", ""))
        if not date or not desc:
            continue
        txns.append(
            {
                "date": date,
                "description": desc,
                "amount": amount,
                "category": category,
            }
        )

    if not txns:
        return None

    return _summarize_transactions(
        source="hsa",
        account_id="hsa",
        txns=txns,
        source_file=filepath.name,
    )


def _parse_paypal_csv(filepath: Path) -> dict | None:
    """Parse PayPal 'Activity Download' CSV.

    PayPal uses a double-entry model where most user-initiated spend creates
    TWO rows: the Debit (e.g., "PreApproved Payment Bill User Payment") and a
    matching funding-side Credit ("General Card Deposit" or "Bank Deposit to
    PP Account"). The sum of Debits + Credits is often zero because PP is a
    pass-through. Reporting those funding counterparts as "income" would be
    misleading, so we exclude them from `total_credit` while keeping actual
    refunds and external transfers.

    - `Balance Impact == "Memo"` rows (holds, dual-sided Withdrawals): dropped.
    - `Balance Impact == "Debit"`: counted as spending.
    - `Balance Impact == "Credit"` with Type in the funding set: dropped.
    - `Balance Impact == "Credit"` otherwise (refunds, external deposits): counted.

    Category = merchant `Name` when present, else `Type` (e.g., "Donation Payment").
    """
    rows = _read_csv_robust(filepath)
    if not rows:
        return None

    FUNDING_TYPES = {
        "General Card Deposit",
        "Bank Deposit to PP Account",
        # PayPal often pads the type string with a trailing space; guard both forms
        "General Card Deposit ",
        "Bank Deposit to PP Account ",
    }

    txns = []
    for row in rows:
        impact = (row.get("Balance Impact") or "").strip()
        if impact == "Memo":
            continue
        ttype = (row.get("Type") or "").strip()
        # Funding-side counterparts mirror actual spend rows. Drop them
        # regardless of Balance Impact — we've observed rows where the
        # Impact column is blank, so filtering purely on Type is safer.
        if ttype in FUNDING_TYPES:
            continue

        date = _parse_mdy(row.get("Date", ""))
        if not date:
            continue

        # Gross / Net both present; Net is post-fee and what actually hits the
        # balance, matching the sign conventions of the other parsers.
        amount = _parse_money(row.get("Net") or row.get("Gross") or "")
        if amount == 0.0:
            continue

        name = (row.get("Name") or "").strip()
        category = name if name else (ttype or "Uncategorized")
        item = (row.get("Item Title") or "").strip()
        desc_parts = [ttype]
        if name:
            desc_parts.append(name)
        if item and item not in (name, ttype):
            desc_parts.append(item)
        desc = " — ".join(p for p in desc_parts if p)

        txns.append(
            {
                "date": date,
                "description": desc,
                "amount": amount,
                "category": category,
            }
        )

    if not txns:
        return None

    return _summarize_transactions(
        source="paypal",
        account_id="paypal",
        txns=txns,
        source_file=filepath.name,
    )


def _parse_schwab_balance_csv(filepath: Path) -> dict | None:
    """Parse a Schwab "Balances" snapshot CSV.

    Schwab balance exports are not clean CSV: line 0 is a prose preamble wrapped
    in quotes, line 1 is blank, then sections follow separated by blank lines.
    Each section starts with a label line (key only, trailing comma) and contains
    key,value pairs. Some sections are nested one level (e.g. "Bank Sweep," is
    a sub-header under "Cash & Cash Investments"). IRA / Margin sections are
    optional depending on account type.

    Returns a tolerant, section-indexed dict. Missing sections are simply absent.
    """
    try:
        with open(filepath, encoding="utf-8-sig", newline="") as f:
            raw_lines = f.readlines()
    except Exception as e:
        log.error(f"Failed to read Schwab balance CSV {filepath.name}: {e}")
        return None

    if not raw_lines:
        return None

    # Preamble: "Balances for account  XXXX-1252 as of 04/17/2026 08:36 AM ET"
    preamble = raw_lines[0].strip()
    m = re.match(
        r'"?Balances for account\s+XXXX-(\d+)\s+as of\s+'
        r'(\d{2}/\d{2}/\d{4}\s+\d{1,2}:\d{2}\s+(?:AM|PM)\s+ET)"?',
        preamble,
    )
    if not m:
        log.warning(f"Schwab balance preamble did not match: {preamble[:80]}")
        return None
    account_mask = m.group(1)
    as_of = m.group(2)

    # Parse remaining lines as CSV rows (so quoted values with commas parse correctly).
    body = "".join(raw_lines[1:])
    reader = csv.reader(io.StringIO(body))
    rows = list(reader)

    # Walk rows. Blank rows separate sections. The first non-blank block is the
    # "headline" (no section header). Subsequent blocks begin with a lone-label
    # row (one non-empty cell plus one empty cell, or just one cell).
    headline: dict = {}
    sections: dict = {}

    # Group rows by blank-line separators.
    groups: list[list[list[str]]] = []
    current: list[list[str]] = []
    for row in rows:
        if not row or all((c or "").strip() == "" for c in row):
            if current:
                groups.append(current)
                current = []
            continue
        current.append(row)
    if current:
        groups.append(current)

    def _is_label_row(row: list[str]) -> bool:
        """A label-only row: first cell is non-empty, remaining cells are empty."""
        if not row:
            return False
        if not (row[0] or "").strip():
            return False
        return all((c or "").strip() == "" for c in row[1:])

    for idx, group in enumerate(groups):
        if idx == 0:
            # Headline block — key,value pairs, no section header.
            for row in group:
                if len(row) >= 2 and (row[0] or "").strip():
                    headline[row[0].strip()] = (row[1] or "").strip()
            continue

        # First row is the section name (label-only, e.g., "Investments,"),
        # OR a compact label like "Option Details" that has just one cell.
        if not _is_label_row(group[0]):
            # Unexpected shape — treat first cell as section name regardless.
            section_name = (group[0][0] or "").strip() or f"section_{idx}"
            data_rows = group[1:]
        else:
            section_name = (group[0][0] or "").strip().rstrip(",")
            data_rows = group[1:]

        section_dict: dict = {}
        current_subsection: str | None = None
        for row in data_rows:
            if not row:
                continue
            key = (row[0] or "").strip()
            if not key:
                continue
            # Sub-section header (e.g., "Bank Sweep,", "To Trade,", "To Withdraw,")
            if _is_label_row(row):
                current_subsection = key
                section_dict[current_subsection] = {}
                continue
            val_raw = (row[1] if len(row) > 1 else "").strip()
            # Decide numeric vs string: money-ish (starts with $, -$, ($) or is
            # a plain number / percent) → float via _parse_money. Percent-only
            # strings (e.g. "8.350%", "100%", "0%") stay strings to preserve
            # the literal display. Pure-numeric year keys in IRA sections
            # also stay strings-as-values (e.g. "2026" → "$0.00").
            if val_raw.startswith("$") or val_raw.startswith("-$") or val_raw.startswith("("):
                val: object = _parse_money(val_raw)
            elif val_raw.endswith("%"):
                val = val_raw
            elif val_raw == "":
                val = None
            else:
                # Try money parse; if it yields 0.0 for a non-"0" string, keep as string.
                parsed = _parse_money(val_raw)
                val = (
                    parsed
                    if (parsed != 0.0 or val_raw.strip() in ("0", "0.0", "0.00"))
                    else val_raw
                )

            if current_subsection and current_subsection in section_dict:
                section_dict[current_subsection][key] = val
            else:
                section_dict[key] = val

        sections[section_name] = section_dict

    # Extract headline numbers with tolerance.
    def _h(k: str) -> float | None:
        v = headline.get(k)
        return _parse_money(v) if v else None

    investments = sections.get("Investments", {}) or {}
    non_margin = investments.get("Non-Margin")
    margin = investments.get("Margin")

    result = {
        "account_mask": account_mask,
        "as_of": as_of,
        "account_value": _h("Account Value") or 0.0,
        "day_change": _h("Day Change") or 0.0,
        "day_change_pct": headline.get("Day Change %", ""),
        "cash": _h("Cash & Cash Investments") or 0.0,
        "market_value": _h("Market Value") or 0.0,
        "non_margin": non_margin if isinstance(non_margin, int | float) else None,
        "margin": margin if isinstance(margin, int | float) else None,
        "sections": sections,
        "source_file": filepath.name,
    }
    return result


def _parse_schwab_position_csv(filepath: Path) -> dict | None:
    """Parse a Schwab "Positions" CSV snapshot.

    Layout: line 0 preamble ("Positions for account <type> ...<mask> as of
    HH:MM AM/PM ET, YYYY/MM/DD"), line 1 blank, line 2 header with trailing
    empty column (trailing comma), line 3+ per-holding rows, final
    `"Positions Total"` row captured as `totals`.

    Numeric cells with "--" become None; the Cash row uses "--" for qty/price
    but has a real Mkt Val.
    """
    try:
        with open(filepath, encoding="utf-8-sig", newline="") as f:
            raw_lines = f.readlines()
    except Exception as e:
        log.error(f"Failed to read Schwab position CSV {filepath.name}: {e}")
        return None

    if len(raw_lines) < 4:
        return None

    preamble = raw_lines[0].strip()
    m = re.match(
        r'"?Positions for account\s+(.+?)\s+\.\.\.(\d+)\s+as of\s+'
        r'(\d{1,2}:\d{2}\s+(?:AM|PM)\s+ET,\s+\d{4}/\d{2}/\d{2})"?',
        preamble,
    )
    if not m:
        log.warning(f"Schwab position preamble did not match: {preamble[:80]}")
        return None
    account_type = m.group(1).strip()
    account_mask = m.group(2)
    as_of = m.group(3)

    # Parse lines 2+ as CSV (line 1 is blank, line 2 is the real header).
    body = "".join(raw_lines[2:])
    reader = csv.DictReader(io.StringIO(body))
    rows = list(reader)

    def _num_or_none(s: str) -> float | None:
        """Parse money; return None for '--' / blank / 'N/A' sentinels."""
        if s is None:
            return None
        s = s.strip()
        if s in ("", "--", "N/A"):
            return None
        return _parse_money(s)

    positions: list[dict] = []
    totals: dict = {}
    for row in rows:
        symbol = (row.get("Symbol") or "").strip()
        if not symbol:
            continue
        if symbol == "Positions Total":
            totals = {
                "mkt_val": _num_or_none(row.get("Mkt Val (Market Value)", "")),
                "cost_basis": _num_or_none(row.get("Cost Basis", "")),
                "gain_dollar": _num_or_none(row.get("Gain $ (Gain/Loss $)", "")),
                "gain_pct": (row.get("Gain % (Gain/Loss %)") or "").strip(),
            }
            continue

        positions.append(
            {
                "symbol": symbol,
                "description": (row.get("Description") or "").strip(),
                "qty": _num_or_none(row.get("Qty (Quantity)", "")),
                "price": _num_or_none(row.get("Price", "")),
                "mkt_val": _num_or_none(row.get("Mkt Val (Market Value)", "")),
                "cost_basis": _num_or_none(row.get("Cost Basis", "")),
                "gain_dollar": _num_or_none(row.get("Gain $ (Gain/Loss $)", "")),
                "gain_pct": (row.get("Gain % (Gain/Loss %)") or "").strip(),
                "asset_type": (row.get("Asset Type") or "").strip(),
            }
        )

    if not positions and not totals:
        return None

    return {
        "account_mask": account_mask,
        "account_type": account_type,
        "as_of": as_of,
        "positions": positions,
        "totals": totals,
        "source_file": filepath.name,
    }


def _route_bank_csv(filepath: Path) -> tuple[str, dict] | None:
    """Dispatch a CSV to the right parser by filename pattern.

    Returns (source, result_dict) on success, or None if no parser matched.
    Tried in specificity order; filename matching is case-insensitive.
    """
    name = filepath.name
    lower = name.lower()

    # Amex: exact filename (the only "activity.csv" we expect is Amex)
    if lower == "activity.csv":
        r = _parse_amex_csv(filepath)
        return ("amex", r) if r else None

    # Chase: starts with "chase" and contains "activity" in the filename
    if lower.startswith("chase") and "activity" in lower:
        r = _parse_chase_csv(filepath)
        return ("chase", r) if r else None

    # Truist: "acct_<digits>_..."
    if re.match(r"acct_\d+_.+\.csv$", lower):
        r = _parse_truist_csv(filepath)
        return ("truist", r) if r else None

    # Schwab balance snapshots: "XXXX<mask>_Balances_<timestamp>.CSV"
    if re.search(r"_balances_[\d-]+\.csv$", lower):
        r = _parse_schwab_balance_csv(filepath)
        return ("schwab_balance", r) if r else None

    # Schwab position snapshots: "<AccountType>-Positions-<timestamp>.csv"
    # Filenames may contain spaces (e.g., "Simple IRA-Positions-...csv"); normalize to dashes.
    normalized = lower.replace(" ", "-")
    if re.search(r"-positions-[\d-]+\.csv$", normalized):
        r = _parse_schwab_position_csv(filepath)
        return ("schwab_position", r) if r else None

    # Schwab brokerage transactions: "*Transactions_*.csv" with an IRA/account-type prefix
    if "_transactions_" in lower and re.search(r"(contributory|simple_ira|designated_bene)", lower):
        r = _parse_schwab_csv(filepath)
        return ("schwab", r) if r else None

    # HSA: filename starts with HSA (e.g., HSATransactionsAsOf_04172026.csv)
    if lower.startswith("hsa"):
        r = _parse_hsa_csv(filepath)
        return ("hsa", r) if r else None

    # PayPal: either the default export name (Download.CSV / Download(N).CSV)
    # or explicitly paypal-prefixed. To avoid matching any random "Download.csv"
    # we header-sniff: PayPal's CSV has "Balance Impact" as the final column
    # plus "Transaction ID" + "Gross" + "Net" — a very specific combination.
    is_download_name = bool(re.match(r"download(\s*\(\d+\))?\.csv$", lower))
    if is_download_name or "paypal" in lower:
        try:
            with open(filepath, encoding="utf-8-sig", newline="") as f:
                header = f.readline()
            paypal_signature = all(
                s in header for s in ('"Balance Impact"', '"Transaction ID"', '"Gross"', '"Net"')
            )
        except Exception:
            paypal_signature = False
        if paypal_signature:
            r = _parse_paypal_csv(filepath)
            return ("paypal", r) if r else None

    # Fallback: Amazon orders CSV (legacy path retained for the existing inbox contents)
    if "amazon" in lower or "order" in lower:
        return None  # handled by legacy Amazon branch in cmd_process_inbox

    log.warning(f"No parser matched for CSV {name}")
    return None


def _format_bank_capture(result: dict) -> tuple[str, dict]:
    """Format a parsed-bank result dict as (capture_content, source_metadata).

    Keeps the capture small and human-readable. Category aggregates and top
    transactions go into the content; full raw amounts go into metadata for
    downstream wiki / brief synthesis.
    """
    src = result["source"]
    acct = result["account_id"]
    dr = result["date_range"]
    period = f"{dr['start']} to {dr['end']}" if dr.get("start") else "unknown period"

    lines = [
        f"{src.title()} Activity — {acct} ({period})",
        "",
        f"Transactions: {result['transaction_count']}",
        f"Spent:  ${result['total_debit']:,.2f}",
        f"Income: ${result['total_credit']:,.2f}",
        f"Net:    ${result['net']:,.2f}",
    ]

    if result["by_category"]:
        lines.extend(["", "By category:"])
        # Sort categories by total volume (debit + credit) descending so both
        # spend-heavy and transfer-heavy categories surface on investment accts.
        cats = sorted(
            result["by_category"].items(),
            key=lambda kv: kv[1]["debit"] + kv[1]["credit"],
            reverse=True,
        )
        for cat, data in cats[:15]:
            if data["credit"] > 0 and data["debit"] > 0:
                line = f"  {cat}: {data['count']} txn, out ${data['debit']:,.2f} / in ${data['credit']:,.2f}"
            elif data["credit"] > 0:
                line = f"  {cat}: {data['count']} txn, in ${data['credit']:,.2f}"
            else:
                line = f"  {cat}: {data['count']} txn, out ${data['debit']:,.2f}"
            lines.append(line)

    if result["top_transactions"]:
        lines.extend(["", "Top 10 charges:"])
        for t in result["top_transactions"][:10]:
            lines.append(
                f"  {t['date']}  ${t['amount']:>9,.2f}  {t['category']:<20}  {t['description']}"
            )

    content = "\n".join(lines)
    meta = {
        "type": f"{src}_activity",
        "source_provider": src,
        "account_id": acct,
        "date_range": result["date_range"],
        "total_debit": result["total_debit"],
        "total_credit": result["total_credit"],
        "net": result["net"],
        "transaction_count": result["transaction_count"],
        "by_category": result["by_category"],
        "source_file": result["source_file"],
    }
    return content, meta


def _format_schwab_balance_capture(result: dict) -> tuple[str, dict]:
    """Format a Schwab balance snapshot as (capture_content, source_metadata).

    Content is a half-screen summary; metadata carries the full section tree
    for downstream wiki / report synthesis.
    """
    mask = result["account_mask"]
    as_of = result["as_of"]
    # Infer account "type" prefix from section shape: IRA Details present → IRA-ish;
    # Margin Details → taxable margin; otherwise plain. Left generic — real account
    # type/name comes from the positions snapshot, not balances.
    account_id = f"Schwab-{mask}"

    sections = result.get("sections", {}) or {}
    lines = [
        f"Schwab Balance — {account_id} (as of {as_of})",
        "",
        f"Account Value: ${result['account_value']:>12,.2f}",
        f"Cash:          ${result['cash']:>12,.2f}",
        f"Market Value:  ${result['market_value']:>12,.2f}",
        f"Day Change:    ${result['day_change']:>12,.2f} ({result['day_change_pct']})",
    ]

    # Cash detail — flatten one level, naming sub-sections for clarity.
    cash_section = sections.get("Cash & Cash Investments") or {}
    cash_detail_lines: list[str] = []
    for k, v in cash_section.items():
        if isinstance(v, dict):
            for sk, sv in v.items():
                if isinstance(sv, int | float):
                    cash_detail_lines.append(f"  {k} / {sk}: ${sv:,.2f}")
        elif isinstance(v, int | float) and k != "Cash & Cash Investments Total":
            cash_detail_lines.append(f"  {k}: ${v:,.2f}")
    if cash_detail_lines:
        lines.extend(["", "Cash detail:"])
        lines.extend(cash_detail_lines)

    # Investments detail — margin vs non-margin split when present.
    inv = sections.get("Investments") or {}
    inv_lines: list[str] = []
    non_margin = inv.get("Non-Margin")
    margin = inv.get("Margin")
    securities = inv.get("Securities")
    if isinstance(non_margin, int | float) and non_margin > 0:
        inv_lines.append(f"  Securities (Non-Margin): ${non_margin:,.2f}")
    if isinstance(margin, int | float) and margin > 0:
        inv_lines.append(f"  Securities (Margin): ${margin:,.2f}")
    if not inv_lines and isinstance(securities, int | float):
        inv_lines.append(f"  Securities: ${securities:,.2f}")
    if inv_lines:
        lines.extend(["", "Investments:"])
        lines.extend(inv_lines)

    # Funds available — pull the "To Trade" subsection's top number.
    funds = sections.get("Funds Available") or {}
    to_trade = funds.get("To Trade") if isinstance(funds.get("To Trade"), dict) else None
    if to_trade:
        tradable = to_trade.get("Cash & Cash Investments")
        if isinstance(tradable, int | float):
            lines.append("")
            lines.append(f"Funds available to trade: ${tradable:,.2f}")

    content = "\n".join(lines)
    meta = {
        "type": "schwab_balance_snapshot",
        "source_provider": "schwab",
        "account_id": account_id,
        "account_mask": mask,
        "as_of": as_of,
        "account_value": result["account_value"],
        "cash": result["cash"],
        "market_value": result["market_value"],
        "day_change": result["day_change"],
        "day_change_pct": result["day_change_pct"],
        "non_margin": result.get("non_margin"),
        "margin": result.get("margin"),
        "sections": sections,
        "source_file": result["source_file"],
    }
    return content, meta


def _format_schwab_position_capture(result: dict) -> tuple[str, dict]:
    """Format a Schwab positions snapshot as (capture_content, source_metadata).

    Shows top-N holdings by market value with allocation %, plus per-asset-type
    aggregation in metadata. Cash is listed alongside equity holdings so the
    allocation view reconciles to total portfolio value.
    """
    mask = result["account_mask"]
    acct_type = result.get("account_type") or ""
    as_of = result["as_of"]
    account_id = f"{acct_type}-{mask}" if acct_type else f"Schwab-{mask}"

    totals = result.get("totals") or {}
    total_value = totals.get("mkt_val") or 0.0
    cost_basis = totals.get("cost_basis")
    gain_dollar = totals.get("gain_dollar")
    gain_pct = totals.get("gain_pct") or ""

    lines = [f"Schwab Positions — {account_id} (as of {as_of})", ""]
    if total_value:
        pieces = [f"Portfolio value: ${total_value:,.2f}"]
        if cost_basis is not None and gain_dollar is not None:
            pieces.append(f"(cost basis ${cost_basis:,.2f}, gain ${gain_dollar:,.2f} / {gain_pct})")
        lines.append(" ".join(pieces))

    positions = result.get("positions") or []
    # Rank by market value, descending, nulls last.
    ranked = sorted(
        positions,
        key=lambda p: (p.get("mkt_val") or 0.0),
        reverse=True,
    )

    if ranked:
        lines.extend(["", "Top holdings by market value:"])
        for p in ranked[:10]:
            sym = p.get("symbol") or ""
            mv = p.get("mkt_val") or 0.0
            pct = (mv / total_value * 100.0) if total_value else 0.0
            desc = (p.get("description") or "")[:60]
            qty = p.get("qty")
            price = p.get("price")
            atype = p.get("asset_type") or ""
            # Cash row carries "Cash & Cash Investments" as its symbol; shorten
            # for display and suppress the "--" description.
            display_sym = "Cash" if sym == "Cash & Cash Investments" else sym
            if desc in ("--", ""):
                desc = "Cash & Cash Investments" if sym == "Cash & Cash Investments" else ""
            # For cash rows, qty/price are None — render with em-dashes.
            qty_price = "—" if qty is None or price is None else f"{qty:,.0f} @ ${price:,.2f}"
            lines.append(
                f"  {display_sym:<6} ${mv:>12,.2f}  ({pct:>4.1f}%)  {desc} — {qty_price} — {atype}"
            )

    # Asset-type aggregation for metadata.
    by_asset_type: dict = defaultdict(lambda: {"count": 0, "mkt_val": 0.0})
    for p in positions:
        atype = p.get("asset_type") or "Unknown"
        mv = p.get("mkt_val") or 0.0
        by_asset_type[atype]["count"] += 1
        by_asset_type[atype]["mkt_val"] += mv

    content = "\n".join(lines)
    meta = {
        "type": "schwab_position_snapshot",
        "source_provider": "schwab",
        "account_id": account_id,
        "account_mask": mask,
        "account_type": acct_type,
        "as_of": as_of,
        "total_value": total_value,
        "cost_basis": cost_basis,
        "gain_dollar": gain_dollar,
        "gain_pct": gain_pct,
        "positions": positions,
        "asset_types": dict(by_asset_type),
        "source_file": result["source_file"],
    }
    return content, meta


def _parse_amazon_csv(filepath: Path) -> dict | None:
    """Parse Amazon 'Request My Data' order CSV and aggregate spending.

    Returns dict with keys: total_spend, order_count, categories (dict),
    top_items (list), quarter, year, rows_raw (list of dicts).
    Returns None if parsing fails.
    """
    rows = []
    # Try common encodings
    for enc in ("utf-8-sig", "utf-8", "latin-1", "cp1252"):
        try:
            with open(filepath, encoding=enc, newline="") as f:
                # Sniff delimiter
                sample = f.read(4096)
                f.seek(0)
                try:
                    dialect = csv.Sniffer().sniff(sample, delimiters=",\t;|")
                except csv.Error:
                    dialect = csv.excel
                reader = csv.DictReader(f, dialect=dialect)
                rows = list(reader)
            if rows:
                break
        except (UnicodeDecodeError, csv.Error):
            continue
        except Exception as e:
            log.error(f"Failed to read CSV {filepath.name}: {e}")
            return None

    if not rows:
        log.error(f"CSV {filepath.name} has no parseable rows")
        return None

    # Normalize header keys (Amazon exports vary in casing/spacing)
    def norm(key):
        return re.sub(r"[^a-z]", "", (key or "").lower())

    header_map = {}
    for key in rows[0]:
        header_map[norm(key)] = key

    def col(row, *candidates):
        for c in candidates:
            mapped = header_map.get(norm(c))
            if mapped and mapped in row and row[mapped]:
                return row[mapped].strip()
        return ""

    total_spend = 0.0
    order_count = 0
    categories = defaultdict(lambda: {"count": 0, "amount": 0.0})
    items = []
    dates_seen = []

    for row in rows:
        title = col(row, "Title", "ProductName", "ItemDescription", "Product Name")
        price_str = col(
            row,
            "ItemTotal",
            "Item Total",
            "TotalOwed",
            "Total Owed",
            "PurchasePricePerUnit",
            "Purchase Price Per Unit",
            "Price",
        )
        category = col(row, "Category", "ProductCategory", "Product Category") or "Uncategorized"
        order_date = col(row, "OrderDate", "Order Date", "Ship Date", "ShipDate")
        qty_str = col(row, "Quantity", "Qty")

        # Parse price
        price_clean = re.sub(r"[^\d.\-]", "", price_str)
        try:
            price = float(price_clean) if price_clean else 0.0
        except ValueError:
            price = 0.0

        qty = 1
        try:
            qty = int(qty_str) if qty_str else 1
        except ValueError:
            qty = 1

        line_total = price * qty if price > 0 else price
        if line_total <= 0:
            continue

        total_spend += line_total
        order_count += 1
        categories[category]["count"] += 1
        categories[category]["amount"] += line_total
        items.append({"title": title or "(no title)", "price": line_total, "category": category})

        if order_date:
            dates_seen.append(order_date)

    if order_count == 0:
        log.error(f"CSV {filepath.name}: no valid order rows found")
        return None

    # Determine quarter/year from earliest order date or today
    today = date.today()
    year = today.year
    quarter = (today.month - 1) // 3 + 1
    for ds in dates_seen:
        for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y", "%d/%m/%Y", "%Y/%m/%d"):
            try:
                dt = datetime.strptime(ds, fmt)
                year = dt.year
                quarter = (dt.month - 1) // 3 + 1
                break
            except ValueError:
                continue
        else:
            continue
        break

    # Sort items by price descending, keep top 10
    items.sort(key=lambda x: x["price"], reverse=True)
    top_items = items[:10]

    # Sort categories by amount descending
    cat_sorted = dict(sorted(categories.items(), key=lambda x: x[1]["amount"], reverse=True))

    return {
        "total_spend": round(total_spend, 2),
        "order_count": order_count,
        "categories": {
            k: {"count": v["count"], "amount": round(v["amount"], 2)} for k, v in cat_sorted.items()
        },
        "top_items": top_items,
        "quarter": quarter,
        "year": year,
    }


def cmd_process_inbox(cfg: dict, conn: sqlite3.Connection):
    """--process-inbox: Scan ~/financial-inbox/ for PDF/CSV files, parse, and post captures."""
    INBOX_DIR.mkdir(parents=True, exist_ok=True)
    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)

    files = sorted(
        f for f in INBOX_DIR.iterdir() if f.is_file() and f.suffix.lower() in (".pdf", ".csv")
    )
    if not files:
        log.info("No files in financial inbox")
        return

    log.info(f"Found {len(files)} file(s) in {INBOX_DIR}")
    processed = 0

    for filepath in files:
        ext = filepath.suffix.lower()
        log.info(f"Processing: {filepath.name}")

        if ext == ".pdf":
            result = _parse_401k_pdf(filepath)
            if result is None:
                log.error(f"Skipping {filepath.name} — parse failed (leaving in inbox)")
                continue

            # Build capture text
            q_label = f"Q{result['quarter']} {result['year']}"
            parts = [f"401k Update — {q_label}", ""]
            if result["balance"] is not None:
                parts.append(f"Balance: ${result['balance']:,.2f}")
            if result["ytd_employee"] is not None or result["ytd_match"] is not None:
                emp = f"${result['ytd_employee']:,.2f}" if result["ytd_employee"] else "N/A"
                match = f"${result['ytd_match']:,.2f}" if result["ytd_match"] else "N/A"
                parts.append(f"YTD Contributions: {emp} (employee) + {match} (match)")
            if result["funds"]:
                parts.append("\nAllocation:")
                for f in result["funds"]:
                    parts.append(f"  {f['name']}: {f['pct']}% (${f['value']:,.2f})")

            content = "\n".join(parts)
            meta = {
                "type": "401k_quarterly",
                "quarter": q_label,
                "balance": result["balance"],
                "ytd_employee": result["ytd_employee"],
                "ytd_match": result["ytd_match"],
                "fund_count": len(result["funds"]),
                "source_file": filepath.name,
            }

            if _post_capture(cfg, content, meta):
                filepath.rename(PROCESSED_DIR / filepath.name)
                processed += 1
                log.info("401k PDF processed and moved to processed/")
            else:
                log.error(f"Failed to post 401k capture — leaving {filepath.name} in inbox")

        elif ext == ".csv":
            # First try the bank/credit-card router (Amex, Chase, Truist, Schwab, HSA).
            # Falls through to the legacy Amazon parser only if filename doesn't match.
            routed = _route_bank_csv(filepath)
            if routed is not None:
                _source, result = routed
                if _source == "schwab_balance":
                    content, meta = _format_schwab_balance_capture(result)
                elif _source == "schwab_position":
                    content, meta = _format_schwab_position_capture(result)
                else:
                    content, meta = _format_bank_capture(result)
                if _post_capture(cfg, content, meta):
                    filepath.rename(PROCESSED_DIR / filepath.name)
                    processed += 1
                    log.info(f"{_source} CSV processed and moved to processed/")
                else:
                    log.error(
                        f"Failed to post {_source} capture — leaving {filepath.name} in inbox"
                    )
                continue

            # Legacy Amazon orders fallback
            result = _parse_amazon_csv(filepath)
            if result is None:
                log.error(f"Skipping {filepath.name} — parse failed (leaving in inbox)")
                continue

            q_label = f"Q{result['quarter']} {result['year']}"

            # Build raw data summary for claude --print
            cat_lines = []
            for cat, data in result["categories"].items():
                cat_lines.append(f"  {cat}: {data['count']} items, ${data['amount']:,.2f}")
            top_lines = []
            for item in result["top_items"][:10]:
                top_lines.append(f"  ${item['price']:,.2f} — {item['title'][:60]}")

            raw_summary = (
                f"Amazon Spending Data — {q_label}\n"
                f"Total: ${result['total_spend']:,.2f} across {result['order_count']} orders\n\n"
                f"By category:\n" + "\n".join(cat_lines) + "\n\n"
                "Top items by price:\n" + "\n".join(top_lines)
            )

            # T2 synthesis via claude --print
            synthesis = None
            prompt = (
                f"Summarize this quarter's Amazon spending patterns. "
                f"Identify notable trends, unusual purchases, and category insights. "
                f"Keep it concise (3-5 paragraphs).\n\n{raw_summary}"
            )
            if len(prompt) > 4000:
                prompt = prompt[:3950] + "\n\n[Data truncated for length.]"

            try:
                cli_result = subprocess.run(
                    ["claude", "--print", "-p", prompt],
                    capture_output=True,
                    text=True,
                    timeout=120,
                )
                if cli_result.returncode == 0 and cli_result.stdout.strip():
                    synthesis = cli_result.stdout.strip()
                    log.info(f"Claude synthesis received ({len(synthesis)} chars)")
                else:
                    log.warning(f"Claude CLI returned code {cli_result.returncode}")
            except (subprocess.TimeoutExpired, FileNotFoundError, Exception) as e:
                log.warning(f"Claude CLI unavailable: {e} — posting raw data")

            # Build capture text
            parts = [f"Amazon Spending — {q_label}", ""]
            parts.append(f"${result['total_spend']:,.2f} across {result['order_count']} orders")
            if synthesis:
                parts.append("")
                parts.append(synthesis)
            parts.append("")
            parts.append("Top categories:")
            for cat, data in list(result["categories"].items())[:8]:
                parts.append(f"  {cat}: ${data['amount']:,.2f} ({data['count']} items)")
            parts.append("")
            parts.append("Top purchases:")
            for item in result["top_items"][:5]:
                parts.append(f"  ${item['price']:,.2f} — {item['title'][:60]}")

            content = "\n".join(parts)
            meta = {
                "type": "amazon_quarterly",
                "quarter": q_label,
                "total_spend": result["total_spend"],
                "order_count": result["order_count"],
                "categories": result["categories"],
                "source_file": filepath.name,
            }

            if _post_capture(cfg, content, meta):
                filepath.rename(PROCESSED_DIR / filepath.name)
                processed += 1
                log.info("Amazon CSV processed and moved to processed/")
            else:
                log.error(f"Failed to post Amazon capture — leaving {filepath.name} in inbox")

        else:
            log.warning(f"Unknown file type: {filepath.name} — skipping")

    log.info(f"Inbox processing complete: {processed}/{len(files)} files processed")


# ── Status ───────────────────────────────────────────────────────────────────


def show_status(conn: sqlite3.Connection):
    """Print pipeline statistics."""
    print("\n=== Financial Pipeline Status ===\n")

    total = conn.execute("SELECT COUNT(*) FROM transactions").fetchone()[0]
    pending = conn.execute("SELECT COUNT(*) FROM transactions WHERE pending = 1").fetchone()[0]
    print(f"Total transactions: {total} ({pending} pending)")

    print("\nBy account:")
    for account_id, name, count in conn.execute(
        "SELECT t.account_id, a.name, COUNT(*) FROM transactions t "
        "LEFT JOIN accounts a ON t.account_id = a.id "
        "GROUP BY t.account_id ORDER BY COUNT(*) DESC"
    ).fetchall():
        print(f"  {name or account_id}: {count}")

    print("\nBy category (30d):")
    for cat, count, total_amt in conn.execute(
        "SELECT ob_category, COUNT(*), SUM(amount) FROM transactions "
        "WHERE date >= date('now', '-30 days') "
        "GROUP BY ob_category ORDER BY SUM(amount) DESC"
    ).fetchall():
        print(f"  {cat}: {count} txns, ${abs(total_amt or 0):,.2f}")

    print("\nSync cursors:")
    for account_id, last_sync in conn.execute(
        "SELECT account_id, last_sync FROM sync_cursors ORDER BY account_id"
    ).fetchall():
        print(f"  {account_id}: last sync {last_sync or 'never'}")

    latest = conn.execute(
        "SELECT date, COUNT(*) FROM transactions GROUP BY date ORDER BY date DESC LIMIT 1"
    ).fetchone()
    if latest:
        print(f"\nLatest transactions: {latest[0]} ({latest[1]} txns)")

    bal_count = conn.execute("SELECT COUNT(*) FROM daily_balances").fetchone()[0]
    print(f"Balance snapshots: {bal_count}")
    print()


# ── CLI ──────────────────────────────────────────────────────────────────────


def main():
    ap = argparse.ArgumentParser(description="Financial Pipeline for Open Brain")
    ap.add_argument("--sync", action="store_true", help="Sync transactions from Plaid")
    ap.add_argument("--balances", action="store_true", help="Daily balance snapshot")
    ap.add_argument("--daily-summary", action="store_true", help="Post daily transaction summary")
    ap.add_argument(
        "--investments", action="store_true", help="Weekly investment report (Schwab holdings)"
    )
    ap.add_argument(
        "--monthly-report", action="store_true", help="Monthly financial synthesis (prior month)"
    )
    ap.add_argument(
        "--process-inbox",
        action="store_true",
        help="Process 401k PDFs and Amazon CSVs from ~/financial-inbox/",
    )
    ap.add_argument("--status", action="store_true", help="Show pipeline stats")
    ap.add_argument(
        "--account-monitoring",
        action="store_true",
        help="Daily account health check: balance diffs, anomaly detection, Pushover alerts",
    )
    ap.add_argument(
        "--json-output",
        action="store_true",
        help="Emit a JSON summary as the final stdout line (for ingest sidecar)",
    )
    args = ap.parse_args()

    # Require at least one action
    if not any(
        [
            args.sync,
            args.balances,
            args.daily_summary,
            args.investments,
            args.monthly_report,
            args.process_inbox,
            args.status,
            args.account_monitoring,
        ]
    ):
        ap.print_help()
        sys.exit(1)

    global _JSON_OUTPUT_MODE
    _JSON_OUTPUT_MODE = bool(args.json_output)
    _json_t0 = time.monotonic()

    exit_code = 0
    try:
        conn = init_db()

        if args.status:
            show_status(conn)
            conn.close()
            return

        cfg = load_config()

        if args.sync:
            cmd_sync(cfg, conn)
        if args.balances:
            cmd_balances(cfg, conn)
        if args.daily_summary:
            cmd_daily_summary(cfg, conn)
        if args.investments:
            cmd_investments(cfg, conn)
        if args.monthly_report:
            cmd_monthly_report(cfg, conn)
        if args.process_inbox:
            cmd_process_inbox(cfg, conn)
        if args.account_monitoring:
            cmd_account_monitoring(cfg, conn)

        conn.close()
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001
        log.exception("financial-pipeline: unhandled error")
        _JSON_ERRORS.append(f"unhandled: {e}")
        exit_code = 1

    if _JSON_OUTPUT_MODE:
        summary = {
            "status": "ok" if exit_code == 0 and not _JSON_ERRORS else "error",
            "captures_posted": list(_JSON_CAPTURES_POSTED),
            "errors": list(_JSON_ERRORS),
            "duration_ms": int((time.monotonic() - _json_t0) * 1000),
        }
        # Final line of stdout must be valid JSON — the sidecar parses it.
        sys.stdout.flush()
        print(json.dumps(summary))

    if exit_code:
        sys.exit(exit_code)


if __name__ == "__main__":
    main()
