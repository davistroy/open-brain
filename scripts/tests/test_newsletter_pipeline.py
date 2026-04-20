"""
Tests for newsletter-pipeline.py — P21.

All tests are mocked at the API boundary:
  - No live Graph API calls
  - No live core-api calls
  - No live Claude CLI invocations

Run: pytest scripts/tests/test_newsletter_pipeline.py -v
"""

import importlib.util
import sqlite3
from pathlib import Path
from unittest.mock import patch

import pytest

# ── Load the module under test ────────────────────────────────────────────────
# newsletter-pipeline.py lives one level up from this test file.
_MODULE_PATH = Path(__file__).resolve().parent.parent / "newsletter-pipeline.py"
_spec = importlib.util.spec_from_file_location("newsletter_pipeline", _MODULE_PATH)
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)

init_db = _mod.init_db
parse_newsletter = _mod.parse_newsletter
compute_diff = _mod.compute_diff
record_newsletter = _mod.record_newsletter
DUPLICATE_SENTINEL = _mod.DUPLICATE_SENTINEL
_body_hash = _mod._body_hash
synthesize_newsletter = _mod.synthesize_newsletter
post_newsletter_capture = _mod.post_newsletter_capture


# ── Fixtures ──────────────────────────────────────────────────────────────────


@pytest.fixture
def mem_db():
    """In-memory SQLite with the newsletter pipeline schema."""
    conn = sqlite3.connect(":memory:")
    conn.executescript("""
        CREATE TABLE processed_newsletters (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            advisor_name TEXT NOT NULL,
            message_id TEXT NOT NULL UNIQUE,
            provider TEXT NOT NULL,
            subject TEXT,
            received_at TEXT,
            body_hash TEXT,
            body_preview TEXT,
            synthesis_posted INTEGER DEFAULT 0,
            capture_id TEXT,
            processed_at TEXT DEFAULT (datetime('now'))
        );
        CREATE INDEX idx_pn_advisor ON processed_newsletters(advisor_name, received_at);
        CREATE INDEX idx_pn_msg ON processed_newsletters(message_id);
    """)
    conn.commit()
    yield conn
    conn.close()


@pytest.fixture
def sample_advisor_cfg():
    return {
        "name": "Test Advisor",
        "sender_match": "newsletter@test-advisor.com",
        "match_type": "exact",
        "brain_view": "personal",
        "capture_type": "observation",
        "action_item_keywords": ["recommend", "action", "consider", "target"],
        "section_headers": ["Market Commentary", "Key Takeaways"],
    }


@pytest.fixture
def sample_pipeline_cfg(tmp_path):
    return {
        "pipeline": {
            "dedupe_window_days": 7,
            "max_body_chars": 20000,
            "synthesis_timeout_sec": 180,
            "capture_api": {
                "url": "http://localhost:3002/api/v1/captures",
                "caller_header": "newsletter-pipeline",
            },
        },
        "advisors": [],
    }


# ── Test WI-2: DB init idempotency ────────────────────────────────────────────


def test_init_db_idempotent(tmp_path, monkeypatch):
    """init_db() can be called multiple times without error or data loss."""
    monkeypatch.setattr(_mod, "DB_PATH", tmp_path / "test.db")
    monkeypatch.setattr(_mod, "PIPE_DIR", tmp_path)

    conn1 = init_db()
    conn1.execute(
        "INSERT INTO processed_newsletters (advisor_name, message_id, provider) VALUES (?,?,?)",
        ("TestAdvisor", "msg-001", "hotmail"),
    )
    conn1.commit()
    conn1.close()

    # Second call must not drop tables
    conn2 = init_db()
    row = conn2.execute(
        "SELECT advisor_name FROM processed_newsletters WHERE message_id=?", ("msg-001",)
    ).fetchone()
    conn2.close()
    assert row is not None
    assert row[0] == "TestAdvisor"


# ── Test WI-4: parse_newsletter action item extraction ─────────────────────────


def test_parse_newsletter_extracts_action_items(sample_advisor_cfg):
    """parse_newsletter() finds lines containing action_item_keywords."""
    body = (
        "General market intro.\n\n"
        "Market Commentary\n"
        "Equities showed mixed performance.\n"
        "We recommend increasing allocation to bonds by 5%.\n"
        "Consider rebalancing your portfolio before year-end.\n\n"
        "Key Takeaways\n"
        "Target price for tech stocks revised upward.\n"
        "No action needed on fixed income.\n"
    )
    result = parse_newsletter(body, sample_advisor_cfg)
    assert len(result["action_items"]) >= 3
    # Should find lines with 'recommend', 'consider', 'target'
    item_text = " ".join(result["action_items"]).lower()
    assert "recommend" in item_text or "consider" in item_text or "target" in item_text


# ── Test WI-4: compute_diff dedup on matching hash ─────────────────────────────


def test_compute_diff_dedup_on_matching_hash(mem_db, sample_advisor_cfg):
    """compute_diff() returns DUPLICATE_SENTINEL when body hash matches prior posted row."""
    body = "Identical newsletter body text."
    h = _body_hash(body)
    preview = body[:500]
    # Insert a prior POSTED row with same hash
    mem_db.execute(
        "INSERT INTO processed_newsletters "
        "(advisor_name, message_id, provider, body_hash, body_preview, synthesis_posted, received_at) "
        "VALUES (?,?,?,?,?,1,'2026-04-01T08:00:00Z')",
        ("Test Advisor", "prior-msg-001", "hotmail", h, preview),
    )
    mem_db.commit()

    result = compute_diff(h, preview, mem_db, "Test Advisor")
    assert result == DUPLICATE_SENTINEL


# ── Test WI-4: compute_diff first newsletter ──────────────────────────────────


def test_compute_diff_first_newsletter(mem_db):
    """compute_diff() returns 'First newsletter' when DB is empty for advisor."""
    h = _body_hash("Some newsletter body")
    result = compute_diff(h, "Some newsletter body"[:500], mem_db, "New Advisor")
    assert "first" in result.lower()


# ── Test WI-4: compute_diff changed body ─────────────────────────────────────


def test_compute_diff_changed_body(mem_db):
    """compute_diff() returns a diff note (not sentinel) when hash differs."""
    prior_body = "Prior newsletter content."
    prior_hash = _body_hash(prior_body)
    mem_db.execute(
        "INSERT INTO processed_newsletters "
        "(advisor_name, message_id, provider, body_hash, body_preview, synthesis_posted, received_at) "
        "VALUES (?,?,?,?,?,1,'2026-04-01T08:00:00Z')",
        ("My Advisor", "old-msg-001", "hotmail", prior_hash, prior_body[:500]),
    )
    mem_db.commit()

    new_body = "Completely different newsletter content with new market views."
    new_hash = _body_hash(new_body)
    result = compute_diff(new_hash, new_body[:500], mem_db, "My Advisor")
    assert result != DUPLICATE_SENTINEL
    assert len(result) > 0


# ── Test WI-5: synthesis fallback on FileNotFoundError ───────────────────────


def test_synthesis_fallback_on_cli_not_found(sample_advisor_cfg, sample_pipeline_cfg):
    """synthesize_newsletter() returns None when claude CLI is not found."""
    with patch("subprocess.run", side_effect=FileNotFoundError("claude not found")):
        result = synthesize_newsletter(
            "Test Advisor",
            "Q1 2026 Newsletter",
            "2026-04-01T08:00:00Z",
            "Some body text",
            {"sections": {"(full)": "Some body text"}, "action_items": [], "word_count": 5},
            "First newsletter from this advisor.",
            sample_pipeline_cfg,
        )
    assert result is None


# ── Test WI-6: post_capture called on new newsletter ─────────────────────────


def test_post_capture_called_on_new_newsletter(
    mem_db, sample_advisor_cfg, sample_pipeline_cfg
):
    """process_newsletters() calls post_newsletter_capture for a new (non-dedup) newsletter."""
    newsletter = {
        "message_id": "new-msg-001",
        "provider": "hotmail",
        "advisor": sample_advisor_cfg,
        "subject": "April Newsletter",
        "sender": "newsletter@test-advisor.com",
        "received_at": "2026-04-01T08:00:00Z",
        "body_text": "New unique content " * 20,
    }

    posted_calls = []

    def fake_post(n, parsed, diff_note, synthesis, cfg):
        posted_calls.append(n["message_id"])
        return "capture-uuid-001"

    with patch.object(_mod, "synthesize_newsletter", return_value="## Synthesis"), \
         patch.object(_mod, "post_newsletter_capture", side_effect=fake_post):
        _mod.process_newsletters([newsletter], mem_db, sample_pipeline_cfg, dry_run=False)

    assert len(posted_calls) == 1
    assert posted_calls[0] == "new-msg-001"


# ── Test WI-6: post_capture skipped on dedup ─────────────────────────────────


def test_post_capture_skipped_on_dedup(
    mem_db, sample_advisor_cfg, sample_pipeline_cfg
):
    """process_newsletters() skips POST when body hash matches a prior posted row."""
    body = "Same newsletter content that was already processed."
    h = _body_hash(body)
    # Insert prior POSTED row
    mem_db.execute(
        "INSERT INTO processed_newsletters "
        "(advisor_name, message_id, provider, body_hash, body_preview, synthesis_posted, received_at) "
        "VALUES (?,?,?,?,?,1,'2026-04-01T08:00:00Z')",
        ("Test Advisor", "prior-dedup-msg", "hotmail", h, body[:500]),
    )
    mem_db.commit()

    newsletter = {
        "message_id": "duplicate-msg-001",
        "provider": "hotmail",
        "advisor": sample_advisor_cfg,
        "subject": "April Newsletter",
        "sender": "newsletter@test-advisor.com",
        "received_at": "2026-04-08T08:00:00Z",
        "body_text": body,
    }

    post_calls = []

    def fake_post(n, parsed, diff_note, synthesis, cfg):
        post_calls.append(n["message_id"])
        return "some-capture-id"

    with patch.object(_mod, "post_newsletter_capture", side_effect=fake_post):
        stats = _mod.process_newsletters(
            [newsletter], mem_db, sample_pipeline_cfg, dry_run=False
        )

    assert len(post_calls) == 0
    assert stats["skipped_dup"] == 1
