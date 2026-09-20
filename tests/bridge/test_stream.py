"""`bridge.stream`: the contract's delta mapping for every result / reject shape, the text rule,
`parse_web_model`, `build_request`, the INFO line (no text), cancel on early close."""

from __future__ import annotations

import asyncio
import logging

import pytest

from backend.llm import bridge
from backend.llm import bridge_protocol as bp
from backend.llm.bridge import build_request, parse_web_model, text_for
from tests.bridge.conftest import DROP, NOT_CAPTURED, FakeConnection, hello

MSGS = [{"role": "user", "content": "What is the maximum gyro range?"}]
ANALYST_MSGS = [
    {"role": "system", "content": "You are the analyst."},
    {"role": "user", "content": "Compare R1, R2 and R3."},
]


async def collect(**kw):
    base = dict(role="chatgpt", purpose="chat", model="web:chatgpt", messages=MSGS, max_tokens=100)
    base.update(kw)
    return [d async for d in bridge.stream(**base)]


def kinds(deltas):
    return [d.kind for d in deltas]


# --------------------------------------------------------------------------- captured results
async def test_captured_text_is_one_text_delta_then_done(fake_desktop):
    desk = await fake_desktop({("chatgpt", "pane", "chat"): "At sea level water boils at 100 C."})
    deltas = await collect()
    assert kinds(deltas) == ["text", "done"]
    assert deltas[0].text == "At sea level water boils at 100 C."
    done = deltas[1]
    assert done.finish_reason == "stop" and done.truncated is False and done.generation_id is None
    u = done.usage
    assert (u.model, u.role, u.purpose) == ("web:chatgpt", "chatgpt", "chat")
    assert (u.prompt_tokens, u.completion_tokens, u.reasoning_tokens, u.cost_usd) == (0, 0, 0, 0.0)
    assert desk.errors == [] and desk.cancels == []


@pytest.mark.parametrize("text", ["", "   \n\t"])
async def test_empty_captured_text_is_done_only(fake_desktop, text):
    await fake_desktop({"*": text})
    deltas = await collect()
    assert kinds(deltas) == ["done"]  # run_send's empty-reply rule takes it from here


async def test_not_captured_is_a_triplex_error_with_the_contract_message(fake_desktop):
    await fake_desktop({("grok", "pane", "chat"): NOT_CAPTURED})
    deltas = await collect(role="grok", model="web:grok")
    assert kinds(deltas) == ["error"]
    e = deltas[0]
    assert e.code == "not_captured" and e.error_type == "triplex"
    assert e.message == "capture is off for grok; the reply is in the site pane"


# --------------------------------------------------------------------------- failures
@pytest.mark.parametrize("code", sorted(bp.REJECT_CODES))
async def test_rejected_maps_to_a_site_error(fake_desktop, code):
    await fake_desktop({"*": {"reject": code, "message": f"the site said {code}"}})
    deltas = await collect()
    assert kinds(deltas) == ["error"]
    e = deltas[0]
    assert (e.code, e.error_type, e.message) == (code, "site", f"the site said {code}")


@pytest.mark.parametrize("code", sorted(bp.RESULT_CODES))
async def test_failed_result_maps_to_a_site_error(fake_desktop, code):
    await fake_desktop({"*": {"error": code, "message": f"failed: {code}"}})
    deltas = await collect()
    assert kinds(deltas) == ["error"]
    e = deltas[0]
    assert (e.code, e.error_type, e.message) == (code, "site", f"failed: {code}")


async def test_failed_result_partial_text_precedes_the_error(fake_desktop):
    await fake_desktop({"*": {"error": "timeout", "message": "late", "partial": "At sea level"}})
    deltas = await collect()
    assert kinds(deltas) == ["text", "error"]
    assert deltas[0].text == "At sea level"
    assert deltas[1].code == "timeout" and deltas[1].error_type == "site"


async def test_no_connection_is_bridge_unavailable():
    deltas = await collect()
    assert kinds(deltas) == ["error"]
    assert deltas[0].code == "bridge_unavailable" and deltas[0].error_type == "triplex"


async def test_no_ack_is_bridge_no_ack(fake_desktop, monkeypatch):
    monkeypatch.setenv("BRIDGE_ACCEPT_TIMEOUT_S", "0.05")
    desk = await fake_desktop({"*": DROP})
    deltas = await collect()
    assert kinds(deltas) == ["error"]
    assert deltas[0].code == "bridge_no_ack" and deltas[0].error_type == "triplex"
    await asyncio.sleep(0)
    assert desk.cancels == [desk.requests[0]["req_id"]]


async def test_result_timeout_is_timeout_with_cancel_sent(fake_desktop, monkeypatch):
    monkeypatch.setenv("BRIDGE_TIMEOUT_S", "0.1")
    desk = await fake_desktop({"*": {"delay_ms": 5000, "drop": True}})
    deltas = await collect()
    assert kinds(deltas) == ["error"]
    assert deltas[0].code == "timeout" and deltas[0].error_type == "triplex"
    await asyncio.sleep(0)
    assert desk.cancels == [desk.requests[0]["req_id"]]
    assert desk.requests[0]["timeout_s"] == 1  # the frame's budget is an int >= 1


async def test_disconnect_mid_request_is_bridge_disconnected(fake_desktop):
    desk = await fake_desktop({"*": {"delay_ms": 5000, "drop": True}})
    task = asyncio.create_task(collect())
    await asyncio.sleep(0.02)
    assert len(desk.requests) == 1
    bridge.hub.detach(desk.conn)
    deltas = await task
    assert kinds(deltas) == ["error"]
    assert deltas[0].code == "bridge_disconnected" and deltas[0].error_type == "triplex"


@pytest.mark.parametrize(
    "model",
    ["", "web:", "web:gemini", "web:claude:pane", "web:claude:analyst:x", "openai/gpt-5", "web"],
)
async def test_bad_model_is_bridge_bad_model_and_sends_nothing(fake_desktop, model):
    desk = await fake_desktop({"*": "never"})
    deltas = await collect(model=model)
    assert kinds(deltas) == ["error"]
    assert deltas[0].code == "bridge_bad_model" and deltas[0].error_type == "triplex"
    assert desk.requests == [] and desk.conn.outbox == []


async def test_consumer_cancellation_sends_cancel(fake_desktop):
    desk = await fake_desktop({"*": {"delay_ms": 5000, "drop": True}})
    task = asyncio.create_task(collect())
    await asyncio.sleep(0.02)
    assert len(desk.requests) == 1
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)
    await asyncio.sleep(0)
    assert desk.cancels == [desk.requests[0]["req_id"]]
    assert bridge.hub.status()["inflight"] == 0


# --------------------------------------------------------------------------- the request frame
async def test_request_frame_fields_and_conversation_scope(fake_desktop):
    desk = await fake_desktop({"*": "ok"})
    with bridge.conversation_scope("conv-123"):
        await collect(
            role="analyst", purpose="extraction", model="web:grok:analyst", messages=ANALYST_MSGS
        )
    await collect(role="claude", purpose="defense", model="web:claude", max_tokens=None)
    analyst, pane = desk.requests
    assert analyst["model"] == "web:grok:analyst" and analyst["slot"] == "grok"
    assert analyst["view"] == "analyst" and analyst["fresh"] is True
    assert analyst["text"] == "You are the analyst.\n\nCompare R1, R2 and R3."
    assert analyst["role"] == "analyst" and analyst["purpose"] == "extraction"
    assert analyst["conversation_id"] == "conv-123" and analyst["timeout_s"] == 600
    assert pane["model"] == "web:claude" and pane["view"] == "pane" and pane["fresh"] is False
    assert pane["text"] == MSGS[-1]["content"] and pane["conversation_id"] is None
    assert pane["role"] == "claude" and pane["purpose"] == "defense"
    for frame in desk.requests:
        assert bp.parse_server_frame(frame).type == "request"
        assert frame["req_id"] != analyst["req_id"] or frame is analyst
    assert analyst["req_id"] != pane["req_id"]


async def test_info_line_per_request_carries_no_text(fake_desktop, caplog):
    caplog.set_level(logging.INFO, logger="triplex.llm.bridge")
    secret = "SECRET-PROMPT-TEXT-9f86d081"
    await fake_desktop(
        {("chatgpt", "pane", "chat"): "SECRET-REPLY-TEXT", ("grok", "pane", "chat"): NOT_CAPTURED}
    )
    await collect(messages=[{"role": "user", "content": secret}])
    await collect(role="grok", model="web:grok", messages=[{"role": "user", "content": secret}])
    lines = [r.getMessage() for r in caplog.records if r.name == "triplex.llm.bridge"]
    assert len(lines) == 2
    assert (
        lines[0].startswith("bridge req=")
        and " slot=chatgpt view=pane purpose=chat ok ms=" in lines[0]
    )
    assert " slot=grok view=pane purpose=chat code=not_captured ms=" in lines[1]
    for line in lines:
        assert secret not in line and "SECRET-REPLY-TEXT" not in line


async def test_info_line_names_the_end_signal_and_the_captured_length(fake_desktop, caplog):
    """Workstream E: the 2026-09-20 analyze failure had to be reconstructed from stored character
    counts because the one INFO line per request recorded neither which end signal ended the
    capture nor how much text came back. A 13-character capture ended by `stop_gone` is now
    visible in the log the moment it happens -- and still without a byte of the reply."""
    caplog.set_level(logging.INFO, logger="triplex.llm.bridge")
    fragment = "```JSON\n{\n```"  # byte for byte what the failing analyst capture handed back
    await fake_desktop(
        {
            ("chatgpt", "analyst", "extraction"): {"text": fragment, "done_by": "stop_gone"},
            ("grok", "pane", "chat"): {"error": "timeout", "partial": "half a reply"},
        }
    )
    await collect(
        role="analyst", purpose="extraction", model="web:chatgpt:analyst", messages=ANALYST_MSGS
    )
    await collect(role="grok", model="web:grok")
    lines = [r.getMessage() for r in caplog.records if r.name == "triplex.llm.bridge"]
    assert len(lines) == 2
    assert " purpose=extraction ok ms=" in lines[0]
    assert " done_by=stop_gone chars=13" in lines[0]
    # A failed result reports what the site had produced: the partial is what the caller sees.
    assert " code=timeout ms=" in lines[1] and " done_by=- chars=12" in lines[1]
    for line in lines:
        assert fragment not in line and "half a reply" not in line
        assert "Compare R1" not in line


async def test_the_info_line_reports_no_end_signal_when_nothing_was_captured(fake_desktop, caplog):
    caplog.set_level(logging.INFO, logger="triplex.llm.bridge")
    await fake_desktop({"*": NOT_CAPTURED})
    await collect()
    (line,) = [r.getMessage() for r in caplog.records if r.name == "triplex.llm.bridge"]
    assert " code=not_captured ms=" in line and line.endswith(" done_by=- chars=0")


# --------------------------------------------------------------------------- pure helpers
@pytest.mark.parametrize(
    "model,expected",
    [
        ("web:claude", ("claude", "pane")),
        ("web:chatgpt", ("chatgpt", "pane")),
        ("web:grok", ("grok", "pane")),
        ("web:chatgpt:analyst", ("chatgpt", "analyst")),
        ("web:grok:analyst", ("grok", "analyst")),
    ],
)
def test_parse_web_model(model, expected):
    assert parse_web_model(model) == expected


@pytest.mark.parametrize(
    "model",
    [
        "",
        "web",
        "web:",
        "web:gemini",
        "web:claude:pane",
        "web:claude:analyst:x",
        "openai/gpt-5",
        "WEB:claude",
        None,
        3,
    ],
)
def test_parse_web_model_rejects(model):
    with pytest.raises(ValueError):
        parse_web_model(model)  # type: ignore[arg-type]


def test_text_for_rules():
    assert text_for("pane", MSGS) == (MSGS[-1]["content"], False)
    thread = [
        {"role": "user", "content": "q1"},
        {"role": "assistant", "content": "a1"},
        {"role": "user", "content": "q2"},
    ]
    assert text_for("pane", thread) == ("q2", False)  # the site is the thread
    assert text_for("analyst", ANALYST_MSGS) == (
        "You are the analyst.\n\nCompare R1, R2 and R3.",
        True,
    )
    correction = [
        *ANALYST_MSGS,
        {"role": "assistant", "content": "bad"},
        {"role": "user", "content": "fix it"},
    ]
    assert text_for("analyst", correction) == ("fix it", False)
    assert text_for("analyst", [{"role": "user", "content": "solo"}]) == ("solo", True)
    with pytest.raises(ValueError):
        text_for("pane", [])
    with pytest.raises(ValueError):
        text_for("hidden", MSGS)


def test_build_request_validates_through_the_frozen_model():
    frame = build_request(
        req_id="6f1d2c3b-4a5e-4f60-8b7c-9d0e1f2a3b4c",
        model="web:chatgpt:analyst",
        messages=ANALYST_MSGS,
        role="analyst",
        purpose="extraction",
        conversation_id="a3c1e2d4-5b6f-4a78-9c0d-e1f2a3b4c5d6",
        timeout_s=599.6,
    )
    assert frame == {
        "type": "request",
        "req_id": "6f1d2c3b-4a5e-4f60-8b7c-9d0e1f2a3b4c",
        "model": "web:chatgpt:analyst",
        "slot": "chatgpt",
        "view": "analyst",
        "fresh": True,
        "text": "You are the analyst.\n\nCompare R1, R2 and R3.",
        "role": "analyst",
        "purpose": "extraction",
        "conversation_id": "a3c1e2d4-5b6f-4a78-9c0d-e1f2a3b4c5d6",
        "timeout_s": 600,
    }
    with pytest.raises(ValueError):
        build_request(
            req_id="r",
            model="web:nope",
            messages=MSGS,
            role="claude",
            purpose="chat",
            conversation_id=None,
            timeout_s=1,
        )
    with pytest.raises(ValueError):  # a role outside the protocol vocabulary
        build_request(
            req_id="r",
            model="web:claude",
            messages=MSGS,
            role="gemini",
            purpose="chat",
            conversation_id=None,
            timeout_s=1,
        )


def test_conversation_scope_nests_and_resets():
    assert bridge.current_conversation() is None
    with bridge.conversation_scope("a"):
        assert bridge.current_conversation() == "a"
        with bridge.conversation_scope("b"):
            assert bridge.current_conversation() == "b"
        assert bridge.current_conversation() == "a"
    assert bridge.current_conversation() is None


async def test_conversation_scope_is_inherited_by_tasks_created_inside_it():
    async def seen() -> str | None:
        await asyncio.sleep(0)
        return bridge.current_conversation()

    with bridge.conversation_scope("inherited"):
        task = asyncio.create_task(seen())
    assert bridge.current_conversation() is None
    assert await task == "inherited"


@pytest.mark.parametrize(
    "name,default,raw,expected",
    [
        ("BRIDGE_TIMEOUT_S", 600.0, None, 600.0),
        ("BRIDGE_TIMEOUT_S", 600.0, "45", 45.0),
        ("BRIDGE_TIMEOUT_S", 600.0, "nope", 600.0),
        ("BRIDGE_TIMEOUT_S", 600.0, "0", 600.0),
        ("BRIDGE_ACCEPT_TIMEOUT_S", 15.0, "2.5", 2.5),
        ("BRIDGE_PING_S", 20.0, "", 20.0),
    ],
)
def test_env_reads_at_call_time(monkeypatch, name, default, raw, expected):
    if raw is None:
        monkeypatch.delenv(name, raising=False)
    else:
        monkeypatch.setenv(name, raw)
    fn = {
        "BRIDGE_TIMEOUT_S": bridge.timeout_s,
        "BRIDGE_ACCEPT_TIMEOUT_S": bridge.accept_timeout_s,
        "BRIDGE_PING_S": bridge.ping_s,
    }[name]
    assert fn() == expected


def test_bridge_token_blank_means_unset(monkeypatch):
    monkeypatch.setenv("BRIDGE_TOKEN", "  ")
    assert bridge.bridge_token() is None
    monkeypatch.setenv("BRIDGE_TOKEN", "abc")
    assert bridge.bridge_token() == "abc"


async def test_hub_connected_property_matches_status(attached: FakeConnection):
    assert bridge.hub.connected and bridge.hub.status()["connected"]
    bridge.hub.detach(attached)
    assert not bridge.hub.connected
    conn = FakeConnection()
    bridge.hub.attach(conn, hello())
    assert bridge.hub.connection is conn
