#!/usr/bin/env python3
"""
Open Brain Batch Wiki-Ingest Orchestrator

Reads categorized files from the inventory SQLite database, groups them by
taxonomy domain (category), and submits each to core-api as a file capture
via the /api/v1/documents/batch endpoint. Tracks processing status in SQLite,
supports checkpoint/resume, triggers wiki-lint after each domain batch, and
generates a completion report.

Usage:
    python scripts/batch-wiki-ingest.py --db /mnt/user/openbrain/inventory.db
    python scripts/batch-wiki-ingest.py --db ./inventory.db --domain technical --batch-size 25
    python scripts/batch-wiki-ingest.py --db ./inventory.db --dry-run
    python scripts/batch-wiki-ingest.py --db ./inventory.db --pilot
    python scripts/batch-wiki-ingest.py --db ./inventory.db --report-only

Requires: requests (pip install requests)
"""

import argparse
import json
import logging
import sqlite3
import sys
import time
from datetime import UTC, datetime
from pathlib import Path

try:
    import requests
except ImportError:
    print("ERROR: requests not installed. Run: pip install requests", file=sys.stderr)
    sys.exit(1)

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("batch-wiki-ingest")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
DEFAULT_API_URL = "http://localhost:3002"
DEFAULT_BATCH_SIZE = 25
MAX_API_BATCH_SIZE = 100  # core-api limit per request
INTER_BATCH_DELAY_SECS = 5  # pause between API batch submissions
CALLER_HEADER = "batch-wiki-ingest"

# Pilot mode: process at most this many files per domain, one domain only
PILOT_MAX_FILES = 5
PILOT_BATCH_SIZE = 5

# Map inventory categories to brain_views
CATEGORY_TO_BRAIN_VIEW = {
    "business": "work-internal",
    "technical": "technical",
    "personal": "personal",
    "reference": "technical",
    "creative": "personal",
    "financial": "work-internal",
    "legal": "work-internal",
    "education": "technical",
    "communication": "work-internal",
    "data": "technical",
}


# ---------------------------------------------------------------------------
# SQLite schema extension for wiki-ingest tracking
# ---------------------------------------------------------------------------

TRACKING_DDL = """
CREATE TABLE IF NOT EXISTS wiki_ingest_status (
    file_id INTEGER PRIMARY KEY REFERENCES files(id),
    capture_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',  -- pending, submitted, completed, error, skipped
    error_message TEXT,
    submitted_at TEXT,
    completed_at TEXT,
    domain TEXT,
    batch_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_wiki_ingest_status ON wiki_ingest_status(status);
CREATE INDEX IF NOT EXISTS idx_wiki_ingest_domain ON wiki_ingest_status(domain);

CREATE TABLE IF NOT EXISTS wiki_ingest_batches (
    batch_id TEXT PRIMARY KEY,
    domain TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    files_total INTEGER NOT NULL DEFAULT 0,
    files_submitted INTEGER NOT NULL DEFAULT 0,
    files_error INTEGER NOT NULL DEFAULT 0,
    files_skipped INTEGER NOT NULL DEFAULT 0,
    lint_triggered INTEGER NOT NULL DEFAULT 0,
    lint_pages_scanned INTEGER,
    lint_issues_found INTEGER
);
"""


def init_tracking(conn: sqlite3.Connection) -> None:
    """Add wiki-ingest tracking tables if they don't exist."""
    conn.executescript(TRACKING_DDL)
    conn.commit()


# ---------------------------------------------------------------------------
# Inventory queries
# ---------------------------------------------------------------------------


def get_domains(conn: sqlite3.Connection) -> list[tuple[str, int]]:
    """Return (category, file_count) for all categorized, non-duplicate files."""
    cursor = conn.execute("""
        SELECT category, COUNT(*) as cnt
        FROM files
        WHERE category IS NOT NULL
          AND is_duplicate = 0
          AND id NOT IN (
              SELECT file_id FROM wiki_ingest_status
              WHERE status IN ('submitted', 'completed')
          )
        GROUP BY category
        ORDER BY cnt DESC
    """)
    return cursor.fetchall()


def get_domain_files(
    conn: sqlite3.Connection,
    domain: str,
    limit: int | None = None,
) -> list[dict]:
    """Get files for a domain that haven't been submitted yet."""
    query = """
        SELECT f.id, f.path, f.filename, f.extension, f.size, f.mime_type,
               f.modified_date, f.extracted_text, f.category, f.subcategory,
               f.description, f.tags
        FROM files f
        WHERE f.category = ?
          AND f.is_duplicate = 0
          AND f.id NOT IN (
              SELECT file_id FROM wiki_ingest_status
              WHERE status IN ('submitted', 'completed')
          )
        ORDER BY f.size DESC
    """
    if limit:
        query += f" LIMIT {limit}"
    cursor = conn.execute(query, (domain,))
    columns = [desc[0] for desc in cursor.description]
    return [dict(zip(columns, row, strict=False)) for row in cursor.fetchall()]


# ---------------------------------------------------------------------------
# API submission
# ---------------------------------------------------------------------------


def submit_batch(
    api_url: str,
    files: list[dict],
    domain: str,
    dry_run: bool = False,
) -> list[dict]:
    """Submit a batch of files to core-api /api/v1/documents/batch.

    Returns list of result dicts with: file_id, capture_id, status, error.
    """
    results = []

    if dry_run:
        for f in files:
            results.append(
                {
                    "file_id": f["id"],
                    "capture_id": None,
                    "status": "dry_run",
                    "error": None,
                }
            )
        return results

    # Build batch payload
    batch_items = []
    file_id_map = {}  # index -> file_id

    for idx, f in enumerate(files):
        brain_view = CATEGORY_TO_BRAIN_VIEW.get(f["category"], "technical")

        # Parse tags from JSON string
        tags = []
        if f.get("tags"):
            try:
                parsed_tags = json.loads(f["tags"])
                if isinstance(parsed_tags, list):
                    tags = [str(t) for t in parsed_tags]
            except (json.JSONDecodeError, TypeError):
                pass

        # Add domain as a tag
        if domain not in tags:
            tags.append(domain)

        # Build content from extracted text or description
        content = None
        if f.get("extracted_text"):
            # Truncate to reasonable size for capture content
            text = f["extracted_text"].strip()
            content = text[:10000] + "\n\n[...truncated...]" if len(text) > 10000 else text

        item = {
            "title": f.get("description") or f["filename"],
            "original_path": f["path"],
            "mime_type": f["mime_type"] or "application/octet-stream",
            "file_size": f.get("size"),
            "modified_date": f.get("modified_date"),
            "category": f.get("category"),
            "subcategory": f.get("subcategory"),
            "taxonomy_path": f"{f.get('category', 'uncategorized')}/{f.get('subcategory', 'general')}",
            "brain_view": brain_view,
            "tags": tags,
        }
        if content:
            item["content"] = content

        batch_items.append(item)
        file_id_map[idx] = f["id"]

    # Submit to API
    url = f"{api_url}/api/v1/documents/batch"
    headers = {
        "Content-Type": "application/json",
        "X-Open-Brain-Caller": CALLER_HEADER,
    }

    try:
        resp = requests.post(
            url,
            json={"files": batch_items},
            headers=headers,
            timeout=120,
        )

        if resp.status_code == 201:
            data = resp.json()
            api_results = data.get("results", [])

            for item in api_results:
                idx = item.get("index", -1)
                file_id = file_id_map.get(idx)
                if file_id is None:
                    continue

                if item.get("capture_id"):
                    results.append(
                        {
                            "file_id": file_id,
                            "capture_id": item["capture_id"],
                            "status": "submitted",
                            "error": None,
                        }
                    )
                else:
                    results.append(
                        {
                            "file_id": file_id,
                            "capture_id": None,
                            "status": "error",
                            "error": item.get("error", "Unknown API error"),
                        }
                    )
        else:
            error_msg = f"HTTP {resp.status_code}: {resp.text[:300]}"
            logger.error("Batch API error: %s", error_msg)
            for idx, file_id in file_id_map.items():
                results.append(
                    {
                        "file_id": file_id,
                        "capture_id": None,
                        "status": "error",
                        "error": error_msg,
                    }
                )

    except requests.exceptions.ConnectionError:
        error_msg = f"Cannot connect to API at {api_url}"
        logger.error(error_msg)
        for idx, file_id in file_id_map.items():
            results.append(
                {
                    "file_id": file_id,
                    "capture_id": None,
                    "status": "error",
                    "error": error_msg,
                }
            )
    except requests.exceptions.Timeout:
        error_msg = "API request timed out (120s)"
        logger.error(error_msg)
        for idx, file_id in file_id_map.items():
            results.append(
                {
                    "file_id": file_id,
                    "capture_id": None,
                    "status": "error",
                    "error": error_msg,
                }
            )

    return results


def record_results(
    conn: sqlite3.Connection,
    results: list[dict],
    domain: str,
    batch_id: str,
) -> tuple[int, int]:
    """Write submission results to wiki_ingest_status. Returns (submitted, errors)."""
    now = datetime.now(UTC).isoformat()
    submitted = 0
    errors = 0

    for r in results:
        status = r["status"]
        if status == "dry_run":
            status = "skipped"

        conn.execute(
            """
            INSERT OR REPLACE INTO wiki_ingest_status
            (file_id, capture_id, status, error_message, submitted_at, domain, batch_id)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
            (
                r["file_id"],
                r.get("capture_id"),
                status,
                r.get("error"),
                now if status == "submitted" else None,
                domain,
                batch_id,
            ),
        )

        if status == "submitted":
            submitted += 1
        elif status == "error":
            errors += 1

    conn.commit()
    return submitted, errors


# ---------------------------------------------------------------------------
# Wiki-lint trigger
# ---------------------------------------------------------------------------


def trigger_wiki_lint(api_url: str) -> dict | None:
    """Trigger wiki-lint skill via the skills API. Returns result or None on failure."""
    url = f"{api_url}/api/v1/skills/wiki-lint/run"
    headers = {
        "Content-Type": "application/json",
        "X-Open-Brain-Caller": CALLER_HEADER,
    }

    try:
        resp = requests.post(url, json={}, headers=headers, timeout=300)
        if resp.status_code in (200, 201, 202):
            return resp.json()
        else:
            logger.warning("Wiki-lint trigger returned %d: %s", resp.status_code, resp.text[:200])
            return None
    except requests.exceptions.ConnectionError:
        logger.warning("Cannot connect to API for wiki-lint trigger")
        return None
    except requests.exceptions.Timeout:
        logger.warning("Wiki-lint trigger timed out (300s)")
        return None


# ---------------------------------------------------------------------------
# Domain batch processing
# ---------------------------------------------------------------------------


def process_domain(
    conn: sqlite3.Connection,
    domain: str,
    api_url: str,
    batch_size: int,
    max_files: int | None,
    dry_run: bool,
    skip_lint: bool,
) -> dict:
    """Process all files in a domain. Returns stats dict."""
    batch_id = f"{domain}_{datetime.now(UTC).strftime('%Y%m%d_%H%M%S')}"
    start_time = time.monotonic()

    files = get_domain_files(conn, domain, limit=max_files)
    total = len(files)

    logger.info(
        "Domain '%s': %d files to process (batch_size=%d, dry_run=%s)",
        domain,
        total,
        batch_size,
        dry_run,
    )

    if total == 0:
        logger.info("Domain '%s': no unprocessed files", domain)
        return {"domain": domain, "total": 0, "submitted": 0, "errors": 0, "skipped": 0}

    # Record batch start
    conn.execute(
        """
        INSERT INTO wiki_ingest_batches (batch_id, domain, started_at, files_total)
        VALUES (?, ?, ?, ?)
    """,
        (batch_id, domain, datetime.now(UTC).isoformat(), total),
    )
    conn.commit()

    total_submitted = 0
    total_errors = 0
    total_skipped = 0

    # Process in chunks of batch_size
    for offset in range(0, total, batch_size):
        chunk = files[offset : offset + batch_size]
        chunk_num = offset // batch_size + 1
        total_chunks = (total + batch_size - 1) // batch_size

        logger.info(
            "  Batch %d/%d: %d files (offset %d)", chunk_num, total_chunks, len(chunk), offset
        )

        # Respect API max batch size
        for api_offset in range(0, len(chunk), MAX_API_BATCH_SIZE):
            api_chunk = chunk[api_offset : api_offset + MAX_API_BATCH_SIZE]

            results = submit_batch(api_url, api_chunk, domain, dry_run=dry_run)
            submitted, errors = record_results(conn, results, domain, batch_id)
            total_submitted += submitted
            total_errors += errors
            total_skipped += sum(1 for r in results if r["status"] in ("dry_run", "skipped"))

            logger.info("    API batch: %d submitted, %d errors", submitted, errors)

        # Pause between batches to respect rate limits
        if offset + batch_size < total:
            logger.info("  Pausing %ds between batches...", INTER_BATCH_DELAY_SECS)
            time.sleep(INTER_BATCH_DELAY_SECS)

    elapsed = time.monotonic() - start_time

    # Trigger wiki-lint after domain batch
    lint_result = None
    if not skip_lint and not dry_run and total_submitted > 0:
        logger.info("  Triggering wiki-lint for post-batch quality check...")
        lint_result = trigger_wiki_lint(api_url)
        if lint_result:
            logger.info(
                "  Wiki-lint: scanned=%s, issues=%s",
                lint_result.get("pagesScanned", "?"),
                lint_result.get("issuesFound", "?"),
            )
        else:
            logger.warning("  Wiki-lint trigger failed (non-fatal)")

    # Update batch record
    conn.execute(
        """
        UPDATE wiki_ingest_batches
        SET completed_at = ?,
            files_submitted = ?,
            files_error = ?,
            files_skipped = ?,
            lint_triggered = ?,
            lint_pages_scanned = ?,
            lint_issues_found = ?
        WHERE batch_id = ?
    """,
        (
            datetime.now(UTC).isoformat(),
            total_submitted,
            total_errors,
            total_skipped,
            1 if lint_result else 0,
            lint_result.get("pagesScanned") if lint_result else None,
            lint_result.get("issuesFound") if lint_result else None,
            batch_id,
        ),
    )
    conn.commit()

    stats = {
        "domain": domain,
        "batch_id": batch_id,
        "total": total,
        "submitted": total_submitted,
        "errors": total_errors,
        "skipped": total_skipped,
        "elapsed_secs": round(elapsed, 1),
        "lint_triggered": lint_result is not None,
        "lint_pages_scanned": lint_result.get("pagesScanned") if lint_result else None,
        "lint_issues_found": lint_result.get("issuesFound") if lint_result else None,
    }

    logger.info(
        "Domain '%s' complete: %d submitted, %d errors, %d skipped (%.1fs)",
        domain,
        total_submitted,
        total_errors,
        total_skipped,
        elapsed,
    )

    return stats


# ---------------------------------------------------------------------------
# Report generation
# ---------------------------------------------------------------------------


def generate_report(conn: sqlite3.Connection, domain_stats: list[dict] | None = None) -> None:
    """Print a comprehensive batch completion report."""
    print("\n" + "=" * 70)
    print("BATCH WIKI-INGEST REPORT")
    print("=" * 70)
    print(f"Generated: {datetime.now(UTC).isoformat()}")

    # Overall status
    cursor = conn.execute("""
        SELECT status, COUNT(*) as cnt
        FROM wiki_ingest_status
        GROUP BY status
        ORDER BY cnt DESC
    """)
    status_rows = cursor.fetchall()
    if status_rows:
        print("\n--- Overall Ingest Status ---")
        print(f"{'Status':<15} {'Count':>8}")
        print("-" * 25)
        for status, count in status_rows:
            print(f"{status:<15} {count:>8,}")

    # Per-domain status
    cursor = conn.execute("""
        SELECT domain, status, COUNT(*) as cnt
        FROM wiki_ingest_status
        GROUP BY domain, status
        ORDER BY domain, status
    """)
    domain_rows = cursor.fetchall()
    if domain_rows:
        print("\n--- Per-Domain Status ---")
        current_domain = None
        for domain, status, count in domain_rows:
            if domain != current_domain:
                print(f"\n  {domain}:")
                current_domain = domain
            print(f"    {status:<15} {count:>8,}")

    # Remaining unprocessed files by domain
    cursor = conn.execute("""
        SELECT f.category, COUNT(*) as cnt
        FROM files f
        WHERE f.category IS NOT NULL
          AND f.is_duplicate = 0
          AND f.id NOT IN (
              SELECT file_id FROM wiki_ingest_status
              WHERE status IN ('submitted', 'completed')
          )
        GROUP BY f.category
        ORDER BY cnt DESC
    """)
    remaining = cursor.fetchall()
    if remaining:
        total_remaining = sum(r[1] for r in remaining)
        print(f"\n--- Remaining Unprocessed Files ({total_remaining:,} total) ---")
        print(f"{'Domain':<20} {'Count':>8}")
        print("-" * 30)
        for domain, count in remaining:
            print(f"{domain:<20} {count:>8,}")
    else:
        print("\nAll categorized files have been processed!")

    # Batch history
    cursor = conn.execute("""
        SELECT batch_id, domain, started_at, completed_at,
               files_total, files_submitted, files_error, files_skipped,
               lint_triggered, lint_pages_scanned, lint_issues_found
        FROM wiki_ingest_batches
        ORDER BY started_at DESC
        LIMIT 20
    """)
    batches = cursor.fetchall()
    if batches:
        print("\n--- Recent Batch History (last 20) ---")
        for (
            batch_id,
            domain,
            _started,
            completed,
            total,
            submitted,
            errors,
            _skipped,
            lint,
            lint_pages,
            lint_issues,
        ) in batches:
            status = "DONE" if completed else "IN PROGRESS"
            lint_info = ""
            if lint:
                lint_info = f" | lint: {lint_pages}pp/{lint_issues}issues"
            print(
                f"  {batch_id}: {submitted}/{total} submitted, "
                f"{errors} errors [{status}]{lint_info}"
            )

    # Current session stats (if provided)
    if domain_stats:
        print("\n--- This Session ---")
        total_files = sum(s["total"] for s in domain_stats)
        total_submitted = sum(s["submitted"] for s in domain_stats)
        total_errors = sum(s["errors"] for s in domain_stats)
        total_skipped = sum(s["skipped"] for s in domain_stats)
        total_elapsed = sum(s.get("elapsed_secs", 0) for s in domain_stats)

        print(f"Domains processed: {len(domain_stats)}")
        print(f"Total files:       {total_files:,}")
        print(f"Submitted:         {total_submitted:,}")
        print(f"Errors:            {total_errors:,}")
        print(f"Skipped:           {total_skipped:,}")
        print(f"Elapsed:           {total_elapsed:.0f}s")

        if total_submitted > 0 and total_elapsed > 0:
            rate = total_submitted / total_elapsed * 60
            print(f"Rate:              {rate:.1f} files/min")

    print("\n" + "=" * 70)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Batch wiki-ingest orchestrator for Open Brain file migration",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Process all domains
  python scripts/batch-wiki-ingest.py --db /mnt/user/openbrain/inventory.db

  # Process a single domain with custom batch size
  python scripts/batch-wiki-ingest.py --db ./inventory.db --domain technical --batch-size 25

  # Dry run (no API calls, marks files as skipped in tracking)
  python scripts/batch-wiki-ingest.py --db ./inventory.db --dry-run

  # Pilot mode: 5 files from largest domain — validate pipeline before full run
  python scripts/batch-wiki-ingest.py --db ./inventory.db --pilot

  # Resume after interruption (automatically skips already-submitted files)
  python scripts/batch-wiki-ingest.py --db ./inventory.db --domain business

  # Just show the report without processing
  python scripts/batch-wiki-ingest.py --db ./inventory.db --report-only

  # Process with max file limit per domain
  python scripts/batch-wiki-ingest.py --db ./inventory.db --max-files 50
        """,
    )
    parser.add_argument(
        "--db",
        default="/mnt/user/openbrain/inventory.db",
        help="Path to inventory SQLite database (default: /mnt/user/openbrain/inventory.db)",
    )
    parser.add_argument(
        "--api-url",
        default=DEFAULT_API_URL,
        help=f"Core API URL (default: {DEFAULT_API_URL})",
    )
    parser.add_argument(
        "--domain",
        default=None,
        help="Process only this domain (category). Omit to process all domains.",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=DEFAULT_BATCH_SIZE,
        help=f"Files per batch checkpoint (default: {DEFAULT_BATCH_SIZE})",
    )
    parser.add_argument(
        "--max-files",
        type=int,
        default=None,
        help="Maximum files to process per domain (for testing)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Simulate processing without making API calls",
    )
    parser.add_argument(
        "--skip-lint",
        action="store_true",
        help="Skip wiki-lint trigger after each domain batch",
    )
    parser.add_argument(
        "--report-only",
        action="store_true",
        help="Show batch status report without processing",
    )
    parser.add_argument(
        "--pilot",
        action="store_true",
        help=(
            f"Pilot mode: process only {PILOT_MAX_FILES} files from the largest domain "
            f"(batch-size={PILOT_BATCH_SIZE}). Use to validate end-to-end pipeline before "
            f"committing to a full run. Implies --skip-lint."
        ),
    )
    args = parser.parse_args()

    db_path = args.db
    if not Path(db_path).exists():
        logger.error("Database not found: %s (run file-inventory.py first)", db_path)
        sys.exit(1)

    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA journal_mode=WAL")
    init_tracking(conn)

    if args.report_only:
        generate_report(conn)
        conn.close()
        return

    # Pilot mode: override settings for a minimal smoke-test run
    if args.pilot:
        logger.info(
            "PILOT MODE — processing %d files from the largest domain only (skip-lint=True)",
            PILOT_MAX_FILES,
        )
        args.max_files = PILOT_MAX_FILES
        args.batch_size = PILOT_BATCH_SIZE
        args.skip_lint = True
        # Force single domain: pick the largest by unprocessed file count
        if not args.domain:
            available = get_domains(conn)
            if available:
                args.domain = available[0][0]
                logger.info("Pilot: auto-selected domain '%s' (%d files)", args.domain, available[0][1])
            else:
                logger.info("No unprocessed domains found — nothing to pilot")
                generate_report(conn)
                conn.close()
                return

    # Determine domains to process
    if args.domain:
        # Validate domain exists
        cursor = conn.execute(
            "SELECT COUNT(*) FROM files WHERE category = ? AND is_duplicate = 0",
            (args.domain,),
        )
        count = cursor.fetchone()[0]
        if count == 0:
            logger.error("No files found for domain '%s'", args.domain)
            available = get_domains(conn)
            if available:
                logger.info("Available domains: %s", ", ".join(f"{d} ({c})" for d, c in available))
            conn.close()
            sys.exit(1)
        domains = [(args.domain, count)]
    else:
        domains = get_domains(conn)
        if not domains:
            logger.info("No unprocessed domains found")
            generate_report(conn)
            conn.close()
            return

    logger.info("Domains to process: %s", ", ".join(f"{d} ({c} files)" for d, c in domains))

    if args.dry_run:
        logger.info("DRY RUN MODE — no API calls will be made")

    # Process each domain
    all_stats = []
    for domain, file_count in domains:
        try:
            stats = process_domain(
                conn=conn,
                domain=domain,
                api_url=args.api_url,
                batch_size=args.batch_size,
                max_files=args.max_files,
                dry_run=args.dry_run,
                skip_lint=args.skip_lint,
            )
            all_stats.append(stats)
        except KeyboardInterrupt:
            logger.info("Interrupted! Progress has been checkpointed.")
            break
        except Exception as e:
            logger.error("Error processing domain '%s': %s", domain, e)
            all_stats.append(
                {
                    "domain": domain,
                    "total": file_count,
                    "submitted": 0,
                    "errors": file_count,
                    "skipped": 0,
                    "elapsed_secs": 0,
                }
            )

    # Generate completion report
    generate_report(conn, domain_stats=all_stats)
    conn.close()

    logger.info("Batch wiki-ingest complete. Database: %s", db_path)


if __name__ == "__main__":
    main()
