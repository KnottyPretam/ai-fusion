"""The store with a council of 2..5 (2026-09-27): `create` seats the config's council, the mock map
is R1..Rn in catalog order, `update_slot_config` re-stamps an EMPTY conversation and refuses a
council change after anything was said, a non-council append is a ValueError, and an invalid
document on disk is a WARNING with locations only, counted."""

from __future__ import annotations

import asyncio
import json
import logging

import pytest
from fastapi import HTTPException

from backend import anon
from backend.schemas import DEFAULT_COUNCIL, LABELS, SlotConfig, SlotSpec, ThreadMessage, council_of
from backend.store import conversations as store
from backend.store import files
from backend.store.conversations import _is_empty
from tests.conftest import DEFAULT_PROMPT

ANALYST = "openai/gpt-5.6-luna"


def cfg(*slots: str, analyst: str = ANALYST) -> SlotConfig:
    return SlotConfig(
        slots={s: SlotSpec(model=f"vendor/{s}-model", effort="medium") for s in slots},
        analyst_model=analyst,
    )


PAIR = cfg("chatgpt", "qwen")
FIVE = cfg("claude", "chatgpt", "grok", "gemini", "deepseek")


def _msg(turn: str = "t1") -> list[ThreadMessage]:
    return [
        ThreadMessage(role="user", content="q", turn_id=turn),
        ThreadMessage(role="assistant", content="a", turn_id=turn),
    ]


# --------------------------------------------------------------------------- mock map / create
def test_mock_anon_map_is_catalog_order_and_pins_the_three():
    assert store.mock_anon_map(DEFAULT_COUNCIL) == store.MOCK_ANON_MAP
    assert store.mock_anon_map(("qwen", "chatgpt")) == {"R1": "qwen", "R2": "chatgpt"}  # as given
    assert store.mock_anon_map(council_of(PAIR)) == {"R1": "chatgpt", "R2": "qwen"}
    assert store.mock_anon_map(council_of(FIVE)) == dict(zip(LABELS, council_of(FIVE), strict=True))


@pytest.mark.parametrize("config", [PAIR, FIVE], ids=["two", "five"])
async def test_create_seats_the_council_in_catalog_order(config):
    conv = await store.create(slot_config=config)
    council = council_of(config)
    assert tuple(conv.threads) == council and all(v == [] for v in conv.threads.values())
    assert conv.anon_map == store.mock_anon_map(council)  # mock mode: fixed
    assert anon.labels(conv) == conv.anon_map
    loaded = await store.load(conv.id)
    assert loaded is not None and loaded.anon_map == conv.anon_map and tuple(loaded.threads) == council


async def test_create_live_map_is_a_permutation_of_the_council(monkeypatch):
    monkeypatch.setenv("MOCK_OPENROUTER", "0")
    conv = await store.create(slot_config=FIVE)
    assert tuple(conv.anon_map) == LABELS and sorted(conv.anon_map.values()) == sorted(council_of(FIVE))
    conv = await store.create(slot_config=PAIR)
    assert tuple(conv.anon_map) == ("R1", "R2") and set(conv.anon_map.values()) == {"chatgpt", "qwen"}


async def test_create_validates_a_custom_map_against_the_council():
    conv = await store.create(slot_config=PAIR, anon_map={"R2": "chatgpt", "R1": "qwen"})
    assert conv.anon_map == {"R1": "qwen", "R2": "chatgpt"}  # verbatim, keyed in label order
    for bad in (
        {"R1": "claude", "R2": "chatgpt", "R3": "grok"},  # the three, but the council is a pair
        {"R1": "chatgpt", "R2": "chatgpt"},
        {"R1": "chatgpt", "R3": "qwen"},
        {"R1": "chatgpt", "R2": "qwen", "R3": "grok"},
    ):
        with pytest.raises(ValueError):
            await store.create(slot_config=PAIR, anon_map=bad)


# --------------------------------------------------------------------------- update_slot_config
async def test_same_council_replaces_the_config_without_touching_threads_or_map():
    conv = await store.create(slot_config=PAIR)
    await store.append_to_thread(conv.id, "qwen", _msg())
    changed = cfg("chatgpt", "qwen", analyst="ollama:hermes3")
    conv2 = await store.update_slot_config(conv.id, changed)
    assert conv2.slot_config.analyst_model == "ollama:hermes3"
    assert conv2.anon_map == conv.anon_map and len(conv2.threads["qwen"]) == 2


async def test_a_different_council_on_an_empty_conversation_restamps_threads_and_map():
    conv = await store.create(slot_config=PAIR)
    conv2 = await store.update_slot_config(conv.id, FIVE)
    assert tuple(conv2.threads) == council_of(FIVE) and all(v == [] for v in conv2.threads.values())
    assert conv2.anon_map == store.mock_anon_map(council_of(FIVE))
    assert anon.labels(conv2) == conv2.anon_map
    loaded = await store.load(conv.id)
    assert loaded is not None and loaded.anon_map == conv2.anon_map
    # and back down to a pair, still empty
    conv3 = await store.update_slot_config(conv.id, PAIR)
    assert tuple(conv3.threads) == ("chatgpt", "qwen") and conv3.anon_map == {"R1": "chatgpt", "R2": "qwen"}


@pytest.mark.parametrize("said", ["thread", "turn"])
async def test_a_different_council_after_anything_was_said_is_409_council_changed(said, make_conversation):
    conv = await store.create(slot_config=PAIR)
    if said == "thread":
        await store.append_to_thread(conv.id, "chatgpt", _msg())
    else:
        turn = make_conversation(with_send=True).turns[0]
        turn.slot_config = PAIR
        turn.responses = {"chatgpt": "a", "qwen": "b"}
        await store.append_turn(conv.id, turn)
    with pytest.raises(HTTPException) as ei:
        await store.update_slot_config(conv.id, FIVE)
    assert ei.value.status_code == 409
    assert ei.value.detail == {
        "error": "council_changed",
        "current": ["chatgpt", "qwen"],
        "requested": list(council_of(FIVE)),
    }
    loaded = await store.load(conv.id)
    assert loaded is not None and council_of(loaded.slot_config) == ("chatgpt", "qwen")
    assert loaded.anon_map == conv.anon_map


async def test_a_council_change_while_the_conversation_is_busy_is_409_council_changed(
    client, monkeypatch
):
    """A running turn is "something said" even before its first slot_done lands a thread pair:
    the store checks the busy guard, so a PUT during the first Send cannot re-stamp the threads
    and the map under the coordinator (review fix, 2026-09-27)."""
    monkeypatch.setenv("MOCK_DELAY_MS", "100")  # paced replay keeps the send in flight
    conv = await store.create()
    first = asyncio.create_task(
        client.post(f"/api/conversations/{conv.id}/send", json={"prompt": DEFAULT_PROMPT})
    )
    await asyncio.sleep(0.15)
    assert store.is_busy(conv.id)
    assert _is_empty(await store.load(conv.id))  # no pair appended yet: turns/threads alone say "empty"
    with pytest.raises(HTTPException) as ei:
        await store.update_slot_config(conv.id, PAIR)
    assert ei.value.status_code == 409 and ei.value.detail["error"] == "council_changed"
    r = await client.put(f"/api/conversations/{conv.id}/slot_config", json=PAIR.model_dump())
    assert r.status_code == 409 and r.json()["detail"]["error"] == "council_changed"
    loaded = await store.load(conv.id)
    assert loaded is not None and council_of(loaded.slot_config) == DEFAULT_COUNCIL
    assert loaded.anon_map == conv.anon_map and tuple(loaded.threads) == DEFAULT_COUNCIL

    r1 = await first  # the send then finishes on the council it started with
    assert r1.status_code == 200 and "slot_error" not in r1.text
    monkeypatch.setenv("MOCK_DELAY_MS", "0")
    loaded = await store.load(conv.id)
    assert loaded is not None and all(len(v) == 2 for v in loaded.threads.values())
    assert not store.is_busy(conv.id)


async def test_put_slot_config_route_reports_council_changed(client):
    r = await client.post("/api/conversations", json={"slot_config": PAIR.model_dump()})
    cid = r.json()["id"]
    r = await client.put(f"/api/conversations/{cid}/slot_config", json=FIVE.model_dump())
    assert r.status_code == 200 and list(r.json()["slots"]) == list(council_of(FIVE))  # empty: ok
    await store.append_to_thread(cid, "gemini", _msg())
    r = await client.put(f"/api/conversations/{cid}/slot_config", json=PAIR.model_dump())
    assert r.status_code == 409 and r.json()["detail"]["error"] == "council_changed"


# --------------------------------------------------------------------------- append_to_thread
async def test_append_to_a_non_council_slot_is_a_value_error_and_writes_nothing():
    conv = await store.create(slot_config=PAIR)
    with pytest.raises(ValueError, match="council"):
        await store.append_to_thread(conv.id, "grok", _msg())  # a catalog slot, not seated
    with pytest.raises(ValueError, match="unknown slot"):
        await store.append_to_thread(conv.id, "bing", _msg())  # type: ignore[arg-type]
    loaded = await store.load(conv.id)
    assert loaded is not None and tuple(loaded.threads) == ("chatgpt", "qwen")
    assert all(v == [] for v in loaded.threads.values())


# --------------------------------------------------------------------------- files.read_document
async def test_invalid_document_is_a_warning_with_locations_only_and_is_counted(caplog):
    conv = await store.create(slot_config=PAIR)
    path = files.document_path(store._dir(), conv.id)
    doc = json.loads(path.read_text(encoding="utf-8"))
    secret = "THE-USERS-SECRET-PROMPT-TEXT"
    doc["slot_config"]["slots"] = {"chatgpt": doc["slot_config"]["slots"]["chatgpt"]}  # a 1-council
    doc["title"] = secret
    doc["turns"] = [{"type": "send", "prompt": secret}]  # also invalid: no slot_config/responses
    files.write_json_atomic(path, doc)
    before = files.invalid_document_count()
    with caplog.at_level(logging.DEBUG, logger="triplex.store"):
        assert await store.load(conv.id) is None
    assert files.invalid_document_count() == before + 1
    records = [r for r in caplog.records if "conversation document invalid" in r.getMessage()]
    assert len(records) == 1 and records[0].levelno == logging.WARNING
    message = records[0].getMessage()
    assert str(path) in message and "slot_config.slots" in message
    assert secret not in message and "input_value" not in message
    # unreadable JSON stays an ERROR and is not counted as invalid
    path.write_text("{not json", encoding="utf-8")
    with caplog.at_level(logging.DEBUG, logger="triplex.store"):
        assert await store.load(conv.id) is None
    assert files.invalid_document_count() == before + 1
    errors = [r for r in caplog.records if "unreadable" in r.getMessage()]
    assert errors and errors[-1].levelno == logging.ERROR
