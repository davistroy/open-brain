"""
Email Cleanup Pass 4 — Delete everything EXCEPT protected categories.

KEEP: Personal & Reminders, Jamie, Ashley, Work & Office, Travel & Transportation,
      Charity & Donations, Government & Official, Utilities & Bills
DELETE: Everything else in inbox

Uses an inverted approach: identify senders in KEEP categories, then delete
all emails NOT from those senders (plus a date safety net for uncategorized).
"""

import json
import os
import sys
import time
import argparse
from datetime import datetime, timezone
from pathlib import Path
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed

import msal
import requests

sys.stdout.reconfigure(line_buffering=True)
sys.stderr.reconfigure(line_buffering=True)

CLIENT_ID = "14d82eec-204b-4c2f-b7e8-296a70dab67e"
TENANT_ID = "common"
SCOPES = ["Mail.ReadWrite", "User.Read"]
TOKEN_CACHE_FILE = Path.home() / ".email-analyzer" / "ms_token_cache.json"
GRAPH_BASE = "https://graph.microsoft.com/v1.0"

BATCH_SIZE = 20
MAX_CONCURRENT = 4
PAGE_SIZE = 999

# Categories to KEEP — everything else gets deleted
KEEP_CATEGORIES = {
    "Personal & Reminders",
    "Jamie",
    "Ashley",
    "Work & Office",
    "Travel & Transportation",
    "Charity & Donations",
    "Government & Official",
    "Utilities & Bills",
}

# Extra protected senders (regardless of category)
PROTECTED_SENDERS = {"ash.davis@hotmail.com"}

session = requests.Session()
session.headers["Content-Type"] = "application/json"


def authenticate():
    print(f"  Token cache: {TOKEN_CACHE_FILE}", flush=True)
    cache = msal.SerializableTokenCache()
    if TOKEN_CACHE_FILE.exists():
        print(f"  Loading cached token...", flush=True)
        cache.deserialize(TOKEN_CACHE_FILE.read_text())

    app = msal.PublicClientApplication(
        CLIENT_ID,
        authority=f"https://login.microsoftonline.com/{TENANT_ID}",
        token_cache=cache,
    )

    accounts = app.get_accounts()
    if accounts:
        result = app.acquire_token_silent(SCOPES, account=accounts[0])
        if result and "access_token" in result:
            print(f"  Authenticated as {accounts[0]['username']} (cached)", flush=True)
            if cache.has_state_changed:
                TOKEN_CACHE_FILE.write_text(cache.serialize())
            return result["access_token"]

    print("\n" + "=" * 60)
    print("MICROSOFT AUTHENTICATION REQUIRED")
    print("=" * 60)
    flow = app.initiate_device_flow(scopes=SCOPES)
    if "user_code" not in flow:
        raise RuntimeError(f"Failed: {flow.get('error_description')}")
    print(flow["message"])
    print("=" * 60 + "\n")
    result = app.acquire_token_by_device_flow(flow)
    if "access_token" in result:
        TOKEN_CACHE_FILE.write_text(cache.serialize())
        return result["access_token"]
    raise RuntimeError(f"Auth failed: {result.get('error_description')}")


def api_get(url, params=None, retries=5):
    for attempt in range(retries):
        try:
            resp = session.get(url, params=params, timeout=30)
        except requests.exceptions.ReadTimeout:
            if attempt < retries - 1:
                time.sleep(2 ** attempt)
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


def api_post(url, json_data, retries=5):
    for attempt in range(retries):
        try:
            resp = session.post(url, json=json_data, timeout=60)
        except requests.exceptions.ReadTimeout:
            if attempt < retries - 1:
                time.sleep(2 ** attempt)
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


def collect_message_ids(folder, odata_filter=None):
    url = f"{GRAPH_BASE}/me/mailFolders/{folder}/messages"
    params = {"$top": PAGE_SIZE, "$select": "id"}
    if odata_filter:
        params["$filter"] = odata_filter

    ids = []
    page = 0
    while url:
        data = api_get(url, params if page == 0 else None)
        ids.extend(m["id"] for m in data.get("value", []))
        url = data.get("@odata.nextLink")
        page += 1
    return ids


def collect_ids_for_sender(sender, folder="inbox"):
    odata_filter = f"from/emailAddress/address eq '{sender}'"
    try:
        return collect_message_ids(folder, odata_filter)
    except Exception as e:
        print(f"    Error querying {sender}: {e}", flush=True)
        return []


def batch_delete(message_ids, label="", dry_run=False):
    if not message_ids:
        return 0

    total = len(message_ids)
    deleted = 0
    batch_url = f"{GRAPH_BASE}/$batch"

    for i in range(0, total, BATCH_SIZE):
        chunk = message_ids[i:i + BATCH_SIZE]
        if dry_run:
            deleted += len(chunk)
        else:
            requests_payload = [
                {"id": str(j), "method": "DELETE", "url": f"/me/messages/{mid}"}
                for j, mid in enumerate(chunk)
            ]
            try:
                result = api_post(batch_url, {"requests": requests_payload})
                deleted += sum(1 for r in result.get("responses", [])
                               if 200 <= r.get("status", 500) < 300)
            except Exception as e:
                print(f"    Batch error at offset {i}: {e}", flush=True)

        pct = min(100, (i + len(chunk)) / total * 100)
        print(f"\r    {label}: {deleted}/{total} deleted ({pct:.0f}%)", end="", flush=True)

        if (i // BATCH_SIZE) % 10 == 9:
            time.sleep(0.5)

    print(flush=True)
    return deleted


def load_sender_sets():
    """Build KEEP and DELETE sender sets from classification data."""
    corpus_path = os.path.expanduser("~/data/outputs/email_corpus.json")
    clf_path = os.path.expanduser("~/data/outputs/classify_report_batch.json")

    with open(corpus_path, encoding="utf-8") as f:
        corpus = json.load(f)
    with open(clf_path, encoding="utf-8") as f:
        clf_data = json.load(f)

    email_info = {}
    for email in corpus["emails"]:
        email_info[email["id"]] = email["sender_email"]

    sender_cats = defaultdict(lambda: defaultdict(int))
    for email_id, info in clf_data["categorized_emails"].items():
        sender = email_info.get(email_id, "")
        if sender:
            sender_cats[sender][info["category"]] += 1

    keep_senders = set()
    delete_senders = set()
    keep_category_counts = defaultdict(int)
    delete_category_counts = defaultdict(int)

    for sender, cats in sender_cats.items():
        primary = max(cats, key=cats.get)
        total = sum(cats.values())

        if sender.lower() in PROTECTED_SENDERS:
            keep_senders.add(sender)
            keep_category_counts[primary] += total
            continue

        if primary in KEEP_CATEGORIES:
            keep_senders.add(sender)
            keep_category_counts[primary] += total
        else:
            delete_senders.add(sender)
            delete_category_counts[primary] += total

    return keep_senders, delete_senders, keep_category_counts, delete_category_counts


def main():
    parser = argparse.ArgumentParser(description="Email cleanup pass 4 — delete all except protected categories")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    mode = "DRY RUN" if args.dry_run else "LIVE"
    print(f"\n{'='*60}", flush=True)
    print(f"  EMAIL CLEANUP PASS 4 — {mode}", flush=True)
    print(f"  Keep ONLY: {', '.join(sorted(KEEP_CATEGORIES))}", flush=True)
    print(f"{'='*60}\n", flush=True)

    print("[1/5] Authenticating...", flush=True)
    token = authenticate()
    session.headers["Authorization"] = f"Bearer {token}"

    total_deleted = 0

    # Load sender classifications
    print("\n[2/5] Loading sender classifications...", flush=True)
    keep_senders, delete_senders, keep_cats, delete_cats = load_sender_sets()

    print(f"\n  KEEP senders: {len(keep_senders)}", flush=True)
    for cat, count in sorted(keep_cats.items(), key=lambda x: x[1], reverse=True):
        print(f"    {cat}: {count} emails from sample", flush=True)

    print(f"\n  DELETE senders: {len(delete_senders)}", flush=True)
    for cat, count in sorted(delete_cats.items(), key=lambda x: x[1], reverse=True)[:15]:
        print(f"    {cat}: {count} emails from sample", flush=True)

    print(f"\n  Protected senders: {PROTECTED_SENDERS}", flush=True)

    # Query delete senders
    print(f"\n[3/5] Querying {len(delete_senders)} senders to delete...", flush=True)
    all_delete_ids = []
    completed = 0

    with ThreadPoolExecutor(max_workers=MAX_CONCURRENT) as pool:
        futures = {
            pool.submit(collect_ids_for_sender, s): s
            for s in delete_senders
        }
        for future in as_completed(futures):
            try:
                ids = future.result()
                if ids:
                    all_delete_ids.extend(ids)
            except Exception as e:
                print(f"    Error: {e}", flush=True)
            completed += 1
            if completed % 50 == 0:
                print(f"    Queried {completed}/{len(delete_senders)} senders, "
                      f"{len(all_delete_ids)} emails to delete...", flush=True)

    print(f"\n  Total emails to delete: {len(all_delete_ids)}", flush=True)

    # Delete
    print(f"\n[4/5] Deleting emails...", flush=True)
    deleted = batch_delete(all_delete_ids, label="Pass 4", dry_run=args.dry_run)
    total_deleted += deleted
    print(f"  Deleted: {deleted}", flush=True)

    # Sent Items older than 2025-01-01
    print(f"\n[5/7] Deleting Sent Items older than 2025-01-01...", flush=True)
    sent_ids = collect_message_ids(
        "sentitems",
        odata_filter="receivedDateTime lt 2025-01-01T00:00:00Z"
    )
    print(f"  Found {len(sent_ids)} sent items before 2025-01-01", flush=True)
    deleted = batch_delete(sent_ids, label="Old Sent Items", dry_run=args.dry_run)
    total_deleted += deleted
    print(f"  Sent Items: {deleted}", flush=True)

    # Empty Junk (in case new junk arrived since Pass 1)
    print(f"\n[6/7] Emptying Junk Email...", flush=True)
    junk_ids = collect_message_ids("junkemail")
    if junk_ids:
        print(f"  Found {len(junk_ids)} in Junk", flush=True)
        deleted = batch_delete(junk_ids, label="Junk", dry_run=args.dry_run)
        total_deleted += deleted
    else:
        print(f"  Junk is empty", flush=True)

    # Empty Deleted Items
    print(f"\n[7/7] Emptying Deleted Items...", flush=True)
    del_ids = collect_message_ids("deleteditems")
    print(f"  Found {len(del_ids)} in Deleted Items", flush=True)
    deleted = batch_delete(del_ids, label="Deleted Items", dry_run=args.dry_run)
    total_deleted += deleted
    print(f"  Deleted Items: {deleted}", flush=True)

    print(f"\n{'='*60}", flush=True)
    print(f"  PASS 4 COMPLETE — {total_deleted} total emails {'would be ' if args.dry_run else ''}deleted", flush=True)
    print(f"{'='*60}\n", flush=True)


if __name__ == "__main__":
    main()
