"""Fusion feature (owner: W6). Frozen signature; yields fusion_* (and auto-run analyze_*) events.

Normative behaviour: docs/semantics.md "Fusion" (+ the producer-model addendum), the `fusion_*`
events in docs/api-contract.md and the per-role call sequences in docs/fixtures.md.

Pre-checks, in order and all BEFORE the first yield (so `sse.sse_response` turns them into plain
JSON errors): `store.load` -> 404; `max_iterations` outside 1..MAX_ITERATIONS_CAP -> 422
invalid_max_iterations; explicit `of_analyze`: unknown id -> 404 not_found("turn"), not an
analyze turn -> 422 not_an_analyze_turn, degraded -> 409 analyze_degraded; default `of_analyze`
= the newest `analyze` turn with status ok whose `of_turn` is the newest send turn. When an ok
Analyze turn exists its standing set (materiality rank >= the CONVERSATION's `materiality_min`,
extraction order) must be non-empty -> 409 nothing_to_fuse. When none exists Analyze is auto-run
inside the stream, so the pre-stream checks Analyze itself would fail are run here first (409
no_send_turn / incomplete_send_turn{missing}) and the nested `run_analyze` never raises while the
outer guard is held. `busy_guard` is entered LAST -> 409 busy.

Producer model (same shape as Send/Analyze): ONE `asyncio.create_task` performs the optional
Analyze auto-run (forwarding every `analyze_*` event), every LLM call and every persistence write,
releases the busy guard in its `finally` after the last write, and only then hands the final event
(`fusion_done` or the terminal `error`) to the queue; the generator only drains that queue, so a
disconnected client neither cancels the work nor releases the guard early. The FusionTurn id is
minted before the first event; after the first event every failure is the terminal
`error{message}` event. On the auto-run path the stream ends after `analyze_degraded` with
`error{message:"analyze_degraded"}`, or after `analyze_done` with `error{message:"nothing_to_fuse"}`
when the fresh extraction has nothing to fuse (no fusion turn either way).

Loop (docs/semantics.md, implemented literally): per round, every label holding a Position on
every still-standing divergence is challenged in its own thread -- sequential per slot in standing
order, slots in parallel -- with `complete_json(role=slot, purpose="defense", DefenseReply,
retries=1)` and that slot's own model/effort; a success appends [fusion_challenge(user),
fusion_reply(assistant, raw verbatim)] to the slot's thread with `meta={divergence_id, round}` and
flags the reply with `schemas.is_unjustified` against the peer claims shown; a failure is an
`unavailable` exchange (claim/justification unchanged, nothing appended). An all-unavailable
round exits "error" (checked BEFORE stalemate); a round without a revise exits "stalemate" with NO
analyst call; otherwise ONE analyst convergence check runs over the standing divergences that
saw >= 1 revise this round. A divergence the analyst resolves becomes `resolved_unjustified` when
every revise on it across all rounds of this turn was flagged; resolved ids keep their status and
are never re-challenged; all resolved -> "converged"; round == max_iterations -> "max_iterations".
`post_round_status` / `final` always list every standing id in standing order. The analyst is
asked for `resolved|standing` only; a `resolved_unjustified` it returns anyway counts as
`resolved` and the flag rule alone decides the kind.
`FusionTurn.usage` covers fusion calls only (its wall clock is the fusion part).

Both `complete_json(retries=1)` calls above rely on the client's web no-retry rule
(`client.web_retry_suppressed`, S7 review: "Fusion's convergence retry re-types the whole payload
into a NEW hidden analyst chat"): on a `web:` transport an attempt that produced no output at all
is NOT corrected, because the correction follow-up would carry no assistant echo -- which the
bridge reads as a fresh analyst conversation and would re-type the entire convergence payload into
a brand-new chat in the user's own account (a pane defense would re-submit into the site's own
thread for nothing). So an empty site reply is one `unavailable` exchange, or one convergence check
that fails and leaves its divergences standing, and exactly ONE request frame either way. Output
that merely fails parsing or validation still gets the correction attempt in the same chat.

Anonymisation (docs/semantics.md "Anonymization / leaks" + the "Delimiter breakout" addendum):
every model- or analyst-authored text Triplex puts into a prompt is scrubbed AND delimited -- the
divergence `topic` of a challenge, and the topic + current claims of the convergence payload --
and every error message that reaches an event or the persisted turn (`Exchange.error`, the
terminal `error{message}`) goes through `anon.scrub`: a live transport message can name the model
slug and the mock's `mock_miss` text pairs the R-label with the slot id.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import AsyncIterator
from typing import Any

from fastapi import HTTPException

from .. import anon, api_errors
from ..config import ANALYST_EFFORT, MAX_ITERATIONS_CAP, MAX_TOKENS_STAGE
from ..llm import client
from ..prompts import fusion as prompts
from ..schemas import (
    ANALYST_ROLE,
    MATERIALITY_RANK,
    SLOT_IDS,
    AnalyzeTurn,
    ConvergenceCheck,
    Conversation,
    DefenseReply,
    Divergence,
    Exchange,
    Extraction,
    FeatureUsage,
    FusionRound,
    FusionTurn,
    Label,
    PeerState,
    RoundStatus,
    RoundStatusValue,
    SendTurn,
    SlotId,
    ThreadMessage,
    is_unjustified,
    new_id,
    to_openai,
)
from ..store import conversations as store

log = logging.getLogger("triplex.features.fusion")

DEFENSE_PURPOSE = "defense"
CONVERGENCE_PURPOSE = "convergence"
# Terminal `error{message}` codes of the auto-run path (docs/api-contract.md).
ANALYZE_DEGRADED = "analyze_degraded"
NOTHING_TO_FUSE = "nothing_to_fuse"
ANALYZE_INCOMPLETE = "analyze_incomplete"

_END = object()  # queue sentinel: the producer has finished (guard released)
# asyncio keeps only weak references to tasks: hold the producers so a disconnected client (whose
# generator is gone) can never let a running Fusion be garbage-collected mid-flight.
_tasks: set[asyncio.Task[None]] = set()

StatusMap = dict[str, RoundStatusValue]
ClaimKey = tuple[str, Label]  # (divergence_id, label)


# --------------------------------------------------------------------------- pure helpers
def compute_standing(extraction: Extraction | None, materiality_min: str) -> list[str]:
    """Divergence ids with `MATERIALITY_RANK[materiality] >= rank[materiality_min]`, in order
    of appearance in `extraction.divergences`."""
    if extraction is None:
        return []
    floor = MATERIALITY_RANK[materiality_min]
    return [d.id for d in extraction.divergences if MATERIALITY_RANK[d.materiality] >= floor]


def newest_send_turn(conv: Conversation) -> SendTurn | None:
    for turn in reversed(conv.turns):
        if turn.type == "send":
            return turn
    return None


def newest_ok_analyze_for(conv: Conversation, send_id: str) -> AnalyzeTurn | None:
    """The newest analyze turn with status ok whose `of_turn` is `send_id`."""
    for turn in reversed(conv.turns):
        if turn.type == "analyze" and turn.status == "ok" and turn.of_turn == send_id:
            return turn
    return None


def find_turn(conv: Conversation, turn_id: str) -> Any | None:
    for turn in conv.turns:
        if turn.id == turn_id:
            return turn
    return None


def resolve_analyze_turn(conv: Conversation, of_analyze: str | None) -> AnalyzeTurn | None:
    """The Analyze turn to fuse, or None when Analyze must be auto-run (default `of_analyze`
    and no ok analyze turn for the newest send turn). Raises the pre-stream errors for an
    explicit `of_analyze`."""
    if of_analyze is None:
        send = newest_send_turn(conv)
        return newest_ok_analyze_for(conv, send.id) if send is not None else None
    turn = find_turn(conv, of_analyze)
    if turn is None:
        raise api_errors.not_found("turn")
    if turn.type != "analyze":
        raise api_errors.unprocessable("not_an_analyze_turn", of_analyze=of_analyze)
    if turn.status != "ok" or turn.extraction is None:
        raise api_errors.conflict(ANALYZE_DEGRADED)
    return turn


def labels_with_position(div: Divergence) -> list[Label]:
    """Every label holding a Position on `div`, in order of appearance, each once."""
    return list(dict.fromkeys(p.model for p in div.positions))


def _error_message(e: BaseException) -> str:
    if isinstance(e, HTTPException):
        detail = e.detail
        if isinstance(detail, dict) and isinstance(detail.get("error"), str):
            return detail["error"]
        return str(detail)
    return f"{type(e).__name__}: {e}"


async def wait_for_background() -> None:
    """Await every producer task still running on this loop (tests / graceful shutdown)."""
    loop = asyncio.get_running_loop()
    pending = [t for t in _tasks if not t.done() and t.get_loop() is loop]
    if pending:
        await asyncio.gather(*pending, return_exceptions=True)


# --------------------------------------------------------------------------- the producer
class _FusionRun:
    """State of one Fusion invocation; `produce()` runs inside the producer task."""

    def __init__(
        self,
        *,
        conv: Conversation,
        analyze_turn: AnalyzeTurn | None,
        max_iterations: int,
        turn_id: str,
        guard: Any,
        queue: asyncio.Queue[Any],
    ) -> None:
        self.conv = conv
        self.conv_id = conv.id
        self.analyze_turn = analyze_turn
        self.max_iterations = max_iterations
        self.turn_id = turn_id
        self.guard = guard
        self.queue = queue
        self.emitted = False
        # Loop state (filled by _init_state once the Analyze turn is known).
        self.standing: list[str] = []
        self.divs: dict[str, Divergence] = {}
        self.labels: dict[Label, SlotId] = {}
        self.threads: dict[SlotId, list[ThreadMessage]] = {}
        self.status: StatusMap = {}
        self.claims: dict[ClaimKey, str] = {}
        self.justs: dict[ClaimKey, str | None] = {}
        self.revise_flags: dict[str, list[bool]] = {}
        self.usage = FeatureUsage()

    # ------------------------------------------------------------------ plumbing
    async def _emit(self, event: dict[str, Any]) -> None:
        self.emitted = True
        await self.queue.put(event)

    async def produce(self) -> None:
        """Everything after the pre-checks. The final event (fusion_done or the terminal error)
        is handed over only after the guard is released in `finally`."""
        final: dict[str, Any] | BaseException | None = None
        try:
            if self.analyze_turn is None:
                final = await self._auto_analyze()
            if final is None:
                final = await self._fuse()
        except Exception as e:
            if not isinstance(e, HTTPException):
                log.exception("fusion failed for conversation %s", self.conv_id)
            # Before the first event the generator re-raises it (a pre-stream JSON error);
            # after it only the terminal error event is possible.
            final = (
                e
                if not self.emitted
                else {"type": "error", "message": anon.scrub(_error_message(e))}
            )
        finally:
            try:
                await self.guard.__aexit__(None, None, None)  # after the last persistence write
            finally:
                if final is not None:
                    await self.queue.put(final)
                await self.queue.put(_END)

    # ------------------------------------------------------------------ analyze auto-run
    async def _auto_analyze(self) -> dict[str, Any] | None:
        """Run the REAL Analyze inside this stream, forwarding its events, and adopt the new
        turn. Returns the terminal error event when the stream must end here, else None."""
        from . import analyze as analyze_mod  # lazy: importers import feature code lazily

        last: dict[str, Any] | None = None
        async for event in analyze_mod.run_analyze(self.conv_id):
            kind = event.get("type")
            if kind in ("analyze_done", "analyze_degraded", "error"):
                last = event
                if kind == "error":
                    # error is always the last event: forward it and stop. Its message reaches
                    # the client, so it is scrubbed like every other error text Fusion emits.
                    self.emitted = True
                    msg = event.get("message")
                    return {**event, "message": anon.scrub(msg)} if isinstance(msg, str) else event
            await self._emit(event)
        if last is None:
            return {"type": "error", "message": ANALYZE_INCOMPLETE}
        if last["type"] == "analyze_degraded":
            return {"type": "error", "message": ANALYZE_DEGRADED}

        conv = await store.load(self.conv_id)
        if conv is None:
            return {"type": "error", "message": "not_found"}
        self.conv = conv
        turn_doc = last.get("turn")
        new_turn_id = turn_doc.get("id") if isinstance(turn_doc, dict) else None
        turn = find_turn(conv, new_turn_id) if isinstance(new_turn_id, str) else None
        if turn is None or turn.type != "analyze" or turn.status != "ok" or turn.extraction is None:
            return {"type": "error", "message": ANALYZE_DEGRADED}
        self.analyze_turn = turn
        if not compute_standing(turn.extraction, conv.slot_config.materiality_min):
            return {"type": "error", "message": NOTHING_TO_FUSE}
        return None

    # ------------------------------------------------------------------ loop state
    def _init_state(self) -> None:
        conv, turn = self.conv, self.analyze_turn
        assert turn is not None and turn.extraction is not None
        self.labels = anon.labels(conv)
        self.threads = {slot: list(conv.threads.get(slot, [])) for slot in SLOT_IDS}
        self.standing = compute_standing(turn.extraction, conv.slot_config.materiality_min)
        self.divs = {d.id: d for d in turn.extraction.divergences}
        self.status = {d: "standing" for d in self.standing}
        self.revise_flags = {d: [] for d in self.standing}
        for d in self.standing:
            for pos in self.divs[d].positions:
                self.claims.setdefault((d, pos.model), pos.claim)
                self.justs.setdefault((d, pos.model), pos.evidence_cited)

    def current_claim(self, d: str, label: Label) -> str:
        """`revised_claim` of the label's most recent revise on `d`, else its Extraction claim."""
        return self.claims[(d, label)]

    def latest_justification(self, d: str, label: Label) -> str:
        """Justification of the label's most recent (available) exchange on `d`, else
        `evidence_cited`, else "(none given)"."""
        just = self.justs.get((d, label))
        return just.strip() if just is not None and just.strip() else anon.NONE_GIVEN

    def post_round_status(self) -> list[RoundStatus]:
        return [RoundStatus(divergence_id=d, status=self.status[d]) for d in self.standing]

    # ------------------------------------------------------------------ one challenge
    async def _challenge(
        self,
        *,
        slot: SlotId,
        d: str,
        label: Label,
        round_no: int,
        claims: dict[ClaimKey, str],
        justs: dict[ClaimKey, str | None],
    ) -> Exchange:
        div = self.divs[d]
        holders = labels_with_position(div)
        peers = [
            PeerState(label=peer, claim=claims[(d, peer)], justification=justs[(d, peer)])
            for peer in holders
        ]
        # Exactly what the peer block shows (render_peer_block scrubs every claim).
        peer_claims_shown = [anon.scrub(claims[(d, peer)]) for peer in holders if peer != label]
        own_just = justs[(d, label)]
        spec = self.conv.slot_config.slots[slot]
        prompt = prompts.challenge_prompt(
            topic=anon.scrub(div.topic),  # analyst-authored: scrubbed here, delimited there
            current_claim=claims[(d, label)],
            latest_justification=(
                own_just.strip() if own_just and own_just.strip() else anon.NONE_GIVEN
            ),
            peer_block=anon.render_peer_block(peers, exclude=label),
            round=round_no,
            max_iterations=self.max_iterations,
            # A web session's reply is read back out of rendered markdown, where only a fenced
            # block survives byte for byte (prompts/fusion.py module docstring).
            fenced=client.transport_kind(spec.model) == "web",
        )
        anon.find_leaks(prompt)  # advisory: logs a warning, never blocks
        thread = self.threads[slot]
        messages = [to_openai(m) for m in thread] + [{"role": "user", "content": prompt}]
        parsed, raw_text, usage, error = await client.complete_json(
            role=slot,
            purpose=DEFENSE_PURPOSE,
            model=spec.model,
            messages=messages,
            schema_model=DefenseReply,
            effort=spec.effort,
            max_tokens=MAX_TOKENS_STAGE[DEFENSE_PURPOSE],
            retries=1,
        )
        self.usage.merge(usage)
        if not isinstance(parsed, DefenseReply):
            # The message is emitted, persisted and shown: a transport error can name the model
            # slug, the mock's mock_miss text names the slot id.
            exchange = Exchange(
                divergence_id=d,
                model=label,
                stance="unavailable",
                confidence=None,
                error=anon.scrub(error or "defense call failed"),
            )
        else:
            meta = {"divergence_id": d, "round": round_no}
            pair = [
                ThreadMessage(
                    role="user",
                    content=prompt,
                    kind="fusion_challenge",
                    turn_id=self.turn_id,
                    meta=dict(meta),
                ),
                ThreadMessage(
                    role="assistant",
                    content=raw_text,
                    kind="fusion_reply",
                    turn_id=self.turn_id,
                    meta=dict(meta),
                ),
            ]
            await store.append_to_thread(self.conv_id, slot, pair)
            thread.extend(pair)
            exchange = Exchange(
                divergence_id=d,
                model=label,
                stance=parsed.stance,
                justification=parsed.justification,
                revised_claim=parsed.revised_claim,
                confidence=parsed.confidence,
                persuaded_by=parsed.persuaded_by,
                flagged_unjustified=is_unjustified(parsed, peer_claims_shown),
            )
        await self._emit({"type": "exchange", "round": round_no, **exchange.model_dump()})
        return exchange

    async def _run_slot(
        self,
        slot: SlotId,
        items: list[ClaimKey],
        round_no: int,
        claims: dict[ClaimKey, str],
        justs: dict[ClaimKey, str | None],
    ) -> list[Exchange]:
        """One slot's challenges of a round, sequential in standing order."""
        out: list[Exchange] = []
        for d, label in items:
            out.append(
                await self._challenge(
                    slot=slot, d=d, label=label, round_no=round_no, claims=claims, justs=justs
                )
            )
        return out

    # ------------------------------------------------------------------ convergence
    async def _convergence(self, to_check: list[str]) -> None:
        """ONE analyst call over `to_check`; a `resolved` (or `resolved_unjustified`) answer
        resolves the id and the flag rule decides the kind. Ids missing from the reply, carrying
        an unknown status, or not sent this round stay as they are. Topic and claims are
        model/analyst-authored: scrubbed here, delimited by `convergence_messages`."""
        items = [
            {
                "divergence_id": d,
                "topic": anon.scrub(self.divs[d].topic),
                "claims": {
                    label: anon.scrub(self.current_claim(d, label))
                    for label in labels_with_position(self.divs[d])
                },
            }
            for d in to_check
        ]
        analyst_model = self.conv.slot_config.analyst_model
        messages = prompts.convergence_messages(
            items, fenced=client.transport_kind(analyst_model) == "web"
        )
        for m in messages:
            anon.find_leaks(m["content"])  # advisory only
        parsed, _raw, usage, error = await client.complete_json(
            role=ANALYST_ROLE,
            purpose=CONVERGENCE_PURPOSE,
            model=analyst_model,
            messages=messages,
            schema_model=ConvergenceCheck,
            effort=ANALYST_EFFORT,
            max_tokens=MAX_TOKENS_STAGE[CONVERGENCE_PURPOSE],
            retries=1,
        )
        self.usage.merge(usage)
        if not isinstance(parsed, ConvergenceCheck):
            log.warning(
                "convergence check failed for conversation %s (%s): %s stay standing",
                self.conv_id,
                error,
                to_check,
            )
            return
        sent = set(to_check)
        for rs in parsed.statuses:
            d = rs.divergence_id
            if d not in sent or self.status.get(d) != "standing":
                continue  # not sent this round (sticky fixture / stale id): ignored
            if rs.status in ("resolved", "resolved_unjustified"):
                # The analyst is instructed to answer resolved|standing; either resolved kind
                # means "resolved" and the deterministic flag rule alone decides the kind
                # (every revise on d across all rounds of this turn flagged -> unjustified).
                flags = self.revise_flags[d]
                self.status[d] = "resolved_unjustified" if flags and all(flags) else "resolved"
            # "standing": stays standing

    # ------------------------------------------------------------------ the loop
    async def _fuse(self) -> dict[str, Any]:
        started = time.monotonic()
        self._init_state()
        analyze_turn = self.analyze_turn
        assert analyze_turn is not None
        await self._emit(
            {
                "type": "fusion_start",
                "turn_id": self.turn_id,
                "of_analyze": analyze_turn.id,
                "max_iterations": self.max_iterations,
                "standing": list(self.standing),
            }
        )

        rounds: list[FusionRound] = []
        exit_reason: str | None = None
        for round_no in range(1, self.max_iterations + 1):
            await self._emit({"type": "round_start", "round": round_no})
            active = [d for d in self.standing if self.status[d] == "standing"]
            # Snapshot at round start: every label of this round sees the same peer state; the
            # current claims/justifications are updated from the replies after the round.
            claims, justs = dict(self.claims), dict(self.justs)
            per_slot: dict[SlotId, list[ClaimKey]] = {}
            for d in active:
                for label in labels_with_position(self.divs[d]):
                    per_slot.setdefault(self.labels[label], []).append((d, label))
            slots = [s for s in SLOT_IDS if s in per_slot]
            results = await asyncio.gather(
                *(self._run_slot(s, per_slot[s], round_no, claims, justs) for s in slots),
                return_exceptions=True,  # wait for every slot, then fail as a whole
            )
            by_key: dict[ClaimKey, Exchange] = {}
            for result in results:
                if isinstance(result, BaseException):
                    raise result
                for ex in result:
                    by_key[(ex.divergence_id, ex.model)] = ex
            exchanges = [
                by_key[(d, label)]
                for d in active
                for label in labels_with_position(self.divs[d])
                if (d, label) in by_key
            ]

            changed = False
            for ex in exchanges:
                if ex.stance == "unavailable":
                    continue  # claim and justification unchanged
                key = (ex.divergence_id, ex.model)
                self.justs[key] = ex.justification
                if ex.stance == "revise":
                    changed = True
                    if ex.revised_claim is not None:
                        self.claims[key] = ex.revised_claim
                    self.revise_flags[ex.divergence_id].append(ex.flagged_unjustified)

            if exchanges and all(ex.stance == "unavailable" for ex in exchanges):
                exit_reason = "error"  # checked BEFORE stalemate
            elif not changed:
                exit_reason = "stalemate"  # nothing changed: no analyst call
            else:
                revised = {ex.divergence_id for ex in exchanges if ex.stance == "revise"}
                await self._convergence([d for d in active if d in revised])
                if all(self.status[d] != "standing" for d in self.standing):
                    exit_reason = "converged"
                elif round_no == self.max_iterations:
                    exit_reason = "max_iterations"

            post = self.post_round_status()
            rounds.append(
                FusionRound(
                    round=round_no, exchanges=exchanges, post_round_status=post, changed=changed
                )
            )
            await self._emit(
                {
                    "type": "round_done",
                    "round": round_no,
                    "post_round_status": [s.model_dump() for s in post],
                    "changed": changed,
                }
            )
            if exit_reason is not None:
                break
        if exit_reason is None:  # pragma: no cover - the loop always decides at the cap
            exit_reason = "max_iterations"

        final = self.post_round_status()
        self.usage.set_wall_clock(max(1, int((time.monotonic() - started) * 1000)))
        turn = FusionTurn(
            id=self.turn_id,
            slot_config=self.conv.slot_config.model_copy(deep=True),
            usage=self.usage,
            of_analyze=analyze_turn.id,
            max_iterations=self.max_iterations,
            standing=list(self.standing),
            rounds=rounds,
            final=final,
            exit_reason=exit_reason,  # type: ignore[arg-type]
        )
        await store.append_turn(self.conv_id, turn)  # completes BEFORE fusion_done is handed over
        totals = self.usage.totals
        log.info(
            "fusion turn conv=%s turn=%s of_analyze=%s max_iterations=%d rounds=%d exit=%s "
            "standing=%s final=%s prompt_tokens=%d completion_tokens=%d reasoning_tokens=%d "
            "cost_usd=%.6f latency_ms=%d calls=%d",
            self.conv_id,
            self.turn_id,
            analyze_turn.id,
            self.max_iterations,
            len(rounds),
            exit_reason,
            ",".join(self.standing) or "-",
            ",".join(f"{s.divergence_id}:{s.status}" for s in final) or "-",
            totals.prompt_tokens,
            totals.completion_tokens,
            totals.reasoning_tokens,
            totals.cost_usd,
            totals.latency_ms,
            totals.calls,
        )
        return {
            "type": "fusion_done",
            "turn": turn.model_dump(mode="json"),
            "exit_reason": exit_reason,
            "usage": self.usage.model_dump(mode="json"),
        }


# --------------------------------------------------------------------------- public API (frozen)
async def run_fusion(
    conv_id: str, *, of_analyze: str | None, max_iterations: int
) -> AsyncIterator[dict[str, Any]]:
    # ---- pre-checks: every one before the first yield ------------------------------------
    conv = await store.load(conv_id)
    if conv is None:
        raise api_errors.not_found("conversation")
    if (
        isinstance(max_iterations, bool)
        or not isinstance(max_iterations, int)
        or not 1 <= max_iterations <= MAX_ITERATIONS_CAP
    ):
        raise api_errors.unprocessable(
            "invalid_max_iterations", max_iterations=max_iterations, cap=MAX_ITERATIONS_CAP
        )
    analyze_turn = resolve_analyze_turn(conv, of_analyze)
    if analyze_turn is not None:
        if not compute_standing(analyze_turn.extraction, conv.slot_config.materiality_min):
            raise api_errors.conflict(NOTHING_TO_FUSE)
    else:
        # Analyze will be auto-run inside the stream: its own pre-stream checks run here so the
        # nested run_analyze never raises while the outer guard is held.
        from . import analyze as analyze_mod  # lazy: importers import feature code lazily

        send = analyze_mod.resolve_send_turn(conv, None)  # 409 no_send_turn
        missing = analyze_mod.missing_responses(send)
        if missing:
            raise api_errors.conflict("incomplete_send_turn", missing=missing)

    guard = store.busy_guard(conv_id)
    await guard.__aenter__()  # LAST pre-check: 409 busy; released by the producer's finally
    try:
        turn_id = new_id()  # minted BEFORE the first event
        queue: asyncio.Queue[Any] = asyncio.Queue()
        run = _FusionRun(
            conv=conv,
            analyze_turn=analyze_turn,
            max_iterations=max_iterations,
            turn_id=turn_id,
            guard=guard,
            queue=queue,
        )
        task = asyncio.create_task(run.produce(), name=f"triplex-fusion-{turn_id}")
    except BaseException:
        await guard.__aexit__(None, None, None)
        raise
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)

    while True:
        item = await queue.get()
        if item is _END:
            return
        if isinstance(item, BaseException):
            raise item  # a pre-stream failure inside the producer: still a plain JSON error
        yield item


__all__ = [
    "ANALYZE_DEGRADED",
    "CONVERGENCE_PURPOSE",
    "DEFENSE_PURPOSE",
    "NOTHING_TO_FUSE",
    "compute_standing",
    "find_turn",
    "labels_with_position",
    "newest_ok_analyze_for",
    "newest_send_turn",
    "resolve_analyze_turn",
    "run_fusion",
    "wait_for_background",
]
