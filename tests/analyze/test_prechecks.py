"""Pre-stream checks of POST /api/conversations/{id}/analyze: plain JSON errors in FastAPI's
`{detail:{error}}` envelope, raised before the first SSE event, in the order of
docs/semantics.md "Analyze" (404 -> of_turn -> incomplete -> cache -> busy LAST)."""

from __future__ import annotations

import uuid

import pytest

from backend.llm import mock
from backend.schemas import ContinueTurn, SendTurn
from backend.store import conversations as store
from tests.analyze.conftest import persist
from tests.conftest import DEFAULT_RESPONSES


def _error(r) -> str:
    assert r.headers["content-type"].startswith("application/json"), r.headers
    return r.json()["detail"]["error"]


# --------------------------------------------------------------------------- 404
@pytest.mark.parametrize("conv_id", [str(uuid.uuid4()), "not-a-uuid", "0" * 36])
async def test_unknown_conversation_is_404(analyze, conv_id):
    r, _ = await analyze(conv_id)
    assert r.status_code == 404
    assert r.json() == {"detail": {"error": "not_found", "what": "conversation"}}
    assert mock.calls == []


async def test_unknown_of_turn_is_404_turn(persisted_conversation, analyze):
    r, _ = await analyze(persisted_conversation.id, {"of_turn": str(uuid.uuid4())})
    assert r.status_code == 404
    assert r.json() == {"detail": {"error": "not_found", "what": "turn"}}
    assert mock.calls == []


# --------------------------------------------------------------------------- 409 / 422
async def test_incomplete_send_turn_is_409_with_the_missing_slots(scenario_conversation, analyze):
    conv = await scenario_conversation("slot_failure")
    send = conv.turns[-1]
    assert send.type == "send" and send.responses["grok"] is None
    assert send.responses["claude"] and send.responses["chatgpt"]
    r, _ = await analyze(conv.id)
    assert r.status_code == 409
    assert r.json() == {"detail": {"error": "incomplete_send_turn", "missing": ["grok"]}}
    assert mock.calls == []
    assert not store.is_busy(conv.id)


async def test_incomplete_lists_every_missing_slot_in_slot_order(make_conversation, analyze):
    conv = await persist(
        make_conversation(responses={"claude": None, "chatgpt": "ok", "grok": None})
    )
    r, _ = await analyze(conv.id)
    assert r.status_code == 409
    assert r.json()["detail"] == {"error": "incomplete_send_turn", "missing": ["claude", "grok"]}


async def test_no_send_turn_is_409(make_conversation, analyze):
    conv = await persist(make_conversation(with_send=False))
    r, _ = await analyze(conv.id)
    assert r.status_code == 409 and r.json() == {"detail": {"error": "no_send_turn"}}
    assert mock.calls == []


async def test_only_continue_turns_is_still_no_send_turn(make_conversation, analyze):
    src = make_conversation(with_send=False)
    src.turns.append(
        ContinueTurn(slot="claude", prompt="more?", response="sure", slot_config=src.slot_config)
    )
    conv = await persist(src)
    r, _ = await analyze(conv.id)
    assert r.status_code == 409 and _error(r) == "no_send_turn"


async def test_explicit_non_send_turn_is_422(make_conversation, analyze):
    src = make_conversation()
    cont = ContinueTurn(slot="grok", prompt="more?", response="sure", slot_config=src.slot_config)
    src.turns.append(cont)
    conv = await persist(src)
    r, _ = await analyze(conv.id, {"of_turn": cont.id})
    assert r.status_code == 422 and r.json() == {"detail": {"error": "not_a_send_turn"}}
    assert mock.calls == []

    # An analyze turn id is not analyzable either.
    _, events = await analyze(conv.id)
    analyze_id = events[0]["turn_id"]
    r, _ = await analyze(conv.id, {"of_turn": analyze_id})
    assert r.status_code == 422 and _error(r) == "not_a_send_turn"


async def test_default_of_turn_is_the_newest_send_turn_even_after_a_continue(
    make_conversation, analyze
):
    src = make_conversation()
    first = src.turns[0]
    second = SendTurn(
        prompt="And the accelerometer?",
        responses={s: f"{s}: 24 g" for s in DEFAULT_RESPONSES},
        slot_config=src.slot_config,
    )
    src.turns.append(second)
    src.turns.append(
        ContinueTurn(slot="claude", prompt="why?", response="because", slot_config=src.slot_config)
    )
    conv = await persist(src)
    _, events = await analyze(conv.id)
    assert events[0]["of_turn"] == second.id != first.id
    _, events = await analyze(conv.id, {"of_turn": first.id})
    assert events[0]["of_turn"] == first.id and events[-1]["cached"] is False


# --------------------------------------------------------------------------- busy
async def test_analyze_while_another_feature_holds_the_conversation_is_409_busy(
    persisted_conversation, analyze, hold_busy
):
    conv = persisted_conversation
    async with hold_busy(conv.id):
        r, _ = await analyze(conv.id)
        assert r.status_code == 409 and r.json() == {"detail": {"error": "busy"}}
        assert mock.calls == []
        r, _ = await analyze(conv.id, {"force": True})
        assert r.status_code == 409 and _error(r) == "busy"
    # Released: the same request now streams.
    r, events = await analyze(conv.id)
    assert r.status_code == 200 and events[-1]["type"] == "analyze_done"
    assert not store.is_busy(conv.id)


async def test_busy_is_checked_last(scenario_conversation, make_conversation, analyze, hold_busy):
    incomplete = await scenario_conversation("slot_failure")
    async with hold_busy(incomplete.id):
        r, _ = await analyze(incomplete.id)
        assert r.status_code == 409 and _error(r) == "incomplete_send_turn"
    empty = await persist(make_conversation(with_send=False))
    async with hold_busy(empty.id):
        r, _ = await analyze(empty.id)
        assert r.status_code == 409 and _error(r) == "no_send_turn"
        r, _ = await analyze(empty.id, {"of_turn": str(uuid.uuid4())})
        assert r.status_code == 404 and _error(r) == "not_found"


async def test_cached_hit_does_not_need_the_guard(
    persisted_conversation, analyze, hold_busy, run_foreign
):
    conv = persisted_conversation
    _, first = await run_foreign(analyze(conv.id))
    mock.reset()
    async with hold_busy(conv.id):
        # Requests run in fresh contexts, the way separate HTTP requests reach the store.
        r, events = await run_foreign(analyze(conv.id))
        assert r.status_code == 200
        assert [e["type"] for e in events] == ["analyze_start", "analyze_done"]
        assert events[-1]["cached"] is True and events[0]["turn_id"] == first[0]["turn_id"]
        assert mock.calls == []
        assert store.is_busy(conv.id)  # still held by the other task, untouched by us
        # force needs a fresh run and therefore the guard.
        r, _ = await run_foreign(analyze(conv.id, {"force": True}))
        assert r.status_code == 409 and _error(r) == "busy"


async def test_guard_is_released_after_a_fresh_run(persisted_conversation, analyze):
    conv = persisted_conversation
    assert not store.is_busy(conv.id)
    await analyze(conv.id, {"force": True})
    assert not store.is_busy(conv.id)
    await analyze(conv.id, {"force": True})  # a second fresh run is not blocked by the first
    assert not store.is_busy(conv.id)


# --------------------------------------------------------------------------- request body
async def test_request_body_validation_uses_fastapi_default_envelope(
    persisted_conversation, client
):
    url = f"/api/conversations/{persisted_conversation.id}/analyze"
    r = await client.post(url, json={"force": "maybe"})
    assert r.status_code == 422 and isinstance(r.json()["detail"], list)
    r = await client.post(url, json={"of_turn": 123})
    assert r.status_code == 422 and isinstance(r.json()["detail"], list)
    assert mock.calls == []


async def test_request_body_is_optional(persisted_conversation, client):
    url = f"/api/conversations/{persisted_conversation.id}/analyze"
    r = await client.post(url)  # no body at all
    assert r.status_code == 200 and "analyze_done" in r.text
    r = await client.post(url, json={})
    assert r.status_code == 200 and '"cached": true' in r.text
    r = await client.post(url, json={"of_turn": None, "force": False})
    assert r.status_code == 200 and '"cached": true' in r.text
