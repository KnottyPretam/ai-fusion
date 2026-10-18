"""Read again (2026-10-15): POST /api/conversations/{id}/turns/{turn_id}/slots/{slot}/reread over the
bridge -- a Send slot whose pane capture gave up while the site was still answering is read out of the
pane again and the Send completed, so Analyze can run. The ASGI `client`, a `fake_desktop` answering
`reread` frames under `(slot, "pane", "reread")`, and `web_env`; the mock is never reached."""

from __future__ import annotations

import asyncio
import contextvars
import uuid
from typing import Any

import pytest

from backend import api_errors
from backend.features import reread as reread_feature
from backend.llm import mock
from backend.schemas import DEFAULT_COUNCIL, AnalyzeTurn, ContinueTurn, RefactorTurn, SendTurn
from backend.store import conversations as store
from tests.bridge.conftest import NOT_CAPTURED, planted, planted_script
from tests.e2e.conftest import one, scenario_prompt
from tests.helpers import parse_sse_text

PROMPT = scenario_prompt("planted_factual")
# The default council's slots -- `BRIDGE_SLOTS` also holds `gemini` since 2026-10-17 (no seat here).
CHAT = {slot: planted(f"{slot}.chat.1.jsonl") for slot in DEFAULT_COUNCIL}
# What the adapter reported on 2026-10-15 at 06:42 (claude.ai, still thinking at its 300 s budget).
STILL_ANSWERING = (
    "the reply was still in progress after 300000 ms [containers=1 followed=0 connected=true "
    "anchor=1 order=oldest geom=yes presubmit=0 stopNow=true stopSeen=true end=- md=0 pre=0 code=0 "
    "reply=181 inner=414 textContent=547 maxContainer=414 rect=367×52 viewport=432×691]"
)
STUCK = {"error": "timeout", "message": STILL_ANSWERING, "partial": "Flagging considerations"}


async def create(client) -> str:
    r = await client.post("/api/conversations", json={})
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def get(client, cid: str) -> dict[str, Any]:
    r = await client.get(f"/api/conversations/{cid}")
    assert r.status_code == 200, r.text
    return r.json()


async def send(client, cid: str) -> list[dict[str, Any]]:
    r = await client.post(f"/api/conversations/{cid}/send", json={"prompt": PROMPT})
    assert r.status_code == 200, r.text
    return parse_sse_text(r.text)


def url(cid: str, turn_id: str, slot: str) -> str:
    return f"/api/conversations/{cid}/turns/{turn_id}/slots/{slot}/reread"


async def reread(client, cid: str, turn_id: str, slot: str):
    r = await client.post(url(cid, turn_id, slot))
    return r, (parse_sse_text(r.text) if r.status_code == 200 else [])


async def stuck_send(client, fake_desktop, reread_entry: Any = None):
    """A Send whose claude capture gave up still answering; the fake desktop answers the re-read."""
    overrides: dict[Any, Any] = {("claude", "pane", "chat"): STUCK}
    if reread_entry is not None:
        overrides[("claude", "pane", "reread")] = reread_entry
    desk = await fake_desktop(planted_script(overrides))
    cid = await create(client)
    events = await send(client, cid)
    err = one(events, "slot_error", "claude")
    assert err["code"] == "timeout" and err["error_type"] == "site"
    turn_id = (await get(client, cid))["turns"][0]["id"]
    return desk, cid, turn_id


# --------------------------------------------------------------------------- the flow
async def test_reread_completes_the_send_and_analyze_runs(client, web_env, fake_desktop):
    desk, cid, turn_id = await stuck_send(client, fake_desktop, CHAT["claude"])
    r = await client.post(f"/api/conversations/{cid}/analyze", json={})
    assert r.status_code == 409
    assert r.json() == {"detail": {"error": "incomplete_send_turn", "missing": ["claude"]}}

    r, events = await reread(client, cid, turn_id, "claude")
    assert r.status_code == 200, r.text
    assert events == [
        {"type": "reread_start", "turn_id": turn_id, "slot": "claude"},
        {
            "type": "reread_done",
            "turn_id": turn_id,
            "slot": "claude",
            "chars": len(CHAT["claude"]),
            "done_by": "quiet",
        },
    ]
    (frame,) = desk.rereads
    assert frame == {
        "type": "reread",
        "req_id": frame["req_id"],
        "slot": "claude",
        "text": PROMPT,  # exactly what the Send typed: the adapter's anchor
        "conversation_id": cid,
        "timeout_s": 10,  # the pane grant (web_env's BRIDGE_TIMEOUT_S)
    }

    conv = await get(client, cid)
    turn = conv["turns"][0]
    assert turn["responses"] == CHAT
    assert turn["errors"] == {} and turn["partial"] == {}
    msgs = conv["threads"]["claude"]
    assert [(m["role"], m["content"], m["turn_id"]) for m in msgs] == [
        ("user", PROMPT, turn_id),
        ("assistant", CHAT["claude"], turn_id),
    ]
    assert msgs[0]["meta"] is None and msgs[1]["meta"] == {"reread": True}
    for slot in ("chatgpt", "grok"):
        assert len(conv["threads"][slot]) == 2, "the other slots are untouched"

    r = await client.post(f"/api/conversations/{cid}/analyze", json={})
    assert r.status_code == 200, r.text
    analyze = parse_sse_text(r.text)
    assert analyze[-1]["type"] == "analyze_done" and analyze[-1]["turn"]["status"] == "ok"

    # the slot is filled now, and an Analyze after the Send does not make it stale
    r, _ = await reread(client, cid, turn_id, "claude")
    assert r.status_code == 409 and r.json()["detail"]["error"] == "already_captured"
    r, _ = await reread(client, cid, analyze[-1]["turn"]["id"], "claude")
    assert r.status_code == 422 and r.json()["detail"]["error"] == "not_a_send_turn"
    assert mock.calls == [] and desk.errors == []


@pytest.mark.parametrize(
    ("entry", "code", "error_type", "message"),
    [
        ({"error": "timeout", "message": STILL_ANSWERING}, "timeout", "site", STILL_ANSWERING),
        (
            {"error": "reply_not_found", "message": "no reply"},
            "reply_not_found",
            "site",
            "no reply",
        ),
        (
            NOT_CAPTURED,
            "not_captured",
            "triplex",
            "capture is off for claude; the reply is in the site pane",
        ),
        ({"reject": "logged_out", "message": "signed out"}, "logged_out", "site", "signed out"),
    ],
)
async def test_a_failed_reread_writes_nothing(
    client, web_env, fake_desktop, entry, code, error_type, message
):
    desk, cid, turn_id = await stuck_send(client, fake_desktop, entry)
    before = await get(client, cid)
    r, events = await reread(client, cid, turn_id, "claude")
    assert r.status_code == 200, r.text
    assert events == [
        {"type": "reread_start", "turn_id": turn_id, "slot": "claude"},
        {
            "type": "reread_error",
            "turn_id": turn_id,
            "slot": "claude",
            "code": code,
            "message": message,
            "error_type": error_type,
        },
    ]
    assert await get(client, cid) == before, "the turn keeps its original error"
    assert len(desk.rereads) == 1 and desk.errors == []


async def test_a_blank_reread_reply_is_empty_reply_and_never_persisted(
    client, web_env, fake_desktop
):
    _, cid, turn_id = await stuck_send(client, fake_desktop, "   \n")
    before = await get(client, cid)
    _, events = await reread(client, cid, turn_id, "claude")
    assert events[-1]["type"] == "reread_error" and events[-1]["code"] == "empty_reply"
    assert await get(client, cid) == before


async def test_reread_without_a_desktop_is_bridge_unavailable(client, web_env):
    cid = await create(client)
    events = await send(client, cid)
    assert one(events, "slot_error", "claude")["code"] == "bridge_unavailable"
    turn_id = (await get(client, cid))["turns"][0]["id"]
    _, events = await reread(client, cid, turn_id, "claude")
    assert events[-1]["type"] == "reread_error"
    assert (events[-1]["code"], events[-1]["error_type"]) == ("bridge_unavailable", "triplex")


# --------------------------------------------------------------------------- pre-checks
async def test_prechecks_404_409_in_contract_order(client, web_env, fake_desktop):
    _, cid, turn_id = await stuck_send(client, fake_desktop, CHAT["claude"])
    cases = [
        (
            url(str(uuid.uuid4()), turn_id, "claude"),
            404,
            {"error": "not_found", "what": "conversation"},
        ),
        (url(cid, str(uuid.uuid4()), "claude"), 404, {"error": "not_found", "what": "turn"}),
        (url(cid, turn_id, "qwen"), 404, {"error": "not_found", "what": "slot"}),
        (url(cid, turn_id, "chatgpt"), 409, {"error": "already_captured"}),
    ]
    for target, status, detail in cases:
        r = await client.post(target)
        assert r.status_code == status, (target, r.text)
        assert r.json() == {"detail": detail}


async def test_something_typed_after_the_send_makes_it_stale(client, web_env, fake_desktop):
    desk, cid, turn_id = await stuck_send(client, fake_desktop, CHAT["claude"])
    # a second Send typed into claude's pane: the newest prompt there is not this one
    await send(client, cid)
    r, _ = await reread(client, cid, turn_id, "claude")
    assert r.status_code == 409
    assert r.json() == {"detail": {"error": "reread_stale", "since": "send"}}
    assert desk.rereads == []


async def test_busy_conversation_is_409_busy_last(client, web_env, fake_desktop):
    desk, cid, turn_id = await stuck_send(client, fake_desktop, CHAT["claude"])

    async def foreign(coro):  # another holder: the guard is re-entrant for its own context
        return await asyncio.create_task(coro, context=contextvars.Context())

    async with store.busy_guard(cid):
        r = await foreign(client.post(url(cid, turn_id, "claude")))
        assert r.status_code == 409 and r.json() == {"detail": {"error": "busy"}}
        r = await foreign(client.post(url(cid, turn_id, "chatgpt")))
        assert r.status_code == 409 and r.json()["detail"]["error"] == "already_captured"
    assert desk.rereads == [] and not store.is_busy(cid)


# --------------------------------------------------------------------------- resolve (unit)
def _web(conv, *slots: str) -> None:
    """Put `slots` on their own web pane in the conversation's and its turns' configs."""
    for cfg in [conv.slot_config, *(t.slot_config for t in conv.turns)]:
        for slot in slots:
            cfg.slots[slot].model = f"web:{slot}"


def test_resolve_refuses_a_model_that_is_not_a_web_pane(make_conversation):
    conv = make_conversation(responses={"claude": None, "chatgpt": "b", "grok": "c"})
    turn = conv.turns[0]
    with pytest.raises(api_errors.HTTPException) as e:  # OpenRouter: there is no page to read
        reread_feature.resolve(conv, turn.id, "claude")
    assert (e.value.status_code, e.value.detail["error"]) == (422, "not_a_web_pane")
    assert e.value.detail["model"] == turn.slot_config.slots["claude"].model
    turn.slot_config.slots["claude"].model = "web:claude:analyst"  # answered on the hidden page
    with pytest.raises(api_errors.HTTPException) as e:
        reread_feature.resolve(conv, turn.id, "claude")
    assert e.value.detail == {"error": "not_a_web_pane", "model": "web:claude:analyst"}
    _web(conv, "claude")
    assert reread_feature.resolve(conv, turn.id, "claude") is turn


def test_resolve_analyze_and_refactor_are_quiet_any_other_later_turn_is_stale(make_conversation):
    conv = make_conversation(responses={"claude": None, "chatgpt": "b", "grok": "c"})
    _web(conv, *DEFAULT_COUNCIL)
    turn = conv.turns[0]
    cfg = conv.slot_config.model_copy(deep=True)
    conv.turns.append(AnalyzeTurn(of_turn=turn.id, status="degraded", error="x", slot_config=cfg))
    conv.turns.append(RefactorTurn(of_turn=turn.id, status="degraded", error="x", slot_config=cfg))
    assert reread_feature.resolve(conv, turn.id, "claude") is turn
    conv.turns.append(ContinueTurn(slot="grok", prompt="more", slot_config=cfg))
    with pytest.raises(api_errors.HTTPException) as e:
        reread_feature.resolve(conv, turn.id, "claude")
    assert e.value.detail == {"error": "reread_stale", "since": "continue"}


# --------------------------------------------------------------------------- the store write
async def test_complete_send_slot_refuses_without_writing(persisted_conversation):
    conv = persisted_conversation
    turn = conv.turns[0]
    assert isinstance(turn, SendTurn)
    with pytest.raises(ValueError, match="blank"):
        await store.complete_send_slot(conv.id, turn.id, "claude", "  ")
    with pytest.raises(ValueError, match="already holds"):
        await store.complete_send_slot(conv.id, turn.id, "claude", "text")
    with pytest.raises(ValueError, match="not a send turn"):
        await store.complete_send_slot(conv.id, "missing", "claude", "text")
    assert await store.load(conv.id) == conv
