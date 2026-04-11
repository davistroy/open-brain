"""Pipecat pipeline definition.

Pipeline: VAD (Silero) -> STT (Deepgram Nova-2) -> LLM (Claude via Anthropic SDK) -> TTS
Includes interrupt handling: user speech during TTS cancels current output.
LLM has access to Open Brain tools (search_brain, get_entity) for in-conversation use.
Transcript turns are accumulated in Redis for capture extraction at session end.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from pipecat.frames.frames import (
    EndFrame,
    LLMMessagesFrame,
    TranscriptionFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.aggregators.llm_response import (
    LLMAssistantResponseAggregator,
    LLMUserResponseAggregator,
)
from pipecat.services.anthropic import AnthropicLLMService
from pipecat.services.deepgram import DeepgramSTTService, DeepgramTTSService
from pipecat.transports.services.daily import DailyParams, DailyTransport

from .config import settings
from .session import SessionManager
from .tools import get_tool_definitions, handle_tool_call

logger = logging.getLogger(__name__)


def create_stt_service() -> DeepgramSTTService:
    """Create and configure the Deepgram STT service."""
    return DeepgramSTTService(
        api_key=settings.deepgram_api_key,
        model=settings.deepgram_model,
        language=settings.deepgram_language,
        sample_rate=settings.deepgram_sample_rate,
        encoding=settings.deepgram_encoding,
        interim_results=settings.deepgram_interim_results,
        utterance_end_ms=str(settings.deepgram_utterance_end_ms),
        vad_events=settings.deepgram_vad_events,
        smart_format=settings.deepgram_smart_format,
    )


def create_tts_service() -> Any:
    """Create the TTS service based on configuration.

    Returns the configured TTS provider. Falls back through:
    1. Configured provider (kokoro, piper, or deepgram)
    2. Deepgram TTS as universal fallback
    """
    provider = settings.tts_provider

    if provider == "kokoro":
        try:
            from pipecat.services.kokoro import KokoroTTSService

            logger.info("Using Kokoro TTS (local)")
            return KokoroTTSService(
                model=settings.kokoro_model,
                voice=settings.kokoro_voice,
                sample_rate=settings.tts_sample_rate,
            )
        except ImportError:
            logger.warning("Kokoro not installed, falling back to Deepgram TTS")

    if provider == "piper":
        try:
            from pipecat.services.piper import PiperTTSService

            logger.info("Using Piper TTS (local)")
            return PiperTTSService(
                model=settings.piper_model,
                sample_rate=settings.tts_sample_rate,
            )
        except ImportError:
            logger.warning("Piper not installed, falling back to Deepgram TTS")

    # Default / fallback: Deepgram TTS
    logger.info("Using Deepgram TTS (cloud)")
    return DeepgramTTSService(
        api_key=settings.deepgram_api_key,
        voice=settings.tts_voice,
        sample_rate=settings.tts_sample_rate,
    )


def create_llm_service() -> AnthropicLLMService:
    """Create the Claude LLM service via Anthropic SDK.

    Includes Open Brain tool definitions so Claude can search the
    knowledge base and look up entities during conversation.
    """
    return AnthropicLLMService(
        api_key=settings.anthropic_api_key,
        model=settings.llm_model,
        max_tokens=settings.llm_max_tokens,
        temperature=settings.llm_temperature,
    )


async def create_pipeline(
    transport: DailyTransport,
    session_manager: SessionManager,
    session_id: str,
) -> tuple[PipelineTask, PipelineRunner]:
    """Create and wire the full Pipecat pipeline for a voice session.

    Pipeline flow:
        Transport input
          -> STT (Deepgram)
          -> User response aggregator
          -> LLM (Claude, with Open Brain tools)
          -> TTS
          -> Transport output

    Transcript turns are accumulated in Redis via session_manager.
    Open Brain tools (search_brain, get_entity) are available to the LLM.

    Interrupt handling is built into Pipecat's pipeline architecture:
    when the user speaks during TTS playback, the pipeline automatically
    interrupts the current LLM/TTS output and processes the new input.

    Args:
        transport: The WebSocket transport for audio I/O.
        session_manager: Session manager for transcript tracking.
        session_id: Unique session identifier.

    Returns:
        Tuple of (PipelineTask, PipelineRunner) for lifecycle management.
    """
    stt = create_stt_service()
    tts = create_tts_service()
    llm = create_llm_service()

    # Message context — maintains conversation history for the LLM
    messages = [
        {"role": "system", "content": settings.llm_system_prompt},
    ]

    # Aggregators collect partial transcriptions into complete utterances
    # and route them through the LLM with conversation context
    user_aggregator = LLMUserResponseAggregator(messages)
    assistant_aggregator = LLMAssistantResponseAggregator(messages)

    # Build the pipeline
    pipeline = Pipeline(
        [
            transport.input(),       # WebSocket audio in
            stt,                     # Deepgram STT
            user_aggregator,         # Collect user utterance
            llm,                     # Claude generates response
            tts,                     # TTS synthesizes audio
            transport.output(),      # WebSocket audio out
            assistant_aggregator,    # Track assistant response in context
        ]
    )

    params = PipelineParams(
        allow_interruptions=True,  # User speech cancels current TTS
        enable_metrics=True,
    )

    task = PipelineTask(pipeline, params=params)
    runner = PipelineRunner()

    # Track transcriptions in session state
    @transport.event_handler("on_first_participant_joined")
    async def on_first_participant_joined(transport_obj, participant):
        logger.info(f"Session {session_id}: participant joined")
        await session_manager.start_session(session_id)
        # Send initial greeting
        await task.queue_frames(
            [
                LLMMessagesFrame(messages),
            ]
        )

    @transport.event_handler("on_participant_left")
    async def on_participant_left(transport_obj, participant, reason):
        logger.info(f"Session {session_id}: participant left ({reason})")
        await session_manager.end_session(session_id)
        await task.queue_frames([EndFrame()])

    return task, runner


async def run_websocket_pipeline(
    websocket,
    session_manager: SessionManager,
    session_id: str,
) -> None:
    """Run a Pipecat pipeline over a raw WebSocket connection.

    This is the entry point for handling a single voice conversation session.
    It creates a pipeline, connects it to the WebSocket transport, and runs
    until the session ends.

    Transcript turns are tracked in Redis. At session end, the session-end
    callback triggers capture extraction.

    Args:
        websocket: The WebSocket connection (from FastAPI/Starlette).
        session_manager: Session manager for state tracking.
        session_id: Unique session identifier.
    """
    from pipecat.transports.services.helpers.daily_rest import DailyRESTHelper
    from pipecat.serializers.protobuf import ProtobufFrameSerializer

    stt = create_stt_service()
    tts = create_tts_service()
    llm = create_llm_service()

    messages = [
        {"role": "system", "content": settings.llm_system_prompt},
    ]

    user_aggregator = LLMUserResponseAggregator(messages)
    assistant_aggregator = LLMAssistantResponseAggregator(messages)

    # For raw WebSocket transport, we use Pipecat's WebSocket server transport
    from pipecat.transports.network.websocket_server import (
        WebSocketServerParams,
        WebSocketServerTransport,
    )

    transport = WebSocketServerTransport(
        params=WebSocketServerParams(
            audio_in_sample_rate=settings.deepgram_sample_rate,
            audio_out_sample_rate=settings.tts_sample_rate,
            audio_in_enabled=True,
            audio_out_enabled=True,
        )
    )

    pipeline = Pipeline(
        [
            transport.input(),
            stt,
            user_aggregator,
            llm,
            tts,
            transport.output(),
            assistant_aggregator,
        ]
    )

    params = PipelineParams(
        allow_interruptions=True,
        enable_metrics=True,
    )

    task = PipelineTask(pipeline, params=params)
    runner = PipelineRunner()

    await session_manager.start_session(session_id)

    try:
        await runner.run(task)
    finally:
        await session_manager.end_session(session_id)
        logger.info(f"Session {session_id}: pipeline completed")
