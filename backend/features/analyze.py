"""Analyze feature (owner: W5). Frozen signature; yields analyze_* SSE event dicts.

Normative behaviour: docs/semantics.md "Analyze" (+ the producer-model addendum) and the
`analyze_*` events in docs/api-contract.md.

Pre-checks, in order and all before the first yield (so `sse.sse_response` turns them into plain
JSON errors): `store.load` -> 404; resolve `of_turn` (default: the newest send turn; explicit
unknown -> 404 not_found("turn"); explicit non-send -> 422 not_a_send_turn; no send turn at all ->
409 no_send_turn); every slot must have a response -> 409 incomplete_send_turn{missing}; the cache
rule (without `force`, the newest ok analyze turn for `of_turn` is replayed as
`analyze_start` + `analyze_done{cached:true}` with no busy guard and no LLM call); and LAST the
busy guard -> 409 busy.

A fresh run mints the turn id, enters the guard, and spawns ONE producer task that emits
`analyze_start{turn_id, of_turn}`, calls the analyst once (`complete_json(..., retries=0)`), on
ANY failure emits `analyze_retry{error}` and calls once more (`retry_follow_up` decides what the
retry carries: the correction message plus the bad output echoed as the assistant turn, the
message alone when that output is blank, or the identical request when there was no output at
all — a transport error or an empty stream), persists the AnalyzeTurn (`ok` or `degraded`) and
only then emits `analyze_done{turn, cached:false}` or `analyze_degraded{turn}` — the last event
either way (no `error` follows a degrade). An unexpected exception after the first event becomes
the terminal `error{message}` event and nothing is persisted. The task releases the guard in its
`finally` after the persistence write (nested so the final event and the queue sentinel are
enqueued even if the release itself raised) and runs to completion even when the client
disconnects; the generator only drains the task's queue.

Web no-retry rule (desktop-catalog-and-ollama S3; docs/desktop-contract.md section 6 and the S6
review's deferred finding "Analyze's correction retry against a site after a site error"): when the
analyst model's `client.transport_kind` is "web" and the first attempt produced NO output -- `raw`
empty with an error, i.e. a transport/site error delta (`site_error`, `challenge`, `bridge_no_ack`,
...) -- the second attempt is skipped and the turn degrades immediately with that error
(`raw_attempts == [""]`, no `analyze_retry` event): re-sending the identical request would type the
whole prompt into a fresh hidden chat on a site that just failed. A parse/validation failure WITH
output keeps the correction attempt exactly as before (the correction message continues in the
same analyst chat, `fresh:false`). Reading where the contract is silent: a captured reply with no
text at all (`parse_error: empty response`, `raw == ""` -- the bridge maps whitespace-only text to
no text delta) is "no output" too and is not retried on a web session. Mock and OpenRouter
analysts are untouched (goldens byte-identical). The transport half of the rule is
`client.web_retry_suppressed`, which the client applies to its own internal retry as well (S7
review, "Fusion's convergence retry re-types the whole payload into a NEW hidden analyst chat"):
one rule, two enforcement points -- Analyze drives its second attempt itself (`retries=0`), Fusion
lets `complete_json` drive it (`retries=1`).

Size bound / the condense ("split") step (2026-09-20; PLAN Workstream D). MEASURED on the
conversation that kept degrading: at high reasoning effort inside the sites the three replies came
back 4,992 / 13,677 / 8,583 characters long and the analyst prompt reached 29,958 characters typed
into ONE chat message, 27,252 of it quoted replies, against a 32,768-character ceiling
(`desktop/main/ipc.js` MAX_PROMPT_CHARS). Nothing bounded it anywhere. So, before the comparison:

- At or under `SPLIT_MIN_CHARS` of quoted replies nothing changes -- one message, one analyst call,
  the same bytes as before (the tests/analyze and tests/e2e goldens are the proof).
- Over it, each label's reply is condensed on its own first (`_condense`, one call per label,
  `purpose="extraction"` -- the frozen `Purpose` literal has no room for a new one and the meter
  reads it as analyst work, which it is). The text is taken directly, with no schema: a
  condensation is quoted data for the next prompt, not a validated artifact. The three condensed
  blocks then go through the normal comparison prompt, which still returns a real `Extraction`.
  Each sub-call is narrated with the EXISTING alphabet -- `analyze_retry{error}` before the call,
  the raw bullets appended to `raw_attempts` -- because a new event type would mean editing the
  frozen docs/api-contract.md.
- A reply over `REPLY_BUDGET_CHARS` on its own cannot be condensed either (its own condense
  message would not fit), so the turn degrades naming the label and both numbers, with NO analyst
  call at all. Never a silent truncation: a comparison that quietly drops half an answer is worse
  than no comparison.
- A condensation that fails degrades there and then (`condense_failure`), without the comparison
  call: falling back to the raw reply would rebuild exactly the oversized prompt this avoids.
- The condensed set is RE-MEASURED (`condense_ineffective`). Three sub-calls that answered with
  claims as long as the replies they were given leave the comparison prompt exactly as big as the
  one the split existed to avoid, and sending it anyway spends a fourth call to fail the same way.

The bound is transport-independent on purpose. The ceiling that produced the failure is the web
transport's, but a 27 KB analyst prompt is a bad prompt everywhere -- it is the input against which
`MAX_TOKENS_STAGE["extraction"]` (4000) has to produce the whole comparison -- and one rule that
every transport takes is one rule to reason about. It costs nothing in practice: no committed
scenario comes near `SPLIT_MIN_CHARS`, so every fixture, golden and offline test runs the
single-call path unchanged.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import AsyncIterator
from typing import Any

from .. import anon, api_errors
from ..config import ANALYST_EFFORT, MAX_TOKENS_STAGE
from ..llm import client
from ..llm.errors import COST_CAP_EXCEEDED, TRANSPORT_ERROR
from ..prompts import analyze as prompts
from ..schemas import (
    LABELS,
    SLOT_IDS,
    AnalyzeTurn,
    Conversation,
    Extraction,
    FeatureUsage,
    Label,
    SendTurn,
    new_id,
)
from ..store import conversations as store

log = logging.getLogger("triplex.features.analyze")

ROLE = "analyst"
PURPOSE = "extraction"
# One retry driven here (docs/semantics.md): at most ATTEMPTS analyst calls per Analyze.
ATTEMPTS = 2

# The size bound (module docstring). SPLIT_MIN_CHARS is the total of the three quoted replies above
# which each one is condensed first; at or under it the prompt is built exactly as it always was.
# 12,000 sits well clear of every scenario fixture (the largest corpus total is 1,884) and well
# under the single-message ceiling, so a normal conversation never takes the split path.
SPLIT_MIN_CHARS = 12_000
# The most ONE reply may be: a web analyst is typed one message at a time and Electron refuses
# anything over 32,768 characters (`desktop/main/ipc.js` MAX_PROMPT_CHARS), so 30,000 leaves 2,768
# for the question and the condense instruction that ride along with it.
REPLY_BUDGET_CHARS = 30_000

_END = None  # queue sentinel
# Strong references to running producer tasks (asyncio keeps only weak ones): a task must survive
# the generator that spawned it when the client disconnects.
_tasks: set[asyncio.Task[None]] = set()


# --------------------------------------------------------------------------- pre-checks
def resolve_send_turn(conv: Conversation, of_turn: str | None) -> SendTurn:
    """The send turn to analyze (docs/semantics.md "Analyze"); raises the pre-stream errors."""
    if of_turn is None:
        for turn in reversed(conv.turns):
            if turn.type == "send":
                return turn
        raise api_errors.conflict("no_send_turn")
    for turn in conv.turns:
        if turn.id == of_turn:
            if turn.type != "send":
                raise api_errors.unprocessable("not_a_send_turn")
            return turn
    raise api_errors.not_found("turn")


def missing_responses(send_turn: SendTurn) -> list[str]:
    return [slot for slot in SLOT_IDS if send_turn.responses.get(slot) is None]


def cached_ok_turn(conv: Conversation, of_turn: str) -> AnalyzeTurn | None:
    """The newest analyze turn with status ok for `of_turn` (degraded turns are never cached)."""
    for turn in reversed(conv.turns):
        if turn.type == "analyze" and turn.of_turn == of_turn and turn.status == "ok":
            return turn
    return None


def responses_by_label(conv: Conversation, send_turn: SendTurn) -> dict[Label, str]:
    """R-labelled responses via the persisted anon_map (never re-derived from position)."""
    return {label: send_turn.responses[slot] or "" for label, slot in anon.labels(conv).items()}


# --------------------------------------------------------------------------- the size bound (pure)
def quoted_chars(responses: dict[Label, str]) -> int:
    """Characters of quoted reply the comparison prompt would carry (the part that grows)."""
    return sum(len(text) for text in responses.values())


def needs_split(responses: dict[Label, str]) -> bool:
    return quoted_chars(responses) > SPLIT_MIN_CHARS


def oversize_reply(responses: dict[Label, str]) -> tuple[Label, int] | None:
    """`(label, chars)` of the first reply -- in R1/R2/R3 order, not size order -- that is over
    the per-message budget on its own, so not even its own condense call would fit; else None."""
    for label in LABELS:
        chars = len(responses.get(label, ""))
        if chars > REPLY_BUDGET_CHARS:
            return label, chars
    return None


def oversize_message(label: Label | str, chars: int) -> str:
    """The loud failure: the label and both numbers, so the user knows what to shorten."""
    return (
        f"{label}'s reply is {chars:,} characters, over the {REPLY_BUDGET_CHARS:,} the analyst "
        f"can take in one message. Ask that slot again for a shorter answer, or analyze a Send "
        f"whose replies fit — Triplex will not compare a truncated one."
    )


def split_notice(label: Label | str, chars: int, total: int) -> str:
    """What `analyze_retry` carries for one condense sub-call. The event alphabet is frozen, so
    this string is the only place the split can announce itself (module docstring)."""
    return (
        f"splitting the analyst prompt: {total:,} characters of replies is over "
        f"{SPLIT_MIN_CHARS:,}, so {label}'s reply ({chars:,} characters) is being condensed to "
        f"its substantive claims first"
    )


def condense_failure(label: Label | str, error: str) -> str:
    return f"could not condense {label}'s reply for the comparison: {error}"


def condense_ineffective(total: int, label: Label | str, chars: int) -> str:
    """Three condense calls that did not actually shrink anything. The comparison prompt would be
    as big as the one the split was there to avoid, so it is not sent: the whole point of the split
    is to keep a single analyst message small enough to be answered, and a prompt that big is what
    made Analyze time out in the first place. Loud, and naming the worst offender, because the
    alternative -- quietly dropping half an answer -- is worse than no comparison (user decision,
    2026-09-20)."""
    return (
        f"the condensed replies still come to {total:,} characters, over the {SPLIT_MIN_CHARS:,} "
        f"one analyst message is sized for (the largest is {label}'s at {chars:,}). Condensing did "
        f"not shorten them enough to compare, and nothing was truncated to force it."
    )


# --------------------------------------------------------------------------- producer
def _analyst_max_tokens(model: str) -> int:
    """The stage budget, plus room for reasoning tokens when the analyst model will reason.

    Reasoning tokens are counted as completion tokens, so they come out of `max_tokens`: measured
    2026-09-20, a reasoning analyst spent 4,615 of a 4,000-token extraction budget on thinking and
    the JSON was cut off, reaching the user as `parse_error: no JSON object found in the response` --
    the same message a mid-reply capture produces, from a completely different cause. A non-reasoning
    model (and every `web:` model, whose transport drops `max_tokens` outright) gets the frozen
    `MAX_TOKENS_STAGE` value unchanged. `catalog` is imported here, not at module scope, so tests can
    monkeypatch `get_meta` (the same reason `slot_config.py` does it)."""
    from ..llm import catalog, reasoning

    return reasoning.token_budget(MAX_TOKENS_STAGE[PURPOSE], catalog.get_meta(model), ANALYST_EFFORT)


async def _attempt(
    *, model: str, messages: list[dict[str, Any]]
) -> tuple[Extraction | None, str, FeatureUsage, str | None]:
    parsed, raw, usage, error = await client.complete_json(
        role=ROLE,
        purpose=PURPOSE,
        model=model,
        messages=messages,
        schema_model=Extraction,
        effort=ANALYST_EFFORT,
        max_tokens=_analyst_max_tokens(model),
        retries=0,
    )
    extraction = parsed if isinstance(parsed, Extraction) else None
    return extraction, raw, usage, error


async def _condense(
    *, model: str, question: str, label: Label, response: str
) -> tuple[str, FeatureUsage, str | None]:
    """One condense sub-call: that label's reply in, its claims out as bullet lines.

    Streamed for its TEXT rather than through `complete_json`, because the claims are quoted data
    for the comparison prompt and there is no schema to add for them -- but they are asked for and
    read back as JSON all the same. That is what makes a TRUNCATED condensation fail instead of
    being quoted as though it were the whole reply: a half-written object does not parse, and on a
    web session the capture will not even end on one (S10, `looksComplete`). Never raises -- the LLM
    layer does not -- and an empty reply is a failure, because an empty block would silently drop
    one label out of the comparison."""
    usage = FeatureUsage()
    parts: list[str] = []
    error: str | None = None
    async for d in client.stream_completion(
        role=ROLE,
        purpose=PURPOSE,
        model=model,
        messages=prompts.condense_messages(
            question, label, response, fenced=client.transport_kind(model) == "web"
        ),
        effort=ANALYST_EFFORT,
        max_tokens=_analyst_max_tokens(model),
    ):
        if d.kind == "text":
            parts.append(d.text)
        elif d.kind == "done":
            if d.usage is not None:
                usage.add(d.usage)
        elif d.kind == "error":
            # Same rule as `complete_json`: the cap keeps its stable key (the UI's persistent
            # warning is keyed on it), every other failure keeps its reason.
            if d.code == COST_CAP_EXCEEDED:
                error = COST_CAP_EXCEEDED
            else:
                error = d.message or (str(d.code) if d.code is not None else TRANSPORT_ERROR)
    text = "".join(parts)
    if error is None and not text.strip():
        error = "the condense pass returned no text"
    if error is not None:
        return "", usage, error
    # The claims arrive as JSON so a half-written answer cannot pass for a whole one; they are
    # rendered back to bullet lines here, because what the comparison prompt quotes is prose.
    value, perr = client.extract_json(text, repair=client.transport_kind(model) == "web")
    if value is None:
        return "", usage, f"the condense pass returned no usable claims: {perr}"
    claims = value.get("claims")
    if not isinstance(claims, list) or not claims:
        return "", usage, "the condense pass returned no claims"
    lines = [f"- {str(c).strip()}" for c in claims if str(c).strip()]
    if not lines:
        return "", usage, "the condense pass returned no claims"
    return "\n".join(lines), usage, None


async def _condense_all(
    *,
    model: str,
    question: str,
    responses: dict[Label, str],
    usage: FeatureUsage,
    raw_attempts: list[str],
    queue: asyncio.Queue[dict[str, Any] | None],
) -> tuple[dict[Label, str] | None, str | None]:
    """The three condense sub-calls, in R1/R2/R3 order. Returns `(condensed, None)` or
    `(None, error)` on the first failure -- the comparison call never runs on a partial set.

    `usage` and `raw_attempts` are the caller's, appended to as each sub-call returns, so a run
    that fails on the second label still reports what it spent and what the first one produced."""
    total = quoted_chars(responses)
    condensed: dict[Label, str] = {}
    for label in LABELS:
        response = responses[label]
        queue.put_nowait(
            {"type": "analyze_retry", "error": split_notice(label, len(response), total)}
        )
        text, call_usage, error = await _condense(
            model=model, question=question, label=label, response=response
        )
        usage.merge(call_usage)
        raw_attempts.append(text)
        if error is not None:
            return None, condense_failure(label, error)
        condensed[label] = text
    return condensed, None


def retry_follow_up(raw: str, error: str | None, *, fenced: bool = False) -> list[dict[str, str]]:
    """The messages appended to the first attempt's request before the retry.

    docs/semantics.md "Analyze" + "Analyze on a transport error": no output at all (a transport
    error delta, or a stream that carried no text) leaves nothing to correct, so the identical
    request is re-sent. Any output that failed lenient parsing / validation gets the correction
    message; it is echoed back as the assistant turn only when it is not blank — providers
    reject empty assistant content (the client applies the same `raw.strip()` rule to its own
    internal retry), so whitespace-only output is never echoed.

    `fenced` is the transport flag `build_messages` already gets: on a web session the correction
    message is the ONLY thing typed into the analyst's chat (`bridge.text_for` sends
    `messages[-1]`), so it has to restate the fenced-block rule itself."""
    if not raw:
        return []
    message = prompts.retry_message(error or "unknown error", fenced=fenced)
    follow_up = [{"role": "user", "content": message}]
    if raw.strip():
        follow_up.insert(0, {"role": "assistant", "content": raw})
    return follow_up


def web_retry_suppressed(model: str, raw: str, error: str | None) -> bool:
    """The web no-retry rule (module docstring): True when the analyst is a web session and the
    attempt produced no output at all (`raw == ""` with an error), so the second attempt must not
    run. Any output keeps the correction attempt; non-web transports always retry as before.

    The transport half of the rule is `client.web_retry_suppressed` -- the same predicate the
    client applies to the internal retry of a `complete_json(retries>=1)` call (Fusion's defense
    and convergence calls) -- so the rule lives in ONE place; this function adds the condition
    that only Analyze can see: its first attempt failed (`error`) with nothing typed back."""
    return error is not None and not raw and client.web_retry_suppressed(model, raw)


async def _produce(
    conv: Conversation,
    send_turn: SendTurn,
    turn_id: str,
    queue: asyncio.Queue[dict[str, Any] | None],
    guard: Any,
) -> None:
    """All LLM calls and the persistence write; releases the busy guard in `finally`."""
    started = time.monotonic()
    final: dict[str, Any] | None = None
    try:
        queue.put_nowait({"type": "analyze_start", "turn_id": turn_id, "of_turn": send_turn.id})
        model = conv.slot_config.analyst_model
        # Transport-aware JSON instruction (prompts/analyze.py module docstring): a web analyst is
        # a chat page whose reply is read back out of rendered markdown, so it is asked for a
        # ```json fence; every API transport keeps Appendix A's "no prose, no code fences".
        fenced = client.transport_kind(model) == "web"
        responses = responses_by_label(conv, send_turn)
        usage = FeatureUsage()
        raw_attempts: list[str] = []
        extraction: Extraction | None = None
        error: str | None = None
        condensed = False

        # The size bound (module docstring), decided before anything is typed anywhere.
        over = oversize_reply(responses)
        if over is not None:
            error = oversize_message(*over)  # loud, and not one analyst call
        elif needs_split(responses):
            condensed = True
            reduced, error = await _condense_all(
                model=model,
                question=send_turn.prompt,
                responses=responses,
                usage=usage,
                raw_attempts=raw_attempts,
                queue=queue,
            )
            if reduced is not None:
                # Re-measure. A condense call that answered with claims as long as the reply it was
                # given leaves the comparison prompt exactly as big as before, having spent three
                # extra analyst calls to get there.
                still = quoted_chars(reduced)
                if still > SPLIT_MIN_CHARS:
                    worst, worst_chars = max(
                        ((label, len(text)) for label, text in reduced.items()),
                        key=lambda pair: pair[1],
                    )
                    error = condense_ineffective(still, worst, worst_chars)
                else:
                    responses = reduced

        if error is None:
            messages = prompts.build_messages(
                send_turn.prompt, responses, fenced=fenced, condensed=condensed
            )
            extraction, raw, attempt_usage, error = await _attempt(model=model, messages=messages)
            usage.merge(attempt_usage)
            raw_attempts.append(raw)
            for _ in range(ATTEMPTS - 1):
                if extraction is not None or web_retry_suppressed(model, raw, error):
                    break
                queue.put_nowait({"type": "analyze_retry", "error": error or "unknown error"})
                messages = [*messages, *retry_follow_up(raw, error, fenced=fenced)]
                extraction, raw, attempt_usage, error = await _attempt(
                    model=model, messages=messages
                )
                usage.merge(attempt_usage)
                raw_attempts.append(raw)

        usage.set_wall_clock(max(1, int((time.monotonic() - started) * 1000)))
        turn = AnalyzeTurn(
            id=turn_id,
            of_turn=send_turn.id,
            extraction=extraction,
            status="ok" if extraction is not None else "degraded",
            error=None if extraction is not None else (error or "unknown error"),
            raw_attempts=raw_attempts,
            slot_config=conv.slot_config.model_copy(deep=True),
            usage=usage,
        )
        await store.append_turn(conv.id, turn)
        if turn.status == "ok":
            final = {"type": "analyze_done", "turn": turn.model_dump(), "cached": False}
        else:
            final = {"type": "analyze_degraded", "turn": turn.model_dump()}
    except Exception as e:  # after the first event only a terminal error event remains
        log.exception("analyze failed for conversation %s", conv.id)
        final = {"type": "error", "message": f"{type(e).__name__}: {e}"}
    finally:
        # Release after the last persistence write and BEFORE the client sees the final event,
        # so a Fusion fired on analyze_done never trips over a guard that is still held. The
        # final event and the sentinel are enqueued even if the release raised (send/fusion
        # parity): a consumer must never block forever on an HTTP 200 stream.
        try:
            await guard.__aexit__(None, None, None)
        finally:
            if final is not None:
                queue.put_nowait(final)
            queue.put_nowait(_END)


# --------------------------------------------------------------------------- public API (frozen)
async def run_analyze(
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
            yield {"type": "analyze_start", "turn_id": cached.id, "of_turn": send_turn.id}
            yield {"type": "analyze_done", "turn": cached.model_dump(), "cached": True}
            return

    guard = store.busy_guard(conv_id)
    await guard.__aenter__()  # LAST pre-check: 409 busy
    turn_id = new_id()  # minted before the first event
    queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
    task = asyncio.create_task(
        _produce(conv, send_turn, turn_id, queue, guard), name=f"analyze:{turn_id}"
    )
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)
    while True:
        event = await queue.get()
        if event is _END:
            return
        yield event


__all__ = [
    "ATTEMPTS",
    "PURPOSE",
    "REPLY_BUDGET_CHARS",
    "ROLE",
    "SPLIT_MIN_CHARS",
    "cached_ok_turn",
    "condense_failure",
    "condense_ineffective",
    "missing_responses",
    "needs_split",
    "oversize_message",
    "oversize_reply",
    "quoted_chars",
    "resolve_send_turn",
    "responses_by_label",
    "retry_follow_up",
    "run_analyze",
    "split_notice",
    "web_retry_suppressed",
]
