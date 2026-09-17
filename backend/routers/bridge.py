"""Bridge endpoints (owner: bridge-backend S2) -- docs/desktop-contract.md sections 1 and 6.

    WS  /api/bridge          the ONE Electron client
    GET /api/bridge/status   -> bridge.hub.status()

Handshake: accept -> a browser `Origin` header whose host is not loopback (127.0.0.1 /
localhost / ::1) closes 4003 at once (Electron's Node WebSocket sends no Origin and a missing
Origin is fine; a page reached through DNS rebinding must never attach as the desktop) -> the
first frame must arrive within `HELLO_TIMEOUT_S` (10 s; else close 4004) -> it must parse
(`bridge_protocol.parse_client_frame`) as a `hello` (else 4001) -> the token must equal
`BRIDGE_TOKEN` (else close 4003 BEFORE any ack; an unset token accepts any hello with a
WARNING) -> `hello_ack{ping_s}` (a peer that vanished before the ack never reaches the hub) ->
`hub.attach` (a second valid hello supersedes: the hub closes the old socket 4002 and fails its
pending requests) -> the receive loop hands every parsed frame to `hub.dispatch(conn, frame)`
(the hub drops frames from a superseded socket); a malformed frame after the handshake closes
the socket 4001 (the JS validator on the other side never sends one); the ping task sends
`ping` every `BRIDGE_PING_S` through `hub.ping` (two missed pongs -> 1011) -> `hub.detach` on
disconnect. Everything from `attach` onward runs inside ONE try/finally, so a socket that dies
at any later point always detaches and the hub never stays "connected" to a dead peer.

The token never appears in a URL (it travels inside the hello frame) and never in a log line:
the accept line names the version, the sites and the capture map only. Frame bodies are never
logged either.
"""

from __future__ import annotations

import asyncio
import contextlib
import hmac
import json
import logging
from typing import Any
from urllib.parse import urlsplit

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from ..llm import bridge
from ..llm import bridge_protocol as bp

log = logging.getLogger("triplex.routers.bridge")

router = APIRouter(prefix="/api/bridge", tags=["bridge"])

HELLO_TIMEOUT_S = 10.0
LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})


def origin_is_loopback(origin: str | None) -> bool:
    """True for a missing Origin (Electron's Node WebSocket sends none) or one whose host is
    loopback; False for anything else -- `null`, an empty value and unparsable ones included."""
    if origin is None:
        return True
    try:
        host = urlsplit(origin.strip()).hostname
    except ValueError:
        return False
    return host is not None and host.lower() in LOOPBACK_HOSTS


class _WsConnection:
    """`bridge.BridgeConnection` over a Starlette WebSocket; `close` never raises."""

    def __init__(self, websocket: WebSocket) -> None:
        self._ws = websocket

    async def send_json(self, obj: dict[str, Any]) -> None:
        await self._ws.send_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")))

    async def close(self, code: int, reason: str) -> None:
        try:
            await self._ws.close(code=code, reason=reason)
        except Exception:  # already closed by the peer or by an earlier close
            log.debug("bridge: close(%d) on a closed socket", code)


async def _receive_text(websocket: WebSocket) -> str | None:
    """The next text frame, or None on disconnect; a binary frame is a protocol error (a
    `ValueError`, so the caller treats it like a malformed frame)."""
    message = await websocket.receive()
    if message["type"] == "websocket.disconnect":
        return None
    text = message.get("text")
    if not isinstance(text, str):
        raise ValueError("binary frame")
    return text


async def _ping_loop(conn: _WsConnection, interval_s: float) -> None:
    try:
        while True:
            await asyncio.sleep(interval_s)
            if not await bridge.hub.ping(conn):
                return
    except asyncio.CancelledError:
        raise
    except Exception:  # pragma: no cover - defensive: the loop must never take the handler down
        log.exception("bridge ping loop failed")


@router.websocket("")
async def bridge_socket(websocket: WebSocket) -> None:
    await websocket.accept()
    # ---- handshake ---------------------------------------------------------------------
    if not origin_is_loopback(websocket.headers.get("origin")):
        log.warning("bridge: non-loopback Origin on the handshake; closing 4003")
        await websocket.close(code=bridge.CLOSE_BAD_TOKEN, reason="bad origin")
        return
    try:
        raw = await asyncio.wait_for(_receive_text(websocket), HELLO_TIMEOUT_S)
    except TimeoutError:
        log.warning("bridge: no hello within %gs; closing 4004", HELLO_TIMEOUT_S)
        await websocket.close(code=bridge.CLOSE_HELLO_TIMEOUT, reason="hello timeout")
        return
    except (WebSocketDisconnect, ValueError):
        with contextlib.suppress(Exception):  # a peer that vanished mid-handshake
            await websocket.close(code=bridge.CLOSE_MALFORMED, reason="malformed hello")
        return
    if raw is None:
        return
    try:
        frame = bp.parse_client_frame(json.loads(raw))
    except ValueError:
        log.warning("bridge: malformed first frame; closing 4001")
        await websocket.close(code=bridge.CLOSE_MALFORMED, reason="malformed hello")
        return
    if not isinstance(frame, bp.Hello):
        log.warning("bridge: first frame was %r, not hello; closing 4001", frame.type)
        await websocket.close(code=bridge.CLOSE_MALFORMED, reason="hello expected")
        return
    expected = bridge.bridge_token()
    if expected is None:
        log.warning("bridge: BRIDGE_TOKEN is unset; accepting any hello")
    elif not hmac.compare_digest(frame.token.encode(), expected.encode()):
        log.warning("bridge: hello with a bad token; closing 4003")
        await websocket.close(code=bridge.CLOSE_BAD_TOKEN, reason="bad token")
        return

    conn = _WsConnection(websocket)
    interval = max(1, int(round(bridge.ping_s())))
    ack = bp.HelloAck(
        type="hello_ack",
        protocol=bridge.PROTOCOL_VERSION,
        backend_version=bridge.BACKEND_VERSION,
        ping_s=interval,
    )
    # The ack goes out BEFORE the hub learns about the socket: a peer that vanished right after
    # its hello never becomes the client (the hub would otherwise report `connected` to a dead
    # socket with no ping loop to notice), and no `request` can precede the `hello_ack` the
    # client waits for.
    try:
        await conn.send_json(ack.model_dump(mode="json"))
    except Exception:
        log.warning("bridge: hello_ack could not be sent; the client is gone")
        return
    ping_task: asyncio.Task[None] | None = None
    try:
        superseded = bridge.hub.attach(conn, frame)
        log.info(
            "bridge client accepted version=%s sites=%s capture=%s analyst=%s superseded=%s",
            frame.version,
            ",".join(frame.sites),
            ",".join(f"{k}={'on' if v else 'off'}" for k, v in frame.capture.model_dump().items()),
            frame.analyst.slot if frame.analyst is not None else "-",
            superseded is not None,
        )
        ping_task = asyncio.create_task(
            _ping_loop(conn, float(interval)), name="triplex-bridge-ping"
        )
        # ---- receive loop ---------------------------------------------------------------
        while True:
            try:
                raw = await _receive_text(websocket)
            except WebSocketDisconnect:
                break
            except ValueError:  # a binary frame: the protocol is JSON text only
                log.warning("bridge: binary frame; closing 4001")
                await conn.close(bridge.CLOSE_MALFORMED, "malformed frame")
                break
            if raw is None:
                break
            try:
                bridge.hub.dispatch(conn, bp.parse_client_frame(json.loads(raw)))
            except ValueError:
                log.warning("bridge: malformed frame; closing 4001")
                await conn.close(bridge.CLOSE_MALFORMED, "malformed frame")
                break
    finally:
        if ping_task is not None:
            ping_task.cancel()
        if bridge.hub.detach(conn):
            log.info("bridge client disconnected")


@router.get("/status")
async def bridge_status() -> dict[str, Any]:
    return bridge.hub.status()
