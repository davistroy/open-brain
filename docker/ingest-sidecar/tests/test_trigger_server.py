"""Unit tests for ``trigger_server.py``.

Each test ties back to one of the three deploy-discovered bugs that
motivated Phase 4 (CS-γ):

* **PR #91** — env var name drift between the Python sidecar and the TS
  workers. The Python side read ``TRIGGER_SECRET`` while TS sent
  ``INGEST_TRIGGER_SECRET``. Defended here by ``test_config_reads_ingest_trigger_secret``
  + the auth-path tests which assert the sidecar genuinely rejects mismatched
  secrets (would have failed loudly in CI on PR #91's broken build).
* **PR #92** — Dockerfile CMD pointed at ``sleep infinity`` instead of
  ``python /app/trigger_server.py``. Defended here by
  ``test_main_entrypoint_structure`` + ``test_dockerfile_cmd_references_trigger_server``
  which together assert the module's ``__main__``/``main()``/``Config``/``create_app``
  contract exists and the Dockerfile still invokes it.
* **PR #93** — compose override forgot to set ``INGEST_SOURCE`` per sidecar,
  so both sidecars reported ``financial``. Defended here by
  ``test_config_binds_ingest_source_from_env`` and
  ``test_process_uses_bound_source_when_body_omits_it`` +
  ``test_process_body_can_override_bound_source``.
"""

from __future__ import annotations

import json
import re
import socket
import threading
import time
from http.client import HTTPConnection
from pathlib import Path
from unittest.mock import patch

# conftest.py adds the sidecar dir to sys.path.
import trigger_server  # noqa: E402


def auth_headers(secret: str = "test-secret") -> dict[str, str]:
    """Headers that satisfy ``check_auth`` for the default test secret."""
    return {
        "X-Open-Brain-Caller": "ingest",
        "Authorization": f"Bearer {secret}",
        "Content-Type": "application/json",
    }


def _pick_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


# ---------------------------------------------------------------------------
# Config.from_env
# ---------------------------------------------------------------------------


def test_config_from_env_defaults():
    """``Config.from_env({})`` yields documented defaults."""
    c = trigger_server.Config.from_env({})
    assert c.port == 8080
    assert c.bind_host == "0.0.0.0"
    assert c.ingest_trigger_secret == ""  # empty → POSTs rejected at runtime
    assert c.ingest_source == "financial"
    assert c.trigger_timeout_sec == 300
    assert c.lock_path == "/tmp/process.lock"


def test_config_reads_ingest_trigger_secret():
    """PR #91 regression: env var name MUST be ``INGEST_TRIGGER_SECRET``.

    If someone renames the field and forgets to update ``from_env`` (or
    vice-versa), the TS worker→sidecar handshake silently 401s in prod.
    """
    c = trigger_server.Config.from_env({"INGEST_TRIGGER_SECRET": "s3cret"})
    assert c.ingest_trigger_secret == "s3cret"


def test_config_binds_ingest_source_from_env():
    """PR #93 regression: each sidecar must read its own ``INGEST_SOURCE``.

    The bug that shipped was a compose-file oversight, but the Python side
    was complicit — if the Python code had ignored the env var, the
    compose fix would not have worked.
    """
    c = trigger_server.Config.from_env({"INGEST_SOURCE": "utility"})
    assert c.ingest_source == "utility"


# ---------------------------------------------------------------------------
# GET /healthz  — no auth, liveness probe
# ---------------------------------------------------------------------------


def test_healthz_returns_200(client):
    client.request("GET", "/healthz")
    resp = client.getresponse()
    assert resp.status == 200
    body = json.loads(resp.read())
    assert body == {"status": "ok"}


# ---------------------------------------------------------------------------
# Auth: POST /process rejects missing / bad credentials
# ---------------------------------------------------------------------------


def test_process_rejects_missing_auth(client):
    client.request("POST", "/process", body=b"{}")
    resp = client.getresponse()
    assert resp.status == 401
    body = json.loads(resp.read())
    assert body["reason"] == "bad-caller"


def test_process_rejects_wrong_bearer(client):
    headers = {
        "X-Open-Brain-Caller": "ingest",
        "Authorization": "Bearer wrong-secret",
        "Content-Type": "application/json",
    }
    client.request("POST", "/process", body=b"{}", headers=headers)
    resp = client.getresponse()
    assert resp.status == 401
    body = json.loads(resp.read())
    assert body["reason"] == "bad-token"


# ---------------------------------------------------------------------------
# POST /process — bound-source behavior (PR #93)
# ---------------------------------------------------------------------------


def test_process_uses_bound_source_when_body_omits_it(client, server):
    """PR #93 regression: empty body → run_pipeline gets config.ingest_source."""
    _, _, cfg = server
    observed: dict = {}

    def fake_run(config, source, extra_args=None):
        observed["source"] = source
        return {
            "status": "ok",
            "exit_code": 0,
            "stderr": "",
            "duration_ms": 1,
            "captures_posted": [],
            "errors": [],
        }

    with patch.object(trigger_server, "run_pipeline", fake_run):
        client.request(
            "POST",
            "/process",
            body=b"{}",
            headers=auth_headers(),
        )
        resp = client.getresponse()
        assert resp.status == 200
        resp.read()

    assert observed["source"] == cfg.ingest_source == "financial"


def test_process_body_can_override_bound_source(utility_config):
    """Body ``{"source": "financial"}`` wins over bound ``utility`` source."""
    # Build a one-off server bound to utility.
    port = _pick_port()
    bound = trigger_server.Config(
        port=port,
        bind_host="127.0.0.1",
        ingest_trigger_secret="test-secret",
        ingest_source="utility",
        trigger_timeout_sec=5,
        lock_path=utility_config.lock_path,
        app_dir=utility_config.app_dir,
    )
    httpd = trigger_server.create_app(bound)
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    time.sleep(0.05)

    observed: dict = {}

    def fake_run(config, source, extra_args=None):
        observed["source"] = source
        return {
            "status": "ok",
            "exit_code": 0,
            "stderr": "",
            "duration_ms": 1,
            "captures_posted": [],
            "errors": [],
        }

    try:
        with patch.object(trigger_server, "run_pipeline", fake_run):
            conn = HTTPConnection("127.0.0.1", port, timeout=5)
            conn.request(
                "POST",
                "/process",
                body=json.dumps({"source": "financial"}).encode(),
                headers=auth_headers(),
            )
            resp = conn.getresponse()
            assert resp.status == 200
            resp.read()
            conn.close()
    finally:
        httpd.shutdown()
        httpd.server_close()
        t.join(timeout=2.0)

    assert observed["source"] == "financial"


# ---------------------------------------------------------------------------
# POST /trigger/{source}
# ---------------------------------------------------------------------------


def test_trigger_path_source_routed_to_correct_script(client):
    """``/trigger/utility`` dispatches the utility pipeline, not financial."""
    observed: dict = {}

    def fake_run(config, source, extra_args=None):
        observed["source"] = source
        return {
            "status": "ok",
            "exit_code": 0,
            "stderr": "",
            "duration_ms": 1,
            "captures_posted": [],
            "errors": [],
        }

    with patch.object(trigger_server, "run_pipeline", fake_run):
        client.request(
            "POST",
            "/trigger/utility",
            body=b"",
            headers=auth_headers(),
        )
        resp = client.getresponse()
        assert resp.status == 200
        resp.read()

    assert observed["source"] == "utility"


# ---------------------------------------------------------------------------
# Error paths
# ---------------------------------------------------------------------------


def test_unknown_source_returns_500_with_structured_error(client):
    """run_pipeline returns ``status=error`` → handler surfaces HTTP 500."""

    def fake_run(config, source, extra_args=None):
        return {
            "status": "error",
            "error": f"unknown source: {source!r}",
            "exit_code": -1,
            "stderr": "",
            "duration_ms": 0,
            "captures_posted": [],
            "errors": [f"unknown source: {source!r}"],
        }

    with patch.object(trigger_server, "run_pipeline", fake_run):
        client.request(
            "POST",
            "/trigger/mystery",
            body=b"",
            headers=auth_headers(),
        )
        resp = client.getresponse()
        assert resp.status == 500
        body = json.loads(resp.read())
        assert body["status"] == "error"
        assert "unknown source" in body["error"]


def test_resolve_pipeline_script_unknown_source_returns_none(config):
    """Sanity check on the resolver used by run_pipeline."""
    assert trigger_server.resolve_pipeline_script(config, "mystery") is None
    # Known fallbacks resolve relative to app_dir.
    p = trigger_server.resolve_pipeline_script(config, "financial")
    assert p is not None and p.name == "financial-pipeline.py"


# ---------------------------------------------------------------------------
# Module contract — PR #92 "Dockerfile CMD was broken" regression
# ---------------------------------------------------------------------------


def test_main_entrypoint_structure():
    """PR #92 regression: ``main()``, ``Config``, ``create_app`` must all exist.

    If any of these get renamed, the Dockerfile CMD (``python /app/trigger_server.py``)
    would silently start a process that exits 0 with no server running. This
    test is intentionally shaped as a structure assertion so it catches
    rename-without-update.
    """
    assert hasattr(trigger_server, "Config")
    assert hasattr(trigger_server, "create_app")
    assert hasattr(trigger_server, "main")
    assert callable(trigger_server.main)
    # Module-level __main__ guard present (we can't execute it in pytest, but
    # we can verify it's there textually).
    source = Path(trigger_server.__file__).read_text(encoding="utf-8")
    assert 'if __name__ == "__main__":' in source
    assert "raise SystemExit(main())" in source


def test_dockerfile_cmd_references_trigger_server():
    """PR #92 regression: Dockerfile CMD must still invoke trigger_server.py.

    If CMD reverts to ``sleep infinity`` (the bug that shipped) or any other
    non-server command, this test fails. Guards against the exact class of
    regression that caused PR #92.
    """
    dockerfile = Path(trigger_server.__file__).parent / "Dockerfile"
    assert dockerfile.exists(), "sidecar Dockerfile not found"
    text = dockerfile.read_text(encoding="utf-8")
    # Must invoke trigger_server.py.
    assert "trigger_server.py" in text
    # Must NOT revert to sleep-as-pid-1.
    assert not re.search(
        r'^\s*CMD\s*\[?\s*"?sleep', text, re.MULTILINE
    ), "Dockerfile CMD uses sleep — PR #92 regression"
