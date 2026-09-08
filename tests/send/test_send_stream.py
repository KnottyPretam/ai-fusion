"""Send: per-slot payloads, event order, usage, persisted SendTurn, message shape, leak-freedom
(PLAN.md §8 Phase 2 AC; docs/semantics.md "Send/continue" + addendum; docs/api-contract.md)."""

from __future__ import annotations

from backend.config import MAX_TOKENS_STAGE
from backend.llm import mock
from backend.schemas import SLOT_IDS
from tests.conftest import DEFAULT_PROMPT, DEFAULT_RESPONSES
from tests.helpers import assert_no_identity_leak, messages_text
from tests.send.conftest import (
    assert_stream_invariants,
    for_slot,
    of_type,
    one,
    slot_text,
    types,
)


# --------------------------------------------------------------------------- (1) own model + effort
async def test_each_slot_request_carries_its_own_model_and_reasoning(client, cid, send, get_conv):
    conv = await get_conv(cid)
    cfg = conv["slot_config"]
    cfg["slots"]["claude"] = {"model": "anthropic/claude-sonnet-5", "effort": "high"}
    cfg["slots"]["grok"] = {"model": "x-ai/grok-4.6", "effort": "low"}
    cfg["slots"]["chatgpt"] = {"model": "openai/gpt-5.6-sol", "effort": "medium"}
    r = await client.put(f"/api/conversations/{cid}/slot_config", json=cfg)
    assert r.status_code == 200, r.text

    events = await send(cid)
    assert_stream_invariants(events)

    assert len(mock.calls) == 3
    by_role = {c["role"]: c for c in mock.calls}
    assert set(by_role) == set(SLOT_IDS)
    assert all(c["purpose"] == "chat" for c in mock.calls)
    assert by_role["claude"]["model"] == "anthropic/claude-sonnet-5"
    assert by_role["claude"]["reasoning"] == {"effort": "high"}
    assert by_role["grok"]["model"] == "x-ai/grok-4.6"
    assert by_role["grok"]["reasoning"] == {"effort": "low"}
    assert by_role["chatgpt"]["model"] == "openai/gpt-5.6-sol"
    assert by_role["chatgpt"]["reasoning"] == {"effort": "medium"}
    # the three payloads really differ from one another
    assert len({(c["model"], c["reasoning"]["effort"]) for c in mock.calls}) == 3
    for c in mock.calls:
        assert c["max_tokens"] == MAX_TOKENS_STAGE["send"]
        assert c["response_format"] is None and c["plugins"] is None
        assert c["fixture"] == f"planted_factual/{c['role']}.chat.1.jsonl"

    for slot in SLOT_IDS:
        start = one(events, "slot_start", slot)
        assert start["model"] == cfg["slots"][slot]["model"]
        assert start["effort"] == cfg["slots"][slot]["effort"]
        assert start["effort_coerced"] is False


# --------------------------------------------------------------------------- (2) three outputs stream
async def test_three_outputs_stream_in_contract_order(send, cid):
    events = await send(cid)
    assert_stream_invariants(events)
    assert types(events)[0] == "turn_start" and types(events)[-1] == "turn_done"
    start = events[0]
    assert set(start) == {"type", "turn_id", "feature", "slots"}
    assert start["feature"] == "send" and start["slots"] == list(SLOT_IDS)
    for slot in SLOT_IDS:
        mine = for_slot(events, slot)
        assert set(mine[0]) == {"type", "slot", "model", "effort", "effort_coerced"}
        deltas = [e for e in mine if e["type"] == "slot_delta"]
        assert deltas, f"{slot} streamed no text"
        assert all(set(e) == {"type", "slot", "text"} for e in deltas)
        assert slot_text(events, slot) == DEFAULT_RESPONSES[slot]
        done = one(events, "slot_done", slot)
        assert set(done) == {"type", "slot", "usage", "finish_reason", "truncated"}
        assert done["finish_reason"] == "stop" and done["truncated"] is False
        assert types(mine).index("slot_done") > max(
            i for i, e in enumerate(mine) if e["type"] in ("slot_delta", "slot_reasoning")
        )
    assert not of_type(events, "slot_error")
    assert set(events[-1]) == {"type", "turn_id", "usage"}


async def test_slots_stream_in_parallel_and_interleave(send, cid, monkeypatch):
    """With paced replay the three producers interleave: every slot_start precedes the first
    slot_done, and the ordering invariants still hold under interleaving."""
    monkeypatch.setenv("MOCK_DELAY_MS", "5")
    events = await send(cid)
    assert_stream_invariants(events)
    kinds = types(events)
    first_done = kinds.index("slot_done")
    assert {e["slot"] for e in events[1:first_done] if e["type"] == "slot_start"} == set(SLOT_IDS)
    for slot in SLOT_IDS:
        assert slot_text(events, slot) == DEFAULT_RESPONSES[slot]


async def test_sse_response_headers(client, cid):
    r = await client.post(f"/api/conversations/{cid}/send", json={"prompt": DEFAULT_PROMPT})
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/event-stream")
    assert r.headers["x-accel-buffering"] == "no"
    assert r.headers["cache-control"] == "no-cache"
    assert r.text.startswith("data: ")


# --------------------------------------------------------------------------- persisted SendTurn
async def test_send_turn_and_threads_are_persisted(send, cid, get_conv):
    events = await send(cid)
    turn_id = events[0]["turn_id"]
    conv = await get_conv(cid)

    assert [t["type"] for t in conv["turns"]] == ["send"]
    turn = conv["turns"][0]
    assert turn["id"] == turn_id and turn["ts"].endswith("Z")
    assert turn["prompt"] == DEFAULT_PROMPT
    assert turn["responses"] == DEFAULT_RESPONSES
    assert turn["errors"] == {} and turn["partial"] == {}
    assert turn["truncated"] == dict.fromkeys(SLOT_IDS, False)
    assert turn["effort_applied"] == {
        s: conv["slot_config"]["slots"][s]["effort"] for s in SLOT_IDS
    }
    assert turn["slot_config"] == conv["slot_config"]
    assert turn["usage"] == events[-1]["usage"]
    assert set(turn["citations"]) == set()

    for slot in SLOT_IDS:
        thread = conv["threads"][slot]
        assert [(m["role"], m["content"]) for m in thread] == [
            ("user", DEFAULT_PROMPT),
            ("assistant", DEFAULT_RESPONSES[slot]),
        ]
        for m in thread:
            assert m["kind"] == "chat" and m["turn_id"] == turn_id and m["meta"] is None
            assert m["ts"].endswith("Z")
    assert conv["updated_at"] >= conv["created_at"]


async def test_turn_ids_are_unique_uuid4_and_turns_accumulate(send, cid, get_conv):
    import uuid

    e1 = await send(cid)
    e2 = await send(cid, "And the accelerometer range?")
    id1, id2 = e1[0]["turn_id"], e2[0]["turn_id"]
    assert id1 != id2
    assert uuid.UUID(id1).version == 4 and uuid.UUID(id2).version == 4
    conv = await get_conv(cid)
    assert [t["id"] for t in conv["turns"]] == [id1, id2]
    for slot in SLOT_IDS:
        assert [m["turn_id"] for m in conv["threads"][slot]] == [id1, id1, id2, id2]
    # the second send carried the first pair as history
    for c in mock.calls[3:]:
        assert [m["role"] for m in c["messages"]] == ["user", "assistant", "user"]


# --------------------------------------------------------------------------- (11) usage
async def test_usage_per_slot_and_totals_with_wall_clock(send, cid, monkeypatch):
    monkeypatch.setenv("MOCK_DELAY_MS", "3")
    events = await send(cid)
    calls = {c["role"]: c for c in mock.calls}
    slot_usages = {}
    for slot in SLOT_IDS:
        u = one(events, "slot_done", slot)["usage"]
        slot_usages[slot] = u
        assert u["role"] == slot and u["purpose"] == "chat"
        assert u["model"] == calls[slot]["model"]
        assert u["prompt_tokens"] > 0 and u["completion_tokens"] > 0 and u["cost_usd"] > 0
        assert u["generation_id"]
    total = events[-1]["usage"]
    assert set(total) == {"calls", "totals"}
    assert len(total["calls"]) == 3
    assert {c["role"] for c in total["calls"]} == set(SLOT_IDS)
    t = total["totals"]
    assert t["calls"] == 3
    for key in ("prompt_tokens", "completion_tokens", "reasoning_tokens"):
        assert t[key] == sum(u[key] for u in slot_usages.values())
    assert abs(t["cost_usd"] - sum(u["cost_usd"] for u in slot_usages.values())) < 1e-8
    assert t["latency_ms"] > 0  # the feature's wall clock, not a sum
    assert t["latency_ms"] >= max(u["latency_ms"] for u in slot_usages.values())


# --------------------------------------------------------------------------- (12) exact message shape
async def test_messages_sent_to_models_are_exactly_role_and_content(send, cont, cid, get_conv):
    await send(cid)
    conv = await get_conv(cid)
    await cont(cid, "claude", "Go on.")
    assert len(mock.calls) == 4
    for c in mock.calls:
        for m in c["messages"]:
            assert set(m) == {"role", "content"}, m
            assert m["role"] in ("user", "assistant") and isinstance(m["content"], str)
    for c in mock.calls[:3]:
        assert c["messages"] == [{"role": "user", "content": DEFAULT_PROMPT}]
    hist = [{"role": m["role"], "content": m["content"]} for m in conv["threads"]["claude"]]
    assert mock.calls[3]["messages"] == hist + [{"role": "user", "content": "Go on."}]
    assert [m["role"] for m in mock.calls[3]["messages"]] == ["user", "assistant", "user"]


# --------------------------------------------------------------------------- (13) leak-free
async def test_send_payload_is_only_thread_history_plus_prompt(
    send, cont, cid, get_conv, monkeypatch
):
    """Nothing in Send is Triplex-authored beyond the verbatim user prompt: even a prompt that
    names a vendor passes the leak scan once the prompt and raw replies are allowed."""
    monkeypatch.setenv("MOCK_SCENARIO", "vendor_in_prompt")
    prompt = "Claude, what is the maximum SPI clock frequency supported by the BMI088?"
    events = await send(cid, prompt)
    assert_stream_invariants(events)
    conv = await get_conv(cid)
    replies = [conv["turns"][0]["responses"][s] for s in SLOT_IDS]
    assert all(replies)

    follow_up = "Thanks Claude; and the I2C limit?"
    await cont(cid, "chatgpt", follow_up)
    conv2 = await get_conv(cid)
    replies.append(conv2["turns"][1]["response"])

    assert len(mock.calls) == 4
    for c in mock.calls[:3]:
        assert c["messages"] == [{"role": "user", "content": prompt}]
    hist = [{"role": m["role"], "content": m["content"]} for m in conv["threads"]["chatgpt"]]
    assert mock.calls[3]["messages"] == hist + [{"role": "user", "content": follow_up}]
    for c in mock.calls:
        assert_no_identity_leak(messages_text(c["messages"]), allow=[prompt, follow_up, *replies])
        # and the ONLY vendor mention anywhere is the user's own wording
        for m in c["messages"]:
            if m["role"] == "user":
                assert m["content"] in (prompt, follow_up)


async def test_all_slot_names_are_absent_from_every_message(send, cid):
    await send(cid)
    for c in mock.calls:
        assert_no_identity_leak(
            messages_text(c["messages"]), allow=[DEFAULT_PROMPT, *DEFAULT_RESPONSES.values()]
        )
