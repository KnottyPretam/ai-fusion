"""The producer model (docs/semantics.md addendum): one task does the LLM calls and the
persistence write, holds the busy guard until after that write, and runs to completion when the
client disconnects; the generator only drains its queue. Also the frozen signature itself."""

from __future__ import annotations

import inspect

from fastapi import HTTPException

from backend.features import analyze as feature
from backend.features.analyze import run_analyze
from backend.llm import mock
from backend.routers import analyze as router_mod
from backend.store import conversations as store
from tests.analyze.conftest import extraction_calls, wait_until_free


def test_frozen_signature_and_router_export():
    sig = inspect.signature(run_analyze)
    assert list(sig.parameters) == ["conv_id", "of_turn", "force"]
    assert sig.parameters["of_turn"].kind is inspect.Parameter.KEYWORD_ONLY
    assert sig.parameters["force"].kind is inspect.Parameter.KEYWORD_ONLY
    assert sig.parameters["of_turn"].default is None and sig.parameters["force"].default is False
    assert inspect.isasyncgenfunction(run_analyze)
    routes = {(r.path, tuple(sorted(r.methods))) for r in router_mod.router.routes}
    assert ("/api/conversations/{conv_id}/analyze", ("POST",)) in routes


async def test_pre_checks_raise_before_the_first_yield(persisted_conversation):
    gen = run_analyze(persisted_conversation.id, of_turn="00000000-0000-4000-8000-000000000000")
    try:
        await gen.__anext__()
    except HTTPException as e:
        assert e.status_code == 404 and e.detail == {"error": "not_found", "what": "turn"}
    else:  # pragma: no cover
        raise AssertionError("expected a pre-stream HTTPException")
    assert mock.calls == [] and not store.is_busy(persisted_conversation.id)


async def test_guard_is_held_from_the_first_event_until_after_persistence(
    persisted_conversation, monkeypatch
):
    monkeypatch.setenv("MOCK_DELAY_MS", "3")  # keep the analyst stream in flight
    conv = persisted_conversation
    gen = run_analyze(conv.id)
    first = await gen.__anext__()
    assert first["type"] == "analyze_start" and store.is_busy(conv.id)
    loaded = await store.load(conv.id)
    assert [t.type for t in loaded.turns] == ["send"]  # nothing persisted yet
    last = await gen.__anext__()
    assert last["type"] == "analyze_done"
    loaded = await store.load(conv.id)
    assert loaded.turns[-1].id == first["turn_id"]  # persisted before analyze_done
    assert not store.is_busy(conv.id)  # released before the final event was handed over
    try:
        await gen.__anext__()
    except StopAsyncIteration:
        pass
    else:  # pragma: no cover
        raise AssertionError("analyze_done must be the last event")


async def test_client_disconnect_lets_the_producer_finish_and_persist(
    persisted_conversation, monkeypatch
):
    monkeypatch.setenv("MOCK_DELAY_MS", "3")  # ~34 chunks: the stream outlives the disconnect
    conv = persisted_conversation
    gen = run_analyze(conv.id)
    first = await gen.__anext__()
    assert first["type"] == "analyze_start"
    await gen.aclose()  # the client went away
    assert store.is_busy(conv.id), "the producer must keep running after the disconnect"
    loaded = await store.load(conv.id)
    assert [t.type for t in loaded.turns] == ["send"]

    await wait_until_free(conv.id)
    loaded = await store.load(conv.id)
    assert [t.type for t in loaded.turns] == ["send", "analyze"]
    turn = loaded.turns[-1]
    assert turn.id == first["turn_id"] and turn.status == "ok"
    assert turn.extraction is not None and turn.extraction.divergences[0].id == "d1"
    assert len(extraction_calls()) == 1
    assert not feature._tasks  # the finished task dropped its strong reference


async def test_a_disconnected_run_is_then_served_from_cache(persisted_conversation, monkeypatch):
    monkeypatch.setenv("MOCK_DELAY_MS", "2")
    conv = persisted_conversation
    gen = run_analyze(conv.id)
    first = await gen.__anext__()
    await gen.aclose()
    await wait_until_free(conv.id)
    monkeypatch.setenv("MOCK_DELAY_MS", "0")
    events = [e async for e in run_analyze(conv.id)]
    assert [e["type"] for e in events] == ["analyze_start", "analyze_done"]
    assert events[0]["turn_id"] == first["turn_id"] and events[-1]["cached"] is True
    assert len(extraction_calls()) == 1


async def test_nested_call_inside_a_guard_holder_is_reentrant(persisted_conversation):
    """run_fusion's auto-run: the caller already holds the guard (acquired in this task), the
    nested run_analyze neither raises busy nor releases the caller's guard."""
    conv = persisted_conversation
    outer = store.busy_guard(conv.id)
    await outer.__aenter__()
    try:
        events = [e async for e in run_analyze(conv.id)]
        assert [e["type"] for e in events] == ["analyze_start", "analyze_done"]
        assert store.is_busy(conv.id), "the nested run released the outer guard"
        loaded = await store.load(conv.id)
        assert loaded.turns[-1].id == events[0]["turn_id"]
    finally:
        await outer.__aexit__(None, None, None)
    assert not store.is_busy(conv.id)
