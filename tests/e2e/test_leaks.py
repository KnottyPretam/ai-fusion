"""Cross-feature leak sweep (PLAN.md §9 "Leak tests", docs/semantics.md "Anonymization / leaks").

For every committed scenario the whole flow runs for real and every Triplex-authored message --
each message of every analyst (extraction), defense and convergence payload captured in
`backend.llm.mock.calls` -- is scanned with `tests.helpers.find_identity_leaks`, allowing only
what the contract's scope rule puts out of scope, PER payload (`scope_allow`): the user prompts
and, for a slot's defense payload, that slot's own replies (its thread). A vendor-naming continue
runs BEFORE Fusion so the round-1 challenge to claude really replays it as history. The `Api`
recorder additionally asserts that no HTTP response body ever contains "anon_map".

The committed corpus is vendor-free, so the sweep alone cannot tell whether `anon.scrub` runs:
`vendor_in_claims` (test-local, `tests/e2e/malformed.py`) plants vendor names in analyst-authored
text and proves they reach later prompts only as `[model]`."""

from __future__ import annotations

import pytest

from backend.config import FORBIDDEN_IDENTITY_STRINGS
from backend.llm import mock
from backend.prompts import fusion as fusion_prompts
from backend.schemas import SLOT_IDS
from tests.conftest import DEFAULT_PROMPT
from tests.e2e.conftest import (
    ALL_SCENARIOS,
    EXTRACTION_1,
    LOCAL_FIXTURES_DIR,
    TRIPLEX_PURPOSES,
    calls,
    challenge_of,
    delimited_blocks,
    fixture_text,
    leak_report,
    scope_allow,
    served_reply_texts,
    strip_delimited,
    triplex_messages,
)
from tests.e2e.malformed import VENDOR_CLAIM, VENDOR_TOPIC
from tests.helpers import find_identity_leaks

CONTINUE_PROMPT = "Now compare that with what OpenAI's ChatGPT or xAI's Grok might say."
FUSION_REFUSALS = ("nothing_to_fuse", "analyze_degraded", "incomplete_send_turn")
# What docs/semantics.md's scrub rule makes of the planted texts (spelled out, NOT computed with
# `anon.scrub`, so a disabled scrub fails on the prompts themselves): every identity string on
# a word boundary and every code name in slug context ("-luna") becomes `[model]`.
SCRUBBED_TOPIC = "[model] vs [model]-5.6[model] register map"
SCRUBBED_CLAIM = "[model]'s documentation says the gyroscope tops out at 1000 deg/s full scale."


@pytest.mark.parametrize("name", ALL_SCENARIOS)
async def test_no_identity_leak_in_any_triplex_authored_message(run_flow, api, name):
    f = await run_flow(name, grounded=(name == "grounded"), fusion=False)
    prompts = [f.prompt]
    analyzed = f.analyze is not None and f.analyze.status_code == 200
    if analyzed:
        # A vendor-naming follow-up on one slot BEFORE Fusion: the continue payload is that
        # slot's own thread + prompt (nothing Triplex-authored), and every later challenge to
        # claude replays that user turn and the sticky reply as history -- so the scope rule
        # (user prompts and a slot's own replies are out of scope) is exercised, not assumed.
        await api.cont(f.cid, "claude", CONTINUE_PROMPT)
        prompts.append(CONTINUE_PROMPT)
    r, events = await api.fusion(f.cid, {"max_iterations": f.max_iterations})
    if r.status_code != 200:
        assert r.status_code == 409 and r.json()["detail"]["error"] in FUSION_REFUSALS
    f.conv = await api.get(f.cid)
    authored = triplex_messages()
    if analyzed:
        assert authored, "an ok/degraded Analyze must have produced analyst messages"
        assert {m.purpose for m in authored} >= {"extraction"}
    assert leak_report(scope_allow(prompts, served_reply_texts())) == {}
    if f.expectations["exit_reason"] is not None:
        assert r.status_code == 200 and events[-1]["type"] == "fusion_done"
        # The claude defense payloads really carry the vendor-naming continue turn as history
        # (and its sticky reply), i.e. the allow list excised something that was there.
        history = [m for m in authored if m.role == "claude" and m.purpose == "defense"]
        assert any(m.message_role == "user" and m.content == CONTINUE_PROMPT for m in history)
        # The Triplex-authored challenge text itself is clean with NOTHING allowed.
        for c in calls("defense"):
            assert find_identity_leaks(challenge_of(c)) == []
    # Every scanned message really was one of the three Triplex-authored kinds.
    assert {m.purpose for m in authored} <= set(TRIPLEX_PURPOSES)
    # The scan is word-bounded and case-insensitive: it also covers the slot ids themselves.
    assert set(SLOT_IDS) <= set(FORBIDDEN_IDENTITY_STRINGS)
    # And no response body carried the mapping (enforced per call by `Api`; restated here).
    assert api.responses and all("anon_map" not in r.text for r in api.responses)
    documents = [
        r.json() for r in api.responses if r.headers["content-type"].startswith("application/json")
    ]
    assert documents and all("anon_map" not in d for d in documents if isinstance(d, dict))


async def test_leak_scanner_catches_a_planted_vendor_name(run_flow):
    """The sweep is not vacuous: planting a vendor name into a challenge payload is caught."""
    await run_flow("planted_factual")
    defense = next(c for c in mock.calls if c["purpose"] == "defense")
    defense["messages"][-1]["content"] += "\n(as Claude would put it)"
    report = leak_report([])
    assert report and all("claude" in leaks for leaks in report.values())


@pytest.fixture
def local_scenario(monkeypatch):
    """Serve a test-local scenario from tests/e2e/fixtures (README there)."""

    def _use(name: str) -> None:
        monkeypatch.setenv("MOCK_FIXTURES_DIR", str(LOCAL_FIXTURES_DIR))
        monkeypatch.setenv("MOCK_SCENARIO", name)
        mock.reset()

    return _use


async def test_vendor_names_in_analyst_text_reach_later_prompts_only_scrubbed(api, local_scenario):
    """Mutation-sensitivity for `anon.scrub`: `vendor_in_claims` plants vendor names and a slug
    code name in analyst-authored text (d1's topic and R2's claim), which is quoted into every
    challenge and the convergence payload. Deleting the scrub of the topic, of the peer block
    (`render_peer_block`) or of the convergence items in `backend/features/fusion.py` fails
    this test; the 14-scenario sweep above cannot see it because its fixtures are vendor-free."""
    local_scenario("vendor_in_claims")
    root = LOCAL_FIXTURES_DIR / "scenarios"
    # Negative control: the planted extraction really carries names the scanner knows.
    planted = fixture_text("vendor_in_claims", EXTRACTION_1, root)
    assert find_identity_leaks(planted) == ["-luna", "claude", "gpt", "openai"]
    assert find_identity_leaks(SCRUBBED_TOPIC + SCRUBBED_CLAIM) == []

    cid = (await api.create())["id"]
    await api.send(cid, DEFAULT_PROMPT)
    r, events = await api.analyze(cid)
    assert r.status_code == 200 and events[-1]["type"] == "analyze_done"
    d1 = events[-1]["turn"]["extraction"]["divergences"][0]
    assert d1["topic"] == VENDOR_TOPIC and d1["positions"][1]["claim"] == VENDOR_CLAIM
    r, events = await api.fusion(cid, {"max_iterations": 1})
    assert r.status_code == 200 and events[-1]["type"] == "fusion_done"
    assert events[-1]["exit_reason"] == "converged"  # R2's justified revise still passes

    for slot in SLOT_IDS:
        challenge = challenge_of(calls("defense", slot)[0])
        blocks = delimited_blocks(challenge)
        assert blocks[fusion_prompts.TOPIC_LABEL] == SCRUBBED_TOPIC, slot
        assert (
            VENDOR_TOPIC not in challenge and find_identity_leaks(strip_delimited(challenge)) == []
        )
        if slot == "chatgpt":
            # A label's OWN claim is quoted back to it verbatim (docs/semantics.md scrubs peers,
            # the topic and the convergence payload -- not a label's own position), and only
            # there: R2 sees no <<<R2>>> block of itself.
            assert blocks[fusion_prompts.CLAIM_LABEL] == VENDOR_CLAIM and "R2" not in blocks
            own = {fusion_prompts.CLAIM_LABEL}
        else:
            assert blocks["R2"].startswith(f"Claim: {SCRUBBED_CLAIM}\n"), slot
            assert VENDOR_CLAIM not in challenge
            own = set()
        rest = "\n".join(body for label, body in blocks.items() if label not in own)
        assert find_identity_leaks(rest) == [], slot
    convergence = calls("convergence")[0]["messages"][1]["content"]
    assert SCRUBBED_TOPIC in convergence and VENDOR_TOPIC not in convergence
    assert find_identity_leaks(convergence) == []

    # The scoped sweep reports exactly R2's own-claim block and nothing else ...
    texts = served_reply_texts(root)
    report = leak_report(scope_allow([DEFAULT_PROMPT], texts))
    r2_calls = [
        i for i, c in enumerate(mock.calls) if (c["role"], c["purpose"]) == ("chatgpt", "defense")
    ]
    assert set(report) == {(i, len(mock.calls[i]["messages"]) - 1) for i in r2_calls}
    assert all(leaks == ["openai"] for leaks in report.values())
    # ... and is clean once that one contractual exception is granted.
    own_positions = {"chatgpt": [VENDOR_CLAIM]}
    assert leak_report(scope_allow([DEFAULT_PROMPT], texts, own_positions=own_positions)) == {}


def test_forbidden_strings_cover_the_three_vendors_and_slot_ids():
    assert {"claude", "chatgpt", "grok", "openai", "anthropic", "x-ai"} <= set(
        FORBIDDEN_IDENTITY_STRINGS
    )
    assert find_identity_leaks("R1 vs R2 vs R3: the gyroscope range") == []
    assert find_identity_leaks("openai/gpt-5.6-luna") == ["-luna", "gpt", "openai"]
