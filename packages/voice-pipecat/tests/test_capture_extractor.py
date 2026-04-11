"""Tests for capture extraction from voice conversation transcripts."""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.capture_extractor import (
    BRAIN_VIEWS,
    CAPTURE_TYPES,
    extract_captures,
    handle_session_end,
    post_captures_to_core_api,
    _format_transcript,
)


# --- Fixtures ---


@pytest.fixture
def sample_transcript():
    """A realistic conversation transcript."""
    return [
        {
            "role": "user",
            "text": "I decided to switch the deployment from Kubernetes to plain Docker Compose.",
            "timestamp": "2026-04-11T10:00:00+00:00",
        },
        {
            "role": "assistant",
            "text": "That's a pragmatic choice for a single-node setup. What drove that decision?",
            "timestamp": "2026-04-11T10:00:05+00:00",
        },
        {
            "role": "user",
            "text": "The hardware is a single server, and Kubernetes adds too much overhead. "
                    "Also I need to set up the CI pipeline by Friday.",
            "timestamp": "2026-04-11T10:00:15+00:00",
        },
    ]


@pytest.fixture
def empty_transcript():
    return []


@pytest.fixture
def assistant_only_transcript():
    return [
        {
            "role": "assistant",
            "text": "Hello! How can I help you today?",
            "timestamp": "2026-04-11T10:00:00+00:00",
        },
    ]


@pytest.fixture
def mock_anthropic_client():
    """Mock Anthropic client returning valid extraction JSON."""
    client = AsyncMock()

    # Build a proper response structure
    text_block = MagicMock()
    text_block.text = json.dumps([
        {
            "content": "Decided to switch deployment from Kubernetes to Docker Compose for the single-server setup.",
            "capture_type": "decision",
            "brain_view": "technical",
        },
        {
            "content": "CI pipeline setup deadline is Friday.",
            "capture_type": "task",
            "brain_view": "technical",
        },
    ])

    response = MagicMock()
    response.content = [text_block]
    client.messages.create = AsyncMock(return_value=response)
    return client


@pytest.fixture
def mock_anthropic_empty():
    """Mock Anthropic client returning empty extraction."""
    client = AsyncMock()
    text_block = MagicMock()
    text_block.text = "[]"
    response = MagicMock()
    response.content = [text_block]
    client.messages.create = AsyncMock(return_value=response)
    return client


@pytest.fixture
def mock_anthropic_bad_json():
    """Mock Anthropic client returning invalid JSON."""
    client = AsyncMock()
    text_block = MagicMock()
    text_block.text = "This is not JSON at all"
    response = MagicMock()
    response.content = [text_block]
    client.messages.create = AsyncMock(return_value=response)
    return client


# --- _format_transcript tests ---


def test_format_transcript(sample_transcript):
    """Should format turns into readable text."""
    result = _format_transcript(sample_transcript)
    assert "User:" in result
    assert "Assistant:" in result
    assert "Docker Compose" in result
    assert "2026-04-11" in result


def test_format_empty_transcript():
    """Empty transcript should produce empty string."""
    assert _format_transcript([]) == ""


# --- extract_captures tests ---


@pytest.mark.asyncio
async def test_extract_captures_success(sample_transcript, mock_anthropic_client):
    """Should extract captures from a valid transcript."""
    captures = await extract_captures(
        "test-session-1", sample_transcript, mock_anthropic_client
    )
    assert len(captures) == 2
    assert captures[0]["capture_type"] == "decision"
    assert captures[0]["brain_view"] == "technical"
    assert "Docker Compose" in captures[0]["content"]
    assert captures[1]["capture_type"] == "task"


@pytest.mark.asyncio
async def test_extract_captures_empty_transcript(empty_transcript):
    """Empty transcript should return no captures without calling LLM."""
    captures = await extract_captures("test-session-2", empty_transcript)
    assert captures == []


@pytest.mark.asyncio
async def test_extract_captures_assistant_only(assistant_only_transcript):
    """Transcript with no user turns should return no captures."""
    captures = await extract_captures(
        "test-session-3", assistant_only_transcript
    )
    assert captures == []


@pytest.mark.asyncio
async def test_extract_captures_empty_extraction(
    sample_transcript, mock_anthropic_empty
):
    """When LLM finds no captures, should return empty list."""
    captures = await extract_captures(
        "test-session-4", sample_transcript, mock_anthropic_empty
    )
    assert captures == []


@pytest.mark.asyncio
async def test_extract_captures_bad_json(
    sample_transcript, mock_anthropic_bad_json
):
    """Invalid JSON from LLM should return empty list, not raise."""
    captures = await extract_captures(
        "test-session-5", sample_transcript, mock_anthropic_bad_json
    )
    assert captures == []


@pytest.mark.asyncio
async def test_extract_captures_invalid_type_fallback(sample_transcript):
    """Invalid capture_type should fall back to 'observation'."""
    client = AsyncMock()
    text_block = MagicMock()
    text_block.text = json.dumps([
        {
            "content": "Some content here.",
            "capture_type": "nonsense_type",
            "brain_view": "technical",
        }
    ])
    response = MagicMock()
    response.content = [text_block]
    client.messages.create = AsyncMock(return_value=response)

    captures = await extract_captures("test-session-6", sample_transcript, client)
    assert len(captures) == 1
    assert captures[0]["capture_type"] == "observation"


@pytest.mark.asyncio
async def test_extract_captures_invalid_view_fallback(sample_transcript):
    """Invalid brain_view should fall back to 'personal'."""
    client = AsyncMock()
    text_block = MagicMock()
    text_block.text = json.dumps([
        {
            "content": "Some content here.",
            "capture_type": "idea",
            "brain_view": "nonexistent_view",
        }
    ])
    response = MagicMock()
    response.content = [text_block]
    client.messages.create = AsyncMock(return_value=response)

    captures = await extract_captures("test-session-7", sample_transcript, client)
    assert len(captures) == 1
    assert captures[0]["brain_view"] == "personal"


@pytest.mark.asyncio
async def test_extract_captures_skips_empty_content(sample_transcript):
    """Captures with empty content should be filtered out."""
    client = AsyncMock()
    text_block = MagicMock()
    text_block.text = json.dumps([
        {"content": "", "capture_type": "idea", "brain_view": "technical"},
        {"content": "Real content.", "capture_type": "idea", "brain_view": "technical"},
    ])
    response = MagicMock()
    response.content = [text_block]
    client.messages.create = AsyncMock(return_value=response)

    captures = await extract_captures("test-session-8", sample_transcript, client)
    assert len(captures) == 1
    assert captures[0]["content"] == "Real content."


@pytest.mark.asyncio
async def test_extract_captures_no_api_key():
    """Without API key and no client, should return empty list."""
    with patch("src.capture_extractor.settings") as mock_settings:
        mock_settings.anthropic_api_key = ""
        mock_settings.llm_model = "claude-sonnet-4-20250514"
        transcript = [{"role": "user", "text": "test", "timestamp": "2026-04-11T00:00:00+00:00"}]
        captures = await extract_captures("test-session-9", transcript)
        assert captures == []


# --- post_captures_to_core_api tests ---


@pytest.mark.asyncio
async def test_post_captures_success():
    """Should POST each capture and collect successful responses."""
    captures = [
        {"content": "Test decision", "capture_type": "decision", "brain_view": "technical"},
        {"content": "Test task", "capture_type": "task", "brain_view": "career"},
    ]

    mock_response_1 = MagicMock()
    mock_response_1.status_code = 201
    mock_response_1.json.return_value = {
        "id": "uuid-1",
        "pipeline_status": "queued",
        "created_at": "2026-04-11T10:00:00+00:00",
    }

    mock_response_2 = MagicMock()
    mock_response_2.status_code = 201
    mock_response_2.json.return_value = {
        "id": "uuid-2",
        "pipeline_status": "queued",
        "created_at": "2026-04-11T10:00:01+00:00",
    }

    with patch("src.capture_extractor.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(side_effect=[mock_response_1, mock_response_2])
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        results = await post_captures_to_core_api("sess-1", captures)

    assert len(results) == 2
    assert results[0]["id"] == "uuid-1"
    assert results[1]["id"] == "uuid-2"

    # Verify the payload structure
    call_args = mock_client.post.call_args_list
    for call in call_args:
        payload = call.kwargs.get("json") or call[1].get("json")
        assert payload["source"] == "voice"
        assert payload["metadata"]["source_metadata"]["session_id"] == "sess-1"


@pytest.mark.asyncio
async def test_post_captures_empty_list():
    """Empty captures list should return empty results."""
    results = await post_captures_to_core_api("sess-2", [])
    assert results == []


@pytest.mark.asyncio
async def test_post_captures_duplicate_handling():
    """409 Conflict (duplicate) should be logged but not raise."""
    captures = [
        {"content": "Duplicate", "capture_type": "idea", "brain_view": "personal"},
    ]

    mock_response = MagicMock()
    mock_response.status_code = 409
    mock_response.text = "Conflict"

    with patch("src.capture_extractor.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=mock_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        results = await post_captures_to_core_api("sess-3", captures)

    assert results == []  # 409s are not added to results


@pytest.mark.asyncio
async def test_post_captures_partial_failure():
    """Some POST failures should not prevent others from succeeding."""
    captures = [
        {"content": "Good one", "capture_type": "idea", "brain_view": "personal"},
        {"content": "Bad one", "capture_type": "task", "brain_view": "career"},
    ]

    import httpx

    mock_response_ok = MagicMock()
    mock_response_ok.status_code = 201
    mock_response_ok.json.return_value = {"id": "uuid-ok", "pipeline_status": "queued", "created_at": "2026-04-11T00:00:00+00:00"}

    with patch("src.capture_extractor.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(
            side_effect=[mock_response_ok, httpx.RequestError("connection refused")]
        )
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        results = await post_captures_to_core_api("sess-4", captures)

    assert len(results) == 1
    assert results[0]["id"] == "uuid-ok"


# --- handle_session_end tests ---


@pytest.mark.asyncio
async def test_handle_session_end_with_transcript():
    """Session end with transcript should extract and post captures."""
    session_data = {
        "session_id": "sess-end-1",
        "transcript": [
            {"role": "user", "text": "I decided to use Postgres.", "timestamp": "2026-04-11T10:00:00+00:00"},
            {"role": "assistant", "text": "Good choice.", "timestamp": "2026-04-11T10:00:05+00:00"},
        ],
    }

    with patch("src.capture_extractor.extract_captures") as mock_extract, \
         patch("src.capture_extractor.post_captures_to_core_api") as mock_post:
        mock_extract.return_value = [
            {"content": "Decision to use Postgres", "capture_type": "decision", "brain_view": "technical"},
        ]
        mock_post.return_value = [{"id": "uuid-1"}]

        await handle_session_end("sess-end-1", session_data)

        mock_extract.assert_called_once_with("sess-end-1", session_data["transcript"])
        mock_post.assert_called_once_with("sess-end-1", mock_extract.return_value)


@pytest.mark.asyncio
async def test_handle_session_end_empty_transcript():
    """Session end with empty transcript should skip extraction."""
    session_data = {"session_id": "sess-end-2", "transcript": []}

    with patch("src.capture_extractor.extract_captures") as mock_extract:
        await handle_session_end("sess-end-2", session_data)
        mock_extract.assert_not_called()


@pytest.mark.asyncio
async def test_handle_session_end_no_captures_found():
    """Session end where extraction finds nothing should not post."""
    session_data = {
        "session_id": "sess-end-3",
        "transcript": [
            {"role": "user", "text": "Hello", "timestamp": "2026-04-11T10:00:00+00:00"},
        ],
    }

    with patch("src.capture_extractor.extract_captures") as mock_extract, \
         patch("src.capture_extractor.post_captures_to_core_api") as mock_post:
        mock_extract.return_value = []

        await handle_session_end("sess-end-3", session_data)

        mock_extract.assert_called_once()
        mock_post.assert_not_called()
