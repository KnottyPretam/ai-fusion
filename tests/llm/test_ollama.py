"""`ollama:<name>` transport (desktop-catalog-and-ollama S3, docs/desktop-contract.md section 6):
`stream_completion` routes it through `_live_stream` against Ollama's OpenAI-compatible endpoint
(respx-mocked at `http://127.0.0.1:11434/v1/chat/completions`) with a sanitised payload, no
Authorization, no `/generation` lookup, no cost cap / key check, and never the mock."""

from __future__ import annotations

import json
import logging

import httpx
import pytest
from pydantic import BaseModel

from backend.config import settings
from backend.llm import metering, mock, ollama
from backend.llm.client import build_payload, complete_json, stream_completion
from tests.llm.conftest import (
    CHAT_URL,
    GENERATION_URL,
    chunk,
    collect,
    error_chunk,
    kinds,
    sse_body,
    usage_obj,
)

OLLAMA_BASE = "http://127.0.0.1:11434/v1"
OLLAMA_URL = OLLAMA_BASE + "/chat/completions"
OLLAMA_GENERATION_URL = OLLAMA_BASE + "/generation"
MSGS = [{"role": "user", "content": "What is the BMI088 gyro range?"}]
SANITISED = {
    "model": "hermes3",
    "messages": MSGS,
    "stream": True,
    "max_tokens": 100,
    "stream_options": {"include_usage": True},
}
DROPPED = ("reasoning", "provider", "plugins", "response_format", "usage")


def _call(**kw):
    base = dict(
        role="analyst",
        purpose="extraction",
        model="ollama:hermes3",
        messages=MSGS,
        effort="medium",
        max_tokens=100,
    )
    base.update(kw)
    return stream_completion(**base)


def _route(respx_router, *payloads, url=OLLAMA_URL, headers=None):
    return respx_router.post(url).mock(
        return_value=httpx.Response(200, content=sse_body(*payloads), headers=headers or {})
    )


def _ok_payloads():
    return (chunk(content="hi", finish="stop", model="hermes3"), chunk(usage=usage_obj(cost=None)))


# --------------------------------------------------------------------------- pure helpers
@pytest.mark.parametrize(
    "model,name",
    [
        ("ollama:hermes3", "hermes3"),
        ("ollama:llama3.1:8b", "llama3.1:8b"),
        ("hermes3", "hermes3"),
        ("ollama:", ""),
    ],
)
def test_model_name(model, name):
    assert ollama.model_name(model) == name


def test_headers_are_json_in_sse_out_and_nothing_else():
    assert ollama.headers() == {"Content-Type": "application/json", "Accept": "text/event-stream"}
    first = ollama.headers()
    first["X-Extra"] = "mutated"
    assert "X-Extra" not in ollama.headers()  # a fresh dict per call


def test_sanitize_payload_is_an_allow_list_and_leaves_the_input_untouched():
    rf = {"type": "json_schema", "json_schema": {"name": "x", "strict": True, "schema": {}}}
    payload = build_payload(
        model="ollama:hermes3",
        messages=MSGS,
        reasoning={"effort": "high"},
        max_tokens=100,
        response_format=rf,
        plugins=[{"id": "web"}],
    )
    payload["usage"] = {"include": True}  # anything OpenRouter-only goes too
    before = json.dumps(payload, sort_keys=True)
    out = ollama.sanitize_payload(payload, "ollama:hermes3")
    assert out == SANITISED
    for key in DROPPED:
        assert key not in out
    assert json.dumps(payload, sort_keys=True) == before


def test_sanitize_payload_without_max_tokens():
    payload = build_payload(
        model="ollama:hermes3",
        messages=MSGS,
        reasoning=None,
        max_tokens=None,
        response_format=None,
        plugins=None,
    )
    out = ollama.sanitize_payload(payload, "ollama:hermes3")
    assert "max_tokens" not in out
    assert out == {
        "model": "hermes3",
        "messages": MSGS,
        "stream": True,
        "stream_options": {"include_usage": True},
    }


@pytest.mark.parametrize(
    "value,expected",
    [
        (None, ollama.DEFAULT_BASE_URL),
        ("", ollama.DEFAULT_BASE_URL),
        ("   ", ollama.DEFAULT_BASE_URL),
        ("http://ollama.test:11435/v1", "http://ollama.test:11435/v1"),
        (" http://ollama.test:11435/v1/ ", "http://ollama.test:11435/v1/"),
    ],
)
def test_base_url_env(monkeypatch, value, expected):
    if value is None:
        monkeypatch.delenv("OLLAMA_BASE_URL", raising=False)
    else:
        monkeypatch.setenv("OLLAMA_BASE_URL", value)
    assert ollama.base_url() == expected
    assert ollama.DEFAULT_BASE_URL == "http://127.0.0.1:11434/v1"


# --------------------------------------------------------------------------- loopback warning
@pytest.fixture
def fresh_warnings(monkeypatch, caplog):
    """A clean per-process warning memo (`warn_if_remote` warns once per host) + WARNING capture."""
    monkeypatch.setattr(ollama, "_warned_hosts", set())
    caplog.set_level(logging.WARNING, logger="triplex.llm.ollama")
    return caplog


def _remote_warnings(caplog) -> list[str]:
    return [
        r.getMessage()
        for r in caplog.records
        if r.name == "triplex.llm.ollama" and r.levelno == logging.WARNING
    ]


@pytest.mark.parametrize(
    "url",
    [
        ollama.DEFAULT_BASE_URL,
        "http://localhost:11434/v1",
        "http://LOCALHOST:11434/v1",
        "http://localhost./v1",
        "http://[::1]:11434/v1",
        "https://127.0.0.1/v1",
    ],
)
def test_is_loopback_accepts_every_loopback_spelling(url):
    assert ollama.is_loopback(url) is True
    assert ollama.host_of(url) is not None


@pytest.mark.parametrize(
    "url",
    [
        "http://10.0.0.5:11434/v1",
        "http://ollama.test:11435/v1",
        "http://127.0.0.1.evil.example/v1",
        "http://[::2]:11434/v1",
        "ollama.test:11435/v1",  # no scheme: no parsable host, so not loopback either
        "",
    ],
)
def test_is_loopback_rejects_everything_else(url):
    assert ollama.is_loopback(url) is False


def test_warn_if_remote_is_silent_for_a_loopback_base_url(fresh_warnings):
    assert ollama.warn_if_remote(ollama.DEFAULT_BASE_URL) is None
    assert ollama.warn_if_remote(" http://localhost:11434/v1 ") is None
    assert _remote_warnings(fresh_warnings) == []


def test_warn_if_remote_warns_once_per_process_naming_the_host(fresh_warnings):
    assert ollama.warn_if_remote("http://10.0.0.5:11434/v1") == "10.0.0.5"
    assert ollama.warn_if_remote("http://10.0.0.5:11434/v1") is None  # once per process
    assert ollama.warn_if_remote("http://10.0.0.5:9999/v1") is None  # same host, other port
    lines = _remote_warnings(fresh_warnings)
    assert len(lines) == 1
    assert "OLLAMA_BASE_URL" in lines[0] and "10.0.0.5" in lines[0]
    assert "non-loopback" in lines[0] and "network" in lines[0]
    assert ollama.warn_if_remote("http://ollama.test:11435/v1") == "ollama.test"  # a new host
    assert len(_remote_warnings(fresh_warnings)) == 2


def test_warn_if_remote_names_an_unparsable_value_verbatim(fresh_warnings):
    assert ollama.warn_if_remote("ollama.test:11435/v1") == "ollama.test:11435/v1"
    assert "ollama.test:11435/v1" in _remote_warnings(fresh_warnings)[0]


async def test_a_remote_base_url_is_served_after_one_warning(
    respx_router, monkeypatch, fresh_warnings
):
    """No refusal (the user may run Ollama on another box) -- but the log says where it went."""
    monkeypatch.setenv("OLLAMA_BASE_URL", "http://10.0.0.5:11434/v1")
    route = _route(respx_router, *_ok_payloads(), url="http://10.0.0.5:11434/v1/chat/completions")
    for _ in range(2):
        deltas = await collect(_call())
        assert kinds(deltas) == ["text", "done"]
    assert route.call_count == 2
    lines = _remote_warnings(fresh_warnings)
    assert len(lines) == 1 and "10.0.0.5" in lines[0]


async def test_the_default_base_url_streams_without_a_warning(respx_router, fresh_warnings):
    route = _route(respx_router, *_ok_payloads())
    deltas = await collect(_call())
    assert kinds(deltas) == ["text", "done"] and route.call_count == 1
    assert _remote_warnings(fresh_warnings) == []


# --------------------------------------------------------------------------- the request
async def test_payload_headers_and_url(respx_router):
    assert settings().mock_openrouter is True and not settings().openrouter_api_key
    rf = {"type": "json_schema", "json_schema": {"name": "x", "strict": True, "schema": {}}}
    route = _route(respx_router, *_ok_payloads())
    deltas = await collect(
        _call(effort="high", plugins=[{"id": "web", "max_results": 3}], response_format=rf)
    )
    assert kinds(deltas) == ["text", "done"] and deltas[0].text == "hi"
    assert route.call_count == 1
    req = route.calls.last.request
    assert str(req.url) == OLLAMA_URL
    for header in ("Authorization", "HTTP-Referer", "X-OpenRouter-Title"):
        assert header not in req.headers
    assert req.headers["Accept"] == "text/event-stream"
    assert req.headers["Content-Type"].startswith("application/json")
    body = json.loads(req.content)
    assert body == SANITISED
    for key in DROPPED:
        assert key not in body
    assert mock.calls == []  # never the mock, even under MOCK_OPENROUTER=1


async def test_complete_json_over_ollama_parses_leniently_without_response_format(respx_router):
    class Answer(BaseModel):
        answer: str

    text = "Sure!\n```json\n" + json.dumps({"answer": "42"}) + "\n```\nDone."
    route = _route(
        respx_router, chunk(content=text, finish="stop"), chunk(usage=usage_obj(cost=None))
    )
    parsed, raw, usage, error = await complete_json(
        role="analyst",
        purpose="extraction",
        model="ollama:hermes3",
        messages=MSGS,
        schema_model=Answer,
        effort="medium",
        max_tokens=100,
        retries=0,
    )
    assert parsed == Answer(answer="42") and error is None and raw == text
    assert usage.totals.calls == 1 and usage.totals.cost_usd == 0
    body = json.loads(route.calls.last.request.content)
    assert "response_format" not in body and "provider" not in body


# --------------------------------------------------------------------------- usage / cost
async def test_usage_chunk_without_cost_is_zero_and_never_asks_generation(respx_router, caplog):
    caplog.set_level(logging.INFO, logger="triplex.llm.client")
    route = _route(
        respx_router,
        chunk(content="hi", finish="stop", cid="gen-local"),
        chunk(content="", usage=usage_obj(prompt=12, completion=5, cost=None), cid="gen-local"),
        headers={"X-Generation-Id": "gen-local"},
    )
    gen_openrouter = respx_router.get(GENERATION_URL).mock(
        return_value=httpx.Response(200, json={"data": {"total_cost": 9.9}})
    )
    gen_local = respx_router.get(OLLAMA_GENERATION_URL).mock(
        return_value=httpx.Response(200, json={"data": {"total_cost": 9.9}})
    )
    deltas = await collect(_call())
    assert kinds(deltas) == ["text", "done"]
    u = deltas[-1].usage
    assert not isinstance(u, metering.EstimatedUsage)
    assert (u.prompt_tokens, u.completion_tokens, u.cost_usd) == (12, 5, 0.0)
    assert (u.model, u.role, u.purpose) == ("ollama:hermes3", "analyst", "extraction")
    assert u.latency_ms >= 0 and u.generation_id == "gen-local"
    assert route.call_count == 1
    assert gen_openrouter.call_count == 0 and gen_local.call_count == 0
    assert respx_router.calls.call_count == 1  # the one POST and nothing else
    assert metering.session_cost_usd() == 0.0
    lines = [
        r.getMessage()
        for r in caplog.records
        if r.name == "triplex.llm.client" and r.getMessage().startswith("llm call")
    ]
    assert len(lines) == 1
    assert "model=ollama:hermes3" in lines[0] and "cost_source=catalog" in lines[0]
    assert "cost_usd=0.000000" in lines[0]
    assert "transport=mock" not in lines[0] and "usage=estimated" not in lines[0]


async def test_no_usage_chunk_synthesises_an_estimated_usage(respx_router, caplog):
    caplog.set_level(logging.INFO, logger="triplex.llm.client")
    route = _route(respx_router, chunk(content="x" * 80, finish="stop"))  # [DONE], no usage
    deltas = await collect(_call())
    assert kinds(deltas) == ["text", "done"]
    u = deltas[-1].usage
    assert isinstance(u, metering.EstimatedUsage)
    assert u.completion_tokens == 20 and u.cost_usd == 0.0 and u.model == "ollama:hermes3"
    assert route.call_count == 1 and respx_router.calls.call_count == 1
    assert "usage=estimated" in caplog.text
    assert metering.session_cost_usd() == 0.0


# --------------------------------------------------------------------------- failures
async def test_connection_refused_is_a_transport_error_delta(respx_router):
    respx_router.post(OLLAMA_URL).mock(side_effect=httpx.ConnectError("Connection refused"))
    deltas = await collect(_call())
    assert kinds(deltas) == ["error"]
    e = deltas[0]
    assert e.code == "transport_error" and e.error_type == "triplex"
    assert "ConnectError" in e.message and "Connection refused" in e.message
    assert mock.calls == []


async def test_http_error_from_the_local_server_is_an_error_delta(respx_router):
    respx_router.post(OLLAMA_URL).mock(
        return_value=httpx.Response(
            404, json={"error": {"message": "model 'hermes3' not found", "type": "api_error"}}
        )
    )
    deltas = await collect(_call())
    assert kinds(deltas) == ["error"]
    assert deltas[0].code == 404 and deltas[0].message == "model 'hermes3' not found"


async def test_mid_stream_error_chunk_passes_through(respx_router):
    _route(respx_router, error_chunk(500, "model not loaded", "server_error"))
    deltas = await collect(_call())
    assert kinds(deltas) == ["error"]
    assert deltas[0].code == 500 and deltas[0].message == "model not loaded"


# --------------------------------------------------------------------------- not consulted
@pytest.mark.parametrize("mock_flag", ["0", "1"])
async def test_cost_cap_and_key_check_are_not_consulted(respx_router, monkeypatch, mock_flag):
    monkeypatch.setenv("MOCK_OPENROUTER", mock_flag)
    monkeypatch.setenv("OPENROUTER_API_KEY", "fake-key")
    monkeypatch.setenv("SESSION_COST_CAP_USD", "0.5")
    metering.add_session_cost(1.0)  # the cap is exceeded for any OpenRouter call
    assert metering.session_cost_status()["exceeded"] is True
    route = _route(respx_router, *_ok_payloads())
    deltas = await collect(_call())
    assert kinds(deltas) == ["text", "done"] and route.call_count == 1
    assert "Authorization" not in route.calls.last.request.headers  # the fake key is unused
    assert deltas[-1].usage.cost_usd == 0.0
    assert metering.session_cost_usd() == pytest.approx(1.0)  # nothing added
    assert mock.calls == []


async def test_missing_key_is_irrelevant(respx_router, monkeypatch):
    monkeypatch.setenv("MOCK_OPENROUTER", "0")
    monkeypatch.setenv("OPENROUTER_API_KEY", "")
    route = _route(respx_router, *_ok_payloads())
    openrouter = respx_router.post(CHAT_URL).mock(return_value=httpx.Response(500))
    deltas = await collect(_call())
    assert kinds(deltas) == ["text", "done"]
    assert route.call_count == 1 and openrouter.call_count == 0


async def test_mock_fixtures_never_replay_an_ollama_model(mini_fixtures, respx_router):
    route = _route(respx_router, *_ok_payloads())
    deltas = await collect(_call())
    assert kinds(deltas) == ["text", "done"] and deltas[0].text == "hi"
    assert route.call_count == 1 and mock.calls == []


async def test_ollama_base_url_is_honoured(respx_router, monkeypatch):
    monkeypatch.setenv("OLLAMA_BASE_URL", "http://ollama.test:11435/v1/")
    alt = _route(respx_router, *_ok_payloads(), url="http://ollama.test:11435/v1/chat/completions")
    default = _route(respx_router, *_ok_payloads())
    deltas = await collect(_call())
    assert kinds(deltas) == ["text", "done"]
    assert alt.call_count == 1 and default.call_count == 0
    assert str(alt.calls.last.request.url) == "http://ollama.test:11435/v1/chat/completions"


# --------------------------------------------------------------------------- desktop mode
async def test_desktop_mode_allows_ollama_and_refuses_openrouter_models(respx_router, monkeypatch):
    monkeypatch.setenv("TRIPLEX_DESKTOP", "1")
    route = _route(respx_router, *_ok_payloads())
    deltas = await collect(_call())
    assert kinds(deltas) == ["text", "done"] and route.call_count == 1
    for model in ("openai/gpt-5", "x-ai/grok-4.6", "anthropic/claude-opus-5"):
        deltas = await collect(_call(model=model))
        assert kinds(deltas) == ["error"]
        assert deltas[0].code == "transport_disabled" and deltas[0].error_type == "triplex"
    assert route.call_count == 1 and mock.calls == []
    assert respx_router.calls.call_count == 1


async def test_desktop_mode_ollama_with_the_spawn_env_pins(respx_router, monkeypatch):
    """Electron pins `OPENROUTER_API_KEY=''`, `MOCK_OPENROUTER=0`, `TRIPLEX_DESKTOP=1`."""
    monkeypatch.setenv("TRIPLEX_DESKTOP", "1")
    monkeypatch.setenv("MOCK_OPENROUTER", "0")
    monkeypatch.setenv("OPENROUTER_API_KEY", "")
    route = _route(respx_router, *_ok_payloads())
    deltas = await collect(_call(model="ollama:hermes3", effort="off"))
    assert kinds(deltas) == ["text", "done"] and route.call_count == 1
    assert json.loads(route.calls.last.request.content) == SANITISED
