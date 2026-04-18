"""FastAPI health endpoint for the voice Pipecat service.

Reports:
- Service status (healthy/unhealthy)
- Model loaded status (STT, LLM, TTS availability)
- Active session count
- TTS provider and availability
- Uptime
"""

from __future__ import annotations

import logging
import time
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import Any

from fastapi import FastAPI
from fastapi.responses import JSONResponse

from .config import settings
from .session import SessionManager

logger = logging.getLogger(__name__)

_start_time: float = 0.0
_session_manager: SessionManager | None = None


def _check_api_key(key_name: str, key_value: str) -> dict[str, Any]:
    """Check if an API key is configured (non-empty)."""
    configured = bool(key_value and key_value.strip())
    return {
        "configured": configured,
        "status": "ready" if configured else "missing",
    }


def _check_tts_provider() -> dict[str, Any]:
    """Check TTS provider availability."""
    provider = settings.tts_provider
    result: dict[str, Any] = {"provider": provider}

    if provider == "kokoro":
        try:
            import kokoro  # noqa: F401

            result["status"] = "available"
            result["type"] = "local"
        except ImportError:
            result["status"] = "unavailable"
            result["fallback"] = "deepgram"
    elif provider == "piper":
        try:
            import piper  # noqa: F401

            result["status"] = "available"
            result["type"] = "local"
        except ImportError:
            result["status"] = "unavailable"
            result["fallback"] = "deepgram"
    elif provider == "deepgram":
        result["status"] = "available" if settings.deepgram_api_key else "missing_key"
        result["type"] = "cloud"
    else:
        result["status"] = "unknown_provider"

    return result


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Manage health endpoint lifecycle."""
    global _start_time, _session_manager
    _start_time = time.monotonic()
    _session_manager = SessionManager()
    logger.info(f"Health endpoint starting on port {settings.health_port}")
    yield
    if _session_manager:
        await _session_manager.close()


app = FastAPI(
    title="Open Brain Voice Pipecat Health",
    version="0.1.0",
    lifespan=lifespan,
)


@app.get("/health")
async def health_check() -> JSONResponse:
    """Return service health status.

    Reports on:
    - Overall status (healthy if all required services are configured)
    - STT readiness (Deepgram API key present)
    - LLM readiness (Anthropic API key present)
    - TTS provider and availability
    - Active voice session count
    - Service uptime
    """
    stt_status = _check_api_key("deepgram", settings.deepgram_api_key)
    llm_status = _check_api_key("anthropic", settings.anthropic_api_key)
    tts_status = _check_tts_provider()

    # Redis / session count
    active_sessions = 0
    redis_status = "unknown"
    if _session_manager:
        try:
            active_sessions = await _session_manager.get_active_session_count()
            redis_status = "connected"
        except Exception as e:
            logger.warning(f"Redis health check failed: {e}")
            redis_status = "disconnected"

    # Overall health: healthy if STT + LLM keys are present and Redis is up
    all_ready = (
        stt_status["status"] == "ready"
        and llm_status["status"] == "ready"
        and redis_status == "connected"
    )
    overall = "healthy" if all_ready else "unhealthy"
    status_code = 200 if all_ready else 503

    uptime_seconds = round(time.monotonic() - _start_time, 1) if _start_time else 0

    return JSONResponse(
        status_code=status_code,
        content={
            "status": overall,
            "service": "voice-pipecat",
            "version": "0.1.0",
            "timestamp": datetime.now(UTC).isoformat(),
            "uptime_seconds": uptime_seconds,
            "components": {
                "stt": {
                    "provider": "deepgram",
                    "model": settings.deepgram_model,
                    **stt_status,
                },
                "llm": {
                    "provider": "anthropic",
                    "model": settings.llm_model,
                    **llm_status,
                },
                "tts": tts_status,
                "redis": {
                    "status": redis_status,
                    "url": settings.redis_url.split("@")[-1]
                    if "@" in settings.redis_url
                    else settings.redis_url,
                },
            },
            "sessions": {
                "active": active_sessions,
            },
        },
    )
