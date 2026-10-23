"""The Markdown export, pinned byte for byte (2026-10-23).

The HTML export renders prose and math now; the `.md` export must not move at all.
`test_rendering.test_the_markdown_export_is_byte_for_byte_what_it_was` proves no HTML decision
(`Body.kind`, `Body.links`) reaches the Markdown, but it compares today's code with itself. This
pins ABSOLUTE bytes: the sha256 of every document of one frozen conversation -- every kind, ok and
degraded, its prose full of run-together display math, a norm, raw tags, a link and an unclosed
fence -- as the Markdown renderer produced them BEFORE the change (git HEAD 82cf2b1's
`backend/export.py`, run against this very fixture), in all three themes.

A deliberate change to the Markdown export changes these hashes: the failure prints the new ones;
replace them and say why in the change.
"""

from __future__ import annotations

import hashlib
import re
from itertools import count

import pytest

from backend import export
from backend.schemas import Conversation
from tests.export.test_plan_document import make_plan_turn

_UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
_STAMP_RE = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z")

RUN_TOGETHER = r"$$Re=\frac{\rho U L}{\mu}$$$$Fr=\frac{U}{\sqrt{g L}}$$"
PROSE = (
    r"Keep $\|\mathbf{x}-\mathbf{p}_j\| < 10^{-3}$, at about $5 and $10, with `$HOME` set."
    "\n\n<b>bold</b> H<sub>2</sub>O and [a link](https://example.org/a?b=1&c=2)"
)

PINNED = {
    "00 send ok": "e7a0c4a3994bfaf9d2026134313122913132019c63270008baccc977ad253724",
    "01 continue ok": "c02263ca4e46692955a87eb3b5c024981ab4c9a8fa93dfb1b5b99feae715f4f1",
    "02 analyze ok": "13c9c6dba72d87400174ef73286e43c44ab65cf1d544afcb4cc5e71ac03307a1",
    "03 analyze degraded": "f0a90433c55ed80560458a4980659177adaf6d7b7245166dd0b3324f807aee14",
    "04 refactor ok": "61863f0f8f64ea9715e5f89897340a071443404b520b9c1e4bf13f1fcf640d81",
    "05 refactor degraded": "ec82ac9c825e0814804818af3614d4036db8968f3c93122e5cd9892224fdce83",
    "06 fusion converged": "90f6e450cfda6edf13c187cc98e9deacf19111a521aaf73ec1f84175eb57d4b2",
    "07 fusion max_iterations": "91a5193f4ce32bad107da13f3864048c24efef8092071f7ea8cc350c35d37f4d",
    "08 fusion stalemate": "fd27bd802427981cca46c5a9d5042c01d480446a527b08f774bc55c2cc4afc42",
    "09 fusion error": "ebddca691298a41ed3b2f0c596a7f4025c5aecb3465ef039deb4ec89efd3554b",
    "10 plan ok": "247888003a8ec233a1086c7f4e60d9da934b4e60323529878e265f3e70d038da",
    "11 plan degraded": "71595eb241a20d3ea9ccf174b44429393d937eacf86ac4b94b2684f26bb042cf",
}


def _frozen(conv: Conversation) -> Conversation:
    """The same conversation with every generated id and timestamp replaced by a fixed one, in
    order of appearance (two turns made in the same millisecond must not change the bytes)."""
    raw = conv.model_dump_json()
    ids = {
        old: f"00000000-0000-4000-8000-{i:012d}"
        for i, old in enumerate(dict.fromkeys(_UUID_RE.findall(raw)))
    }
    raw = _UUID_RE.sub(lambda m: ids[m.group(0)], raw)
    stamps = count()
    raw = _STAMP_RE.sub(
        lambda m: f"2026-10-23T09:{(n := next(stamps)) // 60:02d}:{n % 60:02d}.000Z", raw
    )
    return Conversation.model_validate_json(raw)


@pytest.fixture
def frozen(monkeypatch, rich_send, add_continue, add_analyze, add_refactor, add_fusion):
    monkeypatch.setenv("APP_TITLE", "Solomon's Judgment")
    conv = rich_send()
    conv.turns[0].responses["chatgpt"] = RUN_TOGETHER + "\n\n" + PROSE
    add_continue(conv)
    analyze = add_analyze(conv)
    analyze.extraction.agreements[0].statement = r"All agree on $\pm 2000$ deg/s."
    add_analyze(conv, status="degraded")
    refactor = add_refactor(conv)
    refactor.refactoring.question = PROSE
    add_refactor(conv, status="degraded")
    fusions = [
        add_fusion(conv, analyze, exit_reason=r)
        for r in ("converged", "max_iterations", "stalemate", "error")
    ]
    fusions[0].rounds[0].exchanges[0].justification = PROSE + "\n\n```\nleft open"
    plan = make_plan_turn(conv, fusions[0])
    plan.plan.objective = PROSE
    make_plan_turn(conv, fusions[1], status="degraded")
    return _frozen(conv)


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def markdown_hashes(conv: Conversation) -> dict[str, str]:
    out = {}
    for i, turn in enumerate(conv.turns):
        doc = export.build_document(conv, turn.id)
        md = export.render_markdown_doc(doc)
        for theme in ("light", "dark", "system"):
            assert export.render_doc(doc, "md", theme) == md, (turn.type, theme)
        state = getattr(turn, "exit_reason", None) or getattr(turn, "status", "ok")
        out[f"{i:02d} {turn.type} {state}"] = _sha(md)
    return out


def test_every_markdown_document_is_byte_for_byte_as_before(frozen):
    assert markdown_hashes(frozen) == PINNED


def test_the_frozen_fixture_really_holds_prose_with_math_tags_and_links(frozen):
    md = export.render_markdown(frozen, frozen.turns[0].id)
    assert RUN_TOGETHER in md and "<sub>2</sub>" in md and "](https://example.org/" in md
