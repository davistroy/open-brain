#!/usr/bin/env python3
"""
Open Brain File Deduplication — Detect exact and near-duplicate files.

Reads from the inventory SQLite database (created by file-inventory.py).
Exact duplicates: GROUP BY (size, sha256_full), auto-resolve by keeping newest.
Near-duplicates: difflib.SequenceMatcher on extracted text, flag pairs > 0.9 similarity.
Generates an HTML report with side-by-side comparisons for review.

Usage:
    python scripts/file-dedup.py --db /mnt/user/openbrain/inventory.db
    python scripts/file-dedup.py --db ./inventory.db --threshold 0.85
    python scripts/file-dedup.py --db ./inventory.db --report ./dedup-report.html --dry-run

Requires: inventory SQLite database from file-inventory.py
"""

import argparse
import difflib
import html
import logging
import sqlite3
import sys
from datetime import UTC, datetime
from pathlib import Path

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("file-dedup")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
DEFAULT_NEAR_DUP_THRESHOLD = 0.9
MAX_TEXT_COMPARE_CHARS = 50_000  # Limit text comparison to 50K chars for memory


# ---------------------------------------------------------------------------
# Exact duplicate detection
# ---------------------------------------------------------------------------


def detect_exact_duplicates(conn: sqlite3.Connection, dry_run: bool) -> dict:
    """Detect exact duplicates via (size, sha256_full) grouping.

    Auto-resolves by keeping the newest file (by modified_date).
    Returns stats dict.
    """
    stats = {
        "groups": 0,
        "total_duplicates": 0,
        "space_saved_bytes": 0,
        "kept": [],
        "removed": [],
    }

    cursor = conn.execute("""
        SELECT size, sha256_full, COUNT(*) as cnt
        FROM files
        WHERE sha256_full IS NOT NULL AND is_duplicate = 0
        GROUP BY size, sha256_full
        HAVING cnt > 1
        ORDER BY size DESC
    """)
    groups = cursor.fetchall()
    logger.info("Found %d exact duplicate groups (by SHA-256)", len(groups))

    for size, sha256, _count in groups:
        # Get all files in this group, ordered by modified_date DESC (newest first)
        cursor2 = conn.execute(
            """
            SELECT id, path, filename, modified_date, size
            FROM files
            WHERE size = ? AND sha256_full = ? AND is_duplicate = 0
            ORDER BY modified_date DESC
        """,
            (size, sha256),
        )
        members = cursor2.fetchall()

        if len(members) < 2:
            continue

        stats["groups"] += 1
        keeper = members[0]  # Newest file
        duplicates = members[1:]

        stats["kept"].append(
            {
                "id": keeper[0],
                "path": keeper[1],
                "filename": keeper[2],
                "modified_date": keeper[3],
                "size": keeper[4],
                "sha256": sha256,
                "duplicate_count": len(duplicates),
            }
        )

        for dup in duplicates:
            stats["total_duplicates"] += 1
            stats["space_saved_bytes"] += dup[4]
            stats["removed"].append(
                {
                    "id": dup[0],
                    "path": dup[1],
                    "filename": dup[2],
                    "modified_date": dup[3],
                    "size": dup[4],
                    "kept_path": keeper[1],
                }
            )

            if not dry_run:
                conn.execute(
                    """
                    UPDATE files SET is_duplicate = 1, duplicate_of = ? WHERE id = ?
                """,
                    (keeper[1], dup[0]),
                )

    if not dry_run:
        conn.commit()

    return stats


# ---------------------------------------------------------------------------
# Near-duplicate detection
# ---------------------------------------------------------------------------


def detect_near_duplicates(
    conn: sqlite3.Connection,
    threshold: float,
    dry_run: bool,
) -> dict:
    """Detect near-duplicates using text similarity.

    Compares extracted text of non-duplicate files with same extension.
    Groups by extension to reduce comparison space.
    Returns stats dict with flagged pairs.
    """
    stats = {
        "pairs_compared": 0,
        "near_duplicates_found": 0,
        "pairs": [],
    }

    # Get files with extracted text, grouped by extension
    cursor = conn.execute("""
        SELECT id, path, filename, extension, size, modified_date, extracted_text
        FROM files
        WHERE extracted_text IS NOT NULL
          AND is_duplicate = 0
          AND is_near_duplicate = 0
          AND LENGTH(extracted_text) > 100
        ORDER BY extension, size DESC
    """)
    all_files = cursor.fetchall()
    logger.info("Files with extracted text for near-dup comparison: %d", len(all_files))

    # Group by extension
    by_extension: dict[str, list] = {}
    for row in all_files:
        ext = row[3]
        by_extension.setdefault(ext, []).append(row)

    for ext, files in by_extension.items():
        if len(files) < 2:
            continue
        logger.info("Comparing %d %s files...", len(files), ext)

        # Compare pairs within each extension group
        # Limit to groups of <= 500 to avoid N^2 blowup
        if len(files) > 500:
            logger.warning(
                "Extension %s has %d files, limiting near-dup to first 500 by size",
                ext,
                len(files),
            )
            files = files[:500]

        for i in range(len(files)):
            for j in range(i + 1, len(files)):
                stats["pairs_compared"] += 1
                file_a = files[i]
                file_b = files[j]

                text_a = (file_a[6] or "")[:MAX_TEXT_COMPARE_CHARS]
                text_b = (file_b[6] or "")[:MAX_TEXT_COMPARE_CHARS]

                # Quick length ratio check to skip obviously dissimilar pairs
                len_a, len_b = len(text_a), len(text_b)
                if len_a == 0 or len_b == 0:
                    continue
                length_ratio = min(len_a, len_b) / max(len_a, len_b)
                if length_ratio < 0.5:
                    continue

                # SequenceMatcher with autojunk for speed
                ratio = difflib.SequenceMatcher(None, text_a, text_b).quick_ratio()

                # Only compute full ratio if quick_ratio passes threshold
                if ratio >= threshold:
                    ratio = difflib.SequenceMatcher(None, text_a, text_b).ratio()

                if ratio >= threshold:
                    stats["near_duplicates_found"] += 1
                    pair = {
                        "id_a": file_a[0],
                        "path_a": file_a[1],
                        "filename_a": file_a[2],
                        "size_a": file_a[4],
                        "modified_a": file_a[5],
                        "preview_a": text_a[:200],
                        "id_b": file_b[0],
                        "path_b": file_b[1],
                        "filename_b": file_b[2],
                        "size_b": file_b[4],
                        "modified_b": file_b[5],
                        "preview_b": text_b[:200],
                        "similarity": round(ratio, 4),
                    }
                    stats["pairs"].append(pair)

                    if not dry_run:
                        # Flag both files, record the pairing
                        conn.execute(
                            """
                            UPDATE files
                            SET is_near_duplicate = 1,
                                near_duplicate_of = ?,
                                near_duplicate_score = ?
                            WHERE id = ?
                        """,
                            (file_a[1], ratio, file_b[0]),
                        )

        if stats["pairs_compared"] % 10000 == 0 and stats["pairs_compared"] > 0:
            logger.info("  Compared %d pairs so far...", stats["pairs_compared"])

    if not dry_run:
        conn.commit()

    return stats


# ---------------------------------------------------------------------------
# HTML report generation
# ---------------------------------------------------------------------------


def generate_html_report(
    exact_stats: dict,
    near_stats: dict,
    report_path: str,
    threshold: float,
) -> None:
    """Generate an HTML report with side-by-side near-duplicate comparisons."""

    exact_groups = exact_stats["groups"]
    exact_dupes = exact_stats["total_duplicates"]
    space_saved_mb = exact_stats["space_saved_bytes"] / (1024 * 1024)
    near_pairs = near_stats["near_duplicates_found"]
    pairs_compared = near_stats["pairs_compared"]

    # Build exact duplicates table rows
    exact_rows = ""
    for item in exact_stats["removed"][:200]:  # Cap at 200 rows
        exact_rows += f"""
        <tr>
            <td class="path">{html.escape(item['filename'])}</td>
            <td>{item['size']:,}</td>
            <td>{html.escape(item['modified_date'][:10])}</td>
            <td class="path">{html.escape(item['kept_path'])}</td>
        </tr>"""

    # Build near-duplicate comparison cards
    near_cards = ""
    for pair in sorted(near_stats["pairs"], key=lambda p: -p["similarity"]):
        sim_pct = pair["similarity"] * 100
        badge_class = "high" if sim_pct >= 95 else "medium"
        near_cards += f"""
        <div class="pair-card">
            <div class="pair-header">
                <span class="similarity-badge {badge_class}">{sim_pct:.1f}% similar</span>
            </div>
            <div class="comparison">
                <div class="file-panel">
                    <h4>{html.escape(pair['filename_a'])}</h4>
                    <div class="meta">Size: {pair['size_a']:,} bytes | Modified: {html.escape(pair['modified_a'][:10])}</div>
                    <div class="meta path">{html.escape(pair['path_a'])}</div>
                    <pre class="preview">{html.escape(pair['preview_a'])}</pre>
                </div>
                <div class="file-panel">
                    <h4>{html.escape(pair['filename_b'])}</h4>
                    <div class="meta">Size: {pair['size_b']:,} bytes | Modified: {html.escape(pair['modified_b'][:10])}</div>
                    <div class="meta path">{html.escape(pair['path_b'])}</div>
                    <pre class="preview">{html.escape(pair['preview_b'])}</pre>
                </div>
            </div>
        </div>"""

    report_html = f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Open Brain File Deduplication Report</title>
    <style>
        body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 2rem; background: #f5f5f5; color: #333; }}
        h1 {{ color: #1a1a2e; border-bottom: 2px solid #16213e; padding-bottom: 0.5rem; }}
        h2 {{ color: #16213e; margin-top: 2rem; }}
        .summary {{ background: white; padding: 1.5rem; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); margin-bottom: 2rem; }}
        .summary .stat {{ display: inline-block; margin-right: 2rem; }}
        .summary .stat .number {{ font-size: 2rem; font-weight: 700; color: #0f3460; }}
        .summary .stat .label {{ font-size: 0.85rem; color: #666; }}
        table {{ width: 100%; border-collapse: collapse; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }}
        th {{ background: #16213e; color: white; padding: 0.75rem 1rem; text-align: left; font-weight: 600; }}
        td {{ padding: 0.5rem 1rem; border-bottom: 1px solid #eee; }}
        tr:hover {{ background: #f0f4ff; }}
        .path {{ font-family: 'Cascadia Code', monospace; font-size: 0.8rem; word-break: break-all; }}
        .pair-card {{ background: white; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); margin-bottom: 1.5rem; overflow: hidden; }}
        .pair-header {{ background: #1a1a2e; color: white; padding: 0.75rem 1rem; }}
        .similarity-badge {{ padding: 0.25rem 0.75rem; border-radius: 12px; font-weight: 600; font-size: 0.85rem; }}
        .similarity-badge.high {{ background: #e74c3c; }}
        .similarity-badge.medium {{ background: #f39c12; }}
        .comparison {{ display: grid; grid-template-columns: 1fr 1fr; gap: 1px; background: #ddd; }}
        .file-panel {{ padding: 1rem; background: white; }}
        .file-panel h4 {{ margin: 0 0 0.5rem 0; color: #0f3460; }}
        .meta {{ font-size: 0.8rem; color: #666; margin-bottom: 0.25rem; }}
        .preview {{ background: #f8f9fa; padding: 0.75rem; border-radius: 4px; font-size: 0.75rem; max-height: 150px; overflow-y: auto; white-space: pre-wrap; word-break: break-word; }}
        .footer {{ margin-top: 2rem; color: #999; font-size: 0.8rem; }}
    </style>
</head>
<body>
    <h1>File Deduplication Report</h1>
    <p>Generated: {datetime.now(UTC).strftime('%Y-%m-%d %H:%M UTC')}</p>

    <div class="summary">
        <div class="stat"><div class="number">{exact_groups}</div><div class="label">Exact Duplicate Groups</div></div>
        <div class="stat"><div class="number">{exact_dupes}</div><div class="label">Files Marked Duplicate</div></div>
        <div class="stat"><div class="number">{space_saved_mb:.1f} MB</div><div class="label">Space Recoverable</div></div>
        <div class="stat"><div class="number">{near_pairs}</div><div class="label">Near-Duplicate Pairs</div></div>
        <div class="stat"><div class="number">{pairs_compared:,}</div><div class="label">Pairs Compared</div></div>
    </div>

    <h2>Exact Duplicates (Auto-Resolved: Newest Kept)</h2>
    {"<p>No exact duplicates found.</p>" if exact_dupes == 0 else f'''
    <table>
        <thead>
            <tr><th>Duplicate File</th><th>Size (bytes)</th><th>Modified</th><th>Kept (Newest)</th></tr>
        </thead>
        <tbody>{exact_rows}</tbody>
    </table>
    {"<p><em>Showing first 200 of " + str(exact_dupes) + " duplicates.</em></p>" if exact_dupes > 200 else ""}
    '''}

    <h2>Near-Duplicates (Similarity >= {threshold * 100:.0f}%)</h2>
    {"<p>No near-duplicates found above threshold.</p>" if near_pairs == 0 else near_cards}

    <div class="footer">
        <p>Generated by Open Brain file-dedup.py | Threshold: {threshold} | <a href="https://github.com/davistroy/open-brain">Open Brain</a></p>
    </div>
</body>
</html>"""

    with open(report_path, "w", encoding="utf-8") as f:
        f.write(report_html)

    logger.info("HTML report written to %s", report_path)


# ---------------------------------------------------------------------------
# Console summary
# ---------------------------------------------------------------------------


def print_summary(exact_stats: dict, near_stats: dict) -> None:
    """Print a console summary of dedup results."""
    print("\n" + "=" * 70)
    print("DEDUPLICATION RESULTS")
    print("=" * 70)

    print("\n--- Exact Duplicates ---")
    print(f"Duplicate groups found: {exact_stats['groups']:,}")
    print(f"Files marked as duplicate: {exact_stats['total_duplicates']:,}")
    space_mb = exact_stats["space_saved_bytes"] / (1024 * 1024)
    print(f"Space recoverable: {space_mb:.1f} MB")

    print("\n--- Near-Duplicates ---")
    print(f"Text pairs compared: {near_stats['pairs_compared']:,}")
    print(f"Near-duplicate pairs flagged: {near_stats['near_duplicates_found']:,}")

    if near_stats["pairs"]:
        print("\nTop near-duplicate pairs:")
        for pair in sorted(near_stats["pairs"], key=lambda p: -p["similarity"])[:10]:
            print(
                f"  {pair['similarity']*100:.1f}% | {pair['filename_a']} <-> {pair['filename_b']}"
            )

    print("\n" + "=" * 70)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Detect exact and near-duplicate files in inventory database",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Standard dedup (default threshold 0.9)
  python scripts/file-dedup.py --db /mnt/user/openbrain/inventory.db

  # Lower threshold for more aggressive near-dup detection
  python scripts/file-dedup.py --db ./inventory.db --threshold 0.85

  # Dry run (report only, don't mark files)
  python scripts/file-dedup.py --db ./inventory.db --dry-run

  # Custom report path
  python scripts/file-dedup.py --db ./inventory.db --report ./my-dedup-report.html
        """,
    )
    parser.add_argument(
        "--db",
        default="/mnt/user/openbrain/inventory.db",
        help="Path to inventory SQLite database (default: /mnt/user/openbrain/inventory.db)",
    )
    parser.add_argument(
        "--threshold",
        type=float,
        default=DEFAULT_NEAR_DUP_THRESHOLD,
        help=f"Near-duplicate similarity threshold (default: {DEFAULT_NEAR_DUP_THRESHOLD})",
    )
    parser.add_argument(
        "--report",
        default=None,
        help="Path for HTML report (default: <db-dir>/dedup-report.html)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Report only, don't update database",
    )
    args = parser.parse_args()

    db_path = args.db
    if not Path(db_path).exists():
        logger.error("Database not found: %s (run file-inventory.py first)", db_path)
        sys.exit(1)

    report_path = args.report or str(Path(db_path).parent / "dedup-report.html")

    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA journal_mode=WAL")

    logger.info("Starting deduplication analysis...")
    if args.dry_run:
        logger.info("DRY RUN mode: database will not be modified")

    # Phase 1: Exact duplicates
    logger.info("Phase 1: Detecting exact duplicates (SHA-256 match)...")
    exact_stats = detect_exact_duplicates(conn, dry_run=args.dry_run)

    # Phase 2: Near-duplicates
    logger.info(
        "Phase 2: Detecting near-duplicates (text similarity >= %.0f%%)...", args.threshold * 100
    )
    near_stats = detect_near_duplicates(conn, threshold=args.threshold, dry_run=args.dry_run)

    # Generate report
    generate_html_report(exact_stats, near_stats, report_path, args.threshold)
    print_summary(exact_stats, near_stats)

    conn.close()
    logger.info("Deduplication complete. Report: %s", report_path)


if __name__ == "__main__":
    main()
