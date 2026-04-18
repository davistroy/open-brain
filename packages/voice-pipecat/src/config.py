"""Configuration for the voice Pipecat service.

Loads from config/voice.yaml (mounted at /app/config/voice.yaml in Docker),
with environment variable overrides for secrets and runtime config.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Literal

import yaml
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


def _load_voice_yaml() -> dict[str, Any]:
    """Load voice.yaml from config directory."""
    # Docker mount: /app/config/voice.yaml
    # Local dev: ../../config/voice.yaml (relative to src/)
    candidates = [
        Path("/app/config/voice.yaml"),
        Path(__file__).parent.parent.parent.parent / "config" / "voice.yaml",
    ]
    for path in candidates:
        if path.exists():
            with open(path) as f:
                return yaml.safe_load(f) or {}
    return {}


_yaml_config = _load_voice_yaml()
_stt_config = _yaml_config.get("stt", {})
_tts_config = _yaml_config.get("tts", {})
_llm_config = _yaml_config.get("llm", {})
_session_config = _yaml_config.get("session", {})
_server_config = _yaml_config.get("server", {})


class Settings(BaseSettings):
    """Voice service settings. Env vars override YAML values."""

    # --- Server ---
    host: str = _server_config.get("host", "0.0.0.0")
    websocket_port: int = _server_config.get("websocket_port", 8765)
    health_port: int = _server_config.get("health_port", 8766)

    # --- STT (Deepgram) ---
    stt_provider: Literal["deepgram"] = _stt_config.get("provider", "deepgram")
    deepgram_api_key: str = Field(
        default="",
        description="Deepgram API key (from Bitwarden, never in config files)",
    )
    deepgram_model: str = _stt_config.get("model", "nova-2")
    deepgram_language: str = _stt_config.get("language", "en-US")
    deepgram_sample_rate: int = _stt_config.get("sample_rate", 16000)
    deepgram_encoding: str = _stt_config.get("encoding", "linear16")
    deepgram_interim_results: bool = _stt_config.get("interim_results", True)
    deepgram_utterance_end_ms: int = _stt_config.get("utterance_end_ms", 1000)
    deepgram_vad_events: bool = _stt_config.get("vad_events", True)
    deepgram_smart_format: bool = _stt_config.get("smart_format", True)

    # --- TTS ---
    tts_provider: Literal["kokoro", "piper", "deepgram"] = _tts_config.get("provider", "deepgram")
    tts_voice: str = _tts_config.get("voice", "aura-asteria-en")
    tts_sample_rate: int = _tts_config.get("sample_rate", 16000)

    # Kokoro-specific
    kokoro_model: str = _tts_config.get("kokoro_model", "kokoro-v0_19")
    kokoro_voice: str = _tts_config.get("kokoro_voice", "af_heart")

    # Piper-specific
    piper_model: str = _tts_config.get("piper_model", "en_US-lessac-medium")

    # --- LLM (Claude via Anthropic SDK) ---
    anthropic_api_key: str = Field(
        default="",
        description="Anthropic API key (from Bitwarden, never in config files)",
    )
    llm_model: str = _llm_config.get("model", "claude-sonnet-4-20250514")
    llm_max_tokens: int = _llm_config.get("max_tokens", 1024)
    llm_temperature: float = _llm_config.get("temperature", 0.7)
    llm_system_prompt: str = _llm_config.get(
        "system_prompt",
        (
            "You are Open Brain's voice assistant. You help the user capture thoughts, "
            "recall information, and think through ideas. Be concise and conversational. "
            "Speak naturally as if in a real-time conversation — keep responses short "
            "(1-3 sentences unless more detail is requested)."
        ),
    )

    # --- Session ---
    redis_url: str = Field(default="redis://localhost:6379")
    session_ttl_seconds: int = _session_config.get("ttl_seconds", 3600)
    silence_timeout_seconds: float = _session_config.get("silence_timeout_seconds", 30.0)

    # --- Core API ---
    core_api_url: str = Field(default="http://core-api:3000")

    # --- VAD (Silero) ---
    vad_threshold: float = _yaml_config.get("vad", {}).get("threshold", 0.5)
    vad_min_speech_ms: int = _yaml_config.get("vad", {}).get("min_speech_ms", 250)
    vad_min_silence_ms: int = _yaml_config.get("vad", {}).get("min_silence_ms", 300)

    model_config = SettingsConfigDict(
        env_prefix="",
        case_sensitive=False,
    )


# Singleton — import this from other modules
settings = Settings()
