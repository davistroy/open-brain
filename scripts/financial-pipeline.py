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
    python financial-pipeline.py --investments               # weekly investment report (stub)
    python financial-pipeline.py --monthly-report            # monthly synthesis (stub)
    python financial-pipeline.py --process-inbox             # manual file inbox (stub)
    python financial-pipeline.py --status                    # pipeline stats

Cron (daily 6:30 AM):
    30 6 * * * cd ~/open-brain && venv/bin/python scripts/financial-pipeline.py --sync --daily-summary >> ~/logs/financial-pipeline.log 2>&1
"""

import argparse, json, logging, re, sqlite3, subprocess, sys, time
from collections import defaultdict
from datetime import datetime, date, timezone
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

        CREATE INDEX IF NOT EXISTS idx_txn_date ON transactions(date);
        CREATE INDEX IF NOT EXISTS idx_txn_account ON transactions(account_id);
        CREATE INDEX IF NOT EXISTS idx_bal_date ON daily_balances(date);
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


# ── Balances (stub for 1.3) ─────────────────────────────────────────────────

def cmd_balances(cfg: dict, conn: sqlite3.Connection):
    """--balances: Daily balance snapshot. (Will be implemented in item 1.3)"""
    log.info("--balances: Not implemented yet (see work item 1.3)")


# ── Future stubs ─────────────────────────────────────────────────────────────

def cmd_investments(cfg: dict, conn: sqlite3.Connection):
    """--investments: Weekly investment report. (Will be implemented in Phase 2.)"""
    log.info("--investments: Not implemented yet (see Phase 2, work item 2.1)")


def cmd_monthly_report(cfg: dict, conn: sqlite3.Connection):
    """--monthly-report: Monthly financial synthesis. (Will be implemented in Phase 2.)"""
    log.info("--monthly-report: Not implemented yet (see Phase 2, work item 2.2)")


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
    ap.add_argument("--investments", action="store_true", help="Weekly investment report (stub)")
    ap.add_argument("--monthly-report", action="store_true", help="Monthly financial synthesis (stub)")
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
