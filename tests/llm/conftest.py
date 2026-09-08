"""Per-area fixtures for tests/llm (owned by W1). Shared fixtures live in tests/conftest.py."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import pytest

from backend.schemas import Delta

HERE = Path(__file__).resolve().parent
LLM_FIXTURES_DIR = HERE / "fixtures"
BASE_URL = "https://openrouter.test/api/v1"
CHAT_URL = BASE_URL + "/chat/completions"
MODELS_URL = BASE_URL + "/models"
GENERATION_URL = BASE_URL + "/generation"


@pytest.fixture(autouse=True)
def _llm_module_state():
    """Keep process-level state of the llm package from leaking between tests."""
    from backend.llm import catalog, client, metering

    catalog._reset_cache()
    metering.reset_session_cost()
    client._record_counters.clear()
    yield
    catalog._reset_cache()
    metering.reset_session_cost()
    client._record_counters.clear()


@pytest.fixture
def mini_fixtures(monkeypatch):
    """Point the mock transport at tests/llm/fixtures, scenario `mini`."""
    monkeypatch.setenv("MOCK_FIXTURES_DIR", str(LLM_FIXTURES_DIR))
    monkeypatch.setenv("MOCK_SCENARIO", "mini")
    return LLM_FIXTURES_DIR


@pytest.fixture
def live_transport(monkeypatch):
    """Exercise the real httpx path offline (docs/api-contract.md addendum)."""
    monkeypatch.setenv("MOCK_OPENROUTER", "0")
    monkeypatch.setenv("OPENROUTER_API_KEY", "test-key")
    monkeypatch.setenv("OPENROUTER_BASE_URL", BASE_URL)
    monkeypatch.setenv("HTTP_REFERER", "http://triplex.test")
    monkeypatch.setenv("APP_TITLE", "Triplex Test")
    monkeypatch.setenv("REQUEST_TIMEOUT_S", "5")
    monkeypatch.setenv("SESSION_COST_CAP_USD", "10")
    yield


@pytest.fixture
def respx_router(_block_outbound_http):
    """The autouse blocking router: add routes to it directly."""
    return _block_outbound_http


# --------------------------------------------------------------------------- SSE builders
def chunk(
    *,
    content: str | None = None,
    finish: str | None = None,
    cid: str = "gen-test",
    model: str = "anthropic/claude-opus-5",
    reasoning_details: list[dict[str, Any]] | None = None,
    reasoning: str | None = None,
    annotations: list[dict[str, Any]] | None = None,
    message_annotations: list[dict[str, Any]] | None = None,
    usage: dict[str, Any] | None = None,
    role: bool = False,
) -> str:
    delta: dict[str, Any] = {}
    if role:
        delta["role"] = "assistant"
    if content is not None:
        delta["content"] = content
    if reasoning_details is not None:
        delta["reasoning_details"] = reasoning_details
    if reasoning is not None:
        delta["reasoning"] = reasoning
    if annotations is not None:
        delta["annotations"] = annotations
    choice: dict[str, Any] = {"index": 0, "delta": delta, "finish_reason": finish}
    if message_annotations is not None:
        choice["message"] = {"annotations": message_annotations}
    doc: dict[str, Any] = {
        "id": cid,
        "object": "chat.completion.chunk",
        "model": model,
        "choices": [choice],
    }
    if usage is not None:
        doc["usage"] = usage
    return json.dumps(doc, ensure_ascii=False)


def usage_obj(
    prompt: int = 120,
    completion: int = 40,
    cost: float | None = 0.00123,
    reasoning: int = 0,
) -> dict[str, Any]:
    u: dict[str, Any] = {
        "prompt_tokens": prompt,
        "completion_tokens": completion,
        "total_tokens": prompt + completion,
        "completion_tokens_details": {"reasoning_tokens": reasoning},
    }
    if cost is not None:
        u["cost"] = cost
    return u


def error_chunk(
    code: int | str = 502,
    message: str = "Provider disconnected",
    error_type: str | None = "provider_unavailable",
    cid: str = "gen-test",
) -> str:
    err: dict[str, Any] = {"code": code, "message": message}
    if error_type is not None:
        err["metadata"] = {"error_type": error_type}
    return json.dumps(
        {
            "id": cid,
            "error": err,
            "choices": [{"index": 0, "delta": {"content": ""}, "finish_reason": "error"}],
        }
    )


def citation(url: str, title: str = "t") -> dict[str, Any]:
    return {"type": "url_citation", "url_citation": {"url": url, "title": title}}


def sse_lines(*payloads: str, done: bool = True) -> list[str]:
    """Raw SSE lines: each payload becomes `data: <payload>` unless it is already a comment."""
    out: list[str] = []
    for p in payloads:
        out.append(p if p.startswith(":") or p.startswith("data:") else f"data: {p}")
        out.append("")
    if done:
        out.append("data: [DONE]")
        out.append("")
    return out


def sse_body(*payloads: str, done: bool = True) -> bytes:
    return ("\n".join(sse_lines(*payloads, done=done)) + "\n").encode("utf-8")


async def collect(agen: AsyncIterator[Delta]) -> list[Delta]:
    return [d async for d in agen]


def kinds(deltas: list[Delta]) -> list[str]:
    return [d.kind for d in deltas]


@pytest.fixture
def sse():
    """Namespace of the SSE builders above for tests that prefer a fixture."""

    class _NS:
        chunk = staticmethod(chunk)
        usage = staticmethod(usage_obj)
        error = staticmethod(error_chunk)
        citation = staticmethod(citation)
        lines = staticmethod(sse_lines)
        body = staticmethod(sse_body)
        collect = staticmethod(collect)
        kinds = staticmethod(kinds)

    return _NS
