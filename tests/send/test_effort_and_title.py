"""Reasoning events + persisted reasoning per slot, effort coercion (`slot_start.effort /
effort_coerced`, `SendTurn.effort_applied`), and the first-send auto-title rule."""

from __future__ import annotations

from backend.config import DEFAULT_SLOT_CONFIG
from backend.llm import mock
from backend.schemas import SLOT_IDS, SlotSpec
from backend.store import conversations as store
from tests.conftest import DEFAULT_PROMPT
from tests.send.conftest import assert_stream_invariants, of_type, one, slot_text


# --------------------------------------------------------------------------- (10) reasoning
async def test_reasoning_events_stream_and_are_persisted_per_slot(send, cid, get_conv):
    events = await send(cid)
    assert_stream_invariants(events)
    conv = await get_conv(cid)
    turn = conv["turns"][0]
    assert set(turn["reasoning"]) == set(SLOT_IDS)
    for slot in SLOT_IDS:
        fragments = [e for e in of_type(events, "slot_reasoning") if e["slot"] == slot]
        assert fragments, f"{slot} streamed no reasoning"
        assert all(set(e) == {"type", "slot", "text"} for e in fragments)
        text = slot_text(events, slot, "slot_reasoning")
        assert turn["reasoning"][slot] == text and text.strip()
        # reasoning never enters the thread and is never replayed to the model
        for m in conv["threads"][slot]:
            assert text not in m["content"]
    assert len([e for e in of_type(events, "slot_reasoning") if e["slot"] == "claude"]) == 2
    assert turn["reasoning"]["claude"].startswith("The question asks")
    for c in mock.calls:
        assert all(m["role"] in ("user", "assistant") for m in c["messages"])
    # a following continue does not replay any reasoning text
    mock.reset()
    events2 = await send(cid, "Follow-up")
    conv2 = await get_conv(cid)
    for c in mock.calls:
        for m in c["messages"]:
            assert turn["reasoning"][c["role"]] not in m["content"]
    assert conv2["turns"][1]["reasoning"] == {
        s: slot_text(events2, s, "slot_reasoning") for s in SLOT_IDS
    }


async def test_effort_off_on_a_mandatory_reasoning_model_is_coerced(send, get_conv):
    cfg = DEFAULT_SLOT_CONFIG.model_copy(deep=True)
    cfg.slots["grok"] = SlotSpec(model="x-ai/grok-4.6", effort="off")  # mandatory reasoning
    cfg.slots["claude"] = SlotSpec(model="anthropic/claude-opus-5", effort="off")  # optional
    cfg.slots["chatgpt"] = SlotSpec(model="openai/gpt-5.6-sol", effort="high")
    conv = await store.create(slot_config=cfg)  # PUT would 422 an unsupported effort
    events = await send(conv.id)
    assert_stream_invariants(events)

    grok = one(events, "slot_start", "grok")
    assert grok["effort"] == "low" and grok["effort_coerced"] is True
    claude = one(events, "slot_start", "claude")
    assert claude["effort"] == "off" and claude["effort_coerced"] is False
    chatgpt = one(events, "slot_start", "chatgpt")
    assert chatgpt["effort"] == "high" and chatgpt["effort_coerced"] is False

    by_role = {c["role"]: c for c in mock.calls}
    assert by_role["grok"]["reasoning"] is None  # omitted: the provider default runs
    assert by_role["claude"]["reasoning"] == {"enabled": False}
    assert by_role["chatgpt"]["reasoning"] == {"effort": "high"}

    stored = await get_conv(conv.id)
    turn = stored["turns"][0]
    assert turn["effort_applied"] == {"claude": "off", "chatgpt": "high", "grok": "low"}
    # the as-run stamp is the CONFIGURED config, not the coerced one
    assert turn["slot_config"]["slots"]["grok"]["effort"] == "off"
    assert turn["slot_config"] == stored["slot_config"]


async def test_continue_reports_coercion_too(cont, get_conv):
    cfg = DEFAULT_SLOT_CONFIG.model_copy(deep=True)
    cfg.slots["grok"] = SlotSpec(model="x-ai/grok-4.6", effort="off")
    conv = await store.create(slot_config=cfg)
    events = await cont(conv.id, "grok", "Solo.")
    start = one(events, "slot_start", "grok")
    assert start["effort"] == "low" and start["effort_coerced"] is True
    assert mock.calls[-1]["reasoning"] is None
    assert (await get_conv(conv.id))["turns"][0]["effort_applied"] == "low"


async def test_unknown_model_is_sent_as_configured(send, get_conv):
    cfg = DEFAULT_SLOT_CONFIG.model_copy(deep=True)
    cfg.slots["claude"] = SlotSpec(model="anthropic/claude-opus-9-preview", effort="high")
    conv = await store.create(slot_config=cfg)
    events = await send(conv.id)
    start = one(events, "slot_start", "claude")
    assert start["model"] == "anthropic/claude-opus-9-preview"
    assert start["effort"] == "high" and start["effort_coerced"] is False
    c = {c["role"]: c for c in mock.calls}["claude"]
    assert c["model"] == "anthropic/claude-opus-9-preview" and c["reasoning"] == {"effort": "high"}
    done = one(events, "slot_done", "claude")
    assert done["usage"]["model"] == "anthropic/claude-opus-9-preview"
    assert (await get_conv(conv.id))["turns"][0]["effort_applied"]["claude"] == "high"


async def test_as_run_slot_config_is_a_snapshot(client, send, cid, get_conv):
    first = await send(cid)
    cfg = (await get_conv(cid))["slot_config"]
    cfg["slots"]["claude"]["effort"] = "low"
    r = await client.put(f"/api/conversations/{cid}/slot_config", json=cfg)
    assert r.status_code == 200
    second = await send(cid, "Again")
    conv = await get_conv(cid)
    t1, t2 = conv["turns"]
    assert t1["id"] == first[0]["turn_id"] and t2["id"] == second[0]["turn_id"]
    assert t1["slot_config"]["slots"]["claude"]["effort"] == "medium"
    assert t2["slot_config"]["slots"]["claude"]["effort"] == "low"
    assert t1["effort_applied"]["claude"] == "medium" and t2["effort_applied"]["claude"] == "low"
    assert one(second, "slot_start", "claude")["effort"] == "low"


# --------------------------------------------------------------------------- (9) title
async def test_first_send_titles_the_conversation_with_prompt_60(send, cid, get_conv, client):
    assert len(DEFAULT_PROMPT) > 60
    assert (await get_conv(cid))["title"] == "New conversation"
    await send(cid)
    conv = await get_conv(cid)
    assert conv["title"] == DEFAULT_PROMPT[:60]
    assert len(conv["title"]) == 60
    r = await client.get("/api/conversations")
    assert [c["title"] for c in r.json() if c["id"] == cid] == [DEFAULT_PROMPT[:60]]

    # a second send never re-titles, even after a manual rename
    r = await client.patch(f"/api/conversations/{cid}/title", json={"title": "Custom"})
    assert r.status_code == 200
    await send(cid, "A completely different second prompt")
    assert (await get_conv(cid))["title"] == "Custom"


async def test_short_prompt_titles_verbatim_and_continue_never_titles(
    send, cont, new_conv, get_conv
):
    a = (await new_conv())["id"]
    await send(a, "Short prompt")
    assert (await get_conv(a))["title"] == "Short prompt"

    b = (await new_conv())["id"]
    await cont(b, "claude", "Solo first")
    assert (await get_conv(b))["title"] == "New conversation"
    await send(b, "Now a send")  # a continue turn already exists: the conversation has turns
    assert (await get_conv(b))["title"] == "New conversation"
