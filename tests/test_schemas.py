"""Contract tests for the frozen backend/schemas.py (PLAN.md §8 Phase 1: schema unit tests)."""

import random

import pytest
from pydantic import ValidationError

from backend.config import DEFAULT_SLOT_CONFIG
from backend.schemas import (
    COUNCIL_MAX,
    COUNCIL_MIN,
    DEFAULT_COUNCIL,
    council_labels,
    council_of,
    empty_threads,
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
    assert "anon_map" not in pub and set(pub["threads"]) == set(DEFAULT_COUNCIL)


def test_new_anon_map_is_a_permutation():
    for seed in range(20):
        m = new_anon_map(random.Random(seed))
        assert tuple(m) == LABELS[:3] and sorted(m.values()) == sorted(DEFAULT_COUNCIL)


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


def _keys(node, acc):
    if isinstance(node, dict):
        for k, v in node.items():
            if k != "properties":
                acc.add(k)
            _keys(v, acc)
    elif isinstance(node, list):
        for v in node:
            _keys(v, acc)
    return acc


@pytest.mark.parametrize("cls", [Extraction, DefenseReply, ConvergenceCheck])
def test_strict_json_schema(cls):
    schema = strict_json_schema(cls)
    assert schema["type"] == "object" and _every_object_is_strict(schema)
    banned = {"default", "minimum", "maximum", "format", "pattern", "minLength", "maxLength"}
    assert not (banned & _keys(schema, set()))
    # Nullable optionals survive as anyOf [type, null] and the model still validates them.
    assert DefenseReply.model_validate(
        {
            "stance": "defend",
            "justification": "x",
            "revised_claim": None,
            "confidence": 0.5,
            "persuaded_by": None,
        }
    )


def test_slot_vendors_and_turn_extras():
    from backend.schemas import SLOT_VENDORS, ContinueTurn

    assert SLOT_VENDORS == {"claude": "anthropic", "chatgpt": "openai", "grok": "x-ai", "gemini": "google", "deepseek": "deepseek", "qwen": "qwen", "mimo": "xiaomi"}
    t = SendTurn(
        prompt="q",
        responses={"claude": "a", "chatgpt": "b", "grok": "c"},
        slot_config=DEFAULT_SLOT_CONFIG,
        reasoning={"claude": "hmm"},
        citations={"claude": [{"type": "url_citation", "url_citation": {"url": "u"}}]},
        truncated={"chatgpt": True},
        effort_applied={"grok": "low"},
    )
    back = TurnAdapter.validate_python(t.model_dump())
    assert back.reasoning["claude"] == "hmm" and back.truncated["chatgpt"] is True
    c = ContinueTurn(
        slot="grok",
        prompt="p",
        response="r",
        slot_config=DEFAULT_SLOT_CONFIG,
        truncated=True,
        effort_applied="medium",
    )
    assert TurnAdapter.validate_python(c.model_dump()).effort_applied == "medium"


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


# --------------------------------------------------------------------------- council (2026-09-27)


def test_council_bounds_two_to_five_of_the_catalog():
    spec = {"model": "m"}
    with pytest.raises(ValidationError):
        SlotConfig(slots={"claude": spec}, analyst_model="a")
    assert council_of(SlotConfig(slots={"claude": spec, "qwen": spec}, analyst_model="a")) == ("claude", "qwen")
    five = {s: spec for s in ("claude", "chatgpt", "grok", "gemini", "deepseek")}
    assert len(council_of(SlotConfig(slots=five, analyst_model="a"))) == 5
    with pytest.raises(ValidationError):
        SlotConfig(slots={s: spec for s in SLOT_IDS[:6]}, analyst_model="a")
    with pytest.raises(ValidationError):
        SlotConfig(slots={"claude": spec, "bing": spec}, analyst_model="a")
    assert (COUNCIL_MIN, COUNCIL_MAX) == (2, 5) and DEFAULT_COUNCIL == ("claude", "chatgpt", "grok")


def test_council_of_follows_the_catalog_order_not_the_dict_order():
    cfg = SlotConfig(slots={"qwen": {"model": "m"}, "chatgpt": {"model": "m"}, "gemini": {"model": "m"}}, analyst_model="a")
    assert council_of(cfg) == ("chatgpt", "gemini", "qwen")
    assert council_labels(council_of(cfg)) == ("R1", "R2", "R3")
    assert council_labels(("claude", "qwen")) == ("R1", "R2")


def test_new_anon_map_is_a_bijection_onto_the_council_for_two_and_five():
    for council in (("claude", "qwen"), ("claude", "chatgpt", "grok", "gemini", "deepseek")):
        for seed in range(20):
            m = new_anon_map(random.Random(seed), council)
            assert tuple(m) == LABELS[: len(council)]
            assert sorted(m.values()) == sorted(council)
    assert set(empty_threads(("grok", "mimo"))) == {"grok", "mimo"}
    assert set(empty_threads()) == set(DEFAULT_COUNCIL)


def test_a_schema_v1_three_slot_document_still_validates_unchanged():
    # The on-disk shape of every conversation written before 2026-09-27: three slots, R1..R3, no council field.
    raw = {
        "schema_version": 1,
        "id": "8a4c6d2e-1f3b-4c5d-9e7f-0a1b2c3d4e5f",
        "title": "old",
        "created_at": "2026-09-01T00:00:00+00:00",
        "updated_at": "2026-09-01T00:00:00+00:00",
        "slot_config": {
            "slots": {"claude": {"model": "anthropic/x", "effort": "medium"}, "chatgpt": {"model": "openai/y", "effort": "medium"}, "grok": {"model": "x-ai/z", "effort": "medium"}},
            "analyst_model": "openai/a",
            "max_iterations": 2,
            "materiality_min": "medium",
            "grounded": False,
        },
        "threads": {"claude": [], "chatgpt": [], "grok": []},
        "turns": [],
        "anon_map": {"R1": "grok", "R2": "claude", "R3": "chatgpt"},
    }
    conv = Conversation.model_validate(raw)
    assert council_of(conv.slot_config) == DEFAULT_COUNCIL
    assert conv.anon_map == raw["anon_map"]


def test_r5_is_a_label_and_r6_is_not():
    from backend.schemas import Position

    assert Position(model="R5", claim="c", justification="j").model == "R5"
    with pytest.raises(ValidationError):
        Position(model="R6", claim="c", justification="j")


# --------------------------------------------------------------------------- plan (2026-09-27)


def test_plan_turn_round_trips_through_the_turn_adapter_and_the_conversation():
    from backend.schemas import Plan, PlanDecision, PlanRisk, PlanStep, PlanTurn

    plan = Plan(
        objective="o",
        prerequisites=["p"],
        steps=[PlanStep(number=1, title="t", action="a", why="w", inputs=["i"], outputs=["x"], verify="v")],
        decisions=[PlanDecision(divergence_id="d1", topic="k", options=["1", "2"], recommendation="1", rationale="r")],
        risks=[PlanRisk(risk="r", mitigation="m")],
        done_when=["done"],
    )
    turn = PlanTurn(of_fusion="f1", model="web:claude", plan=plan, slot_config=DEFAULT_SLOT_CONFIG.model_copy(deep=True))
    dumped = turn.model_dump(mode="json")
    assert dumped["type"] == "plan" and dumped["status"] == "ok" and dumped["error"] is None
    again = TurnAdapter.validate_python(dumped)
    assert isinstance(again, PlanTurn) and again == turn
    # The minimal shapes: every list defaults empty, a decision needs no divergence id.
    assert Plan(objective="o").model_dump() == {
        "objective": "o", "prerequisites": [], "steps": [], "decisions": [], "risks": [], "done_when": []
    }
    assert PlanDecision(topic="k").divergence_id is None
    with pytest.raises(ValidationError):
        Plan()  # objective is required
    with pytest.raises(ValidationError):
        PlanTurn(of_fusion="f1", slot_config=DEFAULT_SLOT_CONFIG)  # the model that wrote it is required
    conv = Conversation(slot_config=DEFAULT_SLOT_CONFIG.model_copy(deep=True), threads=empty_threads(), turns=[turn], anon_map={"R1": "claude", "R2": "chatgpt", "R3": "grok"})
    loaded = Conversation.model_validate_json(conv.model_dump_json())
    assert isinstance(loaded.turns[0], PlanTurn) and loaded.turns[0].plan == plan
    degraded = PlanTurn(of_fusion="f1", model="m", status="degraded", error="e", raw_attempts=["a", ""], slot_config=DEFAULT_SLOT_CONFIG)
    assert degraded.plan is None and TurnAdapter.validate_python(degraded.model_dump()).raw_attempts == ["a", ""]


def test_plan_message_kinds_are_valid_and_unknown_kinds_are_not():
    for kind in ("plan_request", "plan_reply"):
        msg = ThreadMessage(role="user", content="c", kind=kind, turn_id="t", meta={"plan_turn": "t"})
        assert msg.kind == kind and to_openai(msg) == {"role": "user", "content": "c"}
    with pytest.raises(ValidationError):
        ThreadMessage(role="user", content="c", kind="plan", turn_id="t")


def test_a_document_without_plan_model_validates_and_reads_none():
    # The on-disk shape of every slot_config written before 2026-09-27: no `plan_model` key.
    cfg = SlotConfig.model_validate(
        {
            "slots": {"claude": {"model": "a"}, "chatgpt": {"model": "b"}, "grok": {"model": "c"}},
            "analyst_model": "openai/a",
        }
    )
    assert cfg.plan_model is None
    assert "plan_model" in cfg.model_dump()  # written back explicitly from now on
    assert SlotConfig.model_validate({**cfg.model_dump(), "plan_model": "web:claude"}).plan_model == "web:claude"
