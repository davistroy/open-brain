#!/usr/bin/env python3
"""
Insurance Cross-Policy Gap Analysis for Open Brain — P22b.

Fetches active insurance policies from the Open Brain API, applies T0
deterministic heuristics to detect five gap classes, calls ``claude --print``
(T2 Claude CLI) for narrative synthesis, and POSTs one capture per run.

Cost tier:
  T0 — fetch + normalize + heuristics (Python, no LLM)
  T2 — narrative synthesis (``claude --print``, subscription-only, no API $)
  NO T3 — no direct Anthropic SDK, no OpenAI API calls

Gap classes detected:
  missing_type   — expected policy type absent from active portfolio
  under_coverage — key limits/deductibles below configured thresholds
  over_coverage  — auto rental + umbrella both covering same auto liability
  redundancy     — two active health plans with overlapping effective dates
  expiring_soon  — expiration_date within synthesis.expiry_warning_days

Usage:
  python scripts/insurance-gap-analysis.py
  python scripts/insurance-gap-analysis.py --dry-run
  python scripts/insurance-gap-analysis.py --no-synthesis
  python scripts/insurance-gap-analysis.py --all          # include expired
  python scripts/insurance-gap-analysis.py --config config/insurance.yaml
  python scripts/insurance-gap-analysis.py --watch-dir ~/financial-inbox/insurance/

Environment:
  OPEN_BRAIN_API_URL   — base URL override (e.g. http://core-api:3002)
  CAPTURE_API_URL      — captures endpoint override
  CAPTURE_API_CALLER   — X-Open-Brain-Caller header value (default: insurance-pipeline)
"""

import argparse
import json
import logging
import os
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import date, datetime
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
)
log = logging.getLogger("insurance-gap")

# ---------------------------------------------------------------------------
# Config loading
# ---------------------------------------------------------------------------

_DEFAULT_CONFIG: dict[str, Any] = {
    "api": {"base_url": ""},
    "synthesis": {
        "max_prompt_chars": 5000,
        "expiry_warning_days": 60,
        "captures_url": "",
    },
    "thresholds": {
        "health": {"high_deductible_usd": 5000, "high_oop_max_usd": 10000},
        "home": {"min_dwelling_usd": 200000},
        "auto": {"min_bodily_injury_usd": 100000},
    },
    "expected_policy_types": ["health", "auto", "home", "umbrella"],
}


def _deep_merge(base: dict, override: dict) -> dict:
    """Recursively merge override into base; override wins on scalar conflicts."""
    result = dict(base)
    for k, v in override.items():
        if k in result and isinstance(result[k], dict) and isinstance(v, dict):
            result[k] = _deep_merge(result[k], v)
        else:
            result[k] = v
    return result


def load_config(config_path: str | None = None) -> dict[str, Any]:
    """Load config/insurance.yaml (or override path) merged onto defaults."""
    if config_path is None:
        # Locate relative to this script
        config_path = str(Path(__file__).resolve().parent.parent / "config" / "insurance.yaml")

    cfg = _DEFAULT_CONFIG
    try:
        import yaml  # type: ignore[import]
        with open(config_path) as fh:
            file_cfg = yaml.safe_load(fh) or {}
        cfg = _deep_merge(_DEFAULT_CONFIG, file_cfg)
        log.debug(f"Config loaded from {config_path}")
    except FileNotFoundError:
        log.warning(f"Config file not found at {config_path} — using defaults")
    except ImportError:
        log.warning("pyyaml not installed — using default config")
    except Exception as exc:  # noqa: BLE001
        log.warning(f"Config load error ({exc}) — using defaults")

    return cfg


# ---------------------------------------------------------------------------
# API helpers (T0 Python — urllib.request only, no requests library)
# ---------------------------------------------------------------------------

def _resolve_base_url(cfg: dict) -> str:
    base = (
        os.environ.get("OPEN_BRAIN_API_URL")
        or cfg.get("api", {}).get("base_url")
        or "http://localhost:3002"
    )
    return base.rstrip("/")


def fetch_policies(cfg: dict, active_only: bool = True) -> list[dict]:
    """GET /api/v1/insurance-policies and return the policies list."""
    base_url = _resolve_base_url(cfg)
    active_param = "true" if active_only else "false"
    url = f"{base_url}/api/v1/insurance-policies?active_only={active_param}"
    log.info(f"Fetching policies: {url}")

    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        log.error(f"HTTP {exc.code} fetching policies: {exc.reason}")
        sys.exit(1)
    except urllib.error.URLError as exc:
        log.error(f"Connection error fetching policies: {exc.reason}")
        sys.exit(1)

    policies = body.get("policies", [])
    log.info(f"Fetched {len(policies)} policy records")
    return policies


def post_capture(cfg: dict, content: str, source_metadata: dict, dry_run: bool = False) -> bool:
    """POST a capture to /api/v1/captures.  Returns True on success."""
    if dry_run:
        log.info("[dry-run] Would POST capture (skipped)")
        return True

    captures_url = (
        os.environ.get("CAPTURE_API_URL")
        or cfg.get("synthesis", {}).get("captures_url")
        or (_resolve_base_url(cfg) + "/api/v1/captures")
    )
    caller = os.environ.get("CAPTURE_API_CALLER") or "insurance-pipeline"

    payload = json.dumps({
        "content": content,
        "source": "api",
        "capture_type": "observation",
        "brain_view": "personal",
        "metadata": {"source_metadata": source_metadata},
    }).encode("utf-8")

    req = urllib.request.Request(
        captures_url,
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "X-Open-Brain-Caller": caller,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            if resp.status in (200, 201):
                log.info(f"Capture posted successfully (status {resp.status})")
                return True
            log.error(f"Unexpected status {resp.status} posting capture")
            return False
    except urllib.error.HTTPError as exc:
        log.error(f"HTTP {exc.code} posting capture: {exc.reason}")
        return False
    except urllib.error.URLError as exc:
        log.error(f"Connection error posting capture: {exc.reason}")
        return False


# ---------------------------------------------------------------------------
# T0 Normalization helpers
# ---------------------------------------------------------------------------

def _parse_amount(val: Any) -> float | None:
    """Parse a coverage amount — handles int, float, str like '$100,000'."""
    if val is None:
        return None
    if isinstance(val, (int, float)):
        return float(val)
    if isinstance(val, str):
        cleaned = val.replace("$", "").replace(",", "").strip()
        try:
            return float(cleaned)
        except ValueError:
            return None
    return None


def _parse_date(val: Any) -> date | None:
    """Parse ISO date string or return None."""
    if val is None:
        return None
    if isinstance(val, date):
        return val
    if isinstance(val, str):
        try:
            return date.fromisoformat(val[:10])
        except ValueError:
            return None
    return None


def normalize_policy(policy: dict) -> dict:
    """Extract a flat normalized summary from a raw policy record."""
    coverage = policy.get("coverage") or {}
    deductibles = coverage.get("deductibles") or {}
    limits = coverage.get("limits") or {}

    # Flatten deductibles to {category -> amount_usd}
    deductible_map: dict[str, float] = {}
    if isinstance(deductibles, dict):
        for k, v in deductibles.items():
            parsed = _parse_amount(v)
            if parsed is not None:
                deductible_map[k] = parsed
    elif isinstance(deductibles, list):
        for item in deductibles:
            if isinstance(item, dict):
                k = item.get("category", "deductible")
                parsed = _parse_amount(item.get("amount_usd") or item.get("amount"))
                if parsed is not None:
                    deductible_map[k] = parsed

    # Flatten limits to {category -> amount_usd}
    limit_map: dict[str, float] = {}
    if isinstance(limits, dict):
        for k, v in limits.items():
            parsed = _parse_amount(v)
            if parsed is not None:
                limit_map[k] = parsed
    elif isinstance(limits, list):
        for item in limits:
            if isinstance(item, dict):
                k = item.get("category", "limit")
                parsed = _parse_amount(item.get("amount_usd") or item.get("amount"))
                if parsed is not None:
                    limit_map[k] = parsed

    oop_max = _parse_amount(coverage.get("out_of_pocket_max"))
    co_insurance = coverage.get("co_insurance")
    coverage_types = coverage.get("coverage_types") or []
    if isinstance(coverage_types, str):
        coverage_types = [coverage_types]

    return {
        "id": policy.get("id", ""),
        "policy_number": policy.get("policy_number", ""),
        "provider": policy.get("provider", "unknown"),
        "policy_type": policy.get("policy_type", "unknown"),
        "effective_date": _parse_date(policy.get("effective_date")),
        "expiration_date": _parse_date(policy.get("expiration_date")),
        "insured_name": policy.get("insured_name", ""),
        "deductibles": deductible_map,
        "limits": limit_map,
        "oop_max": oop_max,
        "co_insurance": co_insurance,
        "coverage_types": coverage_types,
    }


# ---------------------------------------------------------------------------
# T0 Gap heuristics — 5 gap classes
# ---------------------------------------------------------------------------

def detect_missing_types(
    normalized: list[dict], expected_types: list[str]
) -> list[dict]:
    """Gap class: missing_type — expected policy type absent from active portfolio."""
    present_types = {p["policy_type"] for p in normalized}
    findings = []
    for ptype in expected_types:
        if ptype not in present_types:
            findings.append({
                "class": "missing_type",
                "policy_type": ptype,
                "description": f"No active {ptype} policy found in portfolio.",
                "severity": "high",
            })
    return findings


def detect_under_coverage(normalized: list[dict], thresholds: dict) -> list[dict]:
    """Gap class: under_coverage — limits/deductibles outside threshold ranges."""
    findings = []
    h_thresh = thresholds.get("health", {})
    home_thresh = thresholds.get("home", {})
    auto_thresh = thresholds.get("auto", {})

    for p in normalized:
        ptype = p["policy_type"]

        if ptype == "health":
            # High deductible check
            high_ded = h_thresh.get("high_deductible_usd", 5000)
            for cat, amt in p["deductibles"].items():
                if amt > high_ded:
                    findings.append({
                        "class": "under_coverage",
                        "policy_type": ptype,
                        "provider": p["provider"],
                        "description": (
                            f"Health deductible '{cat}' is ${amt:,.0f}, "
                            f"exceeding high-deductible threshold of ${high_ded:,.0f}."
                        ),
                        "severity": "medium",
                    })
            # High OOP max check
            if p["oop_max"] is not None:
                high_oop = h_thresh.get("high_oop_max_usd", 10000)
                if p["oop_max"] > high_oop:
                    findings.append({
                        "class": "under_coverage",
                        "policy_type": ptype,
                        "provider": p["provider"],
                        "description": (
                            f"Health out-of-pocket maximum is ${p['oop_max']:,.0f}, "
                            f"exceeding threshold of ${high_oop:,.0f}."
                        ),
                        "severity": "medium",
                    })

        elif ptype == "home":
            min_dwelling = home_thresh.get("min_dwelling_usd", 200000)
            # Check all limit keys that look like dwelling
            for cat, amt in p["limits"].items():
                if "dwelling" in cat.lower():
                    if amt < min_dwelling:
                        findings.append({
                            "class": "under_coverage",
                            "policy_type": ptype,
                            "provider": p["provider"],
                            "description": (
                                f"Home dwelling limit '{cat}' is ${amt:,.0f}, "
                                f"below minimum threshold of ${min_dwelling:,.0f}."
                            ),
                            "severity": "high",
                        })

        elif ptype == "auto":
            min_bi = auto_thresh.get("min_bodily_injury_usd", 100000)
            for cat, amt in p["limits"].items():
                if "bodily_injury" in cat.lower() or "bodily injury" in cat.lower():
                    if amt < min_bi:
                        findings.append({
                            "class": "under_coverage",
                            "policy_type": ptype,
                            "provider": p["provider"],
                            "description": (
                                f"Auto bodily injury limit '{cat}' is ${amt:,.0f}, "
                                f"below minimum threshold of ${min_bi:,.0f}."
                            ),
                            "severity": "high",
                        })

    return findings


def detect_over_coverage(normalized: list[dict]) -> list[dict]:
    """Gap class: over_coverage — both auto rental reimbursement AND umbrella active."""
    findings = []
    has_umbrella = any(p["policy_type"] == "umbrella" for p in normalized)
    auto_policies = [p for p in normalized if p["policy_type"] == "auto"]

    if has_umbrella:
        for p in auto_policies:
            # Check if auto policy has rental reimbursement in coverage_types
            has_rental = any(
                "rental" in ct.lower()
                for ct in p.get("coverage_types", [])
            )
            # Also check limit keys
            if not has_rental:
                has_rental = any(
                    "rental" in k.lower() for k in p["limits"]
                )
            if has_rental:
                findings.append({
                    "class": "over_coverage",
                    "policy_type": "auto",
                    "provider": p["provider"],
                    "description": (
                        "Auto policy includes rental reimbursement while an umbrella "
                        "policy is also active — umbrella may already provide redundant "
                        "auto liability coverage; evaluate whether rental rider is needed."
                    ),
                    "severity": "low",
                })

    return findings


def detect_redundancy(normalized: list[dict]) -> list[dict]:
    """Gap class: redundancy — two active health policies with overlapping dates."""
    findings = []
    health_policies = [p for p in normalized if p["policy_type"] == "health"]

    if len(health_policies) < 2:
        return findings

    for i in range(len(health_policies)):
        for j in range(i + 1, len(health_policies)):
            pa = health_policies[i]
            pb = health_policies[j]
            # Check date overlap: if neither policy's effective date is after
            # the other's expiration date (or expiration is None), they overlap.
            a_eff = pa["effective_date"] or date.min
            a_exp = pa["expiration_date"] or date.max
            b_eff = pb["effective_date"] or date.min
            b_exp = pb["expiration_date"] or date.max

            overlaps = a_eff <= b_exp and b_eff <= a_exp
            if overlaps:
                findings.append({
                    "class": "redundancy",
                    "policy_type": "health",
                    "providers": [pa["provider"], pb["provider"]],
                    "description": (
                        f"Two active health policies detected with overlapping effective "
                        f"dates: {pa['provider']} and {pb['provider']}. "
                        "Verify that dual coverage is intentional (e.g., spouse plan)."
                    ),
                    "severity": "medium",
                })

    return findings


def detect_expiring_soon(normalized: list[dict], warning_days: int) -> list[dict]:
    """Gap class: expiring_soon — expiration_date within warning_days of today."""
    today = date.today()
    expiring = []
    for p in normalized:
        exp = p["expiration_date"]
        if exp is None:
            continue
        delta = (exp - today).days
        if 0 <= delta <= warning_days:
            expiring.append({
                "policy_type": p["policy_type"],
                "provider": p["provider"],
                "expiration_date": exp.isoformat(),
                "days_remaining": delta,
            })
    return expiring


def run_gap_heuristics(normalized: list[dict], cfg: dict) -> dict:
    """Run all T0 heuristics and return structured gap findings."""
    expected_types = cfg.get("expected_policy_types", ["health", "auto", "home", "umbrella"])
    thresholds = cfg.get("thresholds", {})
    warning_days = cfg.get("synthesis", {}).get("expiry_warning_days", 60)

    gap_findings: list[dict] = []
    gap_findings.extend(detect_missing_types(normalized, expected_types))
    gap_findings.extend(detect_under_coverage(normalized, thresholds))
    gap_findings.extend(detect_over_coverage(normalized))
    gap_findings.extend(detect_redundancy(normalized))

    expiring_soon = detect_expiring_soon(normalized, warning_days)

    return {
        "gap_findings": gap_findings,
        "expiring_soon": expiring_soon,
    }


# ---------------------------------------------------------------------------
# T2 Synthesis — claude --print
# ---------------------------------------------------------------------------

def build_synthesis_prompt(normalized: list[dict], gaps: dict, cfg: dict) -> str:
    """Build the aggregate prompt for claude --print."""
    lines: list[str] = []

    lines.append("You are reviewing an insurance portfolio for a single household.")
    lines.append("Below is the current active policy inventory and gap analysis findings.")
    lines.append("Synthesize a concise annual insurance review memo (under 1000 words) covering:")
    lines.append("  1. Under-coverage risks and recommended actions")
    lines.append("  2. Redundancy or over-coverage savings opportunities")
    lines.append("  3. Renewal priority items for the next 60 days")
    lines.append("  4. Missing coverage recommendations")
    lines.append("")

    # Policy inventory table
    lines.append("## Active Policy Inventory")
    lines.append("")
    lines.append("| Provider | Type | Effective | Expiration | Key Limits |")
    lines.append("|----------|------|-----------|------------|------------|")
    for p in normalized:
        key_limits = "; ".join(
            f"{k}: ${v:,.0f}" for k, v in list(p["limits"].items())[:3]
        )
        eff = p["effective_date"].isoformat() if p["effective_date"] else "—"
        exp = p["expiration_date"].isoformat() if p["expiration_date"] else "—"
        lines.append(
            f"| {p['provider']} | {p['policy_type']} | {eff} | {exp} | {key_limits or '—'} |"
        )
    lines.append("")

    # Gap findings
    if gaps["gap_findings"]:
        lines.append("## Gap Analysis Findings")
        lines.append("")
        for f in gaps["gap_findings"]:
            severity = f.get("severity", "medium").upper()
            lines.append(f"- [{severity}] {f['class']}: {f['description']}")
        lines.append("")
    else:
        lines.append("## Gap Analysis Findings")
        lines.append("")
        lines.append("No significant gaps detected by automated heuristics.")
        lines.append("")

    # Expiring soon
    if gaps["expiring_soon"]:
        lines.append("## Expiring Soon")
        lines.append("")
        for e in gaps["expiring_soon"]:
            lines.append(
                f"- {e['provider']} ({e['policy_type']}) expires {e['expiration_date']} "
                f"({e['days_remaining']} days)"
            )
        lines.append("")

    prompt = "\n".join(lines)

    max_chars = cfg.get("synthesis", {}).get("max_prompt_chars", 5000)
    if len(prompt) > max_chars:
        prompt = prompt[:max_chars - 60] + "\n\n[Data truncated for length. Analyze what is shown above.]"

    return prompt


def call_claude_cli(prompt: str) -> str | None:
    """Call ``claude --print`` for T2 synthesis.  Returns synthesis text or None."""
    try:
        result = subprocess.run(
            ["claude", "--print", "-p", prompt],
            capture_output=True,
            text=True,
            timeout=120,
        )
        if result.returncode == 0 and result.stdout.strip():
            synthesis = result.stdout.strip()
            log.info(f"Claude synthesis received ({len(synthesis)} chars)")
            return synthesis
        else:
            log.warning(
                f"Claude CLI returned code {result.returncode}: "
                f"{result.stderr[:200] if result.stderr else '(no stderr)'}"
            )
            return None
    except subprocess.TimeoutExpired:
        log.warning("Claude CLI timed out (120s) — posting raw gap data without synthesis")
        return None
    except FileNotFoundError:
        log.warning("Claude CLI not found in PATH — posting raw gap data without synthesis")
        return None
    except Exception as exc:  # noqa: BLE001
        log.warning(f"Claude CLI error: {exc} — posting raw gap data without synthesis")
        return None


# ---------------------------------------------------------------------------
# Capture content builder
# ---------------------------------------------------------------------------

def build_capture_content(
    normalized: list[dict],
    gaps: dict,
    synthesis: str | None,
    run_date: str,
) -> str:
    parts: list[str] = [f"Insurance Portfolio Gap Analysis — {run_date}", ""]

    if synthesis:
        parts.append(synthesis)
    else:
        parts.append("## Policy Summary")
        parts.append("")
        for p in normalized:
            eff = p["effective_date"].isoformat() if p["effective_date"] else "unknown"
            exp = p["expiration_date"].isoformat() if p["expiration_date"] else "ongoing"
            parts.append(f"- {p['provider']} ({p['policy_type']}): {eff} – {exp}")
        parts.append("")

    if gaps["gap_findings"]:
        parts.append("")
        parts.append("## Detected Gaps")
        parts.append("")
        for f in gaps["gap_findings"]:
            parts.append(f"- [{f.get('severity', 'medium').upper()}] {f['description']}")

    if gaps["expiring_soon"]:
        parts.append("")
        parts.append("## Expiring Soon")
        parts.append("")
        for e in gaps["expiring_soon"]:
            parts.append(
                f"- {e['provider']} ({e['policy_type']}) expires {e['expiration_date']} "
                f"({e['days_remaining']} days)"
            )

    return "\n".join(parts)


# ---------------------------------------------------------------------------
# Watch-dir (optional — requires watchdog)
# ---------------------------------------------------------------------------

def _run_watch_dir(watch_dir: str, cfg: dict, args: argparse.Namespace) -> None:
    """Watch a directory for new PDFs and re-run gap analysis on each arrival."""
    try:
        from watchdog.observers import Observer  # type: ignore[import]
        from watchdog.events import FileSystemEventHandler, FileCreatedEvent  # type: ignore[import]
    except ImportError:
        log.error(
            "watchdog package not installed.  Install with: pip install watchdog\n"
            "  Or add to requirements-insurance.txt and reinstall."
        )
        sys.exit(1)

    scripts_dir = Path(__file__).resolve().parent
    extract_script = scripts_dir / "insurance-policy-extract.py"

    class _Handler(FileSystemEventHandler):
        def on_created(self, event: Any) -> None:
            if not isinstance(event, FileCreatedEvent):
                return
            path = Path(event.src_path)
            if path.suffix.lower() != ".pdf":
                return
            log.info(f"New PDF detected: {path}")
            result = subprocess.run(
                [sys.executable, str(extract_script), "--file", str(path)],
                capture_output=False,
            )
            if result.returncode == 0:
                log.info(f"Extracted {path.name}; re-running gap analysis")
                run_gap_analysis(cfg, args)
            else:
                log.error(f"Extraction failed for {path.name} (code {result.returncode})")

    observer = Observer()
    observer.schedule(_Handler(), watch_dir, recursive=False)
    observer.start()
    log.info(f"Watching {watch_dir} for new PDFs (Ctrl+C to stop)")
    try:
        import time
        while True:
            time.sleep(5)
    except KeyboardInterrupt:
        observer.stop()
    observer.join()


# ---------------------------------------------------------------------------
# Main pipeline
# ---------------------------------------------------------------------------

def run_gap_analysis(cfg: dict, args: argparse.Namespace) -> dict:
    """Execute the full gap analysis pipeline.  Returns result dict."""
    active_only = not getattr(args, "all", False)
    dry_run = getattr(args, "dry_run", False)
    no_synthesis = getattr(args, "no_synthesis", False)

    # Step 1: fetch policies (T0)
    raw_policies = fetch_policies(cfg, active_only=active_only)
    log.info(f"Processing {len(raw_policies)} policies")

    # Step 2: normalize coverage tree (T0)
    normalized = [normalize_policy(p) for p in raw_policies]

    # Step 3: T0 gap heuristics
    gaps = run_gap_heuristics(normalized, cfg)
    log.info(
        f"Gap heuristics complete: {len(gaps['gap_findings'])} findings, "
        f"{len(gaps['expiring_soon'])} expiring soon"
    )

    # Step 4 + 5: build prompt and call claude --print (T2)
    synthesis: str | None = None
    if not no_synthesis and normalized:
        prompt = build_synthesis_prompt(normalized, gaps, cfg)
        log.info(f"Synthesis prompt: {len(prompt)} chars")
        synthesis = call_claude_cli(prompt)

    # Step 6: build capture content
    run_date = datetime.utcnow().strftime("%Y-%m-%d")
    content = build_capture_content(normalized, gaps, synthesis, run_date)

    policy_types_covered = sorted({p["policy_type"] for p in normalized})
    expected_types = cfg.get("expected_policy_types", ["health", "auto", "home", "umbrella"])
    missing_types = sorted(set(expected_types) - set(policy_types_covered))

    source_metadata = {
        "type": "insurance_gap_analysis",
        "policy_count": len(normalized),
        "policy_types_covered": policy_types_covered,
        "missing_types": missing_types,
        "gap_findings": gaps["gap_findings"],
        "expiring_soon": gaps["expiring_soon"],
        "has_synthesis": synthesis is not None,
        "run_date": run_date,
    }

    result = {
        "policy_count": len(normalized),
        "missing_types": missing_types,
        "gap_findings": gaps["gap_findings"],
        "expiring_soon": gaps["expiring_soon"],
        "synthesis_text": synthesis,
        "content_preview": content[:200],
    }

    if dry_run:
        print(json.dumps(result, indent=2, default=str))
        log.info("[dry-run] No capture posted")
    else:
        success = post_capture(cfg, content, source_metadata)
        if not success:
            log.error("Failed to post capture — check API connectivity")
            sys.exit(1)
        log.info("Gap analysis capture posted successfully")

    return result


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Insurance cross-policy gap analysis for Open Brain (P22b)."
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Print JSON result to stdout; do not POST capture.",
    )
    p.add_argument(
        "--all",
        action="store_true",
        help="Include expired policies (default: active only).",
    )
    p.add_argument(
        "--config",
        default=None,
        metavar="PATH",
        help="Path to insurance.yaml config (default: config/insurance.yaml).",
    )
    p.add_argument(
        "--no-synthesis",
        action="store_true",
        help="Skip claude --print synthesis step; post raw gap findings only.",
    )
    p.add_argument(
        "--watch-dir",
        default=None,
        metavar="DIR",
        help=(
            "Watch DIR for new PDFs; extract then re-run gap analysis on each arrival. "
            "Requires: pip install watchdog"
        ),
    )
    return p


def main() -> None:
    parser = build_arg_parser()
    args = parser.parse_args()

    cfg = load_config(args.config)

    if args.watch_dir:
        _run_watch_dir(args.watch_dir, cfg, args)
    else:
        run_gap_analysis(cfg, args)


if __name__ == "__main__":
    main()
