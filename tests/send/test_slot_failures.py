"""Slot failures minted by the feature itself, and transport codes passed through verbatim.

- A `done` whose accumulated text is empty or whitespace is `slot_error{code:"empty_reply",
  error_type:"triplex", message:"model returned no text (finish_reason=<fr>)", partial:""}`:
  nothing is appended (no orphan user message, no empty assistant message that a provider would
  reject on every later request), `responses[slot]` is None (so Analyze sees an incomplete turn),
  `truncated[slot]` still reflects `finish_reason == "length"`, and the call's usage is still
  folded into `turn_done.usage`.
- A transport `error` delta's `code` (the cost cap included) reaches `slot_error.code` unchanged.

Deltas are injected by monkeypatching `stream_completion` for one slot (the other slots run
through the real mock transport); the `empty_reply` scenario under tests/send/fixtures drives the
same rule through the real SSE parser.
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

from backend.config import DEFAULT_SLOT_CONFIG
from backend.features import send as send_mod
from backend.llm import mock
from backend.schemas import SLOT_IDS, Delta, Usage
from tests.conftest import DEFAULT_PROMPT, DEFAULT_RESPONSES
from tests.send.conftest import assert_stream_invariants, for_slot, of_type, one, slot_text

SEND_FIXTURES = Path(__file__).resolve().parent / "fixtures"
MODEL = {slot: DEFAULT_SLOT_CONFIG.slots[slot].model for slot in SLOT_IDS}
EMPTY_LENGTH = "model returned no text (finish_reason=length)"
EMPTY_STOP = "model returned no text (finish_reason=stop)"


def _usage(slot: str) -> Usage:
    return Usage(
        prompt_tokens=20,
        completion_tokens=64,
        reasoning_tokens=64,
        cost_usd=0.0007,
        latency_ms=5,
        model=MODEL[slot],
        role=slot,
        purpose="chat",
        generation_id="gen-injected",
    )


def _done(slot: str, finish_reason: str, *, usage: bool = True) -> Delta:
    return Delta(
        kind="done",
        finish_reason=finish_reason,
        truncated=finish_reason == "length",
        usage=_usage(slot) if usage else None,
        generation_id="gen-injected",
    )


def _history(thread: list[dict]) -> list[dict]:
    return [{"role": m["role"], "content": m["content"]} for m in thread]


@pytest.fixture
def inject(monkeypatch) -> Callable[..., None]:
    """`inject(slot, deltas)`: the NEXT `stream_completion` call for `slot` yields exactly
    `deltas` (later calls, and every other slot, go through the real client / mock transport)."""
    real = send_mod.llm_client.stream_completion
    planned: dict[str, list[list[Delta]]] = {}

    async def fake(**kw: Any):
        pending = planned.get(kw["role"])
        if pending:
            for d in pending.pop(0):
                yield d
            return
        async for d in real(**kw):
            yield d

    monkeypatch.setattr(send_mod.llm_client, "stream_completion", fake)

    def _plan(slot: str, deltas: list[Delta]) -> None:
        planned.setdefault(slot, []).append(list(deltas))

    return _plan


# --------------------------------------------------------------------------- empty reply
async def test_reasoning_only_reply_is_empty_reply_and_the_thread_stays_replayable(
    inject, send, cont, cid, get_conv
):
    inject("claude", [Delta(kind="reasoning", text="thinking..."), _done("claude", "length")])
    events = await send(cid)
    assert_stream_invariants(events)

    err = one(events, "slot_error", "claude")
    assert err == {
        "type": "slot_error",
        "slot": "claude",
        "code": "empty_reply",
        "error_type": "triplex",
        "message": EMPTY_LENGTH,
        "partial": "",
    }
    assert [e["type"] for e in for_slot(events, "claude")] == [
        "slot_start",
        "slot_reasoning",
        "slot_error",
    ]
    assert slot_text(events, "claude", "slot_reasoning") == "thinking..."
    for slot in ("chatgpt", "grok"):
        one(events, "slot_done", slot)
    done = events[-1]
    assert done["usage"]["totals"]["calls"] == 3  # the empty call is still billed
    assert {u["role"] for u in done["usage"]["calls"]} == set(SLOT_IDS)
    claude_usage = [u for u in done["usage"]["calls"] if u["role"] == "claude"]
    assert len(claude_usage) == 1
    assert claude_usage[0]["reasoning_tokens"] == 64 and claude_usage[0]["cost_usd"] == 0.0007

    conv = await get_conv(cid)
    turn = conv["turns"][0]
    assert turn["responses"] == {
        "claude": None,
        "chatgpt": DEFAULT_RESPONSES["chatgpt"],
        "grok": DEFAULT_RESPONSES["grok"],
    }
    assert turn["errors"] == {"claude": EMPTY_LENGTH}
    assert turn["partial"] == {"claude": ""}
    assert turn["truncated"] == {"claude": True, "chatgpt": False, "grok": False}
    assert turn["reasoning"]["claude"] == "thinking..."  # reasoning lives on the turn
    assert turn["usage"] == done["usage"]
    assert conv["threads"]["claude"] == []  # no orphan user message, no empty assistant message
    for slot in ("chatgpt", "grok"):
        assert [m["role"] for m in conv["threads"][slot]] == ["user", "assistant"]

    # The slot is not poisoned: the next continue replays a request without any empty message.
    events2 = await cont(cid, "claude", "Try again?")
    assert_stream_invariants(events2, slots=("claude",))
    one(events2, "slot_done", "claude")
    c = mock.calls[-1]
    assert c["role"] == "claude" and c["fixture"] == "planted_factual/claude.chat.1.jsonl"
    assert c["messages"] == [{"role": "user", "content": "Try again?"}]
    assert all(m["content"].strip() for m in c["messages"])
    conv2 = await get_conv(cid)
    assert [m["role"] for m in conv2["threads"]["claude"]] == ["user", "assistant"]
    assert conv2["turns"][1]["response"] == DEFAULT_RESPONSES["claude"]


async def test_done_with_no_deltas_at_all_is_empty_reply(inject, send, cid, get_conv):
    """An upstream that returns nothing (no text, no reasoning) and no usage chunk either: the
    feature synthesises the slot's Usage so the call is still counted."""
    inject("grok", [_done("grok", "stop", usage=False)])
    events = await send(cid)
    assert_stream_invariants(events)
    err = one(events, "slot_error", "grok")
    assert err["code"] == "empty_reply" and err["error_type"] == "triplex"
    assert err["message"] == EMPTY_STOP and err["partial"] == ""
    assert [e["type"] for e in for_slot(events, "grok")] == ["slot_start", "slot_error"]
    done = events[-1]
    assert done["usage"]["totals"]["calls"] == 3
    grok_usage = [u for u in done["usage"]["calls"] if u["role"] == "grok"]
    assert len(grok_usage) == 1 and grok_usage[0]["model"] == MODEL["grok"]
    assert grok_usage[0]["purpose"] == "chat" and grok_usage[0]["completion_tokens"] == 0

    turn = (await get_conv(cid))["turns"][0]
    assert turn["responses"]["grok"] is None and turn["truncated"]["grok"] is False
    assert turn["errors"]["grok"] == EMPTY_STOP and turn["partial"]["grok"] == ""
    assert "grok" not in turn["reasoning"]


async def test_whitespace_only_text_counts_as_empty(inject, send, cid, get_conv):
    inject(
        "chatgpt",
        [Delta(kind="text", text="\n"), Delta(kind="text", text="  \n"), _done("chatgpt", "stop")],
    )
    events = await send(cid)
    assert_stream_invariants(events)
    assert slot_text(events, "chatgpt") == "\n  \n"  # streamed as it came
    err = one(events, "slot_error", "chatgpt")
    assert err["code"] == "empty_reply" and err["message"] == EMPTY_STOP
    assert err["partial"] == ""
    assert not [e for e in of_type(events, "slot_done") if e["slot"] == "chatgpt"]
    conv = await get_conv(cid)
    assert conv["threads"]["chatgpt"] == []
    turn = conv["turns"][0]
    assert turn["responses"]["chatgpt"] is None and not turn["partial"]["chatgpt"].strip()
    assert turn["errors"]["chatgpt"] == EMPTY_STOP


async def test_empty_reply_on_a_continue_leaves_the_thread_untouched(
    inject, send, cont, cid, get_conv
):
    await send(cid)
    before = (await get_conv(cid))["threads"]
    inject("claude", [Delta(kind="reasoning", text="..."), _done("claude", "length")])
    events = await cont(cid, "claude", "Go deeper.")
    assert_stream_invariants(events, slots=("claude",))
    err = one(events, "slot_error", "claude")
    assert err["code"] == "empty_reply" and err["message"] == EMPTY_LENGTH
    assert err["partial"] == ""
    assert events[-1]["usage"]["totals"]["calls"] == 1

    conv = await get_conv(cid)
    assert conv["threads"] == before  # byte-identical: nothing appended anywhere
    t = conv["turns"][1]
    assert t["type"] == "continue" and t["slot"] == "claude"
    assert t["response"] is None and t["error"] == EMPTY_LENGTH
    assert t["truncated"] is True and t["reasoning"] == "..."
    assert t["usage"]["totals"]["calls"] == 1 and t["usage"]["calls"][0]["role"] == "claude"

    # ... and the next continue replays exactly the intact history.
    await cont(cid, "claude", "Once more.")
    assert mock.calls[-1]["messages"] == _history(before["claude"]) + [
        {"role": "user", "content": "Once more."}
    ]


async def test_empty_reply_scenario_through_the_real_parser(
    send, client, cid, get_conv, monkeypatch
):
    """`empty_reply`: claude streams reasoning only and hits max_tokens (usage chunk with
    finish_reason "length"); grok's stream is a single usage-only chunk (finish_reason "stop");
    chatgpt replies normally. Both empty slots fail, the turn is incomplete for Analyze."""
    monkeypatch.setenv("MOCK_FIXTURES_DIR", str(SEND_FIXTURES))
    monkeypatch.setenv("MOCK_SCENARIO", "empty_reply")
    events = await send(cid, "Which BMI088 register selects the gyroscope range?")
    assert_stream_invariants(events)
    assert [c["fixture"] for c in mock.calls] == [
        f"empty_reply/{slot}.chat.1.jsonl" for slot in SLOT_IDS
    ]

    claude = one(events, "slot_error", "claude")
    assert claude["code"] == "empty_reply" and claude["message"] == EMPTY_LENGTH
    assert claude["partial"] == ""
    assert slot_text(events, "claude", "slot_reasoning").startswith("Working through")
    assert not [e for e in of_type(events, "slot_delta") if e["slot"] != "chatgpt"]
    grok = one(events, "slot_error", "grok")
    assert grok["code"] == "empty_reply" and grok["message"] == EMPTY_STOP
    assert [e["type"] for e in for_slot(events, "grok")] == ["slot_start", "slot_error"]
    done = one(events, "slot_done", "chatgpt")
    assert done["finish_reason"] == "stop" and done["truncated"] is False
    totals = events[-1]["usage"]["totals"]
    assert totals["calls"] == 3 and totals["reasoning_tokens"] == 64
    assert totals["cost_usd"] == pytest.approx(0.00032 + 0.00015 + 0.00001)

    conv = await get_conv(cid)
    turn = conv["turns"][0]
    assert turn["responses"] == {
        "claude": None,
        "chatgpt": "GYRO_RANGE (register 0x0F) selects the full-scale range.",
        "grok": None,
    }
    assert turn["errors"] == {"claude": EMPTY_LENGTH, "grok": EMPTY_STOP}
    assert turn["partial"] == {"claude": "", "grok": ""}
    assert turn["truncated"] == {"claude": True, "chatgpt": False, "grok": False}
    assert list(turn["reasoning"]) == ["claude"]
    assert conv["threads"]["claude"] == [] and conv["threads"]["grok"] == []
    assert [m["role"] for m in conv["threads"]["chatgpt"]] == ["user", "assistant"]

    # Completeness is "every response non-null": Analyze refuses the turn.
    r = await client.post(f"/api/conversations/{cid}/analyze", json={})
    assert r.status_code == 409
    assert r.json()["detail"] == {"error": "incomplete_send_turn", "missing": ["claude", "grok"]}


# --------------------------------------------------------------------------- codes pass through
async def test_cost_cap_error_delta_maps_to_slot_error_with_the_same_code(
    inject, send, cid, get_conv
):
    msg = "session cost cap reached: spent $10.0000 of SESSION_COST_CAP_USD=$10.00; live calls refused"
    inject(
        "chatgpt",
        [Delta(kind="error", code="cost_cap_exceeded", error_type="triplex", message=msg)],
    )
    events = await send(cid)
    assert_stream_invariants(events)
    err = one(events, "slot_error", "chatgpt")
    assert err == {
        "type": "slot_error",
        "slot": "chatgpt",
        "code": "cost_cap_exceeded",
        "error_type": "triplex",
        "message": msg,
        "partial": "",
    }
    done = events[-1]
    assert done["usage"]["totals"]["calls"] == 2  # a transport error carries no usage
    assert {u["role"] for u in done["usage"]["calls"]} == {"claude", "grok"}
    conv = await get_conv(cid)
    assert conv["turns"][0]["errors"] == {"chatgpt": msg}
    assert conv["turns"][0]["responses"]["chatgpt"] is None
    assert conv["threads"]["chatgpt"] == []


async def test_stream_ending_without_a_terminal_delta_is_an_internal_error(
    inject, send, cid, get_conv
):
    """The client contract forbids it; the feature still refuses to treat it as a success."""
    inject("grok", [Delta(kind="text", text="half an answer")])
    events = await send(cid)
    assert_stream_invariants(events)
    err = one(events, "slot_error", "grok")
    assert err["code"] == "internal_error" and err["error_type"] == "triplex"
    assert "without a terminal delta" in err["message"]
    assert err["partial"] == "half an answer" == slot_text(events, "grok")
    conv = await get_conv(cid)
    assert conv["threads"]["grok"] == []
    assert conv["turns"][0]["partial"]["grok"] == "half an answer"
    assert conv["turns"][0]["prompt"] == DEFAULT_PROMPT
