"""Refactor — the pass that runs BEFORE Analyze and produces what Analyze then compares (S11).

docs/semantics.md "Refactor". A Refactor turn holds three things for one send turn:

- a KNOWLEDGE GRAPH of the question: the things it involves and how they relate. A question's own
  structure is what tells you whether two answers disagree about the same thing or about different
  ones, so it is worth naming before anything is compared.
- the QUESTION restated concisely, with every stated requirement kept and nothing added.
- each reply reduced to a one-sentence summary plus its substantive claims, labelled R1/R2/R3.

Analyze then prefers those reduced replies over the raw ones whenever an ok Refactor turn exists for
the send turn it is comparing (`analyze.refactored_responses`), which is the user's own design: one
explicit pass whose output is visible and exportable, instead of a condense step buried inside
Analyze and only reachable when the replies happened to be large.

Shape, deliberately the same as Analyze so there is one thing to reason about: pre-checks (404 →
404/422/409 on the send turn → 409 `incomplete_send_turn`) → cache hit replays with no call → busy
guard LAST → ONE producer task owning every call and the single write, releasing the guard in its
`finally`. Each call is `complete_json(retries=0)` with Analyze's own retry rule driven here, the web
no-retry rule included; a failure degrades the turn (`status="degraded"`) rather than failing the
request, because a refactor that could not be produced must not block the Analyze it precedes.
`raw_attempts` records what each call actually produced: on a transport/site error the partial the
site had typed before it failed (`complete_json(on_partial=)`), `""` when there was none. The retry
decision keeps reading the client's `raw`, which stays empty on that path -- recording a partial and
correcting it are different things, and only the first is safe after a site error.

`purpose` is `"extraction"` on every call: `schemas.Purpose` is a frozen Literal with no room for a
new name, and the meter reads these as analyst work, which is what they are. No reply is ever quoted
into a message bigger than `analyze.CONDENSE_CHUNK_CHARS` — that bound was measured (a single 15.5 KB
analyst message never came back inside 20 minutes), and it applies here for the same reason.

The claims are capped on the asking side (`prompts.refactor.REPLY_CLAIMS_MAX`; measured 2026-09-22,
51 / 82 / 87 uncapped claims per reply put the refactored set over Analyze's split trigger). A reply
quoted in pieces is asked for its share per piece (`claims_per_piece`), so a three-piece reply is
asked for 4 + 4 + 4, not 36. A model that returns more than it was asked for is NOT truncated (house
rule: fail loudly, never silently truncate): every claim is kept and ONE warning names the overshoot.

The question the analyst is shown is `prompts.preparse.strip_format(send_turn.prompt)`: a pre-parsed
prompt ends with Triplex's own answer-format block, and the map rules would otherwise fold "at most
8 claims… no tables" into the restated question that heads the comparison prompt and the export.

`validated_call` is the one-call-plus-retry-rule primitive; Pre-parse (`features/preparse.py`)
borrows it for its single restate call, so the web no-retry rule has exactly one implementation.
"""

from __future__ import annotations

import asyncio
import logging
import math
import time
import uuid
from collections.abc import AsyncIterator
from typing import Any

from pydantic import BaseModel

from .. import api_errors
from ..config import ANALYST_EFFORT, MAX_TOKENS_STAGE
from ..llm import client
from ..llm.errors import COST_CAP_EXCEEDED
from ..prompts import preparse as preparse_prompts
from ..prompts import refactor as prompts
from ..schemas import (
    LABELS,
    Conversation,
    FeatureUsage,
    KnowledgeGraph,
    Label,
    RefactoredReply,
    Refactoring,
    RefactorTurn,
    SendTurn,
)
from ..store import conversations as store
from .analyze import (
    CONDENSE_CHUNK_CHARS,
    chunk_reply,
    missing_responses,
    resolve_send_turn,
    responses_by_label,
)

log = logging.getLogger("triplex.features.refactor")

ROLE = "analyst"
PURPOSE = "extraction"  # the frozen Purpose literal has no room for a new one (module docstring)
ATTEMPTS = 2
_END: None = None


class _MapResult(BaseModel):
    """The map call's validated shape. Local, not in `schemas.py`: it is this feature's wire format,
    while `Refactoring` — graph + question + replies — is the artifact the turn persists."""

    graph: KnowledgeGraph
    question: str


class _ReplyResult(BaseModel):
    summary: str
    claims: list[str]


def new_id() -> str:
    return str(uuid.uuid4())


def cached_ok_turn(conv: Conversation, of_turn: str) -> RefactorTurn | None:
    """The newest ok Refactor turn for `of_turn`, or None."""
    for turn in reversed(conv.turns):
        if isinstance(turn, RefactorTurn) and turn.of_turn == of_turn and turn.status == "ok":
            return turn
    return None


def chunk_notice(label: Label | str, chars: int, pieces: int, max_claims: int) -> str:
    return (
        f"{label}'s reply is {chars:,} characters, over the {CONDENSE_CHUNK_CHARS:,} one message can "
        f"be answered for, so it is being refactored in {pieces} pieces of at most {max_claims} "
        f"claims each"
    )


def claims_per_piece(pieces: int) -> int:
    """The claims cap ONE piece of a reply is asked for: the reply's share of `REPLY_CLAIMS_MAX`,
    floored at 4 so a piece is never asked for a list too short to carry its own substance."""
    if pieces < 1:
        raise ValueError(f"pieces must be at least 1, got {pieces!r}")
    return max(4, math.ceil(prompts.REPLY_CLAIMS_MAX / pieces))


def reply_notice(label: Label | str, chars: int) -> str:
    return f"refactoring {label}'s reply ({chars:,} characters) to its summary and claims"


MAP_NOTICE = "mapping the question: what it is about, and the question restated concisely"


def _error_of(code: str | None, message: str | None) -> str:
    """The cost cap keeps its stable key (the UI's persistent warning is keyed on it); every other
    failure keeps its own reason."""
    if code == COST_CAP_EXCEEDED:
        return COST_CAP_EXCEEDED
    return message or (str(code) if code is not None else "unknown error")


async def validated_call(
    *,
    model: str,
    messages: list[dict[str, str]],
    schema_model: type[BaseModel],
    fenced: bool,
) -> tuple[BaseModel | None, str, FeatureUsage, str | None]:
    """One validated call plus Analyze's own retry rule, driven here: `retries=0` on the client and
    at most `ATTEMPTS` tries, the second one carrying the correction message — and not at all when
    the web no-retry rule applies (nothing was typed back, so there is nothing to correct).
    Returns `(value | None, raw, usage, error)`, `raw` being every non-empty attempt joined.

    The partial of a failed capture is recorded in the attempts (`on_partial`) and NEVER folded
    into `raw`: the gate below and the correction message read `raw`, and after a site error the
    only safe thing to do with what the site half-typed is to keep it."""
    usage = FeatureUsage()
    partial = ""

    def keep(text: str) -> None:
        nonlocal partial
        partial = text

    parsed, raw, call_usage, error = await client.complete_json(
        role=ROLE,
        purpose=PURPOSE,
        model=model,
        messages=messages,
        schema_model=schema_model,
        effort=ANALYST_EFFORT,
        max_tokens=_max_tokens(model),
        retries=0,
        on_partial=keep,
    )
    usage.merge(call_usage)
    attempts = [raw or partial]
    for _ in range(ATTEMPTS - 1):
        if isinstance(parsed, schema_model):
            break
        if error is not None and not raw and client.web_retry_suppressed(model, raw):
            break
        follow_up: list[dict[str, str]] = []
        if raw.strip():
            follow_up.append({"role": "assistant", "content": raw})
        follow_up.append(
            {"role": "user", "content": prompts.retry_message(error or "unknown error", fenced=fenced)}
        )
        partial = ""  # per attempt: a second call that fails clean must not inherit the first's
        parsed, raw, call_usage, error = await client.complete_json(
            role=ROLE,
            purpose=PURPOSE,
            model=model,
            messages=[*messages, *follow_up],
            schema_model=schema_model,
            effort=ANALYST_EFFORT,
            max_tokens=_max_tokens(model),
            retries=0,
            on_partial=keep,
        )
        usage.merge(call_usage)
        attempts.append(raw or partial)
    value = parsed if isinstance(parsed, schema_model) else None
    return value, "\n\n".join(a for a in attempts if a), usage, error


_call = validated_call  # the name the S11 review notes and tests refer to


def _max_tokens(model: str) -> int:
    """The stage budget plus room for reasoning tokens — the same rule and the same reason as
    `analyze._analyst_max_tokens` (reasoning tokens are counted as completion tokens)."""
    from ..llm import catalog, reasoning

    return reasoning.token_budget(MAX_TOKENS_STAGE[PURPOSE], catalog.get_meta(model), ANALYST_EFFORT)


async def _refactor_reply(
    *, model: str, question: str, label: Label, response: str, fenced: bool
) -> tuple[RefactoredReply | None, list[str], FeatureUsage, str | None]:
    """One label's reply, in pieces when it is too big for one message. The claims of every piece are
    concatenated; the SUMMARY is the first piece's, because a reply states what it recommends near
    the top and a summary stitched out of three pieces reads like none of them. Each piece is asked
    for its share of the claims cap (`claims_per_piece`); more than was asked for is kept, with one
    WARNING, never cut."""
    usage = FeatureUsage()
    raws: list[str] = []
    claims: list[str] = []
    summary = ""
    pieces = chunk_reply(response)
    per_piece = claims_per_piece(len(pieces))
    for piece in pieces:
        value, raw, call_usage, error = await validated_call(
            model=model,
            messages=prompts.reply_messages(
                question, label, piece, fenced=fenced, max_claims=per_piece
            ),
            schema_model=_ReplyResult,
            fenced=fenced,
        )
        usage.merge(call_usage)
        raws.append(raw)
        if value is None:
            return None, raws, usage, _error_of(None, error)
        assert isinstance(value, _ReplyResult)
        if not summary:
            summary = value.summary.strip()
        claims.extend(c.strip() for c in value.claims if c.strip())
    if not claims:
        return None, raws, usage, "the refactor pass returned no claims"
    asked = per_piece * len(pieces)
    if len(claims) > asked:
        log.warning(
            "refactor: %s returned %d claims, over the %d asked for; kept all",
            label,
            len(claims),
            asked,
        )
    return RefactoredReply(model=label, summary=summary, claims=claims), raws, usage, None


async def _produce(
    conv: Conversation,
    send_turn: SendTurn,
    turn_id: str,
    queue: asyncio.Queue[dict[str, Any] | None],
    guard: Any,
) -> None:
    started = time.monotonic()
    final: dict[str, Any] | None = None
    try:
        queue.put_nowait({"type": "refactor_start", "turn_id": turn_id, "of_turn": send_turn.id})
        model = conv.slot_config.analyst_model
        fenced = client.transport_kind(model) == "web"
        responses = responses_by_label(conv, send_turn)
        usage = FeatureUsage()
        raw_attempts: list[str] = []
        refactoring: Refactoring | None = None
        error: str | None = None

        # The question alone: a pre-parsed prompt ends with Triplex's own answer block, which is
        # not part of what was asked (module docstring; an exact-match strip, never user text).
        question = preparse_prompts.strip_format(send_turn.prompt)
        queue.put_nowait({"type": "refactor_retry", "error": MAP_NOTICE})
        mapped, raw, map_usage, error = await validated_call(
            model=model,
            messages=prompts.map_messages(question, fenced=fenced),
            schema_model=_MapResult,
            fenced=fenced,
        )
        usage.merge(map_usage)
        raw_attempts.append(raw)

        replies: list[RefactoredReply] = []
        if mapped is not None:
            assert isinstance(mapped, _MapResult)
            for label in LABELS:
                response = responses[label]
                queue.put_nowait(
                    {"type": "refactor_retry", "error": reply_notice(label, len(response))}
                )
                pieces = chunk_reply(response)
                if len(pieces) > 1:
                    queue.put_nowait(
                        {
                            "type": "refactor_retry",
                            "error": chunk_notice(
                                label, len(response), len(pieces), claims_per_piece(len(pieces))
                            ),
                        }
                    )
                reduced, raws, reply_usage, reply_error = await _refactor_reply(
                    model=model, question=question, label=label, response=response, fenced=fenced
                )
                usage.merge(reply_usage)
                raw_attempts.extend(raws)
                if reduced is None:
                    error = f"could not refactor {label}'s reply: {reply_error}"
                    break
                replies.append(reduced)
            if error is None:
                refactoring = Refactoring(
                    graph=mapped.graph, question=mapped.question.strip(), replies=replies
                )

        usage.set_wall_clock(max(1, int((time.monotonic() - started) * 1000)))
        turn = RefactorTurn(
            id=turn_id,
            of_turn=send_turn.id,
            refactoring=refactoring,
            status="ok" if refactoring is not None else "degraded",
            error=None if refactoring is not None else (error or "unknown error"),
            raw_attempts=raw_attempts,
            slot_config=conv.slot_config.model_copy(deep=True),
            usage=usage,
        )
        await store.append_turn(conv.id, turn)
        if turn.status == "ok":
            final = {"type": "refactor_done", "turn": turn.model_dump(), "cached": False}
        else:
            final = {"type": "refactor_degraded", "turn": turn.model_dump()}
    except Exception as e:
        log.exception("refactor failed for conversation %s", conv.id)
        final = {"type": "error", "message": f"{type(e).__name__}: {e}"}
    finally:
        try:
            await guard.__aexit__(None, None, None)
        finally:
            if final is not None:
                queue.put_nowait(final)
            queue.put_nowait(_END)


async def run_refactor(
    conv_id: str, *, of_turn: str | None = None, force: bool = False
) -> AsyncIterator[dict[str, Any]]:
    conv = await store.load(conv_id)
    if conv is None:
        raise api_errors.not_found("conversation")
    send_turn = resolve_send_turn(conv, of_turn)
    missing = missing_responses(send_turn)
    if missing:
        raise api_errors.conflict("incomplete_send_turn", missing=missing)

    if not force:
        cached = cached_ok_turn(conv, send_turn.id)
        if cached is not None:
            yield {"type": "refactor_start", "turn_id": cached.id, "of_turn": send_turn.id}
            yield {"type": "refactor_done", "turn": cached.model_dump(), "cached": True}
            return

    guard = store.busy_guard(conv_id)
    await guard.__aenter__()  # LAST pre-check: 409 busy
    turn_id = new_id()
    queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
    task = asyncio.create_task(_produce(conv, send_turn, turn_id, queue, guard))
    _background.add(task)
    task.add_done_callback(_background.discard)
    while True:
        event = await queue.get()
        if event is _END:
            break
        yield event


_background: set[asyncio.Task[None]] = set()


async def wait_for_background() -> None:
    """Tests only: await the producer tasks this module spawned."""
    while _background:
        await asyncio.gather(*list(_background), return_exceptions=True)


__all__ = [
    "ATTEMPTS",
    "MAP_NOTICE",
    "PURPOSE",
    "ROLE",
    "cached_ok_turn",
    "chunk_notice",
    "claims_per_piece",
    "reply_notice",
    "run_refactor",
    "validated_call",
    "wait_for_background",
]
