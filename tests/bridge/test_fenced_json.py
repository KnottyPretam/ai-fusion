"""The fenced-JSON contract over the web transport (S7 review; the defect MEASURED live on
2026-09-17 with a real Send followed by an Analyze against the hidden analyst page).

What was measured: the analyst answered with the right SHAPE but unescaped inner quotes --
`{"statement":"The reply is exactly "PING-1"."}` -- on both attempts, so Analyze degraded with
`parse_error: no JSON object found in the response`. A web reply is read back out of the page's
RENDERED markdown (`desktop/preload/site.cjs` `toMarkdown`/`replyText`), and CommonMark resolves a
backslash escape before any ASCII punctuation, so the correct `\\"PING-1\\"` the analyst wrote was
rendered -- and captured -- as a bare `"PING-1"`. Applying that one rule to the JSON the analyst
must have emitted reproduces the captured bytes exactly (the first test below), and both attempts
broke identically -- a deterministic transform, which a stochastic model slip would not be.

The fix has two halves, both asserted here over the real HTTP flow with a fake desktop:
1. a `web:` model is asked for a ```json FENCE (a fenced block resolves no escapes, so it survives
   the round trip) -- every other clause of the analyst and challenge prompts is unchanged;
2. `extract_json` prefers a fence's content, and for a `web:` model only, re-escapes unescaped
   inner quotes as a last resort -- so the measured reply now parses instead of degrading.

The API transports keep Appendix A's "no prose, no code fences" byte for byte: pinned by
tests/analyze/test_prompt.py, tests/fusion/test_prompts.py and the tests/e2e goldens.
"""

from __future__ import annotations

import json
import re
from typing import Any

from backend.llm import mock
from backend.prompts import QUOTED_DATA_NOTICE
from backend.prompts import analyze as analyze_prompts
from backend.prompts import fusion as fusion_prompts
from backend.schemas import SLOT_IDS
from tests.bridge.conftest import planted, planted_script
from tests.bridge.test_flow import PROMPT, create, get, stream

# The captured analyst reply, verbatim from the live run (unescaped inner quotes, no fence).
MEASURED_REPLY = (
    '{"agreements":[{"topic":"Requested output","statement":"The reply is exactly "PING-1".",'
    '"models":["R1","R2","R3"]}],"divergences":[]}'
)
# What the analyst must have written for the page to render the bytes above.
EMITTED_REPLY = MEASURED_REPLY.replace('"PING-1"', '\\"PING-1\\"')
STATEMENT = 'The reply is exactly "PING-1".'

FENCED_EXTRACTION = "```json\n" + EMITTED_REPLY + "\n```"
ANALYST = ("chatgpt", "analyst", "extraction")


def fence_body(text: str) -> str:
    """The content of the first ```json fence in `text` (the analyst's own reply, as captured)."""
    m = re.search(r"```json[ \t]*\r?\n(.*?)```", text, re.DOTALL)
    assert m, text
    return m.group(1)


async def run(client, cid: str, *steps: tuple[str, dict[str, Any]]) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    for path, body in steps:
        r, evs = await stream(client, f"/api/conversations/{cid}/{path}", body)
        assert r.status_code == 200, r.text
        events = evs
    return events


# ------------------------------------------------------------------ the root cause, from the bytes
def test_the_render_rule_reproduces_the_measured_bytes():
    """CommonMark resolves `\\<punctuation>` in a PARAGRAPH: applying that single rule to the JSON
    the analyst emitted gives the captured text byte for byte, which is the whole root cause. The
    same bytes inside a fenced block are left alone, so the fence is the fix."""
    assert json.loads(EMITTED_REPLY)["agreements"][0]["statement"] == STATEMENT
    rendered = re.sub(r"\\([!-/:-@\[-`{-~])", r"\1", EMITTED_REPLY)
    assert rendered == MEASURED_REPLY
    # ... and the measured bytes are not JSON at all, which is exactly how Analyze degraded.
    try:
        json.loads(MEASURED_REPLY)
    except ValueError:
        pass
    else:  # pragma: no cover - the premise of this whole module
        raise AssertionError("the measured reply must not parse")


# ------------------------------------------------------------------ the analyst asks for a fence
async def test_web_analyst_is_asked_for_a_fence_and_a_fenced_reply_parses(
    client, web_env, fake_desktop
):
    desk = await fake_desktop(planted_script({ANALYST: FENCED_EXTRACTION}))
    cid = await create(client)
    events = await run(client, cid, ("send", {"prompt": PROMPT}), ("analyze", {}))

    assert [e["type"] for e in events] == ["analyze_start", "analyze_done"]  # no retry
    turn = events[-1]["turn"]
    assert turn["status"] == "ok"
    assert turn["extraction"]["agreements"][0]["statement"] == STATEMENT
    assert turn["raw_attempts"] == [FENCED_EXTRACTION]  # the fence is kept verbatim on the turn

    (extraction,) = desk.of(*ANALYST)
    text = extraction["text"]
    assert analyze_prompts.JSON_INSTRUCTION_FENCED in text
    assert analyze_prompts.JSON_INSTRUCTION not in text  # never both
    assert "```json" in text and "no prose, no code fences" not in text
    # every other clause is the API one, unchanged: swapping the instruction back gives SYSTEM
    assert text.startswith(analyze_prompts.SYSTEM_FENCED)
    assert (
        analyze_prompts.SYSTEM_FENCED.replace(
            analyze_prompts.JSON_INSTRUCTION_FENCED, analyze_prompts.JSON_INSTRUCTION
        )
        == analyze_prompts.SYSTEM
    )
    assert mock.calls == [] and desk.errors == []


async def test_the_measured_unescaped_quote_reply_is_repaired_not_degraded(
    client, web_env, fake_desktop
):
    """The regression the live run hit: a model that answers in PROSE anyway (the rendered page ate
    its escapes) must no longer degrade -- the quote repair recovers the analyst's own statement,
    in ONE attempt, with no correction retry."""
    desk = await fake_desktop(planted_script({ANALYST: MEASURED_REPLY}))
    cid = await create(client)
    events = await run(client, cid, ("send", {"prompt": PROMPT}), ("analyze", {}))

    assert [e["type"] for e in events] == ["analyze_start", "analyze_done"]
    turn = events[-1]["turn"]
    assert turn["status"] == "ok" and turn["error"] is None
    assert turn["extraction"]["agreements"][0]["statement"] == STATEMENT
    assert turn["extraction"]["divergences"] == []
    assert turn["raw_attempts"] == [MEASURED_REPLY]  # the raw capture is still shown as captured
    assert len(desk.of(*ANALYST)) == 1
    assert mock.calls == [] and desk.errors == []


async def test_a_fence_holding_broken_json_still_degrades(client, web_env, fake_desktop):
    """The repair is narrow: a fenced reply that is not JSON at all (and cannot be repaired by
    re-escaping quotes) still fails both attempts and degrades, as before."""
    broken = "```json\nAgreements: none, divergences: none.\n```"
    desk = await fake_desktop(planted_script({ANALYST: broken}))
    cid = await create(client)
    events = await run(client, cid, ("send", {"prompt": PROMPT}), ("analyze", {}))

    assert [e["type"] for e in events] == ["analyze_start", "analyze_retry", "analyze_degraded"]
    turn = events[-1]["turn"]
    assert turn["status"] == "degraded" and turn["error"].startswith("parse_error")
    assert turn["raw_attempts"] == [broken, broken]
    assert mock.calls == [] and desk.errors == []


# ------------------------------------------------------------------ fusion over the web transport
async def test_web_challenge_asks_for_a_fence_and_a_fenced_defense_parses(
    client, web_env, fake_desktop
):
    fenced_defense = {
        (slot, "pane", "defense"): "```json\n" + planted(f"{slot}.defense.1.jsonl") + "\n```"
        for slot in SLOT_IDS
    }
    desk = await fake_desktop(planted_script(fenced_defense))
    cid = await create(client)
    events = await run(
        client,
        cid,
        ("send", {"prompt": PROMPT}),
        ("analyze", {}),
        ("fusion", {"max_iterations": 2}),
    )
    assert events[-1]["type"] == "fusion_done"
    turn = events[-1]["turn"]

    # every fenced defense parsed: no slot came back `unavailable`
    stances = [x["stance"] for r in turn["rounds"] for x in r["exchanges"]]
    assert stances and "unavailable" not in stances
    assert turn["final"] == [{"divergence_id": "d1", "status": "resolved"}]

    defenses = [r for r in desk.requests if r["purpose"] == "defense"]
    assert len(defenses) == 3
    for req in defenses:
        text = req["text"]
        assert fusion_prompts.DEFENSE_JSON_LEAD_FENCED in text
        assert fusion_prompts.DEFENSE_JSON_LEAD not in text
        # every other clause of the challenge is unchanged (Appendix A order)
        assert text.startswith(QUOTED_DATA_NOTICE)
        assert fusion_prompts.ANTI_SYCOPHANCY_CLAUSE in text
        assert "<<<YOUR CLAIM>>>" in text and "<<<TOPIC>>>" in text
        assert '"persuaded_by"' in text  # the key list is shared with the API variant
    # the fenced reply is what the challenged thread keeps, verbatim
    conv = await get(client, cid)
    for slot in SLOT_IDS:
        reply = [m for m in conv["threads"][slot] if m["kind"] == "fusion_reply"][0]["content"]
        assert reply.startswith("```json") and reply.endswith("```")
        assert json.loads(fence_body(reply))["stance"] in ("defend", "revise")

    (convergence,) = [r for r in desk.requests if r["purpose"] == "convergence"]
    assert fusion_prompts.CONVERGENCE_JSON_LEAD_FENCED in convergence["text"]
    assert fusion_prompts.CONVERGENCE_JSON_LEAD not in convergence["text"]
    assert mock.calls == [] and desk.errors == []
