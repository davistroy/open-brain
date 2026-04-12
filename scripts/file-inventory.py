#!/usr/bin/env python3
"""
Open Brain File Inventory — Build SQLite inventory of staged files.

Walks a staging directory, records file metadata, computes two-tier hashes
(xxhash-64KB for fast grouping, SHA-256 for exact duplicate confirmation),
and optionally calls the Python extraction service for text-bearing formats.

Usage:
    python scripts/file-inventory.py --staging-dir /mnt/user/openbrain/staging
    python scripts/file-inventory.py --staging-dir ./test-staging --db ./inventory.db
    python scripts/file-inventory.py --staging-dir /data --extraction-url http://localhost:8080

Requires: xxhash (pip install xxhash)
"""

import argparse
import hashlib
import logging
import mimetypes
import os
import sqlite3
import sys
import time
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

try:
    import xxhash
except ImportError:
    print("ERROR: xxhash not installed. Run: pip install xxhash", file=sys.stderr)
    sys.exit(1)

try:
    import requests
except ImportError:
    requests = None  # type: ignore[assignment]

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("file-inventory")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
XXHASH_CHUNK_SIZE = 64 * 1024  # 64KB for partial hash
SHA256_CHUNK_SIZE = 128 * 1024  # 128KB chunks for full SHA-256

# Extensions the extraction service supports
EXTRACTABLE_EXTENSIONS = {
    ".pdf", ".docx", ".pptx", ".xlsx", ".txt", ".md", ".csv", ".html", ".htm",
}

# ---------------------------------------------------------------------------
# Database setup
# ---------------------------------------------------------------------------

CREATE_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL UNIQUE,
    filename TEXT NOT NULL,
    extension TEXT NOT NULL,
    size INTEGER NOT NULL,
    modified_date TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    xxhash_partial TEXT NOT NULL,
    sha256_full TEXT,
    extracted_text TEXT,
    extraction_metadata TEXT,
    extraction_error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),

    -- Categorization columns (populated by file-categorize.py)
    category TEXT,
    subcategory TEXT,
    description TEXT,
    tags TEXT,

    -- Dedup columns (populated by file-dedup.py)
    is_duplicate INTEGER DEFAULT 0,
    duplicate_of TEXT,
    is_near_duplicate INTEGER DEFAULT 0,
    near_duplicate_of TEXT,
    near_duplicate_score REAL
);

CREATE INDEX IF NOT EXISTS idx_files_xxhash ON files(xxhash_partial);
CREATE INDEX IF NOT EXISTS idx_files_sha256 ON files(sha256_full);
CREATE INDEX IF NOT EXISTS idx_files_size ON files(size);
CREATE INDEX IF NOT EXISTS idx_files_extension ON files(extension);
CREATE INDEX IF NOT EXISTS idx_files_is_duplicate ON files(is_duplicate);
CREATE INDEX IF NOT EXISTS idx_files_category ON files(category);
"""


def init_db(db_path: str) -> sqlite3.Connection:
    """Initialize SQLite database with inventory schema."""
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.executescript(CREATE_TABLE_SQL)
    conn.commit()
    logger.info("Database initialized at %s", db_path)
    return conn


# ---------------------------------------------------------------------------
# Hashing
# ---------------------------------------------------------------------------

def compute_xxhash_partial(file_path: Path) -> str:
    """Compute xxhash64 of the first 64KB of a file."""
    h = xxhash.xxh64()
    with open(file_path, "rb") as f:
        data = f.read(XXHASH_CHUNK_SIZE)
        h.update(data)
    return h.hexdigest()


def compute_sha256_full(file_path: Path) -> str:
    """Compute full SHA-256 hash of a file, streaming in chunks."""
    h = hashlib.sha256()
    with open(file_path, "rb") as f:
        while True:
            chunk = f.read(SHA256_CHUNK_SIZE)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


# ---------------------------------------------------------------------------
# Content extraction via HTTP service
# ---------------------------------------------------------------------------

def extract_content(file_path: str, extraction_url: str) -> tuple[str | None, str | None, str | None]:
    """Call the extraction service for a file. Returns (text, metadata_json, error)."""
    if requests is None:
        return None, None, "requests library not installed"

    try:
        resp = requests.post(
            f"{extraction_url}/extract",
            json={"file_path": file_path},
            timeout=120,
        )
        if resp.status_code == 200:
            data = resp.json()
            import json
            return data.get("text", ""), json.dumps(data.get("metadata", {})), None
        elif resp.status_code == 400:
            return None, None, f"Unsupported file type (HTTP 400)"
        else:
            return None, None, f"HTTP {resp.status_code}: {resp.text[:200]}"
    except requests.exceptions.ConnectionError:
        return None, None, "Extraction service unavailable"
    except requests.exceptions.Timeout:
        return None, None, "Extraction service timeout (120s)"
    except Exception as e:
        return None, None, f"{type(e).__name__}: {e}"


# ---------------------------------------------------------------------------
# File walking and inventory
# ---------------------------------------------------------------------------

def walk_staging(staging_dir: Path) -> list[Path]:
    """Walk staging directory and return all files (not directories, not hidden)."""
    files: list[Path] = []
    for root, dirs, filenames in os.walk(staging_dir):
        # Skip hidden directories
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        for fname in filenames:
            if fname.startswith("."):
                continue
            files.append(Path(root) / fname)
    return files


def get_mime_type(file_path: Path) -> str:
    """Detect MIME type from extension."""
    mime_type, _ = mimetypes.guess_type(str(file_path))
    return mime_type or "application/octet-stream"


def build_inventory(
    staging_dir: Path,
    db_path: str,
    extraction_url: str | None,
) -> None:
    """Main inventory builder. Walks staging, hashes, extracts, stores in SQLite."""
    conn = init_db(db_path)

    # Check how many files already inventoried (for resume)
    existing = set()
    cursor = conn.execute("SELECT path FROM files")
    for row in cursor:
        existing.add(row[0])
    logger.info("Found %d existing inventory entries", len(existing))

    # Walk staging directory
    all_files = walk_staging(staging_dir)
    logger.info("Found %d files in staging directory", len(all_files))

    new_files = [f for f in all_files if str(f) not in existing]
    logger.info("New files to inventory: %d (skipping %d already inventoried)",
                len(new_files), len(all_files) - len(new_files))

    if not new_files:
        logger.info("No new files to process")
        _generate_report(conn, staging_dir)
        conn.close()
        return

    # Phase 1: Walk and compute xxhash for all files
    logger.info("Phase 1: Computing xxhash for %d files...", len(new_files))
    file_records: list[dict] = []
    errors = 0

    for i, file_path in enumerate(new_files):
        if (i + 1) % 500 == 0 or i == 0:
            logger.info("  Hashing file %d/%d...", i + 1, len(new_files))

        try:
            stat = file_path.stat()
            record = {
                "path": str(file_path),
                "filename": file_path.name,
                "extension": file_path.suffix.lower(),
                "size": stat.st_size,
                "modified_date": datetime.fromtimestamp(
                    stat.st_mtime, tz=timezone.utc
                ).isoformat(),
                "mime_type": get_mime_type(file_path),
                "xxhash_partial": compute_xxhash_partial(file_path),
            }
            file_records.append(record)
        except (OSError, PermissionError) as e:
            logger.warning("Cannot read %s: %s", file_path, e)
            errors += 1

    logger.info("Phase 1 complete: %d files hashed, %d errors", len(file_records), errors)

    # Insert records into database
    conn.executemany(
        """INSERT OR IGNORE INTO files (path, filename, extension, size, modified_date, mime_type, xxhash_partial)
           VALUES (:path, :filename, :extension, :size, :modified_date, :mime_type, :xxhash_partial)""",
        file_records,
    )
    conn.commit()
    logger.info("Inserted %d file records into database", len(file_records))

    # Phase 2: Compute SHA-256 for files with matching (size, xxhash_partial)
    logger.info("Phase 2: Computing SHA-256 for size+xxhash collision groups...")
    cursor = conn.execute("""
        SELECT size, xxhash_partial, COUNT(*) as cnt
        FROM files
        WHERE sha256_full IS NULL
        GROUP BY size, xxhash_partial
        HAVING cnt > 1
    """)
    collision_groups = cursor.fetchall()
    logger.info("Found %d collision groups needing SHA-256", len(collision_groups))

    sha256_count = 0
    for size, xxhash_val, count in collision_groups:
        cursor2 = conn.execute(
            "SELECT id, path FROM files WHERE size = ? AND xxhash_partial = ? AND sha256_full IS NULL",
            (size, xxhash_val),
        )
        for file_id, file_path in cursor2.fetchall():
            try:
                sha256 = compute_sha256_full(Path(file_path))
                conn.execute(
                    "UPDATE files SET sha256_full = ? WHERE id = ?",
                    (sha256, file_id),
                )
                sha256_count += 1
            except (OSError, PermissionError) as e:
                logger.warning("Cannot hash %s: %s", file_path, e)

    conn.commit()
    logger.info("Phase 2 complete: computed SHA-256 for %d files", sha256_count)

    # Phase 3: Content extraction for text-bearing formats
    if extraction_url:
        logger.info("Phase 3: Extracting content via %s...", extraction_url)
        cursor = conn.execute(
            "SELECT id, path, extension FROM files WHERE extracted_text IS NULL AND extraction_error IS NULL"
        )
        extractable = [
            (fid, fpath, ext) for fid, fpath, ext in cursor.fetchall()
            if ext in EXTRACTABLE_EXTENSIONS
        ]
        logger.info("Files to extract: %d", len(extractable))

        extracted_ok = 0
        extracted_err = 0
        for i, (file_id, file_path, ext) in enumerate(extractable):
            if (i + 1) % 100 == 0 or i == 0:
                logger.info("  Extracting %d/%d...", i + 1, len(extractable))

            text, metadata_json, error = extract_content(file_path, extraction_url)
            if error:
                conn.execute(
                    "UPDATE files SET extraction_error = ? WHERE id = ?",
                    (error, file_id),
                )
                extracted_err += 1
            else:
                conn.execute(
                    "UPDATE files SET extracted_text = ?, extraction_metadata = ? WHERE id = ?",
                    (text, metadata_json, file_id),
                )
                extracted_ok += 1

            # Commit every 50 files
            if (i + 1) % 50 == 0:
                conn.commit()

        conn.commit()
        logger.info(
            "Phase 3 complete: %d extracted, %d errors", extracted_ok, extracted_err
        )
    else:
        logger.info("Phase 3: Skipping extraction (no --extraction-url provided)")

    _generate_report(conn, staging_dir)
    conn.close()


# ---------------------------------------------------------------------------
# Report generation
# ---------------------------------------------------------------------------

def _generate_report(conn: sqlite3.Connection, staging_dir: Path) -> None:
    """Print a summary report of the inventory."""
    print("\n" + "=" * 70)
    print("FILE INVENTORY REPORT")
    print("=" * 70)
    print(f"Staging directory: {staging_dir}")
    print(f"Generated: {datetime.now(timezone.utc).isoformat()}")

    # Total files and size
    cursor = conn.execute("SELECT COUNT(*), COALESCE(SUM(size), 0) FROM files")
    total_files, total_size = cursor.fetchone()
    print(f"\nTotal files: {total_files:,}")
    print(f"Total size:  {total_size / (1024 * 1024):.1f} MB ({total_size / (1024 * 1024 * 1024):.2f} GB)")

    # By extension
    print("\n--- Files by Extension ---")
    cursor = conn.execute("""
        SELECT extension, COUNT(*) as cnt, SUM(size) as total_size
        FROM files
        GROUP BY extension
        ORDER BY cnt DESC
        LIMIT 30
    """)
    print(f"{'Extension':<12} {'Count':>8} {'Size (MB)':>12}")
    print("-" * 34)
    for ext, count, ext_size in cursor:
        print(f"{ext or '(none)':<12} {count:>8,} {ext_size / (1024 * 1024):>12.1f}")

    # By MIME type
    print("\n--- Files by MIME Type ---")
    cursor = conn.execute("""
        SELECT mime_type, COUNT(*) as cnt
        FROM files
        GROUP BY mime_type
        ORDER BY cnt DESC
        LIMIT 20
    """)
    print(f"{'MIME Type':<50} {'Count':>8}")
    print("-" * 60)
    for mime, count in cursor:
        print(f"{mime:<50} {count:>8,}")

    # SHA-256 status
    cursor = conn.execute("SELECT COUNT(*) FROM files WHERE sha256_full IS NOT NULL")
    sha256_count = cursor.fetchone()[0]
    print(f"\nSHA-256 computed: {sha256_count:,} / {total_files:,}")

    # Extraction status
    cursor = conn.execute("SELECT COUNT(*) FROM files WHERE extracted_text IS NOT NULL")
    extracted_ok = cursor.fetchone()[0]
    cursor = conn.execute("SELECT COUNT(*) FROM files WHERE extraction_error IS NOT NULL")
    extracted_err = cursor.fetchone()[0]
    cursor = conn.execute(
        "SELECT COUNT(*) FROM files WHERE extension IN (" +
        ",".join(f"'{e}'" for e in EXTRACTABLE_EXTENSIONS) + ")"
    )
    extractable_total = cursor.fetchone()[0]

    print(f"\n--- Extraction Status ---")
    print(f"Extractable files: {extractable_total:,}")
    print(f"Successfully extracted: {extracted_ok:,}")
    print(f"Extraction errors: {extracted_err:,}")
    if extractable_total > 0:
        rate = extracted_ok / extractable_total * 100
        print(f"Extraction success rate: {rate:.1f}%")

    # Potential duplicate groups
    cursor = conn.execute("""
        SELECT COUNT(*) FROM (
            SELECT size, xxhash_partial
            FROM files
            GROUP BY size, xxhash_partial
            HAVING COUNT(*) > 1
        )
    """)
    dup_groups = cursor.fetchone()[0]
    print(f"\nPotential duplicate groups (size+xxhash match): {dup_groups:,}")

    print("\n" + "=" * 70)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Build SQLite inventory of files in staging directory",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Basic inventory (no content extraction)
  python scripts/file-inventory.py --staging-dir /mnt/user/openbrain/staging

  # With content extraction via the file-ingestion service
  python scripts/file-inventory.py \\
      --staging-dir /mnt/user/openbrain/staging \\
      --extraction-url http://localhost:8080

  # Custom database path
  python scripts/file-inventory.py \\
      --staging-dir ./test-data \\
      --db ./test-inventory.db
        """,
    )
    parser.add_argument(
        "--staging-dir",
        required=True,
        help="Path to the staging directory to inventory",
    )
    parser.add_argument(
        "--db",
        default="/mnt/user/openbrain/inventory.db",
        help="Path to SQLite database (default: /mnt/user/openbrain/inventory.db)",
    )
    parser.add_argument(
        "--extraction-url",
        default=None,
        help="URL of the Python extraction service (e.g., http://localhost:8080)",
    )
    args = parser.parse_args()

    staging_dir = Path(args.staging_dir)
    if not staging_dir.is_dir():
        logger.error("Staging directory does not exist: %s", staging_dir)
        sys.exit(1)

    build_inventory(staging_dir, args.db, args.extraction_url)
    logger.info("Inventory complete. Database: %s", args.db)


if __name__ == "__main__":
    main()
