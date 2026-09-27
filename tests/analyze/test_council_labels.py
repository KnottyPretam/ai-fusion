"""Analyze over a council (2026-09-27): the labels the analyst may name are the send turn's own
R1..Rn -- the strict schema enum is narrowed to them, a label outside them is a validation error
that drives the existing correction retry, and `missing_responses` / `refactored_input` read the
turn's council rather than the whole catalog."""

from __future__ import annotations

from backend.features import analyze as feature
from backend.schemas import (
    LABELS,
    Conversation,
    Extraction,
    SendTurn,
    SlotConfig,
    SlotSpec,
    ThreadMessage,
)
from tests.analyze.conftest import extraction_calls, persist


def _cfg(*slots: str) -> SlotConfig:
    return SlotConfig(
        slots={s: SlotSpec(model=f"vendor/{s}", effort="medium") for s in slots},
        analyst_model="openai/gpt-5.6-luna",
    )


# --------------------------------------------------------------------------- pure helpers
def test_missing_responses_is_over_the_turns_own_council():
    turn = SendTurn(prompt="q", slot_config=_cfg("chatgpt", "qwen"), responses={"chatgpt": "a"})
    assert feature.missing_responses(turn) == ["qwen"]
    assert feature.turn_labels(turn) == ("R1", "R2")
    five = SendTurn(
        prompt="q",
        slot_config=_cfg("claude", "chatgpt", "grok", "gemini", "deepseek"),
        responses={"claude": "a", "grok": None},
    )
    assert feature.missing_responses(five) == ["chatgpt", "grok", "gemini", "deepseek"]
    assert feature.turn_labels(five) == LABELS


def test_unknown_labels_and_the_error_text():
    ex = Extraction.model_validate(
        {
            "agreements": [{"topic": "t", "statement": "s", "models": ["R1", "R5"]}],
            "divergences": [
                {
                    "id": "d1",
                    "topic": "t",
                    "materiality": "high",
                    "positions": [
                        {"model": "R1", "claim": "c", "evidence_cited": None},
                        {"model": "R4", "claim": "c", "evidence_cited": None},
                    ],
                }
            ],
        }
    )
    assert feature.unknown_labels(ex, ("R1", "R2")) == ["R4", "R5"]
    assert feature.unknown_labels(ex, LABELS) == []
    assert feature.unknown_labels_error(["R4"], ("R1", "R2")) == (
        "validation_error: unknown label(s) ['R4']; only R1, R2 exist"
    )


def test_extraction_schema_narrows_only_the_label_enums():
    two = feature.extraction_schema_for(("R1", "R2"))
    assert two["$defs"]["Position"]["properties"]["model"]["enum"] == ["R1", "R2"]
    assert two["$defs"]["Agreement"]["properties"]["models"]["items"]["enum"] == ["R1", "R2"]
    assert two["$defs"]["Divergence"]["properties"]["materiality"]["enum"] == ["high", "medium", "low"]
    five = feature.extraction_schema_for(LABELS)
    assert five["$defs"]["Position"]["properties"]["model"]["enum"] == list(LABELS)


# --------------------------------------------------------------------------- the producer
async def test_a_label_outside_the_council_is_corrected_then_accepted(
    local_fixtures, make_conversation, analyze, get_conversation
):
    """`label_out_of_council`: attempt 1 names R4 in a three-council -- valid JSON, valid pydantic
    (the Label literal is R1..R5 now) -- and is treated as a validation failure: `analyze_retry`
    carries the unknown-label error, the correction message echoes the bad output, attempt 2 is
    the good extraction and the turn is ok with both attempts recorded and metered."""
    local_fixtures("label_out_of_council")
    conv = await persist(make_conversation())
    r, events = await analyze(conv.id)
    assert r.status_code == 200, r.text
    assert [e["type"] for e in events] == ["analyze_start", "analyze_retry", "analyze_done"]
    error = events[1]["error"]
    assert error == "validation_error: unknown label(s) ['R4']; only R1, R2, R3 exist"
    turn = events[-1]["turn"]
    assert turn["status"] == "ok" and turn["error"] is None
    assert len(turn["raw_attempts"]) == 2 and '"R4"' in turn["raw_attempts"][0]
    assert turn["usage"]["totals"]["calls"] == 2
    calls = extraction_calls()
    assert len(calls) == 2
    first, second = calls
    assert second["messages"][: len(first["messages"])] == first["messages"]
    echo, correction = second["messages"][-2:]
    assert echo["role"] == "assistant" and echo["content"] == turn["raw_attempts"][0]
    assert correction["role"] == "user" and error in correction["content"]
    for c in calls:  # the strict enum sent is the council's, on both attempts
        enum = c["response_format"]["json_schema"]["schema"]["$defs"]["Position"]["properties"]["model"]["enum"]
        assert enum == ["R1", "R2", "R3"]
    doc = await get_conversation(conv.id)
    assert doc["turns"][-1]["id"] == turn["id"] and doc["turns"][-1]["status"] == "ok"


# --------------------------------------------------------------------------- refactor / pre-parse
async def test_refactor_on_a_pair_asks_two_replies_with_the_pair_wording(local_fixtures, refactor):
    """Refactor iterates the send turn's own labels (R1/R2 for a pair) and its reply rules count
    "one other"; the `refactor_ok` fixtures (a map, then replies) serve a pair as well as the three."""
    local_fixtures("refactor_ok")
    cfg = _cfg("chatgpt", "qwen")
    responses = {"chatgpt": "reply one", "qwen": "reply two"}
    conv = Conversation(
        slot_config=cfg,
        threads={s: [] for s in responses},
        anon_map={"R1": "chatgpt", "R2": "qwen"},
    )
    turn = SendTurn(prompt="Q?", responses=responses, slot_config=cfg)
    for slot, text in responses.items():
        conv.threads[slot] = [
            ThreadMessage(role="user", content="Q?", turn_id=turn.id),
            ThreadMessage(role="assistant", content=text, turn_id=turn.id),
        ]
    conv.turns.append(turn)
    conv = await persist(conv)
    r, events = await refactor(conv.id)
    assert r.status_code == 200, r.text
    assert events[-1]["type"] == "refactor_done", events[-1]
    replies = events[-1]["turn"]["refactoring"]["replies"]
    assert [x["model"] for x in replies] == ["R1", "R2"]
    reply_calls = [c for c in extraction_calls() if "Response to condense:" in c["messages"][1]["content"]]
    assert len(reply_calls) == 2
    for c in reply_calls:
        assert "compared with one other." in c["messages"][0]["content"]
        assert "two others" not in c["messages"][0]["content"]
    assert len(extraction_calls()) == 3  # the map call plus one per label, never a third reply


async def test_preparse_counts_the_councils_experts(local_fixtures, make_conversation, client):
    local_fixtures("preparse_ok")
    conv = make_conversation(with_send=False)
    conv.slot_config = _cfg("claude", "chatgpt", "grok", "gemini", "deepseek")
    conv.threads = {s: [] for s in conv.slot_config.slots}
    conv.anon_map = {"R1": "claude", "R2": "chatgpt", "R3": "grok", "R4": "gemini", "R5": "deepseek"}
    conv = await persist(conv)
    r = await client.post(f"/api/conversations/{conv.id}/preparse", json={"prompt": "What is an IMU?"})
    assert r.status_code == 200, r.text
    (call,) = extraction_calls()
    assert "put to five experts" in call["messages"][0]["content"]
    assert "three experts" not in call["messages"][0]["content"]
