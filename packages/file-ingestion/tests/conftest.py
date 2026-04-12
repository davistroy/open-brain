"""Shared fixtures for file-ingestion tests."""

import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from src.extract import app

FIXTURES_DIR = Path(__file__).parent / "fixtures"


@pytest.fixture
def client():
    """FastAPI test client."""
    return TestClient(app)


@pytest.fixture
def fixtures_dir():
    """Path to test fixtures directory."""
    return FIXTURES_DIR
