#!/usr/bin/env python3
"""
Lab Report Trend Synthesis for Open Brain — P20b.

T0 Python queries lab_results, computes trend directions, builds a structured
prompt.  T2 Claude CLI (``claude --print``) synthesizes the narrative.
One capture is POSTed to core-api per run.

No LLM API calls — synthesis uses the Claude Code CLI (Max subscription, free).

Usage:
    python scripts/lab-report-synthesis.py
    python scripts/lab-report-synthesis.py --last 3
    python scripts/lab-report-synthesis.py --dry-run
    python scripts/lab-report-synthesis.py --no-synthesis
    python scripts/lab-report-synthesis.py --report-id <id>
    python scripts/lab-report-synthesis.py --config /path/to/lab-report.yaml
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import subprocess
import sys
from datetime import date
from pathlib import Path
from typing import Any

import yaml

# ---------------------------------------------------------------------------
# Path wiring — works locally (scripts/ in sys.path[0]) and in Docker sidecar
# ---------------------------------------------------------------------------
_SCRIPT_DIR = Path(__file__).resolve().parent
_REPO_ROOT = _SCRIPT_DIR.parent
sys.path.insert(0, str(_SCRIPT_DIR))

from lib.capture_api import post_capture  # noqa: E402
from lib.db import get_connection  # noqa: E402

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
sys.stdout.reconfigure(line_buffering=True)  # type: ignore[union-attr]
sys.stderr.reconfigure(line_buffering=True)  # type: ignore[union-attr]
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("lab-report-synthesis")

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
_DEFAULT_CONFIG_PATH = _REPO_ROOT / "config" / "lab-report.yaml"


def load_config(config_path: Path | None = None) -> dict:
    path = config_path or _DEFAULT_CONFIG_PATH
    if path.exists():
        with path.open() as f:
            return yaml.safe_load(f) or {}
    log.warning("Config not found at %s — using defaults", path)
    return {}


def get_synthesis_config(cfg: dict) -> dict:
    defaults = {
        "default_report_window": 5,
        "max_prompt_chars": 4000,
        "captures_url": "",
    }
    return {**defaults, **cfg.get("synthesis", {})}


# ---------------------------------------------------------------------------
# Trend direction computation (T0 — pure Python, deterministic)
# ---------------------------------------------------------------------------

# Direction labels
IMPROVING = "IMPROVING"
WORSENING = "WORSENING"
STABLE = "STABLE"
VARIABLE = "VARIABLE"


def compute_trend_direction(
    values: list[float | None],
    flags: list[str | None],
    ref_low: float | None,
    ref_high: float | None,
) -> str | None:
    """Compute trend direction from a chronological series of values + flags.

    Args:
        values:   Numeric values in chronological order (oldest first).
                  May contain None for non-numeric tests.
        flags:    Derived flags ('HIGH', 'LOW', 'ABNORMAL', 'NORMAL', None)
                  in same order as values.
        ref_low:  Lower reference bound (or None).
        ref_high: Upper reference bound (or None).

    Returns:
        IMPROVING / WORSENING / STABLE / VARIABLE, or None if only one point.

    Rules:
      - Single value → None (no trend possible)
      - All same numeric value (within float epsilon) → STABLE
      - At least two numeric values and a reference range:
          * Last two values both moving toward normal range → IMPROVING
          * Last two values both moving away from normal range → WORSENING
          * Mixed recent directions → VARIABLE
      - Flags only (no numeric): alternating non-NORMAL / NORMAL → VARIABLE;
          consistently non-NORMAL → WORSENING; consistently NORMAL → STABLE
    """
    if len(values) < 2:
        return None

    # Strip None values from the end to get the two most-recent comparable points
    numeric = [(v, f) for v, f in zip(values, flags, strict=False) if v is not None]
    if len(numeric) < 2:
        # Fall back to flag-based trend
        return _flag_trend(flags)

    # All values equal (within tiny epsilon) → STABLE
    all_vals = [v for v, _ in numeric]
    if max(all_vals) - min(all_vals) < 1e-9:
        return STABLE

    # Use last two numeric points for direction
    prev_val, prev_flag = numeric[-2]
    curr_val, curr_flag = numeric[-1]

    if ref_low is not None or ref_high is not None:
        prev_dist = _distance_to_normal(prev_val, ref_low, ref_high)
        curr_dist = _distance_to_normal(curr_val, ref_low, ref_high)

        if curr_dist < prev_dist:
            return IMPROVING
        elif curr_dist > prev_dist:
            return WORSENING
        else:
            return STABLE

    # No reference range — use flag transitions
    return _flag_trend(flags)


def _distance_to_normal(
    value: float,
    ref_low: float | None,
    ref_high: float | None,
) -> float:
    """Distance from value to the nearest edge of the normal range (0 = inside)."""
    if ref_low is not None and value < ref_low:
        return ref_low - value
    if ref_high is not None and value > ref_high:
        return value - ref_high
    return 0.0


def _flag_trend(flags: list[str | None]) -> str:
    """Trend direction inferred from flag sequence alone."""
    non_none = [f for f in flags if f is not None]
    if not non_none:
        return STABLE
    abnormal = [f for f in non_none if f != "NORMAL"]
    if not abnormal:
        return STABLE
    normal_count = sum(1 for f in non_none if f == "NORMAL")
    abnormal_count = len(abnormal)
    if normal_count > 0 and abnormal_count > 0:
        return VARIABLE
    return WORSENING  # all entries are abnormal


# ---------------------------------------------------------------------------
# Database queries (T0)
# ---------------------------------------------------------------------------

def fetch_recent_report_ids(conn, limit: int) -> list[str]:
    """Return the N most-recent distinct report_ids ordered by collection_date DESC.

    Memory contract: returns a bounded list (at most `limit` entries) — never
    loads the entire lab_results table.
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT report_id
            FROM lab_results
            GROUP BY report_id
            ORDER BY MAX(collection_date) DESC
            LIMIT %s
            """,
            (limit,),
        )
        rows = cur.fetchall()
    return [r[0] for r in rows]


def fetch_results_for_reports(conn, report_ids: list[str]) -> list[dict]:
    """Fetch all lab_results rows for the given report_ids.

    Returns a list of dicts with keys matching the lab_results schema.
    Bounded by the report window — never loads the full table.
    """
    if not report_ids:
        return []

    placeholders = ",".join(["%s"] * len(report_ids))
    sql = f"""
        SELECT
            report_id, collection_date, test_name,
            raw_value, numeric_value, units,
            ref_range_text, ref_low, ref_high,
            lab_flag, derived_flag, ordering_provider, source_file
        FROM lab_results
        WHERE report_id IN ({placeholders})
        ORDER BY test_name, collection_date ASC
    """
    with conn.cursor() as cur:
        cur.execute(sql, report_ids)
        cols = [d[0] for d in cur.description]
        rows = cur.fetchall()

    results = []
    for row in rows:
        record = dict(zip(cols, row, strict=False))
        # Ensure collection_date is serializable
        if isinstance(record["collection_date"], date):
            record["collection_date"] = record["collection_date"].isoformat()
        results.append(record)
    return results


# ---------------------------------------------------------------------------
# Trend table construction (T0)
# ---------------------------------------------------------------------------

def build_trend_table(
    results: list[dict],
    custom_thresholds: dict,
) -> list[dict]:
    """Group results by test_name and compute trend directions.

    Returns a list of trend entries, one per unique test_name, sorted so
    abnormal / worsening tests appear first.

    custom_thresholds: {test_name_lower: {high: float, low: float}} overrides
    reference range for threshold checking.
    """
    # Group by test_name
    by_test: dict[str, list[dict]] = {}
    for row in results:
        name = row["test_name"]
        by_test.setdefault(name, []).append(row)

    trend_table = []
    for test_name, rows in by_test.items():
        # Already sorted by collection_date ASC from SQL
        values = [r["numeric_value"] for r in rows]
        flags = [r["derived_flag"] for r in rows]
        dates = [r["collection_date"] for r in rows]
        raw_values = [r["raw_value"] for r in rows]
        units = rows[-1].get("units") or ""
        ref_low = rows[-1].get("ref_low")
        ref_high = rows[-1].get("ref_high")
        ref_range_text = rows[-1].get("ref_range_text") or ""

        # Apply custom threshold overrides
        thresh = custom_thresholds.get(test_name.lower(), {})
        if thresh.get("high") is not None:
            ref_high = thresh["high"]
        if thresh.get("low") is not None:
            ref_low = thresh["low"]

        direction = compute_trend_direction(values, flags, ref_low, ref_high)
        current_flag = flags[-1] if flags else None
        current_value = raw_values[-1] if raw_values else ""

        is_abnormal = current_flag in ("HIGH", "LOW", "ABNORMAL")
        is_worsening = direction == WORSENING

        trend_table.append(
            {
                "test_name": test_name,
                "current_value": current_value,
                "current_flag": current_flag,
                "units": units,
                "ref_range_text": ref_range_text,
                "direction": direction,
                "is_abnormal": is_abnormal,
                "is_worsening": is_worsening,
                "dates": dates,
                "values": [str(v) if v is not None else raw for v, raw in zip(values, raw_values, strict=False)],
                "report_count": len(rows),
            }
        )

    # Sort: abnormal+worsening first, then worsening, then abnormal, then rest
    def sort_key(e: dict) -> tuple:
        return (
            0 if (e["is_abnormal"] and e["is_worsening"]) else
            1 if e["is_worsening"] else
            2 if e["is_abnormal"] else
            3,
            e["test_name"],
        )

    trend_table.sort(key=sort_key)
    return trend_table


def collect_flagged_tests(
    trend_table: list[dict],
    custom_thresholds: dict,
) -> list[str]:
    """Return test names that are currently abnormal or worsening."""
    flagged = []
    for entry in trend_table:
        if entry["is_abnormal"] or entry["is_worsening"]:
            flagged.append(entry["test_name"])
    # Also add custom-threshold alerts not already included
    for test_name_lower, thresh in custom_thresholds.items():
        for entry in trend_table:
            if entry["test_name"].lower() == test_name_lower:
                val = entry.get("current_value")
                try:
                    numeric = float(val)  # type: ignore[arg-type]
                    if thresh.get("high") is not None and numeric > thresh["high"]:
                        if entry["test_name"] not in flagged:
                            flagged.append(entry["test_name"])
                    if thresh.get("low") is not None and numeric < thresh["low"]:
                        if entry["test_name"] not in flagged:
                            flagged.append(entry["test_name"])
                except (TypeError, ValueError):
                    pass
    return flagged


# ---------------------------------------------------------------------------
# Prompt construction (T0)
# ---------------------------------------------------------------------------

def build_prompt(
    trend_table: list[dict],
    report_ids: list[str],
    collection_dates: list[str],
    flagged_tests: list[str],
    max_chars: int,
) -> str:
    """Build a structured prompt for claude --print synthesis."""

    date_range = ""
    if collection_dates:
        sorted_dates = sorted(collection_dates)
        if len(sorted_dates) == 1:
            date_range = sorted_dates[0]
        else:
            date_range = f"{sorted_dates[0]} to {sorted_dates[-1]}"

    header = (
        f"You are analyzing {len(report_ids)} lab report(s) spanning {date_range}.\n"
        f"Provide a concise health summary covering:\n"
        f"1. Current state: which values are abnormal and by how much\n"
        f"2. Notable changes: what has improved or worsened since the prior report\n"
        f"3. Trends: which values are moving toward or away from the reference range\n"
        f"4. If any values are flagged below, highlight them prominently\n\n"
    )

    if flagged_tests:
        header += f"FLAGGED (abnormal or worsening): {', '.join(flagged_tests)}\n\n"

    # Build summary table
    table_lines = ["TEST NAME | CURRENT | UNITS | REF RANGE | FLAG | TREND | HISTORY"]
    table_lines.append("-" * 80)
    for entry in trend_table:
        history_str = " → ".join(entry["values"][-4:]) if len(entry["values"]) > 1 else "-"
        direction_str = entry["direction"] or "N/A"
        flag_str = entry["current_flag"] or "NORMAL"
        table_lines.append(
            f"{entry['test_name'][:30]:30s} | "
            f"{entry['current_value'][:8]:8s} | "
            f"{entry['units'][:8]:8s} | "
            f"{entry['ref_range_text'][:12]:12s} | "
            f"{flag_str[:8]:8s} | "
            f"{direction_str[:10]:10s} | "
            f"{history_str}"
        )

    table_text = "\n".join(table_lines)
    full_prompt = header + table_text

    # Hard truncation to max_chars
    if len(full_prompt) > max_chars:
        full_prompt = (
            full_prompt[: max_chars - 80]
            + "\n\n[Data truncated for length. Analyze what is shown above.]"
        )

    return full_prompt


# ---------------------------------------------------------------------------
# T2 synthesis via claude --print
# ---------------------------------------------------------------------------

def run_synthesis(prompt: str, timeout: int = 120) -> str | None:
    """Call claude --print and return the synthesis text, or None on failure."""
    log.info("Calling claude --print (%d chars in prompt)", len(prompt))
    try:
        result = subprocess.run(
            ["claude", "--print", "-p", prompt],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        if result.returncode == 0 and result.stdout.strip():
            synthesis = result.stdout.strip()
            log.info("Synthesis received (%d chars)", len(synthesis))
            return synthesis
        log.warning(
            "claude --print returned code %d: %s",
            result.returncode,
            result.stderr[:200],
        )
    except subprocess.TimeoutExpired:
        log.warning("claude --print timed out (%ds) — posting raw data without synthesis", timeout)
    except FileNotFoundError:
        log.warning("claude CLI not found — posting raw data without synthesis")
    except Exception as exc:
        log.warning("claude --print error: %s — posting raw data without synthesis", exc)
    return None


# ---------------------------------------------------------------------------
# Output construction + capture POST
# ---------------------------------------------------------------------------

def build_capture_content(
    synthesis: str | None,
    trend_table: list[dict],
    report_ids: list[str],
    collection_dates: list[str],
) -> str:
    """Combine synthesis narrative + raw trend table into capture content."""
    date_range = ""
    if collection_dates:
        sorted_dates = sorted(collection_dates)
        date_range = (
            sorted_dates[0]
            if len(sorted_dates) == 1
            else f"{sorted_dates[0]} to {sorted_dates[-1]}"
        )
    parts = [f"Lab Report Trend Analysis — {date_range}", ""]
    if synthesis:
        parts.append(synthesis)
        parts.append("")
    # Append abbreviated raw table
    parts.append("--- Raw Data Summary ---")
    for entry in trend_table:
        flag_str = f" [{entry['current_flag']}]" if entry["current_flag"] else ""
        dir_str = f" ({entry['direction']})" if entry["direction"] else ""
        parts.append(
            f"  {entry['test_name']}: {entry['current_value']} {entry['units']}"
            f"{flag_str}{dir_str}"
        )
    return "\n".join(parts)


# ---------------------------------------------------------------------------
# Main orchestration
# ---------------------------------------------------------------------------

def run(
    conn,
    cfg: dict,
    last_n: int,
    dry_run: bool,
    no_synthesis: bool,
    report_id_filter: str | None,
) -> dict[str, Any]:
    """Core logic — returns result dict suitable for JSON output."""
    synth_cfg = get_synthesis_config(cfg)
    custom_thresholds: dict = {}
    for k, v in (cfg.get("alert_thresholds") or {}).items():
        custom_thresholds[k.lower()] = v
    max_chars: int = synth_cfg.get("max_prompt_chars", 4000)

    # 1. Fetch report IDs
    report_ids = [report_id_filter] if report_id_filter else fetch_recent_report_ids(conn, last_n)

    if not report_ids:
        log.warning("No reports found in lab_results table")
        return {
            "report_count": 0,
            "flagged_tests": [],
            "trend_table": [],
            "synthesis_text": None,
            "capture_posted": False,
            "error": "No reports found",
        }

    # 2. Fetch results for those reports
    results = fetch_results_for_reports(conn, report_ids)

    # 3. Unique collection dates
    all_dates = sorted({r["collection_date"] for r in results})

    # 4. Build trend table (T0)
    trend_table = build_trend_table(results, custom_thresholds)

    # 5. Collect flagged tests
    flagged_tests = collect_flagged_tests(trend_table, custom_thresholds)

    # 6. Build prompt + call claude --print (T2)
    synthesis_text: str | None = None
    if not no_synthesis:
        prompt = build_prompt(trend_table, report_ids, all_dates, flagged_tests, max_chars)
        synthesis_text = run_synthesis(prompt)

    # 7. Build capture content
    content = build_capture_content(synthesis_text, trend_table, report_ids, all_dates)

    # 8. Build source_metadata
    source_metadata: dict[str, Any] = {
        "type": "lab_trend_analysis",
        "report_count": len(report_ids),
        "flagged_tests": flagged_tests,
        "collection_dates": all_dates,
        "has_synthesis": synthesis_text is not None,
    }

    # 9. POST capture (unless dry-run)
    capture_posted = False
    if not dry_run:
        # Inject captures_url from config if set
        captures_url = synth_cfg.get("captures_url")
        if captures_url:
            os.environ.setdefault("CAPTURE_API_URL", captures_url)
        # caller header for rate-limit bypass
        os.environ.setdefault("CAPTURE_API_CALLER", "lab-synthesis")
        capture_posted = post_capture(
            cfg,
            content=content,
            source_metadata=source_metadata,
            capture_type="observation",
            brain_view="personal",
        )

    result: dict[str, Any] = {
        "report_count": len(report_ids),
        "flagged_tests": flagged_tests,
        "trend_table": [
            {
                "test_name": e["test_name"],
                "current_value": e["current_value"],
                "current_flag": e["current_flag"],
                "direction": e["direction"],
                "is_abnormal": e["is_abnormal"],
            }
            for e in trend_table
        ],
        "synthesis_text": synthesis_text,
        "capture_posted": capture_posted,
    }
    return result


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Lab report trend synthesis — T0 trend + T2 Claude CLI → capture POST"
    )
    parser.add_argument(
        "--last",
        type=int,
        default=None,
        metavar="N",
        help="Number of most-recent reports to include (default: synthesis.default_report_window from config)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print JSON output to stdout; do not POST capture",
    )
    parser.add_argument(
        "--no-synthesis",
        action="store_true",
        help="Skip claude --print call; post raw trend data only",
    )
    parser.add_argument(
        "--report-id",
        metavar="ID",
        default=None,
        help="Synthesize a specific report_id vs all prior stored reports",
    )
    parser.add_argument(
        "--config",
        metavar="PATH",
        default=None,
        help="Override config/lab-report.yaml path",
    )
    args = parser.parse_args()

    cfg = load_config(Path(args.config) if args.config else None)
    synth_cfg = get_synthesis_config(cfg)
    last_n = args.last if args.last is not None else synth_cfg.get("default_report_window", 5)

    conn = get_connection()
    try:
        result = run(
            conn=conn,
            cfg=cfg,
            last_n=last_n,
            dry_run=args.dry_run,
            no_synthesis=args.no_synthesis,
            report_id_filter=args.report_id,
        )
    finally:
        conn.close()
        log.debug("DB connection closed")

    if args.dry_run:
        print(json.dumps(result, indent=2, default=str))
    else:
        log.info(
            "Done — %d reports, %d flagged, capture_posted=%s, synthesis=%s",
            result["report_count"],
            len(result["flagged_tests"]),
            result["capture_posted"],
            result["synthesis_text"] is not None,
        )


if __name__ == "__main__":
    main()
