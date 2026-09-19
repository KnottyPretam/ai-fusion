"""Hostile model text is inert in both formats, and the HTML document fetches nothing.

The HTML is opened from a file path and printed to PDF, so it must be inert AND self-contained:
every interpolated value escaped, no stylesheet / font / image / script reference of any kind, and
no absolute URL other than the citation anchors in the body.
"""

from __future__ import annotations

import re
from html import unescape

import pytest

from backend import export
from tests.export.conftest import md_fences

HOSTILE_REPLY = (
    'Try <script>alert("x & y")</script> and <img src=x onerror=alert(1)>.\n'
    "Fenced code: `inline` and a & b, \"double\" and 'single' quotes.\n"
    "<style>body{display:none}</style>"
)
# A reply that already holds a fence AND hostile HTML: the wrapping fence has to outgrow it.
BACKTICK_REPLY = "```\n<script>alert(1)</script>\n```\nand ```` four ````"
# Not a valid escape sequence in HTML: everything below must stay an entity.
_UNESCAPED_AMP_RE = re.compile(r"&(?!amp;|lt;|gt;|quot;|#x27;|#39;)")


@pytest.fixture
def hostile(rich_send):
    conv = rich_send()
    conv.turns[0].responses["claude"] = HOSTILE_REPLY
    conv.turns[0].responses["chatgpt"] = BACKTICK_REPLY
    return conv


def test_html_renders_hostile_text_inert_and_readable(hostile):
    html = export.render_html(hostile, hostile.turns[0].id)
    # Nothing executable survives: no tag from the reply is a tag in the document.
    assert "<script" not in html.lower()
    # The ONLY <img> in the document is the brand mark in the running header; the `<img src=x
    # onerror=...>` in the reply is text, not a tag.
    lowered_html = html.lower()
    assert lowered_html.count("<img") == 1
    assert '<header class="brand"><img src="data:image/png;base64,' in lowered_html
    assert "<img src=x" not in lowered_html
    assert "<style>body" not in html.lower()
    assert "onerror" in html  # as text, inside the escaped body
    # Every ampersand is an entity, and the quotes are escaped.
    assert "&amp;" in html
    assert _UNESCAPED_AMP_RE.search(html) is None
    assert "&quot;" in html and "&#x27;" in html
    # Readable: unescaping the document gives the reply back verbatim.
    assert HOSTILE_REPLY in unescape(html)


def test_markdown_fences_a_reply_that_carries_raw_html(hostile):
    text = export.render_markdown(hostile, hostile.turns[0].id)
    fenced = md_fences(text)
    assert HOSTILE_REPLY in fenced  # the whole reply, verbatim, inside one fence
    # The raw tag never appears outside that fence: everything before the first fence is the
    # Triplex-authored frame.
    head = text[: text.index("```")]
    assert "<script" not in head and "<style" not in head
    # The document structure after the reply is intact (the fence was closed).
    assert "\n## ChatGPT" in text


def test_markdown_fence_outgrows_the_backticks_inside_the_reply(hostile):
    text = export.render_markdown(hostile, hostile.turns[0].id)
    section = text[text.index("## ChatGPT") :]
    opener = re.search(r"^(`{3,})$", section, re.MULTILINE)
    assert opener is not None
    fence = opener.group(1)
    assert len(fence) > 4  # the reply holds a ```` run, so the wrapper is longer
    assert BACKTICK_REPLY in md_fences(section)
    # ... and the heading after it is still a heading.
    assert BACKTICK_REPLY in md_fences(text)


def test_inline_values_are_escaped_in_a_markdown_table(rich_send, add_analyze):
    """A claim lands in a GFM table cell: a pipe or a raw tag there must not break the table."""
    conv = rich_send()
    analyze = add_analyze(conv)
    analyze.extraction.divergences[0].positions[0].claim = "a | b <script>x</script> *bold*"
    text = export.render_markdown(conv, analyze.id)
    row = next(line for line in text.splitlines() if line.startswith("| R1 |"))
    # Four UNESCAPED pipes = three cells: the value did not add a column.
    assert len(re.findall(r"(?<!\\)\|", row)) == 4
    assert r"\|" in row and r"\<script\>" in row and r"\*bold\*" in row


def test_html_references_no_external_resource(rich_send, add_analyze, add_fusion):
    conv = rich_send()
    analyze = add_analyze(conv)
    fusion = add_fusion(conv, analyze)
    for turn_id in (conv.turns[0].id, analyze.id, fusion.id):
        html = export.render_html(conv, turn_id)
        lowered = html.lower()
        assert "<link" not in lowered
        assert "<script" not in lowered
        assert "@import" not in lowered
        assert "url(" not in lowered  # no CSS-loaded font or image
        # An embedded `data:` image is not a reference, it IS the document; anything else under
        # `src=` would be a fetch at open time. Strip the data URIs, then require none left.
        assert "src=" not in re.sub(r'src="data:image/[a-z+.-]+;base64,[a-z0-9+/=]+"', "", lowered)
        # The stylesheet is embedded, once.
        assert lowered.count("<style>") == 1
        # Every attribute URL is a citation anchor on an http(s) scheme, or the embedded logo.
        attrs = re.findall(r'(?:href|src|action|data|poster)\s*=\s*"([^"]*)"', html)
        for value in attrs:
            assert value.startswith("https://www.bosch-sensortec.com") or value.startswith("data:image/png;base64,"), value[:60]
        anchors = re.findall(r"<a [^>]*>", html)
        for anchor in anchors:
            assert anchor.startswith('<a href="https://')
            assert 'rel="noreferrer noopener"' in anchor
        # An Analyze / Fusion document cites nothing at all.
        if turn_id != conv.turns[0].id:
            cited = [a for a in attrs if not a.startswith("data:image/png;base64,")]
            assert not cited and not anchors, "the embedded logo is not a citation"
            assert "http://" not in lowered and "https://" not in lowered
