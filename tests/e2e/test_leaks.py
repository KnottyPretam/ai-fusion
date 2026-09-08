"""Cross-feature leak sweep (PLAN.md §9 "Leak tests", docs/semantics.md "Anonymization / leaks").

For every committed scenario the whole flow runs for real and every Triplex-authored message --
each message of every analyst (extraction), defense and convergence payload captured in
`backend.llm.mock.calls` -- is scanned with `tests.helpers.find_identity_leaks`, allowing only
the user prompts and the raw slot replies (out of scope by the contract's rule). The `Api`
recorder additionally asserts that no HTTP response body ever contains "anon_map"."""

from __future__ import annotations

import pytest

from backend.config import FORBIDDEN_IDENTITY_STRINGS
from backend.llm import mock
from backend.schemas import SLOT_IDS
from tests.e2e.conftest import (
    ALL_SCENARIOS,
    TRIPLEX_PURPOSES,
    leak_report,
    raw_replies_served,
    triplex_messages,
)
from tests.helpers import find_identity_leaks

CONTINUE_PROMPT = "Now compare that with what OpenAI's ChatGPT or xAI's Grok might say."


@pytest.mark.parametrize("name", ALL_SCENARIOS)
async def test_no_identity_leak_in_any_triplex_authored_message(run_flow, api, name):
    f = await run_flow(name, grounded=(name == "grounded"))
    prompts = [f.prompt]
    if f.analyze is not None and f.analyze.status_code == 200:
        # A vendor-naming follow-up on one slot: the continue payload is that slot's own
        # thread + prompt (nothing Triplex-authored), and later fusion prompts must not echo
        # anything but delimited, scrubbed peer claims.
        await api.cont(f.cid, "claude", CONTINUE_PROMPT)
        prompts.append(CONTINUE_PROMPT)
    allow = prompts + raw_replies_served()
    authored = triplex_messages()
    if f.analyze is not None and f.analyze.status_code == 200:
        assert authored, "an ok/degraded Analyze must have produced analyst messages"
        assert {m.purpose for m in authored} >= {"extraction"}
    assert leak_report(allow) == {}
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


def test_forbidden_strings_cover_the_three_vendors_and_slot_ids():
    assert {"claude", "chatgpt", "grok", "openai", "anthropic", "x-ai"} <= set(
        FORBIDDEN_IDENTITY_STRINGS
    )
    assert find_identity_leaks("R1 vs R2 vs R3: the gyroscope range") == []
    assert find_identity_leaks("openai/gpt-5.6-luna") == ["-luna", "gpt", "openai"]
