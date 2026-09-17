"""OpenRouter client (owner: W1). The ONLY code that talks to OpenRouter.

- `stream_completion(...)`: async generator of `Delta`. NEVER raises. Zero or more
  `text | reasoning | citations` deltas, then exactly one terminal `done` (with `usage`) or
  `error{code, message, error_type}` delta, nothing after it. Dispatches to `mock.stream` when
  `settings().mock_openrouter` is true; otherwise POSTs `{base}/chat/completions` with
  `stream: true` through one `httpx.AsyncClient` per call and drives `stream.SSEParser`.
- `complete_json(...)`: streams internally, concatenates text, lenient JSON parse, pydantic
  validation, at most `retries + 1` attempts (docs/api-contract.md addendum).

Cost cap: with `MOCK_OPENROUTER=0`, once the process-level running total of `cost_usd` reaches
`SESSION_COST_CAP_USD` every live call yields a single
`Delta(kind="error", code="cost_cap_exceeded", error_type="triplex")`.

Cost (docs/semantics.md, Metering/logging): `cost_usd` = the usage chunk's `cost`; when the chunk
carries no cost the live transport asks `GET {base}/generation?id=<generation_id>` for
`data.total_cost` (short timeout, never raises, live only) before settling for the catalog
price x tokens the parser already filled in. One INFO line per call, with `usage=estimated`
when no usage chunk arrived at all.

A consumer that stops early (`aclose()` on the generator) closes the inner transport at once:
the open httpx response / client and the record tee are released before `aclose()` returns.

The INFO line of a live call also names its cost source (`cost_source=chunk|generation|catalog`)
so a live check can prove `usage.cost` really arrived in the usage chunk; the mock transport
carries no such field.

Transports (docs/desktop-contract.md section 6, bridge-backend S2): `transport_kind(model)` routes
`web:<slot>[:analyst]` models to `bridge.stream` BEFORE the mock branch (a desktop session is
never replayed from fixtures, and the root conftest's `MOCK_OPENROUTER=1` keeps the fixed
R1/R2/R3 map for bridge tests); under `TRIPLEX_DESKTOP=1` every other model is refused with
`transport_disabled` before the cost-cap / key checks so nothing can reach OpenRouter from the
desktop. The `ollama:` branch is Stage 3 (desktop-catalog-and-ollama): until it lands an
`ollama:` model is refused under the desktop like any non-web model and otherwise handed to the
mock / OpenRouter path unchanged. `_live_stream` takes `base_url=`, `headers=`, `cost_lookup=`
for that stage; the defaults reproduce today's behaviour byte for byte.
"""

from __future__ import annotations

import json
import logging
import math
import os
import re
import time
import uuid
from collections.abc import AsyncGenerator, AsyncIterator
from pathlib import Path
from typing import Any, Literal

import httpx
from pydantic import BaseModel, ValidationError

from ..config import settings
from ..schemas import Delta, Effort, FeatureUsage, canonical_request_key, strict_json_schema
from . import bridge, catalog, metering, mock
from . import reasoning as reasoning_mod
from .errors import (
    COST_CAP_EXCEEDED,
    ERROR_TYPE_TRIPLEX,
    HTTP_ERROR,
    MISSING_API_KEY,
    PARSE_ERROR,
    TIMEOUT,
    TRANSPORT_ERROR,
)
from .stream import DONE_SENTINEL, SSEParser

log = logging.getLogger("triplex.llm.client")

RETRY_USER_MESSAGE = (
    "Your previous output failed validation: {error}. Return only the corrected JSON."
)

# --------------------------------------------------------------------------- payload / headers


def build_payload(
    *,
    model: str,
    messages: list[dict[str, Any]],
    reasoning: dict[str, Any] | None,
    max_tokens: int | None,
    response_format: dict[str, Any] | None,
    plugins: list[dict[str, Any]] | None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {"model": model, "messages": messages, "stream": True}
    if max_tokens is not None:
        payload["max_tokens"] = int(max_tokens)
    if reasoning is not None:
        payload["reasoning"] = reasoning
    if response_format is not None:
        payload["response_format"] = response_format
        # A required response_format must be served by a provider that honours it.
        payload["provider"] = {"require_parameters": True}
    if plugins:
        payload["plugins"] = plugins
    return payload


def build_headers(api_key: str, http_referer: str, app_title: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
        "HTTP-Referer": http_referer,
        "X-OpenRouter-Title": app_title,
    }


def transport_kind(model: str) -> Literal["web", "ollama", "openrouter"]:
    """`web:x` / `web:x:analyst` -> "web"; `ollama:x` -> "ollama"; everything else "openrouter"."""
    if isinstance(model, str):
        if model.startswith("web:"):
            return "web"
        if model.startswith("ollama:"):
            return "ollama"
    return "openrouter"


def desktop_mode() -> bool:
    """`TRIPLEX_DESKTOP=1` (private env read; config.py is frozen)."""
    return os.environ.get("TRIPLEX_DESKTOP", "0").strip() == "1"


def structured_response_format(purpose: str, schema_model: type[BaseModel]) -> dict[str, Any]:
    return {
        "type": "json_schema",
        "json_schema": {
            "name": purpose,
            "strict": True,
            "schema": strict_json_schema(schema_model),
        },
    }


def _messages_text(messages: list[dict[str, Any]]) -> str:
    try:
        return "\n".join(str(m.get("content", "")) for m in messages if isinstance(m, dict))
    except Exception:  # pragma: no cover - defensive
        return ""


# --------------------------------------------------------------------------- recording (live tee)
# (record dir, role, purpose) -> highest number WRITTEN in this process; seeded from disk.
_record_counters: dict[tuple[str, str, str], int] = {}
_RECORD_NAME_ATTEMPTS = 1000


class _Recorder:
    """Tees the raw `data:` JSON lines of a live call into the fixture format (docs/fixtures.md)
    under MOCK_RECORD_DIR:

    - `<role>.<purpose>.<n>.jsonl` -- the scenario layout, so pointing MOCK_RECORD_DIR at
      `<fixtures>/scenarios/<name>` records a scenario `MOCK_SCENARIO=<name>` replays. `n` is
      allocated in `close()`, and only when there is a transcript to write: a call that never
      produced a line (a timeout or transport error before the first byte) consumes no number,
      so the numbering on disk stays contiguous -- the corpus validator rejects a `.2` without a
      `.1`, and counter replay would serve `mock_miss` for the first call. `n` continues from the
      files already on disk (a process restart never renumbers from 1) and a transcript file is
      only ever CREATED, never truncated: mode "x", and a name a concurrent writer took moves on
      to the next number.
    - a pre-stream provider failure (a non-2xx response, or a JSON `{"error": ...}` document
      under HTTP 200) is recorded through `error()` as the canonical one-line error fixture, so
      replay reproduces the failure (code / error_type) exactly as live. Such a transcript is
      `synthetic`: it gets a numbered file and a `requests.jsonl` line but NO `recorded/` copy --
      the content-keyed copy keeps the FIRST recording of a request, and a transient 429 must not
      mask the successful transcript of the same request recorded later.
    - `recorded/<sha256>.jsonl` -- the content-keyed copy the mock serves first when
      `MOCK_FIXTURES_DIR` points at MOCK_RECORD_DIR (the first recording of a request is kept).
    - `requests.jsonl` -- one line per call: the payload and both fixture names as written
      (`fixture: null` when the call produced nothing to record).
    """

    def __init__(self, directory: Path, role: str, purpose: str, payload: dict[str, Any]) -> None:
        self.dir = directory
        self.role = role
        self.purpose = purpose
        self.payload = payload
        self.key = (str(directory), role, purpose)
        self.n: int | None = None  # allocated in close(), only when a transcript exists
        self.lines: list[str] = []
        self.synthetic = False  # the transcript is a synthesised error line, not provider SSE

    @property
    def name(self) -> str:
        if self.n is None:  # pragma: no cover - programming error guard
            raise RuntimeError("fixture number not allocated yet")
        return f"{self.role}.{self.purpose}.{self.n}.jsonl"

    def line(self, raw: str) -> None:
        s = raw.strip()
        if not s or s.startswith(":") or not s.startswith("data:"):
            return
        payload = s[5:].strip()
        if not payload or payload == DONE_SENTINEL:
            return
        self.lines.append(payload)

    def error(self, delta: Delta, gen_id: str | None = None) -> None:
        """Record a pre-stream provider failure as the canonical error fixture line
        (docs/fixtures.md `error`): top-level `error{code, message, metadata.error_type}` plus
        an empty choice with `finish_reason: "error"`. `id` is the response's generation id when
        OpenRouter sent one, else a unique synthetic one (the corpus validator requires a
        non-empty first-chunk id, unique per fixture). Never overwrites streamed provider data."""
        if self.lines:
            return
        code = delta.code if delta.code is not None else HTTP_ERROR
        line = {
            "id": gen_id or f"gen-error-{uuid.uuid4().hex[:12]}",
            "error": {
                "code": code,
                "message": delta.message or str(code),
                "metadata": {"error_type": delta.error_type or HTTP_ERROR},
            },
            "choices": [{"index": 0, "delta": {"content": ""}, "finish_reason": "error"}],
        }
        self.lines.append(json.dumps(line, ensure_ascii=False))
        self.synthetic = True

    def _create(self, path: Path) -> bool:
        """Write the transcript to a NEW file; False (nothing touched) when it already exists."""
        try:
            with path.open("x", encoding="utf-8") as fh:
                fh.write("\n".join(self.lines) + "\n")
        except FileExistsError:
            return False
        return True

    def close(self) -> None:
        try:
            self.dir.mkdir(parents=True, exist_ok=True)
            fixture: str | None = None
            recorded: str | None = None
            if self.lines:
                # Allocate the number NOW, not at construction: a call that produced nothing has
                # consumed nothing, so <role>.<purpose>.<n> stays contiguous on disk.
                existing = mock.existing_numbers(self.dir, self.role, self.purpose)
                self.n = max([_record_counters.get(self.key, 0), *existing]) + 1
                _record_counters[self.key] = self.n
                for _ in range(_RECORD_NAME_ATTEMPTS):
                    if self._create(self.dir / self.name):
                        fixture = self.name
                        break
                    # Another writer (a parallel process) took this number since the listing
                    # above: never truncate its transcript, move on to the next free one.
                    self.n += 1
                    _record_counters[self.key] = max(_record_counters.get(self.key, 0), self.n)
                if fixture is None:
                    log.warning(
                        "no free fixture name for %s.%s under %s", self.role, self.purpose, self.dir
                    )
                if not self.synthetic:
                    sha = canonical_request_key(
                        str(self.payload.get("model", "")),
                        list(self.payload.get("messages") or []),
                        self.payload.get("response_format"),
                    )
                    recorded = f"recorded/{sha}.jsonl"
                    rec_path = self.dir / recorded
                    rec_path.parent.mkdir(parents=True, exist_ok=True)
                    if not self._create(rec_path):
                        log.info(
                            "recorded fixture %s exists; kept the earlier transcript", rec_path
                        )
            with (self.dir / "requests.jsonl").open("a", encoding="utf-8") as fh:
                fh.write(
                    json.dumps(
                        {
                            "fixture": fixture,
                            "recorded": recorded,
                            "role": self.role,
                            "purpose": self.purpose,
                            "model": self.payload.get("model"),
                            "payload": self.payload,
                        },
                        ensure_ascii=False,
                    )
                    + "\n"
                )
            if fixture is not None:
                log.info("recorded %s/%s", self.dir, fixture)
        except OSError as e:
            log.warning("could not record fixture under %s: %s", self.dir, e)


# --------------------------------------------------------------------------- live transport
def _http_error_delta(status: int, body: bytes) -> Delta:
    code: int | str = status
    message = ""
    error_type: str | None = HTTP_ERROR
    try:
        doc = json.loads(body.decode("utf-8", errors="replace"))
    except ValueError:
        doc = None
    if isinstance(doc, dict) and isinstance(doc.get("error"), dict):
        err = doc["error"]
        c = err.get("code")
        if isinstance(c, int | str) and not isinstance(c, bool):
            code = c
        msg = err.get("message")
        message = msg if isinstance(msg, str) else json.dumps(msg) if msg is not None else ""
        meta = err.get("metadata") if isinstance(err.get("metadata"), dict) else {}
        et = meta.get("error_type")
        error_type = et if isinstance(et, str) else HTTP_ERROR
    if not message:
        text = body.decode("utf-8", errors="replace").strip()
        message = text[:300] if text else f"HTTP {status}"
    return Delta(kind="error", code=code, message=message, error_type=error_type)


def _stamp_generation(d: Delta, gen_id: str | None) -> Delta:
    if gen_id:
        d.generation_id = gen_id
        if d.usage is not None:
            d.usage.generation_id = gen_id
    return d


GENERATION_TIMEOUT_S = 10.0  # upper bound for the post-hoc /generation cost lookup
_STRAY_BODY_LIMIT = 4096  # bytes of a non-SSE 2xx body kept for the error message


async def _fetch_generation_cost(
    client: httpx.AsyncClient,
    base: str,
    gen_id: str,
    headers: dict[str, str],
    timeout_s: float,
) -> float | None:
    """`GET {base}/generation?id=<gen_id>` -> `data.total_cost` (USD). None on ANY failure
    (non-2xx, transport error, timeout, malformed body, non-finite or negative value); logs at
    DEBUG and never raises. docs/openrouter-notes.md, "Generation endpoint"."""
    try:
        req_headers = {k: v for k, v in headers.items() if k.lower() != "content-type"}
        req_headers["Accept"] = "application/json"
        resp = await client.get(
            base + "/generation", params={"id": gen_id}, headers=req_headers, timeout=timeout_s
        )
        if not (200 <= resp.status_code < 300):
            log.debug("generation lookup %s: HTTP %s", gen_id, resp.status_code)
            return None
        doc = resp.json()
        data = doc.get("data") if isinstance(doc, dict) else None
        cost = metering.float_or_none(data.get("total_cost")) if isinstance(data, dict) else None
        if cost is None or not math.isfinite(cost) or cost < 0:
            log.debug("generation lookup %s: no usable total_cost", gen_id)
            return None
        return cost
    except Exception as e:
        log.debug("generation lookup %s failed: %s: %s", gen_id, type(e).__name__, e)
        return None


def _non_sse_body_deltas(parser: SSEParser, body: str) -> list[Delta]:
    """A 2xx response whose body carried no SSE data at all. A JSON `{"error": ...}` document
    (a proxy error under HTTP 200) maps through the parser's error rule; anything else is a
    transport error -- never a successful empty `done`."""
    doc = _try_load(body)
    if isinstance(doc, dict) and doc.get("error") is not None:
        out = parser.feed("data: " + json.dumps(doc, ensure_ascii=False))
        if parser.finished:
            return out
    parser.finished = True
    return [
        Delta(
            kind="error",
            code=TRANSPORT_ERROR,
            message=f"response was not an SSE stream: {body[:300]}",
            error_type=ERROR_TYPE_TRIPLEX,
        )
    ]


async def _live_stream(
    *,
    role: str,
    purpose: str,
    model: str,
    messages: list[dict[str, Any]],
    payload: dict[str, Any],
    trace: dict[str, Any] | None = None,
    base_url: str | None = None,
    headers: dict[str, str] | None = None,
    cost_lookup: bool = True,
) -> AsyncIterator[Delta]:
    """The httpx transport. `trace`, when given, receives `cost_source` for the INFO line:
    `chunk` (the usage chunk carried a numeric `cost`), `generation` (filled from
    `GET /generation`) or `catalog` (price x tokens, also for a synthesised usage).

    `base_url=None` -> `settings().openrouter_base_url`; `headers=None` -> `build_headers(...)`
    from the settings; `cost_lookup=False` skips the `GET /generation` cost fallback (an
    OpenAI-compatible local server has no such endpoint). The defaults are today's behaviour."""
    trace = trace if trace is not None else {}
    s = settings()
    base = (base_url if base_url else s.openrouter_base_url).rstrip("/")
    url = base + "/chat/completions"
    headers = (
        dict(headers)
        if headers is not None
        else build_headers(s.openrouter_api_key or "", s.http_referer, s.app_title)
    )
    gen_timeout = min(GENERATION_TIMEOUT_S, s.request_timeout_s)
    parser = SSEParser(
        model=model, role=role, purpose=purpose, prompt_text=_messages_text(messages)
    )
    recorder = _Recorder(s.mock_record_dir, role, purpose, payload) if s.mock_record_dir else None
    gen_id: str | None = None
    stray: list[str] = []  # non-SSE lines of a body that never produced a chunk
    stray_len = 0
    try:
        async with httpx.AsyncClient(timeout=s.request_timeout_s) as client:
            async with client.stream("POST", url, json=payload, headers=headers) as resp:
                gen_id = resp.headers.get("x-generation-id") or None
                if not (200 <= resp.status_code < 300):
                    body = await resp.aread()
                    parser.finished = True
                    err = _http_error_delta(resp.status_code, body)
                    if recorder is not None:
                        recorder.error(err, gen_id)  # replayable; takes a number by writing
                    yield _stamp_generation(err, gen_id)
                    return
                async for line in resp.aiter_lines():
                    if recorder is not None:
                        recorder.line(line)
                    if parser.chunks == 0 and stray_len < _STRAY_BODY_LIMIT:
                        st = line.strip()
                        if st and not st.startswith(("data:", ":", "event:", "id:", "retry:")):
                            stray.append(st)
                            stray_len += len(st)
                    for d in parser.feed(line):
                        if d.kind == "done" and d.usage is not None:
                            # `[DONE]` without a usage chunk synthesises the done delta here
                            # too: price x estimated tokens, not a chunk cost.
                            trace["cost_source"] = "catalog" if parser.synthesized else "chunk"
                            if parser.usage_cost_missing:
                                trace["cost_source"] = "catalog"
                                gid = gen_id or d.generation_id
                                if cost_lookup and gid:
                                    cost = await _fetch_generation_cost(
                                        client, base, gid, headers, gen_timeout
                                    )
                                    if cost is not None:
                                        d.usage.cost_usd = cost
                                        trace["cost_source"] = "generation"
                        yield _stamp_generation(d, gen_id)
                    if parser.finished:
                        break
                if not parser.finished and parser.chunks == 0 and stray:
                    for d in _non_sse_body_deltas(parser, "\n".join(stray)):
                        if recorder is not None and d.kind == "error" and parser.chunks:
                            # A provider error document under HTTP 200 went through the parser:
                            # replayable, unlike a stray non-JSON body (left unrecorded).
                            recorder.error(d, gen_id)
                        yield _stamp_generation(d, gen_id)
        if not parser.finished:
            trace["cost_source"] = "catalog"
            for d in parser.finish():
                yield _stamp_generation(d, gen_id)
    except httpx.TimeoutException as e:
        if not parser.finished:
            parser.finished = True
            yield Delta(
                kind="error",
                code=TIMEOUT,
                message=f"request timed out after {s.request_timeout_s:g}s ({type(e).__name__})",
                error_type="timeout",
            )
    except httpx.HTTPError as e:
        if not parser.finished:
            parser.finished = True
            yield Delta(
                kind="error",
                code=TRANSPORT_ERROR,
                message=f"{type(e).__name__}: {e}",
                error_type=ERROR_TYPE_TRIPLEX,
            )
    except Exception as e:  # never raises across the boundary
        log.exception("unexpected transport failure")
        if not parser.finished:
            parser.finished = True
            yield Delta(
                kind="error",
                code=TRANSPORT_ERROR,
                message=f"{type(e).__name__}: {e}",
                error_type=ERROR_TYPE_TRIPLEX,
            )
    finally:
        if recorder is not None:
            recorder.close()


# --------------------------------------------------------------------------- public API
async def stream_completion(
    *,
    role: str,
    purpose: str,
    model: str,
    messages: list[dict[str, Any]],
    effort: Effort | None,
    max_tokens: int | None,
    response_format: dict[str, Any] | None = None,
    plugins: list[dict[str, Any]] | None = None,
) -> AsyncIterator[Delta]:
    started = time.monotonic()
    terminal = False
    gen: AsyncGenerator[Delta, None] | None = None
    trace: dict[str, Any] = {}  # filled by the live transport (cost_source)
    try:
        s = settings()
        meta = catalog.get_meta(model)
        reasoning_param, _applied, _coerced = reasoning_mod.build(effort, meta)
        payload = build_payload(
            model=model,
            messages=messages,
            reasoning=reasoning_param,
            max_tokens=max_tokens,
            response_format=response_format,
            plugins=plugins,
        )
        is_mock = s.mock_openrouter
        kind = transport_kind(model)

        if kind == "web":  # Stage 2 -- BEFORE the mock branch: a web session is never a fixture
            is_mock = False  # the bridge's zero usage is real usage, not a replayed chunk
            gen = bridge.stream(
                role=role, purpose=purpose, model=model, messages=messages, max_tokens=max_tokens
            )
        # elif kind == "ollama":  # Stage 3 (desktop-catalog-and-ollama) -- placeholder:
        #     gen = _live_stream(role=role, purpose=purpose, model=ollama.model_name(model),
        #                        messages=messages, payload=ollama.sanitize_payload(payload, model),
        #                        trace=trace, base_url=os.environ.get("OLLAMA_BASE_URL", ...),
        #                        headers=ollama.headers(), cost_lookup=False)
        #     Until then `ollama:` falls through: refused under the desktop (below), otherwise
        #     the mock / OpenRouter path unchanged.
        elif desktop_mode():  # Stage 2 guard: never OpenRouter from the desktop
            terminal = True
            msg = (
                "desktop mode: only web:<slot> and ollama:<name> models are allowed; "
                "choose an analyst in the config bar"
            )
            log.warning(
                metering.format_error_log_line(
                    role=role,
                    purpose=purpose,
                    model=model,
                    code=bridge.TRANSPORT_DISABLED,
                    error_type=ERROR_TYPE_TRIPLEX,
                    message=msg,
                    latency_ms=0,
                )
            )
            yield Delta(
                kind="error",
                code=bridge.TRANSPORT_DISABLED,
                message=msg,
                error_type=ERROR_TYPE_TRIPLEX,
            )
            return
        elif is_mock:
            gen = mock.stream(
                role=role,
                purpose=purpose,
                model=model,
                messages=messages,
                reasoning=reasoning_param,
                response_format=response_format,
                plugins=plugins,
                max_tokens=max_tokens,
            )
        else:
            cap = s.session_cost_cap_usd
            spent = metering.session_cost_usd()
            if spent >= cap:
                terminal = True
                msg = (
                    f"session cost cap reached: spent ${spent:.4f} of "
                    f"SESSION_COST_CAP_USD=${cap:.2f}; live calls refused"
                )
                log.warning(
                    metering.format_error_log_line(
                        role=role,
                        purpose=purpose,
                        model=model,
                        code=COST_CAP_EXCEEDED,
                        error_type=ERROR_TYPE_TRIPLEX,
                        message=msg,
                        latency_ms=0,
                    )
                )
                yield Delta(
                    kind="error", code=COST_CAP_EXCEEDED, message=msg, error_type=ERROR_TYPE_TRIPLEX
                )
                return
            if not s.openrouter_api_key:
                terminal = True
                msg = "OPENROUTER_API_KEY is not set; live calls are impossible"
                yield Delta(
                    kind="error", code=MISSING_API_KEY, message=msg, error_type=ERROR_TYPE_TRIPLEX
                )
                return
            gen = _live_stream(
                role=role,
                purpose=purpose,
                model=model,
                messages=messages,
                payload=payload,
                trace=trace,
            )

        async for d in gen:
            if terminal:
                break
            if d.kind == "done":
                terminal = True
                latency = int((time.monotonic() - started) * 1000)
                u = d.usage
                if u is None:
                    u = metering.estimate_usage(
                        model=model, completion_text="", role=role, purpose=purpose
                    )
                u.role = role
                u.purpose = purpose
                u.model = model
                u.latency_ms = latency
                if d.generation_id and not u.generation_id:
                    u.generation_id = d.generation_id
                d.usage = u
                if not is_mock:
                    metering.add_session_cost(u.cost_usd)
                estimated = isinstance(u, metering.EstimatedUsage)
                log.info(
                    metering.format_log_line(
                        u, estimated=estimated, mock=is_mock, cost_source=trace.get("cost_source")
                    )
                )
                yield d
            elif d.kind == "error":
                terminal = True
                latency = int((time.monotonic() - started) * 1000)
                log.warning(
                    metering.format_error_log_line(
                        role=role,
                        purpose=purpose,
                        model=model,
                        code=d.code,
                        error_type=d.error_type,
                        message=d.message,
                        latency_ms=latency,
                    )
                )
                yield d
            else:
                yield d
        if not terminal:
            # Transport ended without a terminal delta (cannot happen with SSEParser, but the
            # contract is absolute): synthesise one.
            terminal = True
            latency = int((time.monotonic() - started) * 1000)
            u = metering.estimate_usage(
                model=model, completion_text="", role=role, purpose=purpose, latency_ms=latency
            )
            log.info(metering.format_log_line(u, estimated=True, mock=is_mock))
            yield Delta(kind="done", usage=u)
    except Exception as e:  # pragma: no cover - last line of defence: never raises
        log.exception("stream_completion failed")
        if not terminal:
            yield Delta(
                kind="error",
                code=TRANSPORT_ERROR,
                message=f"{type(e).__name__}: {e}",
                error_type=ERROR_TYPE_TRIPLEX,
            )
    finally:
        # A consumer that stops early (aclose) must release the transport NOW, not when the
        # garbage collector finalises the inner generator: close the httpx response/client and
        # the record tee before returning control.
        if gen is not None:
            try:
                await gen.aclose()
            except Exception:  # pragma: no cover - defensive: never raises across the boundary
                log.exception("closing the transport generator failed")


# --------------------------------------------------------------------------- lenient JSON
_FENCE_RE = re.compile(r"```[A-Za-z0-9_+-]*[ \t]*\r?\n?(.*?)```", re.DOTALL)
_OPEN_FENCE_RE = re.compile(r"```[A-Za-z0-9_+-]*[ \t]*\r?\n?", re.DOTALL)
_MAX_SCAN_STARTS = 500


def _try_load(candidate: str) -> Any | None:
    candidate = candidate.strip()
    if not candidate:
        return None
    try:
        return json.loads(candidate)
    except ValueError:
        return None


def _balanced_objects(text: str) -> tuple[list[str], bool]:
    """Every OUTERMOST balanced `{...}` substring of `text` in order (string-aware inside an
    object; quotes outside any object are prose and ignored), plus whether the text ends inside
    an unclosed object. Objects nested in another object are never candidates on their own: a
    complete inner object must not mask a truncated outer one (the model would then be told its
    output failed validation instead of being cut off)."""
    objects: list[str] = []
    i = 0
    n = len(text)
    for _ in range(_MAX_SCAN_STARTS):
        start = text.find("{", i)
        if start == -1:
            return objects, False
        depth = 0
        in_str = False
        esc = False
        end = -1
        for j in range(start, n):
            ch = text[j]
            if in_str:
                if esc:
                    esc = False
                elif ch == "\\":
                    esc = True
                elif ch == '"':
                    in_str = False
                continue
            if ch == '"':
                in_str = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    end = j
                    break
        if end == -1:
            return objects, True  # unclosed: whatever is nested inside is not a candidate
        objects.append(text[start : end + 1])
        i = end + 1
    return objects, False


def extract_json(text: str) -> tuple[Any | None, str | None]:
    """Lenient JSON extraction: strip code fences, take the outermost {...}. Returns
    (value, None) or (None, error message). Never raises."""
    if not isinstance(text, str):
        return None, "no text"
    raw = text.strip()
    if not raw:
        return None, "empty response"

    candidates: list[str] = [raw]
    for m in _FENCE_RE.finditer(raw):
        candidates.append(m.group(1))
    # An unterminated fence (truncated output): everything after the opening fence.
    om = _OPEN_FENCE_RE.search(raw)
    if om:
        candidates.append(raw[om.end() :])
    first, last = raw.find("{"), raw.rfind("}")
    if first != -1 and last > first:
        candidates.append(raw[first : last + 1])

    for c in candidates:
        v = _try_load(c)
        if isinstance(v, dict):
            return v, None
    truncated = False
    for c in candidates:
        objects, unclosed = _balanced_objects(c)
        truncated = truncated or unclosed
        for obj in objects:
            v = _try_load(obj)
            if isinstance(v, dict):
                return v, None
    for c in candidates:
        v = _try_load(c)
        if v is not None:
            return None, f"expected a JSON object, got {type(v).__name__}"
    return None, "no JSON object found in the response" + (
        " (output may be truncated)" if truncated else ""
    )


async def complete_json(
    *,
    role: str,
    purpose: str,
    model: str,
    messages: list[dict[str, Any]],
    schema_model: type[BaseModel],
    effort: Effort | None,
    max_tokens: int | None,
    retries: int = 1,
) -> tuple[BaseModel | None, str, FeatureUsage, str | None]:
    """Returns (parsed, raw_text, usage, error). Streams internally (docs/semantics.md)."""
    meta = catalog.get_meta(model)
    response_format = (
        structured_response_format(purpose, schema_model)
        if meta is not None and meta.structured_outputs
        else None
    )
    attempts = max(int(retries), 0) + 1
    convo: list[dict[str, Any]] = [dict(m) for m in messages]
    usage = FeatureUsage()
    raw_text = ""
    error: str | None = None
    started = time.monotonic()

    for attempt in range(attempts):
        parts: list[str] = []
        transport_error: Delta | None = None
        truncated = False
        async for d in stream_completion(
            role=role,
            purpose=purpose,
            model=model,
            messages=convo,
            effort=effort,
            max_tokens=max_tokens,
            response_format=response_format,
        ):
            if d.kind == "text":
                parts.append(d.text)
            elif d.kind == "done":
                truncated = bool(d.truncated)
                if d.usage is not None:
                    usage.add(d.usage)
            elif d.kind == "error":
                transport_error = d
        if truncated:
            # The `truncated` flag has no field in this function's frozen return tuple: surface
            # the cap hit where an operator sees it (the parse error below says so too).
            log.warning(
                "complete_json output truncated at max_tokens=%s (finish_reason=length) "
                "role=%s purpose=%s model=%s attempt=%d/%d",
                max_tokens,
                role,
                purpose,
                model,
                attempt + 1,
                attempts,
            )
        if transport_error is not None:
            usage.set_wall_clock(int((time.monotonic() - started) * 1000))
            te = transport_error
            if te.code == COST_CAP_EXCEEDED:
                # The contract's stable key: the UI keys its persistent warning on it.
                msg = COST_CAP_EXCEEDED
            else:
                # Every other failure keeps its reason (docs/api-contract.md: "transport
                # message"): a bare code such as `transport_error` would drop the cause.
                msg = te.message or (str(te.code) if te.code is not None else TRANSPORT_ERROR)
            return None, "", usage, msg

        raw_text = "".join(parts)
        value, perr = extract_json(raw_text)
        if value is None:
            error = f"{PARSE_ERROR}: {perr}"
        else:
            try:
                parsed = schema_model.model_validate(value)
                usage.set_wall_clock(int((time.monotonic() - started) * 1000))
                return parsed, raw_text, usage, None
            except ValidationError as e:
                error = str(e)
        if attempt + 1 < attempts:
            log.info(
                "complete_json retry %d/%d role=%s purpose=%s model=%s: %.200s",
                attempt + 1,
                attempts - 1,
                role,
                purpose,
                model,
                error,
            )
            follow_up: list[dict[str, Any]] = [
                {"role": "user", "content": RETRY_USER_MESSAGE.format(error=error)}
            ]
            if raw_text.strip():
                # An empty reply is not echoed back: providers reject empty assistant content
                # (Anthropic's Messages API requires non-empty text blocks), which would turn
                # the one retry into a guaranteed 400.
                follow_up.insert(0, {"role": "assistant", "content": raw_text})
            convo = convo + follow_up

    usage.set_wall_clock(int((time.monotonic() - started) * 1000))
    return None, raw_text, usage, error


__all__ = [
    "RETRY_USER_MESSAGE",
    "build_headers",
    "build_payload",
    "complete_json",
    "desktop_mode",
    "extract_json",
    "stream_completion",
    "structured_response_format",
    "transport_kind",
]
