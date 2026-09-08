"""Conversation + slot_config endpoints through the ASGI client (docs/api-contract.md)."""

from __future__ import annotations

import asyncio
import uuid

import pytest

from backend.config import DEFAULT_SLOT_CONFIG
from backend.schemas import SLOT_IDS, ModelMeta, SlotConfig
from backend.store import conversations as store
from tests.conftest import DEFAULT_ANON, DEFAULT_PROMPT, DEFAULT_RESPONSES

NOT_FOUND = {"detail": {"error": "not_found", "what": "conversation"}}
PUBLIC_KEYS = {
    "schema_version",
    "id",
    "title",
    "created_at",
    "updated_at",
    "slot_config",
    "threads",
    "turns",
}
SUMMARY_KEYS = {"id", "title", "created_at", "updated_at", "turn_count"}
MISSING = str(uuid.uuid4())


async def _create(client, **body) -> dict:
    r = await client.post("/api/conversations", json=body)
    assert r.status_code == 201, r.text
    return r.json()


def _cfg(**changes) -> dict:
    cfg = DEFAULT_SLOT_CONFIG.model_copy(deep=True)
    for k, v in changes.items():
        setattr(cfg, k, v)
    return cfg.model_dump()


# --------------------------------------------------------------------------- list / create
async def test_list_is_empty_initially(client):
    r = await client.get("/api/conversations")
    assert r.status_code == 200 and r.json() == []


async def test_create_with_empty_body_uses_defaults(client):
    body = await _create(client)
    assert set(body) == PUBLIC_KEYS and "anon_map" not in body
    assert body["title"] == "New conversation" and body["schema_version"] == 1
    assert body["slot_config"] == DEFAULT_SLOT_CONFIG.model_dump()
    assert body["threads"] == {s: [] for s in SLOT_IDS} and body["turns"] == []
    assert uuid.UUID(body["id"]).version == 4 and body["created_at"].endswith("Z")
    assert body["created_at"] == body["updated_at"]
    r = await client.post("/api/conversations")  # no body at all is fine too
    assert r.status_code == 201 and r.json()["title"] == "New conversation"


async def test_create_with_title_and_slot_config(client):
    cfg = _cfg(max_iterations=4, grounded=True)
    cfg["slots"]["chatgpt"]["effort"] = "high"
    body = await _create(client, title="Bench", slot_config=cfg)
    assert body["title"] == "Bench" and body["slot_config"] == cfg
    r = await client.get(f"/api/conversations/{body['id']}/slot_config")
    assert r.status_code == 200 and r.json() == cfg


async def test_create_rejects_a_malformed_slot_config(client):
    r = await client.post(
        "/api/conversations", json={"slot_config": {"slots": {"claude": {"model": "m"}}}}
    )
    assert r.status_code == 422 and isinstance(r.json()["detail"], list)
    r = await client.post("/api/conversations", json={"slot_config": _cfg(max_iterations=6)})
    assert r.status_code == 422 and isinstance(r.json()["detail"], list)
    assert (await client.get("/api/conversations")).json() == []


async def test_list_newest_updated_first_with_summary_shape(client):
    a = await _create(client, title="A")
    await asyncio.sleep(0.002)
    b = await _create(client, title="B")
    r = await client.get("/api/conversations")
    assert [s["id"] for s in r.json()] == [b["id"], a["id"]]
    assert all(set(s) == SUMMARY_KEYS for s in r.json())
    await asyncio.sleep(0.002)
    r = await client.patch(f"/api/conversations/{a['id']}/title", json={"title": "A2"})
    assert r.status_code == 200
    r = await client.get("/api/conversations")
    assert [(s["id"], s["title"], s["turn_count"]) for s in r.json()] == [
        (a["id"], "A2", 0),
        (b["id"], "B", 0),
    ]


# --------------------------------------------------------------------------- get / 404s
async def test_get_conversation_and_404s(client):
    created = await _create(client, title="x")
    r = await client.get(f"/api/conversations/{created['id']}")
    assert r.status_code == 200 and r.json() == created
    for bad in (MISSING, "not-a-uuid", "%2e%2e", str(uuid.uuid1()), created["id"].upper()):
        r = await client.get(f"/api/conversations/{bad}")
        assert r.status_code == 404 and r.json() == NOT_FOUND, bad
        r = await client.get(f"/api/conversations/{bad}/slot_config")
        assert r.status_code == 404 and r.json() == NOT_FOUND, bad
        r = await client.delete(f"/api/conversations/{bad}")
        assert r.status_code == 404 and r.json() == NOT_FOUND, bad
        r = await client.patch(f"/api/conversations/{bad}/title", json={"title": "t"})
        assert r.status_code == 404 and r.json() == NOT_FOUND, bad
        r = await client.put(f"/api/conversations/{bad}/slot_config", json=_cfg())
        assert r.status_code == 404 and r.json() == NOT_FOUND, bad
    r = await client.get("/api/conversations/..%2F..%2Fetc%2Fpasswd")
    assert r.status_code == 404  # a traversal attempt is never a path


# --------------------------------------------------------------------------- delete
async def test_delete_is_204_then_404(client):
    created = await _create(client)
    r = await client.delete(f"/api/conversations/{created['id']}")
    assert r.status_code == 204 and r.content == b""
    r = await client.delete(f"/api/conversations/{created['id']}")
    assert r.status_code == 404 and r.json() == NOT_FOUND
    r = await client.get(f"/api/conversations/{created['id']}")
    assert r.status_code == 404 and r.json() == NOT_FOUND
    assert (await client.get("/api/conversations")).json() == []


# --------------------------------------------------------------------------- title
async def test_rename_validates_1_to_200_chars(client):
    created = await _create(client)
    r = await client.patch(f"/api/conversations/{created['id']}/title", json={"title": "x" * 200})
    assert r.status_code == 200 and r.json()["title"] == "x" * 200
    assert set(r.json()) == PUBLIC_KEYS and r.json()["id"] == created["id"]
    for bad in ({"title": ""}, {"title": "x" * 201}, {}, {"title": None}):
        r = await client.patch(f"/api/conversations/{created['id']}/title", json=bad)
        assert r.status_code == 422 and isinstance(r.json()["detail"], list), bad
    r = await client.get(f"/api/conversations/{created['id']}")
    assert r.json()["title"] == "x" * 200


# --------------------------------------------------------------------------- slot_config
async def test_slot_config_get_and_put_replace(client):
    created = await _create(client)
    r = await client.get(f"/api/conversations/{created['id']}/slot_config")
    assert r.status_code == 200 and r.json() == DEFAULT_SLOT_CONFIG.model_dump()

    cfg = _cfg(max_iterations=5, materiality_min="high", analyst_model="anthropic/claude-sonnet-5")
    cfg["slots"]["grok"] = {"model": "x-ai/grok-4.3", "effort": "low"}
    r = await client.put(f"/api/conversations/{created['id']}/slot_config", json=cfg)
    assert r.status_code == 200
    assert r.json() == cfg, "PUT returns the stored SlotConfig, not the conversation"
    assert set(r.json()) == set(SlotConfig.model_fields)
    r = await client.get(f"/api/conversations/{created['id']}/slot_config")
    assert r.json() == cfg
    r = await client.get(f"/api/conversations/{created['id']}")
    assert r.json()["slot_config"] == cfg and r.json()["updated_at"] >= created["updated_at"]

    for bad in (
        {"slots": {"claude": {"model": "m"}}, "analyst_model": "a"},  # slots missing
        {"slots": cfg["slots"]},  # analyst_model missing
        _cfg(max_iterations=0),
        {**cfg, "slots": {**cfg["slots"], "grok": {"model": "m", "effort": "max"}}},
    ):
        r = await client.put(f"/api/conversations/{created['id']}/slot_config", json=bad)
        assert r.status_code == 422 and isinstance(r.json()["detail"], list), bad
    r = await client.get(f"/api/conversations/{created['id']}/slot_config")
    assert r.json() == cfg, "a rejected PUT leaves the stored config untouched"


async def test_put_slot_config_unsupported_effort_422(client, monkeypatch):
    grok = DEFAULT_SLOT_CONFIG.slots["grok"].model
    metas = {grok: ModelMeta(id=grok, efforts=["low", "medium", "high"], mandatory_reasoning=True)}
    monkeypatch.setattr("backend.llm.catalog.get_meta", lambda model: metas.get(model))
    created = await _create(client)
    cfg = _cfg()
    cfg["slots"]["grok"]["effort"] = "off"
    r = await client.put(f"/api/conversations/{created['id']}/slot_config", json=cfg)
    assert r.status_code == 422
    assert r.json() == {
        "detail": {
            "error": "unsupported_effort",
            "slot": "grok",
            "model": grok,
            "effort": "off",
            "supported": ["low", "medium", "high"],
        }
    }
    r = await client.get(f"/api/conversations/{created['id']}/slot_config")
    assert r.json() == DEFAULT_SLOT_CONFIG.model_dump(), "nothing stored"

    cfg["slots"]["grok"]["effort"] = "high"  # supported -> stored
    cfg["slots"]["claude"] = {
        "model": "anthropic/unknown-model",
        "effort": "off",
    }  # unknown -> pass
    r = await client.put(f"/api/conversations/{created['id']}/slot_config", json=cfg)
    assert r.status_code == 200 and r.json() == cfg

    # A missing conversation is a 404 even with an unsupported effort (404 before 422).
    cfg["slots"]["grok"]["effort"] = "off"
    r = await client.put(f"/api/conversations/{MISSING}/slot_config", json=cfg)
    assert r.status_code == 404 and r.json() == NOT_FOUND


async def test_put_slot_config_with_stub_catalog_passes(client, monkeypatch):
    def not_ready(model: str):
        raise NotImplementedError("W1 not landed")

    monkeypatch.setattr("backend.llm.catalog.get_meta", not_ready)
    created = await _create(client)
    cfg = _cfg()
    cfg["slots"]["grok"]["effort"] = "off"
    r = await client.put(f"/api/conversations/{created['id']}/slot_config", json=cfg)
    assert r.status_code == 200 and r.json()["slots"]["grok"]["effort"] == "off"


# --------------------------------------------------------------------------- anonymization
@pytest.mark.parametrize("anon", [DEFAULT_ANON, {"R1": "grok", "R2": "claude", "R3": "chatgpt"}])
async def test_anon_map_never_appears_in_any_response(client, make_conversation, anon):
    src = make_conversation(anon=anon)
    conv = await store.create(slot_config=src.slot_config, title=src.title, anon_map=src.anon_map)
    for slot, msgs in src.threads.items():
        await store.append_to_thread(conv.id, slot, msgs)
    await store.append_turn(conv.id, src.turns[0])
    responses = [
        await client.get("/api/conversations"),
        await client.get(f"/api/conversations/{conv.id}"),
        await client.patch(f"/api/conversations/{conv.id}/title", json={"title": "renamed"}),
        await client.get(f"/api/conversations/{conv.id}/slot_config"),
        await client.put(f"/api/conversations/{conv.id}/slot_config", json=_cfg()),
        await client.post("/api/conversations", json={}),
    ]
    for r in responses:
        assert r.status_code in (200, 201)
        assert "anon_map" not in r.text and "R1" not in r.text and "R2" not in r.text
    assert (await store.load(conv.id)).anon_map == anon, "still persisted server-side"


async def test_persisted_conversation_is_served_by_the_api(client, persisted_conversation):
    conv = persisted_conversation
    r = await client.get(f"/api/conversations/{conv.id}")
    assert r.status_code == 200
    body = r.json()
    assert body["title"] == "Test conversation" and "anon_map" not in body
    assert len(body["turns"]) == 1 and body["turns"][0]["type"] == "send"
    assert body["turns"][0]["prompt"] == DEFAULT_PROMPT
    assert body["turns"][0]["responses"] == DEFAULT_RESPONSES
    for slot in SLOT_IDS:
        assert [m["content"] for m in body["threads"][slot]] == [
            DEFAULT_PROMPT,
            DEFAULT_RESPONSES[slot],
        ]
    r = await client.get("/api/conversations")
    assert [(s["id"], s["turn_count"]) for s in r.json()] == [(conv.id, 1)]
