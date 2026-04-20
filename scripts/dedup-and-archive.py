"""
Dedup & Version Archive -- Phase B of OneDrive corpus cleanup.

Reads the hashed file inventory SQLite DB and:
1. Finds exact duplicates (same SHA-256) -- archives all but the best copy
2. Finds version chains (v1/v2/final/draft) -- archives all but newest
3. Moves archived files to _archive/versions/ preserving folder structure
4. Generates a manifest CSV of all moves

Non-destructive: moves files to archive, never permanently deletes.

Usage:
    python dedup-and-archive.py --db /path/to/file-inventory-hash.db --root /path/to/onedrive
    python dedup-and-archive.py --db inventory.db --root /data --dry-run
    python dedup-and-archive.py --db inventory.db --root /data --report-only
"""

from __future__ import annotations

import argparse
import csv
import os
import re
import shutil
import sqlite3
import sys
from collections import defaultdict
from datetime import UTC, datetime
from pathlib import Path

sys.stdout.reconfigure(line_buffering=True)  # type: ignore[attr-defined]

# Patterns to strip when computing base name for version grouping
VERSION_PATTERNS = [
    r"\s*[-_]?\s*v(\d+)\s*$",  # v1, v2, -v3
    r"\s*[-_]?\s*version\s*(\d+)\s*$",  # version 1
    r"\s*[-_]?\s*rev\.?\s*(\d+)\s*$",  # rev1, rev 2
    r"\s*\((\d+)\)\s*$",  # (1), (2) -- copy numbering
    r"\s*[-_]?\s*copy\s*(\d*)?\s*$",  # copy, copy 2
    r"\s*[-_]?\s*final\s*$",  # final
    r"\s*[-_]?\s*final\s*(\d+)\s*$",  # final2
    r"\s*[-_]?\s*draft\s*(\d*)?\s*$",  # draft, draft 2
    r"\s*[-_]?\s*revised\s*(\d*)?\s*$",  # revised
    r"\s*[-_]?\s*updated\s*(\d*)?\s*$",  # updated
    r"\s*[-_]?\s*old\s*$",  # old
    r"\s*[-_]?\s*new\s*$",  # new
    r"\s*[-_]?\s*backup\s*$",  # backup
    r"\s*[-_]?\s*\d{4}[-_]\d{2}[-_]\d{2}\s*$",  # date suffix 2024-01-15
]
VERSION_RE = [re.compile(p, re.IGNORECASE) for p in VERSION_PATTERNS]

# Type alias for a file row from the DB
FileRow = tuple[str, str, int, str | None, str | None]


def compute_base_name(filename: str) -> str:
    """Strip version/copy suffixes to get the base name for grouping."""
    name, ext = os.path.splitext(filename)
    original = name
    for pattern in VERSION_RE:
        name = pattern.sub("", name)
    # Also handle "Copy of X" prefix
    name = re.sub(r"^Copy\s+of\s+", "", name, flags=re.IGNORECASE)
    name = name.strip(" -_")
    if not name:
        name = original
    return name + ext


def score_file(row: FileRow) -> float:
    """Score a file for best copy selection. Higher = better to keep."""
    path, filename, size, modified, sha256 = row
    score: float = 0
    # Prefer files with content (larger)
    score += min(size / 1024, 1000)  # up to 1000 points for size
    # Prefer newer files
    if modified:
        try:
            dt = datetime.fromisoformat(modified.replace("Z", "+00:00"))
            days_old = (datetime.now(UTC) - dt).days
            score += max(0, 3650 - days_old)  # up to 3650 points (10 years)
        except Exception:
            pass
    # Prefer files with "final" in name
    lower = filename.lower()
    if "final" in lower:
        score += 5000
    if "draft" in lower or "old" in lower:
        score -= 2000
    if "(1)" in lower or "(2)" in lower or "copy" in lower:
        score -= 1000
    # Prefer shorter paths (less nested = more intentional location)
    score -= path.count("/") * 10
    score -= path.count("\\") * 10
    return score


def find_exact_duplicates(conn: sqlite3.Connection) -> list[list[FileRow]]:
    """Find groups of files with identical SHA-256 hashes."""
    rows: list[tuple[str, int]] = conn.execute("""
        SELECT sha256, COUNT(*) as cnt
        FROM files
        WHERE sha256 IS NOT NULL AND sha256 != ''
        GROUP BY sha256
        HAVING COUNT(*) > 1
        ORDER BY cnt DESC
    """).fetchall()

    groups: list[list[FileRow]] = []
    for sha256, _cnt in rows:
        files: list[FileRow] = conn.execute(
            """
            SELECT path, filename, size_bytes, modified_at, sha256
            FROM files
            WHERE sha256 = ?
            ORDER BY modified_at DESC
        """,
            (sha256,),
        ).fetchall()
        groups.append(files)
    return groups


def find_version_chains(conn: sqlite3.Connection) -> dict[tuple[str, str], list[FileRow]]:
    """Find groups of files that are versions of each other."""
    rows: list[tuple[str, str, int, str | None, str | None, str, str]] = conn.execute("""
        SELECT path, filename, size_bytes, modified_at, sha256, parent_dir, extension
        FROM files
        WHERE size_bytes > 0
        ORDER BY parent_dir, filename
    """).fetchall()

    # Group by directory + base name + extension
    chains: dict[tuple[str, str], list[FileRow]] = defaultdict(list)
    for path, filename, size, modified, sha256, parent, _ext in rows:
        base = compute_base_name(filename)
        key: tuple[str, str] = (parent, base.lower())
        chains[key].append((path, filename, size, modified, sha256))

    # Filter to only groups with 2+ files (actual version chains)
    return {k: v for k, v in chains.items() if len(v) > 1}


def main() -> None:
    parser = argparse.ArgumentParser(description="Dedup and version archive")
    parser.add_argument("--db", required=True, help="Path to file inventory SQLite DB")
    parser.add_argument("--root", required=True, help="Root directory of the file corpus")
    parser.add_argument(
        "--archive-dir",
        default="_archive/versions",
        help="Archive subdirectory name (default: _archive/versions)",
    )
    parser.add_argument("--dry-run", action="store_true", help="Report only, do not move files")
    parser.add_argument("--report-only", action="store_true", help="Just print the report")
    parser.add_argument("--manifest", default="archive-manifest.csv", help="Manifest CSV path")
    args = parser.parse_args()

    conn = sqlite3.connect(args.db)
    root = Path(args.root).resolve()
    archive_base = root / args.archive_dir

    # Check DB has hashes
    hashed: int = conn.execute(
        "SELECT COUNT(*) FROM files WHERE sha256 IS NOT NULL AND sha256 != ''"
    ).fetchone()[0]
    total: int = conn.execute("SELECT COUNT(*) FROM files").fetchone()[0]
    print(f"Inventory: {total:,} files, {hashed:,} hashed ({hashed*100//total}%)\n", flush=True)

    if hashed == 0:
        print("ERROR: No hashes in database. Run inventory with hashing first.", flush=True)
        sys.exit(1)

    # === EXACT DUPLICATES ===
    print("=" * 60, flush=True)
    print("  EXACT DUPLICATES (same SHA-256)", flush=True)
    print("=" * 60, flush=True)

    dup_groups = find_exact_duplicates(conn)
    dup_archive_count = 0
    dup_archive_bytes = 0
    moves: list[tuple[str, str, str]] = []

    for group in dup_groups:
        scored: list[tuple[float, FileRow]] = [(score_file(f), f) for f in group]
        scored.sort(key=lambda x: x[0], reverse=True)
        keep = scored[0][1]
        archive = [f for _, f in scored[1:]]
        for path, filename, size, modified, _sha256 in archive:
            dup_archive_count += 1
            dup_archive_bytes += size
            moves.append(("duplicate", path, keep[0]))

    print(f"  Duplicate groups: {len(dup_groups):,}", flush=True)
    print(f"  Files to archive: {dup_archive_count:,}", flush=True)
    print(f"  Space recoverable: {dup_archive_bytes/1024/1024/1024:.2f} GB", flush=True)

    if dup_groups:
        print("\n  Top 10 duplicate groups:", flush=True)
        for group in dup_groups[:10]:
            print(f"    {len(group)}x -- {group[0][1]} ({group[0][2]/1024:.0f} KB)", flush=True)
            for path, filename, size, modified, _sha256 in group:
                print(f"      {path}", flush=True)

    # === VERSION CHAINS ===
    print(f"\n{chr(61)*60}", flush=True)
    print("  VERSION CHAINS (same base name, different versions)", flush=True)
    print("=" * 60, flush=True)

    chains = find_version_chains(conn)
    chain_archive_count = 0
    chain_archive_bytes = 0

    dup_hashes: set[str | None] = {group[0][4] for group in dup_groups}
    filtered_chains: dict[tuple[str, str], list[FileRow]] = {}
    for key, files in chains.items():
        hashes: set[str | None] = {f[4] for f in files if f[4]}
        if len(hashes) <= 1 and hashes and hashes.pop() in dup_hashes:
            continue
        filtered_chains[key] = files

    for key, files in filtered_chains.items():
        scored = [(score_file(f), f) for f in files]
        scored.sort(key=lambda x: x[0], reverse=True)
        keep = scored[0][1]
        archive = [f for _, f in scored[1:]]
        for path, filename, size, modified, _sha256 in archive:
            chain_archive_count += 1
            chain_archive_bytes += size
            moves.append(("version", path, keep[0]))

    print(f"  Version chain groups: {len(filtered_chains):,}", flush=True)
    print(f"  Files to archive: {chain_archive_count:,}", flush=True)
    print(f"  Space recoverable: {chain_archive_bytes/1024/1024/1024:.2f} GB", flush=True)

    if filtered_chains:
        print("\n  Top 20 version chains:", flush=True)
        sorted_chains = sorted(filtered_chains.items(), key=lambda x: len(x[1]), reverse=True)
        for (parent, base), files in sorted_chains[:20]:
            print(f"    {len(files)} versions -- {base} (in {parent})", flush=True)
            scored = [(score_file(f), f) for f in files]
            scored.sort(key=lambda x: x[0], reverse=True)
            for i, (_score, (path, filename, size, modified, _sha256)) in enumerate(scored):
                tag = "KEEP" if i == 0 else "archive"
                mod = modified[:10] if modified else "?"
                print(f"      [{tag:7s}] {mod} {filename} ({size/1024:.0f} KB)", flush=True)

    total_archive = dup_archive_count + chain_archive_count
    total_bytes = dup_archive_bytes + chain_archive_bytes
    print(f"\n{chr(61)*60}", flush=True)
    print("  ARCHIVE SUMMARY", flush=True)
    print(f"{chr(61)*60}", flush=True)
    print(f"  Exact duplicates to archive: {dup_archive_count:,}", flush=True)
    print(f"  Version chains to archive:   {chain_archive_count:,}", flush=True)
    print(f"  Total to archive:            {total_archive:,}", flush=True)
    print(f"  Space recoverable:           {total_bytes/1024/1024/1024:.2f} GB", flush=True)
    print(f"  Files remaining:             {total - total_archive:,}", flush=True)

    if args.report_only:
        print("\n  REPORT ONLY -- no files moved.", flush=True)
        conn.close()
        return

    if args.dry_run:
        print("\n  DRY RUN -- no files moved.", flush=True)
        print(f"  Would archive {total_archive:,} files to {archive_base}", flush=True)
        conn.close()
        return

    print(f"\n  Moving {total_archive:,} files to {archive_base}...", flush=True)
    moved = 0
    errors = 0

    manifest_path = os.path.join(str(root), args.manifest)
    with open(manifest_path, "w", newline="", encoding="utf-8") as mf:
        writer = csv.writer(mf)
        writer.writerow(["reason", "original_path", "archive_path", "kept_instead"])
        for reason, rel_path, kept_path in moves:
            src = root / rel_path
            dst = archive_base / rel_path
            if not src.exists():
                continue
            try:
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(src), str(dst))
                writer.writerow([reason, rel_path, str(dst.relative_to(root)), kept_path])
                moved += 1
                if moved % 500 == 0:
                    print(f"    {moved:,}/{total_archive:,} moved...", flush=True)
            except Exception as e:
                errors += 1
                if errors <= 10:
                    print(f"    Error: {rel_path}: {e}", flush=True)

    print(f"\n  Moved: {moved:,}", flush=True)
    print(f"  Errors: {errors:,}", flush=True)
    print(f"  Manifest: {manifest_path}", flush=True)
    print(f"{chr(61)*60}\n", flush=True)
    conn.close()


if __name__ == "__main__":
    main()
