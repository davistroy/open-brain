"""
OneDrive Reorganization — Moves files from current structure to approved new structure.

Reads the file inventory SQLite DB and moves files according to the approved plan.
Run AFTER dedup-and-archive.py has completed.

Usage:
    python reorganize-onedrive.py --db /path/to/db --root /path/to/onedrive --report-only
    python reorganize-onedrive.py --db /path/to/db --root /path/to/onedrive --dry-run
    python reorganize-onedrive.py --db /path/to/db --root /path/to/onedrive
"""

from __future__ import annotations

import argparse
import csv
import os
import shutil
import sqlite3
import sys
from pathlib import Path

sys.stdout.reconfigure(line_buffering=True)  # type: ignore[attr-defined]


# ============================================================
# MAPPING RULES
# ============================================================
# Each rule: (source_prefix, dest_prefix, description)
# Rules are evaluated in order — first match wins.
# More specific prefixes must come before general ones.

MOVE_RULES: list[tuple[str, str | None, str]] = [
    # ---------------------------------------------------------
    # WORK / COCA-COLA
    # ---------------------------------------------------------
    # Primary Coke tree (Coke/Current/) → Work/Coca-Cola/
    # Business Services + BSNA combined into Work/Coca-Cola/BSNA/
    ("Coke/Current/Business Services/", "Work/Coca-Cola/BSNA/", "Coke Bus Svcs → combined BSNA"),
    ("Coke/Current/TSAD/", "Work/Coca-Cola/BSNA/TSAD/", "Coke TSAD → combined BSNA"),
    ("Coke/Current/Admin/", "Work/Coca-Cola/Admin/", ""),
    ("Coke/Current/Projects/", "Work/Coca-Cola/Projects/", ""),
    ("Coke/Current/Strategy and BTO/", "Work/Coca-Cola/Strategy and BTO/", ""),
    ("Coke/Current/Commercial Leadership/", "Work/Coca-Cola/Commercial Leadership/", ""),
    ("Coke/Current/Customer Care/", "Work/Coca-Cola/Customer Care/", ""),
    ("Coke/Current/Email Downloads/", "Work/Coca-Cola/Email Downloads/", ""),
    (
        "Coke/Current/General Coke IT and Business/",
        "Work/Coca-Cola/General Coke IT and Business/",
        "",
    ),
    ("Coke/Current/Region Sales/", "Work/Coca-Cola/Region Sales/", ""),
    ("Coke/Current/CokeONE and SCALE/", "Work/Coca-Cola/CokeONE and SCALE/", ""),
    ("Coke/Current/National Retail Sales/", "Work/Coca-Cola/National Retail Sales/", ""),
    ("Coke/Current/Shared Services/", "Work/Coca-Cola/Shared Services/", ""),
    ("Coke/Current/Supply Chain/", "Work/Coca-Cola/Supply Chain/", ""),
    ("Coke/Current/QA/", "Work/Coca-Cola/QA/", ""),
    ("Coke/Current/Python Scripts/", "Work/Coca-Cola/Programming/", ""),
    ("Coke/Current/Programming/", "Work/Coca-Cola/Programming/", ""),
    ("Coke/Current/Personal/", "Work/Coca-Cola/Personal/", "Coke-era personal files"),
    ("Coke/Current/Old-Favorites/", "Work/Coca-Cola/Old-Favorites/", ""),
    ("Coke/Current/FSOP/", "Work/Coca-Cola/FSOP/", ""),
    ("Coke/Current/Model Market/", "Work/Coca-Cola/Model Market/", ""),
    ("Coke/Current/Other Bottlers/", "Work/Coca-Cola/Other Bottlers/", ""),
    ("Coke/Current/Favorites/", "Work/Coca-Cola/Favorites/", ""),
    ("Coke/Current/", "Work/Coca-Cola/", "Catch-all for remaining Coke/Current"),
    # Other Coke top-level dirs
    ("Coke/BASIS Replacement/", "Work/Coca-Cola/Projects/BASIS Replacement/", ""),
    ("Coke/BSNA/", "Work/Coca-Cola/BSNA/", ""),
    ("Coke/BTO/", "Work/Coca-Cola/Strategy and BTO/BTO/", ""),
    ("Coke/CONA/", "Work/Coca-Cola/Projects/System of the Future/CONA/", ""),
    ("Coke/Python/", "Work/Coca-Cola/Python/", ""),
    ("Coke/SoF/", "Work/Coca-Cola/Projects/System of the Future/SoF/", ""),
    ("Coke/Status/", "Work/Coca-Cola/Admin/Status/", ""),
    ("Coke/T-E/", "Work/Coca-Cola/Admin/Time and Exp/", ""),
    ("Coke/", "Work/Coca-Cola/", "Catch-all Coke top-level"),
    # Documents/Coke → merge into Work/Coca-Cola (unique files after dedup)
    ("Documents/Coke/", "Work/Coca-Cola/", "Documents/Coke merge"),
    # Top-level Admin (Coke expense reports)
    ("Admin/", "Work/Coca-Cola/Admin/", "Top-level Admin → Coke Admin"),
    # BSNA Backup → combined BSNA
    ("BSNA Backup/", "Work/Coca-Cola/BSNA/", "BSNA Backup → combined BSNA"),
    # Top-level Business Services → combined BSNA
    (
        "Business Services/",
        "Work/Coca-Cola/BSNA/Business Services/",
        "Business Services → combined BSNA",
    ),
    # ---------------------------------------------------------
    # WORK / STRATFIELD
    # ---------------------------------------------------------
    (
        "Consulting/Chick-Fil-A/",
        "Work/Stratfield/Chick-fil-A/",
        "Merge Consulting CFA → Stratfield",
    ),
    (
        "Consulting/Chick-fil-A/",
        "Work/Stratfield/Chick-fil-A/",
        "Merge Consulting CFA → Stratfield",
    ),
    ("Business/Stratfield/Chick-Fil-A/", "Work/Stratfield/Chick-fil-A/", "Fix CFA capitalization"),
    ("Business/Stratfield/", "Work/Stratfield/", ""),
    # ---------------------------------------------------------
    # WORK / CONSULTING (pre-Stratfield, minus CFA which merged above)
    # ---------------------------------------------------------
    ("Consulting/Stratfield/", "Work/Consulting/Admin/", "Consulting admin/receipts"),
    ("Consulting/", "Work/Consulting/", ""),
    # ---------------------------------------------------------
    # WORK / OTHER
    # ---------------------------------------------------------
    ("Sellr/", "Work/Sellr/", ""),
    ("Business/Ginkgo/", "Work/Ginkgo/", ""),
    ("Business/Stratidyne/", "Work/Stratidyne/", ""),
    ("Business/Valley Hill Trading Co/", "Work/Valley Hill Trading Co/", ""),
    ("GV Documents/", "Work/GV/", ""),
    ("Product Launch Workspace/", "Work/GV/Product Launch Workspace/", ""),
    # ---------------------------------------------------------
    # AMATEUR RADIO
    # ---------------------------------------------------------
    ("Documents/Affirmatech/N3FJP Software/", "Amateur Radio/N3FJP Software/", "Contest logging"),
    ("Documents/Kenwood/", "Amateur Radio/Equipment/Kenwood/", "Radio configs"),
    ("Documents/Yaesu/", "Amateur Radio/Equipment/Yaesu/", "Radio configs"),
    ("Documents/N1MM Logger+/", "Amateur Radio/Software/N1MM Logger+/", ""),
    ("Documents/G4FON Software/", "Amateur Radio/Software/G4FON/", "Morse trainer"),
    ("Documents/EchoLink/", "Amateur Radio/Software/EchoLink/", ""),
    ("Documents/HDSDR/", "Amateur Radio/Software/HDSDR/", ""),
    ("Documents/Packet Engine Pro/", "Amateur Radio/Software/Packet Engine Pro/", ""),
    (
        "Documents/VBCABLE_A_Driver_Pack43/",
        "Amateur Radio/Software/VBCABLE Driver/",
        "Virtual audio cable",
    ),
    ("Documents/VARA FM v4.2.2 Setup/", "Amateur Radio/Software/VARA FM/", ""),
    ("Documents/VARA HF v4.6.1 Setup/", "Amateur Radio/Software/VARA HF/", ""),
    ("Projects/Raspberry Pi/", "Amateur Radio/Projects/Raspberry Pi/", "BPQ packet radio"),
    ("Projects/Amateur Radio/", "Amateur Radio/Projects/", ""),
    # Amateur Radio itself stays in place
    ("Amateur Radio/", "Amateur Radio/", "Keep as-is"),
    # ---------------------------------------------------------
    # SAILING
    # ---------------------------------------------------------
    ("Boat/", "Sailing/Boat Manuals/", ""),
    ("Documents/Charts/", "Sailing/Charts/", "Navigational charts"),
    ("Sailing/", "Sailing/", "Keep as-is"),
    # ---------------------------------------------------------
    # MAKING
    # ---------------------------------------------------------
    # 3D Printing merge
    ("3D Printer Stuff/AM8", "Making/3D Printing/Printer Mods/AM8", ""),
    ("3D Printer Stuff/Anet", "Making/3D Printing/Printer Mods/Anet", ""),
    ("3D Printer Stuff/Original-Prusa", "Making/3D Printing/Printer Mods/Original-Prusa", ""),
    ("3D Printer Stuff/Prusa_i3", "Making/3D Printing/Printer Mods/Prusa_i3", ""),
    ("3D Printer Stuff/", "Making/3D Printing/", ""),
    ("Projects/3D Printing/", "Making/3D Printing/", ""),
    # Woodworking
    ("Workshop/FWW Issues/", "Making/Woodworking/Fine Woodworking/", ""),
    (
        "Workshop/T4570_The_American_Woodworker_Magazine_Collection/",
        "Making/Woodworking/American Woodworker/",
        "",
    ),
    ("Workshop/1000 Tips and Tricks/", "Making/Woodworking/1000 Tips and Tricks/", ""),
    ("Workshop/", "Making/Woodworking/", "Catch-all Workshop"),
    ("Personal/bandsaw_plans/", "Making/Woodworking/Bandsaw Plans/", ""),
    ("Personal/lawnchair/", "Making/Woodworking/Lawnchair Plans/", ""),
    # CNC
    ("Projects/CNC Milling/", "Making/CNC/", ""),
    ("Personal/Joes CNC Model 2006 R-2/", "Making/CNC/Joes CNC Model 2006/", ""),
    # Electronics merge
    ("Projects/Electronics/", "Making/Electronics/", ""),
    ("Projects/PCB/", "Making/Electronics/", ""),
    ("Documents/KiCad/", "Making/Electronics/KiCad/", "KiCad libraries"),
    ("Documents/EasyEDA-Pro/", "Making/Electronics/EasyEDA-Pro/", ""),
    ("Electronics/", "Making/Electronics/", "Top-level Electronics"),
    # ---------------------------------------------------------
    # PERSONAL
    # ---------------------------------------------------------
    ("Personal/Career/", "Personal/Career/", "Keep"),
    ("Personal/Family/", "Personal/Family/", "Keep"),
    ("Personal/Daniel/", "Personal/Family/Daniel/", ""),
    ("Personal/Jamie/", "Personal/Family/Jamie/", ""),
    ("Personal/Finance/", "Personal/Finance/", "Keep"),
    ("Personal/Insurance/", "Personal/Finance/Insurance/", ""),
    ("Personal/Taxes/", "Personal/Finance/Taxes/", ""),
    ("Personal/Health/", "Personal/Health/", "Keep"),
    ("Health/", "Personal/Health/", "Top-level Health merge"),
    ("Personal/3381 Valley Hill/", "Personal/Home/3381 Valley Hill/", ""),
    ("Personal/3381ValleyHillMortgageDocs/", "Personal/Home/3381 Valley Hill/Mortgage/", ""),
    ("Personal/Cabin/", "Personal/Home/Cabin/", ""),
    ("Real Estate/", "Personal/Home/Real Estate/", ""),
    ("Personal/Newport Trip/", "Personal/Travel/Newport Trip/", ""),
    ("Personal/2023 Italy-France/", "Personal/Travel/2023 Italy-France/", ""),
    ("Trips/", "Personal/Travel/", ""),
    ("Maps-Trips/", "Personal/Travel/Maps/", ""),
    ("Education/", "Personal/Education/", ""),
    ("Personal/KSU/", "Personal/Education/KSU/", ""),
    ("Personal/Bible Study/", "Personal/Education/Bible Study/", ""),
    ("Personal/Kindle Backup/", "Personal/Books/Kindle Backup/", ""),
    ("Personal/Guitar/", "Personal/Books/Guitar/", ""),
    ("Books/", "Personal/Books/", "Top-level Books"),
    ("Vehicles/", "Personal/Vehicles/", ""),
    ("Jeep/", "Personal/Vehicles/Jeep/", ""),
    ("Personal/Vehicles/", "Personal/Vehicles/", "Keep"),
    ("Personal/Writing/", "Personal/Writing/", "Keep"),
    ("Personal/Scouts/", "Personal/Family/Daniel/Scouts/", ""),
    ("First Lego League/", "Personal/Family/Daniel/First Lego League/", ""),
    ("Personal/Moms 80th/", "Personal/Family/Moms 80th/", ""),
    ("Personal/Jimmys Campaign 2018/", "Personal/Family/Jimmys Campaign 2018/", ""),
    ("Personal/Tech/", "Personal/Tech/", "Keep"),
    ("Personal/config/", "Personal/Tech/config/", ""),
    ("Personal/Business/", "Personal/Business/", "Keep"),
    ("Personal/Business Model/", "Personal/Business Model/", "Keep"),
    ("Personal/Code/", "Projects/Code/Personal/", ""),
    ("Personal/Private/", "Personal/Finance/Private/", ""),
    ("Personal/SHTF/", "Personal/SHTF/", "Keep"),
    ("Personal/Home/", "Personal/Home/", "Keep"),
    ("Personal/Funny/", "Personal/Family/Funny/", ""),
    ("Personal/", "Personal/", "Catch-all Personal"),
    # ---------------------------------------------------------
    # PROJECTS
    # ---------------------------------------------------------
    ("Projects/Code/AI/", "Projects/Code/AI/", "Keep"),
    ("Projects/AI/", "Projects/Code/AI/", "Merge AI Projects into Code/AI"),
    ("Projects/Code/", "Projects/Code/", "Keep"),
    ("Projects/Utilities/", "Projects/Utilities/", "Keep"),
    ("Projects/", "Projects/", "Catch-all Projects"),
    # ---------------------------------------------------------
    # REFERENCE
    # ---------------------------------------------------------
    ("Documents/Zoom/", "Reference/Zoom Recordings/", ""),
    ("Documents/Templates/", "Reference/Office Templates/", ""),
    ("Scanbot/", "Reference/Scans/Scanbot/", ""),
    ("Documents/Office Lens/", "Reference/Scans/Office Lens/", ""),
    ("OfficeMobile/", "Reference/Scans/OfficeMobile/", ""),
    ("Documents/ARIS Express/", "Reference/ARIS Express/", ""),
    ("Documents/External Docs/", "Reference/External Docs/", ""),
    ("Documents/iPad/", "Reference/iPad PDFs/", ""),
    # ---------------------------------------------------------
    # APP DATA (remaining app configs)
    # ---------------------------------------------------------
    ("Documents/PowerShell/", "App Data/PowerShell/", ""),
    ("Documents/WindowsPowerShell/", "App Data/WindowsPowerShell/", ""),
    ("Documents/UniGetUI/", "App Data/UniGetUI/", ""),
    ("Documents/Claude/", "App Data/Claude/", ""),
    ("Documents/Cline/", "App Data/Cline/", ""),
    ("Documents/Kutools for Excel/", "App Data/Kutools for Excel/", ""),
    ("Documents/OneNote Notebooks/", "App Data/OneNote Notebooks/", ""),
    ("Documents/My Labels/", "App Data/My Labels/", ""),
    ("Documents/My Garmin/", "App Data/My Garmin/", ""),
    ("Documents/PGP/", "App Data/PGP/", ""),
    ("Documents/OnScreen Control/", "App Data/OnScreen Control/", ""),
    ("Documents/Fiddler2/", "App Data/Fiddler2/", ""),
    ("Documents/XSplit/", "App Data/XSplit/", ""),
    ("Documents/My Tableau Repository/", "App Data/My Tableau Repository/", ""),
    ("Documents/My Data Sources/", "App Data/My Data Sources/", ""),
    ("Documents/navigator/", "App Data/navigator/", ""),
    ("Documents/My Shapes/", "App Data/My Shapes/", ""),
    ("Documents/Visual Studio 2015/", "App Data/Visual Studio 2015/", ""),
    ("Documents/Dell/", "App Data/Dell/", ""),
    ("Documents/HPrintJobsStorage/", "App Data/HPrintJobsStorage/", ""),
    ("Documents/vcam/", "App Data/vcam/", ""),
    ("Documents/CommunityPlugins/", "App Data/CommunityPlugins/", ""),
    ("Documents/My Meetings/", "App Data/My Meetings/", ""),
    ("Documents/TaskSeparator11/", "App Data/TaskSeparator11/", ""),
    # ---------------------------------------------------------
    # ARCHIVE — catch-all for Documents/* not matched above
    # ---------------------------------------------------------
    ("Documents/Workspace/", None, "DELETE — Eclipse metadata"),
    ("Documents/Blueprint RC 2010/", "_Archive/Blueprint RC 2010/", ""),
    ("Documents/Downloads/", "_Archive/Downloads/", ""),
    ("Documents/WinTAK/", "_Archive/WinTAK/", ""),
    ("Documents/ExportBlock-", "_Archive/ExportBlock/", ""),
    ("Documents/dumps/", "_Archive/dumps/", ""),
    ("Documents/git_tutorial/", "_Archive/git_tutorial/", ""),
    ("Documents/Programming/", "Work/Coca-Cola/Programming/", "Coke-era programming"),
    ("Documents/Personal/", "Personal/", "Documents/Personal merge"),
    ("Documents/", "_Archive/Documents/", "Catch-all remaining Documents"),
    # SkyDrive — merge unique files into main structure
    ("SkyDrive/Documents/Coke/", "Work/Coca-Cola/", "SkyDrive Coke merge"),
    ("SkyDrive/Coke/", "Work/Coca-Cola/", "SkyDrive Coke merge"),
    ("SkyDrive/Books/Boat/", "Sailing/Boat Manuals/", "SkyDrive boat books"),
    ("SkyDrive/Books/", "Personal/Books/", "SkyDrive books"),
    ("SkyDrive/Documents/Personal/", "Personal/", "SkyDrive personal merge"),
    ("SkyDrive/Documents/", "_Archive/SkyDrive/Documents/", "SkyDrive remaining docs"),
    ("SkyDrive/Favorites/", None, "DELETE — old bookmarks"),
    ("SkyDrive/", "_Archive/SkyDrive/", "Catch-all SkyDrive"),
    # Favorites — delete
    ("Favorites/", None, "DELETE — old bookmarks"),
    ("Documents/Favorites/", None, "DELETE — old bookmarks"),
    # Remaining top-level misc
    ("Home Share/", "_Archive/Home Share/", ""),
    ("Apps/", "_Archive/Apps/", ""),
    ("Videos/", "_Archive/Videos/", ""),
    ("Public/", "_Archive/Public/", ""),
    ("Email attachments/", "_Archive/Email attachments/", "Sort manually"),
    ("Archive/", "_Archive/Old Archive/", ""),
    ("Desktop/", "_Archive/Desktop/", ""),
    ("Temp/", "_Archive/Temp/", ""),
    ("Documents2-tdavis-HPdm1z/", "_Archive/", ""),
    ("Documents2/", "_Archive/", ""),
    ("Mobile uploads/", "_Archive/Mobile uploads/", ""),
    ("My Blog Photos/", "_Archive/My Blog Photos/", ""),
]

# Root files with known destinations (high confidence classification)
ROOT_FILE_RULES: dict[str, str | None] = {
    "candidatenote.xlsx": "Work/Stratfield/ATS-CRM/",
    "candidatenote_load.csv": "Work/Stratfield/ATS-CRM/",
    "candidate.xlsx": "Work/Stratfield/ATS-CRM/",
    "hotlist.xlsx": "Work/Stratfield/ATS-CRM/",
    "hotlist_candidate_load.xlsx": "Work/Stratfield/ATS-CRM/",
    "2024-10-12 Ride for Wishes TED-K4JDA.pdf": "Amateur Radio/",
    "PTRR-Channel.csv": "Amateur Radio/ARES/",
    "2019 AYC Open SIs v2.doc": "Sailing/Events/",
    "2016 Y Flyer Mid-Winters SIs v3.doc": "Sailing/Events/",
    "BVI-Iten-June2013-WWDL257407.xlsx": "Personal/Travel/BVI 2013/",
    "BVI-Iten-June2013.xlsx": "Personal/Travel/BVI 2013/",
    "BVI-Iten-June2013.pdf": "Personal/Travel/BVI 2013/",
    "SkillChecklist-BVItripJune2013.pdf": "Personal/Travel/BVI 2013/",
    "2018 Benefit Details.pdf": "Work/Coca-Cola/Admin/Benefits/",
    "Holiday Plan 2015.pdf": "Work/Coca-Cola/Admin/",
    "AI rollout JD.docx": "Personal/Career/",
    "Budget Draft 2019-08-10.xlsx": "Personal/Finance/",
    "Bonus.xlsx": "Personal/Finance/",
    "Scan from 2018-01-30 07_20 PM.pdf": "_Archive/Root Files/",
    "45 Settlers Tasks.xlsx": "_Archive/Root Files/",
    "Book.xlsx": None,  # DELETE — empty test file
    "Book1.xlsx": None,
    "Book 1.xlsx": None,
    "Test11-09-13.xlsx": None,
    "Document.docx": None,
    "Document1.docx": None,
    "3D Printer Stuff-Dell7450-Stratfield.url": None,
    "items.sqlite3-shm": None,
    ".config.hash": None,
    ".config.backup": None,
}


def find_dest(path: str, filename: str) -> tuple[str | None, str]:
    """Find destination for a file based on mapping rules."""
    # Root-level files (no directory)
    if "/" not in path:
        if filename in ROOT_FILE_RULES:
            dest = ROOT_FILE_RULES[filename]
            if dest is None:
                return None, "DELETE"
            return dest + filename, "root-file-rule"
        return "_Archive/Root Files/" + filename, "root-unclassified"

    # Directory-based rules
    for prefix, dest_prefix, desc in MOVE_RULES:
        if path.startswith(prefix):
            if dest_prefix is None:
                return None, f"DELETE — {desc}"
            # If source == dest prefix, file stays in place
            if prefix == dest_prefix:
                return path, "no-move"
            remainder = path[len(prefix) :]
            return dest_prefix + remainder, desc or "rule"

    # No rule matched — move to archive
    return "_Archive/Unmatched/" + path, "no-rule-matched"


def main() -> None:
    parser = argparse.ArgumentParser(description="Reorganize OneDrive files")
    parser.add_argument("--db", required=True, help="Path to file inventory SQLite DB")
    parser.add_argument("--root", required=True, help="Root directory of the file corpus")
    parser.add_argument("--report-only", action="store_true", help="Just print the plan")
    parser.add_argument("--dry-run", action="store_true", help="Report only, don't move")
    parser.add_argument("--manifest", default="reorganize-manifest.csv", help="Manifest CSV name")
    parser.add_argument(
        "--archive-dir", default=None, help="External archive dir for _Archive items"
    )
    args = parser.parse_args()

    conn = sqlite3.connect(args.db)
    root = Path(args.root).resolve()

    # Get all files
    rows = conn.execute("""
        SELECT path, filename, size_bytes FROM files
        ORDER BY path
    """).fetchall()
    conn.close()

    print(f"Total files in inventory: {len(rows):,}\n", flush=True)

    # Classify each file
    moves = []  # (src_path, dest_path, reason)
    no_moves = []  # files staying in place
    deletes = []  # files to delete

    for path, filename, size in rows:
        dest, reason = find_dest(path, filename)
        if dest is None:
            deletes.append((path, reason, size))
        elif reason == "no-move" or dest == path:
            no_moves.append(path)
        else:
            moves.append((path, dest, reason, size))

    # Summary
    move_size = sum(s or 0 for _, _, _, s in moves)
    delete_size = sum(s or 0 for _, _, s in deletes)

    print("=" * 60, flush=True)
    print("  REORGANIZATION PLAN", flush=True)
    print("=" * 60, flush=True)
    print(f"  Files to move:    {len(moves):,}  ({move_size/1024/1024/1024:.2f} GB)", flush=True)
    print(f"  Files staying:    {len(no_moves):,}", flush=True)
    print(
        f"  Files to delete:  {len(deletes):,}  ({delete_size/1024/1024/1024:.2f} GB)", flush=True
    )
    print(f"  Total:            {len(moves) + len(no_moves) + len(deletes):,}", flush=True)

    # Show destination breakdown
    dest_counts = {}
    for _, dest, _, size in moves:
        top = dest.split("/")[0]
        if top not in dest_counts:
            dest_counts[top] = {"count": 0, "size": 0}
        dest_counts[top]["count"] += 1
        dest_counts[top]["size"] += size or 0

    print("\n  Destination breakdown:", flush=True)
    for top in sorted(dest_counts.keys()):
        info = dest_counts[top]
        print(
            f"    {top:30s} {info['count']:>6,} files  {info['size']/1024/1024/1024:>7.2f} GB",
            flush=True,
        )

    # Show deletes
    if deletes:
        print("\n  Files to delete:", flush=True)
        delete_groups = {}
        for path, reason, size in deletes:
            key = reason
            if key not in delete_groups:
                delete_groups[key] = {"count": 0, "size": 0}
            delete_groups[key]["count"] += 1
            delete_groups[key]["size"] += size or 0
        for reason, info in sorted(delete_groups.items()):
            print(
                f"    {reason:40s} {info['count']:>5,} files  {info['size']/1024/1024:.0f} MB",
                flush=True,
            )

    # Show sample moves
    print("\n  Sample moves (first 20):", flush=True)
    for src, dest, reason, size in moves[:20]:
        print(f"    {src}", flush=True)
        print(f"      -> {dest}", flush=True)

    if args.report_only:
        print("\n  REPORT ONLY — no files moved.\n", flush=True)
        return

    if args.dry_run:
        print("\n  DRY RUN — no files moved.", flush=True)
        return

    # === EXECUTE ===
    print(f"\n  Executing {len(moves):,} moves...", flush=True)
    moved = 0
    errors = 0
    deleted = 0

    manifest_path = root / args.manifest
    with open(manifest_path, "w", newline="", encoding="utf-8") as mf:
        writer = csv.writer(mf)
        writer.writerow(["action", "original_path", "new_path", "reason"])

        # Moves
        for src_rel, dest_rel, reason, size in moves:
            src = root / src_rel
            dst = root / dest_rel

            if not src.exists():
                continue

            if dst.exists():
                # Don't overwrite — append suffix
                stem = dst.stem
                suffix = dst.suffix
                i = 1
                while dst.exists():
                    dst = dst.parent / f"{stem} ({i}){suffix}"
                    i += 1

            try:
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(src), str(dst))
                writer.writerow(["move", src_rel, str(dst.relative_to(root)), reason])
                moved += 1
                if moved % 500 == 0:
                    print(f"    {moved:,}/{len(moves):,} moved...", flush=True)
            except Exception as e:
                errors += 1
                if errors <= 20:
                    print(f"    Error: {src_rel}: {e}", flush=True)

        # Deletes
        for path, reason, size in deletes:
            src = root / path
            if not src.exists():
                continue
            try:
                src.unlink()
                writer.writerow(["delete", path, "", reason])
                deleted += 1
            except Exception as e:
                errors += 1
                if errors <= 20:
                    print(f"    Delete error: {path}: {e}", flush=True)

    print(f"\n  Moved:   {moved:,}", flush=True)
    print(f"  Deleted: {deleted:,}", flush=True)
    print(f"  Errors:  {errors:,}", flush=True)
    print(f"  Manifest: {manifest_path}", flush=True)

    # Clean up empty directories
    print("\n  Cleaning empty directories...", flush=True)
    empty_removed = 0
    for dirpath, dirnames, filenames in os.walk(str(root), topdown=False):
        if not dirnames and not filenames:
            try:
                os.rmdir(dirpath)
                empty_removed += 1
            except OSError:
                pass
    print(f"  Removed {empty_removed:,} empty directories", flush=True)
    print(f"{'=' * 60}\n", flush=True)


if __name__ == "__main__":
    main()
