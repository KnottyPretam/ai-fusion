"""Per-area fixtures for tests/export (owned by export-backend). Shared fixtures live in
tests/conftest.py.

Everything here is built in memory from `backend.schemas` only -- `backend/export.py` is pure, so
a test never needs the store or the mock transport. The endpoint tests persist the same document
through the real store (`persist`) and drive it over the ASGI `client`.

The turn factories are deliberately nasty: a slot that failed with a partial reply, a truncated
reply, a citation that is not an http(s) url, reasoning text, an analyst that degraded, a Fusion
round in which one label was unavailable, and a revise flagged by the anti-sycophancy rule.
"""

from __future__ import annotations

import re
from html import unescape
from typing import Any

import pytest

from backend.schemas import (
    Agreement,
    AnalyzeTurn,
    ContinueTurn,
    Conversation,
    Divergence,
    Exchange,
    Extraction,
    FusionRound,
    FusionTurn,
    Position,
    RoundStatus,
    SendTurn,
    ThreadMessage,
)

# The three divergences: one high, one medium (both fused at the default threshold) and one low
# (below it, so the report marks it "not fused").
DIVERGENCES = [
    Divergence(
        id="d1",
        topic="gyroscope full-scale range",
        materiality="high",
        positions=[
            Position(
                model="R1",
                claim="The range is selectable up to 2000 deg/s.",
                evidence_cited="datasheet table 3, register GYRO_RANGE",
            ),
            Position(model="R2", claim="It tops out at 1000 deg/s.", evidence_cited=None),
            Position(
                model="R3",
                claim="Ranges run from 125 to 2000 deg/s.",
                evidence_cited="datasheet section 5.3",
            ),
        ],
    ),
    Divergence(
        id="d2",
        topic="accelerometer bandwidth",
        materiality="medium",
        positions=[
            Position(model="R1", claim="Up to 280 Hz.", evidence_cited=None),
            Position(model="R3", claim="Up to 145 Hz.", evidence_cited="table 12"),
        ],
    ),
    Divergence(
        id="d3",
        topic="package marking",
        materiality="low",
        positions=[
            Position(model="R2", claim="The lid is laser-marked.", evidence_cited=None),
            Position(model="R3", claim="The marking is printed.", evidence_cited=None),
        ],
    ),
]
AGREEMENTS = [
    Agreement(
        topic="device family",
        statement="The part is a 6-axis inertial measurement unit.",
        models=["R1", "R2", "R3"],
    ),
    Agreement(
        topic="interface",
        statement="It speaks both SPI and I2C.",
        models=["R1", "R3"],
    ),
]

CITATIONS: list[dict[str, Any]] = [
    {"type": "url_citation", "url_citation": {"url": "https://www.bosch-sensortec.com/bmi088", "title": "BMI088 product page"}},
    # Not an http(s) url: the document must show it as text, never as an anchor.
    {"type": "url_citation", "url_citation": {"url": "javascript:alert(1)", "title": "hostile"}},
]

GROK_PARTIAL = "The gyro supports ranges from 125"
GROK_ERROR = "session cost cap reached: spent $10.02; live calls refused (cost_cap_exceeded)"
CLAUDE_REASONING = "Checked the register map first, then the ranges table."


@pytest.fixture
def rich_send(make_conversation):
    """A Conversation whose single send turn exercises every per-slot extra."""

    def _mk(**kwargs: Any) -> Conversation:
        conv = make_conversation(with_send=False, **kwargs)
        turn = SendTurn(
            prompt="What is the maximum gyroscope full-scale range of the Bosch BMI088 IMU?",
            slot_config=conv.slot_config.model_copy(deep=True),
            responses={
                "claude": "The BMI088 gyroscope range is selectable up to **2000 deg/s**.",
                "chatgpt": "Its gyroscope tops out at 1000 deg/s full scale.",
                "grok": None,
            },
            errors={"grok": GROK_ERROR},
            partial={"grok": GROK_PARTIAL},
            reasoning={"claude": CLAUDE_REASONING},
            citations={"claude": list(CITATIONS)},
            truncated={"claude": False, "chatgpt": True, "grok": False},
            effort_applied={"claude": "high", "chatgpt": "medium", "grok": "medium"},
        )
        for slot in ("claude", "chatgpt"):
            conv.threads[slot].extend(
                [
                    ThreadMessage(role="user", content=turn.prompt, turn_id=turn.id),
                    ThreadMessage(role="assistant", content=turn.responses[slot], turn_id=turn.id),
                ]
            )
        conv.turns.append(turn)
        return conv

    return _mk


@pytest.fixture
def add_continue():
    def _add(conv: Conversation, *, slot: str = "chatgpt", **kwargs: Any) -> ContinueTurn:
        turn = ContinueTurn(
            slot=slot,
            prompt="And what about the accelerometer?",
            response="The accelerometer covers +-3g to +-24g.",
            slot_config=conv.slot_config.model_copy(deep=True),
            effort_applied="low",
            **kwargs,
        )
        conv.turns.append(turn)
        return turn

    return _add


@pytest.fixture
def add_analyze():
    """Append an AnalyzeTurn for the newest send turn (ok, or degraded with raw attempts)."""

    def _add(conv: Conversation, *, status: str = "ok", of_turn: str | None = None) -> AnalyzeTurn:
        send_id = of_turn or next(t.id for t in reversed(conv.turns) if t.type == "send")
        if status == "degraded":
            turn = AnalyzeTurn(
                of_turn=send_id,
                slot_config=conv.slot_config.model_copy(deep=True),
                status="degraded",
                error="validation_error: agreements.0.models: Input should be 'R1', 'R2' or 'R3'",
                raw_attempts=['{"agreements": [{"models": ["Claude"]}]}', "Sure! Here you go:"],
            )
        else:
            turn = AnalyzeTurn(
                of_turn=send_id,
                slot_config=conv.slot_config.model_copy(deep=True),
                # Deep copies: a test that rewrites a claim must not reach the next test.
                extraction=Extraction(
                    agreements=[a.model_copy(deep=True) for a in AGREEMENTS],
                    divergences=[d.model_copy(deep=True) for d in DIVERGENCES],
                ),
            )
        conv.turns.append(turn)
        return turn

    return _add


def _round_one() -> FusionRound:
    """R1 defends d1, R2 revises it (flagged), R3 is unavailable; d2 is defended by both."""
    return FusionRound(
        round=1,
        exchanges=[
            Exchange(
                divergence_id="d1",
                model="R1",
                stance="defend",
                justification="The register map lists 0x00..0x04 for 2000..125 deg/s, so 2000 is selectable.",
                confidence=0.86,
            ),
            Exchange(
                divergence_id="d1",
                model="R2",
                stance="revise",
                justification="Fair.",
                revised_claim="The range reaches 2000 deg/s.",
                confidence=0.4,
                persuaded_by="R1",
                flagged_unjustified=True,
            ),
            Exchange(
                divergence_id="d1",
                model="R3",
                stance="unavailable",
                error="timeout: no reply within 300 s",
            ),
            Exchange(
                divergence_id="d2",
                model="R1",
                stance="defend",
                justification="Table 12 gives the 3 dB bandwidth at ODR/2, i.e. 280 Hz at 800 Hz ODR.",
                confidence=0.7,
            ),
            Exchange(
                divergence_id="d2",
                model="R3",
                stance="defend",
                justification="The filter table caps the usable bandwidth at 145 Hz.",
                confidence=0.65,
            ),
        ],
        post_round_status=[
            RoundStatus(divergence_id="d1", status="resolved_unjustified"),
            RoundStatus(divergence_id="d2", status="standing"),
        ],
        changed=True,
    )


def _round_two() -> FusionRound:
    return FusionRound(
        round=2,
        exchanges=[
            Exchange(
                divergence_id="d2",
                model="R1",
                stance="revise",
                justification=(
                    "The 145 Hz figure is the filter bandwidth at the lower ODR, which is the "
                    "number that matters for the control loop in question, so the claim narrows."
                ),
                revised_claim="Usable bandwidth is 145 Hz at the default ODR.",
                confidence=0.58,
                persuaded_by="R3 pointed at the filter table for the default output data rate.",
            ),
            Exchange(
                divergence_id="d2",
                model="R3",
                stance="defend",
                justification="The filter table is unambiguous for the default ODR.",
                confidence=0.8,
            ),
        ],
        post_round_status=[RoundStatus(divergence_id="d2", status="resolved")],
        changed=True,
    )


@pytest.fixture
def add_fusion():
    """Append a FusionTurn for `analyze`, shaped for the requested exit_reason."""

    def _add(conv: Conversation, analyze: AnalyzeTurn, *, exit_reason: str = "converged") -> FusionTurn:
        standing = ["d1", "d2"]
        if exit_reason == "converged":
            rounds = [_round_one(), _round_two()]
            final = [
                RoundStatus(divergence_id="d1", status="resolved_unjustified"),
                RoundStatus(divergence_id="d2", status="resolved"),
            ]
            max_iterations = 3
        elif exit_reason == "max_iterations":
            rounds = [_round_one()]
            final = [
                RoundStatus(divergence_id="d1", status="resolved_unjustified"),
                RoundStatus(divergence_id="d2", status="standing"),
            ]
            max_iterations = 1
        elif exit_reason == "stalemate":
            rnd = _round_one().model_copy(deep=True)
            rnd.exchanges = [e for e in rnd.exchanges if e.divergence_id == "d2"]
            rnd.post_round_status = [RoundStatus(divergence_id="d2", status="standing")]
            rnd.changed = False
            rounds = [rnd]
            final = [RoundStatus(divergence_id="d2", status="standing")]
            standing = ["d2"]
            max_iterations = 3
        elif exit_reason == "error":
            rnd = FusionRound(
                round=1,
                exchanges=[
                    Exchange(divergence_id="d1", model=label, stance="unavailable", error="transport_error: connection reset")
                    for label in ("R1", "R2", "R3")
                ],
                post_round_status=[RoundStatus(divergence_id="d1", status="standing")],
                changed=False,
            )
            rounds = [rnd]
            final = [RoundStatus(divergence_id="d1", status="standing")]
            standing = ["d1"]
            max_iterations = 2
        else:  # pragma: no cover - guards a typo in a parametrisation
            raise AssertionError(f"unknown exit_reason {exit_reason!r}")
        turn = FusionTurn(
            of_analyze=analyze.id,
            slot_config=conv.slot_config.model_copy(deep=True),
            max_iterations=max_iterations,
            standing=standing,
            rounds=rounds,
            final=final,
            exit_reason=exit_reason,
        )
        conv.turns.append(turn)
        return turn

    return _add


@pytest.fixture
def persist():
    """Write an in-memory Conversation through the real store and return the stored document."""

    async def _persist(conv: Conversation) -> Conversation:
        from backend.store import conversations as store

        stored = await store.create(
            slot_config=conv.slot_config, title=conv.title, anon_map=conv.anon_map
        )
        for slot, msgs in conv.threads.items():
            if msgs:
                await store.append_to_thread(stored.id, slot, msgs)
        for turn in conv.turns:
            await store.append_turn(stored.id, turn)
        loaded = await store.load(stored.id)
        assert loaded is not None
        return loaded

    return _persist


# --------------------------------------------------------------------------- structural readers
_MD_HEADING_RE = re.compile(r"^(#{1,6}) (.+)$", re.MULTILINE)
_HTML_HEADING_RE = re.compile(r"<h([1-6])>(.*?)</h\1>", re.DOTALL)
_MD_TABLE_ROW_RE = re.compile(r"^\|(.+)\|\s*$", re.MULTILINE)


def md_headings(text: str) -> list[tuple[int, str]]:
    return [(len(m.group(1)), m.group(2).strip()) for m in _MD_HEADING_RE.finditer(text)]


def html_headings(text: str) -> list[tuple[int, str]]:
    """Heading TEXT, unescaped, so it compares like-for-like with `md_headings`.

    The HTML builder escapes every value, so a title holding an apostrophe, `&` or `<` reaches the
    markup as an entity (`Solomon&#x27;s Judgment`). Comparing the two renderings is a comparison of
    what a reader sees, not of the bytes; that the escaping happens at all is `test_escaping.py`.
    """
    return [(int(m.group(1)), unescape(m.group(2)).strip()) for m in _HTML_HEADING_RE.finditer(text)]


def md_tables(text: str) -> list[list[list[str]]]:
    """Every GFM pipe table as a list of rows of cells (the `---` rule row dropped)."""
    tables: list[list[list[str]]] = []
    current: list[list[str]] = []
    for line in text.splitlines():
        match = _MD_TABLE_ROW_RE.match(line)
        if match:
            cells = [c.strip() for c in match.group(1).split("|")]
            if not all(set(c) <= set("-: ") and c for c in cells):
                current.append(cells)
            continue
        if current:
            tables.append(current)
            current = []
    if current:
        tables.append(current)
    return tables


def md_fences(text: str) -> list[str]:
    """The body of every fenced block in a Markdown document."""
    out: list[str] = []
    marker: str | None = None
    buf: list[str] = []
    for line in text.splitlines():
        match = re.match(r"^\s{0,3}(`{3,}|~{3,})\s*$", line)
        if marker is None:
            opener = re.match(r"^\s{0,3}(`{3,}|~{3,})", line)
            if opener:
                marker = opener.group(1)
                buf = []
            continue
        if match and match.group(1)[0] == marker[0] and len(match.group(1)) >= len(marker):
            out.append("\n".join(buf))
            marker = None
            continue
        buf.append(line)
    return out
