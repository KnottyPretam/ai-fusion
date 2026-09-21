"""The Refactor document (S11) and the theme every document now follows (user request, 2026-09-20).

The Refactor document is the one the user asked for: all three responses in ONE document, together
with the knowledge graph and the restated question. It is R-labels only, exactly like Analyze and
Fusion — `tests/export/test_anonymity.py` is the standing gate for that, and this file adds the
Refactor-specific assertions.
"""

from __future__ import annotations

import pytest

from backend import export
from backend.export import CSS, build_document, render_html_doc, render_markdown_doc, theme_css


@pytest.fixture
def conv(rich_send):
    return rich_send()


# --------------------------------------------------------------------------- the document
def test_the_refactor_document_holds_the_graph_the_question_and_all_three_responses(
    conv, add_refactor
):
    turn = add_refactor(conv)
    doc = build_document(conv, turn.id)
    assert doc.kind == "refactor"
    md = render_markdown_doc(doc)

    assert "Refactor" in doc.title
    assert "What is the selectable gyroscope full-scale range?" in md  # the restated question
    # the graph, both halves
    assert "inertial sensor" in md and "gyroscope range" in md
    assert "has property" in md
    # all three responses, in one document, each with its summary and claims
    for label in ("R1", "R2", "R3"):
        assert label in md
    assert "The upper range is 2000 dps" in md
    assert "The gyroscope tops out at 1000 dps" in md
    assert "Ranges run from 125 dps to 2000 dps" in md
    assert "Reads the range from the datasheet table." in md


def test_the_refactor_document_names_no_vendor(conv, add_refactor):
    turn = add_refactor(conv)
    md = render_markdown_doc(build_document(conv, turn.id))
    html = render_html_doc(build_document(conv, turn.id))
    # The send prompt and raw replies are out of scope for the leak rule (module docstring), but the
    # refactor document quotes neither: it quotes the PROMPT and the reduced claims only.
    for text in (md, html):
        for vendor in ("Claude", "ChatGPT", "Grok", "claude", "chatgpt", "grok"):
            assert vendor not in text.replace(conv.turns[0].prompt, ""), vendor


def test_a_degraded_refactor_says_so_and_shows_its_attempts(conv, add_refactor):
    turn = add_refactor(conv, status="degraded")
    md = render_markdown_doc(build_document(conv, turn.id))
    assert "Degraded" in md
    assert "falls back to comparing the responses as they were sent" in md
    assert "parse_error" in md
    assert "raw analyst attempts (2)" in md


def test_both_formats_render_from_the_same_document(conv, add_refactor):
    turn = add_refactor(conv)
    doc = build_document(conv, turn.id)
    md, html = render_markdown_doc(doc), render_html_doc(doc)
    for needle in ("2000 dps", "has property", "R3"):
        assert needle in md and needle in html
    assert export.filename_for(doc, "md").endswith(".md")
    assert export.filename_for(doc, "html").endswith(".html")


# --------------------------------------------------------------------------- the theme
def test_light_is_byte_identical_to_what_the_module_always_rendered():
    """The reason no existing document, test or golden moves: `light` is the old CSS exactly."""
    assert theme_css("light") == CSS


@pytest.mark.parametrize("value", ["light", None, "", "nonsense", "DARKISH"])
def test_an_unknown_or_absent_theme_is_light(value):
    assert export.normalise_theme(value) == "light"


@pytest.mark.parametrize(
    ("value", "expected"),
    [("dark", "dark"), ("DARK", "dark"), (" system ", "system"), ("auto", "system")],
)
def test_the_theme_names_the_app_uses_are_accepted(value, expected):
    assert export.normalise_theme(value) == expected


def test_dark_overrides_the_tokens_unconditionally(conv, add_refactor):
    turn = add_refactor(conv)
    html = render_html_doc(build_document(conv, turn.id), "dark")
    assert "#0d1117" in html  # the app's own dark background
    assert "color-scheme: dark" in html
    assert "prefers-color-scheme" not in html.split(CSS, 1)[-1]  # not behind a media query


def test_system_defers_to_the_reader(conv, add_refactor):
    turn = add_refactor(conv)
    html = render_html_doc(build_document(conv, turn.id), "system")
    tail = html.split(CSS, 1)[-1]
    assert "prefers-color-scheme: dark" in tail
    assert "#0d1117" in tail


def test_markdown_is_the_same_bytes_in_every_theme(conv, add_refactor):
    turn = add_refactor(conv)
    doc = build_document(conv, turn.id)
    renders = {t: export.render_doc(doc, "md", t) for t in ("light", "dark", "system")}
    assert len(set(renders.values())) == 1  # Markdown carries no styling


def test_every_document_kind_can_be_themed(conv, add_refactor, add_analyze, add_fusion):
    """Not just Refactor: the user asked for ALL documents to follow the app."""
    analyze = add_analyze(conv)
    turns = [conv.turns[0].id, add_refactor(conv).id, analyze.id, add_fusion(conv, analyze).id]
    for turn_id in turns:
        doc = build_document(conv, turn_id)
        light = render_html_doc(doc, "light")
        dark = render_html_doc(doc, "dark")
        assert "#0d1117" not in light
        assert "#0d1117" in dark
