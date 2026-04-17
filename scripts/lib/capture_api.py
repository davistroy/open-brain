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
    """POST a capture with the nested-metadata envelope core-api expects.

    Returns True on 200/201. Logs 3xx redirects distinctly so
    Cloudflare-Access traps are visible (unauthenticated POSTs to the
    public URL get 302'd to the login page).
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
            return True
        elif resp.status_code in (301, 302, 303, 307, 308):
            loc = resp.headers.get("Location", "")[:120]
            log.warning(
                f"Brain POST {resp.status_code} redirect to {loc} — likely "
                f"Cloudflare Access; set CAPTURE_API_URL to an internal URL"
            )
            return False
        else:
            log.warning(f"Brain POST {resp.status_code}: {resp.text[:200]}")
            return False
    except requests.exceptions.RequestException as e:
        log.warning(f"Brain unreachable: {e}")
        return False
