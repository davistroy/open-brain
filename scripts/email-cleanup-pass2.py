"""
Email Cleanup Pass 2+3 — Direct Graph API
- Delete ALL from Amateur Radio, News & Commentary, Jobs & Career senders
- Delete Shopping senders older than 30 days
- Delete notification senders (GitHub, Facebook, homeserver, pollen, vumedi)
- Delete Sent Items older than 2025-01-01
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import msal  # type: ignore[import-untyped]
import requests

sys.stdout.reconfigure(line_buffering=True)  # type: ignore[union-attr]
sys.stderr.reconfigure(line_buffering=True)  # type: ignore[union-attr]

CLIENT_ID = "14d82eec-204b-4c2f-b7e8-296a70dab67e"
TENANT_ID = "common"
SCOPES = ["Mail.ReadWrite", "User.Read"]
TOKEN_CACHE_FILE = Path.home() / ".email-analyzer" / "ms_token_cache.json"
GRAPH_BASE = "https://graph.microsoft.com/v1.0"

PROTECTED_SENDERS: set[str] = {"ash.davis@hotmail.com"}
BATCH_SIZE = 20
MAX_CONCURRENT = 4
PAGE_SIZE = 999

# Categories to delete ALL emails (no retention)
DELETE_ALL_CATEGORIES: set[str] = {
    "Amateur Radio",
    "News & Commentary",
    "Jobs & Career",
}

# Shopping: keep last 30 days only
SHOPPING_CATEGORIES: set[str] = {
    "Shopping & E-commerce",
    "Shipping & E-commerce",
    "Shipping & Transportation",
}

# Notification senders: delete ALL
NOTIFICATION_SENDERS: set[str] = {
    "notifications@github.com",
    "troydavis.homeserver@gmail.com",
    "friendupdates@facebookmail.com",
    "donotreply@pollen.aaaai.org",
    "videos@vumedi.com",
}

session = requests.Session()
session.headers["Content-Type"] = "application/json"


def authenticate() -> str:
    print(f"  Token cache: {TOKEN_CACHE_FILE}", flush=True)
    cache = msal.SerializableTokenCache()
    if TOKEN_CACHE_FILE.exists():
        print("  Loading cached token...", flush=True)
        cache.deserialize(TOKEN_CACHE_FILE.read_text())

    app = msal.PublicClientApplication(
        CLIENT_ID,
        authority=f"https://login.microsoftonline.com/{TENANT_ID}",
        token_cache=cache,
    )

    accounts = app.get_accounts()
    if accounts:
        result: dict[str, Any] = app.acquire_token_silent(SCOPES, account=accounts[0])
        if result and "access_token" in result:
            print(f"  Authenticated as {accounts[0]['username']} (cached)", flush=True)
            if cache.has_state_changed:
                TOKEN_CACHE_FILE.write_text(cache.serialize())
            return result["access_token"]

    print("\n" + "=" * 60)
    print("MICROSOFT AUTHENTICATION REQUIRED")
    print("=" * 60)
    flow: dict[str, Any] = app.initiate_device_flow(scopes=SCOPES)
    if "user_code" not in flow:
        raise RuntimeError(f"Failed: {flow.get('error_description')}")
    print(flow["message"])
    print("=" * 60 + "\n")
    result = app.acquire_token_by_device_flow(flow)
    if "access_token" in result:
        TOKEN_CACHE_FILE.write_text(cache.serialize())
        return result["access_token"]
    raise RuntimeError(f"Auth failed: {result.get('error_description')}")


def api_get(
    url: str,
    params: dict[str, Any] | None = None,
    retries: int = 5,
) -> dict[str, Any]:
    for attempt in range(retries):
        try:
            resp = session.get(url, params=params, timeout=30)
        except requests.exceptions.ReadTimeout:
            if attempt < retries - 1:
                time.sleep(2**attempt)
                continue
            raise
        if resp.status_code == 429:
            wait = int(resp.headers.get("Retry-After", 10))
            print(f"    Rate limited, waiting {wait}s...", flush=True)
            time.sleep(wait)
            continue
        if resp.status_code == 401:
            token = authenticate()
            session.headers["Authorization"] = f"Bearer {token}"
            continue
        resp.raise_for_status()
        return resp.json()
    raise RuntimeError(f"Failed after {retries} retries: {url}")


def api_post(
    url: str,
    json_data: dict[str, Any],
    retries: int = 5,
) -> dict[str, Any]:
    for attempt in range(retries):
        try:
            resp = session.post(url, json=json_data, timeout=60)
        except requests.exceptions.ReadTimeout:
            if attempt < retries - 1:
                time.sleep(2**attempt)
                continue
            raise
        if resp.status_code == 429:
            wait = int(resp.headers.get("Retry-After", 10))
            print(f"    Rate limited, waiting {wait}s...", flush=True)
            time.sleep(wait)
            continue
        if resp.status_code == 401:
            token = authenticate()
            session.headers["Authorization"] = f"Bearer {token}"
            continue
        resp.raise_for_status()
        return resp.json()
    raise RuntimeError(f"Failed after {retries} retries: {url}")


def collect_message_ids(
    folder: str,
    odata_filter: str | None = None,
) -> list[str]:
    url: str | None = f"{GRAPH_BASE}/me/mailFolders/{folder}/messages"
    params: dict[str, Any] = {"$top": PAGE_SIZE, "$select": "id"}
    if odata_filter:
        params["$filter"] = odata_filter

    ids: list[str] = []
    page = 0
    while url:
        data = api_get(url, params if page == 0 else None)
        ids.extend(m["id"] for m in data.get("value", []))
        url = data.get("@odata.nextLink")
        page += 1
    return ids


def collect_ids_for_sender(
    sender: str,
    folder: str = "inbox",
    date_filter: str | None = None,
) -> list[str]:
    odata_filter = f"from/emailAddress/address eq '{sender}'"
    if date_filter:
        odata_filter += f" and receivedDateTime lt {date_filter}"
    try:
        return collect_message_ids(folder, odata_filter)
    except Exception as e:
        print(f"    Error querying {sender}: {e}", flush=True)
        return []


def batch_delete(
    message_ids: list[str],
    label: str = "",
    dry_run: bool = False,
) -> int:
    if not message_ids:
        return 0

    total = len(message_ids)
    deleted = 0
    batch_url = f"{GRAPH_BASE}/$batch"

    for i in range(0, total, BATCH_SIZE):
        chunk = message_ids[i : i + BATCH_SIZE]
        if dry_run:
            deleted += len(chunk)
        else:
            requests_payload: list[dict[str, Any]] = [
                {"id": str(j), "method": "DELETE", "url": f"/me/messages/{mid}"}
                for j, mid in enumerate(chunk)
            ]
            try:
                result = api_post(batch_url, {"requests": requests_payload})
                deleted += sum(
                    1 for r in result.get("responses", []) if 200 <= r.get("status", 500) < 300
                )
            except Exception as e:
                print(f"    Batch error at offset {i}: {e}", flush=True)

        pct = min(100, (i + len(chunk)) / total * 100)
        print(f"\r    {label}: {deleted}/{total} deleted ({pct:.0f}%)", end="", flush=True)

        if (i // BATCH_SIZE) % 10 == 9:
            time.sleep(0.5)

    print(flush=True)
    return deleted


def load_senders_by_category() -> dict[str, set[str]]:
    corpus_path = os.path.expanduser("~/data/outputs/email_corpus.json")
    clf_path = os.path.expanduser("~/data/outputs/classify_report_batch.json")

    with open(corpus_path, encoding="utf-8") as f:
        corpus: dict[str, Any] = json.load(f)
    with open(clf_path, encoding="utf-8") as f:
        clf_data: dict[str, Any] = json.load(f)

    email_info: dict[str, str] = {}
    for email in corpus["emails"]:
        email_info[email["id"]] = email["sender_email"]

    sender_cats: defaultdict[str, defaultdict[str, int]] = defaultdict(
        lambda: defaultdict(int)
    )
    for email_id, info in clf_data["categorized_emails"].items():
        sender: str = email_info.get(email_id, "")
        if sender:
            sender_cats[sender][info["category"]] += 1

    result: dict[str, set[str]] = {"delete_all": set(), "shopping": set()}
    for sender, cats in sender_cats.items():
        if sender.lower() in PROTECTED_SENDERS:
            continue
        primary = max(cats, key=cats.get)
        if primary in DELETE_ALL_CATEGORIES:
            result["delete_all"].add(sender)
        elif primary in SHOPPING_CATEGORIES:
            result["shopping"].add(sender)

    return result


def query_senders_parallel(
    senders: set[str],
    date_filter: str | None = None,
    label: str = "",
) -> list[str]:
    all_ids: list[str] = []
    completed = 0
    total = len(senders)

    with ThreadPoolExecutor(max_workers=MAX_CONCURRENT) as pool:
        futures = {
            pool.submit(collect_ids_for_sender, s, "inbox", date_filter): s for s in senders
        }
        for future in as_completed(futures):
            try:
                ids = future.result()
                if ids:
                    all_ids.extend(ids)
            except Exception as e:
                print(f"    Error: {e}", flush=True)
            completed += 1
            if completed % 50 == 0:
                print(
                    f"    {label}: queried {completed}/{total} senders, {len(all_ids)} emails found...",
                    flush=True,
                )

    return all_ids


def main() -> None:
    parser = argparse.ArgumentParser(description="Email cleanup pass 2+3")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    mode = "DRY RUN" if args.dry_run else "LIVE"
    print(f"\n{'='*60}", flush=True)
    print(f"  EMAIL CLEANUP PASS 2+3 — {mode}", flush=True)
    print(f"{'='*60}\n", flush=True)

    print("[1/6] Authenticating...", flush=True)
    token = authenticate()
    session.headers["Authorization"] = f"Bearer {token}"

    thirty_days_ago = (datetime.now(UTC) - timedelta(days=30)).strftime("%Y-%m-%dT%H:%M:%SZ")
    total_deleted = 0

    # Load category senders
    print("\n[2/6] Loading sender classifications...", flush=True)
    cat_senders = load_senders_by_category()
    # Add notification senders to delete_all
    cat_senders["delete_all"].update(NOTIFICATION_SENDERS)
    # Remove any protected senders
    for key in cat_senders:
        cat_senders[key] -= PROTECTED_SENDERS

    print(
        f"  Delete-all senders (Amateur Radio + News + Jobs + Notifications): {len(cat_senders['delete_all'])}",
        flush=True,
    )
    print(f"  Shopping senders (>30 days): {len(cat_senders['shopping'])}", flush=True)

    # Pass 2a: Delete ALL from Amateur Radio, News, Jobs senders
    print("\n[3/6] Querying delete-all senders (no retention)...", flush=True)
    delete_all_ids = query_senders_parallel(
        cat_senders["delete_all"], date_filter=None, label="Delete-all"
    )
    print(f"  Found {len(delete_all_ids)} emails to delete", flush=True)
    deleted = batch_delete(delete_all_ids, label="Delete-all categories", dry_run=args.dry_run)
    total_deleted += deleted
    print(f"  Delete-all: {deleted} deleted", flush=True)

    # Pass 2b: Shopping — keep last 30 days
    print("\n[4/6] Querying shopping senders (>30 days)...", flush=True)
    shopping_ids = query_senders_parallel(
        cat_senders["shopping"], date_filter=thirty_days_ago, label="Shopping"
    )
    print(f"  Found {len(shopping_ids)} shopping emails older than 30 days", flush=True)
    deleted = batch_delete(shopping_ids, label="Shopping >30d", dry_run=args.dry_run)
    total_deleted += deleted
    print(f"  Shopping: {deleted} deleted", flush=True)

    # Pass 3: Sent Items older than 1/1/2025
    print("\n[5/6] Querying Sent Items older than 2025-01-01...", flush=True)
    sent_ids = collect_message_ids(
        "sentitems", odata_filter="receivedDateTime lt 2025-01-01T00:00:00Z"
    )
    print(f"  Found {len(sent_ids)} sent items before 2025-01-01", flush=True)
    deleted = batch_delete(sent_ids, label="Old Sent Items", dry_run=args.dry_run)
    total_deleted += deleted
    print(f"  Sent Items: {deleted} deleted", flush=True)

    # Final: Empty Deleted Items (everything we just deleted landed there)
    print("\n[6/6] Emptying Deleted Items (cleanup residue)...", flush=True)
    del_ids = collect_message_ids("deleteditems")
    print(f"  Found {len(del_ids)} emails in Deleted Items", flush=True)
    deleted = batch_delete(del_ids, label="Deleted Items", dry_run=args.dry_run)
    total_deleted += deleted
    print(f"  Deleted Items: {deleted} deleted", flush=True)

    print(f"\n{'='*60}", flush=True)
    print(
        f"  PASS 2+3 COMPLETE — {total_deleted} total emails {'would be ' if args.dry_run else ''}deleted",
        flush=True,
    )
    print(f"{'='*60}\n", flush=True)


if __name__ == "__main__":
    main()
