"""
Email Cleanup Pass 6 — Pattern-based automated sender sweep.

Instead of relying on classification data, matches sender address patterns
directly to identify automated/marketing senders. Flipped approach: protect
personal email domains and known keepers, delete everything matching patterns.
"""

import argparse
import re
import sys
import time
from collections import Counter
from pathlib import Path

import msal
import requests

sys.stdout.reconfigure(line_buffering=True)

CLIENT_ID = "14d82eec-204b-4c2f-b7e8-296a70dab67e"
TENANT_ID = "common"
SCOPES = ["Mail.ReadWrite", "User.Read"]
TOKEN_CACHE_FILE = Path.home() / ".email-analyzer" / "ms_token_cache.json"
GRAPH_BASE = "https://graph.microsoft.com/v1.0"
BATCH_SIZE = 20
PAGE_SIZE = 999

# --- PROTECTED: never delete from these ---
PROTECTED_ADDRESSES = {
    "troy.davis@hotmail.com",
    "ash.davis@hotmail.com",
    "km4ack@arrl.net",
}

# Personal email domains — real humans, keep all
PERSONAL_DOMAINS = {
    "gmail.com",
    "hotmail.com",
    "outlook.com",
    "yahoo.com",
    "aol.com",
    "comcast.net",
    "att.net",
    "icloud.com",
    "me.com",
    "mac.com",
    "live.com",
    "msn.com",
    "sbcglobal.net",
    "bellsouth.net",
    "charter.net",
    "cox.net",
    "verizon.net",
    "earthlink.net",
    "windstream.net",
    "frontier.com",
    "centurylink.net",
}

# --- AUTOMATED SENDER PATTERNS (local part) ---
AUTO_LOCAL_PATTERNS = [
    "noreply",
    "donotreply",
    "no-reply",
    "do-not-reply",
    "do_not_reply",
    "newsletter",
    "newsletters",
    "digest",
    "daily",
    "weekly",
    "promo",
    "promotions",
    "marketing",
    "offers",
    "deals",
    "sale",
    "notifications",
    "notification",
    "alert",
    "alerts",
    "updates",
    "info@",
    "hello@",
    "team@",
    "welcome@",
    "support@",
    "news@",
    "editor@",
    "editorial@",
    "mail@",
    "email@",
    "contact@",
    "subscribe",
    "unsubscribe",
    "feedback@",
    "survey@",
    "billing@",
    "invoice@",
    "receipt@",
    "shipping@",
    "order@",
    "orders@",
    "rewards@",
    "loyalty@",
    "members@",
    "store@",
    "shop@",
]

# --- AUTOMATED SENDER DOMAIN PATTERNS ---
AUTO_DOMAIN_PATTERNS = [
    r"^mail\.",
    r"^email\.",
    r"^email\d?\.",
    r"^e\d?\.",
    r"^e\.",
    r"^promo\.",
    r"^news\.",
    r"^marketing\.",
    r"^send\.",
    r"^reply\.",
    r"^bounce\.",
    r"^notifications?\.",
    r"^alerts?\.",
    r"^campaign\.",
    r"^bulk\.",
]
AUTO_DOMAIN_RE = [re.compile(p, re.IGNORECASE) for p in AUTO_DOMAIN_PATTERNS]

# Known bulk/newsletter platform domains
PLATFORM_DOMAINS = {
    "beehiiv.com",
    "substack.com",
    "groups.io",
    "mailchimp.com",
    "sendgrid.net",
    "constantcontact.com",
    "mailgun.org",
    "amazonses.com",
    "exacttarget.com",
    "sailthru.com",
    "responsys.net",
    "mktomail.com",
    "hubspotemail.net",
    "createsend.com",
    "cmail19.com",
    "cmail20.com",
    "feedproxy.google.com",
    "feedblitz.com",
    "returnpath.net",
    "litmus.com",
}


def is_automated_sender(address):
    """Determine if a sender address is automated/marketing."""
    address = address.lower().strip()
    local, _, domain = address.partition("@")
    if not domain:
        return False

    # Check protected
    if address in PROTECTED_ADDRESSES:
        return False

    # Check personal domains — these are humans
    if domain in PERSONAL_DOMAINS:
        return False

    # Check local part patterns
    for pattern in AUTO_LOCAL_PATTERNS:
        if pattern.rstrip("@") in local:
            return True

    # Check domain patterns (subdomains like mail.company.com)
    for regex in AUTO_DOMAIN_RE:
        if regex.search(domain):
            return True

    # Check known platform domains (or subdomains of them)
    for platform in PLATFORM_DOMAINS:
        if domain == platform or domain.endswith("." + platform):
            return True

    return False


def authenticate():
    cache = msal.SerializableTokenCache()
    if TOKEN_CACHE_FILE.exists():
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
            return result["access_token"], app, cache

    print("\nMICROSOFT AUTHENTICATION REQUIRED", flush=True)
    flow = app.initiate_device_flow(scopes=SCOPES)
    print(flow["message"], flush=True)
    result = app.acquire_token_by_device_flow(flow)
    if "access_token" in result:
        TOKEN_CACHE_FILE.write_text(cache.serialize())
        return result["access_token"], app, cache
    raise RuntimeError(f"Auth failed: {result.get('error_description')}")


session = requests.Session()
session.headers["Content-Type"] = "application/json"
_app = None
_cache = None


def refresh_token():
    global _app, _cache
    accounts = _app.get_accounts()
    result = _app.acquire_token_silent(SCOPES, account=accounts[0])
    return result["access_token"]


def api_get(url, params=None):
    for attempt in range(5):
        try:
            resp = session.get(url, params=params, timeout=30)
        except requests.exceptions.ReadTimeout:
            time.sleep(2**attempt)
            continue
        if resp.status_code == 429:
            wait = int(resp.headers.get("Retry-After", 10))
            print(f"    Rate limited, waiting {wait}s...", flush=True)
            time.sleep(wait)
            continue
        if resp.status_code == 401:
            session.headers["Authorization"] = f"Bearer {refresh_token()}"
            continue
        resp.raise_for_status()
        return resp.json()
    raise RuntimeError("Failed after 5 retries")


def api_post(url, json_data):
    for attempt in range(5):
        try:
            resp = session.post(url, json=json_data, timeout=60)
        except requests.exceptions.ReadTimeout:
            time.sleep(2**attempt)
            continue
        if resp.status_code == 429:
            wait = int(resp.headers.get("Retry-After", 10))
            time.sleep(wait)
            continue
        if resp.status_code == 401:
            session.headers["Authorization"] = f"Bearer {refresh_token()}"
            continue
        resp.raise_for_status()
        return resp.json()
    raise RuntimeError("Failed after 5 retries")


def main():
    global _app, _cache

    parser = argparse.ArgumentParser(description="Pass 6: Pattern-based automated sender cleanup")
    parser.add_argument("--dry-run", action="store_true", help="Scan and report only, don't delete")
    args = parser.parse_args()

    mode = "DRY RUN" if args.dry_run else "LIVE"
    print(f"\n{'='*60}", flush=True)
    print(f"  EMAIL CLEANUP PASS 6 — Pattern Sweep ({mode})", flush=True)
    print(f"  Protected addresses: {len(PROTECTED_ADDRESSES)}", flush=True)
    print(f"  Protected domains: {len(PERSONAL_DOMAINS)} personal email domains", flush=True)
    print(f"{'='*60}\n", flush=True)

    print("[1/3] Authenticating...", flush=True)
    token, _app, _cache = authenticate()
    session.headers["Authorization"] = f"Bearer {token}"

    # Phase 1: Scan entire inbox, classify each sender
    print("\n[2/3] Scanning inbox for automated senders...", flush=True)
    url = f"{GRAPH_BASE}/me/mailFolders/inbox/messages"
    params = {"$top": PAGE_SIZE, "$select": "id,from"}

    auto_ids = []
    keep_count = 0
    auto_senders = Counter()
    keep_senders = Counter()
    total = 0
    page = 0

    while url:
        data = api_get(url, params if page == 0 else None)
        for msg in data.get("value", []):
            addr = msg.get("from", {}).get("emailAddress", {}).get("address", "unknown").lower()
            total += 1
            if is_automated_sender(addr):
                auto_ids.append(msg["id"])
                auto_senders[addr] += 1
            else:
                keep_count += 1
                keep_senders[addr] += 1

        url = data.get("@odata.nextLink")
        page += 1
        if total % 10000 == 0:
            print(
                f"  Scanned {total:,} | Auto: {len(auto_ids):,} | Keep: {keep_count:,}", flush=True
            )

    print(f"\n  Scan complete: {total:,} total emails", flush=True)
    print(f"  Automated/marketing (to delete): {len(auto_ids):,}", flush=True)
    print(f"  Personal/keep: {keep_count:,}", flush=True)
    print(f"  Unique auto senders: {len(auto_senders):,}", flush=True)
    print(f"  Unique keep senders: {len(keep_senders):,}", flush=True)

    print("\n  Top 20 automated senders to delete:", flush=True)
    for addr, count in auto_senders.most_common(20):
        print(f"    {count:>5}  {addr}", flush=True)

    print("\n  Top 20 senders being KEPT:", flush=True)
    for addr, count in keep_senders.most_common(20):
        print(f"    {count:>5}  {addr}", flush=True)

    if args.dry_run:
        print("\n  DRY RUN — no emails deleted.", flush=True)
        print(f"  Would delete {len(auto_ids):,} emails, keep {keep_count:,}", flush=True)
        return

    # Phase 2: Delete
    print(f"\n[3/3] Deleting {len(auto_ids):,} automated emails...", flush=True)
    deleted = 0
    batch_url = f"{GRAPH_BASE}/$batch"

    for i in range(0, len(auto_ids), BATCH_SIZE):
        chunk = auto_ids[i : i + BATCH_SIZE]
        reqs = [
            {"id": str(j), "method": "DELETE", "url": f"/me/messages/{mid}"}
            for j, mid in enumerate(chunk)
        ]
        try:
            result = api_post(batch_url, {"requests": reqs})
            deleted += sum(
                1 for r in result.get("responses", []) if 200 <= r.get("status", 500) < 300
            )
        except Exception as e:
            print(f"    Batch error: {e}", flush=True)

        pct = min(100, (i + len(chunk)) / len(auto_ids) * 100)
        if (i // BATCH_SIZE) % 50 == 0:
            print(f"    {deleted:,}/{len(auto_ids):,} deleted ({pct:.0f}%)", flush=True)
        if (i // BATCH_SIZE) % 10 == 9:
            time.sleep(0.5)

    print(f"\n{'='*60}", flush=True)
    print(f"  PASS 6 COMPLETE — {deleted:,} emails deleted, {keep_count:,} kept", flush=True)
    print(f"{'='*60}\n", flush=True)


if __name__ == "__main__":
    main()
