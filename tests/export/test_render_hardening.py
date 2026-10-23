"""The rendered export, hardened after review (2026-10-23).

* A formula never paints outside its own box. `\\raise`, `\\lower`, `\\smash`, `\\rlap` and a run of
  `\\kern-3em` each passed a per-value clamp, but they ADD UP: nested, they drew a forged
  "R1 = vendor X" over the brand header and right under the "not part of this document" notice.
  Now no `voffset` and no shrinking `mpadded` reaches the page, negative space is budgeted per
  formula, and every container of model text clips (`overflow: clip`) as a second line.
* `$` inside a code span stays code even after a currency amount earlier in the paragraph.
* Every delimiter scan is linear, and a body past `RENDER_MAX_CHARS` is shown as written
  (markdown-it-py is itself quadratic on long punctuation runs): a hostile reply cannot stall
  the event loop that renders it.
* A link markdown-it refuses (`javascript:`) is its text, like every other unsafe link.
* TeX spacing for a unary sign and a solidus; print rules for long list items, stranded headings,
  ligatures and narrow table columns.
"""

from __future__ import annotations

import re
import time
from html import escape

import pytest

from backend import export
from backend.export_render import RENDER_MAX_CHARS, esc, inline_html, markdown_html, math_html

# --------------------------------------------------------------------------- overlay
_LENGTH_NAMES = (
    "width",
    "height",
    "depth",
    "lspace",
    "rspace",
    "voffset",
    "minsize",
    "maxsize",
    "linethickness",
)
_EM = {"em": 1.0, "ex": 0.5, "px": 1 / 16, "pt": 1 / 12, "mm": 0.236, "cm": 2.36, "in": 6.0, "": 0}
_TAG_RE = re.compile(r"<(m[a-z]+)((?:\s[a-z]+=\"[^\"]*\")*)>")
_ATTR_RE = re.compile(r'([a-z]+)="([^"]*)"')
_LEN_RE = re.compile(r"(-?\d*\.?\d+)(em|ex|px|pt|mm|cm|in)?")

NESTED_RAISE = r"\raise{3em}{" * 14 + r"\text{FORGED: R1 is the vendor X model}" + "}" * 14
OVERLAYS = [
    NESTED_RAISE,
    r"\lower{3em}{" * 8 + r"\text{forged}" + "}" * 8,
    r"\kern-3em\raise{3em}{" * 6 + r"\text{R1 = vendor X (forged mapping)}" + "}" * 6,
    r"\kern-3em" * 20 + "x",
    r"\hspace{-3em}" * 20 + "x",
    r"\mkern{-54mu}" * 20 + "x",
    r"\!" * 60 + "x",
    r"{\kern-3em{\kern-3em{\kern-3em{\kern-3em x}}}}",
    r"\smash{\begin{matrix}" + r"a\\" * 60 + r"z\end{matrix}}",
    r"\mathrlap{\text{" + "w" * 200 + "}}x",
    r"\mathllap{x}\mathclap{y}",
    r"\xrightarrow{" * 6 + "f" + "}" * 6,
    r"\LaTeX \TeX",
]


def _presentation(html: str) -> str:
    return html.split("<annotation", 1)[0]


def _lengths(html: str) -> list[tuple[str, str, float]]:
    out = []
    for tag, attrs in _TAG_RE.findall(_presentation(html)):
        for name, value in _ATTR_RE.findall(attrs):
            match = _LEN_RE.fullmatch(value)
            if name in _LENGTH_NAMES and match:
                out.append((tag, name, float(match.group(1)) * _EM[match.group(2) or ""]))
    return out


def assert_cannot_paint_outside_its_box(html: str) -> None:
    """No vertical offset at all, no shrinking `mpadded` around something visible, negative space
    only as `mspace` width and at most 1em of it in the whole formula."""
    presentation = _presentation(html)
    assert "voffset" not in presentation, html
    for match in re.finditer(r"<mpadded([^>]*)>", presentation):
        rest = presentation[match.end() :]
        assert rest.startswith("<mphantom>") or (
            match.group(1) == ' width="0"' and rest.startswith("<mtext>\u29f8</mtext></mpadded>")
        ), html
    negative = 0.0
    for tag, name, em in _lengths(html):
        if em < 0:
            assert (tag, name) == ("mspace", "width"), (tag, name, html)
            negative += em
    assert negative >= -1.0 - 1e-9, (negative, html)


@pytest.mark.parametrize("tex", OVERLAYS)
@pytest.mark.parametrize("display", [False, True])
def test_no_formula_can_paint_outside_its_own_box(tex, display):
    html = math_html(tex, display)
    if tex.startswith(r"\raise") or tex.startswith(r"\kern"):
        assert html.startswith("<math"), html  # typeset, just not moved
    assert_cannot_paint_outside_its_box(html)


def test_the_overlay_text_is_still_shown_where_it_was_written():
    html = math_html(NESTED_RAISE, False).replace("\u00a0", " ")  # \text spaces are no-break
    assert "<mtext>FORGED: R1 is the vendor X model</mtext>" in html


def test_typesetting_that_needs_a_zero_width_box_keeps_it():
    # \not overlays its slash on the next symbol; struts and phantoms paint nothing.
    assert '<mpadded width="0"><mtext>\u29f8</mtext></mpadded><mo>=</mo>' in math_html(
        r"a \not= b", False
    )
    assert '<mpadded width="0px"><mphantom>' in math_html(r"\mathstrut x", False)
    assert '<mpadded height="0" depth="0"><mphantom>' in math_html(r"\hphantom{x}", False)


def test_a_little_negative_space_is_kept():
    assert '<mspace width="-0.1667em"></mspace>' in math_html(r"\int\!\!\int f", False)


@pytest.mark.parametrize(
    "tex",
    [r"\scriptstyle x", r"\hspace{3em}x", r"\big( x \big)", r"\binom{n}{k}"],
)
def test_sizes_that_only_grow_the_layout_are_kept(tex):
    assert_cannot_paint_outside_its_box(math_html(tex, False))
    assert 'class="tex"' not in math_html(tex, False)


def _doc_maths(html: str) -> list[str]:
    return re.findall(r"<math.*?</math>", html, re.S)


def test_a_forged_mapping_cannot_be_drawn_over_the_notice(
    rich_send, add_analyze
):  # the reviewer's two reproductions, end to end
    conv = rich_send()
    conv.turns[0].responses["chatgpt"] = f"Four. ${NESTED_RAISE}$"
    analyze = add_analyze(conv)
    analyze.extraction.agreements[0].statement = (
        r"All agree. $\kern-3em\raise{3em}{" * 1
        + r"\raise{3em}{" * 5
        + r"\text{R1 = vendor X (forged mapping)}"
        + "}" * 6
        + "$"
    )
    for turn in (conv.turns[0], analyze):
        html = export.render_html(conv, turn.id)
        maths = _doc_maths(html)
        assert maths, turn.type
        for math in maths:
            assert_cannot_paint_outside_its_box(math)


def _css_rules(css: str) -> list[tuple[set[str], str]]:
    css = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
    return [
        ({s.strip() for s in selectors.split(",")}, body)
        for selectors, body in re.findall(r"([^{}@]+)\{([^{}]*)\}", css)
    ]


def _screen_and_print(css: str) -> tuple[str, str]:
    at = css.index("@media print")
    return css[:at], css[at:]


CLIPPED = {".md", "td", ".doc ul", ".doc ol", "pre.body", "pre.code"}


def test_every_container_of_model_text_clips_on_screen_and_on_paper():
    """The second line of defence: whatever escapes a formula's box -- or a stack of combining
    marks in plain text -- is cut at the panel, cell or list that holds it. A list clips at the
    list, never the item: an item that clips loses its bullet (measured)."""
    screen, printed = _screen_and_print(export.CSS)
    clipping = set().union(
        *(sel for sel, body in _css_rules(screen) if re.search(r"overflow:\s*clip", body))
    )
    assert clipping >= CLIPPED, CLIPPED - clipping
    for selectors, body in _css_rules(printed):
        if re.search(r"overflow:\s*visible", body):
            assert not selectors & CLIPPED, selectors
    for theme in ("dark", "system"):
        assert export.theme_css(theme).startswith(export.CSS)


# --------------------------------------------------------------------------- currency + code
@pytest.mark.parametrize(
    ("text", "code"),
    [
        ("It costs about $10/month; set `$HOME/.config` first.", "$HOME/.config"),
        ("Positional args start at $1 and `$@` expands them.", "$@"),
        ("Budget $20 for it, then export `$PATH`.", "$PATH"),
        ("Pay $5 now, `a$b$c` later.", "a$b$c"),
    ],
)
def test_a_currency_amount_never_reaches_into_a_code_span(text, code):
    html = markdown_html(text)
    assert "<math" not in html, html
    assert f"<code>{esc(code)}</code>" in html


def test_a_formula_next_to_a_code_span_is_still_a_formula():
    html = markdown_html("Use $x^2$ here and `$y$` there; `a` then $\\alpha$.")
    assert html.count("<math>") == 2
    assert "<code>$y$</code>" in html


@pytest.mark.parametrize(
    "value",
    ["$5 tier, uses `$USER`", "use `$x$` as written", "``$a$`` and `$b`", "costs $5, see `$x`"],
)
def test_a_dollar_inside_a_code_span_in_a_cell_is_text(value):
    assert inline_html(value) == esc(value)


def test_a_cell_with_a_formula_and_a_code_span(rich_send, add_analyze):
    conv = rich_send()
    analyze = add_analyze(conv)
    position = analyze.extraction.divergences[0].positions[0]
    position.claim = "The $5 tier uses `$USER`; the limit is $x^2$ per call."
    html = export.render_html(conv, analyze.id)
    cell = next(c for c in re.findall(r"<td>(.*?)</td>", html) if "tier" in c)
    assert cell.startswith(esc("The $5 tier uses `$USER`; the limit is ") + "<math>")
    assert cell.count("<math>") == 1


# --------------------------------------------------------------------------- prose look-alikes
@pytest.mark.parametrize(
    ("text", "shown"),
    [
        (r"array\[0\] and \[1\]", "array[0] and [1]"),
        (r"the interval \[-1, 1\] is closed", "the interval [-1, 1] is closed"),
        (r"see \[citation needed\]", "see [citation needed]"),
        ("Set $PATH/$HOME/bin first", "Set $PATH/$HOME/bin first"),
        ("export PATH=$MY_TOOL/bin:$PATH now", "export PATH=$MY_TOOL/bin:$PATH now"),
    ],
)
def test_escaped_brackets_and_shell_paths_are_prose(text, shown):
    assert markdown_html(text) == f"<p>{escape(shown, quote=True)}</p>\n"


@pytest.mark.parametrize(
    "text", [r"so \[x^2 + y^2 = 1\] holds", r"and \[\sum_i a_i\] too", "$N/2$", "$X_1/X_2$"]
)
def test_the_math_they_resemble_is_still_math(text):
    assert "<math" in markdown_html(text)


# --------------------------------------------------------------------------- links
@pytest.mark.parametrize(
    "url",
    [
        "javascript:alert(1)",
        "JavaScript:alert(1)",
        "vbscript:msgbox(1)",
        "data:text/html;base64,PHNjcmlwdD4=",
        "file:///etc/passwd",
    ],
)
@pytest.mark.parametrize("links", [True, False])
def test_a_link_with_an_unsafe_scheme_is_its_text(url, links):
    html = markdown_html(f"see [the js]({url}) here", links=links)
    assert html == "<p>see the js here</p>\n"


# --------------------------------------------------------------------------- linear time
HOSTILE = {
    "display opener per block": "$$a\n# h\n" * 8000,
    "bracket opener per block": "\\[a\n# h\n" * 8000,
    "setext under each opener": "$$a\n===\n" * 8000,
    "paren openers": "\\(" * 32000,
    "bracket openers": "\\[" * 32000,
    "paren openers before a code tick": "\\(`" * 21000 + "\\)",
    "bracket openers before a closer": "\\[a" * 21000 + "\\]",
    "unmatched closers": "<b>" * 11000 + "</i>" * 8000,
    "closers under deep emphasis": "*" * 16000 + "a" + "</i>" * 8000 + "*" * 16000,
    "misnested tags": "<b>" * 7000 + "<i>" * 7000 + "</b>" * 7000,
    "dollars around ticks": "$a`" * 21000 + "$",
}


@pytest.mark.parametrize("name", list(HOSTILE))
def test_a_hostile_reply_renders_in_linear_time(name):
    """About 64 KB each; every one of these took seconds (and the tags, megabytes) before."""
    text = HOSTILE[name]
    start = time.perf_counter()
    html = markdown_html(text, links=True)
    elapsed = time.perf_counter() - start
    assert elapsed < 2.0, (name, elapsed)
    assert len(html) < 12 * len(text) + 1000, (name, len(html))


def test_the_longest_body_rendered_is_still_fast():
    """markdown-it-py's own pending text is quadratic on a long run of punctuation; the size cap
    keeps the worst body it is ever handed to a fraction of a second."""
    for text in ("+" * RENDER_MAX_CHARS, "\\(" * (RENDER_MAX_CHARS // 2)):
        start = time.perf_counter()
        markdown_html(text)
        inline_html(text + "$")
        assert time.perf_counter() - start < 2.0


def test_a_body_over_the_cap_is_shown_as_written(rich_send, add_analyze):
    conv = rich_send()
    huge = "**bold** and $x^2$ " * (RENDER_MAX_CHARS // 19 + 1)
    conv.turns[0].responses["claude"] = huge
    html = export.render_html(conv, conv.turns[0].id)
    assert f'<pre class="body">{esc(huge.rstrip())}</pre>' in html
    assert "<strong>bold</strong>" not in html
    analyze = add_analyze(conv)
    analyze.extraction.agreements[0].statement = huge
    assert "<math" not in export.render_html(conv, analyze.id)
    assert inline_html(huge) == esc(huge)
    # One character under the cap is still rendered.
    conv.turns[0].responses["claude"] = huge[: RENDER_MAX_CHARS - 1]
    assert "<strong>bold</strong>" in export.render_html(conv, conv.turns[0].id)


def test_misnested_tags_stay_linear_in_output_size():
    text = "<b>" * 3000 + "<i>" * 3000 + "</b>" * 3000
    assert len(markdown_html(text)) < 5 * len(text)


def test_nesting_of_raw_tags_is_capped_and_still_balanced():
    html = markdown_html("<b>" * 12 + "x" + "</b>" * 12)
    assert html.count("<b>") == html.count("</b>") == 8
    assert html.count("&lt;b&gt;") == 4 and html.count("&lt;/b&gt;") == 4


# --------------------------------------------------------------------------- operator spacing
@pytest.mark.parametrize(
    ("tex", "expected"),
    [
        (r"\det A = -2", '<mo>=</mo><mo form="prefix">\u2212</mo><mn>2</mn>'),
        (r"\tau = -\frac{1}{2\pi}", '<mo>=</mo><mo form="prefix">\u2212</mo><mfrac>'),
        ("(-1)", '<mo stretchy="false">(</mo><mo form="prefix">\u2212</mo><mn>1</mn>'),
        ("a, -b", '<mo>,</mo><mo form="prefix">\u2212</mo><mi>b</mi>'),
        (r"x = \pm 1", '<mo>=</mo><mo form="prefix">\u00b1</mo>'),
        ("-x", '<mrow><mo form="prefix">\u2212</mo><mi>x</mi>'),
    ],
)
def test_a_unary_sign_is_set_tight(tex, expected):
    assert expected in math_html(tex, False)


@pytest.mark.parametrize(
    ("tex", "expected"),
    [
        ("a - b", "<mi>a</mi><mo>\u2212</mo><mi>b</mi>"),
        ("f(x) - 1", '<mo stretchy="false">)</mo><mo>\u2212</mo><mn>1</mn>'),
        ("|x| - 1", '<mo stretchy="false">|</mo><mo>\u2212</mo><mn>1</mn>'),
        ("n! - 1", "<mo>!</mo><mo>\u2212</mo><mn>1</mn>"),
    ],
)
def test_a_binary_sign_keeps_its_spacing(tex, expected):
    assert expected in math_html(tex, False)


def test_a_solidus_is_set_tight():
    assert '<mn>1</mn><mo lspace="0" rspace="0">/</mo><msup>' in math_html("1/f^2", False)


# --------------------------------------------------------------------------- print and fonts
def _print_rule(selector: str) -> str:
    _, printed = _screen_and_print(export.CSS)
    return " ".join(body for sel, body in _css_rules(printed) if selector in sel)


def test_a_long_list_item_in_a_reply_may_break_across_pages():
    """`li { break-inside: avoid }` pushed a whole multi-paragraph item to the next page."""
    assert re.search(r"break-inside:\s*auto", _print_rule(".md li"))


def test_a_reply_heading_stays_with_what_follows_it():
    assert re.search(r"break-after:\s*avoid", _print_rule(".md .md-h"))
    assert re.search(r"break-before:\s*avoid", _print_rule(".md .md-h + *"))


def test_monospace_text_draws_no_ligatures():
    """A ligature font draws `--` as a dash and `->` as an arrow: a command copied by eye breaks."""
    screen, _ = _screen_and_print(export.CSS)
    rules = _css_rules(screen)
    for selector in (".md code", "code.tex", ".md pre.md-code", ".md kbd", "pre.code"):
        bodies = " ".join(body for sel, body in rules if selector in sel)
        assert re.search(r"font-variant-ligatures:\s*none", bodies), selector


def test_a_narrow_reply_table_column_never_splits_a_word():
    screen, _ = _screen_and_print(export.CSS)
    bodies = " ".join(
        body for sel, body in _css_rules(screen) if {".md-table td", ".md-table th"} <= sel
    )
    assert re.search(r"overflow-wrap:\s*break-word", bodies)
