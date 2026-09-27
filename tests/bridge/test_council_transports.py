"""A MIXED council through one Send (2026-09-27): chatgpt on its web session (the bridge), deepseek
on local Ollama (respx), qwen on OpenRouter (the mock). One transport each -- exactly one bridge
request, one Ollama call, one mock call with role `qwen` -- and three [user, assistant] pairs.
A mixed council cannot replay through the mock alone (`web:` / `ollama:` route before the mock
branch), which is why it is covered here and not by a shipped scenario."""

from __future__ import annotations

import json

import httpx

from backend.llm import mock
from tests.bridge.test_flow import create, get, stream
from tests.e2e.conftest import assert_send_stream_invariants, one
from tests.llm.conftest import chunk, sse_body, usage_obj

OLLAMA_URL = "http://127.0.0.1:11434/v1/chat/completions"
PROMPT = "What pull-up resistor value should I use on a 400 kHz I2C bus running at 3.3 V?"
COUNCIL = ("chatgpt", "deepseek", "qwen")
SLOT_CONFIG = {
    "slots": {
        "chatgpt": {"model": "web:chatgpt", "effort": "off"},
        "deepseek": {"model": "ollama:deepseek-r1:14b", "effort": "off"},
        "qwen": {"model": "qwen/qwen3.7-max", "effort": "medium"},
    },
    "analyst_model": "web:chatgpt:analyst",
    "max_iterations": 2,
    "materiality_min": "medium",
    "grounded": False,
}


async def test_one_send_over_three_transports(
    client, fake_desktop, _block_outbound_http, monkeypatch
):
    monkeypatch.setenv("MOCK_SCENARIO", "council_two")  # has qwen.chat.1
    monkeypatch.setenv("BRIDGE_ACCEPT_TIMEOUT_S", "3")
    monkeypatch.setenv("BRIDGE_TIMEOUT_S", "10")
    monkeypatch.setenv("OLLAMA_BASE_URL", "http://127.0.0.1:11434/v1")
    mock.reset()
    desk = await fake_desktop({("chatgpt", "pane", "chat"): "from the pane"})
    ollama_route = _block_outbound_http.post(OLLAMA_URL).mock(
        return_value=httpx.Response(
            200,
            content=sse_body(
                chunk(content="from the local model", finish="stop", cid="gen-local"),
                chunk(content="", usage=usage_obj(cost=None), cid="gen-local"),
            ),
        )
    )

    cid = await create(client, slot_config=SLOT_CONFIG)
    r, events = await stream(client, f"/api/conversations/{cid}/send", {"prompt": PROMPT})
    assert r.status_code == 200, r.text
    assert events[0]["slots"] == list(COUNCIL)
    assert_send_stream_invariants(events, COUNCIL)
    texts = {
        slot: "".join(e["text"] for e in events if e["type"] == "slot_delta" and e["slot"] == slot)
        for slot in COUNCIL
    }
    assert texts["chatgpt"] == "from the pane" and texts["deepseek"] == "from the local model"
    assert texts["qwen"]  # the mock's qwen.chat.1 fixture text
    for slot in COUNCIL:
        assert one(events, "slot_done", slot)["usage"]["model"] == SLOT_CONFIG["slots"][slot]["model"]
    assert events[-1]["usage"]["totals"]["calls"] == 3

    # one request per transport, and nothing crossed to another one
    assert len(desk.requests) == 1 and desk.requests[0]["slot"] == "chatgpt"
    assert desk.requests[0]["model"] == "web:chatgpt" and desk.requests[0]["text"] == PROMPT
    assert ollama_route.call_count == 1
    sent = json.loads(ollama_route.calls.last.request.content)
    assert sent["model"] == "deepseek-r1:14b" and sent["messages"][-1]["content"] == PROMPT
    assert [(c["role"], c["purpose"], c["model"]) for c in mock.calls] == [
        ("qwen", "chat", "qwen/qwen3.7-max")
    ]
    assert mock.calls[0]["fixture"] == "council_two/qwen.chat.1.jsonl"

    conv = await get(client, cid)
    assert tuple(conv["threads"]) == COUNCIL
    for slot in COUNCIL:
        assert [(m["role"], m["content"]) for m in conv["threads"][slot]] == [
            ("user", PROMPT),
            ("assistant", texts[slot]),
        ]
    turn = conv["turns"][0]
    assert turn["responses"] == texts and turn["errors"] == {}
    assert list(turn["slot_config"]["slots"]) == list(COUNCIL)
    assert desk.errors == [] and desk.cancels == []


async def test_web_model_on_a_vendor_without_an_adapter_is_refused_at_put_time(client):
    cid = await create(client)
    cfg = dict(SLOT_CONFIG)
    cfg["slots"] = {**SLOT_CONFIG["slots"], "deepseek": {"model": "web:deepseek", "effort": "off"}}
    r = await client.put(f"/api/conversations/{cid}/slot_config", json=cfg)
    assert r.status_code == 422
    assert r.json()["detail"] == {"error": "web_slot_mismatch", "slot": "deepseek", "model": "web:deepseek"}
    cfg["slots"] = {**SLOT_CONFIG["slots"], "qwen": {"model": "web:chatgpt", "effort": "off"}}
    r = await client.put(f"/api/conversations/{cid}/slot_config", json=cfg)
    assert r.status_code == 422 and r.json()["detail"]["error"] == "web_slot_mismatch"
