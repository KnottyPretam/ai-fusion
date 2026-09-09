"""The session cost cap on the Send / continue path over the REAL transport (respx, offline):
`SESSION_COST_CAP_USD=0` refuses every slot with `slot_error{code:"cost_cap_exceeded"}` before
any request leaves the process, nothing is appended to the threads, the turn is still persisted,
and `metering.session_cost_status()` reports the refusal (PLAN.md Phase 5 cost control;
docs/api-contract.md "Cost cap").

The last two tests drive the same cap through Analyze and Fusion over the httpx path: the
exact strings those features emit (`analyze_retry.error`, `AnalyzeTurn.error`, `Exchange.error`
after `anon.scrub`) are what `scripts/record_fixtures.py::_cost_capped` keys its exit code 3 on."""

from __future__ import annotations

import json

import httpx
import pytest

from backend.llm import metering
from backend.schemas import SLOT_IDS
from tests.conftest import DEFAULT_PROMPT, DEFAULT_RESPONSES
from tests.helpers import parse_sse_text
from tests.llm import test_scripts as scripts_tests
from tests.send.conftest import assert_stream_invariants, of_type, one

BASE_URL = "https://openrouter.test/api/v1"
CHAT_URL = BASE_URL + "/chat/completions"


def _sse(*payloads: dict) -> bytes:
    return "".join(f"data: {json.dumps(p)}\n\n" for p in payloads).encode() + b"data: [DONE]\n\n"


def _ok_body(text: str, cost: float) -> bytes:
    return _sse(
        {
            "id": "gen-1",
            "choices": [{"index": 0, "delta": {"content": text}, "finish_reason": "stop"}],
        },
        {
            "id": "gen-1",
            "choices": [{"index": 0, "delta": {"content": ""}, "finish_reason": None}],
            "usage": {
                "prompt_tokens": 10,
                "completion_tokens": 5,
                "total_tokens": 15,
                "cost": cost,
                "completion_tokens_details": {"reasoning_tokens": 0},
            },
        },
    )


@pytest.fixture
def live_capped(monkeypatch, _block_outbound_http):
    """Real httpx path (docs/api-contract.md addendum), fake key, cap 0, fresh session total.
    The route answers 500 so a request that DOES escape shows up as a provider error, never as
    the refusal under test."""
    metering.reset_session_cost()
    monkeypatch.setenv("MOCK_OPENROUTER", "0")
    monkeypatch.setenv("OPENROUTER_API_KEY", "test-key")
    monkeypatch.setenv("OPENROUTER_BASE_URL", BASE_URL)
    monkeypatch.setenv("SESSION_COST_CAP_USD", "0")
    route = _block_outbound_http.post(CHAT_URL).mock(return_value=httpx.Response(500))
    yield route
    metering.reset_session_cost()


async def test_send_with_cap_zero_yields_cost_cap_exceeded_for_every_slot(
    cid, send, get_conv, live_capped
):
    events = await send(cid)
    assert_stream_invariants(events)
    assert not of_type(events, "slot_delta", "slot_reasoning", "slot_citations", "slot_done")
    for slot in SLOT_IDS:
        err = one(events, "slot_error", slot)
        assert err["code"] == "cost_cap_exceeded" and err["error_type"] == "triplex"
        assert err["partial"] == ""
        assert "SESSION_COST_CAP_USD=$0.00" in err["message"] and "refused" in err["message"]
    done = events[-1]
    assert done["usage"]["totals"]["calls"] == 0 and done["usage"]["totals"]["cost_usd"] == 0
    assert live_capped.call_count == 0  # refused before any request left the process

    conv = await get_conv(cid)
    turn = conv["turns"][0]
    assert turn["type"] == "send" and turn["responses"] == dict.fromkeys(SLOT_IDS)
    assert set(turn["errors"]) == set(SLOT_IDS)
    assert all("cost cap" in m for m in turn["errors"].values())
    assert turn["partial"] == dict.fromkeys(SLOT_IDS, "")
    for slot in SLOT_IDS:
        assert conv["threads"][slot] == []  # no orphan user message
    status = metering.session_cost_status()
    assert status["exceeded"] is True and status["enforced"] is True
    assert (
        status["spent_usd"] == 0.0 and status["cap_usd"] == 0.0 and status["remaining_usd"] == 0.0
    )


async def test_continue_with_cap_zero_is_refused_the_same_way(cid, cont, get_conv, live_capped):
    events = await cont(cid, "grok", "Solo.")
    assert_stream_invariants(events, slots=("grok",))
    err = one(events, "slot_error", "grok")
    assert err["code"] == "cost_cap_exceeded" and err["error_type"] == "triplex"
    assert live_capped.call_count == 0
    conv = await get_conv(cid)
    t = conv["turns"][0]
    assert t["type"] == "continue" and t["response"] is None
    assert t["error"] and "cost cap" in t["error"]
    assert conv["threads"]["grok"] == []


async def test_cap_is_checked_against_the_running_total_before_each_call(
    cid, send, get_conv, live_capped, monkeypatch
):
    """Below the cap the three slots run (each checked against the total at its start); once the
    session total reaches the cap the next Send is refused wholesale."""
    monkeypatch.setenv("SESSION_COST_CAP_USD", "0.01")
    live_capped.mock(return_value=httpx.Response(200, content=_ok_body("ok", 0.004)))
    first = await send(cid)
    assert_stream_invariants(first)
    assert len(of_type(first, "slot_done")) == 3 and not of_type(first, "slot_error")
    assert live_capped.call_count == 3
    assert metering.session_cost_usd() == pytest.approx(0.012)
    assert metering.session_cost_status() == {
        "spent_usd": pytest.approx(0.012),
        "cap_usd": 0.01,
        "remaining_usd": 0.0,
        "exceeded": True,
        "enforced": True,
    }

    second = await send(cid, "Again")
    assert_stream_invariants(second)
    assert {e["code"] for e in of_type(second, "slot_error")} == {"cost_cap_exceeded"}
    assert len(of_type(second, "slot_error")) == 3
    assert live_capped.call_count == 3  # no further request
    conv = await get_conv(cid)
    assert [t["type"] for t in conv["turns"]] == ["send", "send"]
    assert conv["turns"][1]["responses"] == dict.fromkeys(SLOT_IDS)
    for slot in SLOT_IDS:  # only the first send's pair is in the threads
        assert [m["content"] for m in conv["threads"][slot]] == [DEFAULT_PROMPT, "ok"]


async def test_cap_is_not_enforced_in_mock_mode(cid, send, monkeypatch):
    monkeypatch.setenv("SESSION_COST_CAP_USD", "0")
    events = await send(cid)
    assert_stream_invariants(events)
    assert len(of_type(events, "slot_done")) == 3
    assert metering.session_cost_status()["enforced"] is False


# --------------------------------------------------------------------------- Analyze / Fusion
def _cost_capped(events: list[dict]) -> bool:
    return scripts_tests.load_script("record_fixtures")._cost_capped(events)


async def test_analyze_with_cap_zero_degrades_with_cost_cap_exceeded(
    client, persisted_conversation, live_capped
):
    """Both analyst attempts are refused before any request: the retry carries the stable key,
    the persisted turn is degraded with the same key, and the recorder script recognises it."""
    cid = persisted_conversation.id
    r = await client.post(f"/api/conversations/{cid}/analyze", json={})
    assert r.status_code == 200, r.text
    events = parse_sse_text(r.text)
    assert [e["type"] for e in events] == ["analyze_start", "analyze_retry", "analyze_degraded"]
    assert events[1]["error"] == "cost_cap_exceeded"
    turn = events[2]["turn"]
    assert turn["status"] == "degraded" and turn["error"] == "cost_cap_exceeded"
    assert turn["extraction"] is None and turn["raw_attempts"] == ["", ""]
    assert turn["usage"]["totals"] == {
        "prompt_tokens": 0,
        "completion_tokens": 0,
        "reasoning_tokens": 0,
        "cost_usd": 0.0,
        "latency_ms": turn["usage"]["totals"]["latency_ms"],
        "calls": 0,
    }
    assert live_capped.call_count == 0  # refused before any request left the process
    assert _cost_capped(events)
    conv = (await client.get(f"/api/conversations/{cid}")).json()
    assert [t["type"] for t in conv["turns"]] == ["send", "analyze"]
    assert conv["turns"][1]["status"] == "degraded"


async def test_fusion_with_cap_zero_marks_every_exchange_unavailable_and_exits_error(
    client, persisted_conversation, live_capped, monkeypatch
):
    """An ok Analyze from the mock corpus first (planted_factual: d1 high), then Fusion over the
    capped live transport: every defense call is refused, every exchange is `unavailable` with
    the stable key as its (scrubbed) error, the round exits `error`, nothing is appended."""
    cid = persisted_conversation.id
    monkeypatch.setenv("MOCK_OPENROUTER", "1")
    r = await client.post(f"/api/conversations/{cid}/analyze", json={})
    assert r.status_code == 200, r.text
    analyze = parse_sse_text(r.text)
    assert analyze[-1]["type"] == "analyze_done" and analyze[-1]["turn"]["status"] == "ok"
    monkeypatch.setenv("MOCK_OPENROUTER", "0")

    r = await client.post(f"/api/conversations/{cid}/fusion", json={"max_iterations": 2})
    assert r.status_code == 200, r.text
    events = parse_sse_text(r.text)
    assert events[0]["type"] == "fusion_start" and events[0]["standing"] == ["d1"]
    exchanges = of_type(events, "exchange")
    assert [e["model"] for e in exchanges] == ["R1", "R2", "R3"]
    for e in exchanges:
        assert e["stance"] == "unavailable" and e["error"] == "cost_cap_exceeded"
        assert e["confidence"] is None and e["revised_claim"] is None
    assert [e["type"] for e in events[-2:]] == ["round_done", "fusion_done"]
    done = events[-1]
    assert done["exit_reason"] == "error" and len(done["turn"]["rounds"]) == 1
    assert done["turn"]["final"] == [{"divergence_id": "d1", "status": "standing"}]
    assert done["usage"]["totals"]["calls"] == 0 and done["usage"]["totals"]["cost_usd"] == 0
    assert live_capped.call_count == 0
    assert _cost_capped(events)
    conv = (await client.get(f"/api/conversations/{cid}")).json()
    assert [t["type"] for t in conv["turns"]] == ["send", "analyze", "fusion"]
    for slot in SLOT_IDS:  # no challenge/reply pair was appended
        assert [m["content"] for m in conv["threads"][slot]] == [
            DEFAULT_PROMPT,
            DEFAULT_RESPONSES[slot],
        ]
