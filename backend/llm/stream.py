"""OpenRouter SSE line parser (owner: W1). Frozen signature: `parse_sse_lines(lines)`.

Rules (docs/api-contract.md addendum, docs/fixtures.md, docs/openrouter-notes.md):

- `:` comment lines (`: OPENROUTER PROCESSING`) and blank lines are skipped; `data: [DONE]` ends
  the stream; a line that is not valid JSON is skipped with a warning (never raises).
- A chunk with a top-level `error` -> `Delta(kind="error", code, message, error_type)` and STOP
  (it may be the only event of a 200 stream).
- `choices[0].delta.content` -> `text`; `delta.reasoning_details[]` (`reasoning.text`.text,
  `reasoning.summary`.summary; encrypted ignored) and a bare `delta.reasoning` string ->
  `reasoning` (a bare string identical to the details text of the same chunk is not doubled);
  `delta.annotations[]` on any chunk and `message.annotations[]` on the usage chunk ->
  `citations` with the annotation objects passed through VERBATIM, de-duplicated by
  `url_citation.url` across the stream, one delta per chunk that carries new annotations.
- The chunk carrying `usage` -> `Delta(kind="done", usage=Usage(...), finish_reason,
  truncated=finish_reason=="length", generation_id=<first chunk id>)`. `finish_reason` is the
  last non-null value seen on any chunk.
- Exactly one terminal delta (`done` or `error`), nothing after it. A stream that ends without a
  usage chunk gets a synthesised `done` (catalog price x len(text)//4; logged as an estimate).

`SSEParser` is the incremental form (`feed(line)` / `finish()`) the live client drives from
`aiter_lines()`; `parse_sse_lines` wraps it for iterables (fixtures, tests).
"""

from __future__ import annotations

import json
import logging
from collections.abc import Iterable, Iterator
from typing import Any

from ..schemas import Delta
from . import metering

log = logging.getLogger("triplex.llm.stream")

DONE_SENTINEL = "[DONE]"


class SSEParser:
    """Incremental OpenRouter SSE -> Delta parser. Never raises on malformed input."""

    def __init__(
        self, *, model: str = "", role: str = "", purpose: str = "", prompt_text: str = ""
    ) -> None:
        self.model = model
        self.role = role
        self.purpose = purpose
        self.prompt_text = prompt_text  # only used for the synthesised-usage estimate
        self.finished = False  # a terminal delta has been emitted
        self.synthesized = False  # the done delta was synthesised (no usage chunk)
        self.finish_reason: str | None = None
        self.generation_id: str | None = None
        self.text_parts: list[str] = []
        self.reasoning_parts: list[str] = []
        self.chunks = 0
        self._seen_citations: set[str] = set()

    # ------------------------------------------------------------------ public API
    @property
    def text(self) -> str:
        return "".join(self.text_parts)

    @property
    def reasoning(self) -> str:
        return "".join(self.reasoning_parts)

    def feed(self, line: str) -> list[Delta]:
        """Parse one raw SSE line. Returns zero or more deltas (in order)."""
        if self.finished:
            return []
        if line is None:
            return []
        line = line.rstrip("\r\n")
        stripped = line.strip()
        if not stripped or stripped.startswith(":"):
            return []
        if not stripped.startswith("data:"):
            # event:/id:/retry: fields are not used by OpenRouter; ignore anything else.
            return []
        payload = stripped[5:].strip()
        if not payload:
            return []
        if payload == DONE_SENTINEL:
            return self.finish()
        try:
            chunk = json.loads(payload)
        except ValueError:
            log.warning("skipping unparsable SSE data line: %.120r", payload)
            return []
        if not isinstance(chunk, dict):
            log.warning("skipping non-object SSE chunk: %.120r", payload)
            return []
        return self._handle_chunk(chunk)

    def finish(self) -> list[Delta]:
        """End of input: synthesise the terminal `done` delta if none was emitted."""
        if self.finished:
            return []
        self.finished = True
        self.synthesized = True
        usage = metering.estimate_usage(
            model=self.model,
            completion_text=self.text,
            prompt_text=self.prompt_text,
            role=self.role,
            purpose=self.purpose,
            generation_id=self.generation_id,
        )
        log.info(
            "stream ended without a usage chunk; usage estimated (len(text)//4=%d tokens x "
            "catalog price) model=%s generation_id=%s",
            usage.completion_tokens,
            self.model or "-",
            self.generation_id or "-",
        )
        return [
            Delta(
                kind="done",
                usage=usage,
                finish_reason=self.finish_reason,
                truncated=self.finish_reason == "length",
                generation_id=self.generation_id,
            )
        ]

    # ------------------------------------------------------------------ internals
    def _handle_chunk(self, chunk: dict[str, Any]) -> list[Delta]:
        self.chunks += 1
        cid = chunk.get("id")
        if self.generation_id is None and isinstance(cid, str) and cid:
            self.generation_id = cid
        if not self.model and isinstance(chunk.get("model"), str):
            self.model = chunk["model"]

        err = chunk.get("error")
        if err is not None:
            self.finished = True
            return [self._error_delta(err)]

        out: list[Delta] = []
        choice = _first_choice(chunk)
        delta = choice.get("delta") if isinstance(choice.get("delta"), dict) else {}
        message = choice.get("message") if isinstance(choice.get("message"), dict) else {}

        fr = choice.get("finish_reason")
        if isinstance(fr, str) and fr:
            self.finish_reason = fr

        # reasoning (details first; a bare string identical to them is the plaintext mirror)
        details_text = _reasoning_from_details(delta.get("reasoning_details"))
        bare = delta.get("reasoning")
        if not isinstance(bare, str):
            alias = delta.get("reasoning_content")  # documented alias of `reasoning`
            bare = alias if isinstance(alias, str) else ""
        reasoning_text = details_text
        if bare and bare != details_text:
            reasoning_text += bare
        if reasoning_text:
            self.reasoning_parts.append(reasoning_text)
            out.append(Delta(kind="reasoning", text=reasoning_text))

        # text
        content = delta.get("content")
        if isinstance(content, str) and content:
            self.text_parts.append(content)
            out.append(Delta(kind="text", text=content))

        # citations (delta.annotations on any chunk, message.annotations on the usage chunk)
        items = self._new_citations(delta.get("annotations"))
        items += self._new_citations(message.get("annotations"))
        if items:
            out.append(Delta(kind="citations", items=items))

        # terminal usage chunk
        if "usage" in chunk and chunk.get("usage") is not None:
            usage = chunk.get("usage") if isinstance(chunk.get("usage"), dict) else {}
            self.finished = True
            u = metering.usage_from_chunk(
                usage,
                model=self.model,
                role=self.role,
                purpose=self.purpose,
                generation_id=self.generation_id,
            )
            out.append(
                Delta(
                    kind="done",
                    usage=u,
                    finish_reason=self.finish_reason,
                    truncated=self.finish_reason == "length",
                    generation_id=self.generation_id,
                )
            )
        return out

    def _error_delta(self, err: Any) -> Delta:
        if not isinstance(err, dict):
            return Delta(kind="error", code=None, message=str(err), error_type=None)
        meta = err.get("metadata") if isinstance(err.get("metadata"), dict) else {}
        code = err.get("code")
        if not isinstance(code, int | str):
            code = None if code is None else str(code)
        msg = err.get("message")
        message = msg if isinstance(msg, str) else (json.dumps(msg) if msg is not None else "")
        et = meta.get("error_type")
        return Delta(
            kind="error",
            code=code,
            message=message,
            error_type=et if isinstance(et, str) else None,
        )

    def _new_citations(self, annotations: Any) -> list[dict[str, Any]]:
        if not isinstance(annotations, list):
            return []
        fresh: list[dict[str, Any]] = []
        for item in annotations:
            if not isinstance(item, dict):
                continue
            key = _citation_key(item)
            if key in self._seen_citations:
                continue
            self._seen_citations.add(key)
            fresh.append(item)
        return fresh


def _first_choice(chunk: dict[str, Any]) -> dict[str, Any]:
    choices = chunk.get("choices")
    if isinstance(choices, list) and choices and isinstance(choices[0], dict):
        return choices[0]
    return {}


def _reasoning_from_details(details: Any) -> str:
    if not isinstance(details, list):
        return ""
    parts: list[str] = []
    for block in details:
        if not isinstance(block, dict):
            continue
        btype = block.get("type")
        if btype == "reasoning.text":
            t = block.get("text")
            if isinstance(t, str):
                parts.append(t)
        elif btype == "reasoning.summary":
            s = block.get("summary")
            if isinstance(s, str):
                parts.append(s)
        # reasoning.encrypted (and unknown types) are ignored
    return "".join(parts)


def _citation_key(item: dict[str, Any]) -> str:
    uc = item.get("url_citation")
    if isinstance(uc, dict) and isinstance(uc.get("url"), str) and uc["url"]:
        return "url:" + uc["url"]
    try:
        return "raw:" + json.dumps(item, sort_keys=True, separators=(",", ":"), default=str)
    except (TypeError, ValueError):  # pragma: no cover - defensive
        return "raw:" + repr(item)


def parse_sse_lines(lines: Iterable[str]) -> Iterator[Delta]:
    """Parse raw SSE lines into Deltas. Exactly one terminal delta; nothing after it."""
    parser = SSEParser()
    for line in lines:
        yield from parser.feed(line)
        if parser.finished:
            return
    yield from parser.finish()
