"""Spec R5 proof: Fusion exchanges live in the challenged slot's history, so a later solo
continue on that slot carries the challenge and the reply -- and nothing leaks into the other
slots' threads, which stay byte-identical (PLAN.md §2 R5, §8 Phase 2 AC, docs/semantics.md
"Threads are the source of truth")."""

from __future__ import annotations

import json

from backend.config import MAX_TOKENS_STAGE
from backend.llm import mock
from backend.prompts import QUOTED_DATA_NOTICE
from backend.prompts import fusion as fusion_prompts
from backend.schemas import SLOT_IDS, ContinueTurn
from tests.e2e.conftest import assert_send_stream_invariants, calls, challenge_of, fixture_text

FOLLOW_UP = "Which register selects the 2000 deg/s range, and what is its reset value?"


def _openai(thread: list[dict]) -> list[dict]:
    return [{"role": m["role"], "content": m["content"]} for m in thread]


def _frozen(thread: list[dict]) -> str:
    return json.dumps(thread, sort_keys=True, separators=(",", ":"))


async def test_fusion_then_continue_carries_context(run_flow, api):
    f = await run_flow("planted_factual")
    assert f.fusion_turn is not None and f.fusion_turn["exit_reason"] == "converged"
    chatgpt_reply = fixture_text("planted_factual", "chatgpt.chat.1.jsonl")
    fusion_reply = fixture_text("planted_factual", "chatgpt.defense.1.jsonl")
    chatgpt_challenge = challenge_of(calls("defense", "chatgpt")[0])

    before = {slot: _frozen(f.threads(slot)) for slot in SLOT_IDS}
    thread = f.threads("chatgpt")
    assert [m["kind"] for m in thread] == ["chat", "chat", "fusion_challenge", "fusion_reply"]
    assert thread[2]["content"] == chatgpt_challenge and thread[3]["content"] == fusion_reply

    # --- continue on the challenged slot: the payload replays the whole thread in order ----
    mock.reset()
    _, events = await api.cont(f.cid, "chatgpt", FOLLOW_UP)
    assert_send_stream_invariants(events, slots=("chatgpt",))
    assert events[0]["feature"] == "continue" and events[0]["slots"] == ["chatgpt"]
    assert len(mock.calls) == 1
    call = mock.calls[0]
    assert call["role"] == "chatgpt" and call["purpose"] == "chat"
    assert call["max_tokens"] == MAX_TOKENS_STAGE["continue"] and call["plugins"] is None
    assert call["messages"] == [
        {"role": "user", "content": f.prompt},
        {"role": "assistant", "content": chatgpt_reply},
        {"role": "user", "content": chatgpt_challenge},
        {"role": "assistant", "content": fusion_reply},
        {"role": "user", "content": FOLLOW_UP},
    ]
    # What the model sees as history really is the challenge (Triplex-authored, delimited,
    # anti-sycophancy clause) and the raw JSON reply (verbatim, a `revise`).
    assert call["messages"][2]["content"].startswith(QUOTED_DATA_NOTICE)
    assert fusion_prompts.ANTI_SYCOPHANCY_CLAUSE in call["messages"][2]["content"]
    assert "<<<R1>>>" in call["messages"][2]["content"]
    assert "<<<R3>>>" in call["messages"][2]["content"]
    assert json.loads(call["messages"][3]["content"])["stance"] == "revise"
    assert call["fixture"] == "planted_factual/chatgpt.chat.1.jsonl"  # sticky-last reply

    # --- the other threads are byte-identical; the chatgpt thread grew by the new pair ------
    after = await api.get(f.cid)
    for slot in ("claude", "grok"):
        assert _frozen(after["threads"][slot]) == before[slot], f"{slot} thread changed"
    grown = after["threads"]["chatgpt"]
    assert _frozen(grown[:4]) == before["chatgpt"]
    assert [(m["role"], m["kind"]) for m in grown[4:]] == [("user", "chat"), ("assistant", "chat")]
    assert grown[4]["content"] == FOLLOW_UP and grown[5]["content"] == chatgpt_reply
    assert grown[4]["turn_id"] == grown[5]["turn_id"] == events[0]["turn_id"]
    turn = ContinueTurn.model_validate(after["turns"][-1])
    assert turn.slot == "chatgpt" and turn.prompt == FOLLOW_UP and turn.response == chatgpt_reply
    assert [t["type"] for t in after["turns"]] == ["send", "analyze", "fusion", "continue"]

    # --- a continue on claude / grok carries its OWN history and no chatgpt fusion message --
    chatgpt_fusion = {chatgpt_challenge, fusion_reply}
    for slot in ("claude", "grok"):
        mock.reset()
        _, ev = await api.cont(f.cid, slot, f"Follow-up for the {slot} column only.")
        assert_send_stream_invariants(ev, slots=(slot,))
        assert len(mock.calls) == 1 and mock.calls[0]["role"] == slot
        messages = mock.calls[0]["messages"]
        assert messages == _openai(after["threads"][slot]) + [
            {"role": "user", "content": f"Follow-up for the {slot} column only."}
        ]
        contents = {m["content"] for m in messages}
        assert not (contents & chatgpt_fusion), f"{slot} saw chatgpt's fusion exchange"
        assert FOLLOW_UP not in contents and chatgpt_reply not in contents
        # Its own challenge + reply ARE there (R5: exchanges live in the relevant history).
        own = after["threads"][slot]
        assert [m["kind"] for m in own] == ["chat", "chat", "fusion_challenge", "fusion_reply"]
        assert messages[2]["content"] == own[2]["content"]
        assert messages[3]["content"] == fixture_text("planted_factual", f"{slot}.defense.1.jsonl")
        assert [m["role"] for m in messages] == ["user", "assistant", "user", "assistant", "user"]

    final = await api.get(f.cid)
    assert [t["type"] for t in final["turns"]] == [
        "send",
        "analyze",
        "fusion",
        "continue",
        "continue",
        "continue",
    ]
    assert _frozen(final["threads"]["chatgpt"]) == _frozen(grown)  # untouched by the others


async def test_rabbit_hole_after_fusion_keeps_carrying_the_exchange(run_flow, api):
    """Three solo turns deep on the challenged slot, the fusion pair is still in every payload
    and the other threads never move (PLAN.md §8 Phase 2 AC: >= 3 turns)."""
    f = await run_flow("planted_factual")
    before = {slot: _frozen(f.threads(slot)) for slot in ("claude", "grok")}
    challenge = f.threads("chatgpt")[2]["content"]
    reply = f.threads("chatgpt")[3]["content"]
    prompts = ["First follow-up.", "Second follow-up.", "Third follow-up."]
    for i, prompt in enumerate(prompts, start=1):
        mock.reset()
        await api.cont(f.cid, "chatgpt", prompt)
        messages = mock.calls[0]["messages"]
        assert messages[2] == {"role": "user", "content": challenge}
        assert messages[3] == {"role": "assistant", "content": reply}
        assert len(messages) == 4 + 2 * (i - 1) + 1
        assert messages[-1] == {"role": "user", "content": prompt}
    after = await api.get(f.cid)
    for slot in ("claude", "grok"):
        assert _frozen(after["threads"][slot]) == before[slot]
    assert len(after["threads"]["chatgpt"]) == 4 + 2 * len(prompts)
    assert [m["meta"] for m in after["threads"]["chatgpt"]].count(
        {"divergence_id": "d1", "round": 1}
    ) == 2
