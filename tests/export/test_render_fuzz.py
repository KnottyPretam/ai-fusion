"""Fuzz the export renderer (2026-10-23): whatever a model writes, the HTML that comes out uses only
the tags and attributes this module allows, every anchor passes `safe_href`, every tag is closed,
and no entity but the five `html.escape` makes appears.

The inputs are glued from the fragments that matter -- Markdown syntax, raw tags, TeX commands,
delimiters, URLs -- plus a little random text, so hypothesis explores the interactions.
"""

from __future__ import annotations

import re
from html import unescape
from html.parser import HTMLParser

from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from backend import export
from backend.export_render import (
    ALLOWED_TAGS,
    esc,
    inline_html,
    markdown_html,
    math_html,
    safe_href,
)
from tests.export.test_inline_tags import assert_well_nested
from tests.export.test_render_hardening import assert_cannot_paint_outside_its_box

FRAGMENTS = [
    "$", "$$", "\\(", "\\)", "\\[", "\\]", "\\", "\\\\", "_", "*", "**", "~~", "`", "```", "\n",
    "\n\n", "|", "\\|", "| a | b |\n|---|:-:|\n", "# ", "### ", "- ", "1. ", "> ", "- [ ] ", "    ",
    "[x](", ")", "](", "https://example.org/a?b=1&c=2", "javascript:alert(1)", "mailto:a@b.c",
    "<https://example.net>", "![alt](https://example.org/i.png)", "<b>", "</b>", "<i>", "</i>",
    "<br/>", "<sub>", "</sup>", "<B CLASS=x>", "<script>", "</script>", "<img src=x onerror=f()>",
    "<div>", "<table>", "<!--", "-->", "&", "&amp;", "&#x41;", "&nbsp;", "'", '"', "<", ">",
    "\\frac{a}{b}", "\\mathbf{x}", "\\mathbb{R}", "\\text{<b>&</b>}", "\\href{javascript:x}{y}",
    "\\color{red}", "\\colorbox{red}{x}", "\\hspace{999em}", "\\class{brand}{x}", "\\style{x}{y}",
    "\\begin{aligned}", "\\end{aligned}", "\\begin{gather}", "&=", "\\\\[2pt]", "{", "}", "^", "_i",
    "\\boxed{x}", "\\unicode{x3C}", "\\def\\a{b}", "x", "y", " ", "5", "10.02",
    "\\raise{3em}{", "\\lower{2em}{", "\\smash{", "\\rlap{", "\\kern-3em", "\\!", "\\mkern{-54mu}",
    "\\hspace{-9em}", "\\not", "\\vphantom{", "-", "\\pm", "/", "$HOME/", "`$x`",
]  # fmt: skip
texts = st.lists(st.sampled_from(FRAGMENTS) | st.text(max_size=4), max_size=30).map("".join)

_MATHML = {
    "math", "semantics", "annotation", "mrow", "mi", "mn", "mo", "ms", "mtext", "mspace", "msub",
    "msup", "msubsup", "munder", "mover", "munderover", "mmultiscripts", "mprescripts", "none",
    "mfrac", "msqrt", "mroot", "mstyle", "merror", "mpadded", "mphantom", "mtable", "mtr", "mtd",
}  # fmt: skip
_HTML = {
    "p", "h3", "h4", "h5", "h6", "ul", "ol", "li", "input", "blockquote", "hr", "pre", "code", "div",
    "table", "thead", "tbody", "tr", "th", "td", "br", "em", "strong", "s", "a",
}  # fmt: skip
_CLASSES = {
    "md-h", "md-tasks", "md-task", "md-code", "tex", "math-block", "md-table", "al-l", "al-c",
    "al-r", "ma-l", "ma-r", "ma-c", "mt-align", "mv-b", "mv-i", "mv-bi", "mv-tt", "mv-sf", "me-box",
    "me-up", "me-down", "me-h",
}  # fmt: skip
_LENGTH = re.compile(r"^(-?\d+(\.\d+)?(em|ex|px|pt|mm|cm|in)|0)$")
_BOOL = {"true", "false"}
_MATH_ATTRS = {
    "display": {"block"}.__contains__,
    "encoding": {"application/x-tex"}.__contains__,
    "displaystyle": _BOOL.__contains__,
    "scriptlevel": lambda v: re.fullmatch(r"[+-]?[0-7]", v) is not None,
    "mathvariant": {"normal"}.__contains__,
    "form": {"prefix", "infix", "postfix"}.__contains__,
    **{
        a: _BOOL.__contains__
        for a in (
            "fence",
            "separator",
            "stretchy",
            "symmetric",
            "largeop",
            "movablelimits",
            "accent",
            "accentunder",
        )
    },
    **{
        a: lambda v: _LENGTH.match(v) is not None
        for a in (
            "lspace",
            "rspace",
            "minsize",
            "maxsize",
            "width",
            "height",
            "depth",
            "voffset",
            "linethickness",
        )
    },
}
_UNESCAPED_AMP_RE = re.compile(r"&(?!amp;|lt;|gt;|quot;|#x27;)")


class _Audit(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.problems: list[str] = []
        self.anchors: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag not in _HTML | _MATHML | ALLOWED_TAGS:
            self.problems.append(f"tag <{tag}>")
        for name, value in attrs:
            value = value or ""
            if name == "class":
                if not set(value.split()) <= _CLASSES:
                    self.problems.append(f"class {value!r}")
            elif tag == "a" and name in ("href", "target", "rel"):
                if name == "href":
                    self.anchors.append(value)
                    if safe_href(value, mailto=True) != value:
                        self.problems.append(f"href {value!r}")
                elif (name, value) not in (("target", "_blank"), ("rel", "noreferrer noopener")):
                    self.problems.append(f"{name}={value!r}")
            elif tag == "ol" and name == "start":
                if not value.isdigit():
                    self.problems.append(f"start={value!r}")
            elif tag == "input" and name in ("type", "disabled", "checked"):
                if name == "type" and value != "checkbox":
                    self.problems.append(f"type={value!r}")
            elif tag in _MATHML and name in _MATH_ATTRS:
                if not _MATH_ATTRS[name](value):
                    self.problems.append(f"{tag} {name}={value!r}")
            else:
                self.problems.append(f"<{tag} {name}>")


def _audit(html: str) -> _Audit:
    audit = _Audit()
    audit.feed(html)
    audit.close()
    return audit


FUZZ = settings(max_examples=300, deadline=None, suppress_health_check=[HealthCheck.too_slow])


@FUZZ
@given(text=texts)
def test_rendered_markdown_uses_only_allowed_tags_and_attributes(text):
    for links in (False, True):
        html = markdown_html(text, links=links)
        audit = _audit(html)
        assert audit.problems == [], (audit.problems, text, html)
        assert _UNESCAPED_AMP_RE.search(html) is None, (text, html)
        if not links:
            assert audit.anchors == [] and "<a " not in html
        assert_well_nested(html)
        for formula in re.findall(r"<math.*?</math>", html, re.S):
            assert_cannot_paint_outside_its_box(formula)


@FUZZ
@given(tex=texts)
def test_math_is_mathml_core_or_escaped_source(tex):
    for display in (False, True):
        html = math_html(tex, display)
        if html.startswith('<code class="tex">'):
            assert html == f'<code class="tex">{esc(tex.strip())}</code>'
            continue
        assert html.startswith("<math") and html.endswith("</annotation></semantics></math>")
        assert (
            unescape(
                re.search(
                    r'<annotation encoding="application/x-tex">(.*)</annotation>', html, re.S
                ).group(1)
            )
            == tex.strip()
        )
        audit = _audit(html)
        assert audit.problems == [], (audit.problems, tex, html)
        assert _UNESCAPED_AMP_RE.search(html) is None
        assert "xmlns" not in html
        assert_well_nested(html)
        assert_cannot_paint_outside_its_box(html)


@FUZZ
@given(value=texts)
def test_a_cell_without_a_formula_is_byte_for_byte_its_escaped_text(value):
    html = inline_html(value)
    if "<math" not in html and '<code class="tex">' not in html:
        assert html == esc(value)
    assert _audit(html).problems == []


@FUZZ
@given(value=texts)
def test_prose_and_body_take_the_same_markdown_fence_decision(value):
    """The Markdown export reads `text` and `code` only: `prose()` must decide both exactly as the
    `body()` every quoted text went through before, so no `.md` byte can move."""
    rendered, plain = export.prose(value), export.body(value)
    assert (rendered.text, rendered.code) == (plain.text, plain.code)
    assert export._md_block(rendered) == export._md_block(plain)
