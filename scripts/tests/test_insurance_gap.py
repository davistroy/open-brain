"""Unit tests for scripts/insurance-gap-analysis.py — P22b.

Strategy: pure Python fixture dicts — no live DB, no HTTP, no real claude CLI.
Load the module via importlib (hyphenated filename), then test all public
functions directly.

Run:
    python -m pytest scripts/tests/test_insurance_gap.py -v
"""

import importlib.util
import json
import sys
from datetime import date, timedelta
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

# ---------------------------------------------------------------------------
# Load insurance-gap-analysis.py by path (hyphen prevents normal import)
# ---------------------------------------------------------------------------
_SCRIPTS_DIR = Path(__file__).resolve().parent.parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

_MODULE_PATH = _SCRIPTS_DIR / "insurance-gap-analysis.py"

_spec = importlib.util.spec_from_file_location("insurance_gap_analysis", _MODULE_PATH)
assert _spec is not None and _spec.loader is not None, (
    f"Cannot load module at {_MODULE_PATH}"
)
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)  # type: ignore[union-attr]

# Convenience aliases
normalize_policy = _mod.normalize_policy
detect_missing_types = _mod.detect_missing_types
detect_under_coverage = _mod.detect_under_coverage
detect_redundancy = _mod.detect_redundancy
detect_expiring_soon = _mod.detect_expiring_soon
detect_over_coverage = _mod.detect_over_coverage
run_gap_heuristics = _mod.run_gap_heuristics
build_synthesis_prompt = _mod.build_synthesis_prompt
post_capture = _mod.post_capture

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

TODAY = date.today()
EXPIRING_SOON = (TODAY + timedelta(days=30)).isoformat()
NOT_EXPIRING = (TODAY + timedelta(days=180)).isoformat()
PAST_DATE = (TODAY - timedelta(days=365)).isoformat()


def _health_policy(
    provider="Blue Cross",
    individual_deductible=1500,
    oop_max=5000,
    effective=None,
    expiration=NOT_EXPIRING,
):
    """Minimal health policy fixture."""
    effective = effective or PAST_DATE
    return {
        "id": "h1",
        "policy_number": "HC-001",
        "provider": provider,
        "policy_type": "health",
        "effective_date": effective,
        "expiration_date": expiration,
        "insured_name": "Troy Davis",
        "coverage": {
            "deductibles": {"individual": individual_deductible},
            "limits": {},
            "out_of_pocket_max": oop_max,
            "co_insurance": 20,
            "co_pays": {"primary_care": 30},
            "coverage_types": ["medical", "prescription"],
            "exclusions": [],
            "notes": "",
        },
    }


def _auto_policy(
    provider="State Farm",
    bodily_injury=250000,
    has_rental=False,
    expiration=NOT_EXPIRING,
):
    coverage_types = ["collision", "comprehensive"]
    if has_rental:
        coverage_types.append("rental_reimbursement")
    return {
        "id": "a1",
        "policy_number": "AUTO-001",
        "provider": provider,
        "policy_type": "auto",
        "effective_date": PAST_DATE,
        "expiration_date": expiration,
        "insured_name": "Troy Davis",
        "coverage": {
            "deductibles": {"collision": 500, "comprehensive": 250},
            "limits": {
                "bodily_injury_per_person": bodily_injury,
                "property_damage": 100000,
            },
            "coverage_types": coverage_types,
            "exclusions": [],
            "notes": "",
        },
    }


def _home_policy(provider="Allstate", dwelling=300000, expiration=NOT_EXPIRING):
    return {
        "id": "ho1",
        "policy_number": "HOME-001",
        "provider": provider,
        "policy_type": "home",
        "effective_date": PAST_DATE,
        "expiration_date": expiration,
        "insured_name": "Troy Davis",
        "coverage": {
            "deductibles": {"standard": 1000},
            "limits": {
                "dwelling": dwelling,
                "personal_property": 100000,
                "liability": 300000,
            },
            "coverage_types": ["dwelling", "personal_property", "liability"],
            "exclusions": [],
            "notes": "",
        },
    }


def _umbrella_policy(expiration=NOT_EXPIRING):
    return {
        "id": "u1",
        "policy_number": "UMB-001",
        "provider": "GEICO",
        "policy_type": "umbrella",
        "effective_date": PAST_DATE,
        "expiration_date": expiration,
        "insured_name": "Troy Davis",
        "coverage": {
            "deductibles": {"self_insured_retention": 500},
            "limits": {"per_occurrence": 1000000, "aggregate": 2000000},
            "coverage_types": ["umbrella"],
            "exclusions": [],
            "notes": "",
        },
    }


_DEFAULT_CFG = {
    "api": {"base_url": ""},
    "synthesis": {"max_prompt_chars": 5000, "expiry_warning_days": 60, "captures_url": ""},
    "thresholds": {
        "health": {"high_deductible_usd": 5000, "high_oop_max_usd": 10000},
        "home": {"min_dwelling_usd": 200000},
        "auto": {"min_bodily_injury_usd": 100000},
    },
    "expected_policy_types": ["health", "auto", "home", "umbrella"],
}


# ---------------------------------------------------------------------------
# Test 1 — missing_type detected when home is absent
# ---------------------------------------------------------------------------

def test_missing_policy_type_detected():
    """No home policy → missing_types includes 'home'."""
    policies = [_health_policy(), _auto_policy(), _umbrella_policy()]
    normalized = [normalize_policy(p) for p in policies]
    findings = detect_missing_types(normalized, ["health", "auto", "home", "umbrella"])
    missing = [f for f in findings if f["class"] == "missing_type" and f["policy_type"] == "home"]
    assert len(missing) == 1
    assert missing[0]["severity"] == "high"


# ---------------------------------------------------------------------------
# Test 2 — no missing types when all 4 types present
# ---------------------------------------------------------------------------

def test_no_missing_types():
    """All 4 policy types present → no missing_type findings."""
    policies = [_health_policy(), _auto_policy(), _home_policy(), _umbrella_policy()]
    normalized = [normalize_policy(p) for p in policies]
    findings = detect_missing_types(normalized, ["health", "auto", "home", "umbrella"])
    assert findings == []


# ---------------------------------------------------------------------------
# Test 3 — health high deductible triggers under_coverage
# ---------------------------------------------------------------------------

def test_health_high_deductible_flag():
    """Health deductible $7,500 > threshold $5,000 → under_coverage finding."""
    policies = [_health_policy(individual_deductible=7500)]
    normalized = [normalize_policy(p) for p in policies]
    cfg = _DEFAULT_CFG
    findings = detect_under_coverage(normalized, cfg["thresholds"])
    uc = [f for f in findings if f["class"] == "under_coverage" and f["policy_type"] == "health"]
    assert len(uc) >= 1
    assert any("7,500" in f["description"] for f in uc)


# ---------------------------------------------------------------------------
# Test 4 — health normal deductible does NOT trigger under_coverage
# ---------------------------------------------------------------------------

def test_health_normal_deductible_no_flag():
    """Health deductible $2,000 < threshold $5,000 → no under_coverage finding."""
    policies = [_health_policy(individual_deductible=2000)]
    normalized = [normalize_policy(p) for p in policies]
    cfg = _DEFAULT_CFG
    findings = detect_under_coverage(normalized, cfg["thresholds"])
    uc = [f for f in findings if f["class"] == "under_coverage" and f["policy_type"] == "health"]
    # Deductible $2,000 is fine — only OOP might flag but oop_max=5000 == threshold, NOT over
    deductible_findings = [f for f in uc if "deductible" in f["description"].lower()]
    assert len(deductible_findings) == 0


# ---------------------------------------------------------------------------
# Test 5 — two active health plans → redundancy finding
# ---------------------------------------------------------------------------

def test_redundancy_two_active_health_plans():
    """Two active health policies with overlapping dates → redundancy finding."""
    p1 = _health_policy(provider="Blue Cross")
    p2 = _health_policy(provider="Aetna")
    normalized = [normalize_policy(p) for p in [p1, p2]]
    findings = detect_redundancy(normalized)
    red = [f for f in findings if f["class"] == "redundancy"]
    assert len(red) == 1
    assert "Blue Cross" in str(red[0]["providers"]) or "Aetna" in str(red[0]["providers"])


# ---------------------------------------------------------------------------
# Test 6 — policy expiring in 30 days → in expiring_soon list
# ---------------------------------------------------------------------------

def test_expiring_soon():
    """Policy expiring in 30 days → appears in expiring_soon list."""
    policy = _health_policy(expiration=EXPIRING_SOON)
    normalized = [normalize_policy(policy)]
    expiring = detect_expiring_soon(normalized, warning_days=60)
    assert len(expiring) == 1
    assert expiring[0]["days_remaining"] <= 60


# ---------------------------------------------------------------------------
# Test 7 — policy expiring in 180 days → NOT in expiring_soon
# ---------------------------------------------------------------------------

def test_not_expiring():
    """Policy expiring in 180 days → not in expiring_soon (window=60)."""
    policy = _health_policy(expiration=NOT_EXPIRING)
    normalized = [normalize_policy(policy)]
    expiring = detect_expiring_soon(normalized, warning_days=60)
    assert expiring == []


# ---------------------------------------------------------------------------
# Test 8 — large policy fixture truncates prompt at max_prompt_chars
# ---------------------------------------------------------------------------

def test_prompt_truncation():
    """Prompt truncation: content beyond max_prompt_chars is cut and noted."""
    # Generate many policies to inflate the prompt past 200 chars
    policies = []
    for i in range(30):
        policies.append(_health_policy(provider=f"Provider {i:02d} With A Very Long Name"))
    normalized = [normalize_policy(p) for p in policies]
    gaps = run_gap_heuristics(normalized, _DEFAULT_CFG)

    # Set a very small limit to force truncation
    small_cfg = {**_DEFAULT_CFG, "synthesis": {**_DEFAULT_CFG["synthesis"], "max_prompt_chars": 200}}
    prompt = build_synthesis_prompt(normalized, gaps, small_cfg)

    assert len(prompt) <= 200 + 10  # allow small buffer from truncation suffix
    assert "truncated" in prompt.lower()


# ---------------------------------------------------------------------------
# Test 9 — dry_run=True makes no HTTP POST
# ---------------------------------------------------------------------------

def test_dry_run_no_post(capsys):
    """dry_run=True → no HTTP call to captures endpoint."""
    cfg = _DEFAULT_CFG.copy()
    with patch("urllib.request.urlopen") as mock_urlopen:
        result = post_capture(cfg, "test content", {"type": "test"}, dry_run=True)
        mock_urlopen.assert_not_called()
    assert result is True


# ---------------------------------------------------------------------------
# Test 10 — home dwelling limit < threshold triggers under_coverage
# ---------------------------------------------------------------------------

def test_home_under_coverage():
    """Home dwelling limit $150,000 < $200,000 threshold → under_coverage finding."""
    policy = _home_policy(dwelling=150000)
    normalized = [normalize_policy(policy)]
    cfg = _DEFAULT_CFG
    findings = detect_under_coverage(normalized, cfg["thresholds"])
    uc = [f for f in findings if f["class"] == "under_coverage" and f["policy_type"] == "home"]
    assert len(uc) == 1
    assert "150,000" in uc[0]["description"]
    assert uc[0]["severity"] == "high"
