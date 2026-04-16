#!/usr/bin/env python3
"""
OneDrive File Ingestion into Open Brain.

Reads the post-reorg file inventory, extracts text via file-ingestion service,
and submits to Open Brain as captures via /api/v1/documents/batch.

Runs on open-brain-vm or homeserver. Checkpoint/resume via SQLite.

Usage:
    python ingest-onedrive.py --status                    # show progress
    python ingest-onedrive.py --dry-run                   # preview without ingesting
    python ingest-onedrive.py                             # run full ingestion
    python ingest-onedrive.py --domain Work               # ingest one domain only
    python ingest-onedrive.py --batch-size 25             # smaller batches
"""

import argparse, json, logging, os, sqlite3, sys, time
from pathlib import Path
from collections import Counter

import requests

sys.stdout.reconfigure(line_buffering=True)
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s",
                    datefmt="%Y-%m-%d %H:%M:%S")
log = logging.getLogger("ingest-onedrive")

# --- Config ---
INVENTORY_DB = os.environ.get("INVENTORY_DB", "/mnt/user/appdata/open-brain/file-inventory-reorg.db")
PROGRESS_DB = os.environ.get("PROGRESS_DB", os.path.expanduser("~/.file-ingestion/progress.db"))
CORE_API = os.environ.get("CORE_API_URL", "http://192.168.10.50:3002")
FILE_INGESTION = os.environ.get("FILE_INGESTION_URL", "http://192.168.10.50:3007")
ONEDRIVE_CONTAINER_PATH = "/data/onedrive"  # Path inside file-ingestion container

EXTRACTABLE_EXTS = {'.pdf', '.docx', '.doc', '.pptx', '.xlsx', '.txt', '.md', '.csv', '.html', '.htm'}

# Map top-level dirs to brain_views
DOMAIN_TO_VIEW = {
    "Work": "work-internal",
    "Amateur Radio": "technical",
    "Making": "technical",
    "Personal": "personal",
    "Sailing": "personal",
    "Projects": "technical",
    "Reference": "technical",
    "App Data": "technical",
    "_Archive": "personal",
}

CALLER_HEADER = "X-Open-Brain-Caller"
CALLER_VALUE = "file-ingestion-batch"


def init_progress_db() -> sqlite3.Connection:
    Path(PROGRESS_DB).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(PROGRESS_DB, timeout=30)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS ingested (
            path TEXT PRIMARY KEY, capture_id TEXT, status TEXT,
            error TEXT, ingested_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS extraction_cache (
            path TEXT PRIMARY KEY, text_content TEXT, metadata_json TEXT,
            extracted_at TEXT DEFAULT (datetime('now'))
        );
    """)
    conn.commit()
    return conn


def is_ingested(pconn, path):
    r = pconn.execute("SELECT status FROM ingested WHERE path=?", (path,)).fetchone()
    return r is not None  # skip ok, error, empty — all already processed


def get_cached_extraction(pconn, path):
    r = pconn.execute("SELECT text_content, metadata_json FROM extraction_cache WHERE path=?", (path,)).fetchone()
    if r:
        return r[0], json.loads(r[1]) if r[1] else {}
    return None, None


def cache_extraction(pconn, path, text, metadata):
    pconn.execute("INSERT OR REPLACE INTO extraction_cache(path, text_content, metadata_json) VALUES(?,?,?)",
                  (path, text[:500000], json.dumps(metadata)))
    pconn.commit()


def record_ingestion(pconn, path, capture_id, status, error=None):
    pconn.execute("INSERT OR REPLACE INTO ingested(path, capture_id, status, error) VALUES(?,?,?,?)",
                  (path, capture_id, status, error))
    pconn.commit()


MAX_FILE_SIZE_MB = 50  # Skip files larger than this to avoid choking the extractor

def extract_text(path, session, size_bytes=0):
    """Call file-ingestion /extract to get text from a file. Skip oversized files."""
    if size_bytes and size_bytes > MAX_FILE_SIZE_MB * 1024 * 1024:
        return None, None, f"skipped: file too large ({size_bytes/1024/1024:.0f} MB > {MAX_FILE_SIZE_MB} MB)"
    container_path = f"{ONEDRIVE_CONTAINER_PATH}/{path}"
    try:
        resp = session.post(f"{FILE_INGESTION}/extract",
                           json={"file_path": container_path}, timeout=60)
        if resp.status_code != 200:
            return None, None, f"extract {resp.status_code}: {resp.text[:200]}"
        data = resp.json()
        text = data.get("text", "")
        metadata = {k: v for k, v in data.items() if k != "text" and v}
        return text, metadata, None
    except requests.exceptions.Timeout:
        return None, None, f"skipped: extraction timeout (>60s)"
    except Exception as e:
        return None, None, str(e)


def submit_batch(batch, session):
    """Submit a batch of files to /api/v1/documents/batch."""
    files_payload = []
    for item in batch:
        entry = {
            "title": item["filename"],
            "original_path": item["path"],
            "mime_type": item.get("mime_type", "application/octet-stream"),
            "file_size": item.get("size", 0),
            "modified_date": item.get("modified_at", ""),
            "brain_view": item.get("brain_view", "technical"),
            "tags": item.get("tags", []),
            "content": item.get("text", ""),
        }
        if item.get("content_hash"):
            entry["content_hash"] = item["content_hash"]
        if item.get("category"):
            entry["category"] = item["category"]
            entry["taxonomy_path"] = item["path"].rsplit("/", 1)[0]
        files_payload.append(entry)

    try:
        resp = session.post(f"{CORE_API}/api/v1/documents/batch",
                           json={"files": files_payload}, timeout=120)
        if resp.status_code in (200, 201):
            return resp.json(), None
        return None, f"batch {resp.status_code}: {resp.text[:300]}"
    except Exception as e:
        return None, str(e)


def get_extractable_files(inv_conn, domain=None):
    """Get extractable files from inventory, optionally filtered by domain."""
    ext_list = ",".join(f"'{e}'" for e in EXTRACTABLE_EXTS)
    query = f"""
        SELECT path, filename, extension, size_bytes, modified_at, mime_type, sha256
        FROM files
        WHERE LOWER(extension) IN ({ext_list})
        AND size_bytes > 0
    """
    if domain:
        query += f" AND path LIKE '{domain}/%'"
    query += " ORDER BY path"
    return inv_conn.execute(query).fetchall()


def run_ingestion(args):
    inv_conn = sqlite3.connect(INVENTORY_DB)
    pconn = init_progress_db()
    session = requests.Session()
    session.headers[CALLER_HEADER] = CALLER_VALUE

    files = get_extractable_files(inv_conn, args.domain)
    # Filter already ingested
    remaining = [f for f in files if not is_ingested(pconn, f[0])]

    log.info(f"Total extractable: {len(files)}, already ingested: {len(files) - len(remaining)}, remaining: {len(remaining)}")

    if args.dry_run:
        domains = Counter()
        for f in remaining:
            top = f[0].split("/")[0] if "/" in f[0] else "(root)"
            domains[top] += 1
        log.info("Dry run — files by domain:")
        for d, c in domains.most_common():
            log.info(f"  {d}: {c}")
        inv_conn.close()
        pconn.close()
        return

    extracted = 0
    submitted = 0
    errors = 0
    batch = []
    batch_start = time.monotonic()

    for i, (path, filename, ext, size, modified, mime, sha256) in enumerate(remaining):
        # Extract text (check cache first)
        text, metadata = get_cached_extraction(pconn, path)
        if text is None:
            text, metadata, err = extract_text(path, session, size_bytes=size)
            if err:
                log.warning(f"  Extract failed: {path}: {err}")
                record_ingestion(pconn, path, "", "extract_error", err)
                errors += 1
                continue
            if text:
                cache_extraction(pconn, path, text, metadata or {})
            extracted += 1

        if not text or len(text.strip()) < 50:
            record_ingestion(pconn, path, "", "empty", "text too short")
            continue

        # Determine brain_view from top-level dir
        top_dir = path.split("/")[0] if "/" in path else "(root)"
        brain_view = DOMAIN_TO_VIEW.get(top_dir, "technical")

        # Build tags from path
        parts = path.split("/")
        tags = [parts[0]] if parts else []
        if len(parts) > 1:
            tags.append(parts[1])

        batch.append({
            "path": path,
            "filename": filename,
            "text": text[:50000],  # API limit
            "mime_type": mime or f"application/{ext.lstrip('.')}",
            "size": size,
            "modified_at": modified or "",
            "content_hash": sha256 or "",
            "brain_view": brain_view,
            "category": top_dir,
            "tags": tags,
        })

        # Submit batch when full
        if len(batch) >= args.batch_size:
            result, err = submit_batch(batch, session)
            if err:
                log.error(f"  Batch submit failed: {err}")
                for item in batch:
                    record_ingestion(pconn, item["path"], "", "submit_error", err)
                errors += len(batch)
            else:
                queued = result.get("queued", 0)
                submitted += queued
                for j, item in enumerate(batch):
                    results = result.get("results", [])
                    cid = results[j].get("capture_id", "") if j < len(results) else ""
                    record_ingestion(pconn, item["path"], cid, "ok")

            elapsed = time.monotonic() - batch_start
            rate = (extracted + submitted) / max(elapsed, 1)
            log.info(f"  [{i+1}/{len(remaining)}] extracted={extracted} submitted={submitted} "
                     f"errors={errors} rate={rate:.1f}/s")
            batch = []
            time.sleep(0.5)  # Brief pause between batches

    # Submit final partial batch
    if batch:
        result, err = submit_batch(batch, session)
        if err:
            log.error(f"  Final batch failed: {err}")
            for item in batch:
                record_ingestion(pconn, item["path"], "", "submit_error", err)
            errors += len(batch)
        else:
            queued = result.get("queued", 0)
            submitted += queued
            for j, item in enumerate(batch):
                results = result.get("results", [])
                cid = results[j].get("capture_id", "") if j < len(results) else ""
                record_ingestion(pconn, item["path"], cid, "ok")

    elapsed = time.monotonic() - batch_start
    log.info(f"\n=== INGESTION COMPLETE ===")
    log.info(f"  Extracted: {extracted}")
    log.info(f"  Submitted: {submitted}")
    log.info(f"  Errors: {errors}")
    log.info(f"  Duration: {elapsed/60:.1f} minutes")
    log.info(f"  Rate: {submitted/max(elapsed, 1)*60:.0f} files/min")

    inv_conn.close()
    pconn.close()


def show_status():
    pconn = init_progress_db()
    total = pconn.execute("SELECT COUNT(*) FROM ingested").fetchone()[0]
    ok = pconn.execute("SELECT COUNT(*) FROM ingested WHERE status='ok'").fetchone()[0]
    errs = pconn.execute("SELECT COUNT(*) FROM ingested WHERE status LIKE '%error%'").fetchone()[0]
    empty = pconn.execute("SELECT COUNT(*) FROM ingested WHERE status='empty'").fetchone()[0]
    cached = pconn.execute("SELECT COUNT(*) FROM extraction_cache").fetchone()[0]

    print(f"\n=== File Ingestion Status ===")
    print(f"  Total processed: {total}")
    print(f"  Successfully ingested: {ok}")
    print(f"  Errors: {errs}")
    print(f"  Empty/skipped: {empty}")
    print(f"  Extraction cache: {cached}")

    if errs > 0:
        print(f"\n  Recent errors:")
        for path, err in pconn.execute(
            "SELECT path, error FROM ingested WHERE status LIKE '%error%' ORDER BY ingested_at DESC LIMIT 5"
        ).fetchall():
            print(f"    {path}: {err[:80]}")
    print()
    pconn.close()


def main():
    ap = argparse.ArgumentParser(description="Ingest OneDrive files into Open Brain")
    ap.add_argument("--dry-run", action="store_true", help="Preview without ingesting")
    ap.add_argument("--status", action="store_true", help="Show progress")
    ap.add_argument("--domain", type=str, help="Ingest one domain only (e.g., Work, Personal)")
    ap.add_argument("--batch-size", type=int, default=50, help="Files per API batch (default: 50)")
    args = ap.parse_args()

    if args.status:
        show_status()
        return

    run_ingestion(args)


if __name__ == "__main__":
    main()
