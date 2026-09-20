"""Bridge transport (owner: bridge-backend S2): `web:<slot>` models over the Electron WebSocket.

docs/desktop-contract.md section 1 (frames, timeouts, delta mapping) and section 6 (module API,
env keys) are normative; `bridge_protocol.py` (frozen) validates every frame at the boundary.

- `CURRENT_CONVERSATION` / `conversation_scope(conv_id)` / `current_conversation()`: the routers
  wrap `await sse_response(...)` in the scope; the feature's producer task is created inside the
  first `__anext__` (before the scope exits) and inherits the ContextVar, so every `request` frame
  carries the conversation id without the frozen feature signatures changing.
- `parse_web_model("web:chatgpt") == ("chatgpt", "pane")`, `"web:chatgpt:analyst"` ->
  `("chatgpt", "analyst")`; anything else raises `ValueError` (`stream` maps it to
  `bridge_bad_model`).
- `text_for(view, messages) -> (text, fresh)` is the contract's text rule verbatim: a pane types
  the last message (the site is the thread); an analyst view types system + user joined with a
  blank line into a FRESH chat when the conversation holds no assistant turn yet, and only the
  last message (the correction) into the same chat when it does. An empty `messages` list is a
  `ValueError` (nothing to type; `stream` reports `transport_error`).
- `BridgeHub`: ONE client (a second valid hello supersedes: the old socket is closed 4002 and its
  pending requests fail `bridge_disconnected`); `request(frame, ...)` multiplexes by `req_id` on
  per-request `asyncio.Future`s created on the running loop, yields the `accepted` / `rejected`
  frame and then the `result` frame as dicts, raises `BridgeError(code)` for `bridge_unavailable`
  / `bridge_no_ack` / `timeout` / `bridge_disconnected`, and sends `cancel` when it times out
  or when its consumer closes it early (`aclose`). `ping(conn)` is one liveness tick: the router
  calls it every `BRIDGE_PING_S`; a tick without a pong since the previous one is a miss, two
  misses close the socket 1011 and fail every pending request `bridge_disconnected`. Health,
  capture and analyst frames only update the caches `status()` reports.
- `stream(...)`: the transport `client.stream_completion` dispatches `web:*` models to. NEVER
  raises: exactly the section 1 delta mapping, one INFO line per request (`bridge req=<id> slot
  view purpose ok|code ms done_by chars`) that never contains any text, no frame body is ever
  logged. `done_by` is the end signal the adapter reported (`-` when nothing was captured) and
  `chars` the length of the captured text (of `partial` on a failed result, 0 otherwise): the
  pair that tells a genuinely short answer apart from a capture that ended mid-reply.
  `max_tokens`, `response_format`, `plugins` and `reasoning` are ignored (the site decides); the
  `done` delta carries a zero-token, zero-cost `Usage` (`stream_completion` stamps latency). A
  failed `result` that carries `partial` text yields that text as one `text` delta BEFORE the
  error delta, so `slot_error.partial` shows what the site produced (the OpenRouter path does the
  same for a mid-stream error after text).
- A `result ok:false` / `rejected` code is passed through verbatim with `error_type:"site"`; the
  codes this module mints (`error_type:"triplex"`) are the constants below. `transport_disabled`
  lives here too because `errors.py` belongs to another workstream.

Env (private reads, `config.py` untouched; read at CALL time, never cached): `BRIDGE_TOKEN`
(unset -> the router accepts any hello with a WARNING), `BRIDGE_TIMEOUT_S`=600,
`BRIDGE_ACCEPT_TIMEOUT_S`=15, `BRIDGE_PING_S`=20.

Where the contract is silent this module takes the simplest reading (listed for the integrator):
`request()` signals failures by raising `BridgeError` (not by yielding a frame); the overall
`timeout_s` deadline starts when the request frame is sent (the ack wait is bounded by
`min(accept_timeout_s, timeout_s)`); a `result` that arrives without a preceding `accepted` is an
implicit acceptance; `status().analyst` is the analyst slot string (or null) and
`status().since` an ISO-8601 UTC timestamp; `health_ts` is the backend's receive time in epoch
milliseconds; `status().sites` always lists the three slots; `detach` resets every cache so a
disconnected status reports nothing stale.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import time
import uuid
from collections.abc import AsyncIterator, Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Literal, Protocol

from ..schemas import SLOT_IDS, Delta, Usage
from . import bridge_protocol as bp
from .errors import ERROR_TYPE_TRIPLEX, TIMEOUT, TRANSPORT_ERROR

log = logging.getLogger("triplex.llm.bridge")

PROTOCOL_VERSION = bp.PROTOCOL_VERSION
BACKEND_VERSION = "0.1.0"  # pyproject `version`; the package is not installed, so spelled out

# Codes minted here (error_type "triplex"), docs/api-contract.md desktop addendum.
BRIDGE_UNAVAILABLE = "bridge_unavailable"
BRIDGE_DISCONNECTED = "bridge_disconnected"
BRIDGE_NO_ACK = "bridge_no_ack"
BRIDGE_BAD_MODEL = "bridge_bad_model"
NOT_CAPTURED = "not_captured"
TRANSPORT_DISABLED = "transport_disabled"  # minted by client.py under TRIPLEX_DESKTOP=1
ERROR_TYPE_SITE = "site"  # rejected / result ok:false codes reported by Electron

# Close codes (section 1).
CLOSE_MALFORMED = 4001
CLOSE_SUPERSEDED = 4002
CLOSE_BAD_TOKEN = 4003
CLOSE_HELLO_TIMEOUT = 4004
CLOSE_PONG_TIMEOUT = 1011
MISSED_PONGS_LIMIT = 2

DEFAULT_TIMEOUT_S = 600.0
DEFAULT_ACCEPT_TIMEOUT_S = 15.0
DEFAULT_PING_S = 20.0

View = Literal["pane", "analyst"]


# --------------------------------------------------------------------------- env (private reads)
def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError:
        return default
    return value if value > 0 else default


def bridge_token() -> str | None:
    """`BRIDGE_TOKEN`; None when unset or blank (the router then accepts any hello)."""
    return os.environ.get("BRIDGE_TOKEN", "").strip() or None


def timeout_s() -> float:
    return _env_float("BRIDGE_TIMEOUT_S", DEFAULT_TIMEOUT_S)


def accept_timeout_s() -> float:
    return _env_float("BRIDGE_ACCEPT_TIMEOUT_S", DEFAULT_ACCEPT_TIMEOUT_S)


def ping_s() -> float:
    return _env_float("BRIDGE_PING_S", DEFAULT_PING_S)


# --------------------------------------------------------------------------- conversation scope
CURRENT_CONVERSATION: ContextVar[str | None] = ContextVar(
    "triplex_current_conversation", default=None
)


@contextmanager
def conversation_scope(conv_id: str | None) -> Iterator[None]:
    """Routers wrap `await sse_response(gen)` in it: the producer task the feature spawns inside
    the first `__anext__` copies the context and therefore keeps `conv_id` for its whole life."""
    token = CURRENT_CONVERSATION.set(conv_id)
    try:
        yield
    finally:
        CURRENT_CONVERSATION.reset(token)


def current_conversation() -> str | None:
    return CURRENT_CONVERSATION.get()


# --------------------------------------------------------------------------- pure helpers
def parse_web_model(model: str) -> tuple[str, View]:
    """`web:<slot>` -> (slot, "pane"); `web:<slot>:analyst` -> (slot, "analyst"); else ValueError."""
    if not isinstance(model, str):
        raise ValueError(f"web model must be a string, got {type(model).__name__}")
    parts = model.split(":")
    if len(parts) < 2 or parts[0] != "web" or not parts[1]:
        raise ValueError(f"not a web model: {model!r}")
    slot = parts[1]
    if slot not in SLOT_IDS:
        raise ValueError(f"unknown slot {slot!r} in web model {model!r}")
    if len(parts) == 2:
        return slot, "pane"
    if len(parts) == 3 and parts[2] == "analyst":
        return slot, "analyst"
    raise ValueError(f"malformed web model {model!r} (expected web:<slot> or web:<slot>:analyst)")


def _content(message: dict[str, Any]) -> str:
    content = message.get("content", "") if isinstance(message, dict) else ""
    return content if isinstance(content, str) else str(content)


def text_for(view: str, messages: list[dict[str, Any]]) -> tuple[str, bool]:
    """The contract's text rule: `(text, fresh)`."""
    if not messages:
        raise ValueError("no messages to type")
    if view == "pane":
        return _content(messages[-1]), False
    if view != "analyst":
        raise ValueError(f"unknown view {view!r}")
    if any(isinstance(m, dict) and m.get("role") == "assistant" for m in messages):
        return _content(messages[-1]), False
    return "\n\n".join(_content(m) for m in messages), True


def build_request(
    *,
    req_id: str,
    model: str,
    messages: list[dict[str, Any]],
    role: str,
    purpose: str,
    conversation_id: str | None,
    timeout_s: float | int,
) -> dict[str, Any]:
    """The `request` frame as a plain dict, validated through the frozen `Request` model."""
    slot, view = parse_web_model(model)
    text, fresh = text_for(view, messages)
    frame = {
        "type": "request",
        "req_id": req_id,
        "model": model,
        "slot": slot,
        "view": view,
        "fresh": fresh,
        "text": text,
        "role": role,
        "purpose": purpose,
        "conversation_id": conversation_id,
        "timeout_s": max(1, int(round(float(timeout_s)))),
    }
    return bp.parse_server_frame(frame).model_dump(mode="json")


def _now_ms() -> int:
    return int(time.time() * 1000)


# --------------------------------------------------------------------------- hub
class BridgeError(Exception):
    """A request that could not complete for a bridge-level reason (never a site code)."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class BridgeConnection(Protocol):
    async def send_json(self, obj: dict[str, Any]) -> None: ...

    async def close(self, code: int, reason: str) -> None: ...


@dataclass
class _Pending:
    conn: BridgeConnection
    ack: asyncio.Future[dict[str, Any]]
    result: asyncio.Future[dict[str, Any]]


@dataclass
class _HealthEntry:
    health: bp.Health
    ts: int


def _settle(fut: asyncio.Future[Any], value: Any = None, exc: BaseException | None = None) -> None:
    """Resolve a future from whichever loop/thread we are on; a done future is left alone."""

    def _apply() -> None:
        if fut.done():
            return
        if exc is not None:
            fut.set_exception(exc)
        else:
            fut.set_result(value)

    loop = fut.get_loop()
    try:
        running = asyncio.get_running_loop()
    except RuntimeError:
        running = None
    if running is loop:
        _apply()
    else:
        try:
            loop.call_soon_threadsafe(_apply)
        except RuntimeError:  # that loop is closed: nobody can await the future any more
            log.debug("bridge: future settled on a closed loop; dropped")


@dataclass
class BridgeHub:
    _conn: BridgeConnection | None = None
    _hello: bp.Hello | None = None
    _since: str | None = None
    _pending: dict[str, _Pending] = field(default_factory=dict)
    _capture: bp.CaptureMap | None = None
    _analyst: bp.AnalystChoice | None = None
    _health: dict[str, _HealthEntry] = field(default_factory=dict)
    _awaiting_pong: bool = False
    _missed_pongs: int = 0
    _tasks: set[asyncio.Task[Any]] = field(default_factory=set)

    # ------------------------------------------------------------------ connection lifecycle
    @property
    def connected(self) -> bool:
        return self._conn is not None

    @property
    def connection(self) -> BridgeConnection | None:
        return self._conn

    def attach(
        self, conn: BridgeConnection, hello: bp.Hello | dict[str, Any]
    ) -> BridgeConnection | None:
        """Make `conn` the one client. Returns the connection it supersedes (closed 4002 on the
        running loop, its pending requests failed `bridge_disconnected`) or None."""
        if isinstance(hello, dict):
            hello = bp.parse_client_frame(hello)  # type: ignore[assignment]
        if not isinstance(hello, bp.Hello):
            raise ValueError("attach() needs a hello frame")
        old = self._conn
        if old is not None and old is not conn:
            self._fail_pending(BRIDGE_DISCONNECTED, "superseded by a new desktop client")
            self._spawn(old.close(CLOSE_SUPERSEDED, "superseded"))
        self._conn = conn
        self._hello = hello
        self._since = datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        self._capture = hello.capture
        self._analyst = hello.analyst
        self._health = {}
        self._awaiting_pong = False
        self._missed_pongs = 0
        return old if old is not conn else None

    def detach(self, conn: BridgeConnection) -> bool:
        """Forget `conn` if it is the current client (its pending requests fail
        `bridge_disconnected`); a stale/superseded connection is a no-op."""
        if conn is not self._conn:
            return False
        self._fail_pending(BRIDGE_DISCONNECTED, "the desktop client disconnected")
        self._clear()
        return True

    def reset(self) -> None:
        """Drop everything (tests)."""
        self._fail_pending(BRIDGE_DISCONNECTED, "bridge reset")
        self._clear()

    def _clear(self) -> None:
        self._conn = None
        self._hello = None
        self._since = None
        self._capture = None
        self._analyst = None
        self._health = {}
        self._awaiting_pong = False
        self._missed_pongs = 0

    def _spawn(self, coro: Any) -> None:
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            coro.close()
            log.warning("bridge: no running loop; a superseded connection could not be closed")
            return
        task = loop.create_task(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    def _fail_pending(self, code: str, message: str) -> None:
        pending = list(self._pending.values())
        self._pending.clear()
        for p in pending:
            _settle(p.ack, exc=BridgeError(code, message))
            _settle(p.result, exc=BridgeError(code, message))

    # ------------------------------------------------------------------ inbound frames
    def dispatch(
        self,
        conn_or_frame: BridgeConnection | bp.ClientFrame | dict[str, Any],
        frame: bp.ClientFrame | dict[str, Any] | None = None,
    ) -> None:
        """Route one parsed client frame (a dict is parsed first; malformed -> ValueError).

        `dispatch(frame)` is the contract's unscoped form (tests, fakes); the router calls
        `dispatch(conn, frame)`, which drops the frame when `conn` is not the current client:
        a superseded socket keeps delivering until its 4002 close lands, and its pongs and
        cache frames must never touch the new client's liveness bookkeeping or `status()`.
        """
        if frame is None:
            conn: BridgeConnection | None = None
            frame = conn_or_frame  # type: ignore[assignment]
        else:
            conn = conn_or_frame  # type: ignore[assignment]
        if isinstance(frame, dict):
            frame = bp.parse_client_frame(frame)
        if conn is not None and conn is not self._conn:
            log.debug("bridge: %s from a stale connection ignored", frame.type)
            return
        kind = frame.type
        if kind == "pong":
            self._awaiting_pong = False
            self._missed_pongs = 0
        elif kind == "capture":
            self._capture = frame.capture
        elif kind == "analyst":
            self._analyst = frame.analyst
        elif kind == "health":
            self._health[frame.slot] = _HealthEntry(health=frame.health, ts=_now_ms())
        elif kind == "hello":
            log.warning("bridge: hello on an attached connection ignored")
        else:  # accepted | rejected | result
            self._dispatch_reply(frame)

    def _dispatch_reply(self, frame: Any) -> None:
        pending = self._pending.get(frame.req_id)
        if pending is None:
            log.debug("bridge: %s for unknown req=%s ignored", frame.type, frame.req_id)
            return
        doc = frame.model_dump(mode="json")
        if frame.type == "accepted":
            _settle(pending.ack, doc)
        elif frame.type == "rejected":
            if pending.ack.done():
                _settle(pending.result, doc)
            else:
                _settle(pending.ack, doc)
        else:  # result: the terminal frame; without an accepted before it, an implicit accept
            if not pending.ack.done():
                _settle(pending.ack, doc)
            _settle(pending.result, doc)

    # ------------------------------------------------------------------ outbound requests
    async def _send_cancel(self, conn: BridgeConnection, req_id: str) -> None:
        try:
            await conn.send_json({"type": "cancel", "req_id": req_id})
        except Exception as e:  # a dead socket: nothing to cancel any more
            log.debug("bridge: cancel for req=%s not sent: %s", req_id, e)

    async def request(
        self, frame: dict[str, Any], *, accept_timeout_s: float, timeout_s: float
    ) -> AsyncIterator[dict[str, Any]]:
        """Send one `request` frame and yield its replies: the `accepted` (or `rejected`) frame,
        then the `result`. Raises `BridgeError`; sends `cancel` on timeout or early close."""
        conn = self._conn
        if conn is None:
            raise BridgeError(BRIDGE_UNAVAILABLE, "no desktop client is connected")
        req_id = str(frame["req_id"])
        loop = asyncio.get_running_loop()
        pending = _Pending(conn=conn, ack=loop.create_future(), result=loop.create_future())
        self._pending[req_id] = pending
        deadline = loop.time() + timeout_s
        settled = False
        cancel_sent = False
        try:
            try:
                await conn.send_json(frame)
            except Exception as e:
                raise BridgeError(BRIDGE_DISCONNECTED, f"could not send the request: {e}") from e
            try:
                ack = await asyncio.wait_for(pending.ack, min(accept_timeout_s, timeout_s))
            except TimeoutError:
                raise BridgeError(
                    BRIDGE_NO_ACK, f"no accepted/rejected within {accept_timeout_s:g}s"
                ) from None
            if ack["type"] != "accepted":  # rejected, or a result without an accepted
                settled = True
                yield ack
                return
            yield ack
            try:
                result = await asyncio.wait_for(pending.result, max(deadline - loop.time(), 0.0))
            except TimeoutError:
                cancel_sent = True
                await self._send_cancel(conn, req_id)
                raise BridgeError(
                    TIMEOUT, f"no result within {timeout_s:g}s; cancel sent"
                ) from None
            settled = True
            yield result
        finally:
            self._pending.pop(req_id, None)
            if not settled and not cancel_sent and conn is self._conn:
                await self._send_cancel(conn, req_id)

    # ------------------------------------------------------------------ liveness
    async def ping(self, conn: BridgeConnection) -> bool:
        """One tick of the ping loop for `conn`. False when `conn` is no longer the client or
        was just closed for two missed pongs (pending requests failed `bridge_disconnected`)."""
        if conn is not self._conn:
            return False
        if self._awaiting_pong:
            self._missed_pongs += 1
            if self._missed_pongs >= MISSED_PONGS_LIMIT:
                log.warning(
                    "bridge: %d pings unanswered; closing the desktop client", self._missed_pongs
                )
                self._fail_pending(
                    BRIDGE_DISCONNECTED, "the desktop client stopped answering pings"
                )
                self._clear()
                with contextlib.suppress(Exception):
                    await conn.close(CLOSE_PONG_TIMEOUT, "pong timeout")
                return False
        self._awaiting_pong = True
        try:
            await conn.send_json({"type": "ping", "ts": _now_ms()})
        except Exception as e:
            log.debug("bridge: ping not sent: %s", e)
        return True

    # ------------------------------------------------------------------ status
    def status(self) -> dict[str, Any]:
        connected = self._conn is not None
        capture = self._capture.model_dump() if self._capture is not None else {}
        sites: dict[str, Any] = {}
        for slot in SLOT_IDS:
            entry = self._health.get(slot)
            sites[slot] = {
                "capture": bool(capture.get(slot, False)),
                "health": entry.health.model_dump(mode="json") if entry is not None else None,
                "health_ts": entry.ts if entry is not None else None,
            }
        return {
            "connected": connected,
            "protocol": PROTOCOL_VERSION if connected else None,
            "version": self._hello.version if self._hello is not None else None,
            "since": self._since,
            "sites": sites,
            "analyst": self._analyst.slot if self._analyst is not None else None,
            "inflight": len(self._pending),
        }


hub = BridgeHub()


# --------------------------------------------------------------------------- the transport
def _error(code: Any, message: str, error_type: str) -> Delta:
    return Delta(kind="error", code=code, message=message, error_type=error_type)


async def stream(
    *,
    role: str,
    purpose: str,
    model: str,
    messages: list[dict[str, Any]],
    max_tokens: int | None,
) -> AsyncIterator[Delta]:
    """Section 1 "Delta mapping". Never raises; exactly one terminal delta."""
    del max_tokens  # the site decides
    started = time.monotonic()
    req_id = str(uuid.uuid4())
    slot: str = "-"
    view: str = "-"
    outcome = "ok"
    # What the INFO line reports about the capture itself (Workstream E, 2026-09-20): which end
    # signal ended it and how many characters came back. The failure that prompted this -- a
    # 13-character analyst reply stamped `ok` after 78 s, because the capture ended while the site
    # was still typing -- had to be reconstructed afterwards from the persisted raw_attempts,
    # since the log said only `ok ms=78512`. Counts and the signal name only: never any text.
    done_by = "-"
    chars = 0
    try:
        try:
            slot, view = parse_web_model(model)
        except ValueError as e:
            outcome = BRIDGE_BAD_MODEL
            yield _error(BRIDGE_BAD_MODEL, str(e), ERROR_TYPE_TRIPLEX)
            return
        if not hub.connected:
            outcome = BRIDGE_UNAVAILABLE
            yield _error(BRIDGE_UNAVAILABLE, "no desktop client is connected", ERROR_TYPE_TRIPLEX)
            return
        try:
            frame = build_request(
                req_id=req_id,
                model=model,
                messages=messages,
                role=role,
                purpose=purpose,
                conversation_id=current_conversation(),
                timeout_s=timeout_s(),
            )
        except ValueError as e:
            outcome = TRANSPORT_ERROR
            yield _error(
                TRANSPORT_ERROR, f"cannot build the bridge request: {e}", ERROR_TYPE_TRIPLEX
            )
            return
        try:
            async with contextlib.aclosing(
                hub.request(frame, accept_timeout_s=accept_timeout_s(), timeout_s=timeout_s())
            ) as replies:
                async for reply in replies:
                    kind = reply["type"]
                    if kind == "rejected":
                        outcome = reply["code"]
                        yield _error(reply["code"], reply["message"], ERROR_TYPE_SITE)
                        return
                    if kind != "result":
                        continue  # accepted: nothing to emit yet
                    if reply["ok"] is False:
                        outcome = reply["code"]
                        partial = reply.get("partial")
                        if isinstance(partial, str) and partial:
                            chars = len(partial)  # what the site had produced before it failed
                            yield Delta(kind="text", text=partial)
                        yield _error(reply["code"], reply["message"], ERROR_TYPE_SITE)
                        return
                    if reply["captured"] is False:
                        outcome = NOT_CAPTURED
                        yield _error(
                            NOT_CAPTURED,
                            f"capture is off for {slot}; the reply is in the site pane",
                            ERROR_TYPE_TRIPLEX,
                        )
                        return
                    text = reply["text"]
                    done_by = reply.get("done_by") or "-"
                    chars = len(text)
                    if text.strip():
                        yield Delta(kind="text", text=text)
                    yield Delta(
                        kind="done",
                        finish_reason="stop",
                        truncated=False,
                        usage=Usage(model=model, role=role, purpose=purpose),
                    )
                    return
        except BridgeError as e:
            outcome = e.code
            yield _error(e.code, e.message, ERROR_TYPE_TRIPLEX)
            return
        # The hub's generator ended without a terminal frame: impossible by construction.
        outcome = BRIDGE_DISCONNECTED
        yield _error(
            BRIDGE_DISCONNECTED, "the bridge request ended without a result", ERROR_TYPE_TRIPLEX
        )
    except Exception as e:  # pragma: no cover - last line of defence: never raises
        log.exception("bridge stream failed")
        outcome = TRANSPORT_ERROR
        yield _error(TRANSPORT_ERROR, f"{type(e).__name__}: {e}", ERROR_TYPE_TRIPLEX)
    finally:
        log.info(
            "bridge req=%s slot=%s view=%s purpose=%s %s ms=%d done_by=%s chars=%d",
            req_id,
            slot,
            view,
            purpose,
            "ok" if outcome == "ok" else f"code={outcome}",
            int((time.monotonic() - started) * 1000),
            done_by,
            chars,
        )


__all__ = [
    "BACKEND_VERSION",
    "BRIDGE_BAD_MODEL",
    "BRIDGE_DISCONNECTED",
    "BRIDGE_NO_ACK",
    "BRIDGE_UNAVAILABLE",
    "CLOSE_BAD_TOKEN",
    "CLOSE_HELLO_TIMEOUT",
    "CLOSE_MALFORMED",
    "CLOSE_PONG_TIMEOUT",
    "CLOSE_SUPERSEDED",
    "CURRENT_CONVERSATION",
    "ERROR_TYPE_SITE",
    "NOT_CAPTURED",
    "PROTOCOL_VERSION",
    "TRANSPORT_DISABLED",
    "BridgeConnection",
    "BridgeError",
    "BridgeHub",
    "accept_timeout_s",
    "bridge_token",
    "build_request",
    "conversation_scope",
    "current_conversation",
    "hub",
    "parse_web_model",
    "ping_s",
    "stream",
    "text_for",
    "timeout_s",
]
