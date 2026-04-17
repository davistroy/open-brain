"""Shared pytest fixtures for trigger_server tests.

The sidecar lives at ``docker/ingest-sidecar/trigger_server.py`` and is not
packaged — we add the parent directory to ``sys.path`` so ``import
trigger_server`` works whether pytest is invoked from the repo root or from
within ``docker/ingest-sidecar``.
"""

from __future__ import annotations

import socket
import sys
import threading
import time
from http.client import HTTPConnection
from pathlib import Path

import pytest

# Make `import trigger_server` resolve regardless of pytest's cwd.
_SIDECAR_DIR = Path(__file__).resolve().parent.parent
if str(_SIDECAR_DIR) not in sys.path:
    sys.path.insert(0, str(_SIDECAR_DIR))

import trigger_server  # noqa: E402 — sys.path manipulation above


@pytest.fixture
def config(tmp_path: Path) -> trigger_server.Config:
    """Hermetic ``Config`` pointing at temp paths — no network, no /tmp writes."""
    return trigger_server.Config(
        port=0,  # kernel-assigned when bound; overridden by `server` fixture
        bind_host="127.0.0.1",
        ingest_trigger_secret="test-secret",
        ingest_source="financial",
        trigger_timeout_sec=5,
        lock_path=str(tmp_path / "process.lock"),
        app_dir=tmp_path,
    )


@pytest.fixture
def utility_config(tmp_path: Path) -> trigger_server.Config:
    """Same as ``config`` but bound to ``utility`` — proves per-sidecar binding."""
    return trigger_server.Config(
        port=0,
        bind_host="127.0.0.1",
        ingest_trigger_secret="test-secret",
        ingest_source="utility",
        trigger_timeout_sec=5,
        lock_path=str(tmp_path / "process.lock"),
        app_dir=tmp_path,
    )


def _pick_port() -> int:
    """Ask the OS for a free TCP port on loopback."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture
def server(config, monkeypatch):
    """Start a ``create_app(config)`` server in a background thread.

    Yields ``(host, port, config)`` so tests can open raw ``HTTPConnection``s
    and assert on status + body. Shuts down cleanly at teardown.
    """
    port = _pick_port()
    bound_config = trigger_server.Config(
        port=port,
        bind_host=config.bind_host,
        ingest_trigger_secret=config.ingest_trigger_secret,
        ingest_source=config.ingest_source,
        trigger_timeout_sec=config.trigger_timeout_sec,
        lock_path=config.lock_path,
        app_dir=config.app_dir,
        fallback_pipelines=config.fallback_pipelines,
        ingest_router=config.ingest_router,
    )
    httpd = trigger_server.create_app(bound_config)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    # Tiny wait so the accept loop is ready.
    time.sleep(0.05)
    try:
        yield (bound_config.bind_host, port, bound_config)
    finally:
        httpd.shutdown()
        httpd.server_close()
        thread.join(timeout=2.0)


@pytest.fixture
def client(server):
    """HTTPConnection pre-wired to the test server."""
    host, port, _ = server
    conn = HTTPConnection(host, port, timeout=5)
    try:
        yield conn
    finally:
        conn.close()


def auth_headers(secret: str = "test-secret") -> dict[str, str]:
    """Headers that satisfy ``check_auth`` for the default test secret."""
    return {
        "X-Open-Brain-Caller": "ingest",
        "Authorization": f"Bearer {secret}",
        "Content-Type": "application/json",
    }
