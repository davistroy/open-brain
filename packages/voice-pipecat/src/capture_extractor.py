"""Extract captures from voice conversation transcripts at session end.

When a voice session ends (silence timeout, user says "done", or disconnect),
this module uses Claude to analyze the conversation transcript, identify
discrete knowledge captures, classify each one, and POST them to core-api
for standard pipeline processing.

Each capture gets:
- source: 'voice'
- capture_type: Claude classifies (decision, idea, observation, task, etc.)
- brain_view: Claude classifies (career, personal, technical, work-internal, client)
- content: extracted text from conversation
- metadata.source_metadata.session_id: links back to voice session
"""

from __future__ import annotations

import json
import logging
from typing import Any

import anthropic
import httpx

from .config import settings

logger = logging.getLogger(__name__)

# Valid capture types — must match core-api createCaptureSchema
CAPTURE_TYPES = [
    "decision",
    "idea",
    "observation",
    "task",
    "win",
    "blocker",
    "question",
    "reflection",
]

# Valid brain views — must match config/brain-views.yaml
BRAIN_VIEWS = ["career", "personal", "technical", "work-internal", "client"]

# Timeout for core-api calls
_HTTP_TIMEOUT = httpx.Timeout(15.0, connect=5.0)

# Prompt for capture extraction
EXTRACTION_PROMPT = """\
You are a knowledge capture analyst. Analyze the following voice conversation transcript \
and extract discrete pieces of information worth remembering.

For each capture, provide:
1. **content**: A clear, self-contained summary of the information (not the raw transcript — \
write it as a standalone note that makes sense without the conversation context).
2. **capture_type**: One of: decision, idea, observation, task, win, blocker, question, reflection
3. **brain_view**: One of: career, personal, technical, work-internal, client

Rules:
- Extract ONLY substantive information — skip greetings, small talk, and meta-conversation.
- Each capture should be self-contained and useful on its own.
- If the conversation contains no substantive captures, return an empty array.
- Combine related points into a single capture rather than splitting granularly.
- For tasks, include any deadlines or assignees mentioned.
- For decisions, include the reasoning if stated.

Respond with a JSON array (no markdown fencing):
[
  {
    "content": "...",
    "capture_type": "...",
    "brain_view": "..."
  }
]

If there are no captures worth extracting, respond with: []

TRANSCRIPT:
"""


def _format_transcript(transcript: list[dict[str, Any]]) -> str:
    """Format transcript turns into readable text for the LLM.

    Args:
        transcript: List of turn dicts with role, text, timestamp.

    Returns:
        Formatted transcript string.
    """
    lines: list[str] = []
    for turn in transcript:
        role = turn.get("role", "unknown")
        text = turn.get("text", "")
        timestamp = turn.get("timestamp", "")
        prefix = "User" if role == "user" else "Assistant"
        lines.append(f"[{timestamp}] {prefix}: {text}")
    return "\n".join(lines)


async def extract_captures(
    session_id: str,
    transcript: list[dict[str, Any]],
    anthropic_client: anthropic.AsyncAnthropic | None = None,
) -> list[dict[str, Any]]:
    """Use Claude to extract captures from a conversation transcript.

    Args:
        session_id: Session ID for logging and metadata.
        transcript: List of transcript turn dicts.
        anthropic_client: Optional pre-configured client (for testing).

    Returns:
        List of capture dicts with content, capture_type, brain_view.
        Empty list if no captures found or on error.
    """
    if not transcript:
        logger.info(f"Session {session_id}: empty transcript, no captures to extract")
        return []

    # Filter to user turns only for extraction — assistant turns are our own responses
    user_turns = [t for t in transcript if t.get("role") == "user"]
    if not user_turns:
        logger.info(f"Session {session_id}: no user turns, skipping extraction")
        return []

    formatted = _format_transcript(transcript)
    prompt = EXTRACTION_PROMPT + formatted

    client = anthropic_client
    if client is None:
        if not settings.anthropic_api_key:
            logger.error("Cannot extract captures: ANTHROPIC_API_KEY not set")
            return []
        client = anthropic.AsyncAnthropic(api_key=settings.anthropic_api_key)

    try:
        response = await client.messages.create(
            model=settings.llm_model,
            max_tokens=2048,
            temperature=0.3,  # Lower temp for structured extraction
            messages=[{"role": "user", "content": prompt}],
        )

        # Extract text from response
        result_text = ""
        for block in response.content:
            if hasattr(block, "text"):
                result_text += block.text

        # Parse JSON response
        captures = json.loads(result_text.strip())
        if not isinstance(captures, list):
            logger.warning(f"Session {session_id}: extraction returned non-list: {type(captures)}")
            return []

        # Validate and clean each capture
        valid_captures: list[dict[str, Any]] = []
        for cap in captures:
            if not isinstance(cap, dict):
                continue
            content = cap.get("content", "").strip()
            capture_type = cap.get("capture_type", "observation")
            brain_view = cap.get("brain_view", "personal")

            if not content:
                continue
            if capture_type not in CAPTURE_TYPES:
                capture_type = "observation"
            if brain_view not in BRAIN_VIEWS:
                brain_view = "personal"

            valid_captures.append(
                {
                    "content": content,
                    "capture_type": capture_type,
                    "brain_view": brain_view,
                }
            )

        logger.info(
            f"Session {session_id}: extracted {len(valid_captures)} captures "
            f"from {len(transcript)} transcript turns"
        )
        return valid_captures

    except json.JSONDecodeError as e:
        logger.error(f"Session {session_id}: JSON parse error in extraction: {e}")
        return []
    except anthropic.APIError as e:
        logger.error(f"Session {session_id}: Anthropic API error: {e}")
        return []
    except Exception:
        logger.exception(f"Session {session_id}: unexpected extraction error")
        return []


async def post_captures_to_core_api(
    session_id: str,
    captures: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """POST extracted captures to core-api for pipeline processing.

    Args:
        session_id: Session ID for metadata linkage.
        captures: List of capture dicts from extract_captures().

    Returns:
        List of API response dicts (id, pipeline_status, created_at)
        for successfully posted captures.
    """
    if not captures:
        return []

    results: list[dict[str, Any]] = []
    url = f"{settings.core_api_url}/api/v1/captures"

    async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as client:
        for cap in captures:
            payload = {
                "content": cap["content"],
                "capture_type": cap["capture_type"],
                "brain_view": cap["brain_view"],
                "source": "voice",
                "metadata": {
                    "source_metadata": {
                        "session_id": session_id,
                        "extraction_method": "voice_conversation",
                    },
                },
            }

            try:
                resp = await client.post(url, json=payload)
                if resp.status_code == 201:
                    result = resp.json()
                    results.append(result)
                    logger.info(
                        f"Session {session_id}: posted capture {result.get('id')} "
                        f"({cap['capture_type']}/{cap['brain_view']})"
                    )
                elif resp.status_code == 409:
                    logger.info(f"Session {session_id}: duplicate capture skipped (409)")
                else:
                    logger.error(
                        f"Session {session_id}: capture POST failed "
                        f"({resp.status_code}): {resp.text}"
                    )
            except httpx.RequestError as e:
                logger.error(f"Session {session_id}: capture POST request error: {e}")

    logger.info(f"Session {session_id}: posted {len(results)}/{len(captures)} captures")
    return results


async def handle_session_end(
    session_id: str,
    session_data: dict[str, Any],
) -> None:
    """Session-end callback: extract and post captures.

    This is registered with SessionManager.on_session_end() and runs
    when any voice session ends. It extracts captures from the transcript
    and POSTs them to core-api.

    Args:
        session_id: The ended session's ID.
        session_data: Full session data including transcript.
    """
    transcript = session_data.get("transcript", [])
    if not transcript:
        logger.info(f"Session {session_id}: no transcript, skipping capture extraction")
        return

    captures = await extract_captures(session_id, transcript)
    if captures:
        await post_captures_to_core_api(session_id, captures)
    else:
        logger.info(f"Session {session_id}: no captures extracted from conversation")
