"""Entry point for the Open Brain Voice Pipecat service.

Starts two servers:
1. WebSocket server on port 8765 — accepts Pipecat audio streams
2. Health HTTP server on port 8766 — FastAPI health endpoint

The WebSocket server handles individual voice conversation sessions.
Each connection creates a new Pipecat pipeline instance with its own
session state tracked in Redis.
"""

from __future__ import annotations

import asyncio
import logging
import signal
import sys
import uuid
from typing import Any

import uvicorn

from .capture_extractor import handle_session_end
from .config import settings
from .health import app as health_app
from .session import SessionManager

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
)
logger = logging.getLogger("voice-pipecat")


def _validate_config() -> list[str]:
    """Validate required configuration. Returns list of errors."""
    errors: list[str] = []
    if not settings.deepgram_api_key:
        errors.append("DEEPGRAM_API_KEY is not set")
    if not settings.anthropic_api_key:
        errors.append("ANTHROPIC_API_KEY is not set")
    return errors


async def handle_websocket_connection(
    websocket: Any,
    path: str,
    session_manager: SessionManager,
) -> None:
    """Handle a single WebSocket voice session.

    Creates a unique session, builds a Pipecat pipeline, and runs
    until the session ends (participant leaves or timeout).
    """
    session_id = str(uuid.uuid4())
    logger.info(f"New WebSocket connection: session={session_id}, path={path}")

    try:
        from .pipeline import run_websocket_pipeline

        await run_websocket_pipeline(
            websocket=websocket,
            session_manager=session_manager,
            session_id=session_id,
        )
    except Exception:
        logger.exception(f"Session {session_id}: pipeline error")
    finally:
        # Ensure session is cleaned up
        session = await session_manager.get_session(session_id)
        if session and session.get("status") == "active":
            await session_manager.end_session(session_id)
        logger.info(f"Session {session_id}: connection closed")


async def run_websocket_server(session_manager: SessionManager) -> None:
    """Run the WebSocket server for voice connections.

    Uses Pipecat's built-in WebSocket server transport. Clients connect
    and stream audio; the pipeline handles STT -> LLM -> TTS and streams
    audio back.
    """
    try:
        import websockets

        async def handler(websocket, path="/"):
            await handle_websocket_connection(websocket, path, session_manager)

        server = await websockets.serve(
            handler,
            settings.host,
            settings.websocket_port,
        )
        logger.info(
            f"WebSocket server listening on ws://{settings.host}:{settings.websocket_port}"
        )
        await server.wait_closed()
    except ImportError:
        logger.error(
            "websockets package not installed. "
            "The Pipecat WebSocket transport requires it. "
            "Add 'websockets' to requirements.txt."
        )
        raise


async def run_health_server() -> None:
    """Run the FastAPI health endpoint server."""
    config = uvicorn.Config(
        health_app,
        host=settings.host,
        port=settings.health_port,
        log_level="warning",
    )
    server = uvicorn.Server(config)
    logger.info(
        f"Health endpoint listening on http://{settings.host}:{settings.health_port}/health"
    )
    await server.serve()


async def main() -> None:
    """Main entry point — runs WebSocket + health servers concurrently."""
    # Validate configuration
    errors = _validate_config()
    if errors:
        for err in errors:
            logger.error(f"Config error: {err}")
        logger.error(
            "Voice service cannot start without required API keys. "
            "Store keys in Bitwarden and pass via environment variables."
        )
        sys.exit(1)

    logger.info("=" * 60)
    logger.info("Open Brain Voice Pipecat Service")
    logger.info(f"  STT: Deepgram {settings.deepgram_model}")
    logger.info(f"  LLM: Claude ({settings.llm_model})")
    logger.info(f"  TTS: {settings.tts_provider} ({settings.tts_voice})")
    logger.info(f"  WebSocket port: {settings.websocket_port}")
    logger.info(f"  Health port: {settings.health_port}")
    logger.info(f"  Redis: {settings.redis_url}")
    logger.info("=" * 60)

    session_manager = SessionManager()

    # Register capture extraction on session end
    session_manager.on_session_end(handle_session_end)
    logger.info("Capture extraction registered for session-end events")

    # Handle graceful shutdown
    shutdown_event = asyncio.Event()

    def signal_handler():
        logger.info("Shutdown signal received")
        shutdown_event.set()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, signal_handler)
        except NotImplementedError:
            # Windows doesn't support add_signal_handler
            pass

    try:
        # Run both servers concurrently
        await asyncio.gather(
            run_websocket_server(session_manager),
            run_health_server(),
        )
    except asyncio.CancelledError:
        logger.info("Service shutting down")
    finally:
        await session_manager.close()
        logger.info("Voice Pipecat service stopped")


def cli_entry() -> None:
    """CLI entry point."""
    asyncio.run(main())


if __name__ == "__main__":
    cli_entry()
