"""`stream_completion` dispatch (bridge-backend S2): `web:*` reaches the hub before the mock
branch, `TRIPLEX_DESKTOP=1` refuses everything but web:/ollama: with `transport_disabled`, the OpenRouter
branch (cost cap, key check, `_live_stream` defaults) is unchanged."""

from __future__ import annotations

import asyncio
import inspect
import json
import logging

import httpx
import pytest

from backend.config import settings
from backend.llm import bridge, metering, mock
from backend.llm import client as client_mod
from backend.llm.client import stream_completion, transport_kind
from backend.schemas import Extraction
from tests.bridge.conftest import FakeConnection, hello
from tests.llm.conftest import CHAT_URL, GENERATION_URL, chunk, collect, kinds, sse_body, usage_obj

MSGS = [{"role": "user", "content": "What is the BMI088 gyro range?"}]


@pytest.fixture(autouse=True)
def _fresh_hub():
    bridge.hub.reset()
    yield
    bridge.hub.reset()


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


@pytest.mark.parametrize(
    "model,kind",
    [
        ("web:claude", "web"),
        ("web:chatgpt:analyst", "web"),
        ("web:", "web"),
        ("ollama:hermes3", "ollama"),
        ("anthropic/claude-opus-5", "openrouter"),
        ("openai/gpt-5", "openrouter"),
        ("", "openrouter"),
        ("webby/model", "openrouter"),
    ],
)
def test_transport_kind(model, kind):
    assert transport_kind(model) == kind


# --------------------------------------------------------------------------- web -> hub
async def test_web_model_reaches_the_hub_and_never_the_mock(caplog):
    assert settings().mock_openrouter is True  # the root conftest's mock mode is on
    conn = FakeConnection()
    bridge.hub.attach(conn, hello())
    task = asyncio.create_task(collect(_call(model="web:claude", effort="off")))
    await asyncio.sleep(0.01)
    (req,) = conn.sent("request")
    assert req["model"] == "web:claude" and req["text"] == MSGS[0]["content"]
    bridge.hub.dispatch(
        {"type": "accepted", "req_id": req["req_id"], "view": "pane", "slot": "claude"}
    )
    bridge.hub.dispatch(
        {
            "type": "result",
            "req_id": req["req_id"],
            "ok": True,
            "captured": True,
            "text": "from the pane",
            "url": "https://site.example/c/1",
            "ms": 12,
            "done_by": "stop_gone",
        }
    )
    deltas = await task
    assert kinds(deltas) == ["text", "done"] and deltas[0].text == "from the pane"
    u = deltas[-1].usage
    assert (u.model, u.role, u.purpose) == ("web:claude", "claude", "chat")
    assert u.cost_usd == 0 and u.completion_tokens == 0 and u.latency_ms >= 0
    assert mock.calls == []
    assert metering.session_cost_usd() == 0.0


async def test_web_model_without_a_desktop_is_bridge_unavailable_not_a_mock_miss():
    deltas = await collect(_call(model="web:grok", role="grok", effort="off"))
    assert kinds(deltas) == ["error"]
    assert deltas[0].code == "bridge_unavailable" and deltas[0].error_type == "triplex"
    assert mock.calls == []


# --------------------------------------------------------------------------- log hygiene
SECRET = "SECRET-REPLY-FRAGMENT"


async def test_validation_failure_log_lines_never_quote_the_reply(caplog):
    """A captured reply that fails schema validation goes back to the model in full (the
    correction message), but a log line only ever carries `loc: type`: the desktop pipes
    stdout into backend.log on disk, and a reply fragment is site content (the anon/ToS rule:
    frame bodies and captured text never reach a log line)."""
    caplog.set_level(logging.DEBUG)
    conn = FakeConnection()
    bridge.hub.attach(conn, hello())
    bad = json.dumps(
        {
            "agreements": [],
            "divergences": [
                {
                    "id": "d1",
                    "topic": "range",
                    "materiality": "high",
                    "positions": [{"model": SECRET, "claim": f"{SECRET} as a claim"}],
                }
            ],
        }
    )
    task = asyncio.create_task(
        client_mod.complete_json(
            role="analyst",
            purpose="extraction",
            model="web:chatgpt:analyst",
            messages=[
                {"role": "system", "content": "Compare the replies."},
                {"role": "user", "content": "Question and quoted replies."},
            ],
            schema_model=Extraction,
            effort="off",
            max_tokens=100,
            retries=1,
        )
    )

    async def answer(n: int) -> dict:
        while len(conn.sent("request")) < n:
            await asyncio.sleep(0.005)
        req = conn.sent("request")[-1]
        rid = req["req_id"]
        bridge.hub.dispatch(
            conn, {"type": "accepted", "req_id": rid, "view": "analyst", "slot": "chatgpt"}
        )
        bridge.hub.dispatch(
            conn,
            {
                "type": "result",
                "req_id": rid,
                "ok": True,
                "captured": True,
                "text": bad,
                "url": "https://site.example/c/1",
                "ms": 3,
                "done_by": "quiet",
            },
        )
        return req

    await asyncio.wait_for(answer(1), 5)
    correction = await asyncio.wait_for(answer(2), 5)
    parsed, raw, _usage, error = await asyncio.wait_for(task, 5)
    assert parsed is None and raw == bad
    assert error is not None and SECRET in error  # the full rendering, for the model...
    assert "failed validation" in correction["text"] and SECRET in correction["text"]
    for record in caplog.records:  # ...and never a log line
        assert SECRET not in record.getMessage(), record.getMessage()
        assert SECRET not in str(record.args or "")
    retry = [r.getMessage() for r in caplog.records if "complete_json retry" in r.getMessage()]
    assert len(retry) == 1
    assert "1 validation error(s): divergences.0.positions.0.model: literal_error" in retry[0]
    assert mock.calls == []


def test_validation_summary_is_loc_and_type_only():
    with pytest.raises(client_mod.ValidationError) as ei:
        Extraction.model_validate({"agreements": "nope", "divergences": [{"id": SECRET}]})
    summary = client_mod.validation_summary(ei.value)
    assert SECRET in str(ei.value) and SECRET not in summary
    assert summary.startswith("agreements: list_type; divergences.0.topic: missing")
    assert "input_value" not in summary and "http" not in summary


# --------------------------------------------------------------------------- desktop guard
@pytest.mark.parametrize("model", ["openai/gpt-5", "anthropic/claude-opus-5"])
async def test_desktop_mode_refuses_non_web_models(monkeypatch, model):
    monkeypatch.setenv("TRIPLEX_DESKTOP", "1")
    deltas = await collect(_call(model=model))
    assert kinds(deltas) == ["error"]
    e = deltas[0]
    assert e.code == "transport_disabled" and e.error_type == "triplex"
    assert "config bar" in e.message and "web:<slot>" in e.message
    assert mock.calls == []


async def test_desktop_guard_precedes_the_cost_cap_and_key_checks(monkeypatch, respx_router):
    monkeypatch.setenv("TRIPLEX_DESKTOP", "1")
    monkeypatch.setenv("MOCK_OPENROUTER", "0")
    monkeypatch.setenv("OPENROUTER_API_KEY", "")
    monkeypatch.setenv("SESSION_COST_CAP_USD", "0")
    deltas = await collect(_call(model="openai/gpt-5"))
    assert kinds(deltas) == ["error"] and deltas[0].code == "transport_disabled"
    assert respx_router.calls.call_count == 0


async def test_desktop_mode_still_routes_web_models(monkeypatch):
    monkeypatch.setenv("TRIPLEX_DESKTOP", "1")
    deltas = await collect(_call(model="web:claude", effort="off"))
    assert kinds(deltas) == ["error"] and deltas[0].code == "bridge_unavailable"


async def test_desktop_flag_off_keeps_the_mock_path(monkeypatch, mini_fixtures):
    monkeypatch.setenv("TRIPLEX_DESKTOP", "0")
    deltas = await collect(_call())
    assert deltas[-1].kind == "done"
    assert mock.calls[-1]["fixture"] == "mini/claude.chat.1.jsonl"


# --------------------------------------------------------------------------- openrouter unchanged
async def test_openrouter_branch_still_refuses_on_cost_cap_and_missing_key(
    live_transport, respx_router, monkeypatch
):
    route = respx_router.post(CHAT_URL).mock(
        return_value=httpx.Response(
            200,
            content=sse_body(chunk(content="x", finish="stop"), chunk(usage=usage_obj(cost=0.3))),
        )
    )
    monkeypatch.setenv("SESSION_COST_CAP_USD", "0")
    deltas = await collect(_call())
    assert kinds(deltas) == ["error"] and deltas[0].code == "cost_cap_exceeded"
    monkeypatch.setenv("SESSION_COST_CAP_USD", "10")
    monkeypatch.setenv("OPENROUTER_API_KEY", "")
    deltas = await collect(_call())
    assert kinds(deltas) == ["error"] and deltas[0].code == "missing_api_key"
    assert route.call_count == 0
    monkeypatch.setenv("OPENROUTER_API_KEY", "test-key")
    deltas = await collect(_call())
    assert kinds(deltas) == ["text", "done"] and route.call_count == 1
    assert metering.session_cost_usd() == pytest.approx(0.3)
    assert mock.calls == []


def test_live_stream_defaults_are_unchanged():
    params = inspect.signature(client_mod._live_stream).parameters
    assert params["base_url"].default is None
    assert params["headers"].default is None
    assert params["cost_lookup"].default is True
    assert all(p.kind is inspect.Parameter.KEYWORD_ONLY for p in params.values())


async def test_live_stream_honours_base_url_headers_and_cost_lookup(live_transport, respx_router):
    alt = "https://local.test/v1"
    route = respx_router.post(alt + "/chat/completions").mock(
        return_value=httpx.Response(
            200,
            content=sse_body(
                chunk(content="hi", finish="stop", cid="gen-alt"),
                chunk(content="", usage=usage_obj(cost=None), cid="gen-alt"),
            ),
        )
    )
    gen_route = respx_router.get(GENERATION_URL).mock(
        return_value=httpx.Response(200, json={"data": {"total_cost": 9.9}})
    )
    alt_gen = respx_router.get(alt + "/generation").mock(
        return_value=httpx.Response(200, json={"data": {"total_cost": 9.9}})
    )
    payload = {"model": "hermes3", "messages": MSGS, "stream": True}
    deltas = [
        d
        async for d in client_mod._live_stream(
            role="analyst",
            purpose="extraction",
            model="ollama:hermes3",
            messages=MSGS,
            payload=payload,
            base_url=alt,
            headers={"Content-Type": "application/json", "Accept": "text/event-stream"},
            cost_lookup=False,
        )
    ]
    assert kinds(deltas) == ["text", "done"]
    assert route.call_count == 1 and gen_route.call_count == 0 and alt_gen.call_count == 0
    req = route.calls.last.request
    assert "Authorization" not in req.headers and "HTTP-Referer" not in req.headers
    assert json.loads(req.content) == payload
    # The default call still asks /generation for a missing cost (today's behaviour).
    respx_router.post(CHAT_URL).mock(
        return_value=httpx.Response(
            200,
            content=sse_body(
                chunk(content="hi", finish="stop"),
                chunk(content="", usage=usage_obj(cost=None)),
            ),
            headers={"X-Generation-Id": "gen-1"},
        )
    )
    deltas = await collect(_call())
    assert kinds(deltas) == ["text", "done"] and deltas[-1].usage.cost_usd == 9.9
    assert gen_route.call_count == 1
