"""`ollama.list_local_models` and `GET /api/ollama/models` (2026-09-27): the Agents page's local
list -- loopback only, `/api/tags`, never raises, `[]` on any failure."""

from __future__ import annotations

import httpx
import pytest

from backend.llm import ollama

TAGS = {"models": [{"name": "hermes3:latest"}, {"name": "qwen3:8b"}, {"name": "qwen3:8b"}, {"nope": 1}]}


def test_tags_url_strips_the_v1_suffix():
    assert ollama.tags_url("http://127.0.0.1:11434/v1") == "http://127.0.0.1:11434/api/tags"
    assert ollama.tags_url("http://localhost:11434/v1/") == "http://localhost:11434/api/tags"
    assert ollama.tags_url("http://localhost:11434") == "http://localhost:11434/api/tags"


async def test_lists_names_from_api_tags(respx_router, monkeypatch):
    monkeypatch.setenv("OLLAMA_BASE_URL", "http://127.0.0.1:11434/v1")
    route = respx_router.get("http://127.0.0.1:11434/api/tags").mock(
        return_value=httpx.Response(200, json=TAGS)
    )
    assert await ollama.list_local_models(timeout_s=1.0) == ["hermes3:latest", "qwen3:8b"]
    assert route.call_count == 1


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(500, text="boom"),
        httpx.Response(200, text="not json"),
        httpx.Response(200, json={"models": "nope"}),
        httpx.Response(200, json=[]),
        httpx.ConnectError("refused"),
        httpx.ReadTimeout("slow"),
    ],
)
async def test_any_failure_is_an_empty_list(respx_router, monkeypatch, response):
    monkeypatch.setenv("OLLAMA_BASE_URL", "http://127.0.0.1:11434/v1")
    route = respx_router.get("http://127.0.0.1:11434/api/tags")
    if isinstance(response, Exception):
        route.mock(side_effect=response)
    else:
        route.mock(return_value=response)
    assert await ollama.list_local_models(timeout_s=1.0) == []


async def test_a_remote_base_url_is_never_listed(respx_router, monkeypatch):
    monkeypatch.setenv("OLLAMA_BASE_URL", "http://ollama.lan:11434/v1")
    route = respx_router.get("http://ollama.lan:11434/api/tags").mock(
        return_value=httpx.Response(200, json=TAGS)
    )
    assert await ollama.list_local_models(timeout_s=1.0) == []
    assert route.call_count == 0


async def test_route_reports_base_url_loopback_and_models(client, respx_router, monkeypatch):
    monkeypatch.setenv("OLLAMA_BASE_URL", "http://127.0.0.1:11434/v1")
    respx_router.get("http://127.0.0.1:11434/api/tags").mock(
        return_value=httpx.Response(200, json=TAGS)
    )
    r = await client.get("/api/ollama/models")
    assert r.status_code == 200
    assert r.json() == {
        "base_url": "http://127.0.0.1:11434/v1",
        "loopback": True,
        "models": ["hermes3:latest", "qwen3:8b"],
    }
    monkeypatch.setenv("OLLAMA_BASE_URL", "http://ollama.lan:11434/v1")
    r = await client.get("/api/ollama/models")
    assert r.json() == {"base_url": "http://ollama.lan:11434/v1", "loopback": False, "models": []}
