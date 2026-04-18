"""
Email Cleanup Script — Direct Graph API (no Composio)
Reuses MSAL auth from email-corpus-analyzer.

Actions:
1. Delete emails from 500 marketing senders older than 3 days (except ash.davis@hotmail.com)
2. Empty Junk Email folder
3. Empty Deleted Items folder
"""

import argparse
import json
import os
import sys
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import UTC, datetime, timedelta
from pathlib import Path

import msal
import requests

# Force unbuffered output
sys.stdout.reconfigure(line_buffering=True)
sys.stderr.reconfigure(line_buffering=True)

# --- Auth config (matches email-corpus-analyzer) ---
CLIENT_ID = "14d82eec-204b-4c2f-b7e8-296a70dab67e"
TENANT_ID = "common"
SCOPES = ["Mail.ReadWrite", "User.Read"]
TOKEN_CACHE_FILE = Path.home() / ".email-analyzer" / "ms_token_cache.json"
GRAPH_BASE = "https://graph.microsoft.com/v1.0"

# --- Cleanup config ---
PROTECTED_SENDERS = {"ash.davis@hotmail.com"}
BATCH_SIZE = 20  # Graph API $batch limit
MAX_CONCURRENT = 4  # parallel queries
PAGE_SIZE = 999  # Graph API max per page

# --- State ---
session = requests.Session()
session.headers["Content-Type"] = "application/json"


def authenticate():
    """MSAL device code auth with token caching."""
    print(f"  Token cache: {TOKEN_CACHE_FILE}", flush=True)
    cache = msal.SerializableTokenCache()
    if TOKEN_CACHE_FILE.exists():
        print("  Loading cached token...", flush=True)
        cache.deserialize(TOKEN_CACHE_FILE.read_text())
    else:
        print("  No token cache found, will need device code auth", flush=True)

    app = msal.PublicClientApplication(
        CLIENT_ID,
        authority=f"https://login.microsoftonline.com/{TENANT_ID}",
        token_cache=cache,
    )

    accounts = app.get_accounts()
    if accounts:
        result = app.acquire_token_silent(SCOPES, account=accounts[0])
        if result and "access_token" in result:
            print(f"  Authenticated as {accounts[0]['username']} (cached)")
            save_cache(cache)
            return result["access_token"]

    print("\n" + "=" * 60)
    print("MICROSOFT AUTHENTICATION REQUIRED")
    print("=" * 60)
    flow = app.initiate_device_flow(scopes=SCOPES)
    if "user_code" not in flow:
        raise RuntimeError(f"Failed to create device flow: {flow.get('error_description')}")
    print(flow["message"])
    print("=" * 60 + "\n")
    result = app.acquire_token_by_device_flow(flow)
    if "access_token" in result:
        save_cache(cache)
        print("  Authentication successful!")
        return result["access_token"]
    raise RuntimeError(f"Auth failed: {result.get('error_description')}")


def save_cache(cache):
    if cache.has_state_changed:
        TOKEN_CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
        TOKEN_CACHE_FILE.write_text(cache.serialize())


def api_get(url, params=None, retries=3):
    """GET with retry on 429."""
    for _attempt in range(retries):
        resp = session.get(url, params=params, timeout=30)
        if resp.status_code == 429:
            wait = int(resp.headers.get("Retry-After", 10))
            print(f"    Rate limited, waiting {wait}s...")
            time.sleep(wait)
            continue
        if resp.status_code == 401:
            token = authenticate()
            session.headers["Authorization"] = f"Bearer {token}"
            continue
        resp.raise_for_status()
        return resp.json()
    raise RuntimeError(f"Failed after {retries} retries: {url}")


def api_post(url, json_data, retries=3):
    """POST with retry on 429."""
    for _attempt in range(retries):
        resp = session.post(url, json=json_data, timeout=60)
        if resp.status_code == 429:
            wait = int(resp.headers.get("Retry-After", 10))
            print(f"    Rate limited, waiting {wait}s...")
            time.sleep(wait)
            continue
        if resp.status_code == 401:
            token = authenticate()
            session.headers["Authorization"] = f"Bearer {token}"
            continue
        resp.raise_for_status()
        return resp.json()
    raise RuntimeError(f"Failed after {retries} retries: {url}")


def collect_message_ids(folder, odata_filter=None, label=""):
    """Collect all message IDs from a folder, optionally filtered."""
    url = f"{GRAPH_BASE}/me/mailFolders/{folder}/messages"
    params = {"$top": PAGE_SIZE, "$select": "id", "$orderby": "receivedDateTime asc"}
    if odata_filter:
        params["$filter"] = odata_filter
        # OData filter + orderby can conflict; remove orderby
        del params["$orderby"]

    ids = []
    page = 0
    while url:
        data = api_get(url, params if page == 0 else None)
        batch = [m["id"] for m in data.get("value", [])]
        ids.extend(batch)
        next_link = data.get("@odata.nextLink")
        if next_link:
            url = next_link
            page += 1
        else:
            break
    return ids


def batch_delete(message_ids, label="", dry_run=False):
    """Delete messages in batches of 20 using Graph $batch API."""
    if not message_ids:
        return 0

    total = len(message_ids)
    deleted = 0
    batch_url = f"{GRAPH_BASE}/$batch"

    for i in range(0, total, BATCH_SIZE):
        chunk = message_ids[i : i + BATCH_SIZE]
        if dry_run:
            deleted += len(chunk)
            continue

        requests_payload = []
        for j, mid in enumerate(chunk):
            requests_payload.append(
                {
                    "id": str(j),
                    "method": "DELETE",
                    "url": f"/me/messages/{mid}",
                }
            )

        try:
            result = api_post(batch_url, {"requests": requests_payload})
            successes = sum(
                1 for r in result.get("responses", []) if 200 <= r.get("status", 500) < 300
            )
            deleted += successes
        except Exception as e:
            print(f"    Batch error at offset {i}: {e}")

        # Progress
        pct = min(100, (i + len(chunk)) / total * 100)
        print(f"\r    {label}: {deleted}/{total} deleted ({pct:.0f}%)", end="", flush=True)

        # Gentle throttle to avoid 429
        if (i // BATCH_SIZE) % 10 == 9:
            time.sleep(0.5)

    print()
    return deleted


def collect_ids_for_sender(sender, cutoff_iso, folder="inbox"):
    """Query inbox for a sender's emails before cutoff date."""
    odata_filter = (
        f"from/emailAddress/address eq '{sender}' " f"and receivedDateTime lt {cutoff_iso}"
    )
    try:
        return collect_message_ids(folder, odata_filter, label=sender)
    except Exception as e:
        print(f"    Error querying {sender}: {e}")
        return []


def load_marketing_senders():
    """Load senders from classification data."""
    corpus_path = os.path.expanduser("~/data/outputs/email_corpus.json")
    clf_path = os.path.expanduser("~/data/outputs/classify_report_batch.json")

    if not os.path.exists(corpus_path) or not os.path.exists(clf_path):
        print("ERROR: Classification data not found at ~/data/outputs/")
        sys.exit(1)

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

    spam_categories = {
        "Spam & Junk",
        "Newsletters & Marketing",
        "Shopping & E-commerce",
        "Marketing & Newsletters",
        "Shipping & E-commerce",
        "Events & Entertainment",
        "Events & Conferences",
        "Events",
    }
    marketing_signals = [
        "noreply",
        "no-reply",
        "newsletter",
        "marketing",
        "promo",
        "deals",
        "offers",
        "sale",
        "welcome@",
        "mail.beehiiv",
        "substack.com",
        "mailchimp",
        "sendgrid",
    ]

    senders = []
    for sender, cats in sender_cats.items():
        primary_cat = max(cats, key=cats.get)
        is_marketing = primary_cat in spam_categories or any(
            sig in sender.lower() for sig in marketing_signals
        )
        if is_marketing and sender.lower() not in PROTECTED_SENDERS:
            senders.append((sender, sum(cats.values()), primary_cat))

    senders.sort(key=lambda x: x[1], reverse=True)
    return senders


def main():
    parser = argparse.ArgumentParser(description="Email cleanup via Graph API")
    parser.add_argument("--dry-run", action="store_true", help="Count without deleting")
    parser.add_argument("--skip-junk", action="store_true", help="Skip emptying Junk folder")
    parser.add_argument("--skip-deleted", action="store_true", help="Skip emptying Deleted Items")
    parser.add_argument("--skip-senders", action="store_true", help="Skip sender-based cleanup")
    parser.add_argument(
        "--days", type=int, default=3, help="Keep emails newer than N days (default: 3)"
    )
    args = parser.parse_args()

    mode = "DRY RUN" if args.dry_run else "LIVE"
    print(f"\n{'='*60}")
    print(f"  EMAIL CLEANUP — {mode}")
    print(f"{'='*60}\n")

    # Authenticate
    print("[1/4] Authenticating...")
    token = authenticate()
    session.headers["Authorization"] = f"Bearer {token}"

    cutoff = datetime.now(UTC) - timedelta(days=args.days)
    cutoff_iso = cutoff.strftime("%Y-%m-%dT%H:%M:%SZ")
    print(f"  Cutoff: delete emails before {cutoff_iso} ({args.days} days ago)")

    total_deleted = 0

    # Phase 1: Empty Junk
    if not args.skip_junk:
        print("\n[2/4] Emptying Junk Email folder...")
        junk_ids = collect_message_ids("junkemail")
        print(f"  Found {len(junk_ids)} emails in Junk")
        deleted = batch_delete(junk_ids, label="Junk", dry_run=args.dry_run)
        total_deleted += deleted
        print(f"  Junk: {deleted} deleted")
    else:
        print("\n[2/4] Skipping Junk folder")

    # Phase 2: Empty Deleted Items
    if not args.skip_deleted:
        print("\n[3/4] Emptying Deleted Items folder...")
        del_ids = collect_message_ids("deleteditems")
        print(f"  Found {len(del_ids)} emails in Deleted Items")
        deleted = batch_delete(del_ids, label="Deleted Items", dry_run=args.dry_run)
        total_deleted += deleted
        print(f"  Deleted Items: {deleted} deleted")
    else:
        print("\n[3/4] Skipping Deleted Items folder")

    # Phase 3: Marketing senders
    if not args.skip_senders:
        print("\n[4/4] Loading marketing senders from classification data...")
        senders = load_marketing_senders()
        print(f"  Found {len(senders)} marketing senders (excluding {PROTECTED_SENDERS})")
        print(f"  Querying inbox for emails older than {args.days} days...")

        all_ids = []
        completed = 0

        with ThreadPoolExecutor(max_workers=MAX_CONCURRENT) as pool:
            futures = {
                pool.submit(collect_ids_for_sender, sender, cutoff_iso): sender
                for sender, count, cat in senders
            }
            for future in as_completed(futures):
                sender = futures[future]
                try:
                    ids = future.result()
                    if ids:
                        all_ids.extend(ids)
                except Exception as e:
                    print(f"    Error for {sender}: {e}")
                completed += 1
                if completed % 50 == 0:
                    print(
                        f"    Queried {completed}/{len(senders)} senders, {len(all_ids)} emails to delete so far..."
                    )

        print(f"  Total emails to delete from marketing senders: {len(all_ids)}")
        if all_ids:
            deleted = batch_delete(all_ids, label="Marketing", dry_run=args.dry_run)
            total_deleted += deleted
            print(f"  Marketing senders: {deleted} deleted")
    else:
        print("\n[4/4] Skipping sender-based cleanup")

    print(f"\n{'='*60}")
    print(
        f"  CLEANUP COMPLETE — {total_deleted} total emails {'would be ' if args.dry_run else ''}deleted"
    )
    print(f"{'='*60}\n")


if __name__ == "__main__":
    main()
