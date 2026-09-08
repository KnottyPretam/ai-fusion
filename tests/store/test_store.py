"""backend/store/conversations.py: persistence semantics (PLAN.md §5 store, §9 thread bookkeeping)."""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import uuid

import pytest
from fastapi import HTTPException
from hypothesis import HealthCheck, given
from hypothesis import settings as h_settings
from hypothesis import strategies as st
from pydantic import ValidationError

from backend.config import DEFAULT_SLOT_CONFIG, settings
from backend.schemas import (
    LABELS,
    SLOT_IDS,
    ContinueTurn,
    SendTurn,
    ThreadMessage,
)
from backend.store import conversations as store
from backend.store import files, index
from tests.conftest import DEFAULT_ANON, DEFAULT_PROMPT, DEFAULT_RESPONSES

NOT_FOUND = {"error": "not_found", "what": "conversation"}
BAD_IDS = [
    "not-a-uuid",
    "",
    "..",
    "../../etc/passwd",
    "/etc/passwd",
    "_index",
    str(uuid.uuid1()),  # a UUID, but not version 4
    str(uuid.uuid4()).upper(),  # not the canonical lowercase form the store mints
    "{" + str(uuid.uuid4()) + "}",
    "urn:uuid:" + str(uuid.uuid4()),
]


def _pair(slot: str, turn_id: str, n: int = 0) -> list[ThreadMessage]:
    return [
        ThreadMessage(role="user", content=f"q-{slot}-{n}", turn_id=turn_id),
        ThreadMessage(role="assistant", content=f"a-{slot}-{n}", turn_id=turn_id),
    ]


def _send_turn(conv, prompt: str = DEFAULT_PROMPT) -> SendTurn:
    return SendTurn(prompt=prompt, responses=dict(DEFAULT_RESPONSES), slot_config=conv.slot_config)


def _thread_json(conv, slot: str) -> str:
    return json.dumps([m.model_dump() for m in conv.threads[slot]], sort_keys=True)


# --------------------------------------------------------------------------- create
async def test_create_defaults_and_document_layout(conv_dir):
    conv = await store.create()
    assert conv.title == "New conversation"
    assert conv.schema_version == 1 and files.is_uuid4(conv.id)
    assert conv.turns == [] and conv.threads == {s: [] for s in SLOT_IDS}
    assert conv.created_at.endswith("Z") and conv.updated_at == conv.created_at
    path = conv_dir() / f"{conv.id}.json"
    assert path.is_file(), "one document per conversation under <DATA_DIR>/conversations/"
    doc = json.loads(path.read_text(encoding="utf-8"))
    assert doc["id"] == conv.id and doc["schema_version"] == 1
    assert doc["anon_map"] == DEFAULT_ANON, "the map is persisted server-side"


async def test_create_stamps_mock_anon_map_in_mock_mode():
    assert settings().mock_openrouter
    conv = await store.create()
    assert conv.anon_map == store.MOCK_ANON_MAP == DEFAULT_ANON
    assert conv.anon_map is not store.MOCK_ANON_MAP, "never alias the module constant"
    assert (await store.load(conv.id)).anon_map == DEFAULT_ANON


async def test_create_stamps_random_permutation_live(monkeypatch):
    monkeypatch.setenv("MOCK_OPENROUTER", "0")
    seen = set()
    for _ in range(40):
        conv = await store.create()
        assert tuple(conv.anon_map) == LABELS
        assert sorted(conv.anon_map.values()) == sorted(SLOT_IDS)
        seen.add(tuple(conv.anon_map.values()))
    assert len(seen) > 1, "live mode shuffles (40 draws from 6 permutations never all equal)"


async def test_create_with_custom_anon_map_is_validated_and_stamped_verbatim():
    custom = {"R1": "grok", "R2": "claude", "R3": "chatgpt"}
    conv = await store.create(anon_map=custom)
    assert conv.anon_map == custom and conv.anon_map is not custom
    assert (await store.load(conv.id)).anon_map == custom
    shuffled_keys = {"R3": "chatgpt", "R1": "grok", "R2": "claude"}  # key order is irrelevant
    conv2 = await store.create(anon_map=shuffled_keys)
    assert conv2.anon_map == custom and tuple(conv2.anon_map) == LABELS
    for bad in (
        {"R1": "claude", "R2": "claude", "R3": "grok"},  # not a permutation
        {"R1": "claude", "R2": "chatgpt"},  # label missing
        {"R1": "claude", "R2": "chatgpt", "R3": "gemini"},  # unknown slot
        {"R1": "claude", "R2": "chatgpt", "R3": "grok", "R4": "grok"},  # extra label
    ):
        with pytest.raises(ValueError):
            await store.create(anon_map=bad)  # type: ignore[arg-type]


async def test_created_conversations_never_share_slot_config_identity():
    a = await store.create()
    b = await store.create(slot_config=DEFAULT_SLOT_CONFIG)  # even when handed the singleton
    assert a.slot_config == b.slot_config == DEFAULT_SLOT_CONFIG
    assert a.slot_config is not b.slot_config
    assert a.slot_config is not DEFAULT_SLOT_CONFIG and b.slot_config is not DEFAULT_SLOT_CONFIG
    assert b.slot_config.slots["claude"] is not DEFAULT_SLOT_CONFIG.slots["claude"]
    la, lb = await store.load(a.id), await store.load(b.id)
    assert la.slot_config is not lb.slot_config
    la.slot_config.slots["claude"].effort = "off"  # mutating a loaded copy touches nothing else
    assert DEFAULT_SLOT_CONFIG.slots["claude"].effort == "medium"
    assert (await store.load(a.id)).slot_config.slots["claude"].effort == "medium"


async def test_create_uses_env_overridden_defaults_not_the_singleton(monkeypatch):
    monkeypatch.setenv("SLOT_GROK_EFFORT", "off")
    monkeypatch.setenv("ANALYST_MODEL", "anthropic/claude-sonnet-5")
    conv = await store.create()
    assert conv.slot_config.slots["grok"].effort == "off"
    assert conv.slot_config.analyst_model == "anthropic/claude-sonnet-5"
    assert DEFAULT_SLOT_CONFIG.slots["grok"].effort == "medium"


async def test_create_title_and_explicit_config():
    cfg = DEFAULT_SLOT_CONFIG.model_copy(deep=True)
    cfg.max_iterations = 5
    cfg.slots["chatgpt"].model = "openai/gpt-6-astra"
    conv = await store.create(slot_config=cfg, title="Bench run 1")
    assert conv.title == "Bench run 1"
    assert conv.slot_config == cfg and conv.slot_config is not cfg
    cfg.max_iterations = 1  # the caller's object is not the stored one
    assert (await store.load(conv.id)).slot_config.max_iterations == 5


# --------------------------------------------------------------------------- load / ids
async def test_load_missing_uuid_is_none():
    assert await store.load(str(uuid.uuid4())) is None


@pytest.mark.parametrize("bad", BAD_IDS)
async def test_non_uuid4_ids_are_missing_never_paths(bad, tmp_path):
    assert await store.load(bad) is None
    assert await store.delete(bad) is False
    for call in (store.rename(bad, "x"), store.update_slot_config(bad, DEFAULT_SLOT_CONFIG)):
        with pytest.raises(HTTPException) as ei:
            await call
        assert ei.value.status_code == 404 and ei.value.detail == NOT_FOUND
    with pytest.raises(HTTPException):
        await store.append_to_thread(bad, "claude", _pair("claude", "t"))
    with pytest.raises(HTTPException):
        await store.append_turn(
            bad, ContinueTurn(slot="grok", prompt="p", slot_config=DEFAULT_SLOT_CONFIG)
        )
    data_dir = settings().data_dir
    assert not data_dir.exists() or list(data_dir.rglob("*")) == [], "nothing touched disk"


@given(st.text())
@h_settings(
    max_examples=200, deadline=None, suppress_health_check=[HealthCheck.function_scoped_fixture]
)
def test_fuzz_arbitrary_ids_never_resolve_to_a_file(s: str):
    if files.is_uuid4(s):
        assert s == str(uuid.UUID(s)) and uuid.UUID(s).version == 4
    else:
        with pytest.raises(ValueError):
            files.document_path(settings().data_dir / "conversations", s)
        assert asyncio.run(store.load(s)) is None
        assert not settings().data_dir.exists()


@given(st.uuids(version=4))
@h_settings(max_examples=50, deadline=None)
def test_fuzz_uuid4_strings_are_accepted(u: uuid.UUID):
    assert files.is_uuid4(str(u))
    assert not files.is_uuid4(str(u).upper()) or str(u).upper() == str(u)


async def test_load_corrupt_document_is_reported_missing(conv_dir, caplog):
    conv = await store.create()
    (conv_dir() / f"{conv.id}.json").write_text("{not json", encoding="utf-8")
    assert await store.load(conv.id) is None
    assert any("unreadable" in r.message for r in caplog.records)
    (conv_dir() / f"{conv.id}.json").write_text(json.dumps({"id": conv.id}), encoding="utf-8")
    assert await store.load(conv.id) is None


# --------------------------------------------------------------------------- list / rename / update / delete
async def test_list_rename_update_delete_roundtrip():
    a = await store.create(title="A")
    await asyncio.sleep(0.002)
    b = await store.create(title="B")
    assert [s.id for s in await store.list_summaries()] == [b.id, a.id], "newest updated_at first"

    await asyncio.sleep(0.002)
    a2 = await store.rename(a.id, "A renamed")
    assert (
        a2.title == "A renamed" and a2.updated_at > a.updated_at and a2.created_at == a.created_at
    )
    summaries = await store.list_summaries()
    assert [(s.id, s.title) for s in summaries] == [(a.id, "A renamed"), (b.id, "B")]
    assert summaries[0].model_dump() == {
        "id": a.id,
        "title": "A renamed",
        "created_at": a.created_at,
        "updated_at": a2.updated_at,
        "turn_count": 0,
    }

    cfg = DEFAULT_SLOT_CONFIG.model_copy(deep=True)
    cfg.max_iterations = 5
    cfg.slots["grok"].effort = "high"
    cfg.grounded = True
    a3 = await store.update_slot_config(a.id, cfg)
    assert a3.slot_config == cfg and a3.slot_config is not cfg, "replaced by a fresh copy"
    cfg.max_iterations = 1
    loaded = await store.load(a.id)
    assert loaded.slot_config.max_iterations == 5 and loaded.slot_config.grounded is True
    assert loaded.title == "A renamed", "update_slot_config touches only the config"

    assert await store.delete(a.id) is True
    assert await store.load(a.id) is None
    assert await store.delete(a.id) is False
    assert [s.id for s in await store.list_summaries()] == [b.id]
    with pytest.raises(HTTPException) as ei:
        await store.rename(a.id, "gone")
    assert ei.value.status_code == 404 and ei.value.detail == NOT_FOUND
    with pytest.raises(HTTPException) as ei:
        await store.update_slot_config(a.id, DEFAULT_SLOT_CONFIG)
    assert ei.value.status_code == 404 and ei.value.detail == NOT_FOUND


async def test_update_slot_config_validates_before_touching_the_document():
    conv = await store.create()
    before = (await store.load(conv.id)).updated_at
    with pytest.raises(ValidationError):
        await store.update_slot_config(
            conv.id,
            {"slots": {"claude": {"model": "m"}}, "analyst_model": "a"},  # type: ignore[arg-type]
        )
    with pytest.raises(ValidationError):
        await store.update_slot_config(
            conv.id, DEFAULT_SLOT_CONFIG.model_copy(update={"max_iterations": 9}).model_dump()
        )  # type: ignore[arg-type]
    after = await store.load(conv.id)
    assert after.slot_config == DEFAULT_SLOT_CONFIG and after.updated_at == before


async def test_list_is_empty_without_a_data_dir():
    assert not settings().data_dir.exists()
    assert await store.list_summaries() == []
    assert not settings().data_dir.exists(), "listing never creates anything"


# --------------------------------------------------------------------------- appends
async def test_append_to_thread_and_turn_bump_updated_at_and_index():
    conv = await store.create()
    t0 = conv.updated_at
    await asyncio.sleep(0.002)
    await store.append_to_thread(conv.id, "claude", _pair("claude", "t1"))
    c1 = await store.load(conv.id)
    assert c1.updated_at > t0 and [m.content for m in c1.threads["claude"]] == [
        "q-claude-0",
        "a-claude-0",
    ]
    assert c1.threads["chatgpt"] == [] and c1.threads["grok"] == []
    await asyncio.sleep(0.002)
    turn = _send_turn(conv)
    await store.append_turn(conv.id, turn)
    c2 = await store.load(conv.id)
    assert c2.updated_at > c1.updated_at
    assert [t.id for t in c2.turns] == [turn.id] and c2.turns[0].type == "send"
    assert c2.turns[0].responses == DEFAULT_RESPONSES
    summary = (await store.list_summaries())[0]
    assert summary.turn_count == 1 and summary.updated_at == c2.updated_at


async def test_append_turn_rejects_duplicate_ids_and_never_assigns_them():
    conv = await store.create()
    turn = _send_turn(conv)
    await store.append_turn(conv.id, turn)
    with pytest.raises(ValueError, match="duplicate turn id"):
        await store.append_turn(conv.id, turn)
    clash = ContinueTurn(id=turn.id, slot="grok", prompt="p", slot_config=conv.slot_config)
    with pytest.raises(ValueError, match="duplicate turn id"):
        await store.append_turn(conv.id, clash)
    other = ContinueTurn(slot="grok", prompt="p", response="r", slot_config=conv.slot_config)
    await store.append_turn(conv.id, other.model_dump())  # a dumped turn is accepted too
    got = await store.load(conv.id)
    assert [t.id for t in got.turns] == [turn.id, other.id], "ids are the caller's, verbatim"
    assert got.turns[1].type == "continue" and got.turns[1].slot == "grok"


async def test_append_rejects_unknown_slot_and_missing_conversation():
    conv = await store.create()
    with pytest.raises(ValueError):
        await store.append_to_thread(conv.id, "gemini", _pair("gemini", "t"))  # type: ignore[arg-type]
    missing = str(uuid.uuid4())
    with pytest.raises(HTTPException) as ei:
        await store.append_to_thread(missing, "claude", _pair("claude", "t"))
    assert ei.value.status_code == 404 and ei.value.detail == NOT_FOUND
    with pytest.raises(HTTPException) as ei:
        await store.append_turn(missing, _send_turn(conv))
    assert ei.value.status_code == 404


async def test_append_batch_is_atomic_user_and_assistant_together():
    conv = await store.create()
    msgs = [
        ThreadMessage(role="user", content="q", turn_id="t"),
        ThreadMessage(
            role="assistant",
            content='{"stance":"defend"}',
            kind="fusion_reply",
            turn_id="t",
            meta={"divergence_id": "d1", "round": 1},
        ),
    ]
    await store.append_to_thread(conv.id, "chatgpt", msgs)
    got = await store.load(conv.id)
    assert [m.model_dump() for m in got.threads["chatgpt"]] == [m.model_dump() for m in msgs]


async def test_concurrent_appends_lose_nothing(monkeypatch):
    """3 concurrent append_to_thread on different slots + 3 concurrent append_turn. A real
    suspension point is injected between the read and the write of every read-modify-write so
    an unlocked store would clobber; the per-id lock must serialize them."""
    conv = await store.create()
    real_persist = store._persist

    async def slow_persist(c):
        await asyncio.sleep(0.001)
        await real_persist(c)

    monkeypatch.setattr(store, "_persist", slow_persist)
    turns = [_send_turn(conv, prompt=f"p{i}") for i in range(3)]
    await asyncio.gather(
        *(store.append_to_thread(conv.id, s, _pair(s, "t1")) for s in SLOT_IDS),
        *(store.append_turn(conv.id, t) for t in turns),
    )
    got = await store.load(conv.id)
    for s in SLOT_IDS:
        assert [m.content for m in got.threads[s]] == [f"q-{s}-0", f"a-{s}-0"]
    assert sorted(t.id for t in got.turns) == sorted(t.id for t in turns)
    assert (await store.list_summaries())[0].turn_count == 3


async def test_untouched_threads_are_byte_identical_after_appends_to_another_slot(conv_dir):
    conv = await store.create()
    for s in SLOT_IDS:
        await store.append_to_thread(conv.id, s, _pair(s, "t0"))
    before = await store.load(conv.id)
    before_json = {s: _thread_json(before, s) for s in ("chatgpt", "grok")}
    raw_before = json.loads((conv_dir() / f"{conv.id}.json").read_text(encoding="utf-8"))
    for n in range(1, 4):  # rabbit-hole one slot >= 3 turns (spec §8 Phase 2 AC)
        await store.append_to_thread(conv.id, "claude", _pair("claude", f"t{n}", n))
    after = await store.load(conv.id)
    raw_after = json.loads((conv_dir() / f"{conv.id}.json").read_text(encoding="utf-8"))
    assert len(after.threads["claude"]) == 8
    for s in ("chatgpt", "grok"):
        assert _thread_json(after, s) == before_json[s]
        assert raw_after["threads"][s] == raw_before["threads"][s]
    assert raw_after["anon_map"] == raw_before["anon_map"]


# --------------------------------------------------------------------------- atomic writes
async def test_atomic_write_leaves_no_partial_file_on_failure(conv_dir, monkeypatch):
    conv = await store.create()
    real_replace = os.replace
    state = {"fail": True}

    def flaky_replace(src, dst):
        if state["fail"]:
            state["fail"] = False
            raise OSError("simulated disk full during rename")
        return real_replace(src, dst)

    monkeypatch.setattr(files.os, "replace", flaky_replace)
    with pytest.raises(OSError):
        await store.rename(conv.id, "crashed")
    assert not list(conv_dir().glob("*.tmp")), "tmp file cleaned up"
    doc = json.loads((conv_dir() / f"{conv.id}.json").read_text(encoding="utf-8"))
    assert doc["title"] == "New conversation", "target untouched by the failed write"
    assert (await store.load(conv.id)).title == "New conversation"
    assert [s.title for s in await store.list_summaries()] == ["New conversation"]

    real_fsync = os.fsync

    def failing_fsync(fd):
        raise OSError("simulated fsync failure")

    monkeypatch.setattr(files.os, "fsync", failing_fsync)
    with pytest.raises(OSError):
        await store.rename(conv.id, "crashed again")
    assert not list(conv_dir().glob("*.tmp"))
    # Restore explicitly (monkeypatch.undo() would also undo the autouse DATA_DIR patch).
    monkeypatch.setattr(files.os, "replace", real_replace)
    monkeypatch.setattr(files.os, "fsync", real_fsync)
    renamed = await store.rename(conv.id, "recovered")
    assert renamed.title == "recovered"
    assert sorted(p.name for p in conv_dir().iterdir()) == sorted(
        [f"{conv.id}.json", index.INDEX_FILENAME]
    )


async def test_every_write_is_a_fresh_tmp_then_replace(conv_dir, monkeypatch):
    seen: list[tuple[str, str]] = []
    real_replace = os.replace

    def spy(src, dst):
        seen.append((os.fspath(src), os.fspath(dst)))
        return real_replace(src, dst)

    monkeypatch.setattr(files.os, "replace", spy)
    conv = await store.create()
    await store.append_turn(conv.id, _send_turn(conv))
    doc = str(conv_dir() / f"{conv.id}.json")
    idx = str(conv_dir() / index.INDEX_FILENAME)
    assert [dst for _, dst in seen] == [doc, idx, doc, idx]
    for src, dst in seen:
        assert src.endswith(".tmp") and os.path.dirname(src) == os.path.dirname(dst)
    assert not list(conv_dir().glob("*.tmp"))


# --------------------------------------------------------------------------- index
async def test_index_is_a_sidecar_that_lists_newest_first_and_survives_delete(
    conv_dir, monkeypatch
):
    ids = []
    for i in range(3):
        ids.append((await store.create(title=f"c{i}")).id)
        await asyncio.sleep(0.002)
    idx_path = conv_dir() / index.INDEX_FILENAME
    assert idx_path.is_file()
    raw = json.loads(idx_path.read_text(encoding="utf-8"))
    assert raw["schema_version"] == 1 and [e["id"] for e in raw["conversations"]] == ids
    assert [s.id for s in await store.list_summaries()] == ids[::-1]

    assert await store.delete(ids[1]) is True
    assert [s.id for s in await store.list_summaries()] == [ids[2], ids[0]]
    raw = json.loads(idx_path.read_text(encoding="utf-8"))
    assert [e["id"] for e in raw["conversations"]] == [ids[0], ids[2]]

    conv = await store.load(ids[0])
    await store.append_turn(ids[0], _send_turn(conv))
    listed = await store.list_summaries()
    assert [(s.id, s.turn_count) for s in listed] == [(ids[0], 1), (ids[2], 0)]

    # Listing is served from the index: no document is parsed when the index is complete.
    def boom(path):
        raise AssertionError(f"list_summaries parsed a document: {path}")

    monkeypatch.setattr(files, "read_document", boom)
    assert [s.id for s in await store.list_summaries()] == [ids[0], ids[2]]


async def test_index_reconciles_with_the_directory(conv_dir):
    a = await store.create(title="a")
    await asyncio.sleep(0.002)
    b = await store.create(title="b")
    idx_path = conv_dir() / index.INDEX_FILENAME

    idx_path.unlink()  # lost index -> rebuilt once from the documents, then maintained again
    assert [s.id for s in await store.list_summaries()] == [b.id, a.id]
    assert idx_path.is_file()

    stray = str(uuid.uuid4())  # a document that appeared without going through the store
    src = json.loads((conv_dir() / f"{a.id}.json").read_text(encoding="utf-8"))
    src["id"] = stray
    src["title"] = "stray"
    src["updated_at"] = "2099-01-01T00:00:00.000Z"
    (conv_dir() / f"{stray}.json").write_text(json.dumps(src), encoding="utf-8")
    (conv_dir() / "notes.json").write_text("{}", encoding="utf-8")  # non-uuid strays are ignored
    (conv_dir() / f"{b.id}.json").unlink()  # a document removed behind the store's back
    listed = await store.list_summaries()
    assert [(s.id, s.title) for s in listed] == [(stray, "stray"), (a.id, "a")]
    assert (await store.load(stray)).title == "stray"

    idx_path.write_text("garbage", encoding="utf-8")  # corrupt index -> rebuilt
    assert [s.id for s in await store.list_summaries()] == [stray, a.id]


async def test_no_process_level_cache_across_data_dirs(monkeypatch, tmp_path):
    conv = await store.create(title="first dir")
    first_dir = settings().data_dir
    monkeypatch.setenv("DATA_DIR", str(tmp_path / "other"))
    assert await store.load(conv.id) is None
    assert await store.list_summaries() == []
    other = await store.create(title="second dir")
    assert [s.id for s in await store.list_summaries()] == [other.id]
    monkeypatch.setenv("DATA_DIR", str(first_dir))
    assert (await store.load(conv.id)).title == "first dir"
    assert [s.id for s in await store.list_summaries()] == [conv.id]
    shutil.rmtree(first_dir)
    assert await store.load(conv.id) is None and await store.list_summaries() == []


# --------------------------------------------------------------------------- shared fixture
async def test_persisted_conversation_fixture_roundtrips(persisted_conversation):
    conv = persisted_conversation
    assert conv.title == "Test conversation" and conv.anon_map == DEFAULT_ANON
    assert len(conv.turns) == 1 and conv.turns[0].type == "send"
    assert conv.turns[0].prompt == DEFAULT_PROMPT and conv.turns[0].responses == DEFAULT_RESPONSES
    for slot in SLOT_IDS:
        msgs = conv.threads[slot]
        assert [m.role for m in msgs] == ["user", "assistant"]
        assert msgs[0].content == DEFAULT_PROMPT and msgs[1].content == DEFAULT_RESPONSES[slot]
        assert {m.turn_id for m in msgs} == {conv.turns[0].id}
    again = await store.load(conv.id)
    assert again.model_dump() == conv.model_dump()
    summary = (await store.list_summaries())[0]
    assert summary.id == conv.id and summary.turn_count == 1 and summary.title == conv.title
