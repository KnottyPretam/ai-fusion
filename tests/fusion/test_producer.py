"""The producer model (docs/semantics.md addendum): one task performs every LLM call and every
persistence write, holds the busy guard until after the last write and hands `fusion_done` over
only after releasing it, and runs to completion when the client disconnects; the generator only
drains its queue. Also the frozen signature and the router export."""

from __future__ import annotations

import inspect

import pytest
from fastapi import HTTPException

from backend.features import fusion as feature
from backend.features.fusion import run_fusion
from backend.llm import mock
from backend.routers import fusion as router_mod
from backend.schemas import SLOT_IDS
from backend.store import conversations as store
from tests.fusion.conftest import by_type, calls, types_of, wait_until_free


def test_frozen_signature_and_router_export():
    sig = inspect.signature(run_fusion)
    assert list(sig.parameters) == ["conv_id", "of_analyze", "max_iterations"]
    for name in ("of_analyze", "max_iterations"):
        param = sig.parameters[name]
        assert param.kind is inspect.Parameter.KEYWORD_ONLY
        assert param.default is inspect.Parameter.empty
    assert inspect.isasyncgenfunction(run_fusion)
    assert router_mod.router is not None
    routes = {(r.path, tuple(sorted(r.methods))) for r in router_mod.router.routes}
    assert ("/api/conversations/{conv_id}/fusion", ("POST",)) in routes


async def test_pre_checks_raise_before_the_first_yield(prepare):
    p = await prepare("planted_factual")
    gen = run_fusion(p.cid, of_analyze="00000000-0000-4000-8000-000000000000", max_iterations=2)
    with pytest.raises(HTTPException) as info:
        await gen.__anext__()
    assert info.value.status_code == 404
    assert info.value.detail == {"error": "not_found", "what": "turn"}
    assert calls("defense") == [] and not store.is_busy(p.cid)


async def test_guard_is_held_from_the_first_event_until_after_persistence(prepare, monkeypatch):
    monkeypatch.setenv("MOCK_DELAY_MS", "3")  # keep the defense streams in flight
    p = await prepare("planted_factual")
    gen = run_fusion(p.cid, of_analyze=None, max_iterations=2)
    first = await gen.__anext__()
    assert first["type"] == "fusion_start" and store.is_busy(p.cid)
    loaded = await store.load(p.cid)
    assert loaded is not None and [t.type for t in loaded.turns] == ["send", "analyze"]
    last = None
    seen: list[str] = []
    async for ev in gen:
        seen.append(ev["type"])
        if ev["type"] == "fusion_done":
            last = ev
            break
        if ev["type"] != "round_done":  # after the final round_done only persistence remains
            assert store.is_busy(p.cid), ev["type"]
    assert last is not None and seen.count("exchange") == 3
    loaded = await store.load(p.cid)
    assert loaded is not None and loaded.turns[-1].id == first["turn_id"]  # persisted first
    assert not store.is_busy(p.cid)  # released before the final event was handed over
    with pytest.raises(StopAsyncIteration):
        await gen.__anext__()  # fusion_done is the last event


async def test_client_disconnect_lets_the_producer_finish_and_persist(prepare, monkeypatch):
    monkeypatch.setenv("MOCK_DELAY_MS", "3")
    p = await prepare("standing_at_cap")
    gen = run_fusion(p.cid, of_analyze=None, max_iterations=2)
    first = await gen.__anext__()
    assert first["type"] == "fusion_start"
    await gen.aclose()  # the client went away
    assert store.is_busy(p.cid), "the producer must keep running after the disconnect"
    loaded = await store.load(p.cid)
    assert loaded is not None and [t.type for t in loaded.turns] == ["send", "analyze"]

    await wait_until_free(p.cid)
    await feature.wait_for_background()
    loaded = await store.load(p.cid)
    assert loaded is not None
    assert [t.type for t in loaded.turns] == ["send", "analyze", "fusion"]
    turn = loaded.turns[-1]
    assert turn.id == first["turn_id"] and turn.exit_reason == "max_iterations"
    assert len(turn.rounds) == 2 and [s.status for s in turn.final] == ["standing"]
    for slot in SLOT_IDS:
        assert len(loaded.threads[slot]) == 2 + 2 * 2
    assert len(calls("defense")) == 6 and len(calls("convergence")) == 2
    assert not feature._tasks  # the finished task dropped its strong reference


async def test_turn_persistence_failure_after_the_first_event_is_terminal_error(
    prepare, fusion, monkeypatch
):
    p = await prepare("planted_factual")
    real_append_turn = store.append_turn
    fail = {"on": True}

    async def flaky_append_turn(conv_id, turn):
        if fail["on"] and getattr(turn, "type", None) == "fusion":
            raise RuntimeError("disk full")
        await real_append_turn(conv_id, turn)

    monkeypatch.setattr(store, "append_turn", flaky_append_turn)
    r, events = await fusion(p.cid, {"max_iterations": 2})
    assert r.status_code == 200  # the status was committed by the first event
    assert types_of(events) == [
        "fusion_start",
        "round_start",
        "exchange",
        "exchange",
        "exchange",
        "round_done",
        "error",
    ]
    assert "disk full" in events[-1]["message"]
    assert not store.is_busy(p.cid)
    after = await store.load(p.cid)
    assert after is not None
    assert [t.type for t in after.turns] == ["send", "analyze"]  # the turn never made it
    for slot in SLOT_IDS:  # the exchanges did (appended as each challenge completed)
        assert [m.kind for m in after.threads[slot]] == [
            "chat",
            "chat",
            "fusion_challenge",
            "fusion_reply",
        ]

    fail["on"] = False
    mock.reset()
    r, events = await fusion(p.cid, {"max_iterations": 2})
    assert r.status_code == 200 and events[-1]["type"] == "fusion_done"
    after = await store.load(p.cid)
    assert after is not None and [t.type for t in after.turns] == ["send", "analyze", "fusion"]
    assert not store.is_busy(p.cid)


async def test_thread_append_failure_is_terminal_error_after_the_other_slots_finish(
    prepare, fusion, monkeypatch
):
    p = await prepare("planted_factual")
    real_append = store.append_to_thread

    async def flaky_append(conv_id, slot, msgs):
        if slot == "chatgpt":
            raise RuntimeError("cannot write chatgpt thread")
        await real_append(conv_id, slot, msgs)

    monkeypatch.setattr(store, "append_to_thread", flaky_append)
    r, events = await fusion(p.cid, {"max_iterations": 2})
    assert r.status_code == 200
    kinds = types_of(events)
    assert kinds[:2] == ["fusion_start", "round_start"] and kinds[-1] == "error"
    assert "cannot write chatgpt thread" in events[-1]["message"]
    assert "round_done" not in kinds and "fusion_done" not in kinds
    assert {e["model"] for e in by_type(events, "exchange")} == {"R1", "R3"}
    assert calls("convergence") == []  # the round never completed
    assert not store.is_busy(p.cid)
    after = await store.load(p.cid)
    assert after is not None
    assert [t.type for t in after.turns] == ["send", "analyze"]
    assert len(after.threads["chatgpt"]) == 2
    assert len(after.threads["claude"]) == 4 and len(after.threads["grok"]) == 4
