"""Uploaded inbox files route to the same parser as the bare filename (item 9.4).

core-api's ``POST /api/v1/ingest/upload`` writes each file as
``<uploadId>-<original name>`` into the inbox the sidecar scans, so two uploads
of the same export never collide and the file stays traceable to its
``file_uploads`` row. The financial router matches on the ORIGINAL export name
(``activity.csv``, ``chase…activity…``, ``acct_…``, ``HSA…``,
``Download.csv``), so the UUID prefix must be stripped before every name-based
decision — while the real on-disk name is kept for moves and logs.

All fixtures use obviously fake values; no pipeline is run and no network or
secret is touched (parsers are stubbed or fed synthetic CSV text).
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from typing import Any

import pytest

# scripts/ is not a package — add it to sys.path (test is 3 levels deep).
_SCRIPTS_DIR = Path(__file__).resolve().parents[3] / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from lib.inbox_names import strip_upload_prefix  # noqa: E402

# financial-pipeline.py has a hyphen in its name — load it by path.
_SPEC = importlib.util.spec_from_file_location(
    "financial_pipeline", _SCRIPTS_DIR / "financial-pipeline.py"
)
assert _SPEC is not None and _SPEC.loader is not None
fp = importlib.util.module_from_spec(_SPEC)
sys.modules["financial_pipeline"] = fp
_SPEC.loader.exec_module(fp)

UPLOAD_ID = "0b7e3c1a-4d2f-4a8b-9c6d-1e2f3a4b5c6d"


# ── helper ───────────────────────────────────────────────────────────────────


def test_strip_upload_prefix_removes_leading_uuid():
    assert strip_upload_prefix(f"{UPLOAD_ID}-activity.csv") == "activity.csv"


def test_strip_upload_prefix_is_case_insensitive_on_hex():
    assert strip_upload_prefix(f"{UPLOAD_ID.upper()}-HSA_fake.csv") == "HSA_fake.csv"


def test_strip_upload_prefix_leaves_bare_names_alone():
    assert strip_upload_prefix("activity.csv") == "activity.csv"
    assert strip_upload_prefix("Download (2).csv") == "Download (2).csv"


def test_strip_upload_prefix_only_strips_a_full_leading_uuid():
    # Not at the start, or not a complete UUID — untouched.
    assert strip_upload_prefix(f"x{UPLOAD_ID}-activity.csv") == f"x{UPLOAD_ID}-activity.csv"
    assert strip_upload_prefix("0b7e3c1a-4d2f-activity.csv") == "0b7e3c1a-4d2f-activity.csv"
    # Only one prefix is stripped (core-api adds exactly one).
    assert strip_upload_prefix(f"{UPLOAD_ID}-{UPLOAD_ID}-a.csv") == f"{UPLOAD_ID}-a.csv"


# ── _route_bank_csv: prefixed name == bare name ──────────────────────────────


def _stub_parsers(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, str]]:
    """Replace every bank parser with a recorder. Returns the call log."""
    calls: list[tuple[str, str]] = []

    def make(tag: str):
        def _parser(filepath: Path) -> dict[str, Any]:
            calls.append((tag, filepath.name))
            return {"stub": tag}

        return _parser

    for attr, tag in (
        ("_parse_amex_csv", "amex"),
        ("_parse_chase_csv", "chase"),
        ("_parse_truist_csv", "truist"),
        ("_parse_schwab_balance_csv", "schwab_balance"),
        ("_parse_schwab_position_csv", "schwab_position"),
        ("_parse_schwab_csv", "schwab"),
        ("_parse_hsa_csv", "hsa"),
        ("_parse_paypal_csv", "paypal"),
    ):
        monkeypatch.setattr(fp, attr, make(tag))
    return calls


@pytest.mark.parametrize(
    ("bare", "expected"),
    [
        ("activity.csv", "amex"),
        ("Chase0000_Activity_20990101.CSV", "chase"),
        ("acct_0000_fake_export.csv", "truist"),
        ("HSATransactionsAsOf_01012099.csv", "hsa"),
    ],
)
def test_prefixed_upload_routes_like_bare_name(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, bare: str, expected: str
):
    calls = _stub_parsers(monkeypatch)

    bare_path = tmp_path / "bare" / bare
    bare_path.parent.mkdir()
    bare_path.write_text("h\n")
    prefixed_path = tmp_path / f"{UPLOAD_ID}-{bare}"
    prefixed_path.write_text("h\n")

    bare_routed = fp._route_bank_csv(bare_path)
    prefixed_routed = fp._route_bank_csv(prefixed_path)

    assert bare_routed is not None and bare_routed[0] == expected
    assert prefixed_routed is not None
    assert prefixed_routed[0] == bare_routed[0]
    # The parser still receives the REAL on-disk file (moves/logs use it).
    assert calls[-1] == (expected, prefixed_path.name)


def test_prefixed_paypal_download_routes_to_paypal(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    calls = _stub_parsers(monkeypatch)
    header = '"Date","Time","Name","Gross","Net","Transaction ID","Balance Impact"\n'
    p = tmp_path / f"{UPLOAD_ID}-Download.CSV"
    p.write_text(header)

    routed = fp._route_bank_csv(p)

    assert routed is not None and routed[0] == "paypal"
    assert calls == [("paypal", p.name)]


# ── account masks derived from the filename ignore the prefix ───────────────

CHASE_CSV = (
    "Transaction Date,Post Date,Description,Category,Type,Amount,Memo\n"
    "01/02/2099,01/03/2099,FAKE MERCHANT ONE,Shopping,Sale,-1.00,\n"
)
TRUIST_CSV = (
    "Posted Date,Transaction Date,Transaction Type,Check/Serial #,Full description,"
    "Merchant name,Category name,Sub-category name,Amount,Daily Posted Balance\n"
    "01/02/2099,01/02/2099,Debit,,FAKE PAYEE,FAKE PAYEE,Misc,,($1.00),$0.00\n"
)


def test_chase_account_mask_ignores_upload_prefix(tmp_path: Path):
    p = tmp_path / f"{UPLOAD_ID}-Chase0000_Activity_20990101.CSV"
    p.write_text(CHASE_CSV)
    result = fp._parse_chase_csv(p)
    assert result is not None
    assert result["account_id"] == "0000"


def test_truist_account_mask_ignores_upload_prefix(tmp_path: Path):
    p = tmp_path / f"{UPLOAD_ID}-acct_0000_fake_export.csv"
    p.write_text(TRUIST_CSV)
    result = fp._parse_truist_csv(p)
    assert result is not None
    assert result["account_id"] == "0000"


# ── partial uploads are never picked up ─────────────────────────────────────


def test_process_inbox_ignores_part_files(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """core-api streams to ``<dest>.part`` then renames — a half-written upload
    must be invisible to ``--process-inbox``."""
    inbox = tmp_path / "inbox"
    inbox.mkdir()
    (inbox / f"{UPLOAD_ID}-activity.csv.part").write_text("partial")
    monkeypatch.setattr(fp, "INBOX_DIR", inbox)
    monkeypatch.setattr(fp, "PROCESSED_DIR", inbox / "processed")
    routed: list[Path] = []
    monkeypatch.setattr(fp, "_route_bank_csv", lambda p: routed.append(p))
    monkeypatch.setattr(fp, "_parse_401k_pdf", lambda p: routed.append(p))

    fp.cmd_process_inbox({}, None)  # type: ignore[arg-type]

    assert routed == []
    assert (inbox / f"{UPLOAD_ID}-activity.csv.part").exists()


# ── shared YAML router (scripts/lib/ingest_router.py) ───────────────────────


def test_yaml_router_matches_prefixed_upload_like_bare_name():
    from lib import ingest_router

    cfg = _SCRIPTS_DIR.parent / "config" / "ingest-routes.yaml"
    ingest_router._clear_cache()
    try:
        bare = ingest_router.route_for_filename("activity.csv", cfg)
        prefixed = ingest_router.route_for_filename(f"/inbox/{UPLOAD_ID}-activity.csv", cfg)
    finally:
        ingest_router._clear_cache()
    assert bare is not None and bare["parser"] == "amex"
    assert prefixed == bare


# ── end to end through --process-inbox (local stand-in for the CI e2e) ──────


def test_process_inbox_parses_a_prefixed_upload_and_moves_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """The exact file the full-stack e2e uploads (same CSV body, same on-disk
    name shape) is parsed by the real AMEX parser, posted once with
    ``source_file`` = the on-disk name, and moved to processed/ under that name.
    ``_post_capture`` is stubbed — nothing leaves the process."""
    inbox = tmp_path / "inbox"
    inbox.mkdir()
    name = f"{UPLOAD_ID}-activity.csv"
    (inbox / name).write_text(
        "Date,Description,Amount\n"
        "04/17/2026,TEST INGEST E2E ONE,12.34\n"
        "04/16/2026,TEST INGEST E2E TWO,56.78\n"
    )
    monkeypatch.setattr(fp, "INBOX_DIR", inbox)
    monkeypatch.setattr(fp, "PROCESSED_DIR", inbox / "processed")
    posted: list[dict[str, Any]] = []
    monkeypatch.setattr(fp, "_post_capture", lambda cfg, content, meta: posted.append(meta) or True)

    fp.cmd_process_inbox({}, None)  # type: ignore[arg-type]

    assert len(posted) == 1
    assert posted[0]["source_file"] == name
    assert not (inbox / name).exists()
    assert (inbox / "processed" / name).exists()
