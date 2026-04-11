"""Open Brain tools for in-conversation use by Claude during voice chat.

Provides search_brain and get_entity tools that the LLM can call while
conversing with the user. These hit the core-api HTTP endpoints.

Usage in Pipecat pipeline:
    tools = create_open_brain_tools()
    llm = AnthropicLLMService(..., tools=tools)
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

from .config import settings

logger = logging.getLogger(__name__)

# Timeout for core-api calls — keep short for real-time voice UX
_HTTP_TIMEOUT = httpx.Timeout(10.0, connect=3.0)


async def search_brain(query: str, limit: int = 5) -> dict[str, Any]:
    """Search the Open Brain knowledge base.

    Calls GET /api/v1/search on core-api with hybrid search.
    Used by the LLM when the user asks "what did I capture about X?"

    Args:
        query: Search query string.
        limit: Max results to return (default 5, keep small for voice).

    Returns:
        Dict with 'results' list and 'total' count. Each result has
        'capture' (with content, capture_type, brain_view, created_at)
        and 'score'.
    """
    url = f"{settings.core_api_url}/api/v1/search"
    params = {
        "q": query,
        "limit": limit,
    }

    try:
        async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as client:
            resp = await client.get(url, params=params)
            resp.raise_for_status()
            data = resp.json()
            results = data.get("results", [])
            logger.info(
                f"search_brain: query={query!r} returned {len(results)} results"
            )
            return {
                "results": results,
                "total": data.get("total", len(results)),
                "query": query,
            }
    except httpx.HTTPStatusError as e:
        logger.error(f"search_brain HTTP error: {e.response.status_code} {e}")
        return {"results": [], "total": 0, "query": query, "error": str(e)}
    except httpx.RequestError as e:
        logger.error(f"search_brain request error: {e}")
        return {"results": [], "total": 0, "query": query, "error": str(e)}


async def get_entity(name: str) -> dict[str, Any]:
    """Look up an entity in Open Brain by name.

    Calls GET /api/v1/entities?name=<name> on core-api.
    Used by the LLM to look up people, projects, topics mentioned
    in conversation.

    Args:
        name: Entity name to look up (case-insensitive match).

    Returns:
        Dict with 'entity' (name, type, aliases, mention_count,
        linked_captures) or 'error' if not found.
    """
    url = f"{settings.core_api_url}/api/v1/entities"
    params = {"name": name}

    try:
        async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as client:
            resp = await client.get(url, params=params)
            if resp.status_code == 404:
                logger.info(f"get_entity: '{name}' not found")
                return {"entity": None, "found": False, "name": name}
            resp.raise_for_status()
            data = resp.json()
            logger.info(f"get_entity: found '{name}'")
            return {
                "entity": data.get("entity"),
                "found": True,
                "name": name,
            }
    except httpx.HTTPStatusError as e:
        logger.error(f"get_entity HTTP error: {e.response.status_code} {e}")
        return {"entity": None, "found": False, "name": name, "error": str(e)}
    except httpx.RequestError as e:
        logger.error(f"get_entity request error: {e}")
        return {"entity": None, "found": False, "name": name, "error": str(e)}


def get_tool_definitions() -> list[dict[str, Any]]:
    """Return Anthropic-format tool definitions for the LLM.

    These are passed to AnthropicLLMService so Claude can call
    search_brain and get_entity during conversation.
    """
    return [
        {
            "name": "search_brain",
            "description": (
                "Search the user's Open Brain knowledge base. Use this when the user "
                "asks about past captures, decisions, ideas, or any previously stored "
                "information. Returns matching captures with content and metadata."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Search query — what to look for in the knowledge base.",
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Maximum number of results (default 5).",
                        "default": 5,
                    },
                },
                "required": ["query"],
            },
        },
        {
            "name": "get_entity",
            "description": (
                "Look up an entity (person, project, concept, tool) in the user's "
                "knowledge base by name. Returns entity details and linked captures. "
                "Use when the user mentions a specific person, project, or topic and "
                "wants to know what's stored about it."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "Entity name to look up.",
                    },
                },
                "required": ["name"],
            },
        },
    ]


# Map tool names to handler functions for dispatch
TOOL_HANDLERS: dict[str, Any] = {
    "search_brain": search_brain,
    "get_entity": get_entity,
}


async def handle_tool_call(
    tool_name: str,
    tool_input: dict[str, Any],
) -> dict[str, Any]:
    """Dispatch a tool call from the LLM to the appropriate handler.

    Args:
        tool_name: Name of the tool to call.
        tool_input: Input parameters from the LLM.

    Returns:
        Tool result dict.

    Raises:
        ValueError: If tool_name is unknown.
    """
    handler = TOOL_HANDLERS.get(tool_name)
    if handler is None:
        raise ValueError(f"Unknown tool: {tool_name}")
    return await handler(**tool_input)
