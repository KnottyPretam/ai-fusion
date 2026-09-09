"""The producer model under failure and disconnect (docs/semantics.md addendum, "Producer model
for every feature and the busy guard"):

- every slot task is total: a failure inside one slot is THAT slot's `slot_error`, the other
  slots finish, persist and the turn is written (a persisted document missing one thread key is
  the reachable trigger);
- the coordinator waits for every slot before failing as a whole, so the busy guard is never
  released while a sibling is still writing;
- the guard is held through every persistence write and released only after the last one;
- a Starlette-style cancellation of the consumer (a CancelledError inside the generator while it
  waits on the queue) never touches the producer: the turn runs to completion and persists;
- a slot's transport generator is closed deterministically (`contextlib.aclosing`) once its
  terminal delta arrived: before the pair is persisted and before its terminal slot event.
"""

from __future__ import annotations

import asyncio
import json

import pytest

from backend.config import settings
from backend.features import send as send_mod
from backend.llm import mock
from backend.schemas import SLOT_IDS, Delta
from backend.store import conversations as store
from backend.store import files
from tests.conftest import DEFAULT_PROMPT, DEFAULT_RESPONSES
from tests.helpers import parse_sse_text
from tests.send.conftest import SEND_URL, assert_stream_invariants, one, types

WRITES = ("append_to_thread", "append_turn", "rename")


@pytest.fixture
def busy_log(monkeypatch) -> list[tuple[str, bool]]:
    """Wrap every store write and record `(name, store.is_busy(conv_id))` as each one runs."""
    seen: list[tuple[str, bool]] = []
    for name in WRITES:
        real = getattr(store, name)

        async def wrapped(conv_id, *args, _real=real, _name=name, **kw):
            seen.append((_name, store.is_busy(conv_id)))
            return await _real(conv_id, *args, **kw)

        monkeypatch.setattr(store, name, wrapped)
    return seen


def _document_path(cid: str):
    return files.document_path(files.conversations_dir(settings().data_dir), cid)


async def _collect(cid: str, prompt: str = DEFAULT_PROMPT) -> list[dict]:
    return [ev async for ev in send_mod.run_send(cid, prompt)]


# --------------------------------------------------------------------------- slot isolation
async def test_a_document_missing_one_thread_key_fails_only_that_slot(cid, busy_log, monkeypatch):
    """`Conversation.threads` has no all-slots validator, so such a document loads. The request
    for the slot is still built (empty history); its append then fails inside the store and
    becomes `slot_error{internal_error}`, while the other two slots finish and persist."""
    monkeypatch.setenv("MOCK_DELAY_MS", "5")
    path = _document_path(cid)
    raw = json.loads(path.read_text(encoding="utf-8"))
    del raw["threads"]["grok"]
    files.write_json_atomic(path, raw)
    loaded = await store.load(cid)
    assert loaded is not None and "grok" not in loaded.threads

    events = await _collect(cid)
    assert_stream_invariants(events)  # turn_start first, one terminal per slot, turn_done last
    err = one(events, "slot_error", "grok")
    assert err["code"] == "internal_error" and err["error_type"] == "triplex"
    assert "KeyError" in err["message"] and err["partial"] == DEFAULT_RESPONSES["grok"]
    for slot in ("claude", "chatgpt"):
        one(events, "slot_done", slot)
    assert len(mock.calls) == 3  # grok's request still went out, with an empty history
    by_role = {c["role"]: c for c in mock.calls}
    assert by_role["grok"]["messages"] == [{"role": "user", "content": DEFAULT_PROMPT}]

    # every write ran under the guard, and the turn was the last of them (grok's append is
    # recorded too: the wrapper logs the call before the store raises inside it)
    names = [n for n, _ in busy_log]
    assert names.count("append_to_thread") == 3 and names[-2:] == ["rename", "append_turn"]
    assert all(busy for _, busy in busy_log)
    await send_mod.wait_for_background()
    assert not store.is_busy(cid)

    conv = await store.load(cid)
    assert conv is not None
    assert [t.type for t in conv.turns] == ["send"] and conv.turns[0].id == events[0]["turn_id"]
    turn = conv.turns[0]
    assert turn.type == "send"
    assert turn.responses["grok"] is None and "KeyError" in turn.errors["grok"]
    assert turn.responses["claude"] == DEFAULT_RESPONSES["claude"]
    assert "grok" not in conv.threads
    for slot in ("claude", "chatgpt"):
        assert [m.role for m in conv.threads[slot]] == ["user", "assistant"]


async def test_a_slot_task_that_fails_outside_its_own_handler_waits_for_its_siblings(
    cid, busy_log, monkeypatch
):
    """Defence in depth for the gather: even a failure that escapes `_run_slot` entirely (fault
    injected here; the real function never raises) surfaces as the terminal `error` only AFTER
    every sibling finished its last write, and the guard is released after that."""
    monkeypatch.setenv("MOCK_DELAY_MS", "10")
    real_run_slot = send_mod._run_slot

    async def run_slot(conv, slot, *args, **kw):
        if slot == "grok":
            raise RuntimeError("boom outside the slot handler")
        return await real_run_slot(conv, slot, *args, **kw)

    monkeypatch.setattr(send_mod, "_run_slot", run_slot)

    events = await _collect(cid)
    assert events[0]["type"] == "turn_start" and events[-1]["type"] == "error"
    assert "boom outside the slot handler" in events[-1]["message"]
    assert "turn_done" not in types(events)
    for slot in ("claude", "chatgpt"):
        one(events, "slot_done", slot)  # the siblings ran to completion before the error
    assert not [e for e in events if e.get("slot") == "grok"]
    assert [n for n, _ in busy_log] == ["append_to_thread", "append_to_thread"]
    assert all(busy for _, busy in busy_log)  # no write after the release
    assert not store.is_busy(cid)

    conv = await store.load(cid)
    assert conv is not None and conv.turns == []  # the turn as a whole failed
    for slot in ("claude", "chatgpt"):
        assert [m.role for m in conv.threads[slot]] == ["user", "assistant"]
    assert conv.threads["grok"] == []


# --------------------------------------------------------------------------- the busy guard
async def test_guard_is_held_through_every_persistence_write_and_released_after_the_last(
    client, cid, busy_log
):
    r = await client.post(SEND_URL.format(cid=cid), json={"prompt": DEFAULT_PROMPT})
    assert r.status_code == 200
    events = parse_sse_text(r.text)
    assert_stream_invariants(events)
    names = [n for n, _ in busy_log]
    assert names[:3] == ["append_to_thread"] * 3  # one per slot_done
    assert names[3:] == ["rename", "append_turn"]  # the turn is the LAST write
    assert all(busy for _, busy in busy_log)
    assert not store.is_busy(cid)


# --------------------------------------------------------------------------- disconnect
async def test_cancelling_the_consumer_while_it_waits_on_the_queue_does_not_stop_the_turn(
    cid, monkeypatch
):
    """A real disconnect cancels the body-iterating task while the generator is suspended in
    `queue.get()` (a CancelledError inside the generator frame, unlike `aclose()`)."""
    gate = asyncio.Event()
    parked: list[int] = []
    real = send_mod.llm_client.stream_completion

    async def gated(**kw):
        deltas = [d async for d in real(**kw)]  # the real fixture, consumed up front
        for d in deltas[:-1]:
            yield d
        parked.append(len(deltas) - 1)
        await gate.wait()  # hold the terminal delta until the test says so
        yield deltas[-1]

    monkeypatch.setattr(send_mod.llm_client, "stream_completion", gated)

    gen = send_mod.run_send(cid, DEFAULT_PROMPT)
    first = await gen.__anext__()
    assert first["type"] == "turn_start" and store.is_busy(cid)
    # The slot tasks are scheduled, not yet run: give the loop a few turns so every producer
    # reaches its gate, then drain exactly what they queued (their slot_start plus one event per
    # non-terminal delta), leaving the consumer with an empty queue to block on.
    for _ in range(20):
        if len(parked) == 3:
            break
        await asyncio.sleep(0)
    assert len(parked) == 3
    for _ in range(3 + sum(parked)):
        ev = await gen.__anext__()
        assert ev["type"] in ("slot_start", "slot_delta", "slot_reasoning", "slot_citations")

    waiter = asyncio.create_task(gen.__anext__())
    await asyncio.sleep(0)  # let it suspend in queue.get()
    assert not waiter.done()
    waiter.cancel()
    with pytest.raises(asyncio.CancelledError):
        await waiter
    assert store.is_busy(cid)  # the producer is untouched

    gate.set()
    await send_mod.wait_for_background()
    assert not store.is_busy(cid)
    conv = await store.load(cid)
    assert conv is not None
    assert [t.type for t in conv.turns] == ["send"]
    turn = conv.turns[0]
    assert turn.type == "send" and turn.id == first["turn_id"]
    assert turn.responses == DEFAULT_RESPONSES and turn.errors == {}
    assert conv.title == DEFAULT_PROMPT[:60]
    for slot in SLOT_IDS:
        assert [m.role for m in conv.threads[slot]] == ["user", "assistant"]
    assert len(mock.calls) == 3


# --------------------------------------------------------------------------- transport teardown
async def test_transport_is_closed_before_persistence_and_the_terminal_slot_event(
    send, cid, monkeypatch
):
    """`contextlib.aclosing`: a slot's `stream_completion` generator is closed (its `finally`
    has run, i.e. the httpx response/client and record tee are gone) as soon as its terminal
    delta arrived -- before `append_to_thread` and before slot_done / slot_error are built --
    not whenever the garbage collector finalises a generator left suspended by `break`."""
    real = send_mod.llm_client.stream_completion
    closed: dict[str, bool] = {}

    async def tracked(**kw):
        role = kw["role"]
        closed[role] = False
        try:
            if role == "grok":  # the error path persists nothing: its terminal event is the check
                yield Delta(kind="text", text="half")
                yield Delta(kind="error", code=502, error_type="provider_unavailable", message="x")
            else:
                async for d in real(**kw):
                    yield d
        finally:
            closed[role] = True

    monkeypatch.setattr(send_mod.llm_client, "stream_completion", tracked)
    seen: list[tuple[str, str, bool]] = []
    real_append = store.append_to_thread

    async def append(conv_id, slot, msgs):
        seen.append(("append_to_thread", slot, closed[slot]))
        await real_append(conv_id, slot, msgs)

    monkeypatch.setattr(store, "append_to_thread", append)
    for name in ("_slot_done", "_slot_error"):

        def wrapped(*args, _real=getattr(send_mod, name), _name=name, **kw):
            ev = _real(*args, **kw)
            seen.append((_name, ev["slot"], closed[ev["slot"]]))
            return ev

        monkeypatch.setattr(send_mod, name, wrapped)

    events = await send(cid)
    assert_stream_invariants(events)
    one(events, "slot_error", "grok")
    assert sorted(seen) == sorted(
        [
            ("append_to_thread", "claude", True),
            ("_slot_done", "claude", True),
            ("append_to_thread", "chatgpt", True),
            ("_slot_done", "chatgpt", True),
            ("_slot_error", "grok", True),
        ]
    )
    assert closed == dict.fromkeys(SLOT_IDS, True)
