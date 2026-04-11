"""Tests for session management."""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.session import SessionManager, SESSION_KEY_PREFIX, ACTIVE_SESSIONS_KEY


@pytest.fixture
def mock_redis():
    """Create a mock Redis client."""
    r = AsyncMock()
    r.get = AsyncMock(return_value=None)
    r.set = AsyncMock()
    r.sadd = AsyncMock()
    r.srem = AsyncMock()
    r.scard = AsyncMock(return_value=0)
    r.smembers = AsyncMock(return_value=set())
    r.aclose = AsyncMock()
    return r


@pytest.fixture
def session_mgr(mock_redis):
    """Create a session manager with mocked Redis."""
    return SessionManager(redis_client=mock_redis)


@pytest.mark.asyncio
async def test_start_session(session_mgr, mock_redis):
    """Starting a session should store data in Redis and track as active."""
    result = await session_mgr.start_session("test-123")
    assert result["session_id"] == "test-123"
    assert result["status"] == "active"
    assert result["turn_count"] == 0
    assert result["transcript"] == []
    mock_redis.set.assert_called_once()
    mock_redis.sadd.assert_called_once_with(ACTIVE_SESSIONS_KEY, "test-123")


@pytest.mark.asyncio
async def test_end_session(session_mgr, mock_redis):
    """Ending a session should update status and remove from active set."""
    session_data = {
        "session_id": "test-123",
        "status": "active",
        "started_at": "2026-04-11T00:00:00+00:00",
        "ended_at": None,
        "turn_count": 5,
        "transcript": [],
    }
    mock_redis.get = AsyncMock(return_value=json.dumps(session_data))

    result = await session_mgr.end_session("test-123")
    assert result is not None
    assert result["status"] == "ended"
    assert result["ended_at"] is not None
    mock_redis.srem.assert_called_once_with(ACTIVE_SESSIONS_KEY, "test-123")


@pytest.mark.asyncio
async def test_end_session_not_found(session_mgr, mock_redis):
    """Ending a nonexistent session should return None."""
    mock_redis.get = AsyncMock(return_value=None)
    result = await session_mgr.end_session("nonexistent")
    assert result is None


@pytest.mark.asyncio
async def test_increment_turn(session_mgr, mock_redis):
    """Incrementing turns should update the count."""
    session_data = {
        "session_id": "test-123",
        "status": "active",
        "started_at": "2026-04-11T00:00:00+00:00",
        "ended_at": None,
        "turn_count": 3,
        "transcript": [],
    }
    mock_redis.get = AsyncMock(return_value=json.dumps(session_data))

    count = await session_mgr.increment_turn("test-123")
    assert count == 4


@pytest.mark.asyncio
async def test_increment_turn_not_found(session_mgr, mock_redis):
    """Incrementing turns for a nonexistent session should return -1."""
    mock_redis.get = AsyncMock(return_value=None)
    count = await session_mgr.increment_turn("nonexistent")
    assert count == -1


@pytest.mark.asyncio
async def test_get_active_session_count(session_mgr, mock_redis):
    """Should return the count from Redis SCARD."""
    mock_redis.scard = AsyncMock(return_value=3)
    count = await session_mgr.get_active_session_count()
    assert count == 3


@pytest.mark.asyncio
async def test_get_active_session_ids(session_mgr, mock_redis):
    """Should return set members as a list."""
    mock_redis.smembers = AsyncMock(return_value={"a", "b", "c"})
    ids = await session_mgr.get_active_session_ids()
    assert sorted(ids) == ["a", "b", "c"]


# --- Transcript accumulator tests ---


@pytest.mark.asyncio
async def test_add_transcript_turn(session_mgr, mock_redis):
    """Should append a turn to the transcript and update turn count."""
    session_data = {
        "session_id": "test-t1",
        "status": "active",
        "started_at": "2026-04-11T00:00:00+00:00",
        "ended_at": None,
        "turn_count": 0,
        "transcript": [],
    }
    mock_redis.get = AsyncMock(return_value=json.dumps(session_data))

    count = await session_mgr.add_transcript_turn(
        "test-t1", "user", "I have an idea about deployment."
    )
    assert count == 1

    # Verify the data written to Redis
    call_args = mock_redis.set.call_args
    stored = json.loads(call_args[0][1])
    assert len(stored["transcript"]) == 1
    assert stored["transcript"][0]["role"] == "user"
    assert stored["transcript"][0]["text"] == "I have an idea about deployment."
    assert "timestamp" in stored["transcript"][0]
    assert stored["turn_count"] == 1


@pytest.mark.asyncio
async def test_add_transcript_turn_multiple(session_mgr, mock_redis):
    """Should accumulate multiple turns."""
    session_data = {
        "session_id": "test-t2",
        "status": "active",
        "started_at": "2026-04-11T00:00:00+00:00",
        "ended_at": None,
        "turn_count": 1,
        "transcript": [
            {"role": "user", "text": "First turn.", "timestamp": "2026-04-11T10:00:00+00:00"},
        ],
    }
    mock_redis.get = AsyncMock(return_value=json.dumps(session_data))

    count = await session_mgr.add_transcript_turn(
        "test-t2", "assistant", "I understand. Tell me more."
    )
    assert count == 2

    stored = json.loads(mock_redis.set.call_args[0][1])
    assert len(stored["transcript"]) == 2
    assert stored["transcript"][1]["role"] == "assistant"


@pytest.mark.asyncio
async def test_add_transcript_turn_not_found(session_mgr, mock_redis):
    """Adding a turn to a nonexistent session should return -1."""
    mock_redis.get = AsyncMock(return_value=None)
    count = await session_mgr.add_transcript_turn("nonexistent", "user", "test")
    assert count == -1


@pytest.mark.asyncio
async def test_get_transcript(session_mgr, mock_redis):
    """Should return the transcript for a session."""
    transcript = [
        {"role": "user", "text": "Hello", "timestamp": "2026-04-11T10:00:00+00:00"},
        {"role": "assistant", "text": "Hi!", "timestamp": "2026-04-11T10:00:05+00:00"},
    ]
    session_data = {
        "session_id": "test-t3",
        "status": "active",
        "started_at": "2026-04-11T00:00:00+00:00",
        "ended_at": None,
        "turn_count": 2,
        "transcript": transcript,
    }
    mock_redis.get = AsyncMock(return_value=json.dumps(session_data))

    result = await session_mgr.get_transcript("test-t3")
    assert len(result) == 2
    assert result[0]["role"] == "user"
    assert result[1]["role"] == "assistant"


@pytest.mark.asyncio
async def test_get_transcript_not_found(session_mgr, mock_redis):
    """Getting transcript for a nonexistent session should return empty list."""
    mock_redis.get = AsyncMock(return_value=None)
    result = await session_mgr.get_transcript("nonexistent")
    assert result == []


# --- Session-end callback tests ---


@pytest.mark.asyncio
async def test_session_end_callback_invoked(session_mgr, mock_redis):
    """Ending a session should invoke registered callbacks."""
    session_data = {
        "session_id": "test-cb1",
        "status": "active",
        "started_at": "2026-04-11T00:00:00+00:00",
        "ended_at": None,
        "turn_count": 1,
        "transcript": [{"role": "user", "text": "test", "timestamp": "2026-04-11T10:00:00+00:00"}],
    }
    mock_redis.get = AsyncMock(return_value=json.dumps(session_data))

    callback = AsyncMock()
    session_mgr.on_session_end(callback)

    await session_mgr.end_session("test-cb1")

    callback.assert_called_once()
    call_args = callback.call_args[0]
    assert call_args[0] == "test-cb1"
    assert call_args[1]["status"] == "ended"


@pytest.mark.asyncio
async def test_session_end_callback_failure_does_not_block(session_mgr, mock_redis):
    """A failing callback should not prevent session end from completing."""
    session_data = {
        "session_id": "test-cb2",
        "status": "active",
        "started_at": "2026-04-11T00:00:00+00:00",
        "ended_at": None,
        "turn_count": 0,
        "transcript": [],
    }
    mock_redis.get = AsyncMock(return_value=json.dumps(session_data))

    failing_callback = AsyncMock(side_effect=RuntimeError("extraction failed"))
    session_mgr.on_session_end(failing_callback)

    # Should not raise
    result = await session_mgr.end_session("test-cb2")
    assert result is not None
    assert result["status"] == "ended"


@pytest.mark.asyncio
async def test_multiple_session_end_callbacks(session_mgr, mock_redis):
    """All registered callbacks should be invoked."""
    session_data = {
        "session_id": "test-cb3",
        "status": "active",
        "started_at": "2026-04-11T00:00:00+00:00",
        "ended_at": None,
        "turn_count": 0,
        "transcript": [],
    }
    mock_redis.get = AsyncMock(return_value=json.dumps(session_data))

    cb1 = AsyncMock()
    cb2 = AsyncMock()
    session_mgr.on_session_end(cb1)
    session_mgr.on_session_end(cb2)

    await session_mgr.end_session("test-cb3")

    cb1.assert_called_once()
    cb2.assert_called_once()
