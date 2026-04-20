"""
File Inventory Scanner â€” Phase A of OneDrive corpus analysis.

Walks the entire file tree, collects metadata + SHA-256 hashes,
stores in SQLite, and generates a summary report.

Non-destructive: reads only, never modifies files.

Usage:
    python file-inventory.py /path/to/files [--db inventory.db] [--skip-hash] [--resume]
"""

from __future__ import annotations

import argparse
import hashlib
import mimetypes
import os
import re
import sqlite3
import sys
import time
from datetime import UTC, datetime
from pathlib import Path

sys.stdout.reconfigure(line_buffering=True)  # type: ignore[attr-defined]
sys.stderr.reconfigure(line_buffering=True)  # type: ignore[attr-defined]

# Files/dirs to skip entirely
SKIP_NAMES = {
    ".git",
    ".svn",
    "__pycache__",
    "node_modules",
    ".Trash",
    "$RECYCLE.BIN",
    "System Volume Information",
}

# Known junk file patterns
JUNK_PATTERNS = [
    r"^thumbs\.db$",
    r"^desktop\.ini$",
    r"^\.DS_Store$",
    r"^~\$",  # Office temp files
    r"\.tmp$",
    r"^\.~lock\.",  # LibreOffice locks
    r"\.crdownload$",  # Incomplete Chrome downloads
    r"\.partial$",
]
JUNK_RE = [re.compile(p, re.IGNORECASE) for p in JUNK_PATTERNS]

# OneDrive conflict pattern
CONFLICT_RE = re.compile(r"\(.*(?:conflicted|conflict).*copy.*\)", re.IGNORECASE)

# Version chain pattern
VERSION_RE = re.compile(
    r"[_ -]v?\d+[\._]|[_ -](?:final|draft|revised|updated|copy|old|new|backup)",
    re.IGNORECASE,
)

DB_SCHEMA = """
CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT UNIQUE NOT NULL,
    filename TEXT NOT NULL,
    extension TEXT,
    size_bytes INTEGER NOT NULL,
    created_at TEXT,
    modified_at TEXT,
    mime_type TEXT,
    sha256 TEXT,
    is_junk BOOLEAN DEFAULT 0,
    is_conflict_copy BOOLEAN DEFAULT 0,
    is_version_chain BOOLEAN DEFAULT 0,
    is_zero_byte BOOLEAN DEFAULT 0,
    parent_dir TEXT,
    depth INTEGER,
    scanned_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scan_metadata (
    key TEXT PRIMARY KEY,
    value TEXT
);

CREATE INDEX IF NOT EXISTS idx_files_sha256 ON files(sha256);
CREATE INDEX IF NOT EXISTS idx_files_extension ON files(extension);
CREATE INDEX IF NOT EXISTS idx_files_size ON files(size_bytes);
CREATE INDEX IF NOT EXISTS idx_files_parent ON files(parent_dir);
CREATE INDEX IF NOT EXISTS idx_files_junk ON files(is_junk);
"""


def init_db(db_path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.executescript(DB_SCHEMA)
    conn.commit()
    return conn


def file_is_scanned(conn: sqlite3.Connection, path: str) -> bool:
    row = conn.execute("SELECT 1 FROM files WHERE path = ?", (path,)).fetchone()
    return row is not None


def hash_file(filepath: str, chunk_size: int = 65536) -> str | None:
    h = hashlib.sha256()
    try:
        with open(filepath, "rb") as f:
            while True:
                chunk = f.read(chunk_size)
                if not chunk:
                    break
                h.update(chunk)
        return h.hexdigest()
    except (PermissionError, OSError):
        return None


def classify_filename(filename: str) -> tuple[bool, bool, bool]:
    is_junk = any(p.search(filename) for p in JUNK_RE)
    is_conflict = bool(CONFLICT_RE.search(filename))
    is_version = bool(VERSION_RE.search(filename))
    return is_junk, is_conflict, is_version


def get_file_times(filepath: str) -> tuple[str | None, str | None]:
    try:
        stat = os.stat(filepath)
        created = datetime.fromtimestamp(stat.st_ctime, tz=UTC).isoformat()
        modified = datetime.fromtimestamp(stat.st_mtime, tz=UTC).isoformat()
        return created, modified
    except (PermissionError, OSError):
        return None, None


def scan_directory(
    root_path: str,
    conn: sqlite3.Connection,
    skip_hash: bool = False,
    max_hash_size: int = 500 * 1024 * 1024,
) -> tuple[int, int, int]:
    root = Path(root_path).resolve()
    scan_start = datetime.now(UTC).isoformat()

    conn.execute(
        "INSERT OR REPLACE INTO scan_metadata (key, value) VALUES (?, ?)",
        ("scan_start", scan_start),
    )
    conn.execute(
        "INSERT OR REPLACE INTO scan_metadata (key, value) VALUES (?, ?)",
        ("root_path", str(root)),
    )
    conn.commit()

    file_count = 0
    hash_count = 0
    skip_count = 0
    error_count = 0
    total_size = 0
    batch = []
    batch_size = 500
    start_time = time.time()

    max_hash_mb = max_hash_size / 1024 / 1024
    print(f"Scanning: {root}", flush=True)
    print(
        f"Hash: {'enabled (files < ' + str(int(max_hash_mb)) + 'MB)' if not skip_hash else 'disabled'}",
        flush=True,
    )
    print(flush=True)

    for dirpath, dirnames, filenames in os.walk(root):
        # Skip known junk directories
        dirnames[:] = [d for d in dirnames if d not in SKIP_NAMES]

        rel_dir = os.path.relpath(dirpath, root)
        depth = rel_dir.count(os.sep) + 1 if rel_dir != "." else 0

        for filename in filenames:
            filepath = os.path.join(dirpath, filename)

            # Resume support: skip if already scanned
            rel_path = os.path.relpath(filepath, root)
            if file_is_scanned(conn, rel_path):
                skip_count += 1
                if skip_count % 10000 == 0:
                    print(f"  Skipped {skip_count} already-scanned files...", flush=True)
                continue

            try:
                stat = os.stat(filepath)
                size = stat.st_size
            except (PermissionError, OSError):
                error_count += 1
                continue

            ext = os.path.splitext(filename)[1].lower() if "." in filename else ""
            mime = mimetypes.guess_type(filename)[0] or ""
            created, modified = get_file_times(filepath)
            is_junk, is_conflict, is_version = classify_filename(filename)
            is_zero = size == 0

            # Hash if enabled and file is under size limit
            sha = None
            if not skip_hash and size <= max_hash_size and size > 0:
                sha = hash_file(filepath)
                if sha:
                    hash_count += 1

            batch.append(
                (
                    rel_path,
                    filename,
                    ext,
                    size,
                    created,
                    modified,
                    mime,
                    sha,
                    is_junk,
                    is_conflict,
                    is_version,
                    is_zero,
                    rel_dir,
                    depth,
                    scan_start,
                )
            )

            file_count += 1
            total_size += size

            # Batch insert
            if len(batch) >= batch_size:
                conn.executemany(
                    """INSERT OR IGNORE INTO files
                    (path, filename, extension, size_bytes, created_at, modified_at,
                     mime_type, sha256, is_junk, is_conflict_copy, is_version_chain,
                     is_zero_byte, parent_dir, depth, scanned_at)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    batch,
                )
                conn.commit()
                batch.clear()

            # Progress every 10K files
            if file_count % 10000 == 0:
                elapsed = time.time() - start_time
                rate = file_count / elapsed if elapsed > 0 else 0
                print(
                    f"  {file_count:,} files scanned | {hash_count:,} hashed | "
                    f"{total_size/1024/1024/1024:.1f} GB | "
                    f"{rate:.0f} files/sec | {error_count} errors",
                    flush=True,
                )

    # Flush remaining batch
    if batch:
        conn.executemany(
            """INSERT OR IGNORE INTO files
            (path, filename, extension, size_bytes, created_at, modified_at,
             mime_type, sha256, is_junk, is_conflict_copy, is_version_chain,
             is_zero_byte, parent_dir, depth, scanned_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            batch,
        )
        conn.commit()

    elapsed = time.time() - start_time
    conn.execute(
        "INSERT OR REPLACE INTO scan_metadata (key, value) VALUES (?, ?)",
        ("scan_end", datetime.now(UTC).isoformat()),
    )
    conn.execute(
        "INSERT OR REPLACE INTO scan_metadata (key, value) VALUES (?, ?)",
        ("scan_duration_seconds", str(int(elapsed))),
    )
    conn.execute(
        "INSERT OR REPLACE INTO scan_metadata (key, value) VALUES (?, ?)",
        ("total_files", str(file_count)),
    )
    conn.execute(
        "INSERT OR REPLACE INTO scan_metadata (key, value) VALUES (?, ?)",
        ("total_size_bytes", str(total_size)),
    )
    conn.commit()

    print(f"\n{'='*60}", flush=True)
    print("  SCAN COMPLETE", flush=True)
    print(f"  Files scanned: {file_count:,}", flush=True)
    print(f"  Files hashed: {hash_count:,}", flush=True)
    print(f"  Skipped (already scanned): {skip_count:,}", flush=True)
    print(f"  Errors: {error_count:,}", flush=True)
    print(f"  Total size: {total_size/1024/1024/1024:.2f} GB", flush=True)
    print(f"  Duration: {elapsed:.0f}s ({elapsed/60:.1f} min)", flush=True)
    print(f"{'='*60}", flush=True)

    return file_count, hash_count, total_size


def generate_report(conn):
    print(f"\n{'='*60}", flush=True)
    print("  FILE INVENTORY REPORT", flush=True)
    print(f"{'='*60}\n", flush=True)

    row = conn.execute("SELECT COUNT(*), SUM(size_bytes) FROM files").fetchone()
    total_files, total_bytes = row[0], row[1] or 0
    print(f"Total files: {total_files:,}", flush=True)
    print(f"Total size: {total_bytes/1024/1024/1024:.2f} GB\n", flush=True)

    # File type distribution
    print("--- FILE TYPES (top 30) ---", flush=True)
    rows = conn.execute(
        """SELECT extension, COUNT(*) as cnt, SUM(size_bytes) as total_size
           FROM files GROUP BY extension ORDER BY cnt DESC LIMIT 30"""
    ).fetchall()
    print(f"{'Extension':<12} {'Count':>10} {'Size':>12}", flush=True)
    print("-" * 36, flush=True)
    for ext, cnt, sz in rows:
        ext_display = ext if ext else "(none)"
        print(f"{ext_display:<12} {cnt:>10,} {(sz or 0)/1024/1024:>10.1f} MB", flush=True)

    # Duplicate analysis
    print("\n--- EXACT DUPLICATES (by SHA-256) ---", flush=True)
    row = conn.execute(
        """SELECT COUNT(*) FROM (
            SELECT sha256 FROM files WHERE sha256 IS NOT NULL
            GROUP BY sha256 HAVING COUNT(*) > 1
        )"""
    ).fetchone()
    dup_groups = row[0]

    row = conn.execute(
        """SELECT COUNT(*), SUM(size_bytes) FROM files WHERE sha256 IN (
            SELECT sha256 FROM files WHERE sha256 IS NOT NULL
            GROUP BY sha256 HAVING COUNT(*) > 1
        )"""
    ).fetchone()
    dup_files, dup_bytes = row[0], row[1] or 0

    row = conn.execute(
        """SELECT SUM(keep_size) FROM (
            SELECT MIN(size_bytes) as keep_size FROM files
            WHERE sha256 IN (
                SELECT sha256 FROM files WHERE sha256 IS NOT NULL
                GROUP BY sha256 HAVING COUNT(*) > 1
            )
            GROUP BY sha256
        )"""
    ).fetchone()
    keep_bytes = row[0] or 0
    recoverable = dup_bytes - keep_bytes

    print(f"Duplicate groups: {dup_groups:,}", flush=True)
    print(f"Total duplicate files: {dup_files:,}", flush=True)
    print(f"Space used by duplicates: {dup_bytes/1024/1024/1024:.2f} GB", flush=True)
    print(f"Recoverable space: {recoverable/1024/1024/1024:.2f} GB", flush=True)

    print("\nTop 10 most-duplicated files:", flush=True)
    rows = conn.execute(
        """SELECT sha256, COUNT(*) as cnt, MIN(size_bytes) as sz, MIN(filename) as sample
           FROM files WHERE sha256 IS NOT NULL
           GROUP BY sha256 HAVING COUNT(*) > 1
           ORDER BY cnt DESC LIMIT 10"""
    ).fetchall()
    for _sha, cnt, sz, sample in rows:
        print(f"  {cnt}x copies | {sz/1024:.0f} KB | {sample}", flush=True)

    # Junk files
    print("\n--- JUNK / CLEANUP CANDIDATES ---", flush=True)
    row = conn.execute("SELECT COUNT(*), SUM(size_bytes) FROM files WHERE is_junk = 1").fetchone()
    print(
        f"Junk files (temp, system, cache): {row[0]:,} ({(row[1] or 0)/1024/1024:.1f} MB)",
        flush=True,
    )

    row = conn.execute(
        "SELECT COUNT(*), SUM(size_bytes) FROM files WHERE is_zero_byte = 1"
    ).fetchone()
    print(f"Zero-byte files: {row[0]:,}", flush=True)

    row = conn.execute(
        "SELECT COUNT(*), SUM(size_bytes) FROM files WHERE is_conflict_copy = 1"
    ).fetchone()
    print(f"OneDrive conflict copies: {row[0]:,} ({(row[1] or 0)/1024/1024:.1f} MB)", flush=True)

    row = conn.execute(
        "SELECT COUNT(*), SUM(size_bytes) FROM files WHERE is_version_chain = 1"
    ).fetchone()
    print(f"Possible version chains: {row[0]:,} ({(row[1] or 0)/1024/1024:.1f} MB)", flush=True)

    # Date distribution
    print("\n--- DATE DISTRIBUTION (by modified year) ---", flush=True)
    rows = conn.execute(
        """SELECT SUBSTR(modified_at, 1, 4) as year, COUNT(*) as cnt
           FROM files WHERE modified_at IS NOT NULL
           GROUP BY year ORDER BY year"""
    ).fetchall()
    for year, cnt in rows:
        bar = "#" * min(80, cnt // 500)
        print(f"  {year}: {cnt:>8,} {bar}", flush=True)

    # Top-level directory breakdown
    print("\n--- TOP-LEVEL DIRECTORIES ---", flush=True)
    rows = conn.execute(
        """SELECT
            CASE WHEN INSTR(path, '/') > 0 THEN SUBSTR(path, 1, INSTR(path, '/') - 1)
                 WHEN INSTR(path, '\\') > 0 THEN SUBSTR(path, 1, INSTR(path, '\\') - 1)
                 ELSE '(root files)'
            END as top_dir,
            COUNT(*) as cnt,
            SUM(size_bytes) as sz
           FROM files GROUP BY top_dir ORDER BY cnt DESC LIMIT 30"""
    ).fetchall()
    print(f"{'Directory':<35} {'Files':>10} {'Size':>12}", flush=True)
    print("-" * 60, flush=True)
    for d, cnt, sz in rows:
        print(f"{d:<35} {cnt:>10,} {(sz or 0)/1024/1024:>10.1f} MB", flush=True)

    # Cleanup potential summary
    print(f"\n{'='*60}", flush=True)
    print("  CLEANUP POTENTIAL SUMMARY", flush=True)
    print(f"{'='*60}", flush=True)

    junk = conn.execute("SELECT COUNT(*) FROM files WHERE is_junk = 1").fetchone()[0]
    zeros = conn.execute("SELECT COUNT(*) FROM files WHERE is_zero_byte = 1").fetchone()[0]
    conflicts = conn.execute("SELECT COUNT(*) FROM files WHERE is_conflict_copy = 1").fetchone()[0]
    dup_surplus = conn.execute(
        """SELECT COALESCE(SUM(surplus), 0) FROM (
            SELECT COUNT(*) - 1 as surplus FROM files
            WHERE sha256 IS NOT NULL GROUP BY sha256 HAVING COUNT(*) > 1
        )"""
    ).fetchone()[0]

    removable = junk + zeros + conflicts + dup_surplus
    pct = removable / total_files * 100 if total_files > 0 else 0
    print(f"  Junk files:          {junk:>10,}", flush=True)
    print(f"  Zero-byte files:     {zeros:>10,}", flush=True)
    print(f"  Conflict copies:     {conflicts:>10,}", flush=True)
    print(f"  Duplicate surplus:   {dup_surplus:>10,}", flush=True)
    print("  ----------------------------", flush=True)
    print(f"  Total removable:     {removable:>10,} ({pct:.1f}%)", flush=True)
    print(f"  Remaining after:     {total_files - removable:>10,}", flush=True)
    print(f"  Recoverable space:   {recoverable/1024/1024/1024:>9.2f} GB", flush=True)
    print(f"{'='*60}\n", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="File inventory scanner")
    parser.add_argument("path", help="Root directory to scan")
    parser.add_argument(
        "--db",
        default="file-inventory.db",
        help="SQLite database path (default: file-inventory.db)",
    )
    parser.add_argument(
        "--skip-hash", action="store_true", help="Skip SHA-256 hashing (metadata only, much faster)"
    )
    parser.add_argument(
        "--max-hash-mb", type=int, default=500, help="Max file size to hash in MB (default: 500)"
    )
    parser.add_argument(
        "--report-only",
        action="store_true",
        help="Generate report from existing DB without scanning",
    )
    parser.add_argument(
        "--resume", action="store_true", help="Resume interrupted scan (skip already-scanned files)"
    )
    args = parser.parse_args()

    root = Path(args.path).resolve()
    if not root.is_dir():
        print(f"ERROR: {root} is not a directory", flush=True)
        sys.exit(1)

    conn = init_db(args.db)

    if args.report_only:
        generate_report(conn)
    else:
        if not args.resume:
            print("Starting fresh scan (use --resume to continue interrupted scan)", flush=True)
            conn.execute("DELETE FROM files")
            conn.commit()

        scan_directory(
            str(root), conn, skip_hash=args.skip_hash, max_hash_size=args.max_hash_mb * 1024 * 1024
        )
        generate_report(conn)

    conn.close()


if __name__ == "__main__":
    main()
