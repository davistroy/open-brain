"""The sidecar reports real capture UUIDs in ``captures_posted`` (Phase 9 e2e).

``workers`` validates the trigger response with
``captures_posted: z.array(z.string().uuid())`` (packages/shared/src/schema/ingest.ts).
Both pipelines used to append ``content[:80]`` — a text preview — so every upload
failed zod validation and ended ``failed``. The CI e2e hid this behind
``continue-on-error`` until Phase 9 removed it.

No network: ``requests.post`` and the pipelines' POST helpers are stubbed.
"""

from __future__ import annotations

import importlib.util
import sys
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

_SCRIPTS_DIR = Path(__file__).resolve().parents[3] / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from lib import capture_api  # noqa: E402


def _load(module_name: str, file_name: str) -> Any:
    if module_name in sys.modules:
        return sys.modules[module_name]
    spec = importlib.util.spec_from_file_location(module_name, _SCRIPTS_DIR / file_name)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = mod
    spec.loader.exec_module(mod)
    return mod


fp = _load("financial_pipeline", "financial-pipeline.py")
up = _load("utility_pipeline", "utility-pipeline.py")

CAPTURE_ID = "5f0c2b1e-8a3d-4c7e-9b2a-0d1e2f3a4b5c"


class _Resp:
    def __init__(self, status: int, payload: Any = None, text: str = "") -> None:
        self.status_code = status
        self._payload = payload
        self.text = text
        self.headers: dict[str, str] = {}

    def json(self) -> Any:
        if self._payload is None:
            raise ValueError("no json")
        return self._payload


@pytest.fixture(autouse=True)
def _isolate() -> Iterator[None]:
    for mod in (fp, up):
        mod._JSON_CAPTURES_POSTED.clear()
        mod._JSON_ERRORS.clear()
    yield
    for mod in (fp, up):
        mod._JSON_CAPTURES_POSTED.clear()
        mod._JSON_ERRORS.clear()


# ── shared helper ────────────────────────────────────────────────────────────


def test_post_capture_with_id_returns_the_created_capture_id(monkeypatch):
    monkeypatch.setattr(
        capture_api.requests,
        "post",
        lambda *a, **k: _Resp(201, {"id": CAPTURE_ID, "pipeline_status": "pending"}),
    )
    assert capture_api.post_capture_with_id({}, "fake content", {}) == (True, CAPTURE_ID)


def test_post_capture_with_id_ok_without_id_body(monkeypatch):
    monkeypatch.setattr(capture_api.requests, "post", lambda *a, **k: _Resp(201, None))
    assert capture_api.post_capture_with_id({}, "fake content", {}) == (True, None)


def test_post_capture_with_id_failure(monkeypatch):
    monkeypatch.setattr(capture_api.requests, "post", lambda *a, **k: _Resp(500, text="boom"))
    assert capture_api.post_capture_with_id({}, "fake content", {}) == (False, None)


def test_post_capture_still_returns_bool(monkeypatch):
    monkeypatch.setattr(
        capture_api.requests, "post", lambda *a, **k: _Resp(201, {"id": CAPTURE_ID})
    )
    assert capture_api.post_capture({}, "fake content", {}) is True


# ── pipelines report the UUID, never a text preview ──────────────────────────


@pytest.mark.parametrize(
    "mod, wrapper, raw",
    [
        (fp, "_post_capture", "_post_capture_raw"),
        (up, "_post_capture_raw", "_post_capture_unwrapped"),
    ],
)
def test_pipeline_reports_capture_uuid(monkeypatch, mod, wrapper, raw):
    monkeypatch.setattr(mod, "_JSON_OUTPUT_MODE", True)
    monkeypatch.setattr(mod, raw, lambda *a, **k: (True, CAPTURE_ID))
    assert getattr(mod, wrapper)({}, "FAKE TEXT THAT IS NOT A UUID", {}) is True
    assert mod._JSON_CAPTURES_POSTED == [CAPTURE_ID]


@pytest.mark.parametrize(
    "mod, wrapper, raw",
    [
        (fp, "_post_capture", "_post_capture_raw"),
        (up, "_post_capture_raw", "_post_capture_unwrapped"),
    ],
)
def test_pipeline_skips_a_post_with_no_id(monkeypatch, mod, wrapper, raw):
    monkeypatch.setattr(mod, "_JSON_OUTPUT_MODE", True)
    monkeypatch.setattr(mod, raw, lambda *a, **k: (True, None))
    assert getattr(mod, wrapper)({}, "FAKE TEXT", {}) is True
    assert mod._JSON_CAPTURES_POSTED == []
