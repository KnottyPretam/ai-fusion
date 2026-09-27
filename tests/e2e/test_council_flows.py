"""The two council scenarios end to end (2026-09-27, "a council anyone can assemble"): a pair
(chatgpt + qwen) and a five (claude/chatgpt/grok/gemini/deepseek), both on OpenRouter slugs through
the mock. `turn_start.slots` and the thread keys are the council, the analyst is told the count and
the labels of THAT council (`system_for(n)`), the strict enum is R1..Rn, every label with a Position
is challenged, and no Triplex-authored message leaks an identity."""

from __future__ import annotations

import pytest

from backend.features import analyze as analyze_feature
from backend.prompts import analyze as analyze_prompts
from backend.prompts import fusion as fusion_prompts
from backend.schemas import LABELS, FusionTurn, council_labels
from tests.e2e.conftest import (
    LABEL_OF,
    assert_fusion_stream_invariants,
    calls,
    challenge_of,
    delimited_blocks,
    exchanges_of,
    leak_report,
    scenario_council,
    scenario_label_of,
    scenario_send,
    scope_allow,
    served_by_role,
    served_reply_texts,
    strip_delimited,
)
from tests.e2e.test_flows import assert_fusion_threads, assert_send_persisted

COUNCILS = {
    "council_two": ("chatgpt", "qwen"),
    "council_five": ("claude", "chatgpt", "grok", "gemini", "deepseek"),
}


@pytest.mark.parametrize("name", list(COUNCILS))
async def test_council_flow(run_flow, name):
    council = COUNCILS[name]
    labels = council_labels(council)
    n = len(council)
    assert scenario_council(name) == council
    label_of = scenario_label_of(name)
    assert list(label_of.values()) == list(labels)
    if name == "council_two":
        assert label_of == {"chatgpt": "R1", "qwen": "R2"}
        assert LABEL_OF != label_of  # the fixed three-map is not this council's map

    f = await run_flow(name)
    exp = f.expectations
    assert exp["council"] == list(council) and exp["anon_map"] == dict(zip(labels, council, strict=True))

    # ---- Send: exactly the council, in catalog order -------------------------------------
    assert f.send_events[0]["slots"] == list(council)
    assert list(f.conv["slot_config"]["slots"]) == list(council)
    assert tuple(f.conv["threads"]) == council
    assert_send_persisted(f)
    prompt, responses = scenario_send(name)
    assert tuple(responses) == council and all(responses.values())
    assert f.conv["slot_config"] == exp["slot_config"]

    # ---- Analyze: the prompt counts THIS council, the enum is R1..Rn ---------------------
    assert f.analyze is not None and f.analyze.status_code == 200
    assert f.analyze_events[-1]["type"] == "analyze_done"
    (extraction_call,) = calls("extraction")
    system, user = extraction_call["messages"]
    assert system["content"] == analyze_prompts.system_for(n) == analyze_prompts.system_message(n=n)
    assert system["content"] != analyze_prompts.SYSTEM  # neither council is the three
    blocks = delimited_blocks(user["content"])
    assert list(blocks) == list(labels)
    for slot, label in label_of.items():
        assert blocks[label] == responses[slot]
    schema = extraction_call["response_format"]["json_schema"]["schema"]
    assert schema == analyze_feature.extraction_schema_for(labels)
    assert schema["$defs"]["Position"]["properties"]["model"]["enum"] == list(labels)
    turn = f.analyze_turn
    assert turn is not None and turn["status"] == "ok"
    d1 = turn["extraction"]["divergences"][0]
    assert [p["model"] for p in d1["positions"]] == list(labels)
    assert set(labels) >= {m for a in turn["extraction"]["agreements"] for m in a["models"]}
    assert "R3" not in user["content"] if n == 2 else "R5" in user["content"]

    # ---- Fusion: every label with a Position is challenged in its own slot's thread --------
    fusion = FusionTurn.model_validate(assert_fusion_stream_invariants(f.fusion_events))
    assert fusion.exit_reason == exp["exit_reason"] == "converged"
    assert fusion.standing == ["d1"] and [s.model_dump() for s in fusion.final] == [
        {"divergence_id": "d1", "status": "resolved"}
    ]
    exchanges = exchanges_of(f.fusion_events, 1)
    assert {label for _, label in exchanges} == set(labels)
    revised = {label for (_, label), e in exchanges.items() if e["stance"] == "revise"}
    assert revised == ({"R2"} if name == "council_two" else {"R4"})
    assert all(not e["flagged_unjustified"] for e in exchanges.values())
    assert_fusion_threads(f, fusion)
    for slot, label in label_of.items():
        (defense,) = calls("defense", slot)
        challenge = challenge_of(defense)
        peers = [b for b in delimited_blocks(challenge) if b in LABELS]
        assert peers == [x for x in labels if x != label]  # every peer, in R-order, never itself
    (convergence,) = calls("convergence")
    assert convergence["messages"][0]["content"] == fusion_prompts.convergence_system_for(n)
    served = served_by_role()
    assert set(served) == {*council, "analyst"}
    for slot in council:
        assert served[slot] == [f"{slot}.chat.1.jsonl", f"{slot}.defense.1.jsonl"]
    assert served["analyst"] == ["analyst.extraction.1.jsonl", "analyst.convergence.1.jsonl"]

    # ---- no identity, slot id or vendor in any Triplex-authored text ---------------------
    assert leak_report(scope_allow([prompt], served_reply_texts())) == {}
    assert f.conv["turns"][-1]["type"] == "fusion" and len(f.conv["turns"]) == 3


async def test_council_flow_never_names_the_absent_labels(run_flow):
    """A pair's analyst never hears of R3: neither the prompt nor the schema nor any challenge."""
    f = await run_flow("council_two")
    for c in calls():
        text = "\n".join(str(m.get("content", "")) for m in c["messages"])
        if c["purpose"] in ("extraction", "defense", "convergence"):
            assert "R3" not in strip_delimited(text), (c["role"], c["purpose"])
    assert f.fusion_turn is not None
