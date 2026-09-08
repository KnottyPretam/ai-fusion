"""Pre-stream checks (plain JSON errors before any SSE byte), the busy guard, and the producer
model: the turn runs to completion and persists after the client is gone; a persistence failure
after the first event is the terminal `error` event and still releases the guard."""

from __future__ import annotations

import asyncio
import contextvars
import uuid

from backend.features import send as send_mod
from backend.llm import mock
from backend.schemas import SLOT_IDS
from backend.store import conversations as store
from tests.conftest import DEFAULT_PROMPT, DEFAULT_RESPONSES
from tests.helpers import parse_sse_text
from tests.send.conftest import CONTINUE_URL, SEND_URL, assert_stream_invariants, types

NOT_FOUND_CONV = {"detail": {"error": "not_found", "what": "conversation"}}
NOT_FOUND_SLOT = {"detail": {"error": "not_found", "what": "slot"}}
EMPTY_PROMPT = {"detail": {"error": "empty_prompt"}}
BUSY = {"detail": {"error": "busy"}}


def _is_json(r) -> bool:
    return r.headers["content-type"].startswith("application/json")


# --------------------------------------------------------------------------- (8) 404 / 422
async def test_unknown_conversation_is_404_json(client):
    for bad in (str(uuid.uuid4()), "not-a-uuid", "00000000-0000-0000-0000-000000000000"):
        r = await client.post(SEND_URL.format(cid=bad), json={"prompt": DEFAULT_PROMPT})
        assert r.status_code == 404 and r.json() == NOT_FOUND_CONV and _is_json(r)
        r = await client.post(
            CONTINUE_URL.format(cid=bad, slot="claude"), json={"prompt": DEFAULT_PROMPT}
        )
        assert r.status_code == 404 and r.json() == NOT_FOUND_CONV and _is_json(r)
    assert mock.calls == []


async def test_unknown_slot_is_404_json(client, cid, get_conv):
    for bad in ("gemini", "R1", "Claude", ""):
        r = await client.post(
            CONTINUE_URL.format(cid=cid, slot=bad), json={"prompt": DEFAULT_PROMPT}
        )
        assert r.status_code == 404, (bad, r.text)
        if bad:  # an empty segment does not match the route at all
            assert r.json() == NOT_FOUND_SLOT and _is_json(r)
    assert mock.calls == []
    assert (await get_conv(cid))["turns"] == []
    assert not store.is_busy(cid)


async def test_blank_prompt_is_422_json(client, cid, get_conv):
    for blank in ("", "   ", "\n\t "):
        r = await client.post(SEND_URL.format(cid=cid), json={"prompt": blank})
        assert r.status_code == 422 and r.json() == EMPTY_PROMPT and _is_json(r)
        r = await client.post(CONTINUE_URL.format(cid=cid, slot="grok"), json={"prompt": blank})
        assert r.status_code == 422 and r.json() == EMPTY_PROMPT and _is_json(r)
    assert mock.calls == []
    conv = await get_conv(cid)
    assert conv["turns"] == [] and all(conv["threads"][s] == [] for s in SLOT_IDS)
    assert conv["title"] == "New conversation"
    assert not store.is_busy(cid)


async def test_malformed_body_is_fastapi_validation_422(client, cid):
    for body in ({}, {"prompt": None}, {"prompt": 42}, {"text": "hi"}):
        r = await client.post(SEND_URL.format(cid=cid), json=body)
        assert r.status_code == 422 and isinstance(r.json()["detail"], list)
    r = await client.post(SEND_URL.format(cid=cid), content=b"not json")
    assert r.status_code == 422
    assert mock.calls == []


async def test_precheck_order_404_before_422_and_slot(client):
    """A missing conversation wins over a blank prompt (and over the slot check in the feature)."""
    missing = str(uuid.uuid4())
    r = await client.post(SEND_URL.format(cid=missing), json={"prompt": ""})
    assert r.status_code == 404 and r.json() == NOT_FOUND_CONV
    r = await client.post(CONTINUE_URL.format(cid=missing, slot="claude"), json={"prompt": ""})
    assert r.status_code == 404 and r.json() == NOT_FOUND_CONV


async def test_feature_generator_prechecks_raise_before_the_first_yield(cid):
    """Called directly, the frozen generators raise the HTTPException before yielding anything
    (that is what lets sse_response turn them into JSON errors)."""
    from fastapi import HTTPException

    async def first(gen):
        try:
            await gen.__anext__()
        except HTTPException as e:
            return e
        raise AssertionError("no HTTPException")

    e = await first(send_mod.run_send(str(uuid.uuid4()), DEFAULT_PROMPT))
    assert e.status_code == 404 and e.detail == NOT_FOUND_CONV["detail"]
    e = await first(send_mod.run_send(cid, "  "))
    assert e.status_code == 422 and e.detail == EMPTY_PROMPT["detail"]
    e = await first(send_mod.run_continue(cid, "nope", DEFAULT_PROMPT))  # type: ignore[arg-type]
    assert e.status_code == 404 and e.detail == NOT_FOUND_SLOT["detail"]
    e = await first(send_mod.run_continue(cid, "nope", " "))  # type: ignore[arg-type]
    assert e.status_code == 422, "blank prompt is checked before the slot"
    assert mock.calls == [] and not store.is_busy(cid)


# --------------------------------------------------------------------------- (7) busy
async def test_send_while_guard_is_held_elsewhere_is_409_busy(client, cid, get_conv):
    """The feature enters busy_guard as its LAST pre-check: with the id held by another task,
    the request is a plain 409 JSON error and no LLM call is made."""

    async def foreign(coro):
        return await asyncio.create_task(coro, context=contextvars.Context())

    async with store.busy_guard(cid):
        r = await foreign(client.post(SEND_URL.format(cid=cid), json={"prompt": DEFAULT_PROMPT}))
        assert r.status_code == 409 and r.json() == BUSY and _is_json(r)
        r = await foreign(
            client.post(CONTINUE_URL.format(cid=cid, slot="claude"), json={"prompt": "x"})
        )
        assert r.status_code == 409 and r.json() == BUSY
        # other pre-checks still come first
        r = await foreign(client.post(SEND_URL.format(cid=cid), json={"prompt": " "}))
        assert r.status_code == 422 and r.json() == EMPTY_PROMPT
    assert mock.calls == []
    assert not store.is_busy(cid)
    r = await client.post(SEND_URL.format(cid=cid), json={"prompt": DEFAULT_PROMPT})
    assert r.status_code == 200
    assert (await get_conv(cid))["turns"][0]["type"] == "send"


async def test_concurrent_send_on_the_same_conversation_is_409_and_guard_is_released(
    client, cid, get_conv, monkeypatch
):
    monkeypatch.setenv("MOCK_DELAY_MS", "100")  # paced replay keeps the first send in flight
    first = asyncio.create_task(
        client.post(SEND_URL.format(cid=cid), json={"prompt": DEFAULT_PROMPT})
    )
    await asyncio.sleep(0.15)
    assert store.is_busy(cid)
    second = await client.post(SEND_URL.format(cid=cid), json={"prompt": "Concurrent"})
    assert second.status_code == 409 and second.json() == BUSY and _is_json(second)
    third = await client.post(
        CONTINUE_URL.format(cid=cid, slot="grok"), json={"prompt": "Concurrent continue"}
    )
    assert third.status_code == 409 and third.json() == BUSY

    r1 = await first
    assert r1.status_code == 200
    events = parse_sse_text(r1.text)
    assert_stream_invariants(events)
    assert not store.is_busy(cid)
    assert len(mock.calls) == 3  # the rejected calls never reached the transport

    monkeypatch.setenv("MOCK_DELAY_MS", "0")
    r = await client.post(SEND_URL.format(cid=cid), json={"prompt": "After"})
    assert r.status_code == 200
    conv = await get_conv(cid)
    assert [t["prompt"] for t in conv["turns"]] == [DEFAULT_PROMPT, "After"]
    assert not store.is_busy(cid)


async def test_two_conversations_stream_independently(client, new_conv, monkeypatch):
    monkeypatch.setenv("MOCK_DELAY_MS", "5")
    a = (await new_conv())["id"]
    b = (await new_conv())["id"]
    ra, rb = await asyncio.gather(
        client.post(SEND_URL.format(cid=a), json={"prompt": DEFAULT_PROMPT}),
        client.post(SEND_URL.format(cid=b), json={"prompt": DEFAULT_PROMPT}),
    )
    assert ra.status_code == 200 and rb.status_code == 200
    assert_stream_invariants(parse_sse_text(ra.text))
    assert_stream_invariants(parse_sse_text(rb.text))
    assert not store.is_busy(a) and not store.is_busy(b)


# --------------------------------------------------------------------------- producer model
async def test_disconnected_client_does_not_stop_the_turn(cid):
    """The generator only drains the producer's queue: closing it after the first event leaves
    the coordinator task running to completion, persisting everything and releasing the guard."""
    gen = send_mod.run_send(cid, DEFAULT_PROMPT)
    first = await gen.__anext__()
    assert first["type"] == "turn_start"
    assert store.is_busy(cid)
    await gen.aclose()  # the client went away
    await send_mod.wait_for_background()
    assert not store.is_busy(cid)
    conv = await store.load(cid)
    assert conv is not None
    assert [t.type for t in conv.turns] == ["send"]
    assert conv.turns[0].id == first["turn_id"]
    assert conv.turns[0].responses == DEFAULT_RESPONSES
    assert conv.title == DEFAULT_PROMPT[:60]
    for slot in SLOT_IDS:
        assert [m.role for m in conv.threads[slot]] == ["user", "assistant"]
    assert len(mock.calls) == 3


async def test_persistence_failure_after_first_event_is_terminal_error_and_releases_guard(
    client, cid, get_conv, monkeypatch
):
    real_append_turn = store.append_turn
    fail = {"on": True}

    async def flaky_append_turn(conv_id, turn):
        if fail["on"]:
            raise RuntimeError("disk full")
        await real_append_turn(conv_id, turn)

    monkeypatch.setattr(store, "append_turn", flaky_append_turn)
    r = await client.post(SEND_URL.format(cid=cid), json={"prompt": DEFAULT_PROMPT})
    assert r.status_code == 200  # the status was committed by the first event
    events = parse_sse_text(r.text)
    assert events[0]["type"] == "turn_start"
    assert events[-1]["type"] == "error" and "disk full" in events[-1]["message"]
    assert "turn_done" not in types(events)
    assert types(events).count("slot_done") == 3
    assert not store.is_busy(cid)
    conv = await get_conv(cid)
    assert conv["turns"] == []  # the turn itself never made it
    for slot in SLOT_IDS:  # the per-slot pairs did (appended at each slot_done)
        assert [m["role"] for m in conv["threads"][slot]] == ["user", "assistant"]

    fail["on"] = False
    r = await client.post(SEND_URL.format(cid=cid), json={"prompt": "Again"})
    assert r.status_code == 200 and parse_sse_text(r.text)[-1]["type"] == "turn_done"
    assert [t["prompt"] for t in (await get_conv(cid))["turns"]] == ["Again"]


async def test_thread_append_failure_becomes_slot_error_and_turn_still_completes(
    client, cid, get_conv, monkeypatch
):
    real_append = store.append_to_thread

    async def flaky_append(conv_id, slot, msgs):
        if slot == "chatgpt":
            raise RuntimeError("cannot write chatgpt thread")
        await real_append(conv_id, slot, msgs)

    monkeypatch.setattr(store, "append_to_thread", flaky_append)
    r = await client.post(SEND_URL.format(cid=cid), json={"prompt": DEFAULT_PROMPT})
    assert r.status_code == 200
    events = parse_sse_text(r.text)
    assert_stream_invariants(events)
    err = [e for e in events if e["type"] == "slot_error"]
    assert len(err) == 1 and err[0]["slot"] == "chatgpt"
    assert err[0]["code"] == "internal_error" and err[0]["error_type"] == "triplex"
    assert "cannot write chatgpt thread" in err[0]["message"]
    assert err[0]["partial"] == DEFAULT_RESPONSES["chatgpt"]
    conv = await get_conv(cid)
    turn = conv["turns"][0]
    assert turn["responses"]["chatgpt"] is None and turn["partial"]["chatgpt"]
    assert conv["threads"]["chatgpt"] == []
    assert [m["role"] for m in conv["threads"]["claude"]] == ["user", "assistant"]
    assert not store.is_busy(cid)
