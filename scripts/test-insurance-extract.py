#!/usr/bin/env python3
"""
Validation tests for insurance-policy-extract.py.

Runs extraction against text fixtures (no PDF needed, no DB writes) and
asserts extracted values match known-good expectations.

Usage:
    python scripts/test-insurance-extract.py

Exit codes:
    0 — all assertions pass
    1 — one or more assertions failed (detailed diff on stdout)
"""

import importlib.util as _ilu
import json
import sys
from pathlib import Path

# Allow running from repo root or from scripts/ directory
_SCRIPT_DIR = Path(__file__).parent
_FIXTURE_DIR = _SCRIPT_DIR / "test-fixtures" / "insurance"

# Load insurance-policy-extract module (hyphen in filename requires importlib)
_spec = _ilu.spec_from_file_location(
    "insurance_policy_extract",
    _SCRIPT_DIR / "insurance-policy-extract.py",
)
_mod = _ilu.module_from_spec(_spec)  # type: ignore[arg-type]
_spec.loader.exec_module(_mod)  # type: ignore[union-attr]
extract_policy = _mod.extract_policy


# -----------------------------------------------------------------------
# Assertion helpers
# -----------------------------------------------------------------------

_failures: list[str] = []


def assert_eq(label: str, actual, expected) -> None:
    if actual != expected:
        _failures.append(f"  FAIL [{label}]: expected {expected!r}, got {actual!r}")
    else:
        print(f"  PASS [{label}]: {actual!r}")


def assert_gte(label: str, actual: int | float, minimum: int | float) -> None:
    if actual < minimum:
        _failures.append(f"  FAIL [{label}]: expected >= {minimum}, got {actual!r}")
    else:
        print(f"  PASS [{label}]: {actual!r} >= {minimum}")


def assert_in(label: str, item, container) -> None:
    if item not in container:
        _failures.append(f"  FAIL [{label}]: {item!r} not found in {container!r}")
    else:
        print(f"  PASS [{label}]: {item!r} found")


def assert_true(label: str, condition: bool, detail: str = "") -> None:
    if not condition:
        _failures.append(f"  FAIL [{label}]{': ' + detail if detail else ''}")
    else:
        print(f"  PASS [{label}]{': ' + detail if detail else ''}")


# -----------------------------------------------------------------------
# Helper: find coverage entry by category
# -----------------------------------------------------------------------

def find_by_category(items: list[dict], category: str) -> dict | None:
    return next((x for x in items if x.get("category") == category), None)


def find_copay_by_service(copays: list[dict], service: str) -> dict | None:
    return next((x for x in copays if x.get("service") == service), None)


# -----------------------------------------------------------------------
# Test: health policy fixture
# -----------------------------------------------------------------------

def test_health_policy() -> None:
    print("\n=== Health Policy Fixture ===")
    fixture = _FIXTURE_DIR / "health-policy-fixture.txt"
    assert fixture.exists(), f"Fixture missing: {fixture}"

    text = fixture.read_text(encoding="utf-8")
    policy = extract_policy(text, source_file=str(fixture))

    assert_eq("policy_type", policy["policy_type"], "health")
    assert_true(
        "provider_set",
        policy["provider"] is not None and len(policy["provider"]) > 3,
        f"provider={policy['provider']!r}",
    )
    assert_eq("policy_number", policy["policy_number"], "XYZ-2024-001234")
    assert_eq("effective_date", policy["effective_date"], "2025-01-01")
    assert_eq("expiration_date", policy["expiration_date"], "2025-12-31")

    coverage = policy["coverage"]

    indiv_ded = find_by_category(coverage["deductibles"], "individual")
    assert_true("deductible_individual_exists", indiv_ded is not None)
    if indiv_ded:
        assert_eq("deductibles[individual].amount_usd", indiv_ded["amount_usd"], 1500)

    family_ded = find_by_category(coverage["deductibles"], "family")
    assert_true("deductible_family_exists", family_ded is not None)
    if family_ded:
        assert_eq("deductibles[family].amount_usd", family_ded["amount_usd"], 3000)

    indiv_oop = find_by_category(coverage["out_of_pocket_max"], "individual")
    assert_true("oop_max_individual_exists", indiv_oop is not None)
    if indiv_oop:
        assert_eq("out_of_pocket_max[individual].amount_usd", indiv_oop["amount_usd"], 5000)

    assert_true("co_insurance_set", coverage["co_insurance"] is not None)
    if coverage["co_insurance"]:
        assert_eq("co_insurance.percentage", coverage["co_insurance"]["percentage"], 80)

    pcp = find_copay_by_service(coverage["co_pays"], "primary_care_visit")
    assert_true("copay_pcp_exists", pcp is not None)
    if pcp:
        assert_eq("co_pays[primary_care_visit].amount_usd", pcp["amount_usd"], 25)

    specialist = find_copay_by_service(coverage["co_pays"], "specialist_visit")
    assert_true("copay_specialist_exists", specialist is not None)
    if specialist:
        assert_eq("co_pays[specialist_visit].amount_usd", specialist["amount_usd"], 50)

    assert_in("coverage_type_hospitalization", "hospitalization", coverage["coverage_types"])


# -----------------------------------------------------------------------
# Test: auto policy fixture
# -----------------------------------------------------------------------

def test_auto_policy() -> None:
    print("\n=== Auto Policy Fixture ===")
    fixture = _FIXTURE_DIR / "auto-policy-fixture.txt"
    assert fixture.exists(), f"Fixture missing: {fixture}"

    text = fixture.read_text(encoding="utf-8")
    policy = extract_policy(text, source_file=str(fixture))

    assert_eq("policy_type", policy["policy_type"], "auto")

    coverage = policy["coverage"]

    collision = find_by_category(coverage["deductibles"], "collision")
    assert_true("deductible_collision_exists", collision is not None)
    if collision:
        assert_eq("deductibles[collision].amount_usd", collision["amount_usd"], 500)

    comprehensive = find_by_category(coverage["deductibles"], "comprehensive")
    assert_true("deductible_comprehensive_exists", comprehensive is not None)
    if comprehensive:
        assert_eq("deductibles[comprehensive].amount_usd", comprehensive["amount_usd"], 250)

    bi_limit = find_by_category(coverage["limits"], "bodily_injury")
    assert_true("limit_bodily_injury_exists", bi_limit is not None)
    if bi_limit:
        assert_eq("limits[bodily_injury].amount_usd", bi_limit["amount_usd"], 100000)

    assert_in("coverage_type_collision", "collision", coverage["coverage_types"])
    assert_in("coverage_type_liability", "liability", coverage["coverage_types"])


# -----------------------------------------------------------------------
# Test: home policy fixture
# -----------------------------------------------------------------------

def test_home_policy() -> None:
    print("\n=== Home Policy Fixture ===")
    fixture = _FIXTURE_DIR / "home-policy-fixture.txt"
    assert fixture.exists(), f"Fixture missing: {fixture}"

    text = fixture.read_text(encoding="utf-8")
    policy = extract_policy(text, source_file=str(fixture))

    assert_eq("policy_type", policy["policy_type"], "home")

    coverage = policy["coverage"]

    deductible = find_by_category(coverage["deductibles"], "all_perils")
    assert_true("deductible_all_perils_exists", deductible is not None)
    if deductible:
        assert_eq("deductibles[all_perils].amount_usd", deductible["amount_usd"], 2500)

    dwelling = find_by_category(coverage["limits"], "dwelling")
    assert_true("limit_dwelling_exists", dwelling is not None)
    if dwelling:
        assert_eq("limits[dwelling].amount_usd", dwelling["amount_usd"], 400000)

    personal_prop = find_by_category(coverage["limits"], "personal_property")
    assert_true("limit_personal_property_exists", personal_prop is not None)
    if personal_prop:
        assert_eq("limits[personal_property].amount_usd", personal_prop["amount_usd"], 150000)

    liability = find_by_category(coverage["limits"], "liability")
    assert_true("limit_liability_exists", liability is not None)
    if liability:
        assert_eq("limits[liability].amount_usd", liability["amount_usd"], 300000)

    assert_in("coverage_type_liability", "liability", coverage["coverage_types"])


# -----------------------------------------------------------------------
# Test: dry-run JSON validity
# -----------------------------------------------------------------------

def test_dry_run_json_validity() -> None:
    print("\n=== Dry-Run JSON Validity ===")
    fixture = _FIXTURE_DIR / "health-policy-fixture.txt"
    text = fixture.read_text(encoding="utf-8")
    policy = extract_policy(text, source_file=str(fixture))

    try:
        coverage_json = json.dumps(policy["coverage"])
        parsed = json.loads(coverage_json)
        assert_true("coverage_json_roundtrip", parsed == policy["coverage"])
    except Exception as e:
        _failures.append(f"  FAIL [coverage_json_roundtrip]: {e}")

    for field in ["policy_type", "provider", "coverage", "source_file"]:
        assert_true(f"required_field_{field}", policy.get(field) is not None)


# -----------------------------------------------------------------------
# Test: policy type override
# -----------------------------------------------------------------------

def test_policy_type_override() -> None:
    print("\n=== Policy Type Override ===")
    fixture = _FIXTURE_DIR / "health-policy-fixture.txt"
    text = fixture.read_text(encoding="utf-8")

    policy = extract_policy(
        text, source_file=str(fixture), policy_type_override="home"
    )
    assert_eq("policy_type_override", policy["policy_type"], "home")

    policy2 = extract_policy(
        text, source_file=str(fixture), provider_override="Acme Insurance Co"
    )
    assert_eq("provider_override", policy2["provider"], "Acme Insurance Co")


# -----------------------------------------------------------------------
# Main runner
# -----------------------------------------------------------------------

def main() -> None:
    print("Running insurance extraction validation tests...")
    print(f"Fixture directory: {_FIXTURE_DIR}")

    test_health_policy()
    test_auto_policy()
    test_home_policy()
    test_dry_run_json_validity()
    test_policy_type_override()

    print("\n" + "=" * 60)
    if _failures:
        print(f"FAILED: {len(_failures)} assertion(s)")
        for msg in _failures:
            print(msg)
        sys.exit(1)
    else:
        print("ALL PASS")
        sys.exit(0)


if __name__ == "__main__":
    main()
