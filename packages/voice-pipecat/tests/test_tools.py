"""Tests for Open Brain in-conversation tools (search_brain, get_entity)."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.tools import (
    get_entity,
    get_tool_definitions,
    handle_tool_call,
    search_brain,
    TOOL_HANDLERS,
)


# --- Tool definition tests ---


def test_tool_definitions_structure():
    """Tool definitions should have required Anthropic schema fields."""
    defs = get_tool_definitions()
    assert len(defs) == 2

    for tool in defs:
        assert "name" in tool
        assert "description" in tool
        assert "input_schema" in tool
        assert tool["input_schema"]["type"] == "object"
        assert "properties" in tool["input_schema"]
        assert "required" in tool["input_schema"]


def test_tool_definitions_names():
    """Should define search_brain and get_entity tools."""
    defs = get_tool_definitions()
    names = {t["name"] for t in defs}
    assert names == {"search_brain", "get_entity"}


def test_search_brain_tool_schema():
    """search_brain should require query parameter."""
    defs = get_tool_definitions()
    search_tool = next(t for t in defs if t["name"] == "search_brain")
    assert "query" in search_tool["input_schema"]["properties"]
    assert "query" in search_tool["input_schema"]["required"]


def test_get_entity_tool_schema():
    """get_entity should require name parameter."""
    defs = get_tool_definitions()
    entity_tool = next(t for t in defs if t["name"] == "get_entity")
    assert "name" in entity_tool["input_schema"]["properties"]
    assert "name" in entity_tool["input_schema"]["required"]


def test_tool_handlers_map():
    """TOOL_HANDLERS should map both tool names to functions."""
    assert "search_brain" in TOOL_HANDLERS
    assert "get_entity" in TOOL_HANDLERS


# --- search_brain tests ---


@pytest.mark.asyncio
async def test_search_brain_success():
    """Should return search results from core-api."""
    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.raise_for_status = MagicMock()
    mock_response.json.return_value = {
        "query": "kubernetes",
        "total": 2,
        "results": [
            {"capture": {"content": "K8s migration notes"}, "score": 0.9},
            {"capture": {"content": "Helm chart review"}, "score": 0.7},
        ],
    }

    with patch("src.tools.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=mock_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        result = await search_brain("kubernetes")

    assert result["total"] == 2
    assert len(result["results"]) == 2
    assert result["query"] == "kubernetes"
    assert "error" not in result


@pytest.mark.asyncio
async def test_search_brain_empty_results():
    """Should handle zero results gracefully."""
    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.raise_for_status = MagicMock()
    mock_response.json.return_value = {
        "query": "nonexistent topic",
        "total": 0,
        "results": [],
    }

    with patch("src.tools.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=mock_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        result = await search_brain("nonexistent topic")

    assert result["total"] == 0
    assert result["results"] == []


@pytest.mark.asyncio
async def test_search_brain_http_error():
    """HTTP errors should return empty results with error message."""
    import httpx

    mock_response = MagicMock()
    mock_response.status_code = 500
    mock_response.raise_for_status = MagicMock(
        side_effect=httpx.HTTPStatusError(
            "Server Error",
            request=MagicMock(),
            response=mock_response,
        )
    )

    with patch("src.tools.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=mock_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        result = await search_brain("test query")

    assert result["results"] == []
    assert result["total"] == 0
    assert "error" in result


@pytest.mark.asyncio
async def test_search_brain_connection_error():
    """Connection errors should return empty results with error message."""
    import httpx

    with patch("src.tools.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(
            side_effect=httpx.RequestError("Connection refused")
        )
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        result = await search_brain("test query")

    assert result["results"] == []
    assert "error" in result


@pytest.mark.asyncio
async def test_search_brain_custom_limit():
    """Should pass limit parameter to core-api."""
    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.raise_for_status = MagicMock()
    mock_response.json.return_value = {"query": "test", "total": 0, "results": []}

    with patch("src.tools.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=mock_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        await search_brain("test", limit=3)

    call_args = mock_client.get.call_args
    params = call_args.kwargs.get("params") or call_args[1].get("params")
    assert params["limit"] == 3


# --- get_entity tests ---


@pytest.mark.asyncio
async def test_get_entity_found():
    """Should return entity data when found."""
    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.raise_for_status = MagicMock()
    mock_response.json.return_value = {
        "entity": {
            "id": "uuid-entity-1",
            "name": "Docker",
            "type": "technology",
            "aliases": [],
            "mention_count": 15,
        },
    }

    with patch("src.tools.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=mock_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        result = await get_entity("Docker")

    assert result["found"] is True
    assert result["entity"]["name"] == "Docker"
    assert result["name"] == "Docker"


@pytest.mark.asyncio
async def test_get_entity_not_found():
    """Should return found=False when entity doesn't exist."""
    mock_response = MagicMock()
    mock_response.status_code = 404

    with patch("src.tools.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=mock_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        result = await get_entity("NonexistentThing")

    assert result["found"] is False
    assert result["entity"] is None
    assert result["name"] == "NonexistentThing"


@pytest.mark.asyncio
async def test_get_entity_connection_error():
    """Connection error should return error, not raise."""
    import httpx

    with patch("src.tools.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(
            side_effect=httpx.RequestError("Connection refused")
        )
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        result = await get_entity("Docker")

    assert result["found"] is False
    assert "error" in result


# --- handle_tool_call dispatch tests ---


@pytest.mark.asyncio
async def test_handle_tool_call_search():
    """Should dispatch search_brain tool calls."""
    mock_search = AsyncMock(return_value={"results": [], "total": 0, "query": "test"})
    with patch.dict(TOOL_HANDLERS, {"search_brain": mock_search}):
        result = await handle_tool_call("search_brain", {"query": "test"})
        mock_search.assert_called_once_with(query="test")
        assert result["query"] == "test"


@pytest.mark.asyncio
async def test_handle_tool_call_entity():
    """Should dispatch get_entity tool calls."""
    mock_entity = AsyncMock(return_value={"entity": None, "found": False, "name": "Test"})
    with patch.dict(TOOL_HANDLERS, {"get_entity": mock_entity}):
        result = await handle_tool_call("get_entity", {"name": "Test"})
        mock_entity.assert_called_once_with(name="Test")


@pytest.mark.asyncio
async def test_handle_tool_call_unknown():
    """Unknown tool names should raise ValueError."""
    with pytest.raises(ValueError, match="Unknown tool"):
        await handle_tool_call("nonexistent_tool", {})
