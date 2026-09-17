"""Frozen bridge protocol v1: backend/llm/bridge_protocol.py against desktop/protocol/bridge-v1.json
(integrator S0). Every example parses through the parser of its direction and round-trips exactly
through ``model_dump(mode="json")``; every ``invalid`` entry is rejected; the constants match the
corpus and docs/desktop-contract.md section 1."""

import json
from pathlib import Path
from typing import Any, get_args

import pytest
from pydantic import BaseModel, ValidationError

from backend.llm import bridge_protocol as bp

ROOT = Path(__file__).resolve().parents[2]
CONTRACT = ROOT / "desktop" / "protocol" / "bridge-v1.json"
DOC: dict[str, Any] = json.loads(CONTRACT.read_text(encoding="utf-8"))
FRAMES: dict[str, dict[str, Any]] = DOC["frames"]

PARSERS = {"client": bp.parse_client_frame, "server": bp.parse_server_frame}

# The documented sets (docs/desktop-contract.md section 1), spelled out so the module cannot
# drift from the contract without this file noticing.
DOC_CLIENT_TYPES = {
    "hello",
    "capture",
    "analyst",
    "health",
    "accepted",
    "rejected",
    "result",
    "pong",
}
DOC_SERVER_TYPES = {"hello_ack", "request", "cancel", "ping"}
DOC_REJECT_CODES = {
    "view_busy",
    "logged_out",
    "challenge",
    "blocked",
    "analyst_not_chosen",
    "unknown_site",
    "view_crashed",
}
DOC_RESULT_CODES = {
    "composer_not_found",
    "send_not_found",
    "not_submitted",
    "reply_not_found",
    "timeout",
    "cancelled",
    "adapter_gone",
    "site_error",
    "navigation",
    "view_crashed",
}
DOC_SESSION_STATES = {"ok", "logged_out", "challenge", "blocked", "unknown"}


def _cases(key: str) -> list[Any]:
    return [
        pytest.param(frame_type, spec["direction"], obj, id=f"{frame_type}[{i}]")
        for frame_type, spec in FRAMES.items()
        for i, obj in enumerate(spec[key])
    ]


# --------------------------------------------------------------------------- corpus shape
def test_corpus_shape() -> None:
    assert DOC["protocol"] == bp.PROTOCOL_VERSION == 1
    assert FRAMES
    for frame_type, spec in FRAMES.items():
        assert spec["direction"] in ("client", "server"), frame_type
        assert len(spec["examples"]) >= 2, frame_type
        assert len(spec["invalid"]) >= 1, frame_type
        for example in spec["examples"]:
            assert isinstance(example, dict) and example["type"] == frame_type, frame_type


def test_types_by_direction_match_constants() -> None:
    by_dir = {
        d: {t for t, s in FRAMES.items() if s["direction"] == d} for d in ("client", "server")
    }
    assert by_dir["client"] == bp.CLIENT_TYPES == DOC_CLIENT_TYPES
    assert by_dir["server"] == bp.SERVER_TYPES == DOC_SERVER_TYPES
    assert not (bp.CLIENT_TYPES & bp.SERVER_TYPES)
    assert bp.CLIENT_TYPES | bp.SERVER_TYPES == set(FRAMES)


def test_code_sets_match_contract_and_corpus() -> None:
    assert bp.REJECT_CODES == DOC_REJECT_CODES
    assert bp.RESULT_CODES == DOC_RESULT_CODES
    assert set(get_args(bp.SessionState)) == set(bp.SESSION_STATES) == DOC_SESSION_STATES
    # Every code has at least one example, so the JS validator sees each spelled out.
    assert {e["code"] for e in FRAMES["rejected"]["examples"]} == bp.REJECT_CODES
    assert {e["code"] for e in FRAMES["result"]["examples"] if e["ok"] is False} == bp.RESULT_CODES


# --------------------------------------------------------------------------- examples
@pytest.mark.parametrize(("frame_type", "direction", "example"), _cases("examples"))
def test_example_parses_and_round_trips(frame_type: str, direction: str, example: dict) -> None:
    model = PARSERS[direction](example)
    assert model.type == frame_type
    assert model.model_dump(mode="json") == example
    # A frame is only ever valid in its own direction.
    other = "server" if direction == "client" else "client"
    with pytest.raises(ValidationError):
        PARSERS[other](example)


@pytest.mark.parametrize(("frame_type", "direction", "invalid"), _cases("invalid"))
def test_invalid_is_rejected(frame_type: str, direction: str, invalid: dict) -> None:
    with pytest.raises(ValueError):  # pydantic.ValidationError is a ValueError
        PARSERS[direction](invalid)


# --------------------------------------------------------------------------- module rules
def test_every_model_forbids_extra_and_is_strict() -> None:
    models = [
        obj
        for obj in vars(bp).values()
        if isinstance(obj, type) and issubclass(obj, BaseModel) and obj is not BaseModel
    ]
    names = {m.__name__ for m in models}
    assert {
        "Hello",
        "CaptureFrame",
        "AnalystFrame",
        "HealthFrame",
        "Health",
        "Accepted",
        "Rejected",
        "ResultCaptured",
        "ResultNotCaptured",
        "ResultFailed",
        "Pong",
        "HelloAck",
        "Request",
        "Cancel",
        "Ping",
    } <= names
    for m in models:
        assert m.model_config.get("extra") == "forbid", m.__name__
        assert m.model_config.get("strict") is True, m.__name__


def test_result_variants() -> None:
    rid = "6f1d2c3b-4a5e-4f60-8b7c-9d0e1f2a3b4c"
    captured = bp.parse_client_frame(
        {
            "type": "result",
            "req_id": rid,
            "ok": True,
            "captured": True,
            "text": "hi",
            "url": "https://chatgpt.com/c/1",
            "ms": 5,
            "done_by": "quiet",
        }
    )
    assert isinstance(captured, bp.ResultCaptured)
    not_captured = bp.parse_client_frame(
        {
            "type": "result",
            "req_id": rid,
            "ok": True,
            "captured": False,
            "url": "https://chatgpt.com/c/1",
            "ms": 5,
        }
    )
    assert isinstance(not_captured, bp.ResultNotCaptured)
    failed = bp.parse_client_frame(
        {"type": "result", "req_id": rid, "ok": False, "code": "timeout", "message": "late"}
    )
    assert isinstance(failed, bp.ResultFailed) and failed.partial is None
    assert all(isinstance(m, bp.RESULT_MODELS) for m in (captured, not_captured, failed))

    with pytest.raises(ValidationError, match="code"):
        bp.parse_client_frame({"type": "result", "req_id": rid, "ok": False, "message": "x"})
    with pytest.raises(ValidationError, match="text"):
        bp.parse_client_frame(
            {
                "type": "result",
                "req_id": rid,
                "ok": True,
                "captured": True,
                "url": "https://chatgpt.com/c/1",
                "ms": 5,
                "done_by": "quiet",
            }
        )


def test_health_session_is_the_five_states() -> None:
    base = FRAMES["health"]["examples"][0]["health"]
    for state in DOC_SESSION_STATES:
        assert bp.Health.model_validate({**base, "session": state}).session == state
    with pytest.raises(ValidationError):
        bp.Health.model_validate({**base, "session": "expired"})
    assert set(bp.Matched.model_fields) == {"composer", "send", "reply", "stop", "error"}
    assert bp.Matched.model_validate({"composer": None, "send": None, "reply": None, "stop": None})


def test_request_model_must_match_slot_and_view() -> None:
    good = FRAMES["request"]["examples"][0]
    assert bp.parse_server_frame(good).model == f"web:{good['slot']}"
    analyst = bp.parse_server_frame({**good, "model": "web:chatgpt:analyst", "view": "analyst"})
    assert analyst.view == "analyst"
    with pytest.raises(ValidationError, match="model must be"):
        bp.parse_server_frame({**good, "model": "web:chatgpt:analyst"})
    with pytest.raises(ValidationError, match="model must be"):
        bp.parse_server_frame({**good, "slot": "claude"})


def test_parsers_reject_non_frames() -> None:
    for bad in ("hello", 1, None, [], {}, {"type": "nope"}, {"type": 1}):
        with pytest.raises(ValidationError):
            bp.parse_client_frame(bad)
        with pytest.raises(ValidationError):
            bp.parse_server_frame(bad)
    # Strict: no coercion of JSON scalars.
    with pytest.raises(ValidationError):
        bp.parse_client_frame({"type": "pong", "ts": 1.0})
    with pytest.raises(ValidationError):
        bp.parse_server_frame(
            {"type": "hello_ack", "protocol": 1, "backend_version": "0.1.0", "ping_s": "20"}
        )
