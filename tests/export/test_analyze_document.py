"""Structure of an Analyze export: the Send it analysed, the agreements with the pane's caption,
the divergences as tables, and the degraded path with its raw attempts."""

from __future__ import annotations

import pytest

from backend import export
from tests.export.conftest import (
    AGREEMENTS,
    DIVERGENCES,
    html_headings,
    md_fences,
    md_headings,
    md_tables,
)


@pytest.fixture
def conv(rich_send):
    return rich_send()


def test_analyze_markdown_names_the_send_and_quotes_its_prompt(conv, add_analyze):
    send = conv.turns[0]
    turn = add_analyze(conv)
    text = export.render_markdown(conv, turn.id)
    assert md_headings(text)[0] == (1, "Triplex Analyze — Test conversation")
    assert f"**analysed send turn:** {send.id}" in text
    assert "## The Send that was analysed" in text
    assert f"**send turn:** {send.id}" in text
    assert send.prompt in text
    assert "**status:** ok" in text
    assert f"**materiality threshold:** {turn.slot_config.materiality_min}" in text


def test_analyze_markdown_agreements_carry_the_caption_and_the_labels(conv, add_analyze):
    turn = add_analyze(conv)
    text = export.render_markdown(conv, turn.id)
    agreements = text[text.index("## Agreements") : text.index("## Divergences")]
    assert "*convergence, not verified truth*" in agreements
    for agreement in AGREEMENTS:
        assert agreement.topic in agreements
        assert agreement.statement in agreements
        assert "[" + ", ".join(agreement.models) + "]" in agreements


def test_analyze_markdown_divergence_tables(conv, add_analyze):
    turn = add_analyze(conv)
    text = export.render_markdown(conv, turn.id)
    tables = md_tables(text)
    overview = tables[0]
    assert overview[0] == ["id", "topic", "materiality", "fused"]
    assert [row[0] for row in overview[1:]] == ["d1", "d2", "d3"]
    # materiality_min is "medium", so the low-materiality divergence is not fused.
    assert dict(zip([r[0] for r in overview[1:]], [r[3] for r in overview[1:]], strict=True)) == {
        "d1": "yes",
        "d2": "yes",
        "d3": "no",
    }
    assert 'rows below materiality "medium" are not fused' in text
    # One positions table per divergence, in R1/R2/R3 order, claim + evidence_cited per label.
    per_divergence = tables[1:]
    assert len(per_divergence) == len(DIVERGENCES)
    for divergence, table in zip(DIVERGENCES, per_divergence, strict=True):
        assert table[0] == ["model", "claim", "evidence cited"]
        assert [row[0] for row in table[1:]] == [p.model for p in divergence.positions]
        for position, row in zip(divergence.positions, table[1:], strict=True):
            assert position.claim in row[1]
            assert row[2] == (position.evidence_cited or "(none given)")
        assert f"### {divergence.id} — {divergence.topic}" in text
        assert f"**materiality:** {divergence.materiality}" in text


def test_analyze_html_mirrors_the_markdown_sections(conv, add_analyze):
    turn = add_analyze(conv)
    html = export.render_html(conv, turn.id)
    md = export.render_markdown(conv, turn.id)
    assert [t for _, t in html_headings(html)] == [t for _, t in md_headings(md)]
    assert '<meta name="triplex-export-type" content="analyze">' in html
    assert "convergence, not verified truth" in html
    # Every divergence table is a real HTML table inside an overflow wrapper.
    assert html.count('<div class="table-wrap">') == 1 + len(DIVERGENCES)
    assert "<th>evidence cited</th>" in html


def test_degraded_analyze_shows_the_error_and_the_raw_attempts(conv, add_analyze):
    turn = add_analyze(conv, status="degraded")
    text = export.render_markdown(conv, turn.id)
    html = export.render_html(conv, turn.id)
    assert "**status:** degraded" in text
    assert "## Degraded" in text
    assert "Fusion is disabled for it" in text
    assert turn.error in text
    assert "raw analyst attempts (2)" in text
    for i, attempt in enumerate(turn.raw_attempts, start=1):
        assert f"#### attempt {i}" in text
        assert attempt in text
    # No report sections at all: there is no extraction to report.
    assert "## Agreements" not in text and "## Divergences" not in text
    # The HTML keeps the attempts visible in a print (<details open>), monospaced and escaped.
    assert "<details open>" in html
    assert "<summary>raw analyst attempts (2)</summary>" in html
    assert '<pre class="code">' in html


def test_degraded_analyze_raw_attempts_are_always_fenced(conv, add_analyze):
    """A raw attempt is model output: it is never read as document structure, and an attempt that
    holds its own unclosed fence gets a longer one around it."""
    turn = add_analyze(conv, status="degraded")
    turn.raw_attempts = ['```json\n{"agreements": []}', "# not a heading"]
    text = export.render_markdown(conv, turn.id)
    fenced = md_fences(text)
    assert any(block.strip() == "# not a heading" for block in fenced)
    assert any('{"agreements": []}' in block for block in fenced)
    # The wrapping fence outgrows the backtick run inside the attempt.
    assert "````\n```json" in text


def test_analyze_whose_send_turn_is_gone_still_renders(conv, add_analyze):
    turn = add_analyze(conv, of_turn="00000000-0000-4000-8000-000000000000")
    for text in (export.render_markdown(conv, turn.id), export.render_html(conv, turn.id)):
        assert "no longer part of this conversation" in text
        assert "d1" in text  # the report itself is unaffected
