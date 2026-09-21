"""The Fusion loop against the scenario corpus (docs/semantics.md "Fusion", PLAN.md §8 Phase 4
acceptance criteria, docs/fixtures.md exact per-role call sequences).

Every test drives Send and Analyze for real through the API (tests/fusion/conftest.py
`prepare`), then Fusion, and asserts the events, the persisted FusionTurn, the thread appends and
the exact fixture sequence captured in `backend.llm.mock.calls`.
"""

from __future__ import annotations

import json

from backend import anon
from backend.config import DEFAULT_SLOT_CONFIG, MAX_TOKENS_STAGE
from backend.llm import client, mock
from backend.llm.reasoning import REASONING_TOKEN_ALLOWANCE
from backend.llm.client import structured_response_format
from backend.prompts import delimited
from backend.prompts import fusion as prompts
from backend.schemas import (
    SLOT_IDS,
    ConvergenceCheck,
    DefenseReply,
    FusionTurn,
    PeerState,
    to_openai,
)
from backend.store import conversations as store
from tests.fusion.conftest import (
    LABEL_OF,
    assert_fusion_stream_invariants,
    by_type,
    calls,
    challenge_of,
    defense_of,
    exchanges_of,
    extraction_of,
    fixture_cost,
    fixture_text,
    local_defense,
    local_fixture_text,
    one,
    served,
    served_all,
    types_of,
)
from tests.helpers import find_identity_leaks

CHAT_FILES = [f"{slot}.chat.1.jsonl" for slot in SLOT_IDS]
EXTRACTION = "analyst.extraction.1.jsonl"
CONVERGENCE_1 = "analyst.convergence.1.jsonl"


def _defense_calls_precede_convergence(n_defense_per_round: int) -> None:
    """Every convergence call k comes after exactly k * n_defense_per_round defense calls."""
    seen_defense = 0
    k = 0
    for c in mock.calls:
        if c["purpose"] == "defense":
            seen_defense += 1
        elif c["purpose"] == "convergence":
            k += 1
            assert seen_defense == k * n_defense_per_round, (
                f"convergence call {k} came after {seen_defense} defense calls"
            )


def _assert_prefix_is_send_and_analyze() -> None:
    files = served_all()
    assert sorted(files[:3]) == sorted(CHAT_FILES)
    assert files[3] == EXTRACTION


# --------------------------------------------------------------------------- (b) planted_factual
async def test_planted_factual_converges_before_the_cap(prepare, fusion):
    p = await prepare("planted_factual")
    r, events = await fusion(p.cid, {"max_iterations": 3})
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("text/event-stream")
    assert types_of(events) == [
        "fusion_start",
        "round_start",
        "exchange",
        "exchange",
        "exchange",
        "round_done",
        "fusion_done",
    ]
    turn_doc = assert_fusion_stream_invariants(events)
    start, done = events[0], events[-1]
    assert start == {
        "type": "fusion_start",
        "turn_id": start["turn_id"],
        "of_analyze": p.analyze_turn_id,
        "max_iterations": 3,
        "standing": ["d1"],
    }
    assert events[1] == {"type": "round_start", "round": 1}
    assert done["exit_reason"] == "converged"

    ex = exchanges_of(events, 1)
    assert set(ex) == {("d1", "R1"), ("d1", "R2"), ("d1", "R3")}
    assert ex[("d1", "R1")]["stance"] == "defend" and ex[("d1", "R3")]["stance"] == "defend"
    for label in ("R1", "R3"):
        assert ex[("d1", label)]["revised_claim"] is None
        assert ex[("d1", label)]["flagged_unjustified"] is False
    r2 = ex[("d1", "R2")]
    reply = defense_of("planted_factual", "chatgpt")
    assert r2["stance"] == "revise" and r2["flagged_unjustified"] is False
    assert r2["revised_claim"] == reply.revised_claim
    assert r2["justification"] == reply.justification
    assert r2["persuaded_by"] == reply.persuaded_by
    assert r2["confidence"] == reply.confidence and r2["error"] is None

    assert one(events, "round_done") == {
        "type": "round_done",
        "round": 1,
        "post_round_status": [{"divergence_id": "d1", "status": "resolved"}],
        "changed": True,
    }

    turn = FusionTurn.model_validate(turn_doc)
    assert turn.id == start["turn_id"] and turn.of_analyze == p.analyze_turn_id
    assert turn.max_iterations == 3 and turn.standing == ["d1"]
    assert turn.exit_reason == "converged" and len(turn.rounds) == 1
    assert [s.model_dump() for s in turn.final] == [{"divergence_id": "d1", "status": "resolved"}]
    assert [(e.divergence_id, e.model) for e in turn.rounds[0].exchanges] == [
        ("d1", "R1"),
        ("d1", "R2"),
        ("d1", "R3"),
    ]
    assert turn.slot_config == p.conv.slot_config
    assert turn.slot_config is not DEFAULT_SLOT_CONFIG

    # README: 8 files -- send, analyze, then round 1's three defenses and one convergence.
    _assert_prefix_is_send_and_analyze()
    assert served("claude", "defense") == ["claude.defense.1.jsonl"]
    assert served("chatgpt", "defense") == ["chatgpt.defense.1.jsonl"]
    assert served("grok", "defense") == ["grok.defense.1.jsonl"]
    assert served("analyst", "convergence") == [CONVERGENCE_1]
    assert served_all()[-1] == CONVERGENCE_1
    assert len(mock.calls) == 8 and len(calls("extraction")) == 1
    _defense_calls_precede_convergence(3)

    # fusion_done.turn is exactly the persisted turn; the guard is released.
    after = await store.load(p.cid)
    assert after is not None and after.turns[-1].type == "fusion"
    assert after.turns[-1].id == turn.id
    assert after.turns[-1].model_dump(mode="json") == turn_doc
    assert [t.type for t in after.turns] == ["send", "analyze", "fusion"]
    assert not store.is_busy(p.cid)

    # d2 (low) is below materiality_min=medium: not in standing, never challenged.
    d2 = extraction_of("planted_factual").divergences[1]
    assert d2.id == "d2" and "d2" not in turn.standing
    for c in calls("defense"):
        assert d2.topic not in challenge_of(c)
    assert '"d2"' not in calls("convergence")[0]["messages"][1]["content"]


async def test_challenge_and_reply_land_in_the_right_slot_thread_with_meta(prepare, fusion):
    p = await prepare("planted_factual")
    _, events = await fusion(p.cid, {"max_iterations": 2})
    turn_id = events[0]["turn_id"]
    after = await store.load(p.cid)
    assert after is not None
    for slot in SLOT_IDS:
        before = p.conv.threads[slot]
        assert [m.kind for m in before] == ["chat", "chat"]
        thread = after.threads[slot]
        assert thread[: len(before)] == before, "existing history was rewritten"
        assert len(thread) == len(before) + 2
        challenge, reply = thread[-2], thread[-1]
        call = calls("defense", slot)[0]
        assert challenge.role == "user" and challenge.kind == "fusion_challenge"
        assert challenge.content == challenge_of(call)  # the exact prompt
        assert reply.role == "assistant" and reply.kind == "fusion_reply"
        assert reply.content == fixture_text("planted_factual", f"{slot}.defense.1.jsonl")
        for m in (challenge, reply):
            assert m.turn_id == turn_id
            assert m.meta == {"divergence_id": "d1", "round": 1}
            assert m.ts
        # The request carried that slot's own thread + the challenge, nothing else.
        assert call["messages"] == [to_openai(m) for m in before] + [
            {"role": "user", "content": challenge.content}
        ]
        assert call["role"] == slot


async def test_defense_and_convergence_payloads_carry_model_effort_schema_and_caps(
    prepare, fusion, monkeypatch
):
    p = await prepare("planted_factual")
    # docs/semantics.md: defense and convergence calls use `complete_json(retries=1)`. The
    # transport cannot see `retries`, so spy on the client entry point fusion.py resolves at
    # call time (`client.complete_json`), installed AFTER Send/Analyze ran.
    real_complete_json = client.complete_json
    seen: list[tuple[str, int]] = []

    async def spy(**kw):
        seen.append((kw["purpose"], kw["retries"]))
        return await real_complete_json(**kw)

    monkeypatch.setattr(client, "complete_json", spy)
    await fusion(p.cid, {"max_iterations": 1})
    assert sorted(seen) == [("convergence", 1), ("defense", 1), ("defense", 1), ("defense", 1)]
    for slot in SLOT_IDS:
        c = calls("defense", slot)[0]
        spec = p.conv.slot_config.slots[slot]
        assert c["model"] == spec.model
        assert c["reasoning"] == {"effort": spec.effort}
        # The stage budget PLUS room for reasoning tokens, because these slots reason (the assertion
        # above proves it). Reasoning tokens are counted as completion tokens and come out of
        # `max_tokens`, so a budget sized for the answer alone is spent on the thinking -- measured
        # 2026-09-20 at 4,615 reasoning tokens on one analyst call, against a `defense` budget of
        # 2,000. The frozen MAX_TOKENS_STAGE is untouched; the allowance is added at the call site.
        assert MAX_TOKENS_STAGE["defense"] == 2000
        assert c["max_tokens"] == 2000 + REASONING_TOKEN_ALLOWANCE
        assert c["plugins"] is None  # never web search on a challenge
        assert c["response_format"] == structured_response_format("defense", DefenseReply)
    conv_call = calls("convergence")[0]
    assert conv_call["role"] == "analyst"
    assert conv_call["model"] == p.conv.slot_config.analyst_model
    assert MAX_TOKENS_STAGE["convergence"] == 1000
    assert conv_call["max_tokens"] == 1000 + REASONING_TOKEN_ALLOWANCE
    assert conv_call["plugins"] is None
    assert conv_call["response_format"] == structured_response_format(
        "convergence", ConvergenceCheck
    )
    assert [m["role"] for m in conv_call["messages"]] == ["system", "user"]
    user = conv_call["messages"][1]["content"]
    assert '"divergence_id": "d1"' in user
    d1 = extraction_of("planted_factual").divergences[0]
    assert d1.topic in user
    # The payload carries every label's CURRENT claim: R2's revised one, not its extraction claim.
    revised = defense_of("planted_factual", "chatgpt").revised_claim
    assert revised in user
    positions = {pos.model: pos.claim for pos in d1.positions}
    assert positions["R1"] in user and positions["R3"] in user
    assert positions["R2"] not in user


async def test_round_one_challenge_is_built_from_the_extraction_positions(prepare, fusion):
    p = await prepare("planted_factual")
    await fusion(p.cid, {"max_iterations": 3})
    d1 = extraction_of("planted_factual").divergences[0]
    peers = [
        PeerState(label=pos.model, claim=pos.claim, justification=pos.evidence_cited)
        for pos in d1.positions
    ]
    positions = {pos.model: pos for pos in d1.positions}
    for slot in SLOT_IDS:
        label = LABEL_OF[slot]
        expected = prompts.challenge_prompt(
            topic=d1.topic,
            current_claim=positions[label].claim,
            latest_justification=anon.NONE_GIVEN,
            peer_block=anon.render_peer_block(peers, exclude=label),
            round=1,
            max_iterations=3,
        )
        assert challenge_of(calls("defense", slot)[0]) == expected


async def test_explicit_of_analyze_selects_that_turn(prepare, fusion):
    p = await prepare("planted_factual")
    r, events = await fusion(p.cid, {"of_analyze": p.analyze_turn_id, "max_iterations": 2})
    assert r.status_code == 200
    assert events[0]["of_analyze"] == p.analyze_turn_id
    assert types_of(events)[:2] == ["fusion_start", "round_start"]  # no analyze_* prefix
    assert events[-1]["exit_reason"] == "converged"


# --------------------------------------------------------------------------- (a) max_iterations=1
async def test_max_iterations_one_is_a_single_cross_exam_round(prepare, fusion):
    p = await prepare("standing_at_cap")
    _, events = await fusion(p.cid, {"max_iterations": 1})
    turn_doc = assert_fusion_stream_invariants(events)
    assert types_of(events).count("round_start") == 1
    assert types_of(events).count("round_done") == 1
    done = events[-1]
    assert done["exit_reason"] == "max_iterations"
    turn = FusionTurn.model_validate(turn_doc)
    assert turn.max_iterations == 1 and len(turn.rounds) == 1
    assert [s.status for s in turn.final] == ["standing"]
    assert turn.rounds[0].changed is True
    assert len(mock.calls) == 4 + 4  # send + analyze, then 3 defenses + 1 convergence, no more
    files = served_all()
    assert sorted(files[4:7]) == sorted(f"{slot}.defense.1.jsonl" for slot in SLOT_IDS)
    assert files[7] == CONVERGENCE_1
    for c in calls("defense"):
        assert "This is round 1 of at most 1." in challenge_of(c)


async def test_max_iterations_one_still_converges_when_the_analyst_resolves(prepare, fusion):
    p = await prepare("planted_factual")
    _, events = await fusion(p.cid, {"max_iterations": 1})
    assert events[-1]["exit_reason"] == "converged"
    assert len(FusionTurn.model_validate(events[-1]["turn"]).rounds) == 1


# --------------------------------------------------------------------------- (c) stalemate
async def test_stalemate_exits_after_round_one_without_a_convergence_call(prepare, fusion):
    p = await prepare("stalemate")
    _, events = await fusion(p.cid, {"max_iterations": 3})
    assert types_of(events) == [
        "fusion_start",
        "round_start",
        "exchange",
        "exchange",
        "exchange",
        "round_done",
        "fusion_done",
    ]
    turn_doc = assert_fusion_stream_invariants(events)
    assert all(e["stance"] == "defend" for e in by_type(events, "exchange"))
    assert all(e["justification"] for e in by_type(events, "exchange"))
    assert all(e["flagged_unjustified"] is False for e in by_type(events, "exchange"))
    rd = one(events, "round_done")
    assert rd["changed"] is False
    assert rd["post_round_status"] == [{"divergence_id": "d1", "status": "standing"}]
    done = events[-1]
    assert done["exit_reason"] == "stalemate"
    turn = FusionTurn.model_validate(turn_doc)
    assert len(turn.rounds) == 1 and [s.status for s in turn.final] == ["standing"]
    assert calls("convergence") == [], "an all-defend round must not call the analyst"
    assert len(mock.calls) == 4 + 3
    assert served("claude", "defense") == ["claude.defense.1.jsonl"]
    assert served("chatgpt", "defense") == ["chatgpt.defense.1.jsonl"]
    assert served("grok", "defense") == ["grok.defense.1.jsonl"]
    # Both sides' justifications are on the exchanges of the standing divergence.
    by_label = {e.model: e for e in turn.rounds[0].exchanges}
    for slot in SLOT_IDS:
        assert by_label[LABEL_OF[slot]].justification == defense_of("stalemate", slot).justification
    # A defend is still a successful exchange: challenge + reply are in every thread.
    after = await store.load(p.cid)
    assert after is not None
    for slot in SLOT_IDS:
        assert [m.kind for m in after.threads[slot]] == [
            "chat",
            "chat",
            "fusion_challenge",
            "fusion_reply",
        ]


# --------------------------------------------------------------------------- (d) standing_at_cap
async def test_standing_at_cap_runs_five_rounds_with_sticky_last_fixtures(prepare, fusion):
    p = await prepare("standing_at_cap")
    _, events = await fusion(p.cid, {"max_iterations": 5})
    turn_doc = assert_fusion_stream_invariants(events)
    assert [e["round"] for e in by_type(events, "round_start")] == [1, 2, 3, 4, 5]
    assert [e["round"] for e in by_type(events, "round_done")] == [1, 2, 3, 4, 5]
    for rd in by_type(events, "round_done"):
        assert rd["changed"] is True
        assert rd["post_round_status"] == [{"divergence_id": "d1", "status": "standing"}]
    for n in range(1, 6):
        assert set(exchanges_of(events, n)) == {("d1", "R1"), ("d1", "R2"), ("d1", "R3")}
    done = events[-1]
    assert done["exit_reason"] == "max_iterations"
    turn = FusionTurn.model_validate(turn_doc)
    assert len(turn.rounds) == 5
    assert [s.model_dump() for s in turn.final] == [{"divergence_id": "d1", "status": "standing"}]

    # README: 1 claude, 5 chatgpt, 1 grok and 1 convergence file suffice (sticky-last).
    _assert_prefix_is_send_and_analyze()
    assert served("claude", "defense") == ["claude.defense.1.jsonl"] * 5
    assert served("chatgpt", "defense") == [f"chatgpt.defense.{n}.jsonl" for n in range(1, 6)]
    assert served("grok", "defense") == ["grok.defense.1.jsonl"] * 5
    assert served("analyst", "convergence") == [CONVERGENCE_1] * 5
    assert len(mock.calls) == 4 + 20
    _defense_calls_precede_convergence(3)

    # Both sides' latest justifications are on the final round's exchanges.
    last = turn.rounds[-1].exchanges
    by_label = {e.model: e for e in last}
    assert by_label["R1"].stance == "defend" and by_label["R1"].justification
    assert by_label["R3"].stance == "defend" and by_label["R3"].justification
    r2_5 = defense_of("standing_at_cap", "chatgpt", 5)
    assert by_label["R2"].stance == "revise" and by_label["R2"].flagged_unjustified is False
    assert by_label["R2"].justification == r2_5.justification
    assert by_label["R2"].revised_claim == r2_5.revised_claim


async def test_current_claim_and_latest_justification_feed_later_rounds(prepare, fusion):
    p = await prepare("standing_at_cap")
    await fusion(p.cid, {"max_iterations": 5})
    r4 = defense_of("standing_at_cap", "chatgpt", 4)
    r1_defend = defense_of("standing_at_cap", "claude", 1)
    positions = {
        pos.model: pos for pos in extraction_of("standing_at_cap").divergences[0].positions
    }

    # Round 5 challenge to R2: its own current claim / justification = its round-4 revise.
    chatgpt_round5 = challenge_of(calls("defense", "chatgpt")[4])
    assert delimited(prompts.CLAIM_LABEL, r4.revised_claim) in chatgpt_round5
    assert delimited(prompts.JUSTIFICATION_LABEL, r4.justification) in chatgpt_round5
    assert "This is round 5 of at most 5." in chatgpt_round5

    # Round 5 challenge to R1: R2's peer claim is the round-4 revised claim + justification,
    # R3's is its extraction claim + its round-4 (sticky .1) defend justification; R1 sees its
    # own defend justification and never its own label as a peer.
    claude_round5 = challenge_of(calls("defense", "claude")[4])
    assert r4.revised_claim in claude_round5 and r4.justification in claude_round5
    assert "<<<R2>>>" in claude_round5 and "<<<R3>>>" in claude_round5
    assert "<<<R1>>>" not in claude_round5
    assert positions["R3"].claim in claude_round5
    assert defense_of("standing_at_cap", "grok", 1).justification in claude_round5
    assert delimited(prompts.JUSTIFICATION_LABEL, r1_defend.justification) in claude_round5
    assert positions["R2"].claim not in claude_round5, "stale claim shown instead of current"

    # Round 1 challenge to R1: the peers' extraction claims and "(none given)" justifications.
    claude_round1 = challenge_of(calls("defense", "claude")[0])
    assert positions["R2"].claim in claude_round1 and positions["R3"].claim in claude_round1
    assert delimited(prompts.JUSTIFICATION_LABEL, anon.NONE_GIVEN) in claude_round1
    assert claude_round1.count(anon.NONE_GIVEN) == 3  # own + two peers

    # Round 2's request carries round 1's challenge + reply in the slot thread.
    round1, round2 = calls("defense", "chatgpt")[0], calls("defense", "chatgpt")[1]
    assert round2["messages"][: len(round1["messages"])] == round1["messages"]
    assert round2["messages"][len(round1["messages"])] == {
        "role": "assistant",
        "content": fixture_text("standing_at_cap", "chatgpt.defense.1.jsonl"),
    }
    assert len(round2["messages"]) == len(round1["messages"]) + 2
    after = await store.load(p.cid)
    assert after is not None and len(after.threads["chatgpt"]) == 2 + 2 * 5
    assert [m.meta["round"] for m in after.threads["chatgpt"][2:]] == [
        r for r in range(1, 6) for _ in (0, 1)
    ]
    assert [m.kind for m in after.threads["chatgpt"][2:]] == [
        "fusion_challenge",
        "fusion_reply",
    ] * 5
    # Every convergence payload after round n carries R2's round-n revised claim.
    for n, c in enumerate(calls("convergence"), start=1):
        user = c["messages"][1]["content"]
        assert defense_of("standing_at_cap", "chatgpt", n).revised_claim in user


# --------------------------------------------------------------------------- (e) unjustified
async def test_unjustified_revise_is_flagged_and_resolves_as_resolved_unjustified(prepare, fusion):
    p = await prepare("unjustified_revise")
    _, events = await fusion(p.cid, {"max_iterations": 2})
    turn_doc = assert_fusion_stream_invariants(events)
    ex = exchanges_of(events, 1)
    r2 = ex[("d1", "R2")]
    assert r2["stance"] == "revise" and r2["flagged_unjustified"] is True
    assert r2["justification"] == "You are right, I revise."
    assert r2["revised_claim"] == defense_of("unjustified_revise", "chatgpt").revised_claim
    assert ex[("d1", "R1")]["flagged_unjustified"] is False  # never flagged on a defend
    assert ex[("d1", "R3")]["flagged_unjustified"] is False
    rd = one(events, "round_done")
    assert rd["changed"] is True
    assert rd["post_round_status"] == [{"divergence_id": "d1", "status": "resolved_unjustified"}]
    done = events[-1]
    assert done["exit_reason"] == "converged"
    turn = FusionTurn.model_validate(turn_doc)
    assert [s.status for s in turn.final] == ["resolved_unjustified"]
    assert len(turn.rounds) == 1
    assert served("analyst", "convergence") == [CONVERGENCE_1]
    assert len(mock.calls) == 4 + 4
    # The flagged revise still counts as a successful exchange: appended to the R2 thread.
    after = await store.load(p.cid)
    assert after is not None and len(after.threads["chatgpt"]) == 4


# --------------------------------------------------------------------------- (f) slot error
async def test_fusion_slot_error_keeps_r3_unavailable_and_the_loop_running(prepare, fusion):
    p = await prepare("fusion_slot_error")
    _, events = await fusion(p.cid, {"max_iterations": 2})
    turn_doc = assert_fusion_stream_invariants(events)
    for rnd in (1, 2):
        ex = exchanges_of(events, rnd)
        assert set(ex) == {("d1", "R1"), ("d1", "R2"), ("d1", "R3")}
        r3 = ex[("d1", "R3")]
        assert r3["stance"] == "unavailable"
        assert r3["error"] and r3["confidence"] is None
        assert r3["justification"] == "" and r3["revised_claim"] is None
        assert r3["persuaded_by"] is None and r3["flagged_unjustified"] is False
        assert ex[("d1", "R1")]["stance"] == "defend" and ex[("d1", "R1")]["error"] is None
        assert ex[("d1", "R2")]["stance"] == "revise" and ex[("d1", "R2")]["error"] is None
    rds = by_type(events, "round_done")
    assert [rd["changed"] for rd in rds] == [True, True]
    assert all(
        rd["post_round_status"] == [{"divergence_id": "d1", "status": "standing"}] for rd in rds
    )
    done = events[-1]
    assert done["exit_reason"] == "max_iterations"
    turn = FusionTurn.model_validate(turn_doc)
    assert len(turn.rounds) == 2
    assert [s.status for s in turn.final] == ["standing"]
    assert [e.stance for e in turn.rounds[1].exchanges] == ["defend", "revise", "unavailable"]
    assert turn.rounds[0].exchanges[2].error == "Rate limit exceeded"  # the fixture's message

    assert served("grok", "defense") == ["grok.defense.1.jsonl"] * 2
    assert served("claude", "defense") == ["claude.defense.1.jsonl"] * 2
    assert served("chatgpt", "defense") == ["chatgpt.defense.1.jsonl"] * 2
    assert served("analyst", "convergence") == [CONVERGENCE_1] * 2
    assert len(mock.calls) == 4 + 8
    _defense_calls_precede_convergence(3)

    after = await store.load(p.cid)
    assert after is not None
    assert after.threads["grok"] == p.conv.threads["grok"], "nothing appended on error"
    assert len(after.threads["claude"]) == 2 + 2 * 2
    assert len(after.threads["chatgpt"]) == 2 + 2 * 2
    # R3's claim stayed its extraction claim in every peer block (never revised, never lost).
    r3_claim = extraction_of("fusion_slot_error").divergences[0].positions[2].claim
    assert r3_claim in challenge_of(calls("defense", "claude")[1])
    assert r3_claim in calls("convergence")[1]["messages"][1]["content"]
    # Failed calls carry no usage chunk: they are not booked.
    assert all(u.role != "grok" for u in turn.usage.calls)
    assert turn.usage.totals.calls == 6


# --------------------------------------------------------------------------- (g) two divergences
async def test_two_divergences_resolves_d1_and_never_rechallenges_it(prepare, fusion):
    p = await prepare("two_divergences")
    _, events = await fusion(p.cid, {"max_iterations": 2})
    turn_doc = assert_fusion_stream_invariants(events)
    assert events[0]["standing"] == ["d1", "d2"]

    ex1 = exchanges_of(events, 1)
    assert set(ex1) == {(d, label) for d in ("d1", "d2") for label in ("R1", "R2", "R3")}
    assert ex1[("d1", "R2")]["stance"] == "revise" and ex1[("d2", "R2")]["stance"] == "revise"
    assert all(ex1[(d, lb)]["stance"] == "defend" for d in ("d1", "d2") for lb in ("R1", "R3"))
    assert ex1[("d1", "R2")]["flagged_unjustified"] is False
    assert ex1[("d2", "R2")]["flagged_unjustified"] is False
    rd1, rd2 = by_type(events, "round_done")
    assert rd1["post_round_status"] == [
        {"divergence_id": "d1", "status": "resolved"},
        {"divergence_id": "d2", "status": "standing"},
    ]
    ex2 = exchanges_of(events, 2)
    assert set(ex2) == {("d2", "R1"), ("d2", "R2"), ("d2", "R3")}
    assert rd2["post_round_status"] == rd1["post_round_status"]
    assert rd2["changed"] is True

    done = events[-1]
    assert done["exit_reason"] == "max_iterations"
    turn = FusionTurn.model_validate(turn_doc)
    assert [s.model_dump() for s in turn.final] == [
        {"divergence_id": "d1", "status": "resolved"},
        {"divergence_id": "d2", "status": "standing"},
    ]
    assert [(e.divergence_id, e.model) for e in turn.rounds[0].exchanges] == [
        ("d1", "R1"),
        ("d1", "R2"),
        ("d1", "R3"),
        ("d2", "R1"),
        ("d2", "R2"),
        ("d2", "R3"),
    ]
    assert [(e.divergence_id, e.model) for e in turn.rounds[1].exchanges] == [
        ("d2", "R1"),
        ("d2", "R2"),
        ("d2", "R3"),
    ]

    # README's 11-file sequence: send (3) + extraction (1), then per slot `.1` (d1) and `.2`
    # (d2) in round 1, sticky `.2` in round 2; convergence `.1` served twice.
    _assert_prefix_is_send_and_analyze()
    for slot in SLOT_IDS:
        assert served(slot, "defense") == [
            f"{slot}.defense.1.jsonl",
            f"{slot}.defense.2.jsonl",
            f"{slot}.defense.2.jsonl",
        ]
    assert served("analyst", "convergence") == [CONVERGENCE_1] * 2
    assert len(mock.calls) == 4 + 6 + 1 + 3 + 1
    assert len(set(served_all())) == 11
    fusion_calls = mock.calls[4:]
    assert [c["purpose"] for c in fusion_calls].count("convergence") == 2
    first_conv = next(i for i, c in enumerate(fusion_calls) if c["purpose"] == "convergence")
    assert first_conv == 6 and fusion_calls[-1]["purpose"] == "convergence"

    d1_topic, d2_topic = (d.topic for d in extraction_of("two_divergences").divergences)
    for slot in SLOT_IDS:
        c1, c2, c3 = calls("defense", slot)
        assert d1_topic in challenge_of(c1) and d2_topic not in challenge_of(c1)
        assert d2_topic in challenge_of(c2) and d1_topic not in challenge_of(c2)
        assert d2_topic in challenge_of(c3) and d1_topic not in challenge_of(c3)
        assert "This is round 1 of at most 2." in challenge_of(c1)
        assert "This is round 2 of at most 2." in challenge_of(c3)
        # Round 2's request carries BOTH round-1 exchanges of that slot in its thread.
        assert len(c3["messages"]) == len(c1["messages"]) + 4
    # Round 2's convergence payload lists d2 only; the sticky d1 line in the reply is ignored
    # (d1 keeps resolved); d2's claims are R2's second revise and the peers' extraction claims.
    conv1 = calls("convergence")[0]["messages"][1]["content"]
    conv2 = calls("convergence")[1]["messages"][1]["content"]
    assert '"divergence_id": "d1"' in conv1 and '"divergence_id": "d2"' in conv1
    assert '"divergence_id": "d2"' in conv2 and '"divergence_id": "d1"' not in conv2
    assert defense_of("two_divergences", "chatgpt", 2).revised_claim in conv2
    after = await store.load(p.cid)
    assert after is not None
    assert [m.meta["divergence_id"] for m in after.threads["chatgpt"][2:]] == [
        "d1",
        "d1",
        "d2",
        "d2",
        "d2",
        "d2",
    ]
    assert [m.meta["round"] for m in after.threads["chatgpt"][2:]] == [1, 1, 1, 1, 2, 2]


# --------------------------------------------------------------------------- materiality_min
async def test_standing_uses_the_conversations_materiality_min(prepare, fusion):
    cfg = {**DEFAULT_SLOT_CONFIG.model_dump(), "materiality_min": "low"}
    p = await prepare("planted_factual", slot_config=cfg)
    _, events = await fusion(p.cid, {"max_iterations": 2})
    turn_doc = assert_fusion_stream_invariants(events)
    assert events[0]["standing"] == ["d1", "d2"]
    turn = FusionTurn.model_validate(turn_doc)
    assert turn.slot_config.materiality_min == "low"
    # d2 has a revise (sticky chatgpt.defense.1) but the analyst never mentions it -> standing.
    assert [s.model_dump() for s in turn.final] == [
        {"divergence_id": "d1", "status": "resolved"},
        {"divergence_id": "d2", "status": "standing"},
    ]
    assert events[-1]["exit_reason"] == "max_iterations"
    assert len(exchanges_of(events, 1)) == 6 and len(exchanges_of(events, 2)) == 3
    assert set(exchanges_of(events, 2)) == {("d2", "R1"), ("d2", "R2"), ("d2", "R3")}
    assert len(mock.calls) == 4 + 7 + 4


# --------------------------------------------------------------------------- (l) usage
async def test_fusion_done_usage_covers_fusion_calls_only_with_wall_clock(prepare, fusion):
    p = await prepare("planted_factual")
    _, events = await fusion(p.cid, {"max_iterations": 3})
    done = events[-1]
    turn = FusionTurn.model_validate(done["turn"])
    assert done["usage"] == turn.usage.model_dump(mode="json")
    usage = turn.usage
    assert usage.totals.calls == 4 and len(usage.calls) == 4
    assert {u.purpose for u in usage.calls} == {"defense", "convergence"}
    assert usage.totals.latency_ms >= 1
    assert all(u.latency_ms >= 0 for u in usage.calls)
    expected_cost = round(
        sum(fixture_cost("planted_factual", f"{s}.defense.1.jsonl") for s in SLOT_IDS)
        + fixture_cost("planted_factual", CONVERGENCE_1),
        8,
    )
    assert usage.totals.cost_usd == expected_cost
    for u in usage.calls:
        if u.purpose == "defense":
            assert u.model == p.conv.slot_config.slots[u.role].model
        else:
            assert u.role == "analyst" and u.model == p.conv.slot_config.analyst_model
    assert usage.totals.prompt_tokens == sum(u.prompt_tokens for u in usage.calls) > 0
    assert usage.totals.completion_tokens == sum(u.completion_tokens for u in usage.calls) > 0
    # The extraction call is booked on the AnalyzeTurn, never on the FusionTurn.
    after = await store.load(p.cid)
    assert after is not None
    analyze_turn = after.turns[1]
    assert analyze_turn.type == "analyze" and analyze_turn.usage.totals.calls == 1
    assert analyze_turn.usage.calls[0].purpose == "extraction"


# --------------------------------------------------------------------------- (m) all unavailable
async def test_all_unavailable_round_exits_with_error_and_a_persisted_turn(
    prepare, scenario, fusion
):
    p = await prepare("planted_factual")
    scenario("baseline")  # no defense fixtures at all -> mock_miss on every slot
    _, events = await fusion(p.cid, {"max_iterations": 3})
    assert types_of(events) == [
        "fusion_start",
        "round_start",
        "exchange",
        "exchange",
        "exchange",
        "round_done",
        "fusion_done",
    ]
    turn_doc = assert_fusion_stream_invariants(events)
    for e in by_type(events, "exchange"):
        assert e["stance"] == "unavailable" and e["error"] and e["confidence"] is None
        # The mock_miss message ("no fixture baseline/<slot>.defense.1") reaches the event
        # scrubbed: the slot id behind the R-label is never paired with it.
        assert e["error"] == "no fixture baseline/[model].defense.1"
    rd = one(events, "round_done")
    assert rd["changed"] is False
    assert rd["post_round_status"] == [{"divergence_id": "d1", "status": "standing"}]
    done = events[-1]
    assert done["exit_reason"] == "error"
    turn = FusionTurn.model_validate(turn_doc)
    assert turn.exit_reason == "error" and len(turn.rounds) == 1
    assert [s.status for s in turn.final] == ["standing"]
    assert turn.usage.totals.calls == 0 and turn.usage.totals.latency_ms >= 1
    assert calls(role="analyst") == []
    assert [c["fixture"] for c in mock.calls] == [None, None, None]
    after = await store.load(p.cid)
    assert after is not None
    assert after.turns[-1].type == "fusion" and after.turns[-1].id == turn.id
    assert after.threads == p.conv.threads, "nothing appended when every slot failed"
    assert not store.is_busy(p.cid)


# --------------------------------------------------------------------------- (n) scrubbed errors
async def test_unavailable_exchange_error_is_scrubbed_in_the_event_and_the_persisted_turn(
    prepare, local_fixtures, fusion
):
    """`Exchange.error` is emitted, persisted and shown by the fusion pane. The mock's mock_miss
    text pairs the R-label with the slot id ("no fixture <scenario>/grok.defense.1") and a live
    transport message can name the model slug, so every error text goes through `anon.scrub`
    before it leaves the feature; the loop itself continues without R3."""
    p = await prepare("planted_factual")
    local_fixtures("r3_defense_missing")  # claude + chatgpt defenses, NO grok file
    _, events = await fusion(p.cid, {"max_iterations": 2})
    turn_doc = assert_fusion_stream_invariants(events)
    ex = exchanges_of(events, 1)
    assert set(ex) == {("d1", "R1"), ("d1", "R2"), ("d1", "R3")}
    r3 = ex[("d1", "R3")]
    assert r3["stance"] == "unavailable" and r3["confidence"] is None
    assert r3["error"] == "no fixture r3_defense_missing/[model].defense.1"
    assert calls("defense", "grok")[0]["fixture"] is None  # it really was a mock_miss
    event_text = json.dumps(r3).lower()
    for slot in SLOT_IDS:
        assert slot not in event_text
    assert find_identity_leaks(json.dumps(r3)) == []
    assert ex[("d1", "R1")]["stance"] == "defend" and ex[("d1", "R2")]["stance"] == "revise"
    assert one(events, "round_done")["post_round_status"] == [
        {"divergence_id": "d1", "status": "resolved"}
    ]
    assert events[-1]["exit_reason"] == "converged"

    turn = FusionTurn.model_validate(turn_doc)
    after = await store.load(p.cid)
    assert after is not None
    stored = after.turns[-1]
    assert stored.type == "fusion" and stored.id == turn.id
    persisted_r3 = stored.rounds[0].exchanges[2]
    assert persisted_r3.model == "R3" and persisted_r3.stance == "unavailable"
    assert persisted_r3.error == r3["error"]
    for e in stored.rounds[0].exchanges:
        if e.error is not None:
            assert "[model]" in e.error and find_identity_leaks(e.error) == []
            for slot in SLOT_IDS:
                assert slot not in e.error.lower()
    assert after.threads["grok"] == p.conv.threads["grok"], "nothing appended on error"
    assert all(u.role != "grok" for u in turn.usage.calls)
    assert turn.usage.totals.calls == 3  # two defenses + one convergence
    assert not store.is_busy(p.cid)


# --------------------------------------------------------------------------- (o) local scenarios
# tests/fusion/fixtures/README.md: Send + Analyze come from the planted_factual corpus, the
# Fusion phase from a scenario under tests/fusion/fixtures (MOCK_FIXTURES_DIR monkeypatched).
async def test_a_flagged_revise_followed_by_a_justified_one_resolves_cleanly(
    prepare, local_fixtures, fusion
):
    """`resolved_unjustified` only if EVERY revise on the divergence across ALL rounds of the
    turn is flagged: round 1 flagged revise + standing, round 2 justified revise + resolved ->
    `resolved` (the flags accumulate across rounds; a per-round reset would say unjustified)."""
    p = await prepare("planted_factual")
    local_fixtures("unjustified_then_justified")
    _, events = await fusion(p.cid, {"max_iterations": 3})
    turn_doc = assert_fusion_stream_invariants(events)
    rd1, rd2 = by_type(events, "round_done")
    r2_round1 = exchanges_of(events, 1)[("d1", "R2")]
    r2_round2 = exchanges_of(events, 2)[("d1", "R2")]
    assert r2_round1["stance"] == "revise" and r2_round1["flagged_unjustified"] is True
    assert r2_round1["justification"] == "You are right, I revise."
    assert r2_round2["stance"] == "revise" and r2_round2["flagged_unjustified"] is False
    assert rd1["post_round_status"] == [{"divergence_id": "d1", "status": "standing"}]
    assert rd1["changed"] is True and rd2["changed"] is True
    assert rd2["post_round_status"] == [{"divergence_id": "d1", "status": "resolved"}]
    assert events[-1]["exit_reason"] == "converged"
    turn = FusionTurn.model_validate(turn_doc)
    assert len(turn.rounds) == 2 and [s.status for s in turn.final] == ["resolved"]
    assert served("chatgpt", "defense") == ["chatgpt.defense.1.jsonl", "chatgpt.defense.2.jsonl"]
    assert served("claude", "defense") == ["claude.defense.1.jsonl"] * 2  # sticky-last
    assert served("analyst", "convergence") == [
        "analyst.convergence.1.jsonl",
        "analyst.convergence.2.jsonl",
    ]
    _defense_calls_precede_convergence(3)
    # Round 2's convergence payload carries R2's round-2 revised claim, the challenge its round-1
    # (flagged) revised claim as the current position.
    r2_1 = local_defense("unjustified_then_justified", "chatgpt", 1)
    r2_2 = local_defense("unjustified_then_justified", "chatgpt", 2)
    assert r2_2.revised_claim in calls("convergence")[1]["messages"][1]["content"]
    assert delimited(prompts.CLAIM_LABEL, r2_1.revised_claim) in challenge_of(
        calls("defense", "chatgpt")[1]
    )


async def test_two_flagged_revises_across_rounds_resolve_as_resolved_unjustified(
    prepare, local_fixtures, fusion
):
    p = await prepare("planted_factual")
    local_fixtures("unjustified_twice")
    _, events = await fusion(p.cid, {"max_iterations": 3})
    turn_doc = assert_fusion_stream_invariants(events)
    rd1, rd2 = by_type(events, "round_done")
    r2_1, r2_2 = (exchanges_of(events, n)[("d1", "R2")] for n in (1, 2))
    for r2 in (r2_1, r2_2):
        assert r2["stance"] == "revise" and r2["flagged_unjustified"] is True
    assert r2_1["justification"] != r2_2["justification"]  # two distinct flagged revises
    assert rd1["post_round_status"] == [{"divergence_id": "d1", "status": "standing"}]
    assert rd2["post_round_status"] == [{"divergence_id": "d1", "status": "resolved_unjustified"}]
    assert events[-1]["exit_reason"] == "converged"
    turn = FusionTurn.model_validate(turn_doc)
    assert len(turn.rounds) == 2
    assert [s.status for s in turn.final] == ["resolved_unjustified"]
    assert served("chatgpt", "defense") == ["chatgpt.defense.1.jsonl", "chatgpt.defense.2.jsonl"]
    assert served("analyst", "convergence") == [
        "analyst.convergence.1.jsonl",
        "analyst.convergence.2.jsonl",
    ]


async def test_analyst_returned_resolved_unjustified_counts_as_resolved_under_the_flag_rule(
    prepare, local_fixtures, fusion
):
    """The analyst is instructed to answer resolved|standing only, but the strict schema admits
    `resolved_unjustified`: it counts as resolved and the deterministic flag rule alone decides
    the kind -- a justified revise resolves as `resolved`, never as sycophantic convergence."""
    p = await prepare("planted_factual")
    local_fixtures("analyst_says_unjustified")
    assert "resolved_unjustified" in local_fixture_text(
        "analyst_says_unjustified", "analyst.convergence.1.jsonl"
    )
    _, events = await fusion(p.cid, {"max_iterations": 2})
    turn_doc = assert_fusion_stream_invariants(events)
    r2 = exchanges_of(events, 1)[("d1", "R2")]
    assert r2["stance"] == "revise" and r2["flagged_unjustified"] is False
    assert one(events, "round_done")["post_round_status"] == [
        {"divergence_id": "d1", "status": "resolved"}
    ]
    assert events[-1]["exit_reason"] == "converged"
    turn = FusionTurn.model_validate(turn_doc)
    assert len(turn.rounds) == 1 and [s.status for s in turn.final] == ["resolved"]
    assert served("analyst", "convergence") == ["analyst.convergence.1.jsonl"]


async def test_failed_convergence_call_keeps_every_id_standing_and_the_loop_running(
    prepare, local_fixtures, fusion
):
    """A convergence call that fails (here a mock_miss: the local scenario has no convergence
    file) is logged, every id sent stays standing, the loop continues to the cap, and the failed
    call books no usage."""
    p = await prepare("planted_factual")
    local_fixtures("revise_without_convergence")
    _, events = await fusion(p.cid, {"max_iterations": 2})
    turn_doc = assert_fusion_stream_invariants(events)
    rds = by_type(events, "round_done")
    assert [rd["changed"] for rd in rds] == [True, True]
    assert all(
        rd["post_round_status"] == [{"divergence_id": "d1", "status": "standing"}] for rd in rds
    )
    for rnd in (1, 2):
        ex = exchanges_of(events, rnd)
        assert set(ex) == {("d1", "R1"), ("d1", "R2"), ("d1", "R3")}
        assert ex[("d1", "R2")]["stance"] == "revise" and ex[("d1", "R2")]["error"] is None
    assert events[-1]["exit_reason"] == "max_iterations"
    turn = FusionTurn.model_validate(turn_doc)
    assert len(turn.rounds) == 2 and [s.status for s in turn.final] == ["standing"]
    conv_calls = calls("convergence")
    assert len(conv_calls) == 2 and [c["fixture"] for c in conv_calls] == [None, None]
    assert served("chatgpt", "defense") == ["chatgpt.defense.1.jsonl"] * 2
    _defense_calls_precede_convergence(3)
    # A transport error carries no usage: only the six defense calls are booked.
    assert all(u.role != "analyst" for u in turn.usage.calls)
    assert turn.usage.totals.calls == 6
    assert not store.is_busy(p.cid)
    after = await store.load(p.cid)
    assert after is not None and after.turns[-1].id == turn.id
    assert len(after.threads["chatgpt"]) == 2 + 2 * 2


async def test_defense_retry_is_silent_and_books_both_attempts(prepare, local_fixtures, fusion):
    """`complete_json(retries=1)` end to end: chatgpt.defense.1 is prose (no JSON object), .2 is
    valid -> two transport calls for R2 (the second carrying the assistant echo + the correction
    message), ONE exchange, and the thread's fusion_reply is attempt 2's raw text."""
    p = await prepare("planted_factual")
    local_fixtures("defense_retry")
    _, events = await fusion(p.cid, {"max_iterations": 2})
    turn_doc = assert_fusion_stream_invariants(events)
    assert served("chatgpt", "defense") == ["chatgpt.defense.1.jsonl", "chatgpt.defense.2.jsonl"]
    assert served("claude", "defense") == ["claude.defense.1.jsonl"]
    assert served("grok", "defense") == ["grok.defense.1.jsonl"]
    first, second = calls("defense", "chatgpt")
    prose = local_fixture_text("defense_retry", "chatgpt.defense.1.jsonl")
    valid = local_fixture_text("defense_retry", "chatgpt.defense.2.jsonl")
    assert second["messages"][: len(first["messages"])] == first["messages"]
    assert len(second["messages"]) == len(first["messages"]) + 2
    assert second["messages"][-2] == {"role": "assistant", "content": prose}
    assert second["messages"][-1]["role"] == "user"
    assert "failed validation" in second["messages"][-1]["content"]
    ex = exchanges_of(events, 1)
    assert set(ex) == {("d1", "R1"), ("d1", "R2"), ("d1", "R3")}
    assert ex[("d1", "R2")]["stance"] == "revise" and ex[("d1", "R2")]["error"] is None
    assert (
        ex[("d1", "R2")]["revised_claim"] == DefenseReply.model_validate_json(valid).revised_claim
    )
    assert types_of(events).count("exchange") == 3  # the retry is invisible to the stream
    assert events[-1]["exit_reason"] == "converged"
    turn = FusionTurn.model_validate(turn_doc)
    assert len(turn.rounds[0].exchanges) == 3
    assert turn.usage.totals.calls == 5  # 1 + 2 + 1 defense attempts, 1 convergence
    assert [u.role for u in turn.usage.calls].count("chatgpt") == 2
    after = await store.load(p.cid)
    assert after is not None
    thread = after.threads["chatgpt"]
    assert [m.kind for m in thread] == ["chat", "chat", "fusion_challenge", "fusion_reply"]
    assert thread[-1].content == valid
    assert prose not in [m.content for m in thread]
