"""The condense step's claims cap, its targeted second pass and the condensation cache (2026-10-15).

THE MEASURED RUN: a Send whose replies were 7,747 / 24,963 / 6,065 characters (a 466-character
question). Analyze ran 16 sequential condense calls on a reasoning analyst page (34.5 min) and still
degraded at 33,196 characters after two passes, because the condense prompt asked for EVERY claim
with no count: 343 claim lines (~99 characters each) came back on pass 1 and 340 on pass 2 -- a
rewrite, not a reduction. A Fusion click then re-ran the whole chain, because a degraded Analyze is
never cached and Fusion auto-runs Analyze whenever no ok one exists.

So: each label is asked for at most its share of what ONE comparison message can carry, sized so
that one pass fits (`features.analyze.label_claims_cap`, `share_per_piece`); more than asked is kept
with one WARNING, never cut; pass 2 re-condenses only the blocks over their share of the room; and a
successful condensation is cached in memory, so re-running over the same text makes no condense call.
"""

from __future__ import annotations

import json
import logging
import math
import re
from collections.abc import Callable
from typing import Any

import pytest

from backend.features import analyze as feature
from backend.features import refactor as refactor_feature
from backend.llm import client as llm_client
from backend.prompts import analyze as prompts
from backend.prompts import refactor as refactor_prompts
from backend.schemas import LABELS, Delta, Usage
from tests.analyze.conftest import blocks_of, extraction_calls, extraction_text, persist
from tests.conftest import DEFAULT_PROMPT
from tests.helpers import find_identity_leaks

WEB_ANALYST = "web:chatgpt:analyst"
FILLER = "The gyroscope full-scale range is selectable in four steps up to 2000 deg/s. "
CONDENSE_HEAD = "You are condensing ONE anonymous expert response"
CAP_RE = re.compile(r"Return at most (\d+) claims")


def reply(chars: int, marker: str) -> str:
    """A reply of exactly `chars` characters starting with `marker` (test_split's shape)."""
    body = f"{marker}. " + FILLER * (chars // len(FILLER) + 2)
    return body[:chars]


def responses_of(total: int) -> dict[str, str]:
    each = total // 3
    return {
        "claude": reply(each, "CLAUDE-BODY"),
        "chatgpt": reply(each, "CHATGPT-BODY"),
        "grok": reply(total - 2 * each, "GROK-BODY"),
    }


def the_cap(question: str = DEFAULT_PROMPT) -> int:
    return feature.label_claims_cap(feature.condense_room(question), 3)


def claim(label: str, pass_no: int, i: int) -> str:
    """~100 characters, like the measured bullets; unique per label, pass and index."""
    return f"{label} pass-{pass_no} claim {i:03d}: the full-scale range is selectable up to 2000 dps in four steps"


def _usage(kw: dict[str, Any]) -> Usage:
    return Usage(model=kw["model"], role=kw["role"], purpose=kw["purpose"], prompt_tokens=1)


class FakeAnalyst:
    """Stands in for `client.stream_completion` (so `mock.calls` stays empty: `requests` is the
    record). A condense message is answered with `count(label, pass_no, asked)` claims -- the pass
    read off the quoted text, since a pass-2 message quotes pass-1 claims, and `asked` the cap the
    message carries -- each padded to `length` characters when that is longer; the comparison is
    answered with the planted_factual extraction."""

    def __init__(self, count: Callable[[str, int, int], int], *, length: int = 0):
        self.count = count
        self.length = length
        self.requests: list[list[dict[str, str]]] = []
        self._issued = 0

    def condense_requests(self) -> list[list[dict[str, str]]]:
        return [m for m in self.requests if m[0]["content"].startswith(CONDENSE_HEAD)]

    async def __call__(self, **kw: Any):
        messages = kw["messages"]
        self.requests.append(messages)
        if messages[0]["content"].startswith(CONDENSE_HEAD):
            ((label, quoted),) = blocks_of(messages[1]["content"]).items()
            pass_no = 2 if "pass-1 claim" in quoted else 1
            asked = int(CAP_RE.search(messages[0]["content"]).group(1))
            claims = []
            for _ in range(self.count(label, pass_no, asked)):
                self._issued += 1
                claims.append(claim(label, pass_no, self._issued).ljust(self.length, "~"))
            text = json.dumps({"claims": claims})
        else:
            text = extraction_text("planted_factual")
        yield Delta(kind="text", text=text)
        yield Delta(kind="done", usage=_usage(kw))


# --------------------------------------------------------------------------- the arithmetic
def test_the_measured_run_asks_for_32_claims_a_label_shared_16_7_16_over_its_pieces():
    question = "q" * 466
    room = feature.condense_room(question)
    assert room == 19_534
    cap = feature.label_claims_cap(room, 3)
    assert cap == 32
    lengths = {"R1": 7_747, "R2": 24_963, "R3": 6_065}
    pieces = {label: len(feature.chunk_reply("x" * chars)) for label, chars in lengths.items()}
    assert pieces == {"R1": 2, "R2": 5, "R3": 2}
    per_piece = {label: feature.share_per_piece(cap, p) for label, p in pieces.items()}
    assert per_piece == {"R1": 16, "R2": 7, "R3": 16}


def test_the_room_is_the_comparison_bound_less_what_rides_along_with_the_blocks():
    question, graph = "why? " * 100, "- a --[feeds]--> b\n" * 40
    assert feature.condense_room(question, graph) == (
        feature.CONDENSED_MAX_CHARS - feature.comparison_chars(question, {}, graph)
    )
    assert feature.condense_room(question) == feature.CONDENSED_MAX_CHARS - len(question)


def test_a_full_set_of_capped_blocks_fits_one_comparison_message_with_margin():
    """The cap is sized so ONE pass fits: n labels at their cap, at the assumed bullet length, fill
    CONDENSE_TARGET_FRACTION of the room at most."""
    assert (feature.CLAIM_CHARS_ASSUMED, feature.CONDENSE_TARGET_FRACTION) == (120, 0.6)
    for n in range(2, 6):
        for question in ("q", DEFAULT_PROMPT, "q" * 466, "q" * 5_000):
            room = feature.condense_room(question)
            cap = feature.label_claims_cap(room, n)
            assert n * cap * feature.CLAIM_CHARS_ASSUMED <= room * feature.CONDENSE_TARGET_FRACTION


def test_no_message_is_asked_for_fewer_than_four_claims():
    assert feature.CONDENSE_CLAIMS_MIN == 4
    assert feature.share_per_piece(32, 10) == 4
    assert feature.share_per_piece(0, 1) == 4
    assert feature.share_per_piece(-3, 1) == 4  # a question that fills the room on its own
    assert feature.share_per_piece(33, 1) == 33
    # rounded UP: a piece never gets less than its share
    assert feature.share_per_piece(33, 2) == 17
    with pytest.raises(ValueError):
        feature.share_per_piece(32, 0)


def test_pass_two_asks_a_block_that_kept_its_cap_for_fewer_claims_than_it_holds():
    """Review 2026-10-15: a block that OBEYED its pass-1 cap with long bullets holds at most that
    cap, so asking it for the same cap again -- spread over its pieces and rounded up, 33 -> 17 + 17
    -- asked for at least as many claims as it had: an identity rewrite. Pass 2 sizes the cap from
    the block itself: its bullets at the length they came back with fill CONDENSE_TARGET_FRACTION
    of its share of the room, and never more than the pass-1 cap."""
    room = feature.condense_room(DEFAULT_PROMPT)
    k = feature.label_claims_cap(room, 3)
    block = "\n".join(f"- {'a load-bearing claim at length ' * 11}{i}" for i in range(k))
    assert len(block) > room / 3  # over its share, at k claims of ~350 characters
    pieces = len(feature.chunk_reply(block))
    assert pieces == 2
    assert feature.share_per_piece(k, pieces) * pieces >= k  # the old ask: the identity rewrite
    cap = feature.block_claims_cap(k, len(block), room, 3)
    assert feature.share_per_piece(cap, pieces) * pieces < k  # the new one asks for fewer
    assert cap * len(block) / k <= room / 3 * feature.CONDENSE_TARGET_FRACTION
    # a block that ignored its cap with short bullets is asked for the pass-1 cap, never more
    assert feature.block_claims_cap(300, 300 * 90, room, 3) == k


@pytest.mark.parametrize(("pieces", "expected"), [(1, 12), (2, 6), (3, 4), (4, 4), (5, 4), (6, 4)])
def test_refactor_claims_per_piece_is_unchanged_by_the_delegation(pieces, expected):
    old = max(4, math.ceil(refactor_prompts.REPLY_CLAIMS_MAX / pieces))  # the formula it replaced
    assert expected == old
    assert refactor_feature.claims_per_piece(pieces) == expected
    assert refactor_feature.claims_per_piece(pieces) == feature.share_per_piece(
        refactor_prompts.REPLY_CLAIMS_MAX, pieces
    )


# --------------------------------------------------------------------------- the prompt
def test_the_cap_clause_appears_only_when_a_cap_is_given():
    plain = prompts.condense_system_for(3)
    assert plain == prompts.CONDENSE_SYSTEM
    assert "Return at most" not in plain
    clause = prompts.CONDENSE_CAP_CLAUSE.format(max_claims=7)
    assert clause.startswith("Return at most 7 claims: the ones the answer rests on")
    assert "rather than merging several into one" in clause  # refactor's wording, same reason
    for n in range(2, 6):
        for fenced in (False, True):
            uncapped = prompts.condense_system_for(n, fenced=fenced)
            capped = prompts.condense_system_for(n, fenced=fenced, max_claims=7)
            assert capped.count(clause) == 1
            assert capped.replace(clause, "") == uncapped  # the clause is the ONLY difference
            # …and it sits right before the "Do not add" paragraph
            assert capped.index(clause) + len(clause) == capped.index("Do not add, resolve")
    messages = prompts.condense_messages("Q?", "R2", "beta", max_claims=9)
    assert messages[0]["content"] == prompts.condense_system_for(3, max_claims=9)
    assert messages[1] == prompts.condense_messages("Q?", "R2", "beta")[1]
    assert prompts.condense_messages("Q?", "R2", "beta") == prompts.condense_messages(
        "Q?", "R2", "beta", max_claims=None
    )
    assert find_identity_leaks(prompts.CONDENSE_CAP_CLAUSE) == []


@pytest.mark.parametrize("bad", [0, -1, True, 2.5, "7"])
def test_the_cap_must_be_a_positive_count(bad):
    with pytest.raises(ValueError):
        prompts.condense_system_for(3, max_claims=bad)  # type: ignore[arg-type]


def test_the_notices_carry_the_cap_after_the_prefix():
    prefix = f"{feature.SPLIT_NOTICE_PREFIX}: "
    split = feature.split_notice("R2", 24_963, 38_775, max_claims=32)
    assert split.startswith(prefix) and split.endswith(" (at most 32 claims)")
    again = feature.split_notice(
        "R2", 9_000, 21_000, bound=feature.CONDENSED_MAX_CHARS, pass_no=2, max_claims=32
    )
    assert again.startswith(prefix) and "condensed again" in again
    assert again.endswith(" (at most 32 claims)")
    chunk = feature.chunk_notice("R2", 24_963, 5, max_claims=7)
    assert chunk.startswith(prefix) and chunk.endswith("in 5 pieces (at most 7 claims each)")
    # without a cap, the text is what it was
    assert "at most" not in feature.split_notice("R2", 1, 2)
    assert feature.chunk_notice("R1", 1, 2).endswith("condensed in 2 pieces")
    reuse = feature.reuse_notice("R3", 2, 5)
    assert reuse.startswith(prefix) and "(reused)" in reuse and "piece 2 of 5" in reuse
    assert "piece" not in feature.reuse_notice("R1")


# --------------------------------------------------------------------------- the run
async def test_claims_over_the_cap_are_kept_with_one_warning_per_label(
    make_conversation, analyze, monkeypatch, caplog
):
    """R1 is quoted in two pieces and each answers three more claims than asked: every claim
    reaches the comparison, and ONE warning (not one per piece) says so. R2 and R3 answer within
    their cap and are not mentioned."""
    cap = the_cap()
    per_piece = feature.share_per_piece(cap, 2)
    fake = FakeAnalyst(lambda label, _pass, _asked: per_piece + 3 if label == "R1" else 3)
    monkeypatch.setattr(llm_client, "stream_completion", fake)
    responses = {
        "claude": reply(9_000, "R1"),  # two pieces
        "chatgpt": reply(4_000, "R2"),
        "grok": reply(4_000, "R3"),
    }
    conv = await persist(make_conversation(responses=responses))
    with caplog.at_level(logging.WARNING, logger="triplex.features.analyze"):
        r, events = await analyze(conv.id)
    assert r.status_code == 200, r.text
    assert events[-1]["type"] == "analyze_done", events[-1]
    asked = [int(CAP_RE.search(m[0]["content"]).group(1)) for m in fake.condense_requests()]
    assert asked == [per_piece, per_piece, cap, cap]  # R1's two pieces share its cap; R2, R3 whole
    comparison = blocks_of(fake.requests[-1][1]["content"])
    assert len(comparison["R1"].splitlines()) == 2 * (per_piece + 3)  # all kept, none cut
    assert len(comparison["R2"].splitlines()) == 3
    warnings = [
        r.getMessage()
        for r in caplog.records
        if r.name == "triplex.features.analyze" and r.levelno == logging.WARNING
    ]
    assert len(warnings) == 1, warnings
    assert "R1" in warnings[0] and str(2 * (per_piece + 3)) in warnings[0]
    assert str(2 * per_piece) in warnings[0] and "kept all" in warnings[0]
    narrations = [e["error"] for e in events if e["type"] == "analyze_retry"]
    assert all(n.startswith(feature.SPLIT_NOTICE_PREFIX) for n in narrations)
    assert sum(1 for n in narrations if n.endswith(f"(at most {cap} claims)")) == 3
    assert any(n.endswith(f"in 2 pieces (at most {per_piece} claims each)") for n in narrations)


async def test_pass_two_condenses_only_the_blocks_over_their_share(
    make_conversation, analyze, monkeypatch
):
    """R1 ignores its cap on pass 1 (220 claims, ~19,100 characters) while R2 and R3 stay well
    under their share: the set is over the bound, so a second pass runs -- for R1 ALONE. R2's and
    R3's pass-1 blocks reach the comparison byte for byte, and no pass-2 message quotes them."""

    def count(label: str, pass_no: int, _asked: int) -> int:
        if pass_no == 2:
            return 9
        return 220 if label == "R1" else 30

    fake = FakeAnalyst(count)
    monkeypatch.setattr(llm_client, "stream_completion", fake)
    conv = await persist(make_conversation(responses=responses_of(feature.SPLIT_MIN_CHARS + 3)))
    r, events = await analyze(conv.id)
    assert r.status_code == 200, r.text
    assert events[-1]["type"] == "analyze_done", events[-1].get("turn", {}).get("error")
    turn = events[-1]["turn"]
    pass_one = dict(zip(LABELS[:3], turn["raw_attempts"][:3], strict=True))
    room = feature.condense_room(DEFAULT_PROMPT)
    assert len(pass_one["R1"]) > room / 3  # over its share…
    assert len(pass_one["R2"]) < room / 3 and len(pass_one["R3"]) < room / 3  # …and under it
    assert feature.comparison_chars(DEFAULT_PROMPT, pass_one) > feature.CONDENSED_MAX_CHARS

    condense = fake.condense_requests()
    r1_pieces = feature.chunk_reply(pass_one["R1"])
    assert len(r1_pieces) > 1
    assert len(condense) == 3 + len(r1_pieces)  # pass 1 for all three, pass 2 for R1 only
    r1_cap = feature.block_claims_cap(220, len(pass_one["R1"]), room, 3)
    assert r1_cap == the_cap()  # 220 claims came back: the block's own measure is no tighter
    for messages in condense[3:]:
        assert list(blocks_of(messages[1]["content"])) == ["R1"]
        asked = int(CAP_RE.search(messages[0]["content"]).group(1))
        assert asked == feature.share_per_piece(r1_cap, len(r1_pieces))
    assert len(fake.requests) == len(condense) + 1  # then exactly one comparison

    comparison = blocks_of(fake.requests[-1][1]["content"])
    assert comparison["R2"] == pass_one["R2"] and comparison["R3"] == pass_one["R3"]
    assert "pass-2 claim" in comparison["R1"] and "pass-1 claim" not in comparison["R1"]
    assert turn["status"] == "ok" and turn["usage"]["totals"]["calls"] == len(fake.requests)
    again = [e["error"] for e in events if e["type"] == "analyze_retry" and "again" in e["error"]]
    assert len(again) == 1 and "R1's condensed block" in again[0]


async def test_pass_two_shrinks_blocks_that_kept_their_cap_with_long_bullets(
    make_conversation, analyze, monkeypatch
):
    """Review 2026-10-15, as a run: the analyst obeys every cap, but its bullets are ~350
    characters, so three capped blocks are still over the bound. Pass 2 asks each block for FEWER
    claims than it holds and the comparison runs. With the pass-1 cap asked again (17 per piece of
    a 33-claim block) the same run took six more calls to the same refusal at 35,054 characters."""
    fake = FakeAnalyst(lambda _label, _pass, asked: asked, length=350)  # keeps to every cap
    monkeypatch.setattr(llm_client, "stream_completion", fake)
    conv = await persist(make_conversation(responses=responses_of(feature.SPLIT_MIN_CHARS + 3)))
    r, events = await analyze(conv.id)
    assert r.status_code == 200, r.text
    assert events[-1]["type"] == "analyze_done", events[-1].get("turn", {}).get("error")

    k, room = the_cap(), feature.condense_room(DEFAULT_PROMPT)
    condense = fake.condense_requests()
    asked = [int(CAP_RE.search(m[0]["content"]).group(1)) for m in condense]
    assert asked[:3] == [k, k, k]
    pass_one = dict(zip(LABELS[:3], events[-1]["turn"]["raw_attempts"][:3], strict=True))
    assert all(len(block) > room / 3 for block in pass_one.values())  # every block over its share
    assert all(len(block.splitlines()) == k for block in pass_one.values())  # …at exactly its cap
    position = 3
    for label, block in pass_one.items():
        pieces = len(feature.chunk_reply(block))
        expected = feature.share_per_piece(feature.block_claims_cap(k, len(block), room, 3), pieces)
        mine = condense[position : position + pieces]
        assert all(list(blocks_of(m[1]["content"])) == [label] for m in mine)
        assert asked[position : position + pieces] == [expected] * pieces
        assert expected * pieces < k  # fewer than the block holds: a reduction, not a rewrite
        position += pieces
    assert position == len(condense)
    comparison = blocks_of(fake.requests[-1][1]["content"])
    assert feature.comparison_chars(DEFAULT_PROMPT, comparison) <= feature.CONDENSED_MAX_CHARS
    assert len(fake.requests) == len(condense) + 1


# --------------------------------------------------------------------------- the cache
async def test_a_second_analyze_of_the_same_split_makes_no_condense_call(
    make_conversation, analyze, local_fixtures
):
    """The Fusion-click re-run: the same split again (force, so the turn cache is bypassed) answers
    every condensation from memory -- no call, nothing booked, each narrated as reused -- and still
    makes its one comparison call, which is never cached. Clearing the cache calls again."""
    local_fixtures("analyst_split")
    conv = await persist(make_conversation(responses=responses_of(feature.SPLIT_MIN_CHARS + 3)))
    _, first = await analyze(conv.id)
    assert first[-1]["type"] == "analyze_done"
    assert len(extraction_calls()) == 4

    _, second = await analyze(conv.id, {"force": True})
    assert second[-1]["type"] == "analyze_done"
    calls = extraction_calls()
    assert len(calls) == 5  # no condense call, one comparison
    assert calls[4]["messages"][0]["content"] == prompts.SYSTEM
    assert calls[4]["messages"] == calls[3]["messages"]  # the same comparison over the same claims
    reused = [
        e["error"] for e in second if e["type"] == "analyze_retry" and "(reused)" in e["error"]
    ]
    assert len(reused) == 3
    assert all(n.startswith(feature.SPLIT_NOTICE_PREFIX) for n in reused)
    assert [label for label in LABELS[:3] if any(f"{label}'s" in n for n in reused)] == list(
        LABELS[:3]
    )
    turn = second[-1]["turn"]
    assert turn["id"] != first[-1]["turn"]["id"]
    assert turn["usage"]["totals"]["calls"] == 1  # a reused condensation books nothing
    assert turn["raw_attempts"][:3] == first[-1]["turn"]["raw_attempts"][:3]

    feature.clear_condense_cache()
    local_fixtures("analyst_split")  # fresh mock counters and call log
    _, third = await analyze(conv.id, {"force": True})
    assert third[-1]["type"] == "analyze_done"
    assert len(extraction_calls()) == 4  # three condensations again, then the comparison
    assert not any("(reused)" in e["error"] for e in third if e["type"] == "analyze_retry")


async def test_a_condensation_that_ignored_its_cap_is_asked_again_on_a_re_run(
    make_conversation, analyze, monkeypatch
):
    """Review 2026-10-15: R1 answers 300 claims whatever it is asked (the measured failure mode) and
    the set is refused after two passes. Had those condensations been cached, a forced Re-run would
    replay the same refusal with no call made -- for as long as the process lived. They are not: the
    Re-run asks R1 again, a now-compliant R1 fits in one pass, and only R2 and R3, which kept to
    their cap, are reused."""
    ignores = {"R1": True}
    fake = FakeAnalyst(lambda label, _pass, _asked: 300 if ignores.get(label) else 10)
    monkeypatch.setattr(llm_client, "stream_completion", fake)
    conv = await persist(make_conversation(responses=responses_of(feature.SPLIT_MIN_CHARS + 3)))
    _, first = await analyze(conv.id)
    assert first[-1]["type"] == "analyze_degraded"
    assert "condense passes" in first[-1]["turn"]["error"]  # condense_ineffective
    made = len(fake.requests)
    assert made > 3 and fake.requests == fake.condense_requests()  # no comparison was sent

    ignores["R1"] = False
    _, second = await analyze(conv.id, {"force": True})
    assert second[-1]["type"] == "analyze_done", second[-1].get("turn", {}).get("error")
    new = fake.requests[made:]
    assert len(new) == 2  # R1 condensed again, then the comparison
    assert list(blocks_of(new[0][1]["content"])) == ["R1"]
    assert new[1][0]["content"] == prompts.SYSTEM
    reused = [
        e["error"] for e in second if e["type"] == "analyze_retry" and "(reused)" in e["error"]
    ]
    assert [label for label in LABELS[:3] if any(f"{label}'s" in n for n in reused)] == ["R2", "R3"]


def _scripted(monkeypatch, *replies: list[Delta]) -> list[list[dict[str, str]]]:
    """`client.stream_completion` answering the n-th call with `replies[n]` (sticky-last)."""
    seen: list[list[dict[str, str]]] = []

    async def fake(**kw: Any):
        seen.append(kw["messages"])
        for d in replies[min(len(seen), len(replies)) - 1]:
            yield d.model_copy(update={"usage": _usage(kw)}) if d.kind == "done" else d

    monkeypatch.setattr(llm_client, "stream_completion", fake)
    return seen


OK = [
    Delta(kind="text", text='```json\n{"claims": ["one", "two"]}\n```'),
    Delta(kind="done"),
]
FAIL = [Delta(kind="error", code="timeout", message="the capture timed out")]


async def _condense(response: str = "a reply", **kw: Any):
    return await feature._condense(
        model=WEB_ANALYST, question="q", label="R1", response=response, **kw
    )


async def test_a_hit_returns_the_claims_with_no_call_and_empty_usage(monkeypatch):
    seen = _scripted(monkeypatch, OK)
    text, usage, error, raw, claims, reused = await _condense()
    assert (text, error, claims, reused) == ("- one\n- two", None, 2, False)
    assert usage.totals.calls == 1 and len(seen) == 1
    text, usage, error, raw, claims, reused = await _condense()
    assert (text, error, raw, claims, reused) == ("- one\n- two", None, "- one\n- two", 2, True)
    assert usage.totals.calls == 0 and usage.calls == []
    assert len(seen) == 1  # no call made


async def test_only_a_successful_condensation_is_cached(monkeypatch):
    seen = _scripted(monkeypatch, FAIL, OK)
    *_, error, _raw, _claims, reused = await _condense()
    assert error is not None and not reused
    *_, error, _raw, _claims, reused = await _condense()  # the failure was not remembered
    assert error is None and not reused and len(seen) == 2
    *_, error, _raw, _claims, reused = await _condense()
    assert error is None and reused and len(seen) == 2


async def test_a_condensation_over_its_cap_is_not_cached(monkeypatch):
    seen = _scripted(monkeypatch, OK)  # two claims, every time
    await _condense(max_claims=1)
    *_, claims, reused = await _condense(max_claims=1)
    assert claims == 2 and not reused and len(seen) == 2  # over its cap: asked again
    await _condense(max_claims=2)
    *_, reused = await _condense(max_claims=2)
    assert reused and len(seen) == 3  # at its cap: remembered


async def test_anything_that_changes_the_message_is_a_different_entry(monkeypatch):
    seen = _scripted(monkeypatch, OK)
    await _condense(max_claims=5)
    await _condense(max_claims=6)  # another cap
    await _condense(n=2)  # another council size
    await _condense(response="another reply")
    await feature._condense(model="ollama:hermes3", question="q", label="R1", response="a reply")
    assert len(seen) == 5
    *_, reused = await _condense(max_claims=5)
    assert reused and len(seen) == 5
    assert feature.condense_cache_key("m", [{"role": "user", "content": "x"}]) == (
        feature.condense_cache_key("m", [{"content": "x", "role": "user"}])  # canonical: key order
    )


async def test_the_cache_keeps_the_newest_entries_up_to_its_bound(monkeypatch):
    seen = _scripted(monkeypatch, OK)
    size = feature.CONDENSE_CACHE_MAX
    assert size == 64
    for i in range(size + 1):
        await _condense(f"reply {i}")
    assert len(seen) == size + 1
    *_, reused = await _condense(f"reply {size}")  # the newest is still there
    assert reused and len(seen) == size + 1
    *_, reused = await _condense("reply 0")  # the oldest was evicted
    assert not reused and len(seen) == size + 2
