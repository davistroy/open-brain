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
    python financial-pipeline.py --process-inbox             # manual file inbox (stub)
    python financial-pipeline.py --status                    # pipeline stats

Cron (daily 6:30 AM):
    30 6 * * * cd ~/open-brain && venv/bin/python scripts/financial-pipeline.py --sync --daily-summary >> ~/logs/financial-pipeline.log 2>&1
"""

import argparse, json, logging, re, sqlite3, subprocess, sys, time
from collections import defaultdict
from datetime import datetime, date, timedelta, timezone
from pathlib import Path
from typing import Optional

import requests, yaml

sys.stdout.reconfigure(line_buffering=True)
sys.stderr.reconfigure(line_buffering=True)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("financial-pipeline")

# --- Paths & constants ---
PIPE_DIR = Path.home() / ".financial-pipeline"
DB_PATH = PIPE_DIR / "financial.db"
CONFIG_PATH = Path(__file__).resolve().parent.parent / "config" / "financial" / "plaid-config.yaml"
MERCHANTS_PATH = Path(__file__).resolve().parent.parent / "config" / "financial" / "merchants.yaml"


# ── Config ───────────────────────────────────────────────────────────────────

def load_config() -> dict:
    """Load plaid-config.yaml."""
    if not CONFIG_PATH.exists():
        sys.exit(f"Config not found: {CONFIG_PATH}")
    return yaml.safe_load(CONFIG_PATH.read_text())


def load_merchants() -> Optional[dict]:
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
_bws_secrets_cache: Optional[list] = None


def _load_bws_secrets() -> list:
    """Load all secrets from Bitwarden Secrets Manager (cached)."""
    global _bws_secrets_cache
    if _bws_secrets_cache is not None:
        return _bws_secrets_cache
    try:
        result = subprocess.run(
            ["bws", "secret", "list"],
            capture_output=True, text=True, timeout=30,
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
        (account_key, cfg_account["name"], cfg_account["type"],
         cfg_account["institution"], account_key),
    )
    conn.commit()


def get_sync_cursor(conn: sqlite3.Connection, account_id: str) -> Optional[str]:
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


def categorize_transaction(txn: dict, merchants: Optional[dict]) -> str:
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

def sync_account(client, conn: sqlite3.Connection, account_key: str, access_token: str,
                 merchants: Optional[dict]) -> dict:
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
                log.warning(f"  {account_key}: bank login required — re-run Plaid Link for this account")
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
            txn_id = txn.transaction_id if hasattr(txn, "transaction_id") else txn.get("transaction_id", "")
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
        log.info(f"    +{stats['added']} added, ~{stats['modified']} modified, -{stats['removed']} removed")

    log.info(f"Sync complete: +{total_stats['added']} added, ~{total_stats['modified']} modified, "
             f"-{total_stats['removed']} removed, {len(total_stats['errors'])} errors")
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
    by_account = defaultdict(lambda: {"name": "", "total": 0.0, "count": 0, "categories": defaultdict(lambda: {"total": 0.0, "count": 0})})
    grand_total = 0.0

    for account_id, account_name, amount, merchant, ob_category, pending in rows:
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
        for cat, cat_data in sorted(acct["categories"].items(), key=lambda x: abs(x[1]["total"]), reverse=True):
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
    cap_cfg = cfg.get("capture_api", {})
    url = cap_cfg.get("url", "https://brain.troy-davis.com/api/v1/captures")
    caller = cap_cfg.get("caller_header", "financial-pipeline")

    try:
        resp = requests.post(
            url,
            json={
                "content": summary_text,
                "source": "api",
                "source_metadata": {
                    "type": "financial_daily",
                    "date": today,
                    "transaction_count": len(rows),
                    "grand_total": round(grand_total, 2),
                    "accounts": categories_summary,
                },
            },
            headers={
                "Content-Type": "application/json",
                "X-Open-Brain-Caller": caller,
            },
            timeout=30,
        )
        if resp.status_code in (200, 201):
            log.info(f"Daily summary posted ({len(rows)} transactions)")
        else:
            log.warning(f"Brain POST {resp.status_code}: {resp.text[:200]}")
    except requests.exceptions.RequestException as e:
        log.warning(f"Brain unreachable: {e}")


# ── Balances ─────────────────────────────────────────────────────────────────

# Account types where Plaid reports positive balances that represent debt (owed)
CREDIT_ACCOUNT_TYPES = {"credit", "loan"}


def fetch_account_balances(client, access_token: str) -> list:
    """Call Plaid /accounts/balance/get and return list of account dicts."""
    from plaid.model.accounts_balance_get_request import AccountsBalanceGetRequest

    request = AccountsBalanceGetRequest(access_token=access_token)
    response = client.accounts_balance_get(request)
    return [acct.to_dict() for acct in response.accounts]


def store_balances(conn: sqlite3.Connection, today: str, account_key: str,
                   current: float, available: float, limit: float):
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

            store_balances(conn, today, sub_key, current,
                           available if available is not None else 0.0,
                           limit if limit is not None else 0.0)

            balance_rows.append((
                sub_key,
                account_cfg["name"],
                acct_type,
                acct_subtype,
                current,
                available,
                limit,
            ))
            log.info(f"  {account_cfg['name']}: current=${current:,.2f}"
                     f"{f', available=${available:,.2f}' if available is not None else ''}"
                     f"{f', limit=${limit:,.2f}' if limit is not None else ''}"
                     f" ({acct_type}/{acct_subtype})")

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

    for account_key, display_name, acct_type, acct_subtype, current, available, limit in balance_rows:
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
    for account_key, display_name, acct_type, acct_subtype, current, available, limit in balance_rows:
        accounts_meta[account_key] = {
            "name": display_name,
            "type": acct_type,
            "subtype": acct_subtype,
            "current_balance": round(current, 2),
            "available_balance": round(available, 2) if available is not None else None,
            "credit_limit": round(limit, 2) if limit is not None and limit > 0 else None,
        }

    # ── POST capture to Open Brain ───────────────────────────────────────
    cap_cfg = cfg.get("capture_api", {})
    url = cap_cfg.get("url", "https://brain.troy-davis.com/api/v1/captures")
    caller = cap_cfg.get("caller_header", "financial-pipeline")

    try:
        resp = requests.post(
            url,
            json={
                "content": capture_text,
                "source": "api",
                "source_metadata": {
                    "type": "balance_snapshot",
                    "date": today,
                    "net_worth": round(net_worth, 2),
                    "account_count": len(balance_rows),
                    "accounts": accounts_meta,
                },
            },
            headers={
                "Content-Type": "application/json",
                "X-Open-Brain-Caller": caller,
            },
            timeout=30,
        )
        if resp.status_code in (200, 201):
            log.info(f"Balance snapshot posted ({len(balance_rows)} accounts, net worth ${net_worth:,.2f})")
        else:
            log.warning(f"Brain POST {resp.status_code}: {resp.text[:200]}")
    except requests.exceptions.RequestException as e:
        log.warning(f"Brain unreachable: {e}")


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
        key for key, acfg in accounts_cfg.items()
        if acfg.get("type") in ("brokerage", "investment")
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

        log.info(f"  {accounts_cfg[account_key]['name']}: {len(response.holdings)} positions retrieved")
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
            (h["date"], h["security_id"], h["name"], h["ticker"],
             h["quantity"], h["close_price"], h["value"], h["type"], h["account_id"]),
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
                movers.append({
                    "name": h["name"],
                    "ticker": h["ticker"],
                    "change": change,
                    "change_pct": change_pct,
                })

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
        lines.append(f"  {h['name']}{ticker_str}: ${h['value']:,.2f} — {h['quantity']:.2f} shares @ ${h['close_price']:,.2f}")
    lines.append("")

    # Top movers
    if movers:
        lines.append("Top Movers (week):")
        for m in movers:
            ticker_str = f" ({m['ticker']})" if m["ticker"] else ""
            sign = "+" if m["change"] >= 0 else ""
            lines.append(f"  {m['name']}{ticker_str}: {sign}${m['change']:,.2f} ({sign}{m['change_pct']:.1f}%)")
    else:
        lines.append("Top Movers: (no prior week data for comparison)")

    capture_text = "\n".join(lines)
    log.info(f"Portfolio: ${total_value:,.2f}" +
             (f", weekly change: {'+' if weekly_delta >= 0 else ''}${weekly_delta:,.2f} ({weekly_pct:+.1f}%)"
              if weekly_delta is not None else ""))

    # ── POST capture to Open Brain ───────────────────────────────────────
    cap_cfg = cfg.get("capture_api", {})
    url = cap_cfg.get("url", "https://brain.troy-davis.com/api/v1/captures")
    caller = cap_cfg.get("caller_header", "financial-pipeline")

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

    try:
        resp = requests.post(
            url,
            json={
                "content": capture_text,
                "source": "api",
                "source_metadata": source_meta,
            },
            headers={
                "Content-Type": "application/json",
                "X-Open-Brain-Caller": caller,
            },
            timeout=30,
        )
        if resp.status_code in (200, 201):
            log.info(f"Investment summary posted ({len(all_holdings)} holdings, ${total_value:,.2f})")
        else:
            log.warning(f"Brain POST {resp.status_code}: {resp.text[:200]}")
    except requests.exceptions.RequestException as e:
        log.warning(f"Brain unreachable: {e}")


def _get_prior_month_range(year: int, month: int) -> tuple:
    """Return (start_date, end_date) ISO strings for the month before year/month."""
    if month == 1:
        py, pm = year - 1, 12
    else:
        py, pm = year, month - 1
    start = f"{py}-{pm:02d}-01"
    if pm == 12:
        end_d = date(py, 12, 31)
    else:
        end_d = date(py, pm + 1, 1) - timedelta(days=1)
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
    top_merchants = sorted(merchant_totals.items(), key=lambda x: abs(x[1]["amount"]), reverse=True)[:10]

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
        for r in rows if abs(r[2]) > 200
    ]
    large_txns.sort(key=lambda x: abs(x["amount"]), reverse=True)

    # 2g. Subscription changes (compare recurring merchants to prior month)
    prior_month_start, prior_month_end = _get_prior_month_range(target_year, target_month)
    prior_month_merchants = set(
        r[0] for r in conn.execute(
            "SELECT DISTINCT merchant FROM transactions "
            "WHERE date >= ? AND date <= ? AND merchant IS NOT NULL AND pending = 0",
            (prior_month_start, prior_month_end),
        ).fetchall()
    )
    new_subs = sorted(current_merchants - prior_month_merchants) if prior_month_merchants else []
    cancelled_subs = sorted(prior_month_merchants - current_merchants) if prior_month_merchants else []

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
        target_month - 1 if target_month > 1 else 12, 1,
    ).strftime("%B %Y")

    mom_comparison = []
    if has_prior_month:
        all_cats = set(dict(cat_sorted).keys()) | set(prior_cat.keys())
        for cat in sorted(all_cats):
            curr = cat_totals[cat]["amount"] if cat in cat_totals else 0.0
            prev = prior_cat.get(cat, 0.0)
            delta = curr - prev
            pct = (delta / abs(prev) * 100) if prev != 0 else 0.0
            mom_comparison.append({
                "category": cat, "current": round(curr, 2),
                "prior": round(prev, 2), "delta": round(delta, 2),
                "pct_change": round(pct, 1),
            })

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
            yoy_comparison.append({
                "category": cat, "current": round(curr, 2),
                "prior_year": round(prev_y, 2), "delta": round(delta, 2),
                "pct_change": round(pct, 1),
            })

    # ── 5. End-of-month net worth from daily_balances ──────────────────
    net_worth_row = conn.execute(
        "SELECT SUM(CASE WHEN a.type IN ('credit', 'loan') THEN -db.current_balance "
        "ELSE db.current_balance END) "
        "FROM daily_balances db LEFT JOIN accounts a ON db.account_id = a.id "
        "WHERE db.date = (SELECT MAX(date) FROM daily_balances WHERE date <= ?)",
        (month_end,),
    ).fetchone()
    net_worth_eom = round(net_worth_row[0], 2) if net_worth_row and net_worth_row[0] is not None else None

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
    for acct_id, data in sorted(account_stats.items()):
        raw_lines.append(f"  {data['name']}: {data['count']} txns, ${abs(data['total']):,.2f}")

    if large_txns:
        raw_lines.append("")
        raw_lines.append("LARGE TRANSACTIONS (>$200):")
        for lt in large_txns:
            raw_lines.append(f"  {lt['date']} | {lt['merchant']} | ${abs(lt['amount']):,.2f} | {lt['category']} | {lt['account']}")

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
            raw_lines.append(f"  {m['category']}: ${abs(m['current']):,.2f} ({direction}{m['pct_change']}%)")

    if yoy_comparison:
        raw_lines.append("")
        raw_lines.append(f"YEAR-OVER-YEAR ({last_of_prior.strftime('%b')} {yoy_year} -> {month_label}):")
        for y in yoy_comparison:
            direction = "+" if y["delta"] >= 0 else ""
            raw_lines.append(f"  {y['category']}: ${abs(y['current']):,.2f} ({direction}{y['pct_change']}%)")

    raw_data_text = "\n".join(raw_lines)

    # ── 7. Build Claude CLI prompt (keep under 4000 chars) ─────────────
    pp = []
    pp.append(f"Analyze this monthly financial report for {month_label}.")
    pp.append(f"Total: ${total_spend:,.2f} across {len(rows)} transactions, avg ${avg_txn:,.2f}/txn.")
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
            pp.append(f"  {lt['date']} {lt['merchant']}: ${abs(lt['amount']):,.2f} ({lt['category']})")

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
            key=lambda x: abs(x["delta"]), reverse=True,
        )
        for m in significant[:10]:
            d = "+" if m["delta"] >= 0 else ""
            pp.append(f"  {m['category']}: {d}${abs(m['delta']):,.2f} ({d}{m['pct_change']}%)")

    if yoy_comparison:
        pp.append("")
        pp.append(f"YOY CHANGES (vs {last_of_prior.strftime('%b')} {yoy_year}):")
        significant_y = sorted(
            [y for y in yoy_comparison if abs(y["delta"]) > 20],
            key=lambda x: abs(x["delta"]), reverse=True,
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
            capture_output=True, text=True, timeout=120,
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
        "top_merchants": {m: {"amount": round(d["amount"], 2), "count": d["count"]} for m, d in top_merchants},
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

    cap_cfg = cfg.get("capture_api", {})
    url = cap_cfg.get("url", "https://brain.troy-davis.com/api/v1/captures")
    caller = cap_cfg.get("caller_header", "financial-pipeline")

    try:
        resp = requests.post(
            url,
            json={
                "content": capture_text,
                "source": "api",
                "source_metadata": source_metadata,
            },
            headers={
                "Content-Type": "application/json",
                "X-Open-Brain-Caller": caller,
            },
            timeout=30,
        )
        if resp.status_code in (200, 201):
            log.info(f"Monthly report posted: {month_label} ({len(rows)} txns, ${total_spend:,.2f})")
        else:
            log.warning(f"Brain POST {resp.status_code}: {resp.text[:200]}")
    except requests.exceptions.RequestException as e:
        log.warning(f"Brain unreachable: {e}")


def cmd_process_inbox(cfg: dict, conn: sqlite3.Connection):
    """--process-inbox: Manual file inbox watcher. (Will be implemented in Phase 4.)"""
    log.info("--process-inbox: Not implemented yet (see Phase 4, work items 4.1/4.2)")


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
    ap.add_argument("--investments", action="store_true", help="Weekly investment report (Schwab holdings)")
    ap.add_argument("--monthly-report", action="store_true", help="Monthly financial synthesis (prior month)")
    ap.add_argument("--process-inbox", action="store_true", help="Process manual file inbox (stub)")
    ap.add_argument("--status", action="store_true", help="Show pipeline stats")
    args = ap.parse_args()

    # Require at least one action
    if not any([args.sync, args.balances, args.daily_summary, args.investments,
                args.monthly_report, args.process_inbox, args.status]):
        ap.print_help()
        sys.exit(1)

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

    conn.close()


if __name__ == "__main__":
    main()
