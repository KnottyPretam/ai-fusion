"""The web no-retry rule on Fusion's two `complete_json(retries=1)` calls (S7 review: "Fusion's
convergence retry re-types the whole payload into a NEW hidden analyst chat"). Over the real HTTP
API with `web_env` and a `fake_desktop`: a site reply that carries no text at all is NOT corrected
-- exactly ONE request frame for that (slot, view, purpose) in the round -- while a reply WITH
output that fails parsing still gets the correction attempt in the SAME chat (`fresh: false`).

The analyst case is the expensive one: the convergence follow-up would carry no assistant echo, so
`bridge.text_for` reads it as a new analyst conversation (`fresh: true`) and the whole payload is
typed a second time into a brand-new chat in the user's own account (twice per round, so up to ten
fresh chats at `max_iterations: 5`). tests/analyze/test_web_no_retry.py is the same rule on the
Analyze path (`retries=0`, driven by the feature)."""

from __future__ import annotations

from typing import Any

import pytest

from backend.llm import client as client_mod
from backend.llm import mock
from backend.prompts import fusion as fusion_prompts
from tests.bridge.conftest import planted, planted_script
from tests.e2e.conftest import assert_fusion_stream_invariants, scenario_prompt
from tests.helpers import parse_sse_text

PROMPT = scenario_prompt("planted_factual")
CONVERGENCE = ("chatgpt", "analyst", "convergence")
EXTRACTION = ("chatgpt", "analyst", "extraction")
DEFENSE = ("chatgpt", "pane", "defense")
PROSE = "I will defend my claim, but here is prose instead of the JSON object you asked for."
GOOD_DEFENSE = planted("chatgpt.defense.1.jsonl")
EMPTY = ["", "   \n\t"]


async def _send_analyze(client) -> str:
    r = await client.post("/api/conversations", json={})
    assert r.status_code == 201, r.text
    cid = r.json()["id"]
    r = await client.post(f"/api/conversations/{cid}/send", json={"prompt": PROMPT})
    assert r.status_code == 200, r.text
    assert parse_sse_text(r.text)[-1]["type"] == "turn_done"
    r = await client.post(f"/api/conversations/{cid}/analyze", json={})
    assert r.status_code == 200, r.text
    events = parse_sse_text(r.text)
    assert [e["type"] for e in events] == ["analyze_start", "analyze_done"]
    return cid


async def _fusion(client, cid: str, max_iterations: int) -> list[dict[str, Any]]:
    r = await client.post(
        f"/api/conversations/{cid}/fusion", json={"max_iterations": max_iterations}
    )
    assert r.status_code == 200, r.text
    return parse_sse_text(r.text)


def _exchange(events: list[dict[str, Any]], label: str) -> dict[str, Any]:
    (found,) = [e for e in events if e["type"] == "exchange" and e["model"] == label]
    return found


# ------------------------------------------------------- the convergence call (analyst view)
@pytest.mark.parametrize("empty", EMPTY)
async def test_empty_convergence_reply_is_asked_once_per_round(
    client, web_env, fake_desktop, empty
):
    """One convergence frame per round, not two: the divergence stays standing and Fusion runs
    out of iterations (before the fix: four frames for two rounds, every one of them fresh)."""
    desk = await fake_desktop(planted_script({CONVERGENCE: empty}))
    cid = await _send_analyze(client)
    events = await _fusion(client, cid, 2)
    turn = assert_fusion_stream_invariants(events)

    convergences = desk.of(*CONVERGENCE)
    assert len(convergences) == 2  # exactly one per round
    assert [r["fresh"] for r in convergences] == [True, True]  # an analyst call is always fresh
    assert all(r["text"].startswith(fusion_prompts.CONVERGENCE_SYSTEM) for r in convergences)
    assert len({r["req_id"] for r in convergences}) == 2

    assert turn["exit_reason"] == "max_iterations"
    assert turn["final"] == [{"divergence_id": "d1", "status": "standing"}]
    assert [r["round"] for r in events if r["type"] == "round_done"] == [1, 2]
    assert len(desk.of(*DEFENSE)) == 2  # the revise was typed once per round, not re-asked
    assert len(desk.of(*EXTRACTION)) == 1
    assert desk.errors == [] and desk.cancels == [] and mock.calls == []


async def test_unparsable_convergence_reply_is_still_corrected_in_the_same_chat(
    client, web_env, fake_desktop
):
    """Output that fails parsing has something to correct: the second frame is the correction
    message alone, continuing the same analyst chat (`fresh: false`)."""
    good = planted("analyst.convergence.1.jsonl")
    desk = await fake_desktop(planted_script({CONVERGENCE: ["Both sides now agree.", good]}))
    cid = await _send_analyze(client)
    events = await _fusion(client, cid, 2)
    turn = assert_fusion_stream_invariants(events)
    assert turn["exit_reason"] == "converged"
    assert turn["final"] == [{"divergence_id": "d1", "status": "resolved"}]

    first, second = desk.of(*CONVERGENCE)
    assert first["fresh"] is True and second["fresh"] is False
    assert first["req_id"] != second["req_id"]
    assert second["text"].startswith("Your previous output failed validation:")
    assert second["text"].endswith("Return only the corrected JSON.")
    assert desk.errors == [] and mock.calls == []


# ------------------------------------------------------------ the defense call (pane view)
@pytest.mark.parametrize("empty", EMPTY)
async def test_empty_defense_reply_is_asked_once(client, web_env, fake_desktop, empty):
    """A pane defense with no text is one `unavailable` exchange and ONE typed challenge: the
    correction message alone would be a pointless second submit into the site's own thread."""
    desk = await fake_desktop(planted_script({DEFENSE: empty}))
    cid = await _send_analyze(client)
    events = await _fusion(client, cid, 1)
    turn = assert_fusion_stream_invariants(events)

    assert len(desk.of(*DEFENSE)) == 1
    assert desk.of(*DEFENSE)[0]["fresh"] is False
    exchange = _exchange(events, "R2")  # chatgpt is R2 in the fixed mock map
    assert exchange["stance"] == "unavailable"
    assert exchange["error"] == "parse_error: empty response"
    assert exchange["confidence"] is None

    # The other two slots defended, so nothing changed: stalemate, with no analyst call.
    assert turn["exit_reason"] == "stalemate"
    assert desk.of(*CONVERGENCE) == []
    conv = (await client.get(f"/api/conversations/{cid}")).json()
    assert [m["kind"] for m in conv["threads"]["chatgpt"]] == ["chat", "chat"]  # the send only
    assert desk.errors == [] and mock.calls == []


async def test_unparsable_defense_reply_is_still_corrected_in_the_same_chat(
    client, web_env, fake_desktop
):
    desk = await fake_desktop(planted_script({DEFENSE: [PROSE, GOOD_DEFENSE]}))
    cid = await _send_analyze(client)
    events = await _fusion(client, cid, 1)
    turn = assert_fusion_stream_invariants(events)

    first, second = desk.of(*DEFENSE)
    assert first["fresh"] is False and second["fresh"] is False
    assert first["req_id"] != second["req_id"]
    assert second["text"].startswith("Your previous output failed validation:")
    assert second["text"].endswith("Return only the corrected JSON.")
    exchange = _exchange(events, "R2")
    assert exchange["stance"] == "revise" and exchange["error"] is None
    assert turn["exit_reason"] == "converged"
    assert desk.errors == [] and mock.calls == []


# --------------------------------------------------------------------------- the rule itself
def test_web_retry_suppressed_is_web_only_and_no_output_only():
    assert client_mod.web_retry_suppressed("web:chatgpt:analyst", "")
    assert client_mod.web_retry_suppressed("web:chatgpt", "   \n\t")
    assert client_mod.web_retry_suppressed("web:grok", "")
    assert not client_mod.web_retry_suppressed("web:chatgpt:analyst", "{not json")
    assert not client_mod.web_retry_suppressed("ollama:hermes3", "")
    assert not client_mod.web_retry_suppressed("openai/gpt-5", "")
