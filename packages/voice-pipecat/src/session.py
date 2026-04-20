"""Redis-backed session state management for voice conversations.

Each voice session gets a Redis key with:
- Session metadata (start time, status)
- Active session tracking for health reporting
- Configurable TTL for automatic cleanup
- Transcript accumulator (list of turn dicts with role, text, timestamp)

Session data structure in Redis (JSON):
{
    "session_id": "uuid",
    "status": "active" | "ended",
    "started_at": "ISO timestamp",
    "ended_at": "ISO timestamp" | null,
    "turn_count": 0,
    "transcript": [
        {"role": "user"|"assistant", "text": "...", "timestamp": "ISO"}
    ]
}
"""

from __future__ import annotations

import json
import logging
from collections.abc import Callable, Coroutine
from datetime import UTC, datetime
from typing import Any

import redis.asyncio as aioredis

from .config import settings

logger = logging.getLogger(__name__)

# Redis key prefixes
SESSION_KEY_PREFIX = "ob:voice:session:"
ACTIVE_SESSIONS_KEY = "ob:voice:active_sessions"

# Type alias for session-end callback
SessionEndCallback = Callable[[str, dict[str, Any]], Coroutine[Any, Any, None]]


class SessionManager:
    """Manages voice session state in Redis.

    Tracks session lifecycle, accumulates transcript turns, and triggers
    capture extraction when a session ends.
    """

    def __init__(self, redis_client: aioredis.Redis | None = None) -> None:
        self._redis = redis_client
        self._on_session_end_callbacks: list[SessionEndCallback] = []

    def on_session_end(self, callback: SessionEndCallback) -> None:
        """Register a callback to be invoked when a session ends.

        The callback receives (session_id, session_data) and runs
        asynchronously. Failures are logged but do not block session cleanup.
        """
        self._on_session_end_callbacks.append(callback)

    async def _get_redis(self) -> aioredis.Redis:
        """Lazy-init Redis connection."""
        if self._redis is None:
            self._redis = aioredis.from_url(
                settings.redis_url,
                decode_responses=True,
            )
        return self._redis

    async def start_session(self, session_id: str) -> dict[str, Any]:
        """Initialize a new voice session.

        Args:
            session_id: Unique session identifier.

        Returns:
            Session data dict.
        """
        r = await self._get_redis()
        now = datetime.now(UTC).isoformat()
        session_data = {
            "session_id": session_id,
            "status": "active",
            "started_at": now,
            "ended_at": None,
            "turn_count": 0,
            "transcript": [],
        }
        key = f"{SESSION_KEY_PREFIX}{session_id}"
        await r.set(key, json.dumps(session_data), ex=settings.session_ttl_seconds)
        await r.sadd(ACTIVE_SESSIONS_KEY, session_id)  # type: ignore[misc]  # redis.asyncio stubs mis-type sadd as int (not Awaitable)
        logger.info(f"Session started: {session_id}")
        return session_data

    async def end_session(self, session_id: str) -> dict[str, Any] | None:
        """End a voice session and trigger capture extraction.

        Args:
            session_id: Session to end.

        Returns:
            Final session data, or None if session not found.
        """
        r = await self._get_redis()
        key = f"{SESSION_KEY_PREFIX}{session_id}"
        raw = await r.get(key)
        if raw is None:
            logger.warning(f"Session not found for end: {session_id}")
            return None

        session_data = json.loads(raw)
        session_data["status"] = "ended"
        session_data["ended_at"] = datetime.now(UTC).isoformat()
        # Keep the session data around for a while after ending (for review)
        await r.set(key, json.dumps(session_data), ex=settings.session_ttl_seconds)
        await r.srem(ACTIVE_SESSIONS_KEY, session_id)  # type: ignore[misc]  # redis.asyncio stubs mis-type srem as int (not Awaitable)
        logger.info(f"Session ended: {session_id} " f"(turns: {session_data.get('turn_count', 0)})")

        # Fire session-end callbacks (capture extraction, etc.)
        for callback in self._on_session_end_callbacks:
            try:
                await callback(session_id, session_data)
            except Exception:
                logger.exception(f"Session end callback failed for {session_id}")

        return session_data

    async def add_transcript_turn(
        self,
        session_id: str,
        role: str,
        text: str,
    ) -> int:
        """Append a turn to the session transcript and increment turn count.

        Args:
            session_id: Session to update.
            role: 'user' or 'assistant'.
            text: The transcribed/generated text for this turn.

        Returns:
            New turn count, or -1 if session not found.
        """
        r = await self._get_redis()
        key = f"{SESSION_KEY_PREFIX}{session_id}"
        raw = await r.get(key)
        if raw is None:
            return -1
        session_data = json.loads(raw)

        turn = {
            "role": role,
            "text": text,
            "timestamp": datetime.now(UTC).isoformat(),
        }
        session_data["transcript"].append(turn)
        session_data["turn_count"] = len(session_data["transcript"])

        await r.set(key, json.dumps(session_data), ex=settings.session_ttl_seconds)
        return session_data["turn_count"]

    async def increment_turn(self, session_id: str) -> int:
        """Increment the turn counter for a session (legacy compat).

        Returns:
            New turn count, or -1 if session not found.
        """
        r = await self._get_redis()
        key = f"{SESSION_KEY_PREFIX}{session_id}"
        raw = await r.get(key)
        if raw is None:
            return -1
        session_data = json.loads(raw)
        session_data["turn_count"] = session_data.get("turn_count", 0) + 1
        await r.set(key, json.dumps(session_data), ex=settings.session_ttl_seconds)
        return session_data["turn_count"]

    async def get_session(self, session_id: str) -> dict[str, Any] | None:
        """Get session data.

        Returns:
            Session data dict, or None if not found.
        """
        r = await self._get_redis()
        key = f"{SESSION_KEY_PREFIX}{session_id}"
        raw = await r.get(key)
        if raw is None:
            return None
        return json.loads(raw)

    async def get_transcript(self, session_id: str) -> list[dict[str, Any]]:
        """Get the transcript for a session.

        Returns:
            List of turn dicts, or empty list if session not found.
        """
        session = await self.get_session(session_id)
        if session is None:
            return []
        return session.get("transcript", [])

    async def get_active_session_count(self) -> int:
        """Get the number of currently active sessions."""
        r = await self._get_redis()
        return await r.scard(ACTIVE_SESSIONS_KEY)  # type: ignore[misc]  # redis.asyncio stubs mis-type scard as int (not Awaitable)

    async def get_active_session_ids(self) -> list[str]:
        """Get IDs of all active sessions."""
        r = await self._get_redis()
        members = await r.smembers(ACTIVE_SESSIONS_KEY)  # type: ignore[misc]  # redis.asyncio stubs mis-type smembers as Set (not Awaitable)
        return list(members)

    async def close(self) -> None:
        """Close the Redis connection."""
        if self._redis is not None:
            await self._redis.aclose()
            self._redis = None
