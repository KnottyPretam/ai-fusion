"""The analyst prompt's size bound: the condense ("split") step.

Why this exists (measured 2026-09-20 on conversation `2b242b5c`, the failing run in the plan): at
high reasoning effort the three replies came back 4,992 / 13,677 / 8,583 characters long and the
analyst prompt became 29,958 characters typed into ONE chat message, 27,252 of it quoted replies.
Nothing bounded it, and the capture of the analyst's own long reply ended mid-stream.

The rule (docs/semantics.md "Analyze", PLAN Workstream D): under
`feature.SPLIT_MIN_CHARS` of quoted replies nothing changes -- one message, one analyst call,
goldens byte-identical. Over it, each label's reply is condensed to its substantive claims in its
own call first (`purpose="extraction"`, no new schema: the condensation is quoted data for the
next prompt, not a validated artifact) and the three condensed blocks are then compared by the
normal prompt, which still returns a real `Extraction`. A reply that is over
`feature.REPLY_BUDGET_CHARS` on its own cannot be condensed either, so the turn degrades naming
the label and both numbers -- never a silent truncation.
"""

from __future__ import annotations

import json

from pathlib import Path
from typing import Any

import pytest

from backend.features import analyze as feature
from backend.llm import mock
from backend.prompts import analyze as prompts
from backend.schemas import LABELS
from tests.analyze.conftest import blocks_of, extraction_calls, outside_blocks, persist
from tests.bridge import conftest as bridge_fixtures
from tests.conftest import DEFAULT_PROMPT
from tests.helpers import messages_text, parse_sse_text

# Fixtures reused from the bridge area (same binding trick as tests/analyze/test_web_no_retry.py:
# pytest registers a fixture under the module attribute it finds it at).
_fresh_hub = bridge_fixtures._fresh_hub
fake_desktop = bridge_fixtures.fake_desktop
web_env = bridge_fixtures.web_env

ANALYST = ("chatgpt", "analyst", "extraction")
REPO_ROOT = Path(__file__).resolve().parents[2]
# One sentence of plausible reply prose, repeated to reach an exact length.
FILLER = "The gyroscope full-scale range is selectable in four steps up to 2000 deg/s. "


def reply(chars: int, marker: str) -> str:
    """A reply of exactly `chars` characters that starts with `marker` (so a test can tell the
    three apart inside a payload)."""
    body = f"{marker}. " + FILLER * (chars // len(FILLER) + 2)
    return body[:chars]


def _types(events: list[dict[str, Any]]) -> list[str]:
    return [e["type"] for e in events]


def responses_of(total: int) -> dict[str, str]:
    """Three slot replies whose characters sum to exactly `total`."""
    each = total // 3
    return {
        "claude": reply(each, "CLAUDE-BODY"),
        "chatgpt": reply(each, "CHATGPT-BODY"),
        "grok": reply(total - 2 * each, "GROK-BODY"),
    }


# --------------------------------------------------------------------------- pure helpers
def test_quoted_chars_counts_every_label_and_nothing_else():
    assert feature.quoted_chars({"R1": "abc", "R2": "de", "R3": ""}) == 5
    assert feature.quoted_chars(dict.fromkeys(LABELS, "")) == 0


def test_the_threshold_and_the_budget_leave_room_for_the_scaffold():
    """`desktop/main/ipc.js` MAX_PROMPT_CHARS is 32768: one reply may fill at most
    REPLY_BUDGET_CHARS of that, and the question plus the condense instruction ride in the rest."""
    assert feature.SPLIT_MIN_CHARS == 12_000
    assert feature.REPLY_BUDGET_CHARS == 30_000
    assert feature.REPLY_BUDGET_CHARS < 32_768
    assert feature.SPLIT_MIN_CHARS < feature.REPLY_BUDGET_CHARS


def test_needs_split_is_the_total_over_the_threshold():
    under = {label: "x" * (feature.SPLIT_MIN_CHARS // 3) for label in LABELS}
    assert feature.quoted_chars(under) <= feature.SPLIT_MIN_CHARS
    assert not feature.needs_split(under)
    over = {**under, "R3": "x" * (feature.SPLIT_MIN_CHARS // 3 + 1)}
    assert feature.needs_split(over)


def test_oversize_reply_names_the_first_label_over_the_budget():
    ok = dict.fromkeys(LABELS, "x" * feature.REPLY_BUDGET_CHARS)  # exactly at the budget is fine
    assert feature.oversize_reply(ok) is None
    big = {**ok, "R2": "x" * (feature.REPLY_BUDGET_CHARS + 1)}
    assert feature.oversize_reply(big) == ("R2", feature.REPLY_BUDGET_CHARS + 1)
    both = {**big, "R1": "x" * 41_200}
    assert feature.oversize_reply(both) == ("R1", 41_200)  # R1/R2/R3 order, not size order


def test_the_oversize_message_carries_the_label_and_both_numbers():
    msg = feature.oversize_message("R2", 41_200)
    assert "R2" in msg and "41,200" in msg and "30,000" in msg
    assert "characters" in msg


# --------------------------------------------------------------------------- below the threshold
async def test_replies_under_the_threshold_take_exactly_one_analyst_call(
    make_conversation, analyze
):
    """The proof that a normal conversation is untouched: one call, and the user message is
    `build_user` with the unchanged `Responses:` header (the goldens in tests/analyze and
    tests/e2e pin the same bytes)."""
    responses = responses_of(feature.SPLIT_MIN_CHARS)
    conv = await persist(make_conversation(responses=responses))
    r, events = await analyze(conv.id)
    assert r.status_code == 200, r.text
    assert _types(events) == ["analyze_start", "analyze_done"]
    (call,) = extraction_calls()
    system, user = call["messages"]
    assert system["content"] == prompts.SYSTEM
    expected = {"R1": responses["claude"], "R2": responses["chatgpt"], "R3": responses["grok"]}
    assert user["content"] == prompts.build_user(DEFAULT_PROMPT, expected)
    assert prompts.RESPONSES_HEADER in user["content"]


# --------------------------------------------------------------------------- above the threshold
async def test_long_replies_are_condensed_label_by_label_before_the_comparison(
    make_conversation, analyze, local_fixtures
):
    local_fixtures("analyst_split")
    responses = responses_of(feature.SPLIT_MIN_CHARS + 3)
    conv = await persist(make_conversation(responses=responses))
    r, events = await analyze(conv.id)
    assert r.status_code == 200, r.text
    # The existing event alphabet only: one analyze_retry per condense call (no new event type).
    assert _types(events) == [
        "analyze_start",
        "analyze_retry",
        "analyze_retry",
        "analyze_retry",
        "analyze_done",
    ]
    for label, event in zip(LABELS, events[1:4], strict=True):
        assert event["error"].startswith(feature.SPLIT_NOTICE_PREFIX)  # progress, not a failure
        assert label in event["error"]
        assert f"{feature.SPLIT_MIN_CHARS:,}" in event["error"]

    calls = extraction_calls()
    assert len(calls) == 4  # three condensations, then the comparison
    expected = {"R1": responses["claude"], "R2": responses["chatgpt"], "R3": responses["grok"]}
    for label, call in zip(LABELS, calls[:3], strict=True):
        system, user = call["messages"]
        assert system["content"] == prompts.CONDENSE_SYSTEM
        assert blocks_of(user["content"]) == {label: expected[label]}  # exactly one reply quoted
        assert DEFAULT_PROMPT in user["content"]  # the question, so "substantive" has a referent
        assert call["response_format"] is None  # bullets are not a validated artifact

    system, user = calls[3]["messages"]
    assert system["content"] == prompts.SYSTEM
    condensed = blocks_of(user["content"])
    assert list(condensed) == list(LABELS)
    for label in LABELS:
        assert "2000 dps" in condensed[label] or "1000 dps" in condensed[label]
        assert expected[label] not in user["content"]  # the raw reply never reaches the comparison
    assert prompts.CONDENSED_RESPONSES_HEADER in user["content"]
    assert len(user["content"]) < feature.SPLIT_MIN_CHARS  # the whole point

    turn = events[-1]["turn"]
    assert turn["status"] == "ok" and turn["extraction"] is not None
    # Each sub-call's raw text is narrated through raw_attempts (a plain list[str]).
    assert len(turn["raw_attempts"]) == 4
    assert turn["raw_attempts"][:3] == [condensed[label] for label in LABELS]
    assert turn["usage"]["totals"]["calls"] == 4  # every condensation is metered


async def test_a_failed_condensation_degrades_before_the_comparison_call(
    make_conversation, analyze, local_fixtures
):
    """A condensation that produced nothing cannot be compared, and falling back to the raw reply
    would rebuild the oversized prompt: degrade, naming the label."""
    local_fixtures("analyst_split_condense_error")
    conv = await persist(make_conversation(responses=responses_of(feature.SPLIT_MIN_CHARS + 3)))
    r, events = await analyze(conv.id)
    assert r.status_code == 200, r.text
    assert _types(events) == ["analyze_start", "analyze_retry", "analyze_retry", "analyze_degraded"]
    turn = events[-1]["turn"]
    assert turn["status"] == "degraded" and turn["extraction"] is None
    assert "R2" in turn["error"] and "Provider disconnected" in turn["error"]
    assert len(extraction_calls()) == 2  # R1 condensed, R2 failed, no comparison call


def test_chunk_reply_leaves_a_reply_that_already_fits_exactly_as_it_was():
    short = "One paragraph.\n\nAnother."
    assert feature.chunk_reply(short) == [short]
    at_limit = "x" * feature.CONDENSE_CHUNK_CHARS
    assert feature.chunk_reply(at_limit) == [at_limit]


def test_chunk_reply_splits_on_paragraph_boundaries_and_keeps_every_character():
    paras = [f"Paragraph {i}. " + ("filler sentence about storage. " * 30) for i in range(12)]
    reply = "\n\n".join(paras)
    assert len(reply) > feature.CONDENSE_CHUNK_CHARS
    pieces = feature.chunk_reply(reply)
    assert len(pieces) > 1
    assert all(len(p) <= feature.CONDENSE_CHUNK_CHARS for p in pieces)
    # every paragraph survives somewhere, whole: a chunk boundary is never a cut sentence here
    joined = "\n\n".join(pieces)
    for para in paras:
        assert para in joined
    assert all("\n\n".join(pieces).count(p) == 1 for p in paras)  # and never duplicated


def test_chunk_reply_cuts_inside_one_oversized_paragraph_rather_than_giving_up():
    """A single paragraph longer than the whole limit has no boundary to split on. A hard cut inside
    it beats a message the analyst will not answer, which is the failure this exists to avoid."""
    one = "y" * (feature.CONDENSE_CHUNK_CHARS * 2 + 500)
    pieces = feature.chunk_reply(one)
    assert len(pieces) == 3
    assert all(len(p) <= feature.CONDENSE_CHUNK_CHARS for p in pieces)
    assert "".join(pieces) == one  # nothing dropped, nothing duplicated


def test_the_chunk_size_is_under_what_was_measured_to_fail():
    # Measured 2026-09-20: single condense calls quoting 13.6 KB and 15.5 KB never produced readable
    # text inside 300 s, 570 s or 1,200 s; a 6.3 KB reply condensed in about 15 s.
    assert feature.CONDENSE_CHUNK_CHARS < 13_000
    assert feature.CONDENSE_CHUNK_CHARS < feature.SPLIT_MIN_CHARS


def test_chunk_notice_names_the_label_the_size_and_the_piece_count():
    message = feature.chunk_notice("R1", 15_460, 3)
    assert message.startswith(feature.SPLIT_NOTICE_PREFIX)  # progress, so the pane shows it as such
    assert "R1" in message and "15,460" in message and "3 pieces" in message
    assert f"{feature.CONDENSE_CHUNK_CHARS:,}" in message


# --------------------------------------------------------------------------- the narration prefix
# `analyze_retry` is the ONE event that carries both a failed attempt being sent back and a progress
# narration (a reply being condensed, a reply being condensed in pieces), because the alphabet is
# frozen. The pane keys its progress branch on `SPLIT_NOTICE_PREFIX` alone and docs/api-contract.md
# promises it; the chunk notice shipped without it in 1fc9339 and every chunked reply reached the
# user as "the analyst output failed validation" (found 2026-09-22). These pin the invariant.
def test_every_progress_narration_begins_with_the_prefix_the_pane_keys_on():
    prefix = feature.SPLIT_NOTICE_PREFIX
    split = feature.split_notice("R2", 13_677, 27_252)
    chunk = feature.chunk_notice("R1", 6_187, 2)
    assert split.startswith(f"{prefix}: ")
    assert chunk.startswith(f"{prefix}: ")
    # What follows the prefix is where the two differ; a client need not care.
    assert "condensed to its substantive claims" in split
    assert "condensed in 2 pieces" in chunk


async def test_a_genuine_retry_never_carries_the_progress_prefix(scenario_conversation, analyze):
    """The other kind of `analyze_retry`: the `error or "unknown error"` the producer sends back
    after a failed attempt. The pane must keep reading that one as a failure."""
    conv = await scenario_conversation("analyst_retry")
    r, events = await analyze(conv.id)
    assert r.status_code == 200, r.text
    (retry,) = [e for e in events if e["type"] == "analyze_retry"]
    assert retry["error"] and not retry["error"].startswith(feature.SPLIT_NOTICE_PREFIX)
    assert not "unknown error".startswith(feature.SPLIT_NOTICE_PREFIX)  # the fallback text too


def test_the_pane_mirrors_the_prefix_verbatim():
    """Product code in the renderer never reads the backend, so the pane carries a copy of the
    constant with a pointer (the way `SLOT_VENDORS` is duplicated). This is the guard that the two
    copies still say the same thing -- the regression class 1fc9339 was."""
    pane = (REPO_ROOT / "frontend" / "src" / "features" / "analyze" / "AnalyzePane.jsx").read_text()
    assert f"NOTICE_PREFIX = '{feature.SPLIT_NOTICE_PREFIX}'" in pane


async def test_condensations_that_do_not_shrink_degrade_instead_of_sending_the_prompt_anyway(
    make_conversation, analyze, local_fixtures
):
    """Two passes that still leave the set over CONDENSED_MAX_CHARS. The comparison prompt would be
    bigger than one analyst message can carry, so it is never sent: the turn degrades naming the
    largest block, and nothing is truncated to force it."""
    local_fixtures("analyst_split_no_shrink")
    conv = await persist(make_conversation(responses=responses_of(feature.SPLIT_MIN_CHARS + 3)))
    r, events = await analyze(conv.id)
    assert r.status_code == 200, r.text
    types = _types(events)
    assert types[0] == "analyze_start" and types[-1] == "analyze_degraded"
    # Pass 1: three labels, one call each (the replies are under CONDENSE_CHUNK_CHARS). Pass 2: each
    # ~7,800-character block is chunked into two pieces, so six more calls. Never a comparison.
    assert len(extraction_calls()) == 3 + 6
    narrations = [e["error"] for e in events if e["type"] == "analyze_retry"]
    assert all(n.startswith(feature.SPLIT_NOTICE_PREFIX) for n in narrations), narrations
    assert sum(1 for n in narrations if "being condensed to its substantive claims" in n) == 6  # 3 + 3
    turn = events[-1]["turn"]
    assert turn["status"] == "degraded" and turn["extraction"] is None
    assert f"after {feature.CONDENSE_PASSES} condense passes" in turn["error"]
    assert f"over the {feature.CONDENSED_MAX_CHARS:,}" in turn["error"]
    assert "truncated" in turn["error"]  # and says plainly that nothing was cut to force it
    assert len(turn["raw_attempts"]) == 9  # every condensation of both passes is still reported
    assert turn["usage"]["totals"]["calls"] == 9


def test_condense_ineffective_names_the_total_the_label_the_passes_and_the_bound():
    message = feature.condense_ineffective(25_002, "R2", 9_001)
    assert "25,002" in message and "R2" in message and "9,001" in message
    assert f"{feature.CONDENSED_MAX_CHARS:,}" in message
    assert f"after {feature.CONDENSE_PASSES} condense passes" in message
    # the split trigger is NOT the bound the comparison is measured against (measured 2026-09-22)
    assert feature.CONDENSED_MAX_CHARS > feature.SPLIT_MIN_CHARS


def test_the_condensed_bound_is_sized_for_what_one_pass_actually_achieves():
    """Measured 2026-09-22: one pass took 20,511 characters of replies to 14,950 -- ~30% off. The bound
    has to admit that, or every over-threshold conversation is refused after the work is done."""
    assert 14_950 <= feature.CONDENSED_MAX_CHARS
    assert feature.CONDENSE_PASSES == 2


def test_chunk_reply_splits_a_bullet_block_on_line_boundaries_before_cutting():
    """A condensed block is bullet lines joined by single newlines with no paragraph break anywhere,
    and a second pass reads it back through chunk_reply: it must split between bullets, never inside
    one, and only a single line longer than the whole limit is hard-cut."""
    bullets = "\n".join(f"- claim {i} about the constellation and its band" for i in range(400))
    assert "\n\n" not in bullets and len(bullets) > feature.CONDENSE_CHUNK_CHARS
    pieces = feature.chunk_reply(bullets)
    assert len(pieces) > 1
    assert all(len(p) <= feature.CONDENSE_CHUNK_CHARS for p in pieces)
    assert all(p.startswith("- claim") and p.endswith("band") for p in pieces)  # whole lines only
    assert "\n".join(pieces) == bullets  # nothing dropped, nothing duplicated
    one_line = "y" * (feature.CONDENSE_CHUNK_CHARS * 2 + 100)
    assert [len(p) for p in feature.chunk_reply(one_line)] == [6000, 6000, 100]


async def test_a_set_still_over_the_bound_after_one_pass_gets_a_second_pass_then_the_comparison(
    make_conversation, analyze, local_fixtures
):
    """The other step the user asked for on 2026-09-20: three 9,000-character replies, split into two
    pieces each; the first pass's claims still total ~24,600, over CONDENSED_MAX_CHARS, so a second
    pass runs over the condensed blocks (~6,600 after it) and THEN the comparison."""
    local_fixtures("analyst_split_two_pass")
    responses = {"claude": reply(9_000, "R1"), "chatgpt": reply(9_000, "R2"), "grok": reply(9_000, "R3")}
    conv = await persist(make_conversation(responses=responses))
    r, events = await analyze(conv.id)
    assert r.status_code == 200, r.text
    assert _types(events)[-1] == "analyze_done", events[-1].get("turn", {}).get("error")
    calls = extraction_calls()
    assert len(calls) == 6 + 6 + 1  # two pieces per label per pass, then the comparison
    for call in calls[:12]:
        system, user = call["messages"]
        assert system["content"] == prompts.CONDENSE_SYSTEM
        assert len(next(iter(blocks_of(user["content"]).values()))) <= feature.CONDENSE_CHUNK_CHARS
    # the second pass condensed the FIRST pass's bullets, not the raw replies
    _system, user7 = calls[6]["messages"]
    seventh = next(iter(blocks_of(user7["content"]).values()))
    assert "pass-1 piece" in seventh and "R1 raw" not in seventh
    system, user = calls[12]["messages"]
    assert system["content"] == prompts.SYSTEM
    condensed = blocks_of(user["content"])
    assert list(condensed) == list(LABELS)
    assert all("pass-2 piece" in condensed[label] for label in LABELS)
    assert sum(len(v) for v in condensed.values()) <= feature.CONDENSED_MAX_CHARS
    turn = events[-1]["turn"]
    assert turn["status"] == "ok" and turn["extraction"] is not None
    assert len(turn["raw_attempts"]) == 13
    assert turn["usage"]["totals"]["calls"] == 13
    narrations = [e["error"] for e in events if e["type"] == "analyze_retry"]
    assert all(n.startswith(feature.SPLIT_NOTICE_PREFIX) for n in narrations)
    assert sum(1 for n in narrations if "being condensed to its substantive claims" in n) == 6  # 3 per pass


async def test_a_reply_over_the_chunk_size_is_condensed_in_pieces_that_reach_the_comparison_as_one_block(
    make_conversation, analyze, local_fixtures
):
    """The failure measured on 2026-09-20: R1's reply was 15,460 characters and its single condense
    call never produced readable text inside 300 s, 570 s or 1,200 s. No condense message may quote
    more than `CONDENSE_CHUNK_CHARS`, so a reply over it is condensed in pieces whose claims are
    concatenated -- the comparison still sees exactly one block per label."""
    local_fixtures("analyst_split_chunked")
    big = reply(feature.CONDENSE_CHUNK_CHARS * 2 + 1500, "R1-BIG")
    small = reply(4_000, "other")
    responses = {"claude": big, "chatgpt": small, "grok": small}
    assert len(big) > feature.CONDENSE_CHUNK_CHARS
    conv = await persist(make_conversation(responses=responses))
    r, events = await analyze(conv.id)
    assert r.status_code == 200, r.text

    # R1 (claude in mock mode) is announced once as a split and once as a chunked reply.
    narrations = [e["error"] for e in events if e["type"] == "analyze_retry"]
    # Every one of them is progress, and the pane can only tell by the prefix (1fc9339 lost it).
    assert all(n.startswith(feature.SPLIT_NOTICE_PREFIX) for n in narrations), narrations
    assert any("3 pieces" in n and "R1" in n for n in narrations), narrations
    assert sum(1 for n in narrations if "being condensed to its substantive claims" in n) == 3

    calls = extraction_calls()
    assert len(calls) == 6  # three pieces for R1, one each for R2 and R3, then the comparison
    for call in calls[:5]:
        system, user = call["messages"]
        assert system["content"] == prompts.CONDENSE_SYSTEM
        quoted = blocks_of(user["content"])
        assert len(quoted) == 1  # one label per condense message, always
        assert len(next(iter(quoted.values()))) <= feature.CONDENSE_CHUNK_CHARS

    # …and the comparison quotes ONE block per label, R1's being the three pieces joined.
    system, user = calls[5]["messages"]
    assert system["content"] == prompts.SYSTEM
    condensed = blocks_of(user["content"])
    assert list(condensed) == list(LABELS)
    assert "piece 1" in condensed["R1"] and "piece 2" in condensed["R1"] and "piece 3" in condensed["R1"]
    assert big not in user["content"]  # the raw reply never reaches the comparison

    turn = events[-1]["turn"]
    assert turn["status"] == "ok" and turn["extraction"] is not None
    assert len(turn["raw_attempts"]) == 6  # every piece is reported
    assert turn["usage"]["totals"]["calls"] == 6  # and metered


async def test_the_condense_partial_is_returned_even_on_failure(monkeypatch):
    """Directly: `_condense` hands back whatever text arrived as its fourth value, on every path."""
    from backend.llm import client as llm_client
    from backend.schemas import Delta, Usage

    async def fake_stream(**_kw):
        yield Delta(kind="text", text='```json\n{"claims": [')   # a fragment: opens and stops
        yield Delta(kind="error", code="timeout", message="the reply never became a complete json document")

    monkeypatch.setattr(llm_client, "stream_completion", fake_stream)
    text, _usage, error, raw = await feature._condense(
        model="web:chatgpt:analyst", question="q", label="R1", response="a reply"
    )
    assert error is not None and "complete json" in error
    assert text == ""                       # nothing usable for the comparison
    assert raw == '```json\n{"claims": ['   # …but the fragment is preserved for the report
    del Usage


async def test_no_identity_leak_in_any_split_payload(
    make_conversation, analyze, local_fixtures, assert_no_identity_leak
):
    """The split adds two new Triplex-authored payloads (the condense prompt and the condensed
    comparison), so the anonymization firewall has to hold across all four calls: vendor words
    live only inside a delimited block, and no slot id appears anywhere."""
    local_fixtures("analyst_split")
    responses = responses_of(feature.SPLIT_MIN_CHARS + 3)
    conv = await persist(make_conversation(responses=responses))
    _, events = await analyze(conv.id)
    assert _types(events)[-1] == "analyze_done"
    allow = [DEFAULT_PROMPT, *responses.values()]
    for call in extraction_calls():
        text = messages_text(call["messages"])
        assert_no_identity_leak(text, allow=allow)
        outside = outside_blocks(text)
        for slot in ("claude", "chatgpt", "grok"):
            assert slot not in outside.lower(), f"{slot!r} outside a delimited block"


# --------------------------------------------------------------------------- oversize
async def test_a_single_reply_over_the_budget_degrades_loudly_with_no_analyst_call(
    make_conversation, analyze
):
    responses = {
        "claude": reply(200, "CLAUDE-BODY"),
        "chatgpt": reply(feature.REPLY_BUDGET_CHARS + 1_200, "CHATGPT-BODY"),
        "grok": reply(200, "GROK-BODY"),
    }
    conv = await persist(make_conversation(responses=responses))
    r, events = await analyze(conv.id)
    assert r.status_code == 200, r.text
    assert _types(events) == ["analyze_start", "analyze_degraded"]
    turn = events[-1]["turn"]
    assert turn["status"] == "degraded" and turn["extraction"] is None
    assert turn["raw_attempts"] == []
    error = turn["error"]
    assert "R2" in error  # the label, never the slot name
    assert f"{feature.REPLY_BUDGET_CHARS + 1_200:,}" in error
    assert f"{feature.REPLY_BUDGET_CHARS:,}" in error
    for slot in ("chatgpt", "claude", "grok"):
        assert slot not in error.lower()
    assert extraction_calls() == []  # nothing was typed anywhere
    assert turn["usage"]["totals"]["calls"] == 0


async def test_the_oversize_degrade_is_never_served_from_cache(make_conversation, analyze):
    responses = {
        "claude": reply(200, "CLAUDE-BODY"),
        "chatgpt": reply(feature.REPLY_BUDGET_CHARS + 1, "CHATGPT-BODY"),
        "grok": reply(200, "GROK-BODY"),
    }
    conv = await persist(make_conversation(responses=responses))
    ids = []
    for _ in range(2):
        _, events = await analyze(conv.id)
        assert _types(events) == ["analyze_start", "analyze_degraded"]
        ids.append(events[0]["turn_id"])
    assert ids[0] != ids[1]  # a degraded turn is never replayed: a fresh attempt is appended


# --------------------------------------------------------------------------- the web transport
async def test_the_split_runs_as_four_fresh_analyst_chats_on_a_web_session(
    client, web_env, fake_desktop, make_conversation
):
    """The transport this was built for: each condensation is its own hidden chat, so no single
    message carries more than one reply, and the comparison chat only ever sees the bullets."""
    responses = responses_of(feature.SPLIT_MIN_CHARS + 3)
    # What a web analyst types back: the claims as a FENCED json object, which is what the condense
    # prompt asks a web session for and what the capture will not end on until it balances (S10).
    claim_sets = [["claim one", "claim two"], ["claim three"], ["claim four"]]
    condensed = ["```json\n" + json.dumps({"claims": c}) + "\n```" for c in claim_sets]
    conv = make_conversation(responses=responses)
    conv.slot_config.analyst_model = "web:chatgpt:analyst"
    stored = await persist(conv)
    comparison = bridge_fixtures.planted("analyst.extraction.1.jsonl")
    desk = await fake_desktop({ANALYST: [*condensed, comparison]})

    r = await client.post(f"/api/conversations/{stored.id}/analyze", json={})
    assert r.status_code == 200, r.text
    events = parse_sse_text(r.text)
    assert _types(events)[-1] == "analyze_done"
    requests = desk.of(*ANALYST)
    assert len(requests) == 4
    for req, label in zip(requests[:3], LABELS, strict=True):
        assert req["fresh"] is True  # one condensation per chat: nothing else is in it
        assert f"<<<{label}>>>" in req["text"]
        assert len(req["text"]) <= feature.REPLY_BUDGET_CHARS + 2_768
        for other in LABELS:
            if other != label:
                assert f"<<<{other}>>>" not in req["text"]
    last = requests[3]
    assert last["fresh"] is True and prompts.SYSTEM_FENCED in last["text"]
    # The comparison quotes the CLAIMS, rendered back to bullet lines — never the analyst's raw
    # JSON envelope, which is transport packaging and has no business in the next prompt.
    for claims in claim_sets:
        for claim in claims:
            assert f"- {claim}" in last["text"]
    for raw in condensed:
        assert raw not in last["text"]
    for slot_reply in responses.values():
        assert slot_reply not in last["text"]
    assert desk.errors == [] and mock.calls == []


# --------------------------------------------------------------------------- the fenced retry
@pytest.mark.parametrize("fenced", [False, True])
def test_retry_follow_up_passes_the_transport_flag_through(fenced):
    follow_up = feature.retry_follow_up("{not json", "parse_error: x", fenced=fenced)
    assert follow_up[-1]["content"] == prompts.retry_message("parse_error: x", fenced=fenced)
    assert ("```json" in follow_up[-1]["content"]) is fenced
