"""Tests for the health endpoint."""

from __future__ import annotations

import os
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client():
    """Create a test client for the health endpoint."""
    # Patch session manager before importing the app
    with patch("src.health.SessionManager") as MockSM:
        mock_sm = AsyncMock()
        mock_sm.get_active_session_count = AsyncMock(return_value=2)
        mock_sm.close = AsyncMock()
        MockSM.return_value = mock_sm

        from src.health import app
        with TestClient(app) as c:
            yield c


def test_health_endpoint_exists(client):
    """Health endpoint should respond."""
    response = client.get("/health")
    assert response.status_code in (200, 503)
    data = response.json()
    assert "status" in data
    assert "components" in data
    assert "sessions" in data


def test_health_reports_service_name(client):
    """Health should identify itself as voice-pipecat."""
    response = client.get("/health")
    data = response.json()
    assert data["service"] == "voice-pipecat"


def test_health_reports_components(client):
    """Health should report STT, LLM, TTS, and Redis status."""
    response = client.get("/health")
    data = response.json()
    components = data["components"]
    assert "stt" in components
    assert "llm" in components
    assert "tts" in components
    assert "redis" in components
    assert components["stt"]["provider"] == "deepgram"
    assert components["llm"]["provider"] == "anthropic"
