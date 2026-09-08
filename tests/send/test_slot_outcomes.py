"""Per-slot outcomes: slot_error appends nothing, truncation appends and flags, grounded mode
carries the web plugin and yields citations (scenarios slot_failure / truncated / grounded)."""

from __future__ import annotations

from backend.config import DEFAULT_SLOT_CONFIG
from backend.llm import mock
from backend.schemas import SLOT_IDS
from tests.send.conftest import assert_stream_invariants, of_type, one, slot_text

SLOT_FAILURE_PROMPT = (
    "Which accelerometer output data rate should I select on the BMI088 for a 400 Hz "
    "attitude control loop?"
)
TRUNCATED_PROMPT = (
    "Derive the discrete-time process noise covariance Q for a constant-velocity Kalman "
    "filter with sample period T, assuming white acceleration noise."
)
GROUNDED_PROMPT = (
    "What is the zero-rate offset specification of the BMI088 gyroscope, and where is it "
    "documented?"
)
DATASHEET_URL = (
    "https://www.bosch-sensortec.com/media/boschsensortec/downloads/datasheets/bst-bmi088-ds001.pdf"
)
PRODUCT_URL = "https://www.bosch-sensortec.com/products/motion-sensors/imus/bmi088/"


# --------------------------------------------------------------------------- (4) slot_error
async def test_slot_error_appends_nothing_and_keeps_partial_on_the_turn(
    send, cid, get_conv, monkeypatch
):
    monkeypatch.setenv("MOCK_SCENARIO", "slot_failure")
    events = await send(cid, SLOT_FAILURE_PROMPT)
    assert_stream_invariants(events)

    err = one(events, "slot_error", "grok")
    assert set(err) == {"type", "slot", "code", "error_type", "message", "partial"}
    assert err["code"] == 502 and err["error_type"] == "provider_unavailable"
    assert err["message"] == "Provider disconnected"
    assert err["partial"] == slot_text(events, "grok")
    assert err["partial"].startswith("Run the accelerometer at 1600 Hz")
    assert not [e for e in of_type(events, "slot_done") if e["slot"] == "grok"]
    for slot in ("claude", "chatgpt"):
        one(events, "slot_done", slot)
    assert events[-1]["type"] == "turn_done"
    assert events[-1]["usage"]["totals"]["calls"] == 2
    assert {u["role"] for u in events[-1]["usage"]["calls"]} == {"claude", "chatgpt"}

    conv = await get_conv(cid)
    turn = conv["turns"][0]
    assert turn["type"] == "send"
    assert turn["responses"]["grok"] is None
    assert turn["responses"]["claude"] == slot_text(events, "claude")
    assert turn["responses"]["chatgpt"] == slot_text(events, "chatgpt")
    assert turn["errors"] == {"grok": "Provider disconnected"}
    assert turn["partial"] == {"grok": err["partial"]}
    assert turn["truncated"]["grok"] is False
    assert "grok" in turn["effort_applied"]
    # nothing appended to the failed slot's thread: no orphan user message
    assert conv["threads"]["grok"] == []
    for slot in ("claude", "chatgpt"):
        assert [m["role"] for m in conv["threads"][slot]] == ["user", "assistant"]
        assert conv["threads"][slot][1]["content"] == turn["responses"][slot]
    assert mock.calls[2]["fixture"] == "slot_failure/grok.chat.1.jsonl"


async def test_continue_on_a_failing_slot_appends_nothing(send, cont, cid, get_conv, monkeypatch):
    monkeypatch.setenv("MOCK_SCENARIO", "slot_failure")
    await send(cid, SLOT_FAILURE_PROMPT)
    events = await cont(cid, "grok", "Try again?")  # sticky grok.chat.1 -> errors again
    assert_stream_invariants(events, slots=("grok",))
    err = one(events, "slot_error", "grok")
    assert err["code"] == 502
    assert events[-1]["usage"]["totals"]["calls"] == 0
    conv = await get_conv(cid)
    assert conv["threads"]["grok"] == []
    t = conv["turns"][1]
    assert t["type"] == "continue" and t["slot"] == "grok"
    assert t["response"] is None and t["error"] == "Provider disconnected"
    assert t["truncated"] is False and t["usage"]["totals"]["calls"] == 0
    assert mock.calls[-1]["messages"] == [{"role": "user", "content": "Try again?"}]


# --------------------------------------------------------------------------- (5) truncated
async def test_truncated_reply_is_flagged_and_still_appended(send, cid, get_conv, monkeypatch):
    monkeypatch.setenv("MOCK_SCENARIO", "truncated")
    events = await send(cid, TRUNCATED_PROMPT)
    assert_stream_invariants(events)
    done = one(events, "slot_done", "chatgpt")
    assert done["finish_reason"] == "length" and done["truncated"] is True
    for slot in ("claude", "grok"):
        d = one(events, "slot_done", slot)
        assert d["finish_reason"] == "stop" and d["truncated"] is False
    assert not of_type(events, "slot_error")

    conv = await get_conv(cid)
    turn = conv["turns"][0]
    assert turn["truncated"] == {"claude": False, "chatgpt": True, "grok": False}
    assert turn["errors"] == {} and turn["partial"] == {}
    text = slot_text(events, "chatgpt")
    assert turn["responses"]["chatgpt"] == text and text.endswith("and the (2,2) entry")
    thread = conv["threads"]["chatgpt"]
    assert [m["role"] for m in thread] == ["user", "assistant"]
    assert thread[1]["content"] == text


# --------------------------------------------------------------------------- (6) grounded
async def test_grounded_mode_sends_web_plugin_and_yields_citations(
    new_conv, send, get_conv, monkeypatch
):
    monkeypatch.setenv("MOCK_SCENARIO", "grounded")
    cfg = DEFAULT_SLOT_CONFIG.model_copy(deep=True)
    cfg.grounded = True
    conv = await new_conv(slot_config=cfg.model_dump())
    assert conv["slot_config"]["grounded"] is True
    events = await send(conv["id"], GROUNDED_PROMPT)
    assert_stream_invariants(events)

    assert len(mock.calls) == 3
    for c in mock.calls:
        assert isinstance(c["plugins"], list) and len(c["plugins"]) == 1
        plugin = c["plugins"][0]
        assert plugin["id"] == "web"
        assert plugin.get("max_results") == 5 and "engine" not in plugin
        assert c["response_format"] is None

    cites = [e for e in of_type(events, "slot_citations") if e["slot"] == "claude"]
    assert len(cites) == 2 and all(set(e) == {"type", "slot", "items"} for e in cites)
    urls = [item["url_citation"]["url"] for e in cites for item in e["items"]]
    assert urls == [DATASHEET_URL, PRODUCT_URL]
    assert all(item["type"] == "url_citation" for e in cites for item in e["items"])
    assert not [e for e in of_type(events, "slot_citations") if e["slot"] != "claude"]
    # citations precede the slot's slot_done
    kinds = [e["type"] for e in events if e.get("slot") == "claude"]
    assert kinds.index("slot_done") > max(i for i, k in enumerate(kinds) if k == "slot_citations")

    stored = await get_conv(conv["id"])
    turn = stored["turns"][0]
    assert list(turn["citations"]) == ["claude"]
    assert [i["url_citation"]["url"] for i in turn["citations"]["claude"]] == urls
    assert turn["citations"]["claude"][0]["url_citation"]["title"].startswith("BMI088 Datasheet")
    # reasoning: the reasoning.text block only, the encrypted block is ignored
    assert turn["reasoning"]["claude"].startswith("Search result: BMI088 datasheet")
    assert "[REDACTED]" not in turn["reasoning"]["claude"]
    assert turn["slot_config"]["grounded"] is True
    # citations live on the turn, never in threads
    for slot in SLOT_IDS:
        for m in stored["threads"][slot]:
            assert set(m) == {"role", "content", "kind", "turn_id", "ts", "meta"}


async def test_grounded_engine_setting_is_carried_in_the_plugin(new_conv, send, monkeypatch, cont):
    monkeypatch.setenv("MOCK_SCENARIO", "grounded")
    monkeypatch.setenv("GROUNDED_ENGINE", "exa")
    monkeypatch.setenv("GROUNDED_MAX_RESULTS", "3")
    cfg = DEFAULT_SLOT_CONFIG.model_copy(deep=True)
    cfg.grounded = True
    conv = await new_conv(slot_config=cfg.model_dump())
    await send(conv["id"], GROUNDED_PROMPT)
    await cont(conv["id"], "grok", "Which revision?")
    assert len(mock.calls) == 4
    for c in mock.calls:
        assert c["plugins"] == [{"id": "web", "engine": "exa", "max_results": 3}]


async def test_ungrounded_requests_carry_no_plugins(send, cont, cid, monkeypatch):
    monkeypatch.setenv("MOCK_SCENARIO", "grounded")
    events = await send(cid, GROUNDED_PROMPT)
    await cont(cid, "claude", "More?")
    assert len(mock.calls) == 4
    for c in mock.calls:
        assert c["plugins"] is None
    # the fixture's annotations still surface (they are data from the transport), but the
    # request itself asked for no web search
    assert of_type(events, "slot_citations")
