"""Grounded mode hardening (PLAN.md Phase 5 / R6): citations from `delta.annotations` on any
chunk AND from `message.annotations` on the usage chunk are captured, de-duplicated by URL and
persisted per slot on the SendTurn and on a ContinueTurn; the grounded flag is the CONVERSATION's
(`GROUNDED_DEFAULT` only seeds it) and the plugin never reaches an ungrounded request."""

from __future__ import annotations

from pathlib import Path

from backend.config import DEFAULT_SLOT_CONFIG
from backend.llm import mock
from backend.schemas import SLOT_IDS
from tests.send.conftest import assert_stream_invariants, for_slot, of_type, one, slot_text

SEND_FIXTURES = Path(__file__).resolve().parent / "fixtures"
DATASHEET = "https://example.com/bmi088/datasheet.pdf"
PRODUCT = "https://example.com/bmi088/product"
GROUNDED_URLS = [
    "https://www.bosch-sensortec.com/media/boschsensortec/downloads/datasheets/bst-bmi088-ds001.pdf",
    "https://www.bosch-sensortec.com/products/motion-sensors/imus/bmi088/",
]


def _urls(items: list[dict]) -> list[str]:
    return [i["url_citation"]["url"] for i in items]


async def test_citations_from_delta_and_usage_chunk_are_deduplicated_per_slot(
    new_conv, send, get_conv, monkeypatch
):
    monkeypatch.setenv("MOCK_FIXTURES_DIR", str(SEND_FIXTURES))
    monkeypatch.setenv("MOCK_SCENARIO", "grounded_dupes")
    cfg = DEFAULT_SLOT_CONFIG.model_copy(deep=True)
    cfg.grounded = True
    conv = await new_conv(slot_config=cfg.model_dump())
    events = await send(conv["id"], "Where is the BMI088 gyro range documented?")
    assert_stream_invariants(events)
    assert [c["fixture"] for c in mock.calls] == [
        f"grounded_dupes/{s}.chat.1.jsonl" for s in SLOT_IDS
    ]
    assert all(c["plugins"] == [{"id": "web", "max_results": 5}] for c in mock.calls)

    cites = [e for e in of_type(events, "slot_citations") if e["slot"] == "claude"]
    # chunk 2 -> datasheet; chunk 3 repeats it -> no event; usage chunk -> product only
    assert [_urls(e["items"]) for e in cites] == [[DATASHEET], [PRODUCT]]
    assert cites[0]["items"][0]["url_citation"]["title"] == "Datasheet"  # first occurrence kept
    assert cites[1]["items"][0]["url_citation"]["title"] == "Product page (usage chunk only)"
    kinds = [e["type"] for e in for_slot(events, "claude")]
    assert kinds[-1] == "slot_done" and kinds[-2] == "slot_citations"  # usage-chunk citations first
    assert not [e for e in of_type(events, "slot_citations") if e["slot"] != "claude"]
    assert (
        slot_text(events, "claude")
        == "Per the datasheet (BST-BMI088-DS001) the range is 2000 deg/s."
    )

    stored = await get_conv(conv["id"])
    turn = stored["turns"][0]
    assert list(turn["citations"]) == ["claude"]
    assert _urls(turn["citations"]["claude"]) == [DATASHEET, PRODUCT]
    assert [i["type"] for i in turn["citations"]["claude"]] == ["url_citation", "url_citation"]
    assert turn["citations"]["claude"][0]["url_citation"]["start_index"] == 18  # verbatim object
    assert turn["responses"]["claude"] == slot_text(events, "claude")
    for slot in SLOT_IDS:  # never in threads
        for m in stored["threads"][slot]:
            assert "annotations" not in m["content"] and set(m) == {
                "role",
                "content",
                "kind",
                "turn_id",
                "ts",
                "meta",
            }


async def test_continue_persists_citations_on_the_continue_turn(
    new_conv, send, cont, get_conv, monkeypatch
):
    monkeypatch.setenv("MOCK_SCENARIO", "grounded")
    cfg = DEFAULT_SLOT_CONFIG.model_copy(deep=True)
    cfg.grounded = True
    conv = await new_conv(slot_config=cfg.model_dump())
    await send(conv["id"], "Zero-rate offset of the BMI088 gyro?")
    mock.reset()
    events = await cont(conv["id"], "claude", "And where exactly is it documented?")
    assert_stream_invariants(events, slots=("claude",))
    assert mock.calls[-1]["fixture"] == "grounded/claude.chat.1.jsonl"  # sticky-last
    assert mock.calls[-1]["plugins"] == [{"id": "web", "max_results": 5}]
    cites = [e for e in of_type(events, "slot_citations") if e["slot"] == "claude"]
    assert [_urls(e["items"]) for e in cites] == [[GROUNDED_URLS[0]], [GROUNDED_URLS[1]]]
    assert one(events, "slot_done", "claude")["usage"]["cost_usd"] > 0

    stored = await get_conv(conv["id"])
    t = stored["turns"][1]
    assert t["type"] == "continue" and t["slot"] == "claude"
    assert _urls(t["citations"]) == GROUNDED_URLS
    assert t["citations"][0]["url_citation"]["title"].startswith("BMI088 Datasheet")
    assert t["reasoning"].startswith("Search result: BMI088 datasheet")
    assert t["slot_config"]["grounded"] is True
    assert [m["role"] for m in stored["threads"]["claude"]] == ["user", "assistant"] * 2
    assert stored["threads"]["chatgpt"] == stored["threads"]["chatgpt"][:2]  # untouched


async def test_grounded_default_seeds_new_conversations_and_the_toggle_is_per_conversation(
    client, new_conv, send, get_conv, monkeypatch
):
    monkeypatch.setenv("MOCK_SCENARIO", "grounded")
    monkeypatch.setenv("GROUNDED_DEFAULT", "1")
    seeded = await new_conv()
    assert seeded["slot_config"]["grounded"] is True
    await send(seeded["id"], "Grounded by default")
    assert all(c["plugins"] == [{"id": "web", "max_results": 5}] for c in mock.calls[:3])

    # switching the conversation off wins over the env default ...
    cfg = (await get_conv(seeded["id"]))["slot_config"]
    cfg["grounded"] = False
    r = await client.put(f"/api/conversations/{seeded['id']}/slot_config", json=cfg)
    assert r.status_code == 200 and r.json()["grounded"] is False
    mock.reset()
    await send(seeded["id"], "Now ungrounded")
    assert all(c["plugins"] is None for c in mock.calls)
    stored = await get_conv(seeded["id"])
    assert [t["slot_config"]["grounded"] for t in stored["turns"]] == [True, False]

    # ... and an env change after creation never leaks into an existing conversation
    monkeypatch.setenv("GROUNDED_DEFAULT", "0")
    mock.reset()
    cfg["grounded"] = True
    r = await client.put(f"/api/conversations/{seeded['id']}/slot_config", json=cfg)
    assert r.status_code == 200
    await send(seeded["id"], "Grounded again")
    assert all(c["plugins"] == [{"id": "web", "max_results": 5}] for c in mock.calls)
    fresh = await new_conv()
    assert fresh["slot_config"]["grounded"] is False
