"""Bridge WebSocket protocol v1 -- frame contract (owner: integrator S0, frozen).

``ws://127.0.0.1:<PORT>/api/bridge`` carries JSON text frames between the Electron shell (the
*client*) and this backend (the *server*). ``docs/desktop-contract.md`` section 1 is normative;
``desktop/protocol/bridge-v1.json`` is the machine-checked corpus: every ``examples`` entry must
parse through ``parse_client_frame`` / ``parse_server_frame`` and round-trip exactly through
``model_dump(mode="json")``, every ``invalid`` entry must be rejected
(``tests/bridge/test_protocol_examples.py``); the hand-written JS validator in
``desktop/main/protocol.js`` is held to the same file.

Rules encoded here:

- Every model forbids unknown keys and validates strictly (JSON already has real types; a
  string ``"1"`` is never a protocol version and ``1`` is never ``true``).
- ``type`` is the discriminator in both directions. ``result`` is a three-variant sub-union told
  apart by ``ok`` / ``captured`` so that an ``ok:false`` result without ``code`` and an
  ``ok:true, captured:true`` result without ``text`` are rejected, and each variant dumps only its
  own keys.
- ``Health.session`` is one of five states; ``reply`` / ``stop`` and the four ``matched`` keys are
  nullable (``null`` until selectors v2).
- A ``request``'s ``model`` is ``web:<slot>`` for ``view:"pane"`` and ``web:<slot>:analyst`` for
  ``view:"analyst"``, with ``<slot>`` equal to ``slot`` -- the derivation ``bridge.parse_web_model``
  performs, checked again at the boundary.

Nothing here does I/O and nothing here imports from a feature module.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal, get_args

from pydantic import (
    BaseModel,
    ConfigDict,
    Discriminator,
    Field,
    Tag,
    TypeAdapter,
    field_validator,
    model_validator,
)

from ..schemas import Purpose, SlotId

PROTOCOL_VERSION = 1

# --------------------------------------------------------------------------- vocabularies
SessionState = Literal["ok", "logged_out", "challenge", "blocked", "unknown"]
SESSION_STATES: tuple[str, ...] = get_args(SessionState)
View = Literal["pane", "analyst"]
DoneBy = Literal["done_selector", "stop_gone", "quiet"]
BridgeRole = Literal["chatgpt", "claude", "grok", "analyst"]
RejectCode = Literal[
    "view_busy",
    "logged_out",
    "challenge",
    "blocked",
    "analyst_not_chosen",
    "unknown_site",
    "view_crashed",
]
ResultCode = Literal[
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
]
REJECT_CODES: frozenset[str] = frozenset(get_args(RejectCode))
RESULT_CODES: frozenset[str] = frozenset(get_args(ResultCode))

CLIENT_TYPES: frozenset[str] = frozenset(
    {"hello", "capture", "analyst", "health", "accepted", "rejected", "result", "pong"}
)
SERVER_TYPES: frozenset[str] = frozenset({"hello_ack", "request", "cancel", "ping"})

ReqId = Annotated[str, Field(min_length=1)]
Millis = Annotated[int, Field(ge=0)]


class _Frame(BaseModel):
    """Base of every protocol object: unknown keys are a protocol error, never ignored."""

    model_config = ConfigDict(extra="forbid", strict=True)


# --------------------------------------------------------------------------- shared objects
class CaptureMap(_Frame):
    """Per-site capture switch; all three sites are always listed."""

    claude: bool
    chatgpt: bool
    grok: bool


class AnalystChoice(_Frame):
    """The site whose hidden page acts as the analyst (``null`` = no analyst chosen)."""

    slot: SlotId


class Matched(_Frame):
    """Which selector of each cascade matched (``null`` = none / not probed yet)."""

    composer: str | None
    send: str | None
    reply: str | None
    stop: str | None
    error: str | None = None  # selector-config problem (bad override file), else None


class Health(_Frame):
    composer: bool
    send: bool
    reply: bool | None
    stop: bool | None
    session: SessionState
    matched: Matched
    url: str
    host: str
    title: str
    ts: int


# --------------------------------------------------------------------------- client -> backend
class Hello(_Frame):
    """MUST be the first frame within 10 s; the token is checked before any ack."""

    type: Literal["hello"]
    protocol: Literal[1]
    token: str = Field(min_length=1)
    version: str
    sites: list[SlotId] = Field(min_length=1, max_length=3)
    capture: CaptureMap
    analyst: AnalystChoice | None

    @field_validator("sites")
    @classmethod
    def _sites_unique(cls, sites: list[str]) -> list[str]:
        if len(set(sites)) != len(sites):
            raise ValueError("sites must not repeat a slot")
        return sites


class CaptureFrame(_Frame):
    type: Literal["capture"]
    capture: CaptureMap


class AnalystFrame(_Frame):
    type: Literal["analyst"]
    analyst: AnalystChoice | None


class HealthFrame(_Frame):
    type: Literal["health"]
    slot: SlotId
    health: Health


class Accepted(_Frame):
    """Sent before any DOM write."""

    type: Literal["accepted"]
    req_id: ReqId
    view: View
    slot: SlotId


class Rejected(_Frame):
    type: Literal["rejected"]
    req_id: ReqId
    code: RejectCode
    message: str


class ResultCaptured(_Frame):
    """``ok:true, captured:true`` -- the final reply text read from the site."""

    type: Literal["result"]
    req_id: ReqId
    ok: Literal[True]
    captured: Literal[True]
    text: str
    url: str
    ms: Millis
    done_by: DoneBy


class ResultNotCaptured(_Frame):
    """``ok:true, captured:false`` -- typed and submitted, capture off (``view:"pane"`` only)."""

    type: Literal["result"]
    req_id: ReqId
    ok: Literal[True]
    captured: Literal[False]
    url: str
    ms: Millis


class ResultFailed(_Frame):
    """``ok:false`` -- the adapter could not complete the turn; ``partial`` is optional."""

    type: Literal["result"]
    req_id: ReqId
    ok: Literal[False]
    code: ResultCode
    message: str
    partial: str | None = None


def _result_variant(value: Any) -> str | None:
    """Tag a ``result`` frame by its ``ok`` / ``captured`` pair (``None`` = no variant matches)."""
    if isinstance(value, dict):
        ok, captured = value.get("ok"), value.get("captured")
    else:
        ok, captured = getattr(value, "ok", None), getattr(value, "captured", None)
    if ok is False:
        return "failed"
    if ok is True:
        return "not_captured" if captured is False else "captured"
    return None


Result = Annotated[
    Annotated[ResultCaptured, Tag("captured")]
    | Annotated[ResultNotCaptured, Tag("not_captured")]
    | Annotated[ResultFailed, Tag("failed")],
    Discriminator(_result_variant),
]
RESULT_MODELS: tuple[type[_Frame], ...] = (ResultCaptured, ResultNotCaptured, ResultFailed)


class Pong(_Frame):
    type: Literal["pong"]
    ts: int


# --------------------------------------------------------------------------- backend -> client
class HelloAck(_Frame):
    type: Literal["hello_ack"]
    protocol: Literal[1]
    backend_version: str
    ping_s: int = Field(gt=0)


class Request(_Frame):
    """One turn to type into a site view; ``text`` is exactly what the adapter inserts."""

    type: Literal["request"]
    req_id: ReqId
    model: str
    slot: SlotId
    view: View
    fresh: bool
    text: str
    role: BridgeRole
    purpose: Purpose
    conversation_id: str | None
    timeout_s: int = Field(gt=0)

    @model_validator(mode="after")
    def _model_matches_slot_and_view(self) -> Request:
        expected = f"web:{self.slot}" + (":analyst" if self.view == "analyst" else "")
        if self.model != expected:
            raise ValueError(
                f"model must be {expected!r} for slot {self.slot!r} and view {self.view!r}"
            )
        return self


class Cancel(_Frame):
    """Sent on timeout or when the consumer closes the stream."""

    type: Literal["cancel"]
    req_id: ReqId


class Ping(_Frame):
    type: Literal["ping"]
    ts: int


# --------------------------------------------------------------------------- unions + parsers
ClientFrame = Annotated[
    Hello | CaptureFrame | AnalystFrame | HealthFrame | Accepted | Rejected | Result | Pong,
    Field(discriminator="type"),
]
ServerFrame = Annotated[HelloAck | Request | Cancel | Ping, Field(discriminator="type")]

ClientFrameAdapter: TypeAdapter[ClientFrame] = TypeAdapter(ClientFrame)
ServerFrameAdapter: TypeAdapter[ServerFrame] = TypeAdapter(ServerFrame)


def parse_client_frame(obj: Any) -> ClientFrame:
    """Validate one Electron -> backend frame; raises ``pydantic.ValidationError`` (a
    ``ValueError``) on anything that is not exactly one of the client shapes."""
    return ClientFrameAdapter.validate_python(obj)


def parse_server_frame(obj: Any) -> ServerFrame:
    """Validate one backend -> Electron frame; raises ``pydantic.ValidationError`` (a
    ``ValueError``) on anything that is not exactly one of the server shapes."""
    return ServerFrameAdapter.validate_python(obj)
