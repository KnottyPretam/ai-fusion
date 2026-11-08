"""The table of contents in the HTML export (2026-10-28) -- and so in the PDF printed from it.

Every document opens with a list of its own sections (the `Heading` blocks at levels 2 and 3, an h3
nested under the h2 before it), each a link to the heading's fragment id. The links are bare
fragments: they load nothing, so a document that may hold no URL at all (Analyze, Fusion, Refactor,
Plan) may hold them. The Markdown export carries no table of contents and does not move
(`test_markdown_pin.py`).
"""

from __future__ import annotations

import re
from html import escape, unescape

import pytest

from backend import export
from backend.export import TOC_LEVELS, Document, Heading, Meta, Para, build_document
from tests.export.conftest import doc_headings, html_headings
from tests.export.test_plan_document import make_plan_turn

_NAV_RE = re.compile(r'<nav class="toc" aria-label="Contents">(.*?)</nav>', re.S)
_ENTRY_RE = re.compile(r'<a href="#(sec-\d+)">(.*?)</a>')
_HEADING_RE = re.compile(r'<h([1-6]) id="(sec-\d+)">(.*?)</h\1>', re.S)


@pytest.fixture
def every_kind(rich_send, add_continue, add_analyze, add_refactor, add_fusion):
    """One conversation holding every document kind, ok and degraded."""
    conv = rich_send()
    add_continue(conv)
    analyze = add_analyze(conv)
    add_analyze(conv, status="degraded")
    add_refactor(conv)
    add_refactor(conv, status="degraded")
    fusion = add_fusion(conv, analyze)
    make_plan_turn(conv, fusion)
    make_plan_turn(conv, fusion, status="degraded")
    return conv


def _toc(html: str) -> str:
    navs = _NAV_RE.findall(html)
    assert len(navs) == 1, "exactly one table of contents"
    return navs[0]


def test_every_document_lists_its_own_sections_in_order(every_kind):
    conv = every_kind
    for turn in conv.turns:
        doc = build_document(conv, turn.id)
        html = export.render_html_doc(doc)
        entries = [(anchor, unescape(text)) for anchor, text in _ENTRY_RE.findall(_toc(html))]
        headings = {
            anchor: (int(level), unescape(text))
            for level, anchor, text in _HEADING_RE.findall(html)
        }
        # Each entry names a heading the document really carries, with that heading's text.
        assert [headings[a][1] for a, _ in entries] == [t for _, t in entries], turn.type
        # ...and the entries ARE the document's sections and subsections, in document order.
        wanted = [(lvl, text) for lvl, text in doc_headings(doc)[1:] if lvl in TOC_LEVELS]
        assert [headings[a] for a, _ in entries] == wanted, turn.type


def test_every_heading_has_a_unique_id_and_the_outline_is_unchanged(every_kind):
    conv = every_kind
    for turn in conv.turns:
        doc = build_document(conv, turn.id)
        html = export.render_html_doc(doc)
        ids = [anchor for _, anchor, _ in _HEADING_RE.findall(html)]
        assert len(ids) == len(set(ids)), turn.type
        # Every document heading (h4 and those inside an open <details> included) carries one; the
        # title does not, and nothing in the TOC is itself a heading.
        assert len(ids) == len(doc_headings(doc)) - 1, turn.type
        assert html_headings(html) == doc_headings(doc), turn.type


def test_a_subsection_nests_under_its_section(rich_send, add_analyze):
    conv = rich_send()
    analyze = add_analyze(conv)
    toc = _toc(export.render_html(conv, analyze.id))
    # "Divergences" (h2) holds one h3 per divergence: an <ol> inside its <li>.
    divergences = re.search(
        r'<li><a href="#sec-\d+">Divergences</a>\n<ol>\n(.*?)</ol>\n</li>', toc, re.S
    )
    assert divergences, toc
    nested = _ENTRY_RE.findall(divergences.group(1))
    assert [unescape(t) for _, t in nested] == [
        f"{d.id} — {d.topic}" for d in analyze.extraction.divergences
    ]


def test_the_toc_sits_before_the_first_section(every_kind):
    conv = every_kind
    for turn in conv.turns:
        html = export.render_html(conv, turn.id)
        nav = html.index('<nav class="toc"')
        first = _HEADING_RE.search(html)
        assert html.index("<h1>") < nav < first.start(), turn.type
        # The metadata line opens the document, above the contents.
        assert html.index('<p class="meta">') < nav, turn.type


def test_heading_text_is_escaped_in_the_toc(rich_send, add_analyze):
    conv = rich_send()
    analyze = add_analyze(conv)
    hostile = '<script>alert("x")</script> & <a href="https://e.org">y</a>'
    analyze.extraction.divergences[0].topic = hostile
    html = export.render_html(conv, analyze.id)
    toc = _toc(html)
    assert "<script" not in toc and 'href="https://' not in toc
    assert escape(hostile) in toc


def test_no_toc_for_fewer_than_two_entries():
    doc = Document(
        kind="send",
        turn_id="t",
        conversation_id="c",
        conversation_title="x",
        title="x",
        ts="",
        blocks=(Meta((("a", "b"),)), Heading("Only", 2), Para("text"), Heading("deep", 4)),
    )
    html = export.render_html_doc(doc)
    assert '<nav class="toc"' not in html and "href=" not in html
    assert '<h2 id="sec-1">Only</h2>' in html and '<h4 id="sec-2">deep</h4>' in html


def test_the_markdown_has_no_toc(every_kind):
    conv = every_kind
    for turn in conv.turns:
        md = export.render_markdown(conv, turn.id)
        assert "sec-" not in md and "Contents" not in md, turn.type
