"""Contract tests for the frozen backend/schemas.py (PLAN.md §8 Phase 1: schema unit tests)."""

import random

import pytest
from pydantic import ValidationError

from backend.config import DEFAULT_SLOT_CONFIG
from backend.schemas import (
    LABELS,
    SLOT_IDS,
    AnalyzeTurn,
    ConvergenceCheck,
    Conversation,
    DefenseReply,
    Exchange,
    Extraction,
    FusionRound,
    FusionTurn,
    RoundStatus,
    SendTurn,
    SlotConfig,
    ThreadMessage,
    TurnAdapter,
    canonical_request_key,
    efforts_from_reasoning_meta,
    empty_threads,
    is_unjustified,
    new_anon_map,
    sse_frame,
    strict_json_schema,
    to_openai,
    to_public,
)

VALID_EXTRACTION = {
    "agreements": [
        {"topic": "range", "statement": "Selectable full-scale range", "models": ["R1", "R3"]}
    ],
    "divergences": [
        {
            "id": "d1",
            "topic": "max range",
            "positions": [
                {"model": "R1", "claim": "2000 deg/s", "evidence_cited": "datasheet"},
                {"model": "R2", "claim": "1000 deg/s", "evidence_cited": None},
            ],
            "materiality": "high",
        }
    ],
}


def test_extraction_valid_and_invalid():
    ex = Extraction.model_validate(VALID_EXTRACTION)
    assert ex.divergences[0].positions[1].evidence_cited is None
    with pytest.raises(ValidationError):
        Extraction.model_validate(
            {
                "agreements": [],
                "divergences": [
                    {
                        "id": "d1",
                        "topic": "t",
                        "positions": [{"model": "R9", "claim": "x"}],
                        "materiality": "high",
                    }
                ],
            }
        )
    with pytest.raises(ValidationError):
        Extraction.model_validate({"agreements": []})  # divergences missing


def test_fusion_round_and_exchange():
    rnd = FusionRound(
        round=1,
        exchanges=[
            Exchange(
                divergence_id="d1",
                model="R2",
                stance="revise",
                justification="j",
                revised_claim="c",
                confidence=0.7,
                persuaded_by="p",
            )
        ],
        post_round_status=[RoundStatus(divergence_id="d1", status="resolved")],
        changed=True,
    )
    assert rnd.exchanges[0].flagged_unjustified is False
    with pytest.raises(ValidationError):
        Exchange(divergence_id="d1", model="R1", stance="concede")
    with pytest.raises(ValidationError):
        RoundStatus(divergence_id="d1", status="maybe")
    with pytest.raises(ValidationError):
        DefenseReply(stance="defend", justification="x", confidence=1.5)
    ConvergenceCheck(statuses=[RoundStatus(divergence_id="d1", status="standing")])


def test_turn_discriminated_union_roundtrip():
    cfg = DEFAULT_SLOT_CONFIG
    turns = [
        SendTurn(
            prompt="q",
            responses={"claude": "a", "chatgpt": None, "grok": "c"},
            slot_config=cfg,
            errors={"chatgpt": "boom"},
        ),
        AnalyzeTurn(
            of_turn="t1", extraction=Extraction.model_validate(VALID_EXTRACTION), slot_config=cfg
        ),
        FusionTurn(
            of_analyze="a1",
            max_iterations=2,
            standing=["d1"],
            exit_reason="converged",
            slot_config=cfg,
        ),
    ]
    for t in turns:
        back = TurnAdapter.validate_python(t.model_dump())
        assert type(back) is type(t) and back.id == t.id and back.ts.endswith("Z")
    with pytest.raises(ValidationError):
        TurnAdapter.validate_python({"type": "bogus", "slot_config": cfg.model_dump()})
    with pytest.raises(ValidationError):
        FusionTurn(
            of_analyze="a", max_iterations=6, standing=[], exit_reason="converged", slot_config=cfg
        )


def test_slot_config_requires_all_slots_and_caps_iterations():
    with pytest.raises(ValidationError):
        SlotConfig(slots={"claude": {"model": "m"}}, analyst_model="a")
    with pytest.raises(ValidationError):
        SlotConfig(slots=DEFAULT_SLOT_CONFIG.slots, analyst_model="a", max_iterations=0)
    assert (
        DEFAULT_SLOT_CONFIG.max_iterations == 2 and DEFAULT_SLOT_CONFIG.materiality_min == "medium"
    )


def test_to_public_strips_anon_map():
    conv = Conversation(
        slot_config=DEFAULT_SLOT_CONFIG,
        threads=empty_threads(),
        anon_map=new_anon_map(random.Random(0)),
    )
    pub = to_public(conv).model_dump()
    assert "anon_map" not in pub and set(pub["threads"]) == set(SLOT_IDS)


def test_new_anon_map_is_a_permutation():
    for seed in range(20):
        m = new_anon_map(random.Random(seed))
        assert tuple(m) == LABELS and sorted(m.values()) == sorted(SLOT_IDS)


def test_thread_message_projection():
    m = ThreadMessage(
        role="assistant",
        content="hi",
        kind="fusion_reply",
        turn_id="t",
        meta={"divergence_id": "d1", "round": 1},
    )
    assert to_openai(m) == {"role": "assistant", "content": "hi"}


def _every_object_is_strict(node) -> bool:
    if isinstance(node, dict):
        if node.get("type") == "object" and "properties" in node:
            if node.get("additionalProperties") is not False:
                return False
            if set(node.get("required", [])) != set(node["properties"]):
                return False
        return all(_every_object_is_strict(v) for v in node.values())
    if isinstance(node, list):
        return all(_every_object_is_strict(v) for v in node)
    return True


@pytest.mark.parametrize("cls", [Extraction, DefenseReply, ConvergenceCheck])
def test_strict_json_schema(cls):
    schema = strict_json_schema(cls)
    assert schema["type"] == "object" and _every_object_is_strict(schema)


PEERS = ["The BMI088 gyroscope full-scale range is selectable up to 2000 deg/s per the datasheet."]
GOOD_JUST = (
    "Peer R1 cites the Bosch datasheet table where the gyroscope full-scale range is "
    "selectable up to 2000 deg/s; that specific figure contradicts my 1000 deg/s claim."
)


@pytest.mark.parametrize(
    "reply,expected",
    [
        (DefenseReply(stance="defend", justification="short", confidence=0.9), False),
        (
            DefenseReply(
                stance="revise",
                justification=GOOD_JUST,
                revised_claim="2000 deg/s",
                confidence=0.8,
                persuaded_by="the datasheet gyroscope full-scale figure",
            ),
            False,
        ),
        (
            DefenseReply(
                stance="revise",
                justification="You are right, I revise.",
                revised_claim="2000",
                confidence=0.5,
                persuaded_by="the datasheet gyroscope full-scale figure",
            ),
            True,
        ),
        (
            DefenseReply(
                stance="revise",
                justification=GOOD_JUST,
                revised_claim=None,
                confidence=0.8,
                persuaded_by="the datasheet gyroscope full-scale figure",
            ),
            True,
        ),
        (
            DefenseReply(
                stance="revise",
                justification=GOOD_JUST,
                revised_claim="2000",
                confidence=0.8,
                persuaded_by=None,
            ),
            True,
        ),
        (
            DefenseReply(
                stance="revise",
                justification=GOOD_JUST,
                revised_claim="2000",
                confidence=0.8,
                persuaded_by="ok",
            ),
            True,
        ),
        (
            DefenseReply(
                stance="revise",
                justification="x" * 100,
                revised_claim="2000",
                confidence=0.8,
                persuaded_by="the datasheet gyroscope full-scale figure",
            ),
            True,
        ),
    ],
)
def test_is_unjustified_truth_table(reply, expected):
    assert is_unjustified(reply, PEERS) is expected


def test_efforts_from_reasoning_meta():
    assert efforts_from_reasoning_meta(None) == (["off"], False)
    assert efforts_from_reasoning_meta({"supported_efforts": None, "mandatory": False}) == (
        ["off", "low", "medium", "high"],
        False,
    )
    assert efforts_from_reasoning_meta(
        {"supported_efforts": ["xhigh", "high", "medium", "low"], "mandatory": True}
    ) == (["low", "medium", "high"], True)
    assert efforts_from_reasoning_meta({"supported_efforts": ["high"], "mandatory": True}) == (
        ["high"],
        True,
    )


def test_sse_frame_and_request_key():
    assert sse_frame({"type": "x", "t": "é"}) == 'data: {"type": "x", "t": "é"}\n\n'
    k1 = canonical_request_key("m", [{"role": "user", "content": "a"}], None)
    k2 = canonical_request_key("m", [{"content": "a", "role": "user"}], None)
    assert k1 == k2 and len(k1) == 64
    assert (
        canonical_request_key("m", [{"role": "user", "content": "a"}], {"type": "json_schema"})
        != k1
    )
