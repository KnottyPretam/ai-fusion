"""Raw HTML inside a reply (user decision, 2026-10-23): rendered for an allow-list of attribute-free
formatting tags ONLY, shown as text otherwise.

There are no CommonMark HTML BLOCKS (a line starting with `<div>` or `<table>` would swallow every
line after it up to a blank line, and Markdown inside it would stop rendering); each inline tag is
matched strictly, normalised to lowercase, and kept balanced within its own inline run.
"""

from __future__ import annotations

import re
from html.parser import HTMLParser

import pytest

from backend import export
from backend.export_render import ALLOWED_TAGS, esc, inline_html, markdown_html

_VOID = {"br", "hr", "input", "img", "meta"}


class _Nesting(HTMLParser):
    """Records an error for every end tag that does not close the innermost open element."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.stack: list[str] = []
        self.errors: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag not in _VOID:
            self.stack.append(tag)

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag not in _VOID:
            self.errors.append(f"self-closing <{tag}/>")

    def handle_endtag(self, tag: str) -> None:
        if not self.stack or self.stack[-1] != tag:
            self.errors.append(f"</{tag}> closes {self.stack[-1:] or 'nothing'}")
        else:
            self.stack.pop()


def assert_well_nested(html: str) -> None:
    parser = _Nesting()
    parser.feed(html)
    parser.close()
    assert parser.errors == [] and parser.stack == [], (parser.errors, parser.stack, html)


@pytest.mark.parametrize("tag", sorted(ALLOWED_TAGS - {"br"}))
def test_every_allowed_tag_renders(tag):
    html = markdown_html(f"x <{tag}>y</{tag}> z")
    assert html == f"<p>x <{tag}>y</{tag}> z</p>\n"


@pytest.mark.parametrize(
    ("raw", "rendered"),
    [
        ("<B>a</B>", "<b>a</b>"),
        ("<Strong >a</STRONG >", "<strong>a</strong>"),
        ("H<SUB>2</SUB>O and x<sup>2</sup>", "H<sub>2</sub>O and x<sup>2</sup>"),
        ("one<br>two", "one<br>two"),
        ("one<br/>two", "one<br>two"),
        ("one<br />two", "one<br>two"),
        ("one<BR>two", "one<br>two"),
    ],
)
def test_allowed_tags_are_normalised(raw, rendered):
    assert markdown_html(raw) == f"<p>{rendered}</p>\n"


@pytest.mark.parametrize(
    "raw",
    [
        '<b class="x">t</b>',
        "<b onclick=alert(1)>t</b>",
        "<i style='color:red'>t</i>",
        "<span>t</span>",
        '<a href="https://example.org">t</a>',
        "<img src=x onerror=alert(1)>",
        "<iframe src=//example.org></iframe>",
        "<script>alert(1)</script>",
        "<style>body{display:none}</style>",
        "<math><mi>x</mi></math>",
        "<svg onload=alert(1)>",
        "<!-- a comment -->",
        "<?php echo 1; ?>",
        "<![CDATA[x]]>",
        "<!DOCTYPE html>",
        "</br>",
        "<b/>",
    ],
)
def test_anything_else_is_shown_as_text(raw):
    html = markdown_html(f"before {raw} after")
    # Every `<` the reply wrote is text: the only tags left are the paragraph's own.
    assert re.findall(r"<[a-z!?/][^>]*>", html.replace("<p>", "").replace("</p>", "")) == []
    assert esc(raw) in html or esc(raw).replace("&#x27;", "'") in html


def test_attributes_never_survive_on_an_allowed_tag():
    html = markdown_html('<b title="t">x</b> <i class=y>z</i>')
    assert html == "<p>&lt;b title=&quot;t&quot;&gt;x&lt;/b&gt; &lt;i class=y&gt;z&lt;/i&gt;</p>\n"


def test_an_unclosed_tag_is_closed_at_the_end_of_its_run():
    html = markdown_html("<b>one <i>two\n\nthree <sup>")
    assert html == "<p><b>one <i>two</i></b></p>\n<p>three <sup></sup></p>\n"


def test_a_closer_with_no_opener_is_text():
    html = markdown_html("text</b> and </i></mark> more <b>x</b></b>")
    assert html == "<p>text&lt;/b&gt; and &lt;/i&gt;&lt;/mark&gt; more <b>x</b>&lt;/b&gt;</p>\n"


@pytest.mark.parametrize(
    "raw",
    [
        "**a <i>b** c</i> d",
        "<i>a **b</i> c** d",
        "<b><i>x</b></i>",
        "[link <b>text](https://example.org) tail</b>",
        "<u>a *b <s>c* d</u> e</s>",
        "~~a <mark>b~~ c</mark>",
    ],
)
def test_tags_crossing_markdown_emphasis_stay_well_nested(raw):
    for links in (False, True):
        assert_well_nested(markdown_html(raw, links=links))


def test_a_misnested_pair_is_closed_and_reopened_not_dropped():
    assert markdown_html("**a <i>b** c</i> d") == "<p><strong>a <i>b</i></strong><i> c</i> d</p>\n"


@pytest.mark.parametrize(
    "block_line",
    ["<div>", '<div class="x">', "<table>", "<details>", "<br>", "<b>", "<pre>", "<!-- note -->"],
)
def test_a_block_level_tag_line_never_swallows_what_follows(block_line):
    """With CommonMark HTML blocks, `<div>` on a line of its own would eat the lines after it up to a
    blank line -- and the Markdown inside would not render. Here it is just text (or a tag)."""
    html = markdown_html(f"{block_line}\n**bold** after it\n# A heading\n- an item")
    assert "<strong>bold</strong>" in html
    assert '<h3 class="md-h">A heading</h3>' in html
    assert "<li>an item</li>" in html
    assert_well_nested(html)


def test_a_table_of_raw_html_is_text_and_the_markdown_table_after_it_renders():
    html = markdown_html(
        "<table><tr><td>raw</td></tr></table>\n\n| a | b |\n|---|---|\n| <b>c | d |"
    )
    assert "&lt;table&gt;&lt;tr&gt;&lt;td&gt;raw" in html
    assert "<td><b>c</b></td><td>d</td>" in html  # balanced per cell
    assert_well_nested(html)


def test_script_is_inert_everywhere(rich_send):
    conv = rich_send()
    conv.turns[0].responses["claude"] = (
        "<script>alert(1)</script>\n\n`<script>`\n\n```html\n<script>x()</script>\n```\n\n"
        "<SCRIPT SRC=//example.org/x.js></SCRIPT>\n\n$\\text{<script>}$"
    )
    html = export.render_html(conv, conv.turns[0].id)
    assert "<script" not in html.lower()
    assert html.count("&lt;script&gt;") >= 4


def test_an_allowed_tag_in_a_heading_is_balanced_inside_it():
    html = markdown_html("## A <i>title\n\nbody")
    assert html == '<h4 class="md-h">A <i>title</i></h4>\n<p>body</p>\n'


def test_cells_bullets_and_checklist_items_never_render_raw_html():
    """`inline_html` typesets formulas and nothing else: a tag in a claim is its text."""
    assert inline_html("<b>bold</b> and <br>") == "&lt;b&gt;bold&lt;/b&gt; and &lt;br&gt;"


def test_the_markdown_export_still_fences_a_reply_with_a_tag(rich_send):
    conv = rich_send()
    conv.turns[0].responses["claude"] = "Water is H<sub>2</sub>O."
    md = export.render_markdown(conv, conv.turns[0].id)
    assert "```\nWater is H<sub>2</sub>O.\n```" in md
    assert "H<sub>2</sub>O" in export.render_html(conv, conv.turns[0].id)
