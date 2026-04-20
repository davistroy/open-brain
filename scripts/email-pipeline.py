#!/usr/bin/env python3
"""
Email Classification Pipeline for Open Brain.

Fetches new emails from Hotmail (Graph API) and Gmail (Gmail API), classifies
via cost-tiered approach (T0 sender -> T0 keyword -> T1 Jetson LLM), and
organizes into folders/labels. Runs via cron every 15 min on open-brain-vm.

Usage:
    python email-pipeline.py --provider both              # normal run
    python email-pipeline.py --provider hotmail --dry-run  # classify only
    python email-pipeline.py --setup --provider hotmail    # first-time auth
    python email-pipeline.py --summary                     # daily summary
    python email-pipeline.py --status                      # pipeline stats
"""

from __future__ import annotations

import argparse
import json
import logging
import re
import sqlite3
import subprocess
import sys
import time
from collections import Counter
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import msal  # type: ignore[import-untyped]
import requests
import yaml  # type: ignore[import-untyped]

sys.stdout.reconfigure(line_buffering=True)  # type: ignore[union-attr]
sys.stderr.reconfigure(line_buffering=True)  # type: ignore[union-attr]
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("email-pipeline")

# --- Paths & constants ---
PIPE_DIR = Path.home() / ".email-pipeline"
DB_PATH = PIPE_DIR / "pipeline.db"
MS_TOKEN_CACHE = PIPE_DIR / "ms_token_cache.json"
GMAIL_CREDS = PIPE_DIR / "gmail_credentials.json"
GMAIL_TOKEN = PIPE_DIR / "gmail_token.json"
CONFIG_PATH = Path(__file__).resolve().parent.parent / "config" / "email-categories.yaml"

MS_CLIENT_ID = "14d82eec-204b-4c2f-b7e8-296a70dab67e"
MS_SCOPES = ["Mail.ReadWrite", "User.Read"]
GRAPH = "https://graph.microsoft.com/v1.0"
API_DELAY = 0.1
BATCH = 50


# ── Config ───────────────────────────────────────────────────────────────────


def load_config() -> dict[str, Any]:
    """Load and normalize email-categories.yaml."""
    if not CONFIG_PATH.exists():
        sys.exit(f"Config not found: {CONFIG_PATH}")
    cfg: dict[str, Any] = yaml.safe_load(CONFIG_PATH.read_text())
    cfg["_categories"] = {c for cats in cfg["groups"].values() for c in cats}
    cfg["sender_rules"] = {k.lower(): v for k, v in cfg["sender_rules"].items()}
    cfg["keyword_rules"] = {c: [w.lower() for w in ws] for c, ws in cfg["keyword_rules"].items()}
    return cfg


# ── Database ─────────────────────────────────────────────────────────────────


def init_db() -> sqlite3.Connection:
    """Initialize SQLite with pipeline tables."""
    PIPE_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH), timeout=30)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS processed_emails (
            message_id TEXT PRIMARY KEY, provider TEXT, sender TEXT,
            subject TEXT, category TEXT, confidence REAL, tier TEXT,
            folder_id TEXT, processed_at TEXT DEFAULT (datetime('now')),
            moved INTEGER DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS corrections (
            id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT,
            provider TEXT, old_category TEXT, new_category TEXT,
            detected_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS folder_map (
            provider TEXT, category TEXT, folder_id TEXT, folder_name TEXT,
            PRIMARY KEY (provider, category)
        );
        CREATE TABLE IF NOT EXISTS daily_summaries (
            date TEXT PRIMARY KEY, email_count INTEGER,
            categories_json TEXT, summary_text TEXT,
            posted_to_brain INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_pe_date ON processed_emails(processed_at);
    """)
    conn.commit()
    return conn


def is_processed(conn: sqlite3.Connection, mid: str) -> bool:
    return (
        conn.execute("SELECT 1 FROM processed_emails WHERE message_id=?", (mid,)).fetchone()
        is not None
    )


def record_email(
    conn: sqlite3.Connection,
    mid: str,
    provider: str,
    sender: str,
    subject: str,
    cat: str,
    conf: float,
    tier: str,
    fid: str,
    moved: bool,
) -> None:
    conn.execute(
        "INSERT OR REPLACE INTO processed_emails "
        "(message_id,provider,sender,subject,category,confidence,tier,folder_id,moved) "
        "VALUES(?,?,?,?,?,?,?,?,?)",
        (mid, provider, sender, subject[:500], cat, conf, tier, fid, int(moved)),
    )
    conn.commit()


def record_correction(
    conn: sqlite3.Connection,
    mid: str,
    provider: str,
    old_cat: str,
    new_cat: str,
) -> None:
    conn.execute(
        "INSERT INTO corrections(message_id,provider,old_category,new_category) VALUES(?,?,?,?)",
        (mid, provider, old_cat, new_cat),
    )
    conn.commit()


def get_folder_id(conn: sqlite3.Connection, provider: str, category: str) -> str | None:
    r = conn.execute(
        "SELECT folder_id FROM folder_map WHERE provider=? AND category=?", (provider, category)
    ).fetchone()
    return r[0] if r else None


def save_folder_id(
    conn: sqlite3.Connection,
    provider: str,
    category: str,
    fid: str,
    fname: str,
) -> None:
    conn.execute(
        "INSERT OR REPLACE INTO folder_map(provider,category,folder_id,folder_name) VALUES(?,?,?,?)",
        (provider, category, fid, fname),
    )
    conn.commit()


# ── Graph API helpers ────────────────────────────────────────────────────────


def _graph_request(
    session: requests.Session,
    method: str,
    url: str,
    json_data: dict[str, Any] | None = None,
    refresh_fn: Any = None,
) -> dict[str, Any] | None:
    """Generic Graph API call with retry, rate limit, and 401 refresh."""
    for attempt in range(5):
        try:
            resp = getattr(session, method)(url, json=json_data, timeout=30)
        except requests.exceptions.RequestException as e:
            log.warning(f"Request error (attempt {attempt+1}): {e}")
            time.sleep(2**attempt)
            continue
        if resp.status_code == 429:
            time.sleep(int(resp.headers.get("Retry-After", 10)))
            continue
        if resp.status_code == 401 and refresh_fn and refresh_fn():
            continue
        if resp.status_code >= 400:
            log.error(f"API {resp.status_code}: {resp.text[:200]}")
            return None
        time.sleep(API_DELAY)
        return resp.json() if resp.text.strip() else {}
    return None


# ── Hotmail Backend ──────────────────────────────────────────────────────────


class HotmailBackend:
    def __init__(self, conn: sqlite3.Connection, cfg: dict[str, Any]) -> None:
        self.conn = conn
        self.cfg = cfg
        self.session = requests.Session()
        self.session.headers["Content-Type"] = "application/json"
        self._cache: msal.SerializableTokenCache = msal.SerializableTokenCache()
        self._app: msal.PublicClientApplication | None = None

    def authenticate(self, interactive: bool = False) -> bool:
        if MS_TOKEN_CACHE.exists():
            self._cache.deserialize(MS_TOKEN_CACHE.read_text())
        self._app = msal.PublicClientApplication(
            MS_CLIENT_ID,
            authority="https://login.microsoftonline.com/common",
            token_cache=self._cache,
        )
        accounts = self._app.get_accounts()
        if accounts:
            r: dict[str, Any] = self._app.acquire_token_silent(MS_SCOPES, account=accounts[0])
            if r and "access_token" in r:
                self.session.headers["Authorization"] = f"Bearer {r['access_token']}"
                self._save_cache()
                log.info(f"Hotmail: cached auth as {accounts[0]['username']}")
                return True
        if not interactive:
            log.error("Hotmail: no cached token. Run --setup --provider hotmail")
            return False
        flow: dict[str, Any] = self._app.initiate_device_flow(scopes=MS_SCOPES)
        if "user_code" not in flow:
            log.error(f"Device flow failed: {flow.get('error_description')}")
            return False
        print(f"\n{'='*60}\nMICROSOFT AUTHENTICATION\n{'='*60}\n{flow['message']}\n{'='*60}\n")
        r = self._app.acquire_token_by_device_flow(flow)
        if "access_token" in r:
            self.session.headers["Authorization"] = f"Bearer {r['access_token']}"
            self._save_cache()
            log.info("Hotmail: authenticated")
            return True
        log.error(f"Auth failed: {r.get('error_description')}")
        return False

    def _save_cache(self) -> None:
        PIPE_DIR.mkdir(parents=True, exist_ok=True)
        MS_TOKEN_CACHE.write_text(self._cache.serialize())

    def _refresh(self) -> bool:
        if self._app is None:
            return False
        accounts = self._app.get_accounts()
        if accounts:
            r: dict[str, Any] = self._app.acquire_token_silent(MS_SCOPES, account=accounts[0])
            if r and "access_token" in r:
                self.session.headers["Authorization"] = f"Bearer {r['access_token']}"
                self._save_cache()
                return True
        return False

    def _get(self, url: str, params: dict[str, Any] | None = None) -> dict[str, Any] | None:
        return _graph_request(
            self.session, "get", url if not params else url, refresh_fn=self._refresh
        )

    def _post(self, url: str, data: dict[str, Any]) -> dict[str, Any] | None:
        return _graph_request(self.session, "post", url, json_data=data, refresh_fn=self._refresh)

    def list_folders(self) -> dict[str, str]:
        folders: dict[str, str] = {}
        data = self._get(f"{GRAPH}/me/mailFolders?$top=100")
        if not data or "value" not in data:
            return folders
        for f in data["value"]:
            folders[f["displayName"]] = f["id"]
            cdata = self._get(f"{GRAPH}/me/mailFolders/{f['id']}/childFolders?$top=100")
            if cdata and "value" in cdata:
                for c in cdata["value"]:
                    folders[c["displayName"]] = c["id"]
        return folders

    def setup_folders(self) -> None:
        existing = self.list_folders()
        inbox_id = existing.get("Inbox")
        if not inbox_id:
            return log.error("Cannot find Inbox folder")
        for cat in sorted(list(self.cfg["_categories"]) + ["Needs Review"]):
            if cat in existing:
                fid: str | None = existing[cat]
            else:
                r = self._post(
                    f"{GRAPH}/me/mailFolders/{inbox_id}/childFolders", {"displayName": cat}
                )
                fid = r.get("id") if r else None
                if not fid:
                    log.error(f"Failed to create: {cat}")
                    continue
                log.info(f"Created folder: {cat}")
            save_folder_id(self.conn, "hotmail", cat, fid, cat)
        log.info("Hotmail: folders ready")

    def fetch_inbox(self, since_hours: int = 1) -> list[dict[str, Any]]:
        since = (datetime.now(UTC) - timedelta(hours=since_hours)).strftime("%Y-%m-%dT%H:%M:%SZ")
        emails: list[dict[str, Any]] = []
        url = (
            f"{GRAPH}/me/mailFolders/inbox/messages?$top={BATCH}"
            f"&$select=id,subject,from,receivedDateTime,bodyPreview"
            f"&$filter=receivedDateTime ge {since}&$orderby=receivedDateTime desc"
        )
        while url and len(emails) < 200:
            data = self._get(url)
            if not data:
                break
            for m in data.get("value", []):
                emails.append(
                    {
                        "id": m["id"],
                        "subject": m.get("subject", ""),
                        "sender": m.get("from", {})
                        .get("emailAddress", {})
                        .get("address", "")
                        .lower(),
                        "date": m.get("receivedDateTime", ""),
                        "preview": m.get("bodyPreview", "")[:500],
                        "provider": "hotmail",
                    }
                )
            url = data.get("@odata.nextLink")
        return emails

    def move_email(self, mid: str, fid: str) -> bool:
        return self._post(f"{GRAPH}/me/messages/{mid}/move", {"destinationId": fid}) is not None

    def cleanup_spam(self) -> None:
        cutoff = (
            datetime.now(UTC) - timedelta(days=self.cfg.get("spam_max_age_days", 30))
        ).strftime("%Y-%m-%dT%H:%M:%SZ")
        folders = self.list_folders()
        junk_id, del_id = folders.get("Junk Email"), folders.get("Deleted Items")
        if not (junk_id and del_id):
            return
        url: str | None = (
            f"{GRAPH}/me/mailFolders/{junk_id}/messages?$top={BATCH}"
            f"&$select=id&$filter=receivedDateTime lt {cutoff}"
        )
        moved = 0
        while url and moved < 200:
            data = self._get(url)
            if not data:
                break
            for m in data.get("value", []):
                if self.move_email(m["id"], del_id):
                    moved += 1
            url = data.get("@odata.nextLink")
        if moved:
            log.info(f"Hotmail: trashed {moved} old spam")

    def detect_corrections(self) -> None:
        rows = self.conn.execute(
            "SELECT message_id,category,folder_id FROM processed_emails "
            "WHERE provider='hotmail' AND moved=1 AND processed_at>datetime('now','-7 days')"
        ).fetchall()
        if not rows:
            return
        fid_to_cat: dict[str, str] = dict(
            self.conn.execute(
                "SELECT folder_id,category FROM folder_map WHERE provider='hotmail'"
            ).fetchall()
        )
        found = 0
        for mid, old_cat, old_fid in rows:
            data = self._get(f"{GRAPH}/me/messages/{mid}?$select=parentFolderId")
            if not data:
                continue
            cur = data.get("parentFolderId")
            if cur and cur != old_fid:
                record_correction(
                    self.conn, mid, "hotmail", old_cat, fid_to_cat.get(cur, "unknown")
                )
                found += 1
        if found:
            log.info(f"Hotmail: {found} corrections detected")


# ── Gmail Backend ────────────────────────────────────────────────────────────


class GmailBackend:
    def __init__(self, conn: sqlite3.Connection, cfg: dict[str, Any]) -> None:
        self.conn = conn
        self.cfg = cfg
        self.svc: Any = None

    def authenticate(self, interactive: bool = False) -> bool:
        try:
            from google.auth.transport.requests import (
                Request as GReq,  # type: ignore[import-untyped]
            )
            from google.oauth2.credentials import Credentials  # type: ignore[import-untyped]
            from google_auth_oauthlib.flow import InstalledAppFlow  # type: ignore[import-untyped]
            from googleapiclient.discovery import build  # type: ignore[import-untyped]
        except ImportError:
            log.error("pip install google-auth-oauthlib google-api-python-client")
            return False
        SCOPES = ["https://www.googleapis.com/auth/gmail.modify"]
        creds: Any = None
        if GMAIL_TOKEN.exists():
            creds = Credentials.from_authorized_user_file(str(GMAIL_TOKEN), SCOPES)
        if creds and creds.expired and creds.refresh_token:
            try:
                creds.refresh(GReq())
            except Exception:
                creds = None
        if not creds or not creds.valid:
            if not interactive:
                log.error("Gmail: no valid token. Run --setup --provider gmail")
                return False
            if not GMAIL_CREDS.exists():
                log.error(f"Download OAuth JSON to {GMAIL_CREDS}")
                return False
            creds = InstalledAppFlow.from_client_secrets_file(
                str(GMAIL_CREDS), SCOPES
            ).run_local_server(port=0)
        PIPE_DIR.mkdir(parents=True, exist_ok=True)
        GMAIL_TOKEN.write_text(creds.to_json())
        self.svc = build("gmail", "v1", credentials=creds)
        log.info("Gmail: authenticated")
        return True

    def list_labels(self) -> dict[str, str]:
        r: dict[str, Any] = self.svc.users().labels().list(userId="me").execute()
        return {lb["name"]: lb["id"] for lb in r.get("labels", [])}

    def setup_labels(self) -> None:
        existing = self.list_labels()
        for cat in sorted(list(self.cfg["_categories"]) + ["Needs Review"]):
            if cat in existing:
                lid: str = existing[cat]
            else:
                try:
                    r: dict[str, Any] = (
                        self.svc.users()
                        .labels()
                        .create(
                            userId="me",
                            body={
                                "name": cat,
                                "labelListVisibility": "labelShow",
                                "messageListVisibility": "show",
                            },
                        )
                        .execute()
                    )
                    lid = r["id"]
                    log.info(f"Created label: {cat}")
                except Exception as e:
                    log.error(f"Failed to create label {cat}: {e}")
                    continue
            save_folder_id(self.conn, "gmail", cat, lid, cat)
        log.info("Gmail: labels ready")

    def fetch_inbox(self, since_hours: int = 1) -> list[dict[str, Any]]:
        since = (datetime.now(UTC) - timedelta(hours=since_hours)).strftime("%Y/%m/%d")
        emails: list[dict[str, Any]] = []
        page_token: str | None = None
        while len(emails) < 200:
            r: dict[str, Any] = (
                self.svc.users()
                .messages()
                .list(
                    userId="me", q=f"in:inbox after:{since}", maxResults=BATCH, pageToken=page_token
                )
                .execute()
            )
            for stub in r.get("messages", []):
                m: dict[str, Any] = (
                    self.svc.users()
                    .messages()
                    .get(
                        userId="me",
                        id=stub["id"],
                        format="metadata",
                        metadataHeaders=["From", "Subject"],
                    )
                    .execute()
                )
                time.sleep(API_DELAY)
                hdrs: dict[str, str] = {
                    h["name"]: h["value"]
                    for h in m.get("payload", {}).get("headers", [])
                }
                raw_from = hdrs.get("From", "")
                match = re.search(r"<([^>]+)>", raw_from)
                emails.append(
                    {
                        "id": m["id"],
                        "subject": hdrs.get("Subject", ""),
                        "sender": (match.group(1) if match else raw_from).lower().strip(),
                        "date": hdrs.get("Date", ""),
                        "preview": m.get("snippet", "")[:500],
                        "provider": "gmail",
                    }
                )
            page_token = r.get("nextPageToken")
            if not page_token:
                break
        return emails

    def label_email(self, mid: str, lid: str) -> bool:
        try:
            self.svc.users().messages().modify(
                userId="me", id=mid, body={"addLabelIds": [lid], "removeLabelIds": ["INBOX"]}
            ).execute()
            time.sleep(API_DELAY)
            return True
        except Exception as e:
            log.error(f"Label failed {mid}: {e}")
            return False

    def move_email(self, mid: str, lid: str) -> bool:
        return self.label_email(mid, lid)

    def cleanup_spam(self) -> None:
        cutoff = (
            datetime.now(UTC) - timedelta(days=self.cfg.get("spam_max_age_days", 30))
        ).strftime("%Y/%m/%d")
        trashed = 0
        pt: str | None = None
        while trashed < 200:
            r: dict[str, Any] = (
                self.svc.users()
                .messages()
                .list(userId="me", q=f"in:spam before:{cutoff}", maxResults=BATCH, pageToken=pt)
                .execute()
            )
            for m in r.get("messages", []):
                try:
                    self.svc.users().messages().trash(userId="me", id=m["id"]).execute()
                    trashed += 1
                    time.sleep(API_DELAY)
                except Exception:
                    pass
            pt = r.get("nextPageToken")
            if not pt:
                break
        if trashed:
            log.info(f"Gmail: trashed {trashed} old spam")

    def detect_corrections(self) -> None:
        rows = self.conn.execute(
            "SELECT message_id,category,folder_id FROM processed_emails "
            "WHERE provider='gmail' AND moved=1 AND processed_at>datetime('now','-7 days')"
        ).fetchall()
        if not rows:
            return
        lid_to_cat: dict[str, str] = dict(
            self.conn.execute(
                "SELECT folder_id,category FROM folder_map WHERE provider='gmail'"
            ).fetchall()
        )
        found = 0
        for mid, old_cat, old_lid in rows:
            try:
                m: dict[str, Any] = (
                    self.svc.users().messages().get(userId="me", id=mid, format="minimal").execute()
                )
                time.sleep(API_DELAY)
            except Exception:
                continue
            cur_labels: set[str] = set(m.get("labelIds", []))
            if old_lid not in cur_labels:
                new_cat = next((lid_to_cat[l] for l in cur_labels if l in lid_to_cat), "unknown")
                record_correction(self.conn, mid, "gmail", old_cat, new_cat)
                found += 1
        if found:
            log.info(f"Gmail: {found} corrections detected")


# ── Classifier ───────────────────────────────────────────────────────────────


def classify_by_sender(
    email: dict[str, Any],
    sender_rules: dict[str, str],
) -> tuple[str, float, str] | None:
    """T0: exact email or domain suffix match. Returns (category, 1.0, 'sender')."""
    sender: str = email["sender"]
    if sender in sender_rules:
        return (sender_rules[sender], 1.0, "sender")
    if "@" in sender:
        domain = sender.split("@", 1)[1]
        for rule, cat in sender_rules.items():
            if "@" not in rule and (domain == rule or domain.endswith("." + rule)):
                return (cat, 1.0, "sender")
    return None


def classify_by_keyword(
    email: dict[str, Any],
    keyword_rules: dict[str, list[str]],
) -> tuple[str, float, str] | None:
    """T0: subject keyword match. Confidence 0.5-0.9 based on hit count."""
    subj: str = email["subject"].lower()
    best: str | None = None
    best_n = 0
    for cat, kws in keyword_rules.items():
        n = sum(1 for kw in kws if kw in subj)
        if n > best_n:
            best, best_n = cat, n
    if best:
        return (best, min(0.5 + 0.15 * best_n, 0.9), "keyword")
    return None


def classify_by_jetson(
    email: dict[str, Any],
    cfg: dict[str, Any],
) -> tuple[str, float, str] | None:
    """T1: Jetson LLM classification. Returns (category, confidence, 'jetson')."""
    jcfg: dict[str, Any] = cfg.get("jetson", {})
    cats = sorted(cfg["_categories"])
    prompt = (
        f"Classify this email into exactly one of these categories:\n{json.dumps(cats)}\n\n"
        f"Email:\nFrom: {email['sender']}\nSubject: {email['subject']}\n"
        f"Body preview: {email['preview'][:500]}\n\n"
        'Respond with ONLY valid JSON: {"category": "...", "confidence": 0.0-1.0}'
    )
    try:
        resp = requests.post(
            f"{jcfg.get('base_url', 'http://jetson.k4jda.net:8080/v1')}/chat/completions",
            json={
                "model": jcfg.get("model", "qwen3.5-4b"),
                "messages": [
                    {"role": "system", "content": "Email classifier. JSON only."},
                    {"role": "user", "content": prompt},
                ],
                "max_completion_tokens": jcfg.get("max_completion_tokens", 256),
                "temperature": jcfg.get("temperature", 0.1),
            },
            timeout=jcfg.get("timeout", 90),
        )
        if resp.status_code != 200:
            log.warning(f"Jetson {resp.status_code}: {resp.text[:200]}")
            return None
        content: str = resp.json()["choices"][0]["message"]["content"].strip()
        content = re.sub(r"^```(?:json)?\s*", "", content)
        content = re.sub(r"\s*```$", "", content)
        content = re.sub(r"<think>.*?</think>", "", content, flags=re.DOTALL).strip()
        r: dict[str, Any] = json.loads(content)
        cat, conf = r.get("category", ""), float(r.get("confidence", 0))
        return (cat, conf, "jetson") if cat in cfg["_categories"] else None
    except Exception as e:
        log.warning(f"Jetson error: {e}")
        return None


def classify_email(
    email: dict[str, Any],
    cfg: dict[str, Any],
) -> tuple[str, float, str]:
    """Tiered classification: sender -> keyword -> Jetson -> Needs Review."""
    return (
        classify_by_sender(email, cfg["sender_rules"])
        or classify_by_keyword(email, cfg["keyword_rules"])
        or classify_by_jetson(email, cfg)
        or ("Needs Review", 0.0, "none")
    )


# ── Pipeline Orchestrator ────────────────────────────────────────────────────


def run_pipeline(
    backend: HotmailBackend | GmailBackend,
    conn: sqlite3.Connection,
    cfg: dict[str, Any],
    dry_run: bool = False,
    since_hours: int = 1,
) -> None:
    """Fetch -> classify -> organize -> cleanup -> detect corrections."""
    provider = "hotmail" if isinstance(backend, HotmailBackend) else "gmail"
    log.info(f"--- {provider.upper()} pipeline start ---")

    emails = backend.fetch_inbox(since_hours=since_hours)
    new = [e for e in emails if not is_processed(conn, e["id"])]
    log.info(f"Fetched {len(emails)}, new: {len(new)}")

    threshold: float = cfg.get("auto_move_threshold", 0.85)
    stats: Counter[str] = Counter()

    for e in new:
        cat, conf, tier = classify_email(e, cfg)
        stats[tier] += 1
        target = cat if conf >= threshold else "Needs Review"
        if target == "Needs Review":
            stats["needs_review"] += 1
        fid = get_folder_id(conn, provider, target)
        moved = False
        if not dry_run and fid:
            moved = backend.move_email(e["id"], fid)
            if moved:
                stats["moved"] += 1
        record_email(
            conn, e["id"], provider, e["sender"], e["subject"], cat, conf, tier, fid or "", moved
        )
        action = "DRY" if dry_run else ("MOV" if moved else "REC")
        log.info(f"  [{action}] {tier}({conf:.2f}) -> {target}: {e['subject'][:60]}")

    if not dry_run:
        backend.cleanup_spam()
        backend.detect_corrections()

    log.info(
        f"--- {provider.upper()} done: {len(new)} classified, "
        f"sender={stats['sender']}, kw={stats['keyword']}, "
        f"llm={stats['jetson']}, unclass={stats['none']}, "
        f"moved={stats['moved']}, review={stats['needs_review']} ---"
    )


# ── Daily Summary ────────────────────────────────────────────────────────────


def generate_daily_summary(conn: sqlite3.Connection, cfg: dict[str, Any]) -> None:
    """Aggregate today's emails, synthesize via claude --print, POST to brain."""
    today = datetime.now().strftime("%Y-%m-%d")
    existing = conn.execute(
        "SELECT posted_to_brain FROM daily_summaries WHERE date=?", (today,)
    ).fetchone()
    if existing and existing[0]:
        return log.info(f"Summary for {today} already posted")

    rows = conn.execute(
        "SELECT provider,sender,subject,category,confidence,tier FROM processed_emails "
        "WHERE date(processed_at)=? ORDER BY processed_at",
        (today,),
    ).fetchall()
    if not rows:
        return log.info(f"No emails on {today}, skipping summary")

    cat_counts: Counter[str] = Counter(r[3] for r in rows)
    tier_counts: Counter[str] = Counter(r[5] for r in rows)
    lines = [f"- [{r[0]}] {r[1]} | {r[2]} | {r[3]} ({r[5]}, {r[4]:.0%})" for r in rows[:100]]

    prompt = (
        f"Summarize today's email activity for Troy Davis's personal knowledge system.\n\n"
        f"Date: {today} | Total: {len(rows)}\n"
        f"Categories: {json.dumps(dict(cat_counts))}\n"
        f"Tiers: {json.dumps(dict(tier_counts))}\n\n"
        f"Emails:\n{chr(10).join(lines)}\n\n"
        "Write a concise daily digest (3-5 paragraphs): volume highlights, "
        "actionable items by category, notable senders, patterns worth noting."
    )

    summary: str | None
    try:
        r = subprocess.run(
            ["claude", "--print", "-p", prompt], capture_output=True, text=True, timeout=120
        )
        summary = r.stdout.strip() if r.returncode == 0 else None
    except (FileNotFoundError, subprocess.TimeoutExpired):
        summary = None
    if not summary:
        summary = f"[Auto] {len(rows)} emails. Top: " + ", ".join(
            f"{c}({n})" for c, n in cat_counts.most_common(5)
        )

    conn.execute(
        "INSERT OR REPLACE INTO daily_summaries(date,email_count,categories_json,summary_text) "
        "VALUES(?,?,?,?)",
        (today, len(rows), json.dumps(dict(cat_counts)), summary),
    )
    conn.commit()

    scfg: dict[str, Any] = cfg.get("daily_summary", {})
    url = scfg.get("open_brain_url", "https://brain.troy-davis.com/api/v1/captures")
    try:
        resp = requests.post(
            url,
            json={
                "content": f"[Email Daily Digest] {today}\n\n{summary}",
                "source": "email",
                "source_metadata": {
                    "type": "daily_digest",
                    "date": today,
                    "email_count": len(rows),
                    "categories": dict(cat_counts),
                },
            },
            headers={
                "Content-Type": "application/json",
                "X-Open-Brain-Caller": scfg.get("open_brain_caller", "email-pipeline"),
            },
            timeout=30,
        )
        if resp.status_code in (200, 201):
            conn.execute("UPDATE daily_summaries SET posted_to_brain=1 WHERE date=?", (today,))
            conn.commit()
            log.info(f"Summary posted ({len(rows)} emails)")
        else:
            log.warning(f"Brain POST {resp.status_code}: {resp.text[:200]}")
    except requests.exceptions.RequestException as e:
        log.warning(f"Brain unreachable: {e}")


# ── Status ───────────────────────────────────────────────────────────────────


def show_status(conn: sqlite3.Connection) -> None:
    """Print pipeline statistics."""
    print("\n=== Email Pipeline Status ===\n")
    total: int = conn.execute("SELECT COUNT(*) FROM processed_emails").fetchone()[0]
    print(f"Total processed: {total}")
    for p in ("hotmail", "gmail"):
        n: int = conn.execute(
            "SELECT COUNT(*) FROM processed_emails WHERE provider=?", (p,)
        ).fetchone()[0]
        print(f"  {p}: {n}")

    print("\nTiers (7d):")
    for tier, n in conn.execute(
        "SELECT tier,COUNT(*) FROM processed_emails WHERE processed_at>datetime('now','-7 days') "
        "GROUP BY tier ORDER BY COUNT(*) DESC"
    ).fetchall():
        print(f"  {tier}: {n}")

    print("\nTop categories (7d):")
    for cat, n in conn.execute(
        "SELECT category,COUNT(*) FROM processed_emails WHERE processed_at>datetime('now','-7 days') "
        "GROUP BY category ORDER BY COUNT(*) DESC LIMIT 10"
    ).fetchall():
        print(f"  {cat}: {n}")

    corr: int = conn.execute("SELECT COUNT(*) FROM corrections").fetchone()[0]
    print(f"\nCorrections: {corr}")
    if corr:
        for old, new, n in conn.execute(
            "SELECT old_category,new_category,COUNT(*) FROM corrections "
            "GROUP BY old_category,new_category ORDER BY COUNT(*) DESC LIMIT 5"
        ).fetchall():
            print(f"  {old} -> {new}: {n}x")

    for p in ("hotmail", "gmail"):
        n = conn.execute(
            "SELECT COUNT(*) FROM folder_map WHERE provider=?", (p,)
        ).fetchone()[0]
        print(f"\n{p} folders mapped: {n}")

    r = conn.execute(
        "SELECT date,email_count,posted_to_brain FROM daily_summaries ORDER BY date DESC LIMIT 1"
    ).fetchone()
    if r:
        print(f"\nLast summary: {r[0]} ({r[1]} emails, {'posted' if r[2] else 'pending'})")
    print()


# ── CLI ──────────────────────────────────────────────────────────────────────


def main() -> None:
    ap = argparse.ArgumentParser(description="Email Classification Pipeline")
    ap.add_argument("--provider", choices=["hotmail", "gmail", "both"], default="both")
    ap.add_argument("--setup", action="store_true", help="Authenticate + create folders/labels")
    ap.add_argument("--summary", action="store_true", help="Generate daily summary")
    ap.add_argument("--dry-run", action="store_true", help="Classify without moving")
    ap.add_argument("--status", action="store_true", help="Show stats")
    ap.add_argument("--since-hours", type=int, default=1, help="Fetch window (default: 1h)")
    args = ap.parse_args()

    conn = init_db()
    if args.status:
        show_status(conn)
        return conn.close()
    if args.summary:
        generate_daily_summary(conn, load_config())
        return conn.close()

    cfg = load_config()
    providers: list[str] = ["hotmail", "gmail"] if args.provider == "both" else [args.provider]

    for p in providers:
        try:
            if p == "hotmail":
                be: HotmailBackend | GmailBackend = HotmailBackend(conn, cfg)
                if not be.authenticate(interactive=args.setup):
                    continue
                if args.setup:
                    be.setup_folders()
                    continue
            else:
                be = GmailBackend(conn, cfg)
                if not be.authenticate(interactive=args.setup):
                    continue
                if args.setup:
                    be.setup_labels()
                    continue
            run_pipeline(be, conn, cfg, dry_run=args.dry_run, since_hours=args.since_hours)
        except Exception as e:
            log.error(f"{p} failed: {e}", exc_info=True)

    conn.close()


if __name__ == "__main__":
    main()
