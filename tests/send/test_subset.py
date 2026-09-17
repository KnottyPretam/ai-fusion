"""`POST …/send` with `slots` (docs/api-contract.md desktop addendum): a subset runs exactly the
listed slots and persists only their entries; omitted / null / all-three are identical to
today's run; unknown -> 404 not_found(slot); [] -> 422 empty_slots; duplicates collapse in
SLOT_IDS order."""

from __future__ import annotations

import copy
from typing import Any

import pytest
from fastapi import HTTPException

from backend.features import send as send_mod
from backend.llm import mock
from backend.schemas import SLOT_IDS
from tests.conftest import DEFAULT_PROMPT, DEFAULT_RESPONSES
from tests.helpers import parse_sse_text
from tests.send.conftest import SEND_URL, assert_stream_invariants, one, types

NOT_FOUND_SLOT = {"detail": {"error": "not_found", "what": "slot"}}
EMPTY_SLOTS = {"detail": {"error": "empty_slots"}}


async def post(client, cid: str, body: dict[str, Any]):
    r = await client.post(SEND_URL.format(cid=cid), json=body)
    return r, (parse_sse_text(r.text) if r.status_code == 200 else [])


def neutral(events: list[dict[str, Any]]) -> dict[str, Any]:
    """Per-slot event sequences plus the turn events, with the volatile bits pinned (turn id,
    latencies); slots run in parallel, so the global interleaving is not part of the contract."""

    def pin(node: Any) -> Any:
        if isinstance(node, dict):
            out = {}
            for k, v in node.items():
                if k == "turn_id":
                    out[k] = "<turn>"
                elif k == "latency_ms":
                    out[k] = 0
                elif k == "calls" and isinstance(v, list):
                    out[k] = sorted((pin(u) for u in v), key=lambda u: (u["role"], u["purpose"]))
                else:
                    out[k] = pin(v)
            return out
        if isinstance(node, list):
            return [pin(v) for v in node]
        return node

    pinned = [pin(e) for e in copy.deepcopy(events)]
    return {
        "turn": [e for e in pinned if e["type"] in ("turn_start", "turn_done")],
        **{slot: [e for e in pinned if e.get("slot") == slot] for slot in SLOT_IDS},
    }


# --------------------------------------------------------------------------- subset
async def test_grok_only_runs_and_persists_one_slot(client, cid, get_conv):
    r, events = await post(client, cid, {"prompt": DEFAULT_PROMPT, "slots": ["grok"]})
    assert r.status_code == 200, r.text
    assert_stream_invariants(events, ("grok",))
    assert events[0]["slots"] == ["grok"]
    assert types(events).count("slot_start") == 1 and types(events).count("slot_done") == 1
    one(events, "slot_start", "grok")
    one(events, "slot_done", "grok")
    assert not [e for e in events if e.get("slot") in ("claude", "chatgpt")]
    assert events[-1]["usage"]["totals"]["calls"] == 1
    assert [c["role"] for c in mock.calls] == ["grok"]

    conv = await get_conv(cid)
    assert conv["threads"]["claude"] == [] and conv["threads"]["chatgpt"] == []
    assert [(m["role"], m["content"]) for m in conv["threads"]["grok"]] == [
        ("user", DEFAULT_PROMPT),
        ("assistant", DEFAULT_RESPONSES["grok"]),
    ]
    turn = conv["turns"][0]
    assert turn["type"] == "send" and turn["responses"] == {"grok": DEFAULT_RESPONSES["grok"]}
    assert turn["errors"] == {} and turn["partial"] == {}
    assert turn["truncated"] == {"grok": False} and turn["effort_applied"] == {"grok": "medium"}
    assert set(turn["reasoning"]) <= {"grok"}
    assert conv["title"] == DEFAULT_PROMPT[:60]

    r = await client.post(f"/api/conversations/{cid}/analyze", json={})
    assert r.status_code == 409
    assert r.json() == {
        "detail": {"error": "incomplete_send_turn", "missing": ["claude", "chatgpt"]}
    }


async def test_two_slots_keep_slot_ids_order(client, cid, get_conv):
    r, events = await post(
        client, cid, {"prompt": DEFAULT_PROMPT, "slots": ["grok", "claude", "claude"]}
    )
    assert r.status_code == 200, r.text
    assert events[0]["slots"] == ["claude", "grok"]
    assert_stream_invariants(events, ("claude", "grok"))
    assert sorted(c["role"] for c in mock.calls) == ["claude", "grok"]
    turn = (await get_conv(cid))["turns"][0]
    assert set(turn["responses"]) == {"claude", "grok"}
    r = await client.post(f"/api/conversations/{cid}/analyze", json={})
    assert r.status_code == 409 and r.json()["detail"]["missing"] == ["chatgpt"]


async def test_omitted_null_and_all_three_are_identical(client, new_conv, get_conv, monkeypatch):
    monkeypatch.setenv("MOCK_DELAY_MS", "0")
    runs: dict[str, dict[str, Any]] = {}
    convs: dict[str, dict[str, Any]] = {}
    for name, body in (
        ("omitted", {"prompt": DEFAULT_PROMPT}),
        ("null", {"prompt": DEFAULT_PROMPT, "slots": None}),
        ("all", {"prompt": DEFAULT_PROMPT, "slots": ["grok", "chatgpt", "claude"]}),
    ):
        mock.reset()
        cid = (await new_conv())["id"]
        r, events = await post(client, cid, body)
        assert r.status_code == 200, (name, r.text)
        assert_stream_invariants(events)
        assert events[0]["slots"] == list(SLOT_IDS)
        runs[name] = neutral(events)
        convs[name] = await get_conv(cid)
    assert runs["omitted"] == runs["null"] == runs["all"]
    turns = {name: {**c["turns"][0], "id": "<turn>", "ts": "<ts>"} for name, c in convs.items()}
    for t in turns.values():
        t["usage"]["totals"]["latency_ms"] = 0
        for u in t["usage"]["calls"]:
            u["latency_ms"] = 0
        t["usage"]["calls"].sort(key=lambda u: (u["role"], u["purpose"]))
    assert turns["omitted"] == turns["null"] == turns["all"]
    for c in convs.values():
        assert all(len(c["threads"][s]) == 2 for s in SLOT_IDS)


# --------------------------------------------------------------------------- refusals
@pytest.mark.parametrize(
    "slots",
    [["gemini"], ["claude", "R1"], ["Claude"], ["grok", ""], ["claude", "chatgpt", "grok", "nope"]],
)
async def test_unknown_slot_is_404_json(client, cid, get_conv, slots):
    r, _ = await post(client, cid, {"prompt": DEFAULT_PROMPT, "slots": slots})
    assert r.status_code == 404 and r.json() == NOT_FOUND_SLOT
    assert r.headers["content-type"].startswith("application/json")
    assert mock.calls == [] and (await get_conv(cid))["turns"] == []


async def test_empty_list_is_422_empty_slots(client, cid, get_conv):
    r, _ = await post(client, cid, {"prompt": DEFAULT_PROMPT, "slots": []})
    assert r.status_code == 422 and r.json() == EMPTY_SLOTS
    assert mock.calls == [] and (await get_conv(cid))["turns"] == []


async def test_precheck_order_prompt_before_slots(client, cid):
    r, _ = await post(client, cid, {"prompt": "   ", "slots": ["gemini"]})
    assert r.status_code == 422 and r.json() == {"detail": {"error": "empty_prompt"}}
    r, _ = await post(client, cid, {"prompt": "   ", "slots": []})
    assert r.status_code == 422 and r.json() == {"detail": {"error": "empty_prompt"}}


async def test_non_list_slots_is_a_validation_422(client, cid):
    r, _ = await post(client, cid, {"prompt": DEFAULT_PROMPT, "slots": "grok"})
    assert r.status_code == 422 and isinstance(r.json()["detail"], list)
    assert mock.calls == []


async def test_continue_ignores_slots(client, cid):
    r = await client.post(
        f"/api/conversations/{cid}/slots/claude/continue",
        json={"prompt": DEFAULT_PROMPT, "slots": ["grok"]},
    )
    assert r.status_code == 200
    events = parse_sse_text(r.text)
    assert events[0]["slots"] == ["claude"] and [c["role"] for c in mock.calls] == ["claude"]


# --------------------------------------------------------------------------- the pure helper
def test_resolve_slots():
    assert send_mod.resolve_slots(None) == SLOT_IDS
    assert send_mod.resolve_slots(("grok",)) == ("grok",)
    assert send_mod.resolve_slots(["grok", "claude", "grok"]) == ("claude", "grok")
    assert send_mod.resolve_slots(list(reversed(SLOT_IDS))) == SLOT_IDS
    with pytest.raises(HTTPException) as ei:
        send_mod.resolve_slots([])
    assert ei.value.status_code == 422 and ei.value.detail == {"error": "empty_slots"}
    with pytest.raises(HTTPException) as ei:
        send_mod.resolve_slots(["claude", "gemini"])
    assert ei.value.status_code == 404 and ei.value.detail == {"error": "not_found", "what": "slot"}
    with pytest.raises(HTTPException) as ei:
        send_mod.resolve_slots("grok")  # type: ignore[arg-type]
    assert ei.value.status_code == 404


async def test_run_send_direct_call_with_slots(cid, get_conv):
    events = [ev async for ev in send_mod.run_send(cid, DEFAULT_PROMPT, slots=["chatgpt"])]
    assert_stream_invariants(events, ("chatgpt",))
    assert (await get_conv(cid))["turns"][0]["responses"] == {
        "chatgpt": DEFAULT_RESPONSES["chatgpt"]
    }
