"""Shared capture-API POST helper for Open Brain Python sidecar scripts.

Extracted from financial-pipeline.py (CS2.1) so financial-pipeline,
utility-pipeline, and future batch ingesters share a single POST path with
consistent nested-metadata envelope handling and Cloudflare-Access redirect
diagnostics.

Contract matches what core-api's createCaptureSchema expects:
    { content, source, capture_type, brain_view,
      metadata: { source_metadata } }

Env-var overrides (CAPTURE_API_URL / CAPTURE_API_CALLER) win over cfg so the
Docker sidecar can post to the internal container URL while the same config
file keeps the external URL for VM deployments.
"""

import logging
import os
import re

import requests

log = logging.getLogger("capture_api")


def get_capture_api_config(cfg: dict) -> tuple[str, str]:
    """Resolve (url, caller_header) with env-var override.

    Precedence: CAPTURE_API_URL / CAPTURE_API_CALLER > cfg.capture_api.url /
    caller_header > defaults.
    """
    cap_cfg = cfg.get("capture_api", {}) if cfg else {}
    url = os.environ.get("CAPTURE_API_URL") or cap_cfg.get(
        "url", "https://brain.troy-davis.com/api/v1/captures"
    )
    caller = os.environ.get("CAPTURE_API_CALLER") or cap_cfg.get(
        "caller_header", "financial-pipeline"
    )
    return url, caller


def post_capture(
    cfg: dict,
    content: str,
    source_metadata: dict,
    capture_type: str = "observation",
    brain_view: str = "personal",
) -> bool:
    """POST a capture; True on 200/201. See :func:`post_capture_with_id`."""
    ok, _ = post_capture_with_id(
        cfg, content, source_metadata, capture_type=capture_type, brain_view=brain_view
    )
    return ok


def post_capture_with_id(
    cfg: dict,
    content: str,
    source_metadata: dict,
    capture_type: str = "observation",
    brain_view: str = "personal",
) -> tuple[bool, str | None]:
    """POST a capture with the nested-metadata envelope core-api expects.

    Returns ``(ok, capture_id)``: ok is True on 200/201, and capture_id is the
    ``id`` core-api returns (``None`` when the body has none). The ingest
    sidecar must report these UUIDs in ``captures_posted`` — workers validate
    that list as UUIDs. Logs 3xx redirects distinctly so Cloudflare-Access traps
    are visible (unauthenticated POSTs to the public URL get 302'd to the login
    page).
    """
    url, caller = get_capture_api_config(cfg)
    try:
        resp = requests.post(
            url,
            json={
                "content": content,
                "source": "api",
                "capture_type": capture_type,
                "brain_view": brain_view,
                "metadata": {"source_metadata": source_metadata},
            },
            headers={
                "Content-Type": "application/json",
                "X-Open-Brain-Caller": caller,
            },
            timeout=30,
            allow_redirects=False,
        )
        if resp.status_code in (200, 201):
            log.info(f"Capture posted: {content[:60]}...")
            try:
                body = resp.json()
            except ValueError:
                body = None
            capture_id = body.get("id") if isinstance(body, dict) else None
            return True, capture_id if isinstance(capture_id, str) and capture_id else None
        elif resp.status_code in (301, 302, 303, 307, 308):
            loc = resp.headers.get("Location", "")[:120]
            log.warning(
                f"Brain POST {resp.status_code} redirect to {loc} — likely "
                f"Cloudflare Access; set CAPTURE_API_URL to an internal URL"
            )
            return False, None
        else:
            log.warning(f"Brain POST {resp.status_code}: {resp.text[:200]}")
            return False, None
    except requests.exceptions.RequestException as e:
        log.warning(f"Brain unreachable: {e}")
        return False, None


def get_api_base(cfg: dict) -> str:
    """Core-api base URL (no trailing slash), derived from the capture URL.

    Uses the same resolution as ``get_capture_api_config`` and strips the
    trailing ``/api/v1/captures`` (or ``/captures``) so the heartbeat route
    follows wherever captures go (internal container URL in the sidecar).
    """
    url, _ = get_capture_api_config(cfg)
    return re.sub(r"(/api/v1)?/captures/?$", "", url).rstrip("/")


def post_heartbeat(
    cfg: dict,
    source: str,
    ok: bool,
    errors: list[str] | None = None,
    meta: dict | None = None,
    caller: str | None = None,
) -> bool:
    """POST a run heartbeat to ``/api/v1/internal/heartbeat/<source>``.

    Returns True on 200. Never raises: a failed post is logged and returns
    False so the caller's own exit status is not masked.
    """
    _, default_caller = get_capture_api_config(cfg)
    url = f"{get_api_base(cfg)}/api/v1/internal/heartbeat/{source}"
    body: dict = {"ok": ok}
    if errors:
        body["errors"] = errors
    if meta:
        body["meta"] = meta
    try:
        resp = requests.post(
            url,
            json=body,
            headers={
                "Content-Type": "application/json",
                "X-Open-Brain-Caller": caller or default_caller,
            },
            timeout=10,
            allow_redirects=False,
        )
    except requests.exceptions.RequestException as e:
        log.warning(f"Heartbeat POST for {source} failed: {e}")
        return False
    if resp.status_code == 200:
        return True
    log.warning(f"Heartbeat POST for {source} returned {resp.status_code}: {resp.text[:200]}")
    return False
