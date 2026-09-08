"""Frozen shared contract for Triplex (SCHEMA_VERSION = 1). Append-only after Stage 0.

Every workstream imports from here; nothing here imports from any feature module.
Normative behaviour lives in docs/semantics.md, the wire format in docs/api-contract.md,
and the mock/replay format in docs/fixtures.md.
"""

from __future__ import annotations

import json
import random
import re
import uuid
from datetime import UTC, datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field, TypeAdapter, field_validator

SCHEMA_VERSION = 1

# --------------------------------------------------------------------------- vocabularies
SlotId = Literal["claude", "chatgpt", "grok"]
SLOT_IDS: tuple[SlotId, ...] = ("claude", "chatgpt", "grok")
# Slot -> OpenRouter slug vendor prefix (the part before the first "/"). Frozen; the frontend
# duplicates it inside features/send because state/* is frozen.
SLOT_VENDORS: dict[SlotId, str] = {"claude": "anthropic", "chatgpt": "openai", "grok": "x-ai"}
Label = Literal["R1", "R2", "R3"]
LABELS: tuple[Label, ...] = ("R1", "R2", "R3")
Effort = Literal["off", "low", "medium", "high"]
EFFORTS: tuple[Effort, ...] = ("off", "low", "medium", "high")
Materiality = Literal["high", "medium", "low"]
MATERIALITY_RANK: dict[str, int] = {"low": 0, "medium": 1, "high": 2}
Purpose = Literal["chat", "extraction", "defense", "convergence"]
ANALYST_ROLE = "analyst"  # `role` is a SlotId or ANALYST_ROLE
ExitReason = Literal["converged", "stalemate", "max_iterations", "error"]


def now_iso() -> str:
    """ISO-8601 UTC with millisecond precision and a Z suffix."""
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def new_id() -> str:
    return str(uuid.uuid4())


# --------------------------------------------------------------------------- configuration
class SlotSpec(BaseModel):
    model: str
    effort: Effort = "medium"


class SlotConfig(BaseModel):
    slots: dict[SlotId, SlotSpec]
    analyst_model: str
    max_iterations: int = Field(default=2, ge=1, le=5)
    materiality_min: Materiality = "medium"
    grounded: bool = False

    @field_validator("slots")
    @classmethod
    def _all_slots_present(cls, v: dict[str, SlotSpec]) -> dict[str, SlotSpec]:
        missing = [s for s in SLOT_IDS if s not in v]
        if missing:
            raise ValueError(f"slot_config.slots missing {missing}")
        return v


# --------------------------------------------------------------------------- threads
MessageKind = Literal["chat", "fusion_challenge", "fusion_reply"]


class ThreadMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str
    kind: MessageKind = "chat"
    turn_id: str
    ts: str = Field(default_factory=now_iso)
    meta: dict[str, Any] | None = None  # {"divergence_id": ..., "round": ...} for fusion messages


def to_openai(msg: ThreadMessage) -> dict[str, str]:
    """Projection sent to OpenRouter: only role + content, never kind/meta/turn_id."""
    return {"role": msg.role, "content": msg.content}


# --------------------------------------------------------------------------- usage / metering
class Usage(BaseModel):
    prompt_tokens: int = 0
    completion_tokens: int = 0
    reasoning_tokens: int = 0
    cost_usd: float = 0.0
    latency_ms: int = 0
    model: str
    role: str
    purpose: str
    generation_id: str | None = None


class UsageTotals(BaseModel):
    prompt_tokens: int = 0
    completion_tokens: int = 0
    reasoning_tokens: int = 0
    cost_usd: float = 0.0
    latency_ms: int = 0  # wall clock of the whole feature invocation, NOT a sum
    calls: int = 0


class FeatureUsage(BaseModel):
    calls: list[Usage] = Field(default_factory=list)
    totals: UsageTotals = Field(default_factory=UsageTotals)

    def add(self, u: Usage) -> None:
        self.calls.append(u)
        t = self.totals
        t.prompt_tokens += u.prompt_tokens
        t.completion_tokens += u.completion_tokens
        t.reasoning_tokens += u.reasoning_tokens
        t.cost_usd = round(t.cost_usd + u.cost_usd, 8)
        t.calls += 1

    def set_wall_clock(self, latency_ms: int) -> None:
        self.totals.latency_ms = latency_ms

    def merge(self, other: FeatureUsage) -> None:
        for u in other.calls:
            self.add(u)


# --------------------------------------------------------------------------- analyze (extraction)
class Position(BaseModel):
    model: Label
    claim: str
    evidence_cited: str | None = None


class Divergence(BaseModel):
    id: str
    topic: str
    positions: list[Position]
    materiality: Materiality


class Agreement(BaseModel):
    topic: str
    statement: str
    models: list[Label]


class Extraction(BaseModel):
    """Analyst response schema (purpose = "extraction")."""

    agreements: list[Agreement]
    divergences: list[Divergence]


# --------------------------------------------------------------------------- fusion
class DefenseReply(BaseModel):
    """Model-facing reply schema for a challenge (purpose = "defense")."""

    stance: Literal["defend", "revise"]
    justification: str
    revised_claim: str | None = None
    confidence: float = Field(ge=0.0, le=1.0)
    persuaded_by: str | None = None


RoundStatusValue = Literal["resolved", "resolved_unjustified", "standing"]


class RoundStatus(BaseModel):
    divergence_id: str
    status: RoundStatusValue


class ConvergenceCheck(BaseModel):
    """Analyst response schema for the per-round convergence check (purpose = "convergence")."""

    statuses: list[RoundStatus]


class Exchange(BaseModel):
    divergence_id: str
    model: Label
    stance: Literal["defend", "revise", "unavailable"]
    justification: str = ""
    revised_claim: str | None = None
    confidence: float | None = None
    persuaded_by: str | None = None
    flagged_unjustified: bool = False
    error: str | None = None


class FusionRound(BaseModel):
    round: int
    exchanges: list[Exchange]
    post_round_status: list[RoundStatus]
    changed: bool


class PeerState(BaseModel):
    """What a challenged model is shown about one peer (rendered by anon.render_peer_block)."""

    label: Label
    claim: str
    justification: str | None = None


# --------------------------------------------------------------------------- turns
class _TurnBase(BaseModel):
    id: str = Field(default_factory=new_id)
    ts: str = Field(default_factory=now_iso)
    slot_config: SlotConfig
    usage: FeatureUsage = Field(default_factory=FeatureUsage)


class SendTurn(_TurnBase):
    type: Literal["send"] = "send"
    prompt: str
    responses: dict[SlotId, str | None]
    errors: dict[SlotId, str] = Field(default_factory=dict)
    partial: dict[SlotId, str] = Field(default_factory=dict)
    # Persisted per slot on the turn (never in threads): live reasoning text, raw citation
    # annotations, truncation flag and the effort actually applied.
    reasoning: dict[SlotId, str] = Field(default_factory=dict)
    citations: dict[SlotId, list[dict[str, Any]]] = Field(default_factory=dict)
    truncated: dict[SlotId, bool] = Field(default_factory=dict)
    effort_applied: dict[SlotId, Effort] = Field(default_factory=dict)


class ContinueTurn(_TurnBase):
    type: Literal["continue"] = "continue"
    slot: SlotId
    prompt: str
    response: str | None = None
    error: str | None = None
    reasoning: str | None = None
    citations: list[dict[str, Any]] = Field(default_factory=list)
    truncated: bool = False
    effort_applied: Effort | None = None


class AnalyzeTurn(_TurnBase):
    type: Literal["analyze"] = "analyze"
    of_turn: str
    extraction: Extraction | None = None
    status: Literal["ok", "degraded"] = "ok"
    error: str | None = None
    raw_attempts: list[str] = Field(default_factory=list)


class FusionTurn(_TurnBase):
    type: Literal["fusion"] = "fusion"
    of_analyze: str
    max_iterations: int = Field(ge=1, le=5)
    standing: list[str]
    rounds: list[FusionRound] = Field(default_factory=list)
    final: list[RoundStatus] = Field(default_factory=list)
    exit_reason: ExitReason


Turn = Annotated[SendTurn | ContinueTurn | AnalyzeTurn | FusionTurn, Field(discriminator="type")]
TurnAdapter: TypeAdapter[Turn] = TypeAdapter(Turn)


# --------------------------------------------------------------------------- conversation document
class Conversation(BaseModel):
    schema_version: int = SCHEMA_VERSION
    id: str = Field(default_factory=new_id)
    title: str = "New conversation"
    created_at: str = Field(default_factory=now_iso)
    updated_at: str = Field(default_factory=now_iso)
    slot_config: SlotConfig
    threads: dict[SlotId, list[ThreadMessage]]
    turns: list[Turn] = Field(default_factory=list)
    anon_map: dict[Label, SlotId]  # server-side only; stripped by to_public()


class ConversationPublic(BaseModel):
    schema_version: int
    id: str
    title: str
    created_at: str
    updated_at: str
    slot_config: SlotConfig
    threads: dict[SlotId, list[ThreadMessage]]
    turns: list[Turn]


class ConversationSummary(BaseModel):
    id: str
    title: str
    created_at: str
    updated_at: str
    turn_count: int


def to_public(conv: Conversation) -> ConversationPublic:
    return ConversationPublic.model_validate(conv.model_dump(exclude={"anon_map"}))


def new_anon_map(rng: random.Random | None = None) -> dict[Label, SlotId]:
    """A random, per-conversation R-label -> slot permutation. Created once by store.create,
    persisted, and never re-derived from list position."""
    slots = list(SLOT_IDS)
    (rng or random).shuffle(slots)
    return dict(zip(LABELS, slots, strict=True))


def empty_threads() -> dict[SlotId, list[ThreadMessage]]:
    return {s: [] for s in SLOT_IDS}


# --------------------------------------------------------------------------- LLM layer types
DeltaKind = Literal["text", "reasoning", "citations", "done", "error"]


class Delta(BaseModel):
    kind: DeltaKind
    text: str = ""
    items: list[dict[str, Any]] = Field(default_factory=list)  # citations
    usage: Usage | None = None  # on kind == "done"
    finish_reason: str | None = None
    truncated: bool = False
    generation_id: str | None = None
    code: int | str | None = None  # on kind == "error"
    message: str | None = None
    error_type: str | None = None


class ModelMeta(BaseModel):
    id: str
    name: str = ""
    vendor: str = ""
    context_length: int | None = None
    price_prompt: float | None = None  # USD per token
    price_completion: float | None = None  # USD per token
    efforts: list[Effort] = Field(default_factory=lambda: ["off"])
    mandatory_reasoning: bool = False
    structured_outputs: bool = False
    raw: dict[str, Any] = Field(default_factory=dict)


def efforts_from_reasoning_meta(reasoning: dict[str, Any] | None) -> tuple[list[Effort], bool]:
    """Map OpenRouter's per-model `reasoning` block to Triplex efforts.

    off in efforts  iff a reasoning block exists and mandatory is False.
    low/medium/high in efforts iff supported_efforts is null or contains that name.
    No reasoning block at all -> ["off"] (non-reasoning model).
    Returns (efforts, mandatory).
    """
    if not reasoning:
        return ["off"], False
    mandatory = bool(reasoning.get("mandatory", False))
    supported = reasoning.get("supported_efforts", None)
    efforts: list[Effort] = []
    if not mandatory:
        efforts.append("off")
    for name in ("low", "medium", "high"):
        if supported is None or name in supported:
            efforts.append(name)  # type: ignore[arg-type]
    return efforts, mandatory


# --------------------------------------------------------------------------- helpers
_STRICT_DROP = (
    "default",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "minLength",
    "maxLength",
    "pattern",
    "format",
    "minItems",
    "maxItems",
)


def strict_json_schema(model_cls: type[BaseModel]) -> dict[str, Any]:
    """JSON Schema acceptable to OpenRouter/OpenAI strict mode: every object gets
    additionalProperties:false and lists every property as required; $defs are kept; keywords
    strict mode rejects (default, numeric/string/array bounds, format) are removed -- pydantic
    still enforces them locally after parsing. The `properties` map itself is never treated as
    a schema node (a field could legitimately be named `pattern` or `format`)."""
    schema = model_cls.model_json_schema()

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            for k in _STRICT_DROP:
                node.pop(k, None)
            props = node.get("properties")
            if node.get("type") == "object" and isinstance(props, dict):
                node["additionalProperties"] = False
                node["required"] = list(props)
                for v in props.values():
                    walk(v)
            for k, v in node.items():
                if k != "properties":
                    walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)

    walk(schema)
    return schema


_WORD6 = re.compile(r"[A-Za-z]{6,}")


def is_unjustified(reply: DefenseReply, peer_claims: list[str]) -> bool:
    """Deterministic anti-sycophancy rule (docs/semantics.md). True == flag this revise."""
    if reply.stance != "revise":
        return False
    if reply.revised_claim is None:
        return True
    if len(reply.justification.strip()) < 80:
        return True
    if reply.persuaded_by is None or len(reply.persuaded_by.strip()) < 20:
        return True
    just_tokens = {t.lower() for t in _WORD6.findall(reply.justification)}
    peer_tokens = {t.lower() for c in peer_claims for t in _WORD6.findall(c)}
    return not (just_tokens & peer_tokens)


def sse_frame(event: dict[str, Any]) -> str:
    """One SSE frame: `data: <json>\\n\\n`. The event kind rides inside as `type`."""
    return f"data: {json.dumps(event, ensure_ascii=False)}\n\n"


def canonical_request_key(
    model: str, messages: list[dict[str, Any]], response_format: dict[str, Any] | None
) -> str:
    """sha256 key for recorded fixtures (docs/fixtures.md)."""
    import hashlib

    payload = json.dumps(
        {"model": model, "messages": messages, "response_format": response_format},
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()
