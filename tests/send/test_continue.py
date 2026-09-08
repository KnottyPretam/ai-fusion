"""Solo continue: rabbit-holing one slot leaves the other threads byte-identical (spec R5,
PLAN.md §8 P2 AC); the continue request carries the whole thread history in order."""

from __future__ import annotations

import json

from backend.config import MAX_TOKENS_STAGE
from backend.llm import mock
from backend.schemas import SLOT_IDS
from tests.conftest import DEFAULT_PROMPT, DEFAULT_RESPONSES
from tests.send.conftest import assert_stream_invariants, one, slot_text

FOLLOW_UPS = (
    "Which register selects that range?",
    "And what is the default after reset?",
    "How do I read it back over SPI?",
)


def _openai(thread: list[dict]) -> list[dict]:
    return [{"role": m["role"], "content": m["content"]} for m in thread]


async def test_rabbit_hole_one_slot_three_times_leaves_other_threads_byte_identical(
    send, cont, cid, get_conv
):
    await send(cid)
    before = await get_conv(cid)
    others = {s: json.dumps(before["threads"][s], sort_keys=True) for s in ("claude", "chatgpt")}
    grok_before = list(before["threads"]["grok"])
    calls_before = len(mock.calls)

    turn_ids = []
    for i, prompt in enumerate(FOLLOW_UPS):
        snapshot = await get_conv(cid)
        history = _openai(snapshot["threads"]["grok"])
        events = await cont(cid, "grok", prompt)
        assert_stream_invariants(events, slots=("grok",))
        turn_ids.append(events[0]["turn_id"])
        assert events[0]["feature"] == "continue" and events[0]["slots"] == ["grok"]
        # the request = the WHOLE grok thread so far, in order, plus the new prompt
        c = mock.calls[-1]
        assert len(mock.calls) == calls_before + i + 1
        assert c["role"] == "grok" and c["purpose"] == "chat"
        assert c["messages"] == history + [{"role": "user", "content": prompt}]
        assert [m["role"] for m in c["messages"]] == ["user", "assistant"] * (i + 1) + ["user"]
        assert c["max_tokens"] == MAX_TOKENS_STAGE["continue"]
        assert c["fixture"] == "planted_factual/grok.chat.1.jsonl"  # sticky-last
        assert slot_text(events, "grok") == DEFAULT_RESPONSES["grok"]

    after = await get_conv(cid)
    for s in ("claude", "chatgpt"):
        assert json.dumps(after["threads"][s], sort_keys=True) == others[s]
    grok = after["threads"]["grok"]
    assert grok[: len(grok_before)] == grok_before
    extra = grok[len(grok_before) :]
    assert len(extra) == 2 * len(FOLLOW_UPS)
    for i, prompt in enumerate(FOLLOW_UPS):
        user, assistant = extra[2 * i], extra[2 * i + 1]
        assert (user["role"], user["content"]) == ("user", prompt)
        assert (assistant["role"], assistant["content"]) == ("assistant", DEFAULT_RESPONSES["grok"])
        assert user["turn_id"] == assistant["turn_id"] == turn_ids[i]
        assert user["kind"] == assistant["kind"] == "chat"

    assert [t["type"] for t in after["turns"]] == ["send", "continue", "continue", "continue"]
    for turn, prompt, tid in zip(after["turns"][1:], FOLLOW_UPS, turn_ids, strict=True):
        assert turn["id"] == tid and turn["slot"] == "grok" and turn["prompt"] == prompt
        assert turn["response"] == DEFAULT_RESPONSES["grok"]
        assert turn["error"] is None and turn["truncated"] is False
        assert turn["citations"] == [] and turn["reasoning"]
        assert turn["effort_applied"] == after["slot_config"]["slots"]["grok"]["effort"]
        assert turn["slot_config"] == after["slot_config"]
        assert turn["usage"]["totals"]["calls"] == 1
        assert turn["usage"]["calls"][0]["role"] == "grok"


async def test_continue_events_and_turn_shape(cont, cid, get_conv):
    events = await cont(cid, "claude", "Start here.")
    assert_stream_invariants(events, slots=("claude",))
    assert [e["type"] for e in events][:2] == ["turn_start", "slot_start"]
    assert {e.get("slot") for e in events[1:-1]} == {"claude"}
    done = one(events, "slot_done", "claude")
    assert done["usage"]["role"] == "claude" and done["usage"]["purpose"] == "chat"
    tot = events[-1]["usage"]["totals"]
    assert tot["calls"] == 1 and tot["cost_usd"] == done["usage"]["cost_usd"]

    conv = await get_conv(cid)
    assert conv["title"] == "New conversation"  # continue never auto-titles
    assert [t["type"] for t in conv["turns"]] == ["continue"]
    t = conv["turns"][0]
    assert t["id"] == events[0]["turn_id"] and t["slot"] == "claude"
    assert t["response"] == DEFAULT_RESPONSES["claude"]
    assert t["usage"] == events[-1]["usage"]
    assert [m["role"] for m in conv["threads"]["claude"]] == ["user", "assistant"]
    assert conv["threads"]["chatgpt"] == [] and conv["threads"]["grok"] == []
    assert mock.calls[-1]["messages"] == [{"role": "user", "content": "Start here."}]


async def test_continue_uses_that_slots_own_model_and_effort(client, cont, cid, get_conv):
    cfg = (await get_conv(cid))["slot_config"]
    cfg["slots"]["chatgpt"] = {"model": "openai/gpt-5.6-sol", "effort": "high"}
    r = await client.put(f"/api/conversations/{cid}/slot_config", json=cfg)
    assert r.status_code == 200, r.text
    events = await cont(cid, "chatgpt", "Elaborate.")
    start = one(events, "slot_start", "chatgpt")
    assert start["model"] == "openai/gpt-5.6-sol" and start["effort"] == "high"
    c = mock.calls[-1]
    assert c["role"] == "chatgpt" and c["model"] == "openai/gpt-5.6-sol"
    assert c["reasoning"] == {"effort": "high"}
    conv = await get_conv(cid)
    assert conv["turns"][0]["effort_applied"] == "high"


async def test_continue_after_send_carries_only_that_slots_history(send, cont, cid, get_conv):
    await send(cid)
    await send(cid, "Second question about the accelerometer.")
    conv = await get_conv(cid)
    for slot in SLOT_IDS:
        mock.reset()
        events = await cont(cid, slot, f"Follow-up for this column only ({slot}).")
        assert_stream_invariants(events, slots=(slot,))
        assert len(mock.calls) == 1
        c = mock.calls[0]
        assert c["role"] == slot
        assert c["messages"][:-1] == _openai(conv["threads"][slot])
        assert c["messages"][-1] == {
            "role": "user",
            "content": f"Follow-up for this column only ({slot}).",
        }
        assert DEFAULT_PROMPT == c["messages"][0]["content"]
