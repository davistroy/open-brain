"""
Archive Inbox Emails by Year — Move remaining inbox emails to Archive/YYYY folders.

Scans inbox, groups by receivedDateTime year, batch-moves to Archive subfolders.
Keeps current year (2026) emails in inbox.
"""

from __future__ import annotations

import sys
import time
from pathlib import Path
from typing import Any

import msal  # type: ignore[import-untyped]
import requests

sys.stdout.reconfigure(line_buffering=True, encoding="utf-8", errors="replace")  # type: ignore[union-attr]

CLIENT_ID = "14d82eec-204b-4c2f-b7e8-296a70dab67e"
SCOPES = ["Mail.ReadWrite", "User.Read"]
TOKEN_CACHE_FILE = Path.home() / ".email-analyzer" / "ms_token_cache.json"
GRAPH_BASE = "https://graph.microsoft.com/v1.0"
PAGE_SIZE = 999
BATCH_SIZE = 20

# Keep current year in inbox
KEEP_IN_INBOX_YEAR = 2026

cache = msal.SerializableTokenCache()
cache.deserialize(TOKEN_CACHE_FILE.read_text())
app = msal.PublicClientApplication(
    CLIENT_ID, authority="https://login.microsoftonline.com/common", token_cache=cache
)

session = requests.Session()
session.headers.update({"Content-Type": "application/json"})


def get_token() -> str:
    result: dict[str, Any] = app.acquire_token_silent(SCOPES, account=app.get_accounts()[0])  # type: ignore[assignment]
    return result["access_token"]


def api_get(url: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    for attempt in range(5):
        try:
            resp = session.get(url, params=params, timeout=30)
        except requests.exceptions.ReadTimeout:
            time.sleep(2**attempt)
            continue
        if resp.status_code == 429:
            time.sleep(int(resp.headers.get("Retry-After", 10)))
            continue
        if resp.status_code == 401:
            session.headers["Authorization"] = f"Bearer {get_token()}"
            continue
        resp.raise_for_status()
        return resp.json()
    raise RuntimeError("Failed after 5 retries")


def api_post(url: str, json_data: dict[str, Any]) -> dict[str, Any]:
    for attempt in range(5):
        try:
            resp = session.post(url, json=json_data, timeout=60)
        except requests.exceptions.ReadTimeout:
            time.sleep(2**attempt)
            continue
        if resp.status_code == 429:
            time.sleep(int(resp.headers.get("Retry-After", 10)))
            continue
        if resp.status_code == 401:
            session.headers["Authorization"] = f"Bearer {get_token()}"
            continue
        resp.raise_for_status()
        return resp.json()
    raise RuntimeError("Failed after 5 retries")


def main() -> None:
    session.headers["Authorization"] = f"Bearer {get_token()}"

    print(f"{'='*60}", flush=True)
    print("  ARCHIVE BY YEAR — Move inbox emails to Archive/YYYY", flush=True)
    print(f"  Keep in inbox: {KEEP_IN_INBOX_YEAR} and newer", flush=True)
    print(f"{'='*60}\n", flush=True)

    # Step 1: Find Archive folder and year subfolders
    print("[1/3] Finding Archive year folders...", flush=True)
    folders = api_get(
        f"{GRAPH_BASE}/me/mailFolders", params={"$top": 50, "$select": "id,displayName"}
    )
    archive_id: str | None = None
    for f in folders.get("value", []):
        if f["displayName"] == "Archive":
            archive_id = f["id"]
            break

    if not archive_id:
        print("  ERROR: Archive folder not found!", flush=True)
        sys.exit(1)

    # Get year subfolders
    year_folders: dict[int, str] = {}
    children = api_get(
        f"{GRAPH_BASE}/me/mailFolders/{archive_id}/childFolders",
        params={"$top": 50, "$select": "id,displayName"},
    )
    for cf in children.get("value", []):
        name: str = cf["displayName"]
        if name.isdigit() and len(name) == 4:
            year_folders[int(name)] = cf["id"]

    print(f"  Found year folders: {sorted(year_folders.keys())}", flush=True)

    # Step 2: Scan inbox, group by year
    print("\n[2/3] Scanning inbox...", flush=True)
    url: str | None = f"{GRAPH_BASE}/me/mailFolders/inbox/messages"
    params: dict[str, Any] = {"$top": PAGE_SIZE, "$select": "id,receivedDateTime"}
    by_year: dict[int, list[str]] = {}
    keep_count = 0
    total = 0

    while url:
        data = api_get(url, params if total == 0 else None)
        for msg in data.get("value", []):
            total += 1
            date_str: str = msg.get("receivedDateTime", "")
            year = int(date_str[:4]) if date_str else 0

            if year >= KEEP_IN_INBOX_YEAR:
                keep_count += 1
                continue

            if year not in year_folders:
                # Create the folder if it doesn't exist
                print(f"  Creating Archive/{year}...", flush=True)
                resp = session.post(
                    f"{GRAPH_BASE}/me/mailFolders/{archive_id}/childFolders",
                    json={"displayName": str(year)},
                    timeout=30,
                )
                if resp.status_code == 201:
                    year_folders[year] = resp.json()["id"]
                else:
                    print(f"  Error creating {year}: {resp.status_code}", flush=True)
                    keep_count += 1
                    continue

            by_year.setdefault(year, []).append(msg["id"])

        url = data.get("@odata.nextLink")
        if total % 5000 == 0:
            print(f"  {total:,} scanned...", flush=True)

    print(f"\n  Scan complete: {total:,} total", flush=True)
    print(f"  Keep in inbox ({KEEP_IN_INBOX_YEAR}+): {keep_count:,}", flush=True)
    print("  Move to archive:", flush=True)
    for year in sorted(by_year.keys()):
        print(f"    {year}: {len(by_year[year]):,} emails", flush=True)

    move_total = sum(len(ids) for ids in by_year.values())
    print(f"  Total to move: {move_total:,}", flush=True)

    # Step 3: Batch move by year
    print(f"\n[3/3] Moving {move_total:,} emails to Archive year folders...", flush=True)
    moved = 0
    errors = 0
    batch_url = f"{GRAPH_BASE}/$batch"

    for year in sorted(by_year.keys()):
        ids = by_year[year]
        dest_id: str | None = year_folders.get(year)
        if not dest_id:
            print(f"  Skipping {year} — no folder", flush=True)
            continue

        print(f"  {year}: moving {len(ids):,} emails...", flush=True)

        for i in range(0, len(ids), BATCH_SIZE):
            chunk = ids[i : i + BATCH_SIZE]
            reqs: list[dict[str, Any]] = [
                {
                    "id": str(j),
                    "method": "POST",
                    "url": f"/me/messages/{mid}/move",
                    "headers": {"Content-Type": "application/json"},
                    "body": {"destinationId": dest_id},
                }
                for j, mid in enumerate(chunk)
            ]

            try:
                result = api_post(batch_url, {"requests": reqs})
                for r in result.get("responses", []):
                    if r.get("status") in (200, 201):
                        moved += 1
                    else:
                        errors += 1
            except Exception:
                errors += len(chunk)

            if (i // BATCH_SIZE) % 25 == 0 and i > 0:
                print(f"    {year}: {min(i + BATCH_SIZE, len(ids)):,}/{len(ids):,}", flush=True)
            if (i // BATCH_SIZE) % 10 == 9:
                time.sleep(0.5)

        print(f"    {year}: done", flush=True)

    print(f"\n{'='*60}", flush=True)
    print("  ARCHIVE COMPLETE", flush=True)
    print(f"  Moved: {moved:,}", flush=True)
    print(f"  Errors: {errors:,}", flush=True)
    print(f"  Kept in inbox: {keep_count:,} ({KEEP_IN_INBOX_YEAR}+)", flush=True)
    print(f"{'='*60}", flush=True)


if __name__ == "__main__":
    main()
