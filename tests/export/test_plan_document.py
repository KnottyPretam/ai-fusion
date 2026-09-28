"""The Plan document (2026-09-27): the procedure as a table, the checklist, and never the model
string that wrote it. R-labels-free by construction (the plan model is told not to mention the
experts); `tests/export/test_anonymity.py` is the standing gate for what may not appear.
"""

from __future__ import annotations

import pytest

from backend import export
from backend.config import settings
from backend.export import Checklist, build_document, render_html_doc, render_markdown_doc
from backend.schemas import (
    Conversation,
    FusionTurn,
    Plan,
    PlanDecision,
    PlanRisk,
    PlanStep,
    PlanTurn,
    Usage,
)
from tests.export.conftest import html_headings, md_headings, md_tables

PLAN_MODEL = "anthropic/claude-opus-5.5"


def sample_plan() -> Plan:
    return Plan(
        objective="Configure the gyroscope at its widest usable range and confirm it in the register map.",
        prerequisites=["The datasheet revision that carries table 3", "Register access over SPI or I2C"],
        steps=[
            PlanStep(
                number=1,
                title="Read the range register",
                action="Read register GYRO_RANGE and note its value.",
                why="The selectable range is written there.",
                inputs=["the register address"],
                outputs=["the current value"],
                verify="The read returns a value in 0x00..0x04.",
            ),
            PlanStep(
                number=2,
                title="Select 2000 deg/s",
                action="Write 0x00 to GYRO_RANGE.",
                verify="Reading it back returns 0x00.",
            ),
        ],
        decisions=[
            PlanDecision(
                divergence_id="d1",
                topic="gyroscope full-scale range",
                options=["Treat 2000 deg/s as the maximum", "Treat 1000 deg/s as the maximum"],
                recommendation="Use 2000 deg/s.",
                rationale="The cited table and two positions agree on it.",
            ),
            PlanDecision(topic="which host to use", options=["the bench host", "the target"]),
        ],
        risks=[
            PlanRisk(
                risk="The datasheet revision may number the tables differently.",
                mitigation="Locate the table by its register name.",
            )
        ],
        done_when=["GYRO_RANGE reads back 0x00", "A known rotation is reported within tolerance"],
    )


def make_plan_turn(
    conv: Conversation,
    fusion: FusionTurn,
    *,
    status: str = "ok",
    model: str = PLAN_MODEL,
    plan: Plan | None = None,
) -> PlanTurn:
    """Append a PlanTurn for `fusion` (ok with `sample_plan()`, or degraded with raw attempts)."""
    if status == "degraded":
        turn = PlanTurn(
            of_fusion=fusion.id,
            model=model,
            slot_config=conv.slot_config.model_copy(deep=True),
            status="degraded",
            error="parse_error: no JSON object found in the response",
            raw_attempts=["Sure! Here is a plan in prose:", ""],
        )
    else:
        turn = PlanTurn(
            of_fusion=fusion.id,
            model=model,
            slot_config=conv.slot_config.model_copy(deep=True),
            plan=plan if plan is not None else sample_plan(),
        )
    turn.usage.add(
        Usage(
            model=model,
            role="analyst",
            purpose="extraction",
            prompt_tokens=2400,
            completion_tokens=650,
            cost_usd=0.0012,
            latency_ms=1234,
        )
    )
    turn.usage.set_wall_clock(1500)
    conv.turns.append(turn)
    return turn


@pytest.fixture
def planned(rich_send, add_analyze, add_fusion):
    def _mk(**kwargs):
        conv = rich_send()
        analyze = add_analyze(conv)
        fusion = add_fusion(conv, analyze)
        turn = make_plan_turn(conv, fusion, **kwargs)
        return conv, fusion, turn

    return _mk


# --------------------------------------------------------------------------- the document
def test_the_plan_document_header_and_lineage(planned):
    conv, fusion, turn = planned()
    doc = build_document(conv, turn.id)
    assert doc.kind == "plan" and export.KIND_TITLES["plan"] == "Plan"
    md = render_markdown_doc(doc)
    assert md_headings(md)[0] == (1, f"{settings().app_title} Plan — Test conversation")
    assert f"**planned fusion turn:** {fusion.id}" in md
    assert "**status:** ok" in md
    assert "**turn type:** plan" in md
    assert export.filename_for(doc, "md").startswith("triplex-plan-") and export.filename_for(doc, "md").endswith(".md")


def test_the_plan_document_holds_every_section_in_order(planned):
    conv, _, turn = planned()
    md = render_markdown_doc(build_document(conv, turn.id))
    assert [h for h in md_headings(md) if h[0] == 2] == [
        (2, "Objective"),
        (2, "Prerequisites"),
        (2, "Procedure"),
        (2, "Decision points"),
        (2, "Risks"),
        (2, "Done when"),
        (2, "Usage"),
    ]
    assert "Configure the gyroscope at its widest usable range" in md
    assert "- The datasheet revision that carries table 3" in md
    assert "- Register access over SPI or I2C" in md


def test_the_procedure_is_a_table_then_one_section_per_step(planned):
    conv, _, turn = planned()
    md = render_markdown_doc(build_document(conv, turn.id))
    (table,) = md_tables(md)
    assert table[0] == ["#", "step", "action", "verify"]
    assert table[1] == ["1", "Read the range register", "Read register GYRO_RANGE and note its value.", "The read returns a value in 0x00..0x04."]
    assert table[2][:2] == ["2", "Select 2000 deg/s"]
    steps = [h for h in md_headings(md) if h[0] == 3]
    assert steps[:2] == [(3, "1. Read the range register"), (3, "2. Select 2000 deg/s")]
    first = md[md.index("### 1. Read the range register") : md.index("### 2. Select 2000 deg/s")]
    for caption in ("*action*", "*why*", "*inputs*", "*outputs*", "*verify*"):
        assert caption in first
    assert "- the register address" in first and "- the current value" in first
    second = md[md.index("### 2. Select 2000 deg/s") : md.index("## Decision points")]
    assert "*action*" in second and "*verify*" in second
    for absent in ("*why*", "*inputs*", "*outputs*"):  # empty on step 2: skipped, never "(none)"
        assert absent not in second


def test_decision_points_name_the_divergence_when_there_is_one(planned):
    conv, _, turn = planned()
    md = render_markdown_doc(build_document(conv, turn.id))
    headings = [h for h in md_headings(md) if h[0] == 3]
    assert (3, "d1 — gyroscope full-scale range") in headings
    assert (3, "which host to use") in headings  # divergence_id None: the topic alone
    section = md[md.index("### d1 — gyroscope full-scale range") : md.index("### which host to use")]
    assert "*options*" in section and "- Treat 2000 deg/s as the maximum" in section
    assert "*recommendation*" in section and "Use 2000 deg/s." in section
    assert "*rationale*" in section and "The cited table and two positions agree on it." in section
    tail = md[md.index("### which host to use") : md.index("## Risks")]
    assert "*options*" in tail and "*recommendation*" not in tail and "*rationale*" not in tail


def test_risks_pair_each_risk_with_its_mitigation(planned):
    conv, _, turn = planned()
    md = render_markdown_doc(build_document(conv, turn.id))
    assert "- **The datasheet revision may number the tables differently.** — Locate the table by its register name." in md


def test_done_when_is_a_task_list_in_markdown_and_disabled_checkboxes_in_html(planned):
    conv, _, turn = planned()
    doc = build_document(conv, turn.id)
    assert any(isinstance(b, Checklist) for b in doc.blocks)
    md = render_markdown_doc(doc)
    done = md[md.index("## Done when") : md.index("## Usage")]
    assert "- [ ] GYRO_RANGE reads back 0x00" in done  # `_` is never escaped (intraword, CommonMark)
    assert "- [ ] A known rotation is reported within tolerance" in done
    html = render_html_doc(doc)
    assert html.count('<li><input type="checkbox" disabled> ') == 2
    assert '<ul class="checklist">' in html
    assert "GYRO_RANGE reads back 0x00</li>" in html


def test_empty_lists_say_so_instead_of_vanishing(rich_send, add_analyze, add_fusion):
    conv = rich_send()
    fusion = add_fusion(conv, add_analyze(conv))
    turn = make_plan_turn(conv, fusion, plan=Plan(objective="Nothing but an objective."))
    md = render_markdown_doc(build_document(conv, turn.id))
    assert "Nothing but an objective." in md
    for section, following in (
        ("## Prerequisites", "## Procedure"),
        ("## Decision points", "## Risks"),
        ("## Risks", "## Done when"),
        ("## Done when", "## Usage"),
    ):
        assert "(none)" in md[md.index(section) : md.index(following)]
    assert "(no steps)" in md[md.index("## Procedure") : md.index("## Decision points")]
    assert md_tables(md) == []


def test_the_document_never_prints_the_model_string(planned):
    """`PlanTurn.model` can name a vendor (the default does); it is on screen, never in a document."""
    for model in (PLAN_MODEL, "web:claude", "ollama:hermes3", "vendor-x/model-y"):
        conv, _, turn = planned(model=model)
        for fmt in ("md", "html"):
            doc = export.render_doc(build_document(conv, turn.id), fmt)
            assert model not in doc
            assert "vendor-x" not in doc and "hermes3" not in doc
            assert conv.slot_config.analyst_model not in doc


def test_a_degraded_plan_says_so_and_shows_its_attempts(planned):
    conv, fusion, turn = planned(status="degraded")
    doc = build_document(conv, turn.id)
    md, html = render_markdown_doc(doc), render_html_doc(doc)
    for text in (md, html):
        assert "Degraded" in text
        assert "did not return a usable procedure" in text
        assert "parse_error: no JSON object found in the response" in text
        assert "raw attempts (2)" in text
        assert "Sure! Here is a plan in prose:" in text
        assert "(no output)" in text
    assert "**status:** degraded" in md
    assert f"**planned fusion turn:** {fusion.id}" in md
    assert "## Objective" not in md and md_tables(md) == []
    assert "<details open>" in html


def test_both_formats_render_from_the_same_document(planned):
    conv, _, turn = planned()
    doc = build_document(conv, turn.id)
    md, html = render_markdown_doc(doc), render_html_doc(doc)
    assert [h for h in md_headings(md) if h[0] >= 2] == [h for h in html_headings(html) if h[0] >= 2]
    for needle in ("Use 2000 deg/s.", "Locate the table by its register name.", "0x00..0x04"):
        assert needle in md and needle in html
    assert "**tokens:** 2400 in / 650 out" in md and "**model calls:** 1" in md
    assert export.filename_for(doc, "html").endswith(".html")


def test_the_usage_section_never_carries_the_per_call_rows(planned):
    """The per-call rows carry `model` and `role`; only the totals reach the document."""
    conv, _, turn = planned()
    md = render_markdown_doc(build_document(conv, turn.id))
    assert "**cost:** $0.0012" in md and "**latency:** 1500 ms" in md
    assert "analyst" not in md


def test_the_checklist_block_escapes_its_items():
    html = export.render_html_doc(
        export.Document(
            kind="plan",
            turn_id="t",
            conversation_id="c",
            conversation_title="x",
            title="Plan — x",
            ts="2026-09-27T00:00:00.000Z",
            blocks=(Checklist(("a <b> & c",)),),
        )
    )
    assert "a &lt;b&gt; &amp; c" in html and "<b>" not in html.split("<h1>")[1]
    md = export.render_markdown_doc(
        export.Document(
            kind="plan",
            turn_id="t",
            conversation_id="c",
            conversation_title="x",
            title="Plan — x",
            ts="2026-09-27T00:00:00.000Z",
            blocks=(Checklist(("a [b] `c`", "line\nbreak")),),
        )
    )
    assert "- [ ] a \\[b\\] \\`c\\`" in md and "- [ ] line break" in md
