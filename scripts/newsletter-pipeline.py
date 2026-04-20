#!/usr/bin/env python3
"""
Financial Advisor Newsletter Assessment Pipeline for Open Brain — P21.

Fetches full-body newsletters from known advisor senders (Hotmail/Gmail),
extracts structure + action items via T0 parsing, diffs against prior
newsletter for the same advisor, synthesizes via T2 Claude CLI, and posts
one capture per advisor per new newsletter to the Open Brain API.

Cost tier: T0 (Python) + T2 (claude --print, subscription-covered). Zero
LLM API cost. Aggregation rule satisfied: one synthesis call per newsletter
per advisor, never per-email.

Usage:
    python newsletter-pipeline.py --run              # fetch + parse + synthesize + post
    python newsletter-pipeline.py --setup            # interactive auth (first-time Graph/Gmail)
    python newsletter-pipeline.py --fetch-only       # dry-run: print matches, no post
    python newsletter-pipeline.py --status           # DB stats: advisors, last run, counts
    python newsletter-pipeline.py --reprocess N      # re-synthesize last N newsletters

Cron (open-brain-vm, daily 08:00):
    0 8 * * * cd ~/open-brain && venv/bin/python scripts/newsletter-pipeline.py --run >> ~/logs/newsletter-pipeline.log 2>&1
"""

import argparse
import hashlib
import importlib.util
import json
import logging
import re
import sqlite3
import subprocess
import sys
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

import requests
import yaml

sys.stdout.reconfigure(line_buffering=True)
sys.stderr.reconfigure(line_buffering=True)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("newsletter-pipeline")

# ── Paths & constants ─────────────────────────────────────────────────────────

PIPE_DIR = Path.home() / ".newsletter-pipeline"
DB_PATH = PIPE_DIR / "pipeline.db"
SCRIPTS_DIR = Path(__file__).resolve().parent
CONFIG_PATH = SCRIPTS_DIR.parent / "config" / "financial" / "newsletter-advisors.yaml"

GRAPH = "https://graph.microsoft.com/v1.0"
API_DELAY = 0.1
DUPLICATE_SENTINEL = "DUPLICATE"


# ── Config ────────────────────────────────────────────────────────────────────


def load_config() -> dict:
    """Load and validate newsletter-advisors.yaml."""
    if not CONFIG_PATH.exists():
        sys.exit(f"Config not found: {CONFIG_PATH}")
    cfg = yaml.safe_load(CONFIG_PATH.read_text())
    if not cfg.get("advisors"):
        log.warning("No advisors configured in newsletter-advisors.yaml")
    return cfg


def _advisor_index(cfg: dict) -> dict[str, dict]:
    """Build lookup: normalized_sender -> advisor_config."""
    idx: dict[str, dict] = {}
    for adv in cfg.get("advisors", []):
        key = adv["sender_match"].lower().strip()
        idx[key] = adv
    return idx


# ── WI-2: SQLite DB ───────────────────────────────────────────────────────────


def init_db() -> sqlite3.Connection:
    """Initialize SQLite tracking DB. Idempotent — safe to call multiple times."""
    PIPE_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH), timeout=30)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS processed_newsletters (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            advisor_name TEXT NOT NULL,
            message_id TEXT NOT NULL UNIQUE,
            provider TEXT NOT NULL,
            subject TEXT,
            received_at TEXT,
            body_hash TEXT,
            body_preview TEXT,
            synthesis_posted INTEGER DEFAULT 0,
            capture_id TEXT,
            processed_at TEXT DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_pn_advisor
            ON processed_newsletters(advisor_name, received_at);
        CREATE INDEX IF NOT EXISTS idx_pn_msg
            ON processed_newsletters(message_id);
    """)
    conn.commit()
    return conn


def is_processed(conn: sqlite3.Connection, message_id: str) -> bool:
    return conn.execute(
        "SELECT 1 FROM processed_newsletters WHERE message_id=?", (message_id,)
    ).fetchone() is not None


def record_newsletter(
    conn: sqlite3.Connection,
    advisor_name: str,
    message_id: str,
    provider: str,
    subject: str,
    received_at: str,
    body_hash: str,
    body_preview: str,
    synthesis_posted: bool = False,
    capture_id: str | None = None,
) -> None:
    conn.execute(
        "INSERT OR REPLACE INTO processed_newsletters "
        "(advisor_name, message_id, provider, subject, received_at, body_hash, "
        " body_preview, synthesis_posted, capture_id) "
        "VALUES (?,?,?,?,?,?,?,?,?)",
        (
            advisor_name,
            message_id,
            provider,
            subject[:500],
            received_at,
            body_hash,
            body_preview[:500],
            int(synthesis_posted),
            capture_id,
        ),
    )
    conn.commit()


def mark_posted(conn: sqlite3.Connection, message_id: str, capture_id: str | None = None) -> None:
    conn.execute(
        "UPDATE processed_newsletters SET synthesis_posted=1, capture_id=? WHERE message_id=?",
        (capture_id, message_id),
    )
    conn.commit()


# ── WI-3: Email fetch helpers ─────────────────────────────────────────────────


def _load_hotmail_backend():
    """Load HotmailBackend from email-pipeline.py via importlib (hyphenated filename)."""
    email_pipeline_path = SCRIPTS_DIR / "email-pipeline.py"
    if not email_pipeline_path.exists():
        log.error(f"email-pipeline.py not found at {email_pipeline_path}")
        return None
    spec = importlib.util.spec_from_file_location("email_pipeline", email_pipeline_path)
    if spec is None or spec.loader is None:
        log.error("importlib could not load email-pipeline.py")
        return None
    mod = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(mod)
    except Exception as e:
        log.error(f"Failed to load email-pipeline.py: {e}")
        return None
    return getattr(mod, "HotmailBackend", None)


def _strip_html(html: str) -> str:
    """T0: strip HTML tags to plain text — no external lib needed."""
    text = re.sub(r"<style[^>]*>.*?</style>", " ", html, flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r"<script[^>]*>.*?</script>", " ", text, flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"&nbsp;", " ", text)
    text = re.sub(r"&amp;", "&", text)
    text = re.sub(r"&lt;", "<", text)
    text = re.sub(r"&gt;", ">", text)
    text = re.sub(r"&quot;", '"', text)
    text = re.sub(r"&#39;", "'", text)
    text = re.sub(r"\s{3,}", "\n\n", text)
    return text.strip()


def _match_sender(sender: str, advisor_index: dict[str, dict]) -> dict | None:
    """Match a sender address against the advisor index (exact or domain)."""
    sender = sender.lower().strip()
    # Exact match
    if sender in advisor_index:
        return advisor_index[sender]
    # Domain match
    if "@" in sender:
        domain = sender.split("@", 1)[1]
        for key, adv in advisor_index.items():
            if adv.get("match_type") == "domain" and (domain == key or domain.endswith("." + key)):
                return adv
    return None


def fetch_newsletters_hotmail(
    conn: sqlite3.Connection,
    cfg: dict,
    advisor_index: dict[str, dict],
    interactive: bool = False,
    dry_run: bool = False,
) -> list[dict]:
    """Fetch full-body newsletter emails from Hotmail for known advisor senders."""
    HotmailBackend = _load_hotmail_backend()
    if HotmailBackend is None:
        log.error("Cannot fetch from Hotmail — HotmailBackend not available")
        return []

    # Create a minimal cfg object that HotmailBackend accepts
    email_cfg: dict = {"_categories": set(), "sender_rules": {}, "keyword_rules": {}}
    backend = HotmailBackend(conn, email_cfg)
    if not backend.authenticate(interactive=interactive):
        log.error("Hotmail authentication failed")
        return []

    dedupe_days = cfg["pipeline"].get("dedupe_window_days", 7)
    max_chars = cfg["pipeline"].get("max_body_chars", 20000)
    since = (datetime.now(UTC) - timedelta(days=dedupe_days)).strftime("%Y-%m-%dT%H:%M:%SZ")

    # Fetch inbox messages for the window
    url = (
        f"{GRAPH}/me/mailFolders/inbox/messages"
        f"?$top=50"
        f"&$select=id,subject,from,receivedDateTime"
        f"&$filter=receivedDateTime ge {since}"
        f"&$orderby=receivedDateTime desc"
    )
    results: list[dict] = []
    while url:
        data = backend._get(url)
        if not data:
            break
        for m in data.get("value", []):
            sender = (
                m.get("from", {}).get("emailAddress", {}).get("address", "").lower().strip()
            )
            advisor = _match_sender(sender, advisor_index)
            if advisor is None:
                continue
            mid = m["id"]
            if not dry_run and is_processed(conn, mid):
                log.debug(f"  [SKIP] already processed: {m.get('subject','')[:60]}")
                continue
            # Fetch full body
            body_data = backend._get(
                f"{GRAPH}/me/messages/{mid}"
                f"?$select=body,subject,from,receivedDateTime"
            )
            if not body_data:
                log.warning(f"  Failed to fetch body for {mid}")
                continue
            body_obj = body_data.get("body", {})
            raw_body = body_obj.get("content", "")
            content_type = body_obj.get("contentType", "text").lower()
            body_text = _strip_html(raw_body) if content_type == "html" else raw_body
            body_text = body_text[:max_chars]
            results.append(
                {
                    "message_id": mid,
                    "provider": "hotmail",
                    "advisor": advisor,
                    "subject": m.get("subject", ""),
                    "sender": sender,
                    "received_at": m.get("receivedDateTime", ""),
                    "body_text": body_text,
                }
            )
            time.sleep(API_DELAY)
        url = data.get("@odata.nextLink")

    return results


def _gmail_walk_parts(payload: dict) -> str:
    """Recursively walk Gmail message payload to extract plain/html text."""
    mime = payload.get("mimeType", "")
    if mime == "text/plain":
        import base64
        data = payload.get("body", {}).get("data", "")
        if data:
            return base64.urlsafe_b64decode(data + "==").decode("utf-8", errors="replace")
    if mime == "text/html":
        import base64
        data = payload.get("body", {}).get("data", "")
        if data:
            raw = base64.urlsafe_b64decode(data + "==").decode("utf-8", errors="replace")
            return _strip_html(raw)
    if "parts" in payload:
        texts = []
        for part in payload["parts"]:
            t = _gmail_walk_parts(part)
            if t:
                texts.append(t)
        return "\n".join(texts)
    return ""


def fetch_newsletters_gmail(
    conn: sqlite3.Connection,
    cfg: dict,
    advisor_index: dict[str, dict],
    interactive: bool = False,
    dry_run: bool = False,
) -> list[dict]:
    """Fetch full-body newsletter emails from Gmail for known advisor senders."""
    try:
        from google.auth.transport.requests import Request as GReq
        from google.oauth2.credentials import Credentials
        from google_auth_oauthlib.flow import InstalledAppFlow
        from googleapiclient.discovery import build
    except ImportError:
        log.error("pip install google-auth-oauthlib google-api-python-client")
        return []

    gmail_pipe_dir = Path.home() / ".email-pipeline"
    gmail_token = gmail_pipe_dir / "gmail_token.json"
    gmail_creds_file = gmail_pipe_dir / "gmail_credentials.json"
    SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"]

    creds = None
    if gmail_token.exists():
        creds = Credentials.from_authorized_user_file(str(gmail_token), SCOPES)
    if creds and creds.expired and creds.refresh_token:
        try:
            creds.refresh(GReq())
        except Exception:
            creds = None
    if not creds or not creds.valid:
        if not interactive:
            log.error("Gmail: no valid token. Run --setup")
            return []
        if not gmail_creds_file.exists():
            log.error(f"Download OAuth JSON to {gmail_creds_file}")
            return []
        creds = InstalledAppFlow.from_client_secrets_file(
            str(gmail_creds_file), SCOPES
        ).run_local_server(port=0)
    gmail_pipe_dir.mkdir(parents=True, exist_ok=True)
    gmail_token.write_text(creds.to_json())

    svc = build("gmail", "v1", credentials=creds)

    dedupe_days = cfg["pipeline"].get("dedupe_window_days", 7)
    max_chars = cfg["pipeline"].get("max_body_chars", 20000)
    since_date = (datetime.now(UTC) - timedelta(days=dedupe_days)).strftime("%Y/%m/%d")

    results: list[dict] = []
    page_token = None
    while True:
        r = (
            svc.users()
            .messages()
            .list(
                userId="me",
                q=f"in:inbox after:{since_date}",
                maxResults=50,
                pageToken=page_token,
            )
            .execute()
        )
        for stub in r.get("messages", []):
            mid = stub["id"]
            if not dry_run and is_processed(conn, mid):
                continue
            msg = (
                svc.users()
                .messages()
                .get(userId="me", id=mid, format="metadata",
                     metadataHeaders=["From", "Subject", "Date"])
                .execute()
            )
            time.sleep(API_DELAY)
            hdrs = {h["name"]: h["value"] for h in msg.get("payload", {}).get("headers", [])}
            raw_from = hdrs.get("From", "")
            match = re.search(r"<([^>]+)>", raw_from)
            sender = (match.group(1) if match else raw_from).lower().strip()
            advisor = _match_sender(sender, advisor_index)
            if advisor is None:
                continue
            # Fetch full message for body
            full_msg = svc.users().messages().get(userId="me", id=mid, format="full").execute()
            time.sleep(API_DELAY)
            body_text = _gmail_walk_parts(full_msg.get("payload", {}))[:max_chars]
            results.append(
                {
                    "message_id": mid,
                    "provider": "gmail",
                    "advisor": advisor,
                    "subject": hdrs.get("Subject", ""),
                    "sender": sender,
                    "received_at": hdrs.get("Date", ""),
                    "body_text": body_text,
                }
            )
        page_token = r.get("nextPageToken")
        if not page_token:
            break

    return results


# ── WI-4: T0 parsing + diff ───────────────────────────────────────────────────


def parse_newsletter(body_text: str, advisor_config: dict) -> dict:
    """T0: section-split + action-item extraction.

    Returns:
        {
          sections: {header_str: body_str},
          action_items: [str],
          word_count: int,
        }
    """
    headers = advisor_config.get("section_headers", [])
    action_keywords = advisor_config.get("action_item_keywords", [])

    # Build a single regex from section headers for splitting
    if headers:
        pattern = r"(?:^|\n)(" + "|".join(re.escape(h) for h in headers) + r")[\s:]*\n"
        parts = re.split(pattern, body_text, flags=re.IGNORECASE)
    else:
        parts = [body_text]

    sections: dict[str, str] = {}
    if len(parts) > 1:
        # parts alternates: [pre-text, header1, body1, header2, body2, ...]
        sections["(intro)"] = parts[0].strip()
        it = iter(parts[1:])
        for hdr, body in zip(it, it):
            sections[hdr.strip()] = body.strip()
    else:
        sections["(full)"] = body_text.strip()

    # Extract action-item sentences
    action_items: list[str] = []
    if action_keywords:
        kw_pattern = r"\b(" + "|".join(re.escape(kw) for kw in action_keywords) + r")\b"
        for line in body_text.split("\n"):
            line = line.strip()
            if not line:
                continue
            if re.search(kw_pattern, line, flags=re.IGNORECASE):
                action_items.append(line)

    word_count = len(body_text.split())
    return {"sections": sections, "action_items": action_items[:20], "word_count": word_count}


def _body_hash(body_text: str) -> str:
    """SHA-256 of normalized body text."""
    normalized = re.sub(r"\s+", " ", body_text.strip()).encode("utf-8")
    return hashlib.sha256(normalized).hexdigest()


def compute_diff(
    current_hash: str,
    current_preview: str,
    conn: sqlite3.Connection,
    advisor_name: str,
) -> str:
    """T0: compare current newsletter against the most recent prior one.

    Returns DUPLICATE_SENTINEL on matching hash (caller should skip synthesis).
    Returns "First newsletter from this advisor." on empty history.
    Otherwise returns a short diff note.
    """
    row = conn.execute(
        "SELECT body_hash, body_preview, received_at FROM processed_newsletters "
        "WHERE advisor_name=? AND synthesis_posted=1 "
        "ORDER BY received_at DESC LIMIT 1",
        (advisor_name,),
    ).fetchone()
    if row is None:
        return "First newsletter from this advisor."
    prior_hash, prior_preview, prior_date = row
    if prior_hash == current_hash:
        return DUPLICATE_SENTINEL

    # Simple structural diff
    prior_words = len(prior_preview.split())
    curr_words = len(current_preview.split())
    delta = curr_words - prior_words
    sign = "+" if delta >= 0 else ""
    diff_note = (
        f"Changed since {prior_date[:10]} — "
        f"word-count delta: {sign}{delta}. "
        f"Prior preview: {prior_preview[:200]}"
    )
    return diff_note


# ── WI-5: T2 synthesis ────────────────────────────────────────────────────────


def _build_synthesis_prompt(
    advisor_name: str,
    subject: str,
    received_at: str,
    body_text: str,
    parsed: dict,
    diff_note: str,
    max_total_chars: int = 6000,
) -> str:
    """Assemble the Claude CLI prompt, capped at max_total_chars."""
    section_text = ""
    for hdr, content in parsed["sections"].items():
        section_text += f"\n### {hdr}\n{content[:800]}\n"

    action_text = (
        "\n".join(f"- {a}" for a in parsed["action_items"])
        if parsed["action_items"]
        else "(none detected)"
    )

    prompt = (
        f"You are analyzing a financial advisor newsletter for Troy Davis.\n\n"
        f"Advisor: {advisor_name}\n"
        f"Subject: {subject}\n"
        f"Date: {received_at[:10] if received_at else 'unknown'}\n"
        f"Word count: {parsed['word_count']}\n\n"
        f"Change vs. prior newsletter: {diff_note}\n\n"
        f"## Extracted Sections\n{section_text}\n\n"
        f"## T0-Extracted Action Items\n{action_text}\n\n"
        f"---\n"
        f"Please produce a structured analysis in exactly this format:\n\n"
        f"## What's New\n"
        f"(2–4 bullets on key topics/themes compared to prior newsletter)\n\n"
        f"## Action Items\n"
        f"(3–7 specific actionable recommendations with any stated deadlines. "
        f"If none, state 'No specific action items identified.')\n\n"
        f"## Market Views\n"
        f"(Current market positions or outlooks expressed by the advisor)\n\n"
        f"## Changed Positions\n"
        f"(Any positions or views that changed since the prior newsletter; "
        f"'None detected' if this is the first or diff is unavailable)\n"
    )

    # Trim to cap
    if len(prompt) > max_total_chars:
        prompt = prompt[:max_total_chars] + "\n[truncated]"
    return prompt


def synthesize_newsletter(
    advisor_name: str,
    subject: str,
    received_at: str,
    body_text: str,
    parsed: dict,
    diff_note: str,
    cfg: dict,
) -> str | None:
    """T2: call claude --print for synthesis. Returns text or None on failure."""
    timeout = cfg["pipeline"].get("synthesis_timeout_sec", 180)
    prompt = _build_synthesis_prompt(advisor_name, subject, received_at, body_text, parsed, diff_note)
    try:
        result = subprocess.run(
            ["claude", "--print", "-p", prompt],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
        log.warning(f"Claude CLI returned {result.returncode}: {result.stderr[:200]}")
    except subprocess.TimeoutExpired:
        log.warning("Claude CLI timed out — posting raw extraction without synthesis")
    except FileNotFoundError:
        log.warning("Claude CLI not found — posting raw extraction without synthesis")
    return None


def _raw_extraction_text(parsed: dict, diff_note: str) -> str:
    """Fallback when synthesis fails: format T0 output as plain text."""
    lines = ["## Action Items (T0 extracted)"]
    if parsed["action_items"]:
        for a in parsed["action_items"]:
            lines.append(f"- {a}")
    else:
        lines.append("(none detected)")
    lines.append(f"\n## Change Note\n{diff_note}")
    lines.append(f"\n## Sections\n" + ", ".join(parsed["sections"].keys()))
    return "\n".join(lines)


# ── WI-6: POST capture ────────────────────────────────────────────────────────


def post_newsletter_capture(
    newsletter: dict,
    parsed: dict,
    diff_note: str,
    synthesis: str | None,
    cfg: dict,
) -> bool | str:
    """POST newsletter assessment capture to core-api.

    Returns the capture_id string on success, False on failure.
    """
    advisor = newsletter["advisor"]
    advisor_name = advisor["name"]
    subject = newsletter["subject"]
    received_at = newsletter["received_at"]
    provider = newsletter["provider"]

    body_section = synthesis if synthesis else _raw_extraction_text(parsed, diff_note)
    date_str = received_at[:10] if received_at else "unknown"

    content = (
        f"[Newsletter] {advisor_name} — {subject} ({date_str})\n\n"
        f"{body_section}\n\n"
        f"---\n"
        f"Source: {provider} | {parsed['word_count']} words | Changes: {diff_note[:200]}\n"
        f"Action items extracted: {len(parsed['action_items'])}"
    )

    source_metadata = {
        "type": "newsletter_assessment",
        "advisor_name": advisor_name,
        "subject": subject,
        "received_at": received_at,
        "provider": provider,
        "word_count": parsed["word_count"],
        "action_item_count": len(parsed["action_items"]),
        "has_synthesis": synthesis is not None,
        "diff_from_prior": diff_note[:200],
    }

    cap_cfg = cfg["pipeline"].get("capture_api", {})
    import os
    url = os.environ.get("CAPTURE_API_URL") or cap_cfg.get(
        "url", "https://brain.troy-davis.com/api/v1/captures"
    )
    caller = os.environ.get("CAPTURE_API_CALLER") or cap_cfg.get(
        "caller_header", "newsletter-pipeline"
    )
    brain_view = advisor.get("brain_view", "personal")
    capture_type = advisor.get("capture_type", "observation")

    try:
        resp = requests.post(
            url,
            json={
                "content": content,
                "source": "api",
                "capture_type": capture_type,
                "brain_view": brain_view,
                "metadata": {"source_metadata": source_metadata},
            },
            headers={
                "Content-Type": "application/json",
                "X-Open-Brain-Caller": caller,
            },
            timeout=30,
            allow_redirects=False,
        )
        if resp.status_code in (200, 201):
            data = resp.json()
            capture_id = data.get("id")
            log.info(f"Capture posted: {advisor_name} / {subject[:60]} → {capture_id}")
            return capture_id or True
        elif resp.status_code in (301, 302, 303, 307, 308):
            loc = resp.headers.get("Location", "")[:120]
            log.warning(
                f"Brain POST {resp.status_code} redirect to {loc} — "
                f"set CAPTURE_API_URL to an internal URL"
            )
            return False
        else:
            log.warning(f"Brain POST {resp.status_code}: {resp.text[:200]}")
            return False
    except requests.exceptions.RequestException as e:
        log.warning(f"Brain unreachable: {e}")
        return False


# ── Main pipeline orchestrator ────────────────────────────────────────────────


def process_newsletters(
    newsletters: list[dict],
    conn: sqlite3.Connection,
    cfg: dict,
    dry_run: bool = False,
) -> dict:
    """Parse, diff, synthesize, and post each newsletter. Returns stats dict."""
    stats = {"total": len(newsletters), "posted": 0, "skipped_dup": 0, "failed": 0}

    for n in newsletters:
        advisor = n["advisor"]
        advisor_name = advisor["name"]
        body_text = n["body_text"]
        curr_hash = _body_hash(body_text)
        curr_preview = body_text[:500]

        diff_note = compute_diff(curr_hash, curr_preview, conn, advisor_name)

        if diff_note == DUPLICATE_SENTINEL:
            log.info(f"  [DEDUP] {advisor_name} / {n['subject'][:60]} — body unchanged, skipping")
            # Record as processed so we don't re-check each run
            record_newsletter(
                conn,
                advisor_name,
                n["message_id"],
                n["provider"],
                n["subject"],
                n["received_at"],
                curr_hash,
                curr_preview,
                synthesis_posted=False,
            )
            stats["skipped_dup"] += 1
            continue

        parsed = parse_newsletter(body_text, advisor)

        if dry_run:
            log.info(
                f"  [DRY] {advisor_name} / {n['subject'][:60]} — "
                f"{parsed['word_count']} words, {len(parsed['action_items'])} action items"
            )
            log.info(f"        Diff: {diff_note[:100]}")
            stats["posted"] += 1
            continue

        synthesis = synthesize_newsletter(
            advisor_name,
            n["subject"],
            n["received_at"],
            body_text,
            parsed,
            diff_note,
            cfg,
        )

        capture_result = post_newsletter_capture(n, parsed, diff_note, synthesis, cfg)
        if capture_result:
            capture_id = capture_result if isinstance(capture_result, str) else None
            record_newsletter(
                conn,
                advisor_name,
                n["message_id"],
                n["provider"],
                n["subject"],
                n["received_at"],
                curr_hash,
                curr_preview,
                synthesis_posted=True,
                capture_id=capture_id,
            )
            stats["posted"] += 1
        else:
            # Record as processed (not posted) so it doesn't retry in next run
            record_newsletter(
                conn,
                advisor_name,
                n["message_id"],
                n["provider"],
                n["subject"],
                n["received_at"],
                curr_hash,
                curr_preview,
                synthesis_posted=False,
            )
            stats["failed"] += 1
            log.warning(f"  [FAIL] POST failed: {advisor_name} / {n['subject'][:60]}")

    return stats


def run_pipeline(
    conn: sqlite3.Connection,
    cfg: dict,
    interactive: bool = False,
    dry_run: bool = False,
) -> None:
    """Full pipeline: fetch from all providers, process, report."""
    advisor_index = _advisor_index(cfg)
    if not advisor_index:
        log.info("No advisors configured — nothing to fetch")
        return

    all_newsletters: list[dict] = []

    # Hotmail
    try:
        hm = fetch_newsletters_hotmail(conn, cfg, advisor_index, interactive=interactive, dry_run=dry_run)
        all_newsletters.extend(hm)
        log.info(f"Hotmail: {len(hm)} matched newsletters")
    except Exception as e:
        log.error(f"Hotmail fetch failed: {e}", exc_info=True)

    # Gmail (optional — skips gracefully if no token)
    try:
        gm = fetch_newsletters_gmail(conn, cfg, advisor_index, interactive=interactive, dry_run=dry_run)
        all_newsletters.extend(gm)
        log.info(f"Gmail: {len(gm)} matched newsletters")
    except Exception as e:
        log.error(f"Gmail fetch failed: {e}", exc_info=True)

    if not all_newsletters:
        log.info("No new newsletters found")
        return

    log.info(f"Processing {len(all_newsletters)} newsletter(s)...")
    stats = process_newsletters(all_newsletters, conn, cfg, dry_run=dry_run)
    log.info(
        f"Done — total={stats['total']}, posted={stats['posted']}, "
        f"dedup={stats['skipped_dup']}, failed={stats['failed']}"
    )


# ── WI-8: CLI ─────────────────────────────────────────────────────────────────


def cmd_status(conn: sqlite3.Connection) -> None:
    """Print pipeline statistics."""
    print("\n=== Newsletter Pipeline Status ===\n")
    total = conn.execute("SELECT COUNT(*) FROM processed_newsletters").fetchone()[0]
    print(f"Total processed:  {total}")
    posted = conn.execute(
        "SELECT COUNT(*) FROM processed_newsletters WHERE synthesis_posted=1"
    ).fetchone()[0]
    print(f"  Posted to brain: {posted}")
    dedup = conn.execute(
        "SELECT COUNT(*) FROM processed_newsletters WHERE synthesis_posted=0"
    ).fetchone()[0]
    print(f"  Not posted (dedup/failed): {dedup}")

    print("\nBy advisor:")
    for name, cnt, last in conn.execute(
        "SELECT advisor_name, COUNT(*), MAX(received_at) FROM processed_newsletters "
        "GROUP BY advisor_name ORDER BY MAX(received_at) DESC"
    ).fetchall():
        print(f"  {name}: {cnt} newsletters, last: {last or 'n/a'}")

    print()


def cmd_reprocess(conn: sqlite3.Connection, cfg: dict, n: int) -> None:
    """Mark last N newsletters as not-posted and re-run synthesis + post."""
    rows = conn.execute(
        "SELECT message_id, advisor_name, provider, subject, received_at, body_hash, body_preview "
        "FROM processed_newsletters ORDER BY processed_at DESC LIMIT ?",
        (n,),
    ).fetchall()
    if not rows:
        log.info("No newsletters to reprocess")
        return
    advisor_index = _advisor_index(cfg)
    log.info(f"Reprocessing {len(rows)} newsletter(s)...")
    for (mid, aname, prov, subj, recv, bhash, bprev) in rows:
        conn.execute(
            "UPDATE processed_newsletters SET synthesis_posted=0 WHERE message_id=?", (mid,)
        )
    conn.commit()
    # Re-fetch body text would require API calls; instead rebuild from preview + stored data
    # For reprocess we use a simplified note
    for (mid, aname, prov, subj, recv, bhash, bprev) in rows:
        adv_cfg = next(
            (a for a in cfg.get("advisors", []) if a["name"] == aname),
            {"name": aname, "brain_view": "personal", "capture_type": "observation",
             "action_item_keywords": [], "section_headers": []},
        )
        parsed = parse_newsletter(bprev or "", adv_cfg)
        diff_note = f"[Reprocessed] {recv[:10] if recv else 'unknown'}"
        synthesis = synthesize_newsletter(aname, subj, recv or "", bprev or "", parsed, diff_note, cfg)
        newsletter = {
            "message_id": mid,
            "advisor": adv_cfg,
            "subject": subj or "",
            "sender": "",
            "received_at": recv or "",
            "body_text": bprev or "",
            "provider": prov,
        }
        result = post_newsletter_capture(newsletter, parsed, diff_note, synthesis, cfg)
        if result:
            capture_id = result if isinstance(result, str) else None
            mark_posted(conn, mid, capture_id)
            log.info(f"  Reprocessed: {aname} / {subj[:60]}")
        else:
            log.warning(f"  Reprocess POST failed: {aname} / {subj[:60]}")


def main() -> None:
    ap = argparse.ArgumentParser(description="Newsletter Assessment Pipeline — P21")
    group = ap.add_mutually_exclusive_group()
    group.add_argument("--run", action="store_true", help="Fetch + parse + synthesize + post")
    group.add_argument("--setup", action="store_true", help="Interactive auth setup")
    group.add_argument("--fetch-only", action="store_true", help="Dry-run: print matches, no post")
    group.add_argument("--status", action="store_true", help="Show DB stats")
    group.add_argument("--reprocess", type=int, metavar="N", help="Re-synthesize last N newsletters")
    args = ap.parse_args()

    # Default to --run if no mode specified
    if not any([args.run, args.setup, args.fetch_only, args.status, args.reprocess]):
        args.run = True

    conn = init_db()
    cfg = load_config()

    try:
        if args.status:
            cmd_status(conn)
        elif args.setup:
            run_pipeline(conn, cfg, interactive=True, dry_run=True)
        elif args.fetch_only:
            run_pipeline(conn, cfg, interactive=False, dry_run=True)
        elif args.reprocess is not None:
            cmd_reprocess(conn, cfg, args.reprocess)
        else:  # --run
            run_pipeline(conn, cfg, interactive=False, dry_run=False)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
