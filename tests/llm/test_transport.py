"""stream_completion over the real httpx path (respx-mocked, offline) and in mock mode."""

from __future__ import annotations

import json

import httpx
import pytest

from backend.llm import catalog, metering, mock
from backend.llm.client import stream_completion
from backend.schemas import ModelMeta
from tests.llm.conftest import (
    CHAT_URL,
    chunk,
    citation,
    collect,
    error_chunk,
    kinds,
    sse_body,
    usage_obj,
)

MSGS = [{"role": "user", "content": "What is the BMI088 gyro range?"}]


def _call(**kw):
    base = dict(
        role="claude",
        purpose="chat",
        model="anthropic/claude-opus-5",
        messages=MSGS,
        effort="medium",
        max_tokens=100,
    )
    base.update(kw)
    return stream_completion(**base)


def _ok_route(respx_router, *payloads, headers=None, status=200):
    return respx_router.post(CHAT_URL).mock(
        return_value=httpx.Response(status, content=sse_body(*payloads), headers=headers or {})
    )


# --------------------------------------------------------------------------- happy path
async def test_comment_lines_done_usage_and_generation_header(live_transport, respx_router):
    route = _ok_route(
        respx_router,
        ": OPENROUTER PROCESSING",
        chunk(content="Hel", role=True),
        chunk(content="lo", finish="stop"),
        chunk(content="", usage=usage_obj(cost=0.00123, reasoning=2)),
        headers={"X-Generation-Id": "gen-from-header"},
    )
    deltas = await collect(_call())
    assert kinds(deltas) == ["text", "text", "done"]
    done = deltas[-1]
    assert done.generation_id == "gen-from-header"
    u = done.usage
    assert u.generation_id == "gen-from-header"
    assert (u.prompt_tokens, u.completion_tokens, u.reasoning_tokens) == (120, 40, 2)
    assert u.cost_usd == 0.00123 and u.latency_ms >= 0
    assert (u.role, u.purpose, u.model) == ("claude", "chat", "anthropic/claude-opus-5")
    assert route.call_count == 1
    assert metering.session_cost_usd() == pytest.approx(0.00123)


async def test_headers_url_and_payload_shape(live_transport, respx_router):
    route = _ok_route(respx_router, chunk(content="x", finish="stop"), chunk(usage=usage_obj()))
    await collect(_call(effort="high", plugins=[{"id": "web", "max_results": 3}]))
    req = route.calls.last.request
    assert str(req.url) == CHAT_URL
    assert req.headers["Authorization"] == "Bearer test-key"
    assert req.headers["HTTP-Referer"] == "http://triplex.test"
    assert req.headers["X-OpenRouter-Title"] == "Triplex Test"
    assert req.headers["Content-Type"].startswith("application/json")
    body = json.loads(req.content)
    assert body["model"] == "anthropic/claude-opus-5" and body["messages"] == MSGS
    assert body["stream"] is True and body["max_tokens"] == 100
    assert body["reasoning"] == {"effort": "high"}
    assert body["plugins"] == [{"id": "web", "max_results": 3}]
    assert "response_format" not in body and "provider" not in body
    assert "usage" not in body  # usage.include is deprecated and must not be sent


@pytest.mark.parametrize(
    "model,effort,expected",
    [
        ("anthropic/claude-opus-5", "off", {"enabled": False}),
        ("anthropic/claude-opus-5", "low", {"effort": "low"}),
        ("anthropic/claude-opus-5", "medium", {"effort": "medium"}),
        ("x-ai/grok-4.6", "off", None),  # mandatory: omitted
        ("x-ai/grok-4.6", "high", {"effort": "high"}),
        ("openai/gpt-chat-latest", "off", None),  # no reasoning block: omitted
        ("nobody/unknown", "off", {"enabled": False}),  # unknown model: as configured
        ("nobody/unknown", "high", {"effort": "high"}),
        ("anthropic/claude-opus-5", None, None),
    ],
)
async def test_reasoning_object_per_effort(live_transport, respx_router, model, effort, expected):
    route = _ok_route(respx_router, chunk(content="x", finish="stop"), chunk(usage=usage_obj()))
    await collect(_call(model=model, effort=effort))
    body = json.loads(route.calls.last.request.content)
    assert body.get("reasoning") == expected
    if expected is None:
        assert "reasoning" not in body


async def test_response_format_and_provider_passthrough(live_transport, respx_router):
    route = _ok_route(respx_router, chunk(content="{}", finish="stop"), chunk(usage=usage_obj()))
    rf = {"type": "json_schema", "json_schema": {"name": "x", "strict": True, "schema": {}}}
    await collect(_call(response_format=rf, max_tokens=None))
    body = json.loads(route.calls.last.request.content)
    assert body["response_format"] == rf
    assert body["provider"] == {"require_parameters": True}
    assert "max_tokens" not in body and "plugins" not in body


async def test_reasoning_citations_and_truncation_over_http(live_transport, respx_router):
    a = citation("https://a.example/", "A")
    _ok_route(
        respx_router,
        chunk(reasoning_details=[{"type": "reasoning.text", "text": "hmm "}]),
        chunk(reasoning="bare"),
        chunk(content="cite", annotations=[a]),
        chunk(content=" more", finish="length"),
        chunk(content="", finish="length", message_annotations=[a], usage=usage_obj()),
    )
    deltas = await collect(_call())
    assert kinds(deltas) == ["reasoning", "reasoning", "text", "citations", "text", "done"]
    assert deltas[0].text == "hmm " and deltas[1].text == "bare"
    assert deltas[3].items == [a]
    assert deltas[-1].finish_reason == "length" and deltas[-1].truncated is True


async def test_stream_without_usage_chunk_synthesises_usage(live_transport, respx_router, caplog):
    caplog.set_level("INFO")
    _ok_route(respx_router, chunk(content="x" * 80, finish="stop"))
    deltas = await collect(_call())
    assert kinds(deltas) == ["text", "done"]
    u = deltas[-1].usage
    assert u.completion_tokens == 20 and u.prompt_tokens == len(MSGS[0]["content"]) // 4
    assert u.cost_usd == pytest.approx(u.prompt_tokens * 5e-6 + 20 * 25e-6)
    assert any("estimated" in r.getMessage() for r in caplog.records)


async def test_one_info_log_line_per_call(live_transport, respx_router, caplog):
    caplog.set_level("INFO", logger="triplex.llm.client")
    _ok_route(respx_router, chunk(content="x", finish="stop"), chunk(usage=usage_obj(cost=0.5)))
    await collect(_call(role="grok", purpose="defense", model="x-ai/grok-4.6"))
    lines = [r.getMessage() for r in caplog.records if r.name == "triplex.llm.client"]
    assert len(lines) == 1
    line = lines[0]
    for needle in (
        "role=grok",
        "purpose=defense",
        "model=x-ai/grok-4.6",
        "cost_usd=0.5",
        "latency_ms=",
    ):
        assert needle in line


# --------------------------------------------------------------------------- failures
async def test_mid_stream_error_is_the_only_event(live_transport, respx_router):
    _ok_route(respx_router, error_chunk(502, "Provider disconnected", "provider_unavailable"))
    deltas = await collect(_call())
    assert kinds(deltas) == ["error"]
    e = deltas[0]
    assert e.code == 502 and e.message == "Provider disconnected"
    assert e.error_type == "provider_unavailable" and e.usage is None
    assert metering.session_cost_usd() == 0.0


async def test_mid_stream_error_after_partial_text(live_transport, respx_router):
    _ok_route(
        respx_router,
        chunk(content="partial"),
        error_chunk(429, "Rate limit exceeded", "rate_limit_exceeded"),
    )
    deltas = await collect(_call())
    assert kinds(deltas) == ["text", "error"] and deltas[0].text == "partial"


@pytest.mark.parametrize(
    "status,body,code,error_type",
    [
        (
            429,
            {
                "error": {
                    "code": 429,
                    "message": "Rate limit exceeded",
                    "metadata": {"error_type": "rate_limit_exceeded"},
                }
            },
            429,
            "rate_limit_exceeded",
        ),
        (402, {"error": {"code": 402, "message": "Insufficient credits"}}, 402, "http_error"),
        (401, {"error": {"code": 401, "message": "No auth credentials found"}}, 401, "http_error"),
    ],
)
async def test_pre_stream_http_error_json_body(
    live_transport, respx_router, status, body, code, error_type
):
    respx_router.post(CHAT_URL).mock(return_value=httpx.Response(status, json=body))
    deltas = await collect(_call())
    assert kinds(deltas) == ["error"]
    e = deltas[0]
    assert e.code == code and e.message == body["error"]["message"] and e.error_type == error_type


async def test_pre_stream_http_error_non_json_body(live_transport, respx_router):
    respx_router.post(CHAT_URL).mock(
        return_value=httpx.Response(503, content=b"<html>bad gateway</html>")
    )
    deltas = await collect(_call())
    assert kinds(deltas) == ["error"]
    assert deltas[0].code == 503 and "bad gateway" in deltas[0].message


@pytest.mark.parametrize(
    "exc", [httpx.ReadTimeout("slow"), httpx.ConnectTimeout("slow"), httpx.PoolTimeout("slow")]
)
async def test_timeout_becomes_error_delta(live_transport, respx_router, exc):
    respx_router.post(CHAT_URL).mock(side_effect=exc)
    deltas = await collect(_call())
    assert kinds(deltas) == ["error"]
    assert deltas[0].code == "timeout" and deltas[0].error_type == "timeout"
    assert "timed out" in deltas[0].message


async def test_connect_error_becomes_error_delta(live_transport, respx_router):
    respx_router.post(CHAT_URL).mock(side_effect=httpx.ConnectError("refused"))
    deltas = await collect(_call())
    assert kinds(deltas) == ["error"] and deltas[0].code == "transport_error"
    assert deltas[0].error_type == "triplex"


async def test_read_error_mid_stream_after_text(live_transport, respx_router):
    async def body():
        yield b"data: " + chunk(content="part").encode() + b"\n\n"
        raise httpx.ReadError("connection reset")

    respx_router.post(CHAT_URL).mock(return_value=httpx.Response(200, content=body()))
    deltas = await collect(_call())
    assert kinds(deltas) == ["text", "error"]
    assert deltas[1].code == "transport_error"


async def test_missing_api_key_is_an_error_delta(live_transport, respx_router, monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "")
    route = _ok_route(respx_router, chunk(content="x", finish="stop"), chunk(usage=usage_obj()))
    deltas = await collect(_call())
    assert kinds(deltas) == ["error"]
    assert deltas[0].code == "missing_api_key" and deltas[0].error_type == "triplex"
    assert route.call_count == 0


# --------------------------------------------------------------------------- cost cap
async def test_cost_cap_refuses_live_calls(live_transport, respx_router, monkeypatch):
    monkeypatch.setenv("SESSION_COST_CAP_USD", "0.5")
    route = _ok_route(
        respx_router, chunk(content="x", finish="stop"), chunk(usage=usage_obj(cost=0.3))
    )
    d1 = await collect(_call())
    assert kinds(d1) == ["text", "done"] and metering.session_cost_usd() == pytest.approx(0.3)
    d2 = await collect(_call())
    assert kinds(d2) == ["text", "done"] and metering.session_cost_usd() == pytest.approx(0.6)
    d3 = await collect(_call())
    assert kinds(d3) == ["error"]
    e = d3[0]
    assert e.code == "cost_cap_exceeded" and e.error_type == "triplex" and e.usage is None
    assert "0.5" in e.message
    assert route.call_count == 2


async def test_cost_cap_not_enforced_in_mock_mode(mini_fixtures, monkeypatch):
    monkeypatch.setenv("SESSION_COST_CAP_USD", "0")
    deltas = await collect(_call())
    assert kinds(deltas)[-1] == "done"
    assert metering.session_cost_usd() == 0.0  # mock costs never accrue


# --------------------------------------------------------------------------- record tee
async def test_record_dir_tees_fixture_format(live_transport, respx_router, monkeypatch, tmp_path):
    rec = tmp_path / "rec"
    monkeypatch.setenv("MOCK_RECORD_DIR", str(rec))
    payloads = [chunk(content="a"), chunk(content="b", finish="stop"), chunk(usage=usage_obj())]
    _ok_route(respx_router, ": OPENROUTER PROCESSING", *payloads)
    await collect(_call(role="chatgpt", purpose="chat", model="openai/gpt-5.6-sol"))
    files = sorted(p.name for p in rec.iterdir())
    assert "requests.jsonl" in files
    fixture = [f for f in files if f.startswith("chatgpt.chat.")]
    assert len(fixture) == 1 and fixture[0].endswith(".jsonl")
    lines = (rec / fixture[0]).read_text().splitlines()
    assert [json.loads(ln) for ln in lines] == [json.loads(p) for p in payloads]
    req = json.loads((rec / "requests.jsonl").read_text().splitlines()[-1])
    assert req["fixture"] == fixture[0] and req["role"] == "chatgpt" and req["purpose"] == "chat"
    assert req["payload"]["model"] == "openai/gpt-5.6-sol" and req["payload"]["stream"] is True


# --------------------------------------------------------------------------- mock dispatch
async def test_mock_mode_dispatches_to_mock_and_stamps_usage(mini_fixtures, respx_router):
    deltas = await collect(_call())
    assert kinds(deltas) == ["text", "reasoning", "text", "done"]
    done = deltas[-1]
    assert done.generation_id == "gen-mini-c1" and done.finish_reason == "stop"
    u = done.usage
    assert (u.role, u.purpose, u.model) == ("claude", "chat", "anthropic/claude-opus-5")
    assert u.cost_usd == 0.0004 and u.reasoning_tokens == 3 and u.generation_id == "gen-mini-c1"
    assert mock.calls[-1]["fixture"] == "mini/claude.chat.1.jsonl"
    assert mock.calls[-1]["reasoning"] == {"effort": "medium"}
    assert respx_router.calls.call_count == 0


async def test_mock_mode_truncated_and_error_fixtures(mini_fixtures):
    d = await collect(_call(role="chatgpt", model="openai/gpt-5.6-sol"))
    assert d[-1].kind == "done" and d[-1].truncated is True and d[-1].finish_reason == "length"
    e = await collect(_call(role="grok", model="x-ai/grok-4.6"))
    assert kinds(e) == ["error"] and e[0].code == 502 and e[0].error_type == "provider_unavailable"


async def test_never_raises_even_if_the_catalog_explodes(mini_fixtures, monkeypatch):
    def boom(_model):
        raise RuntimeError("catalog down")

    monkeypatch.setattr(catalog, "get_meta", boom)
    deltas = await collect(_call())
    assert deltas[-1].kind == "error" and "catalog down" in deltas[-1].message


async def test_structured_outputs_meta_does_not_change_stream_completion(
    live_transport, respx_router, monkeypatch
):
    """stream_completion never adds response_format on its own; complete_json does."""
    monkeypatch.setattr(
        catalog,
        "get_meta",
        lambda m: ModelMeta(id=m, efforts=["off", "low"], structured_outputs=True),
    )
    route = _ok_route(respx_router, chunk(content="x", finish="stop"), chunk(usage=usage_obj()))
    await collect(_call(effort="low"))
    assert "response_format" not in json.loads(route.calls.last.request.content)
