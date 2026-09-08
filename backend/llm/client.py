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
"""

from __future__ import annotations

import json
import logging
import re
import time
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import httpx
from pydantic import BaseModel, ValidationError

from ..config import settings
from ..schemas import Delta, Effort, FeatureUsage, strict_json_schema
from . import catalog, metering, mock
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
_record_counters: dict[tuple[str, str], int] = {}


class _Recorder:
    """Tees the raw `data:` JSON lines of a live call into the fixture format under
    MOCK_RECORD_DIR as <role>.<purpose>.<n>.jsonl, plus requests.jsonl with the payload."""

    def __init__(self, directory: Path, role: str, purpose: str, payload: dict[str, Any]) -> None:
        self.dir = directory
        self.role = role
        self.purpose = purpose
        self.payload = payload
        n = _record_counters.get((role, purpose), 0) + 1
        _record_counters[(role, purpose)] = n
        self.name = f"{role}.{purpose}.{n}.jsonl"
        self.lines: list[str] = []

    def line(self, raw: str) -> None:
        s = raw.strip()
        if not s or s.startswith(":") or not s.startswith("data:"):
            return
        payload = s[5:].strip()
        if not payload or payload == DONE_SENTINEL:
            return
        self.lines.append(payload)

    def close(self) -> None:
        try:
            self.dir.mkdir(parents=True, exist_ok=True)
            fixture: str | None = None
            if self.lines:
                fixture = self.name
                with (self.dir / self.name).open("w", encoding="utf-8") as fh:
                    fh.write("\n".join(self.lines) + "\n")
            with (self.dir / "requests.jsonl").open("a", encoding="utf-8") as fh:
                fh.write(
                    json.dumps(
                        {
                            "fixture": fixture,
                            "role": self.role,
                            "purpose": self.purpose,
                            "model": self.payload.get("model"),
                            "payload": self.payload,
                        },
                        ensure_ascii=False,
                    )
                    + "\n"
                )
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


async def _live_stream(
    *,
    role: str,
    purpose: str,
    model: str,
    messages: list[dict[str, Any]],
    payload: dict[str, Any],
) -> AsyncIterator[Delta]:
    s = settings()
    url = s.openrouter_base_url.rstrip("/") + "/chat/completions"
    headers = build_headers(s.openrouter_api_key or "", s.http_referer, s.app_title)
    parser = SSEParser(
        model=model, role=role, purpose=purpose, prompt_text=_messages_text(messages)
    )
    recorder = _Recorder(s.mock_record_dir, role, purpose, payload) if s.mock_record_dir else None
    gen_id: str | None = None
    try:
        async with httpx.AsyncClient(timeout=s.request_timeout_s) as client:
            async with client.stream("POST", url, json=payload, headers=headers) as resp:
                gen_id = resp.headers.get("x-generation-id") or None
                if not (200 <= resp.status_code < 300):
                    body = await resp.aread()
                    parser.finished = True
                    yield _stamp_generation(_http_error_delta(resp.status_code, body), gen_id)
                    return
                async for line in resp.aiter_lines():
                    if recorder is not None:
                        recorder.line(line)
                    for d in parser.feed(line):
                        yield _stamp_generation(d, gen_id)
                    if parser.finished:
                        break
        if not parser.finished:
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

        if is_mock:
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
                role=role, purpose=purpose, model=model, messages=messages, payload=payload
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
                log.info(metering.format_log_line(u, mock=is_mock))
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


def _balanced_objects(text: str):
    """Yield every balanced `{...}` substring (string-aware), longest-first per start."""
    starts = [i for i, ch in enumerate(text) if ch == "{"][:_MAX_SCAN_STARTS]
    for start in starts:
        depth = 0
        in_str = False
        esc = False
        for j in range(start, len(text)):
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
                    yield text[start : j + 1]
                    break


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
    for c in candidates:
        for obj in _balanced_objects(c):
            v = _try_load(obj)
            if isinstance(v, dict):
                return v, None
    for c in candidates:
        v = _try_load(c)
        if v is not None:
            return None, f"expected a JSON object, got {type(v).__name__}"
    return None, "no JSON object found in the response" + (
        " (output may be truncated)" if first != -1 and last <= first else ""
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
                if d.usage is not None:
                    usage.add(d.usage)
            elif d.kind == "error":
                transport_error = d
        if transport_error is not None:
            usage.set_wall_clock(int((time.monotonic() - started) * 1000))
            te = transport_error
            if te.error_type == ERROR_TYPE_TRIPLEX and te.code is not None:
                msg = str(te.code)
            else:
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
            convo = convo + [
                {"role": "assistant", "content": raw_text},
                {"role": "user", "content": RETRY_USER_MESSAGE.format(error=error)},
            ]

    usage.set_wall_clock(int((time.monotonic() - started) * 1000))
    return None, raw_text, usage, error


__all__ = [
    "RETRY_USER_MESSAGE",
    "build_headers",
    "build_payload",
    "complete_json",
    "extract_json",
    "stream_completion",
    "structured_response_format",
]
