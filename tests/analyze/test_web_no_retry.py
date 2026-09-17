"""Analyze's web no-retry rule (desktop-catalog-and-ollama S3; the S6 review's deferred finding):
over the real HTTP API with `web_env` and a `fake_desktop` from tests/bridge/conftest.py, a
web-session analyst whose first attempt fails with a transport/site error (no output) is NOT asked
again -- exactly one analyst request frame, `analyze_degraded` with the site message -- while a
parse/validation failure WITH output still gets the correction attempt in the same chat
(`fresh:false`). Mock-mode Analyze (the `analyst_retry` scenario, the transport-error local
fixture) is unchanged."""

from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx
import pytest

from backend.features import analyze as feature
from backend.llm import bridge, mock
from backend.prompts import analyze as prompts
from tests.analyze.conftest import extraction_calls, extraction_text, persist
from tests.bridge import conftest as bridge_fixtures
from tests.e2e.conftest import scenario_prompt
from tests.helpers import parse_sse_text

# Fixtures reused from the bridge area: pytest registers a fixture under the module attribute it
# finds it at, so these bindings make `fake_desktop` / `web_env` / the autouse hub reset available
# here (as assignments, not imports, so the test parameters of the same name shadow nothing).
_fresh_hub = bridge_fixtures._fresh_hub
fake_desktop = bridge_fixtures.fake_desktop
web_env = bridge_fixtures.web_env
planted = bridge_fixtures.planted
planted_script = bridge_fixtures.planted_script

PROMPT = scenario_prompt("planted_factual")
ANALYST = ("chatgpt", "analyst", "extraction")
PROSE = "Sure! Here is my comparison of the three answers, in prose rather than JSON."
SCHEMA_BREAKING = json.dumps({"agreements": "none", "divergences": [{"id": "d1"}]})
GOOD = planted("analyst.extraction.1.jsonl")


def _types(events: list[dict[str, Any]]) -> list[str]:
    return [e["type"] for e in events]


async def _conversation_with_send(client: httpx.AsyncClient) -> str:
    r = await client.post("/api/conversations", json={})
    assert r.status_code == 201, r.text
    cid = r.json()["id"]
    r = await client.post(f"/api/conversations/{cid}/send", json={"prompt": PROMPT})
    assert r.status_code == 200, r.text
    events = parse_sse_text(r.text)
    assert events[-1]["type"] == "turn_done"
    return cid


async def _analyze(client: httpx.AsyncClient, cid: str) -> list[dict[str, Any]]:
    r = await client.post(f"/api/conversations/{cid}/analyze", json={})
    assert r.status_code == 200, r.text
    return parse_sse_text(r.text)


async def _last_turn(client: httpx.AsyncClient, cid: str) -> dict[str, Any]:
    r = await client.get(f"/api/conversations/{cid}")
    assert r.status_code == 200, r.text
    assert "anon_map" not in r.text
    return r.json()["turns"][-1]


# --------------------------------------------------------------------------- no output: no retry
@pytest.mark.parametrize(
    "entry,message",
    [
        ({"error": "site_error"}, "site_error on chatgpt"),
        (
            {"error": "site_error", "message": "the page showed an error banner"},
            "the page showed an error banner",
        ),
        ({"error": "timeout", "partial": "half a reply"}, "timeout on chatgpt"),
        ({"reject": "challenge"}, "challenge on chatgpt"),
        ({"reject": "logged_out"}, "logged_out on chatgpt"),
    ],
)
async def test_site_error_on_the_first_attempt_degrades_without_a_second_request(
    client, web_env, fake_desktop, entry, message
):
    desk = await fake_desktop(planted_script({ANALYST: entry}))
    cid = await _conversation_with_send(client)
    events = await _analyze(client, cid)
    assert _types(events) == ["analyze_start", "analyze_degraded"]
    turn = events[-1]["turn"]
    assert turn["status"] == "degraded" and turn["error"] == message
    assert turn["raw_attempts"] == [""] and turn["extraction"] is None
    assert len(desk.of(*ANALYST)) == 1  # exactly one analyst request frame
    assert desk.of(*ANALYST)[0]["fresh"] is True
    assert desk.errors == [] and mock.calls == []
    persisted = await _last_turn(client, cid)
    assert persisted["type"] == "analyze" and persisted["status"] == "degraded"
    assert persisted["error"] == message and persisted["raw_attempts"] == [""]


async def test_no_ack_on_the_first_attempt_degrades_without_a_second_request(
    client, web_env, fake_desktop, monkeypatch
):
    monkeypatch.setenv("BRIDGE_ACCEPT_TIMEOUT_S", "0.3")
    desk = await fake_desktop(planted_script({ANALYST: "drop"}))
    cid = await _conversation_with_send(client)
    events = await _analyze(client, cid)
    assert _types(events) == ["analyze_start", "analyze_degraded"]
    turn = events[-1]["turn"]
    assert turn["error"] == "no accepted/rejected within 0.3s" and turn["raw_attempts"] == [""]
    (req,) = desk.of(*ANALYST)
    await asyncio.sleep(0.01)  # let the fake drain the cancel frame
    assert desk.cancels == [req["req_id"]]
    assert mock.calls == []


@pytest.mark.parametrize("text", ["", "   \n\t"])
async def test_empty_captured_reply_degrades_without_a_second_request(
    client, web_env, fake_desktop, text
):
    """Documented reading: a captured reply with no text (the bridge maps whitespace-only text
    to no text delta) is "no output" too, so a web analyst is not asked again."""
    desk = await fake_desktop(planted_script({ANALYST: text}))
    cid = await _conversation_with_send(client)
    events = await _analyze(client, cid)
    assert _types(events) == ["analyze_start", "analyze_degraded"]
    turn = events[-1]["turn"]
    assert turn["error"] == "parse_error: empty response" and turn["raw_attempts"] == [""]
    assert len(desk.of(*ANALYST)) == 1 and mock.calls == []


async def test_bridge_unavailable_degrades_without_a_second_request(
    client, web_env, make_conversation
):
    """No desktop connected: `bridge_unavailable` is a transport error with no output."""
    assert bridge.hub.connected is False
    conv = make_conversation(prompt=PROMPT)  # a complete send turn; the send itself needs a desktop
    conv.slot_config.analyst_model = "web:chatgpt:analyst"
    stored = await persist(conv)
    events = await _analyze(client, stored.id)
    assert _types(events) == ["analyze_start", "analyze_degraded"]
    turn = events[-1]["turn"]
    assert turn["error"] == "no desktop client is connected" and turn["raw_attempts"] == [""]
    assert mock.calls == []


# --------------------------------------------------------------------------- output: corrected
@pytest.mark.parametrize("bad", [PROSE, SCHEMA_BREAKING])
async def test_invalid_output_then_valid_is_corrected_in_the_same_chat(
    client, web_env, fake_desktop, bad
):
    desk = await fake_desktop(planted_script({ANALYST: [bad, GOOD]}))
    cid = await _conversation_with_send(client)
    events = await _analyze(client, cid)
    assert _types(events) == ["analyze_start", "analyze_retry", "analyze_done"]
    retry_error = events[1]["error"]
    if bad is PROSE:
        assert retry_error.startswith("parse_error:")
    else:
        assert "validation error" in retry_error
    turn = events[-1]["turn"]
    assert turn["status"] == "ok" and turn["error"] is None and events[-1]["cached"] is False
    assert turn["raw_attempts"] == [bad, GOOD]
    assert turn["usage"]["totals"]["calls"] == 2
    first, second = desk.of(*ANALYST)  # two requests: the prompt, then the correction
    assert first["fresh"] is True and second["fresh"] is False
    assert first["req_id"] != second["req_id"]
    assert second["text"] == prompts.retry_message(retry_error)
    assert second["model"] == "web:chatgpt:analyst" and second["purpose"] == "extraction"
    assert desk.errors == [] and mock.calls == []


async def test_site_error_on_the_correction_attempt_degrades_with_that_error(
    client, web_env, fake_desktop
):
    desk = await fake_desktop(planted_script({ANALYST: [PROSE, {"error": "site_error"}]}))
    cid = await _conversation_with_send(client)
    events = await _analyze(client, cid)
    assert _types(events) == ["analyze_start", "analyze_retry", "analyze_degraded"]
    turn = events[-1]["turn"]
    assert turn["status"] == "degraded" and turn["error"] == "site_error on chatgpt"
    assert turn["raw_attempts"] == [PROSE, ""]
    assert len(desk.of(*ANALYST)) == 2 and mock.calls == []


# --------------------------------------------------------------------------- mock mode unchanged
async def test_mock_mode_analyst_retry_scenario_is_unchanged(scenario_conversation, analyze):
    conv = await scenario_conversation("analyst_retry")
    r, events = await analyze(conv.id)
    assert r.status_code == 200
    assert _types(events) == ["analyze_start", "analyze_retry", "analyze_done"]
    assert events[-1]["turn"]["raw_attempts"] == [
        extraction_text("analyst_retry", 1),
        extraction_text("analyst_retry", 2),
    ]
    calls = extraction_calls()
    assert len(calls) == 2
    assert calls[1]["messages"][-1]["content"] == prompts.retry_message(events[1]["error"])


async def test_mock_mode_transport_error_still_retries_the_identical_request(
    persisted_conversation, analyze, local_fixtures
):
    local_fixtures("analyst_transport_error")
    r, events = await analyze(persisted_conversation.id)
    assert r.status_code == 200
    assert _types(events) == ["analyze_start", "analyze_retry", "analyze_degraded"]
    assert events[1]["error"] == "Provider disconnected"
    assert events[-1]["turn"]["raw_attempts"] == ["", ""]
    calls = extraction_calls()
    assert len(calls) == 2 and calls[0]["messages"] == calls[1]["messages"]


# --------------------------------------------------------------------------- the rule itself
def test_web_retry_suppressed_is_web_only_and_no_output_only():
    assert feature.web_retry_suppressed("web:chatgpt:analyst", "", "site_error on chatgpt")
    assert feature.web_retry_suppressed("web:claude:analyst", "", "parse_error: empty response")
    assert feature.web_retry_suppressed("web:grok", "", "bridge_unavailable")
    assert not feature.web_retry_suppressed("web:chatgpt:analyst", "{not json", "parse_error: x")
    assert not feature.web_retry_suppressed("web:chatgpt:analyst", "  \n", "parse_error: empty")
    assert not feature.web_retry_suppressed("web:chatgpt:analyst", "", None)
    assert not feature.web_retry_suppressed("ollama:hermes3", "", "transport_error")
    assert not feature.web_retry_suppressed("anthropic/claude-opus-5", "", "Provider disconnected")
    assert feature.ATTEMPTS == 2
