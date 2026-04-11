"""Tests for voice Pipecat configuration."""

from __future__ import annotations

import os
from unittest.mock import patch


def test_settings_defaults():
    """Settings should have sensible defaults without any env vars."""
    # Import with empty API keys (default) — just verifying the class loads
    with patch.dict(os.environ, {}, clear=False):
        from src.config import Settings
        s = Settings()
        assert s.websocket_port == 8765
        assert s.health_port == 8766
        assert s.stt_provider == "deepgram"
        assert s.deepgram_model == "nova-2"
        assert s.deepgram_language == "en-US"
        assert s.deepgram_sample_rate == 16000
        assert s.llm_max_tokens == 1024
        assert s.session_ttl_seconds == 3600
        assert s.vad_threshold == 0.5


def test_settings_env_override():
    """Environment variables should override YAML defaults."""
    with patch.dict(os.environ, {
        "DEEPGRAM_API_KEY": "test-dg-key",
        "ANTHROPIC_API_KEY": "test-ant-key",
        "REDIS_URL": "redis://custom:6380",
    }):
        from src.config import Settings
        s = Settings()
        assert s.deepgram_api_key == "test-dg-key"
        assert s.anthropic_api_key == "test-ant-key"
        assert s.redis_url == "redis://custom:6380"
