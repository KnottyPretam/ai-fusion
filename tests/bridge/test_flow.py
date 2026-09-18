"""Whole flows over the real HTTP API with `web:*` models: the ASGI `client`, a `fake_desktop`
answering the bridge from the planted_factual corpus, and `web_env`. The mock is never reached
(`mock.calls == []` in every test): a web session is a real transport, not a replayed fixture."""

from __future__ import annotations

import copy
from typing import Any

import pytest

from backend.config import DEFAULT_SLOT_CONFIG
from backend.llm import mock
from backend.prompts import QUOTED_DATA_NOTICE
from backend.prompts import analyze as analyze_prompts
from backend.prompts import fusion as fusion_prompts
from backend.schemas import SLOT_IDS
from tests.bridge.conftest import NOT_CAPTURED, planted, planted_script
from tests.e2e.conftest import (
    assert_fusion_stream_invariants,
    assert_send_stream_invariants,
    by_type,
    normalise_turns,
    one,
    scenario_prompt,
)
from tests.helpers import find_identity_leaks, parse_sse_text

PROMPT = scenario_prompt("planted_factual")
LABEL_OF = {"claude": "R1", "chatgpt": "R2", "grok": "R3"}
CHAT = {slot: planted(f"{slot}.chat.1.jsonl") for slot in SLOT_IDS}


async def create(client, **body: Any) -> str:
    r = await client.post("/api/conversations", json=body)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def stream(client, url: str, body: dict[str, Any]):
    r = await client.post(url, json=body)
    return r, (parse_sse_text(r.text) if r.status_code == 200 else [])


async def get(client, cid: str) -> dict[str, Any]:
    r = await client.get(f"/api/conversations/{cid}")
    assert r.status_code == 200, r.text
    assert "anon_map" not in r.text
    return r.json()


def stripped(turn: dict[str, Any]) -> dict[str, Any]:
    """A normalised turn without the parts that legitimately differ between transports."""
    out = copy.deepcopy(turn)
    out.pop("usage")
    out.pop("slot_config")
    return out


# --------------------------------------------------------------------------- send
async def test_send_three_slot_done_and_threads_appended(client, web_env, fake_desktop):
    desk = await fake_desktop(planted_script())
    cid = await create(client)
    r, events = await stream(client, f"/api/conversations/{cid}/send", {"prompt": PROMPT})
    assert r.status_code == 200, r.text
    assert_send_stream_invariants(events)
    for slot in SLOT_IDS:
        start = one(events, "slot_start", slot)
        assert start["model"] == f"web:{slot}" and start["effort"] == "off"
        assert not start["effort_coerced"]
        assert (
            "".join(e["text"] for e in events if e["type"] == "slot_delta" and e["slot"] == slot)
            == CHAT[slot]
        )
        done = one(events, "slot_done", slot)
        assert done["finish_reason"] == "stop" and done["truncated"] is False
        assert done["usage"]["cost_usd"] == 0 and done["usage"]["completion_tokens"] == 0
    totals = events[-1]["usage"]["totals"]
    assert totals["calls"] == 3 and totals["cost_usd"] == 0 and totals["prompt_tokens"] == 0

    conv = await get(client, cid)
    turn = conv["turns"][0]
    assert turn["responses"] == CHAT and turn["errors"] == {} and turn["reasoning"] == {}
    for slot in SLOT_IDS:
        msgs = conv["threads"][slot]
        assert [(m["role"], m["content"]) for m in msgs] == [
            ("user", PROMPT),
            ("assistant", CHAT[slot]),
        ]
        assert {m["turn_id"] for m in msgs} == {turn["id"]}
    assert conv["title"] == PROMPT[:60]

    assert mock.calls == []
    assert desk.errors == [] and desk.cancels == []
    assert len(desk.requests) == 3
    assert {r["slot"] for r in desk.requests} == set(SLOT_IDS)
    for req in desk.requests:
        assert req["view"] == "pane" and req["fresh"] is False and req["text"] == PROMPT
        assert req["model"] == f"web:{req['slot']}" and req["role"] == req["slot"]
        assert req["purpose"] == "chat" and req["conversation_id"] == cid


async def test_capture_off_for_grok(client, web_env, fake_desktop):
    desk = await fake_desktop(planted_script({("grok", "pane", "chat"): NOT_CAPTURED}))
    cid = await create(client)
    r, events = await stream(client, f"/api/conversations/{cid}/send", {"prompt": PROMPT})
    assert r.status_code == 200
    assert_send_stream_invariants(events)
    err = one(events, "slot_error", "grok")
    assert err["code"] == "not_captured" and err["error_type"] == "triplex"
    assert err["message"] == "capture is off for grok; the reply is in the site pane"
    assert err["partial"] == ""
    for slot in ("claude", "chatgpt"):
        one(events, "slot_done", slot)

    conv = await get(client, cid)
    assert conv["threads"]["grok"] == []
    assert len(conv["threads"]["claude"]) == 2 and len(conv["threads"]["chatgpt"]) == 2
    turn = conv["turns"][0]
    assert turn["responses"]["grok"] is None and turn["responses"]["claude"] == CHAT["claude"]
    assert turn["errors"] == {"grok": err["message"]} and turn["partial"] == {"grok": ""}
    assert turn["usage"]["totals"]["calls"] == 2

    r = await client.post(f"/api/conversations/{cid}/analyze", json={})
    assert r.status_code == 409
    assert r.json() == {"detail": {"error": "incomplete_send_turn", "missing": ["grok"]}}
    assert mock.calls == [] and desk.errors == []
    assert len(desk.requests) == 3  # the request was typed; only the capture was off


# --------------------------------------------------------------------------- the whole flow
async def test_send_analyze_fusion_over_the_bridge_matches_the_mock_run(
    client, web_env, fake_desktop, monkeypatch
):
    desk = await fake_desktop(planted_script())
    cid = await create(client)
    r, send_events = await stream(client, f"/api/conversations/{cid}/send", {"prompt": PROMPT})
    assert r.status_code == 200
    assert_send_stream_invariants(send_events)
    r, analyze_events = await stream(client, f"/api/conversations/{cid}/analyze", {})
    assert r.status_code == 200, r.text
    assert [e["type"] for e in analyze_events] == ["analyze_start", "analyze_done"]
    assert analyze_events[-1]["turn"]["status"] == "ok" and analyze_events[-1]["cached"] is False
    r, fusion_events = await stream(
        client, f"/api/conversations/{cid}/fusion", {"max_iterations": 2}
    )
    assert r.status_code == 200, r.text
    fusion_turn = assert_fusion_stream_invariants(fusion_events)
    assert fusion_turn["exit_reason"] == "converged"
    assert fusion_turn["final"] == [{"divergence_id": "d1", "status": "resolved"}]
    assert mock.calls == [] and desk.errors == [] and desk.cancels == []
    web_conv = await get(client, cid)

    # ---- the request sequence -----------------------------------------------------------
    chats = [r for r in desk.requests if r["purpose"] == "chat"]
    extractions = desk.of("chatgpt", "analyst", "extraction")
    defenses = [r for r in desk.requests if r["purpose"] == "defense"]
    convergences = desk.of("chatgpt", "analyst", "convergence")
    assert (
        len(desk.requests) == 8 == len(chats) + len(extractions) + len(defenses) + len(convergences)
    )
    assert [r["purpose"] for r in desk.requests] == ["chat"] * 3 + ["extraction"] + [
        "defense"
    ] * 3 + ["convergence"]
    assert all(r["view"] == "pane" and r["fresh"] is False for r in chats + defenses)
    assert all(r["conversation_id"] == cid for r in desk.requests)

    (extraction,) = extractions
    assert extraction["model"] == "web:chatgpt:analyst" and extraction["role"] == "analyst"
    assert extraction["fresh"] is True
    # A web analyst is asked for a FENCED json block, not for a bare object (the reply is read
    # back out of rendered markdown -- tests/bridge/test_fenced_json.py).
    system, user = analyze_prompts.build_messages(
        PROMPT, {LABEL_OF[s]: CHAT[s] for s in SLOT_IDS}, fenced=True
    )
    assert extraction["text"] == system["content"] + "\n\n" + user["content"]

    assert {r["slot"] for r in defenses} == set(SLOT_IDS)
    for req in defenses:
        challenge = [m for m in web_conv["threads"][req["slot"]] if m["kind"] == "fusion_challenge"]
        assert len(challenge) == 1 and req["text"] == challenge[0]["content"]
        assert req["text"].startswith(QUOTED_DATA_NOTICE)
        assert fusion_prompts.ANTI_SYCOPHANCY_CLAUSE in req["text"]
        assert "<<<YOUR CLAIM>>>" in req["text"] and req["role"] == req["slot"]
        reply = [m for m in web_conv["threads"][req["slot"]] if m["kind"] == "fusion_reply"]
        assert reply[0]["content"] == planted(f"{req['slot']}.defense.1.jsonl")

    (convergence,) = convergences
    assert convergence["fresh"] is True and convergence["model"] == "web:chatgpt:analyst"
    assert convergence["text"].startswith(fusion_prompts.CONVERGENCE_SYSTEM_FENCED)
    assert "<<<DIVERGENCES>>>" in convergence["text"] and "R2" in convergence["text"]

    # ---- leak sweep over every typed text -----------------------------------------------
    allow = [PROMPT, *CHAT.values(), *(planted(f"{s}.defense.1.jsonl") for s in SLOT_IDS)]
    for req in desk.requests:
        assert find_identity_leaks(req["text"], allow) == [], req["purpose"]

    # ---- the persisted turns equal the mock-mode run (what the goldens pin) --------------
    monkeypatch.setenv("MOCK_SCENARIO", "planted_factual")
    monkeypatch.setenv("MOCK_DELAY_MS", "0")
    mock.reset()
    mid = await create(client, slot_config=DEFAULT_SLOT_CONFIG.model_dump())
    for url, body in (
        (f"/api/conversations/{mid}/send", {"prompt": PROMPT}),
        (f"/api/conversations/{mid}/analyze", {}),
        (f"/api/conversations/{mid}/fusion", {"max_iterations": 2}),
    ):
        r, _ = await stream(client, url, body)
        assert r.status_code == 200, r.text
    assert len(mock.calls) == 8
    mock_conv = await get(client, mid)
    web_turns, mock_turns = normalise_turns(web_conv), normalise_turns(mock_conv)
    assert [t["type"] for t in web_turns] == ["send", "analyze", "fusion"]
    for web_turn, mock_turn in zip(web_turns[1:], mock_turns[1:], strict=True):
        assert stripped(web_turn) == stripped(mock_turn)
    web_send, mock_send = web_turns[0], mock_turns[0]
    assert web_send["responses"] == mock_send["responses"] == CHAT
    assert web_send["errors"] == mock_send["errors"] == {}
    for web_turn, mock_turn in zip(web_turns, mock_turns, strict=True):
        assert web_turn["usage"]["totals"]["calls"] == mock_turn["usage"]["totals"]["calls"]
        assert [(u["role"], u["purpose"]) for u in web_turn["usage"]["calls"]] == [
            (u["role"], u["purpose"]) for u in mock_turn["usage"]["calls"]
        ]
        for u in web_turn["usage"]["calls"]:
            assert (u["prompt_tokens"], u["completion_tokens"], u["reasoning_tokens"]) == (0, 0, 0)
            assert (
                u["cost_usd"] == 0 and u["generation_id"] is None and u["model"].startswith("web:")
            )
        assert web_turn["usage"]["totals"]["cost_usd"] == 0
        assert web_turn["slot_config"]["analyst_model"] == "web:chatgpt:analyst"
        assert all(s["model"] == f"web:{k}" for k, s in web_turn["slot_config"]["slots"].items())


async def test_analyst_correction_retry_continues_the_same_chat(client, web_env, fake_desktop):
    bad = "Here is my analysis in prose, without any JSON object."
    desk = await fake_desktop(
        planted_script(
            {("chatgpt", "analyst", "extraction"): [bad, planted("analyst.extraction.1.jsonl")]}
        )
    )
    cid = await create(client)
    r, _ = await stream(client, f"/api/conversations/{cid}/send", {"prompt": PROMPT})
    assert r.status_code == 200
    r, events = await stream(client, f"/api/conversations/{cid}/analyze", {})
    assert r.status_code == 200, r.text
    assert [e["type"] for e in events] == ["analyze_start", "analyze_retry", "analyze_done"]
    turn = events[-1]["turn"]
    assert turn["status"] == "ok" and turn["raw_attempts"] == [
        bad,
        planted("analyst.extraction.1.jsonl"),
    ]

    first, second = desk.of("chatgpt", "analyst", "extraction")
    assert first["fresh"] is True and second["fresh"] is False
    assert second["text"] == analyze_prompts.retry_message(events[1]["error"])
    assert events[1]["error"].startswith("parse_error")
    assert second["req_id"] != first["req_id"] and second["conversation_id"] == cid
    assert mock.calls == [] and desk.errors == []
    assert len(desk.requests) == 5


async def test_site_failures_reach_the_send_and_fusion_events(client, web_env, fake_desktop):
    script = planted_script(
        {
            ("claude", "pane", "chat"): {"reject": "logged_out", "message": "claude is signed out"},
            ("grok", "pane", "chat"): {
                "error": "reply_not_found",
                "message": "no reply",
                "partial": "The gyro",
            },
        }
    )
    desk = await fake_desktop(script)
    cid = await create(client)
    r, events = await stream(client, f"/api/conversations/{cid}/send", {"prompt": PROMPT})
    assert r.status_code == 200
    assert_send_stream_invariants(events)
    claude = one(events, "slot_error", "claude")
    assert (claude["code"], claude["error_type"], claude["message"]) == (
        "logged_out",
        "site",
        "claude is signed out",
    )
    grok = one(events, "slot_error", "grok")
    assert (grok["code"], grok["error_type"], grok["partial"]) == (
        "reply_not_found",
        "site",
        "The gyro",
    )
    assert [e["text"] for e in events if e["type"] == "slot_delta" and e["slot"] == "grok"] == [
        "The gyro"
    ]
    one(events, "slot_done", "chatgpt")
    conv = await get(client, cid)
    assert conv["threads"]["claude"] == [] and conv["threads"]["grok"] == []
    assert conv["turns"][0]["partial"] == {"claude": "", "grok": "The gyro"}
    r = await client.post(f"/api/conversations/{cid}/analyze", json={})
    assert r.status_code == 409 and r.json()["detail"]["missing"] == ["claude", "grok"]
    assert mock.calls == [] and desk.errors == []


async def test_bridge_unavailable_when_no_desktop_is_connected(client, web_env):
    cid = await create(client)
    r, events = await stream(client, f"/api/conversations/{cid}/send", {"prompt": PROMPT})
    assert r.status_code == 200
    assert_send_stream_invariants(events)
    for slot in SLOT_IDS:
        err = one(events, "slot_error", slot)
        assert err["code"] == "bridge_unavailable" and err["error_type"] == "triplex"
    conv = await get(client, cid)
    assert all(conv["threads"][s] == [] for s in SLOT_IDS)
    assert set(conv["turns"][0]["errors"]) == set(SLOT_IDS)
    assert mock.calls == []


@pytest.mark.parametrize("empty", ["", "  \n"])
async def test_empty_captured_reply_is_the_empty_reply_slot_error(
    client, web_env, fake_desktop, empty
):
    desk = await fake_desktop(planted_script({("chatgpt", "pane", "chat"): empty}))
    cid = await create(client)
    r, events = await stream(client, f"/api/conversations/{cid}/send", {"prompt": PROMPT})
    assert r.status_code == 200
    err = one(events, "slot_error", "chatgpt")
    assert err["code"] == "empty_reply" and err["error_type"] == "triplex"
    assert "finish_reason=stop" in err["message"]
    conv = await get(client, cid)
    assert conv["threads"]["chatgpt"] == [] and conv["turns"][0]["responses"]["chatgpt"] is None
    assert conv["turns"][0]["usage"]["totals"]["calls"] == 3  # the typed turn is still booked
    assert by_type(events, "slot_done") and mock.calls == [] and desk.errors == []
