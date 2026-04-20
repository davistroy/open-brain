#!/usr/bin/env python3
"""
Insurance Policy PDF Extraction for Open Brain.

Reads insurance policy PDFs and writes structured coverage JSONB to the
insurance_policies table via direct psycopg2 connection.

Cost tier: T0 (Python/pdfplumber/regex — zero LLM calls).

Supports: health, auto, home, umbrella policies.

Usage:
    python insurance-policy-extract.py --file policy.pdf
    python insurance-policy-extract.py --file policy.pdf --dry-run
    python insurance-policy-extract.py --file policy.pdf --policy-type health --provider "Blue Cross"
    python insurance-policy-extract.py --dir ~/financial-inbox/insurance/
    python insurance-policy-extract.py --dir ~/financial-inbox/insurance/ --dry-run
    python insurance-policy-extract.py --status
    python insurance-policy-extract.py --list

Environment:
    OPEN_BRAIN_DATABASE_URL  — PostgreSQL connection string (required for DB writes)
                               e.g. postgresql://openbrain:pass@localhost:5432/openbrain
                               Falls back to POSTGRES_URL if not set.
"""

import argparse
import json
import logging
import os
import re
import sys
from datetime import date
from pathlib import Path

# -----------------------------------------------------------------------
# Logging
# -----------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
)
log = logging.getLogger("insurance-extract")

# -----------------------------------------------------------------------
# Policy type detection — T0 keyword matching
# -----------------------------------------------------------------------
POLICY_TYPE_KEYWORDS: dict[str, list[str]] = {
    "health": [
        "health insurance",
        "medical benefits",
        "prescription drug",
        "health plan",
        "medical plan",
        "hospitalization",
        "out-of-pocket maximum",
        "out of pocket maximum",
        "copayment",
        "co-payment",
        "coinsurance",
        "co-insurance",
        "in-network",
        "out-of-network",
        "formulary",
        "explanation of benefits",
    ],
    "auto": [
        "auto insurance",
        "automobile insurance",
        "vehicle insurance",
        "collision coverage",
        "comprehensive coverage",
        "bodily injury liability",
        "property damage liability",
        "uninsured motorist",
        "underinsured motorist",
        "personal injury protection",
        "medical payments coverage",
        "rental reimbursement",
        "roadside assistance",
        "policy declarations",
        "covered auto",
    ],
    "home": [
        "homeowners",
        "homeowner's",
        "dwelling coverage",
        "renters insurance",
        "renter's insurance",
        "property damage",
        "personal property",
        "liability coverage",
        "additional living expenses",
        "loss of use",
        "ho-3",
        "ho3",
        "dwelling",
        "other structures",
        "medical payments to others",
    ],
    "umbrella": [
        "umbrella",
        "excess liability",
        "umbrella liability",
        "umbrella policy",
        "personal umbrella",
        "commercial umbrella",
        "excess coverage",
    ],
}


def detect_policy_type(text: str) -> str | None:
    """Detect policy type from text using keyword matching. Returns None if ambiguous."""
    text_lower = text.lower()
    scores: dict[str, int] = {}
    for ptype, keywords in POLICY_TYPE_KEYWORDS.items():
        count = sum(1 for kw in keywords if kw in text_lower)
        if count > 0:
            scores[ptype] = count
    if not scores:
        return None
    # Return the type with the most keyword hits
    return max(scores, key=lambda k: scores[k])


# -----------------------------------------------------------------------
# Dollar amount extraction helpers
# -----------------------------------------------------------------------
_DOLLAR_RE = re.compile(r"\$\s*([\d,]+(?:\.\d{1,2})?)")
_PERCENT_RE = re.compile(r"(\d{1,3})\s*%")
_DATE_RE = re.compile(
    r"(?:"
    r"(\d{1,2})[/\-](\d{1,2})[/\-](\d{2,4})"  # MM/DD/YYYY or M-D-YY
    r"|"
    r"(\d{4})[/\-](\d{1,2})[/\-](\d{1,2})"  # YYYY-MM-DD
    r")"
)


def _parse_dollar(match: re.Match) -> int:
    """Extract integer dollar amount from regex match (strips cents and commas)."""
    raw = match.group(1).replace(",", "")
    try:
        return int(float(raw))
    except ValueError:
        return 0


def _nearby_text(lines: list[str], idx: int, window: int = 3) -> str:
    """Return text from lines within ±window of idx, joined."""
    start = max(0, idx - window)
    end = min(len(lines), idx + window + 1)
    return " ".join(lines[start:end]).lower()


def _extract_first_dollar_near(
    lines: list[str],
    keywords: list[str],
    window: int = 3,
    forward_only: bool = False,
) -> int | None:
    """
    Find first dollar amount near any line containing a keyword.

    Search strategy (line-first to avoid window bleed between adjacent rows):
    1. Check the matching line itself first (highest signal).
    2. Forward lines only (lines[i+1..i+window]).
    3. If forward_only is False, also check backward lines as last resort.
    """
    for i, line in enumerate(lines):
        line_lower = line.lower()
        if any(kw in line_lower for kw in keywords):
            # 1. Try the keyword line itself
            m = _DOLLAR_RE.search(line)
            if m:
                return _parse_dollar(m)
            # 2. Try forward window
            fwd_end = min(len(lines), i + window + 1)
            for j in range(i + 1, fwd_end):
                m = _DOLLAR_RE.search(lines[j])
                if m:
                    return _parse_dollar(m)
            # 3. Try backward window (if allowed)
            if not forward_only:
                bwd_start = max(0, i - window)
                for j in range(bwd_start, i):
                    m = _DOLLAR_RE.search(lines[j])
                    if m:
                        return _parse_dollar(m)
    return None


def _extract_all_dollar_amounts_near(
    lines: list[str], keywords: list[str], window: int = 3
) -> list[int]:
    """Return all dollar amounts in nearby lines of keyword lines (deduped)."""
    seen: set[int] = set()
    results: list[int] = []
    for i, line in enumerate(lines):
        line_lower = line.lower()
        if any(kw in line_lower for kw in keywords):
            nearby = _nearby_text(lines, i, window)
            for m in _DOLLAR_RE.finditer(nearby):
                amt = _parse_dollar(m)
                if amt > 0 and amt not in seen:
                    seen.add(amt)
                    results.append(amt)
    return results


def _extract_date_from_line(line: str) -> date | None:
    """Try to parse a date from a single line. Returns None if no date found."""
    m = _DATE_RE.search(line)
    if not m:
        return None
    try:
        if m.group(1):  # MM/DD/YYYY
            mo, dy, yr = int(m.group(1)), int(m.group(2)), int(m.group(3))
            if yr < 100:
                yr += 2000
            return date(yr, mo, dy)
        else:  # YYYY-MM-DD
            yr, mo, dy = int(m.group(4)), int(m.group(5)), int(m.group(6))
            return date(yr, mo, dy)
    except ValueError:
        return None


def _extract_date_near(lines: list[str], keywords: list[str], window: int = 2) -> date | None:
    """
    Find first parseable date within ±window lines of keyword lines.

    Priority: keyword line itself, then forward window, then backward window.
    """
    for i, line in enumerate(lines):
        line_lower = line.lower()
        if any(kw in line_lower for kw in keywords):
            # Check the matching line first
            d = _extract_date_from_line(line)
            if d:
                return d
            # Forward window
            fwd_end = min(len(lines), i + window + 1)
            for j in range(i + 1, fwd_end):
                d = _extract_date_from_line(lines[j])
                if d:
                    return d
            # Backward window
            bwd_start = max(0, i - window)
            for j in range(bwd_start, i):
                d = _extract_date_from_line(lines[j])
                if d:
                    return d
    return None


def _extract_percent_near(lines: list[str], keywords: list[str], window: int = 3) -> int | None:
    """Find first percentage within ±window lines of keyword lines."""
    for i, line in enumerate(lines):
        line_lower = line.lower()
        if any(kw in line_lower for kw in keywords):
            nearby = _nearby_text(lines, i, window)
            m = _PERCENT_RE.search(nearby)
            if m:
                try:
                    val = int(m.group(1))
                    if 0 <= val <= 100:
                        return val
                except ValueError:
                    continue
    return None


# -----------------------------------------------------------------------
# Policy-specific extraction
# -----------------------------------------------------------------------


def _extract_health_coverage(lines: list[str]) -> dict:
    """Extract health insurance coverage elements."""
    coverage: dict = {
        "deductibles": [],
        "out_of_pocket_max": [],
        "co_insurance": None,
        "co_pays": [],
        "coverage_types": ["hospitalization", "emergency", "preventive"],
        "exclusions": [],
        "notes": [],
    }

    # Deductibles: individual and family (line-first search prevents window bleed)
    indiv_ded = _extract_first_dollar_near(
        lines, ["individual deductible", "single deductible"], window=2
    )
    family_ded = _extract_first_dollar_near(
        lines, ["family deductible", "aggregate deductible"], window=2
    )
    if indiv_ded:
        coverage["deductibles"].append(
            {"category": "individual", "amount_usd": indiv_ded, "applies_to": "medical"}
        )
    if family_ded:
        coverage["deductibles"].append(
            {"category": "family", "amount_usd": family_ded, "applies_to": "medical"}
        )
    # Fallback: generic "deductible" line (only if no specific ones found)
    if not coverage["deductibles"]:
        amt = _extract_first_dollar_near(lines, ["deductible"], window=2)
        if amt:
            coverage["deductibles"].append(
                {"category": "individual", "amount_usd": amt, "applies_to": "medical"}
            )

    # Out-of-pocket max (individual and family)
    indiv_oop = _extract_first_dollar_near(
        lines,
        [
            "individual out-of-pocket",
            "individual out of pocket",
            "individual out-of-pocket maximum",
            "individual out of pocket maximum",
        ],
        window=2,
    )
    if not indiv_oop:
        # Broader fallback: first OOP maximum mention (usually individual)
        indiv_oop = _extract_first_dollar_near(
            lines,
            ["out-of-pocket maximum", "out of pocket maximum", "oop max", "out-of-pocket max"],
            window=2,
        )
    if indiv_oop:
        coverage["out_of_pocket_max"].append({"category": "individual", "amount_usd": indiv_oop})

    family_oop = _extract_first_dollar_near(
        lines,
        [
            "family out-of-pocket",
            "family out of pocket",
            "family out-of-pocket maximum",
            "family out of pocket maximum",
        ],
        window=2,
    )
    if family_oop:
        coverage["out_of_pocket_max"].append({"category": "family", "amount_usd": family_oop})

    # Co-insurance — find the plan's percentage (what the plan pays), not the patient's.
    # Fixture pattern: "Co-Insurance: 80/20 after deductible" or "plan pays 80%"
    co_ins_pct: int | None = None
    for i, line in enumerate(lines):
        ll = line.lower()
        if any(kw in ll for kw in ["coinsurance", "co-insurance", "co insurance"]):
            nearby = _nearby_text(lines, i, 3)
            # Look for "plan pays X%" pattern
            plan_pays_m = re.search(r"plan pays\s+(\d{1,3})\s*%", nearby, re.IGNORECASE)
            if plan_pays_m:
                co_ins_pct = int(plan_pays_m.group(1))
                break
            # Look for "X/Y" coinsurance split (plan/patient); take larger = plan portion
            split_m = re.search(r"(\d{1,3})\s*/\s*(\d{1,3})", nearby)
            if split_m:
                a, b = int(split_m.group(1)), int(split_m.group(2))
                co_ins_pct = max(a, b)
                break
            # Fallback: find the highest percentage >= 50% (plan pays more than patient)
            all_pcts = [
                int(m.group(1))
                for m in _PERCENT_RE.finditer(nearby)
                if 50 <= int(m.group(1)) <= 100
            ]
            if all_pcts:
                co_ins_pct = max(all_pcts)
                break
            # Last resort: any percentage
            m = _PERCENT_RE.search(nearby)
            if m:
                co_ins_pct = int(m.group(1))
                break
    if co_ins_pct:
        coverage["co_insurance"] = {"percentage": co_ins_pct, "after_deductible": True}

    # Co-pays: line-by-line scan — each copay service line contains its own dollar amount.
    # Line-first approach avoids window bleed between adjacent copay rows.
    service_map = {
        "primary care": "primary_care_visit",
        "primary care visit": "primary_care_visit",
        "pcp visit": "primary_care_visit",
        "specialist": "specialist_visit",
        "specialist visit": "specialist_visit",
        "emergency room": "emergency_room",
        "emergency department": "emergency_room",
        "urgent care": "urgent_care",
        "hospitalization": "hospitalization",
        "inpatient": "inpatient_stay",
        "outpatient": "outpatient_visit",
        "mental health": "mental_health_visit",
        "preventive": "preventive_care",
        "lab work": "lab_work",
        "x-ray": "imaging",
        "imaging": "imaging",
        "prescription": "prescription_generic",
        "generic drug": "prescription_generic",
        "brand drug": "prescription_brand",
    }
    copay_trigger = re.compile(r"copay|co-pay|co pay", re.IGNORECASE)
    line_index = {line: i for i, line in enumerate(lines)}
    for line in lines:
        line_lower = line.lower()
        has_copay_kw = bool(copay_trigger.search(line_lower))
        dollar_m = _DOLLAR_RE.search(line)
        if not dollar_m:
            continue
        amt = _parse_dollar(dollar_m)
        if amt == 0:
            continue
        for svc_kw, svc_name in service_map.items():
            if svc_kw in line_lower:
                if not has_copay_kw:
                    idx = line_index.get(line, -1)
                    if idx == -1:
                        continue
                    ctx = _nearby_text(lines, idx, 1)
                    if not copay_trigger.search(ctx):
                        continue
                if not any(cp["service"] == svc_name for cp in coverage["co_pays"]):
                    coverage["co_pays"].append({"service": svc_name, "amount_usd": amt})
                break

    # Exclusions: look for exclusion section
    in_exclusions = False
    for line in lines:
        ll = line.lower()
        if any(
            kw in ll for kw in ["exclusion", "not covered", "what is not covered", "does not cover"]
        ):
            in_exclusions = True
        if in_exclusions:
            stripped = line.strip().lstrip("•-* ")
            if stripped and len(stripped) > 3 and len(stripped) < 120:
                if not any(kw in stripped.lower() for kw in ["exclusion", "not covered"]):
                    coverage["exclusions"].append(stripped)
            if len(coverage["exclusions"]) >= 10:
                break

    return coverage


def _extract_auto_coverage(lines: list[str]) -> dict:
    """Extract auto insurance coverage elements."""
    coverage: dict = {
        "deductibles": [],
        "limits": [],
        "coverage_types": [],
        "exclusions": [],
        "notes": [],
    }

    # Collision deductible
    col_ded = _extract_first_dollar_near(lines, ["collision deductible"], window=2)
    if col_ded:
        coverage["deductibles"].append({"category": "collision", "amount_usd": col_ded})

    # Comprehensive deductible
    comp_ded = _extract_first_dollar_near(lines, ["comprehensive deductible"], window=2)
    if comp_ded:
        coverage["deductibles"].append({"category": "comprehensive", "amount_usd": comp_ded})

    # Liability limits
    liab_amt = _extract_first_dollar_near(
        lines, ["bodily injury liability limit", "bodily injury limit", "bi limit"], window=2
    )
    if not liab_amt:
        liab_amt = _extract_first_dollar_near(
            lines, ["bodily injury", "liability limit", "per person"], window=2
        )
    if liab_amt:
        coverage["limits"].append(
            {"category": "bodily_injury", "amount_usd": liab_amt, "per": "person"}
        )

    prop_amt = _extract_first_dollar_near(
        lines, ["property damage liability limit", "property damage limit", "pd limit"], window=2
    )
    if not prop_amt:
        prop_amt = _extract_first_dollar_near(
            lines, ["property damage liability", "property damage"], window=2
        )
    if prop_amt:
        coverage["limits"].append(
            {"category": "property_damage", "amount_usd": prop_amt, "per": "occurrence"}
        )

    # Uninsured motorist
    um_amt = _extract_first_dollar_near(
        lines, ["uninsured motorist", "underinsured motorist", "um/uim", "um limit"], window=2
    )
    if um_amt:
        coverage["limits"].append(
            {"category": "uninsured_motorist", "amount_usd": um_amt, "per": "person"}
        )

    # Medical payments
    medpay = _extract_first_dollar_near(
        lines, ["medical payments", "medpay", "pip", "personal injury protection"], window=2
    )
    if medpay:
        coverage["limits"].append(
            {"category": "medical_payments", "amount_usd": medpay, "per": "person"}
        )

    # Rental reimbursement
    rental_amt = _extract_first_dollar_near(
        lines, ["rental reimbursement", "rental car", "transportation expense"], window=2
    )
    if rental_amt:
        coverage["limits"].append(
            {"category": "rental_reimbursement", "amount_usd": rental_amt, "per": "day"}
        )

    # Coverage types
    cov_keywords = {
        "liability": "liability",
        "collision": "collision",
        "comprehensive": "comprehensive",
        "uninsured motorist": "uninsured_motorist",
        "underinsured motorist": "underinsured_motorist",
        "medical payments": "medical_payments",
        "personal injury protection": "personal_injury_protection",
        "rental reimbursement": "rental_reimbursement",
        "roadside assistance": "roadside_assistance",
        "towing": "towing",
        "gap coverage": "gap_coverage",
    }
    text_lower = "\n".join(lines).lower()
    for kw, ctype in cov_keywords.items():
        if kw in text_lower and ctype not in coverage["coverage_types"]:
            coverage["coverage_types"].append(ctype)

    return coverage


def _extract_home_coverage(lines: list[str]) -> dict:
    """Extract homeowners insurance coverage elements."""
    coverage: dict = {
        "deductibles": [],
        "limits": [],
        "coverage_types": [],
        "exclusions": [],
        "notes": [],
    }

    # Deductible — look for specific deductible label lines
    ded = _extract_first_dollar_near(
        lines, ["all-peril deductible", "all peril deductible", "deductible:"], window=2
    )
    if not ded:
        ded = _extract_first_dollar_near(lines, ["deductible"], window=2)
    if ded:
        coverage["deductibles"].append({"category": "all_perils", "amount_usd": ded})

    # Dwelling limit (Coverage A)
    dwelling = _extract_first_dollar_near(
        lines, ["coverage a - dwelling", "dwelling limit", "coverage a:"], window=2
    )
    if not dwelling:
        dwelling = _extract_first_dollar_near(lines, ["dwelling", "coverage a"], window=2)
    if dwelling:
        coverage["limits"].append(
            {"category": "dwelling", "amount_usd": dwelling, "per": "occurrence"}
        )

    # Other structures (Coverage B)
    other_struct = _extract_first_dollar_near(
        lines, ["other structures limit", "coverage b - other", "coverage b:"], window=2
    )
    if not other_struct:
        other_struct = _extract_first_dollar_near(
            lines, ["other structures", "coverage b"], window=2
        )
    if other_struct:
        coverage["limits"].append(
            {"category": "other_structures", "amount_usd": other_struct, "per": "occurrence"}
        )

    # Personal property (Coverage C)
    personal_prop = _extract_first_dollar_near(
        lines, ["personal property limit", "coverage c - personal", "coverage c:"], window=2
    )
    if not personal_prop:
        personal_prop = _extract_first_dollar_near(
            lines, ["personal property", "coverage c"], window=2
        )
    if personal_prop:
        coverage["limits"].append(
            {"category": "personal_property", "amount_usd": personal_prop, "per": "occurrence"}
        )

    # Loss of use / additional living expenses (Coverage D)
    loss_use = _extract_first_dollar_near(
        lines,
        ["loss of use limit", "coverage d - loss", "additional living expenses limit"],
        window=2,
    )
    if not loss_use:
        loss_use = _extract_first_dollar_near(
            lines, ["loss of use", "coverage d", "additional living expenses"], window=2
        )
    if loss_use:
        coverage["limits"].append(
            {"category": "loss_of_use", "amount_usd": loss_use, "per": "occurrence"}
        )

    # Liability (Coverage E)
    liability = _extract_first_dollar_near(
        lines, ["personal liability limit", "coverage e - personal", "coverage e:"], window=2
    )
    if not liability:
        liability = _extract_first_dollar_near(
            lines, ["personal liability", "coverage e", "liability limit"], window=2
        )
    if liability:
        coverage["limits"].append(
            {"category": "liability", "amount_usd": liability, "per": "occurrence"}
        )

    # Medical payments (Coverage F)
    medpay = _extract_first_dollar_near(
        lines, ["medical payments limit", "coverage f - medical", "coverage f:"], window=2
    )
    if not medpay:
        medpay = _extract_first_dollar_near(
            lines, ["medical payments to others", "coverage f", "medical payments"], window=2
        )
    if medpay:
        coverage["limits"].append(
            {"category": "medical_payments", "amount_usd": medpay, "per": "person"}
        )

    # Coverage types
    text_lower = "\n".join(lines).lower()
    for kw, ctype in [
        ("fire", "fire"),
        ("theft", "theft"),
        ("windstorm", "windstorm"),
        ("hail", "hail"),
        ("water damage", "water_damage"),
        ("liability", "liability"),
        ("personal property", "personal_property"),
        ("loss of use", "loss_of_use"),
    ]:
        if kw in text_lower and ctype not in coverage["coverage_types"]:
            coverage["coverage_types"].append(ctype)

    # Exclusions
    for kw in ["flood", "earthquake", "nuclear", "wear and tear", "mold", "termite"]:
        if kw in text_lower:
            coverage["exclusions"].append(kw)

    return coverage


def _extract_umbrella_coverage(lines: list[str]) -> dict:
    """Extract umbrella/excess liability coverage elements."""
    coverage: dict = {
        "deductibles": [],
        "limits": [],
        "coverage_types": ["excess_liability", "personal_liability"],
        "exclusions": [],
        "notes": [],
    }

    # Primary limit
    primary = _extract_first_dollar_near(
        lines,
        [
            "per occurrence",
            "per claim",
            "umbrella limit",
            "coverage limit",
            "liability limit",
            "aggregate limit",
        ],
        window=2,
    )
    if primary:
        coverage["limits"].append(
            {"category": "per_occurrence", "amount_usd": primary, "per": "occurrence"}
        )

    # Aggregate
    agg = _extract_first_dollar_near(
        lines, ["aggregate", "annual aggregate", "policy aggregate"], window=2
    )
    if agg and agg != primary:
        coverage["limits"].append(
            {"category": "aggregate", "amount_usd": agg, "per": "policy_period"}
        )

    # Self-insured retention (SIR / retained limit)
    sir = _extract_first_dollar_near(
        lines, ["self-insured retention", "sir", "retained limit"], window=2
    )
    if sir:
        coverage["deductibles"].append({"category": "self_insured_retention", "amount_usd": sir})

    return coverage


# -----------------------------------------------------------------------
# PDF text extraction
# -----------------------------------------------------------------------


def extract_text_from_pdf(pdf_path: Path) -> str:
    """Extract full text from PDF using pdfplumber (streams pages, bounded memory)."""
    try:
        import pdfplumber  # type: ignore[import]
    except ImportError:
        log.error("pdfplumber not installed. Run: pip install pdfplumber>=0.11")
        sys.exit(1)

    pages: list[str] = []
    try:
        with pdfplumber.open(str(pdf_path)) as pdf:
            for page_num, page in enumerate(pdf.pages, 1):
                try:
                    text = page.extract_text() or ""
                    pages.append(text)
                except Exception as e:
                    log.warning(f"Page {page_num} extraction failed: {e}")
                    pages.append("")
    except Exception as e:
        log.error(f"Failed to open PDF {pdf_path}: {e}")
        return ""

    return "\n".join(pages)


# -----------------------------------------------------------------------
# Header extraction (provider name, policy number, insured name)
# -----------------------------------------------------------------------


def extract_header_fields(lines: list[str]) -> dict:
    """Extract provider, policy number, and insured name from document header."""
    result: dict = {"provider": None, "policy_number": None, "insured_name": None}

    # Provider: first non-empty line that looks like a company name
    for line in lines[:15]:
        stripped = line.strip()
        if (
            5 <= len(stripped) <= 80
            and not _DOLLAR_RE.search(stripped)
            and not stripped.isdigit()
            and re.search(r"[A-Za-z]{3,}", stripped)
        ):
            result["provider"] = stripped
            break

    # Policy number: regex near "policy number", "policy #", "certificate"
    for i, line in enumerate(lines):
        ll = line.lower()
        if any(
            kw in ll
            for kw in [
                "policy number",
                "policy no",
                "policy #",
                "certificate number",
                "certificate no",
            ]
        ):
            nearby = " ".join(lines[max(0, i) : min(len(lines), i + 3)])
            m = re.search(
                r"(?:policy\s*(?:number|no|#)|certificate\s*(?:number|no))[:\s]+([A-Z0-9\-]+)",
                nearby,
                re.IGNORECASE,
            )
            if m:
                result["policy_number"] = m.group(1).strip()
                break

    # Insured name: near "named insured", "insured:", "policyholder"
    for i, line in enumerate(lines):
        ll = line.lower()
        if any(kw in ll for kw in ["named insured", "insured:", "policyholder:", "policy holder:"]):
            nearby = " ".join(lines[max(0, i) : min(len(lines), i + 2)])
            m = re.search(
                r"(?:named insured|insured|policyholder|policy holder)[:\s]+([A-Za-z ,\.'-]{3,60})",
                nearby,
                re.IGNORECASE,
            )
            if m:
                name = m.group(1).strip().rstrip(",")
                if not any(kw in name.lower() for kw in ["date", "number", "policy", "period"]):
                    result["insured_name"] = name
                    break

    return result


# -----------------------------------------------------------------------
# Main extraction entry point
# -----------------------------------------------------------------------


def extract_policy(
    text: str,
    source_file: str,
    policy_type_override: str | None = None,
    provider_override: str | None = None,
) -> dict:
    """
    Parse insurance policy text and return structured coverage dict.

    Returns dict ready for INSERT into insurance_policies.
    """
    lines = text.splitlines()

    # Detect policy type
    policy_type = policy_type_override or detect_policy_type(text)
    if not policy_type:
        log.warning(f"Could not detect policy type for {source_file}; defaulting to 'health'")
        policy_type = "health"

    # Extract header fields
    header = extract_header_fields(lines)
    provider = provider_override or header["provider"] or "Unknown Provider"
    policy_number = header["policy_number"]
    insured_name = header["insured_name"]

    # Extract dates — use specific keywords to avoid effective/expiration date collision
    effective_date = _extract_date_near(
        lines, ["effective date:", "effective date", "coverage begins", "policy begins"], window=1
    )
    expiration_date = _extract_date_near(
        lines,
        ["expiration date:", "expiration date", "expiration:", "coverage ends", "policy expires"],
        window=1,
    )

    # Extract coverage by type
    coverage_extractors = {
        "health": _extract_health_coverage,
        "auto": _extract_auto_coverage,
        "home": _extract_home_coverage,
        "umbrella": _extract_umbrella_coverage,
    }
    extractor = coverage_extractors.get(policy_type, _extract_health_coverage)
    coverage = extractor(lines)

    return {
        "policy_type": policy_type,
        "provider": provider,
        "policy_number": policy_number,
        "insured_name": insured_name,
        "effective_date": effective_date.isoformat() if effective_date else None,
        "expiration_date": expiration_date.isoformat() if expiration_date else None,
        "coverage": coverage,
        "raw_text": text[:50000],  # cap raw text at 50K chars
        "source_file": source_file,
    }


# -----------------------------------------------------------------------
# Database operations
# -----------------------------------------------------------------------


def get_db_url() -> str:
    """Resolve Postgres connection URL from environment."""
    url = (
        os.environ.get("OPEN_BRAIN_DATABASE_URL")
        or os.environ.get("POSTGRES_URL")
        or os.environ.get("POSTGRES_CONNECTION_STRING")
    )
    if not url:
        log.error(
            "No database URL found. Set OPEN_BRAIN_DATABASE_URL "
            "(e.g. postgresql://openbrain:pass@localhost:5432/openbrain)"
        )
        sys.exit(1)
    return url


def upsert_policy(policy_data: dict) -> str:
    """
    UPSERT policy into insurance_policies table.

    If source_file already exists, updates the existing row.
    Returns the UUID of the inserted/updated row.
    """
    try:
        import psycopg2  # type: ignore[import]
        import psycopg2.extras
    except ImportError:
        log.error("psycopg2 not installed. Run: pip install psycopg2-binary>=2.9")
        sys.exit(1)

    db_url = get_db_url()
    sql = """
        INSERT INTO insurance_policies
            (policy_number, provider, policy_type, effective_date, expiration_date,
             insured_name, coverage, raw_text, source_file, extracted_at)
        VALUES
            (%(policy_number)s, %(provider)s, %(policy_type)s,
             %(effective_date)s, %(expiration_date)s, %(insured_name)s,
             %(coverage)s, %(raw_text)s, %(source_file)s, NOW())
        ON CONFLICT (source_file)
        WHERE source_file IS NOT NULL
        DO UPDATE SET
            policy_number   = EXCLUDED.policy_number,
            provider        = EXCLUDED.provider,
            policy_type     = EXCLUDED.policy_type,
            effective_date  = EXCLUDED.effective_date,
            expiration_date = EXCLUDED.expiration_date,
            insured_name    = EXCLUDED.insured_name,
            coverage        = EXCLUDED.coverage,
            raw_text        = EXCLUDED.raw_text,
            extracted_at    = NOW()
        RETURNING id
    """
    params = dict(policy_data)
    params["coverage"] = json.dumps(policy_data["coverage"])

    conn = None
    try:
        conn = psycopg2.connect(db_url)
        with conn, conn.cursor() as cur:
            cur.execute(sql, params)
            row = cur.fetchone()
            return str(row[0]) if row else "unknown"
    finally:
        if conn:
            conn.close()


def get_policy_status() -> None:
    """Print count of policies by type."""
    try:
        import psycopg2  # type: ignore[import]
    except ImportError:
        log.error("psycopg2 not installed. Run: pip install psycopg2-binary>=2.9")
        sys.exit(1)

    db_url = get_db_url()
    conn = None
    try:
        conn = psycopg2.connect(db_url)
        with conn, conn.cursor() as cur:
            cur.execute(
                "SELECT policy_type, COUNT(*) FROM insurance_policies GROUP BY policy_type ORDER BY policy_type"
            )
            rows = cur.fetchall()
            if not rows:
                print("No policies in database.")
                return
            print(f"\n{'Policy Type':<15} {'Count':>6}")
            print("-" * 22)
            total = 0
            for ptype, count in rows:
                print(f"{ptype:<15} {count:>6}")
                total += count
            print("-" * 22)
            print(f"{'Total':<15} {total:>6}")
    finally:
        if conn:
            conn.close()


def list_policies() -> None:
    """List all stored policies with key fields."""
    try:
        import psycopg2  # type: ignore[import]
    except ImportError:
        log.error("psycopg2 not installed. Run: pip install psycopg2-binary>=2.9")
        sys.exit(1)

    db_url = get_db_url()
    conn = None
    try:
        conn = psycopg2.connect(db_url)
        with conn, conn.cursor() as cur:
            cur.execute(
                """SELECT id, provider, policy_type, effective_date, expiration_date, source_file, extracted_at
                   FROM insurance_policies
                   ORDER BY created_at DESC"""
            )
            rows = cur.fetchall()
            if not rows:
                print("No policies in database.")
                return
            print(
                f"\n{'ID':36}  {'Provider':25}  {'Type':10}  {'Effective':12}  {'Expires':12}  {'File'}"
            )
            print("-" * 120)
            for row in rows:
                pid, prov, ptype, eff, exp, src, extracted = row
                src_short = Path(src).name if src else "(none)"
                eff_s = str(eff) if eff else "        "
                exp_s = str(exp) if exp else "        "
                print(f"{pid}  {prov[:25]:<25}  {ptype:<10}  {eff_s:<12}  {exp_s:<12}  {src_short}")
    finally:
        if conn:
            conn.close()


# -----------------------------------------------------------------------
# Process files
# -----------------------------------------------------------------------


def process_file(
    path: Path,
    dry_run: bool = False,
    policy_type_override: str | None = None,
    provider_override: str | None = None,
    text_content: str | None = None,
) -> dict | None:
    """
    Process a single policy file (PDF or text fixture).

    Args:
        path: Path to the policy file.
        dry_run: If True, print extracted JSON without writing to DB.
        policy_type_override: Override auto-detected policy type.
        provider_override: Override auto-detected provider name.
        text_content: Pre-loaded text content (for test fixtures).
                      If None, text is extracted from the PDF.
    Returns:
        Extracted policy dict, or None on failure.
    """
    log.info(f"Processing: {path}")

    if text_content is not None:
        text = text_content
    elif path.suffix.lower() == ".pdf":
        text = extract_text_from_pdf(path)
    else:
        # Treat as plain text (fixture files, .txt)
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except Exception as e:
            log.error(f"Failed to read {path}: {e}")
            return None

    if not text.strip():
        log.warning(f"No text extracted from {path}")
        return None

    policy = extract_policy(
        text,
        source_file=str(path),
        policy_type_override=policy_type_override,
        provider_override=provider_override,
    )

    if dry_run:
        output = dict(policy)
        output.pop("raw_text", None)  # omit raw text from dry-run output
        print(json.dumps(output, indent=2, default=str))
        return policy

    policy_id = upsert_policy(policy)
    log.info(
        f"Stored: {policy['policy_type']} policy from {policy['provider']} "
        f"(id={policy_id}, effective={policy.get('effective_date')})"
    )
    return policy


def process_dir(
    directory: Path,
    dry_run: bool = False,
    policy_type_override: str | None = None,
    provider_override: str | None = None,
) -> None:
    """Process all PDFs in a directory, skipping already-ingested files."""
    pdfs = sorted(directory.glob("*.pdf"))
    if not pdfs:
        log.info(f"No PDFs found in {directory}")
        return

    log.info(f"Found {len(pdfs)} PDF(s) in {directory}")

    # Pre-load already-ingested source_file paths
    ingested: set[str] = set()
    if not dry_run:
        try:
            import psycopg2  # type: ignore[import]

            conn = psycopg2.connect(get_db_url())
            with conn, conn.cursor() as cur:
                cur.execute(
                    "SELECT source_file FROM insurance_policies WHERE source_file IS NOT NULL"
                )
                for row in cur.fetchall():
                    ingested.add(row[0])
            conn.close()
        except Exception as e:
            log.warning(f"Could not load ingested file list: {e}")

    processed = 0
    skipped = 0
    for pdf in pdfs:
        pdf_str = str(pdf)
        if pdf_str in ingested:
            log.info(f"Skipping (already ingested): {pdf.name}")
            skipped += 1
            continue
        result = process_file(pdf, dry_run, policy_type_override, provider_override)
        if result:
            processed += 1

    log.info(f"Done — processed {processed}, skipped {skipped}, total {len(pdfs)}")


# -----------------------------------------------------------------------
# CLI
# -----------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Insurance policy PDF extraction for Open Brain (T0 Python/pdfplumber).",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument(
        "--file", metavar="PDF", help="Process a single policy PDF (or .txt fixture)."
    )
    mode.add_argument("--dir", metavar="DIR", help="Process all PDFs in a directory.")
    mode.add_argument("--status", action="store_true", help="Show policy counts by type.")
    mode.add_argument("--list", action="store_true", help="List all stored policies.")

    parser.add_argument(
        "--dry-run", action="store_true", help="Print extracted JSON; do not write to DB."
    )
    parser.add_argument(
        "--policy-type",
        choices=["health", "auto", "home", "umbrella"],
        help="Override auto-detected policy type.",
    )
    parser.add_argument("--provider", metavar="NAME", help="Override auto-detected provider name.")

    args = parser.parse_args()

    if args.status:
        get_policy_status()
        return

    if args.list:
        list_policies()
        return

    if args.file:
        path = Path(args.file)
        if not path.exists():
            log.error(f"File not found: {path}")
            sys.exit(1)
        result = process_file(
            path,
            dry_run=args.dry_run,
            policy_type_override=args.policy_type,
            provider_override=args.provider,
        )
        if result is None:
            sys.exit(1)
        return

    if args.dir:
        directory = Path(args.dir)
        if not directory.is_dir():
            log.error(f"Not a directory: {directory}")
            sys.exit(1)
        process_dir(
            directory,
            dry_run=args.dry_run,
            policy_type_override=args.policy_type,
            provider_override=args.provider,
        )


if __name__ == "__main__":
    main()
