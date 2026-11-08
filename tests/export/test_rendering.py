"""Rendered Markdown and typeset math in the HTML export (user request, 2026-10-23).

The HTML (and so the PDF the desktop prints from it with scripting off) shows model prose as
rendered Markdown with native MathML, instead of escaped `<pre>` text. The shapes below are the ones
the stored conversations actually hold -- display formulas run together on one line by the web
capture, `\\mathbf` vectors inside a norm, `$1/f^2$`, currency, `$VAR` in code spans, a GFM table
cell with an escaped pipe -- written fresh here (no stored text is copied into the repo).

What must NOT move: the Markdown export, byte for byte (`test_the_markdown_export_*`).
"""

from __future__ import annotations

import re
import unicodedata
from html import escape, unescape
from typing import Any

import pytest

from backend import export
from backend.export import (
    Body,
    Details,
    Document,
    build_document,
    render_html_doc,
    render_markdown_doc,
)
from backend.export_render import (
    TEX_MAX_CHARS,
    esc,
    inline_html,
    markdown_html,
    math_html,
    safe_href,
    styled_char,
)
from backend.schemas import Plan
from tests.export.conftest import doc_headings, html_headings, md_headings, without_toc_links
from tests.export.test_plan_document import make_plan_turn, sample_plan
from tests.helpers import find_identity_leaks

# Anything after `&` that is not one of the escapes `html.escape(quote=True)` makes is a stray
# entity -- e.g. a latex2mathml `&#x…;` placeholder that reached the page undecoded.
_UNESCAPED_AMP_RE = re.compile(r"&(?!amp;|lt;|gt;|quot;|#x27;)")

# Three display formulas run together on ONE line, exactly as the web capture writes `$$tex$$`.
RUN_TOGETHER = r"$$Re=\frac{\rho U L}{\mu}$$$$Fr=\frac{U}{\sqrt{g L}}$$$$St=\frac{f L}{U}$$"
NORM_LINE = r"$$r_j = \|\mathbf{x}-\mathbf{p}_j\| + c\,\delta t_j$$"
BOLD_X = "\U0001d431"  # MATHEMATICAL BOLD SMALL X


def _send_html(conv, reply: str, *, slot: str = "claude") -> str:
    conv.turns[0].responses[slot] = reply
    return export.render_html(conv, conv.turns[0].id)


def _md_divs(html: str) -> str:
    """Only the rendered replies (`div.md`), so the document frame cannot satisfy an assertion."""
    return "\n".join(re.findall(r'<div class="md">\n(.*?)</div>\n(?=<|$)', html, re.S))


# --------------------------------------------------------------------------- math: the real shapes
def test_display_formulas_run_together_on_one_line_are_three_formulas():
    html = markdown_html(RUN_TOGETHER)
    assert html.count('<div class="math-block">') == 1
    assert html.count('<math display="block">') == 3
    annotations = re.findall(r'<annotation encoding="application/x-tex">(.*?)</annotation>', html)
    assert annotations == [
        r"Re=\frac{\rho U L}{\mu}",
        r"Fr=\frac{U}{\sqrt{g L}}",
        r"St=\frac{f L}{U}",
    ]
    assert "$$" not in html and 'class="tex"' not in html  # nothing fell back to source


@pytest.mark.parametrize(
    "line",
    [r"$$a=1$$ $$b=2$$", "$$\na=1\n$$", "$$a=1\n$$"],
)
def test_other_display_shapes_are_display_math(line):
    html = markdown_html(line)
    assert html.startswith('<div class="math-block">')
    assert 'class="tex"' not in html and "$$" not in html


def test_display_formulas_with_prose_between_them_stay_in_their_paragraph():
    html = markdown_html("$$a=1$$ and then $$b=2$$")
    assert html.startswith("<p>") and " and then " in html
    assert html.count('<math display="block">') == 2


def test_bold_letters_are_unicode_math_letters_not_mathvariant():
    """MathML Core honours `mathvariant` only when it is "normal": the letter itself must be bold."""
    html = markdown_html(NORM_LINE)
    assert BOLD_X in html and "\U0001d429" in html  # bold x and bold p
    assert "\u2016" in html  # the norm bars
    assert "mathvariant" not in html


@pytest.mark.parametrize(
    ("tex", "expected"),
    [
        (r"\mathbf{x}", BOLD_X),
        (r"\mathbf{xy}", "\U0001d431\U0001d432"),  # several letters: the `mathvariant` path
        (r"\mathbb{R}^n", "\u211d"),
        (r"\mathbb{RZ}", "\u211d\u2124"),  # Letterlike holes, several letters
        (r"\mathcal{L}", "\u2112"),
        (r"\mathfrak{g}", "\U0001d524"),
        (r"\boldsymbol{\mu}", "\U0001d741"),  # bold italic small mu
        (r"\mathbf{0}", "\U0001d7ce"),  # bold digit zero
    ],
)
def test_font_commands_become_math_alphanumerics(tex, expected):
    html = math_html(tex, False)
    glyphs = re.sub(r"<[^>]+>", "", html.split("<annotation", 1)[0])
    assert expected in glyphs, html
    assert "mathvariant" not in html


def test_upright_text_keeps_mathvariant_normal():
    html = math_html(r"R_{\mathrm{FF}}", False)
    assert '<mi mathvariant="normal">F</mi>' in html


@pytest.mark.parametrize(
    ("variant", "char", "name"),
    [
        ("double-struck", "R", "DOUBLE-STRUCK CAPITAL R"),
        ("double-struck", "N", "DOUBLE-STRUCK CAPITAL N"),
        ("italic", "h", "PLANCK CONSTANT"),
        ("script", "L", "SCRIPT CAPITAL L"),
        ("script", "e", "SCRIPT SMALL E"),
        ("fraktur", "C", "BLACK-LETTER CAPITAL C"),
    ],
)
def test_letterlike_exceptions_fill_the_holes_in_the_math_block(variant, char, name):
    """These letters do not exist in U+1D400..: Unicode keeps them in Letterlike Symbols."""
    prefix = {
        "double-struck": "DOUBLE-STRUCK",
        "italic": "ITALIC",
        "script": "SCRIPT",
        "fraktur": "FRAKTUR",
    }
    case = "CAPITAL" if char.isupper() else "SMALL"
    with pytest.raises(KeyError):
        unicodedata.lookup(f"MATHEMATICAL {prefix[variant]} {case} {char.upper()}")
    assert unicodedata.name(styled_char(variant, char)) == name


def test_characters_without_a_math_letter_are_left_alone():
    assert styled_char("bold", "+") == "+"
    assert styled_char("no-such-variant", "x") == "x"
    assert styled_char("double-struck", "\u03b1") == "\u03b1"  # no double-struck small alpha


def test_underscores_and_norms_inside_formulas_are_never_markdown():
    html = markdown_html(r"Both $a_1$ and $b_1$ hold; $\|v\|$ is a norm and $x_i * y_i$ a product.")
    assert "<em>" not in html and "<strong>" not in html
    assert html.count("<math>") == 4
    assert "\u2016" in html


def test_a_formula_with_a_digit_before_its_closing_dollar_is_still_math():
    html = markdown_html("delay scales approximately with $1/f^2$.")
    assert "<msup><mi>f</mi><mn>2</mn></msup>" in html


@pytest.mark.parametrize(
    "text",
    ["It costs $5 and $10.", "a total of $10.02 today", "$5, $10 and $20", "pay $5 or $ 6"],
)
def test_currency_stays_text(text):
    html = markdown_html(text)
    assert "<math" not in html
    assert html == f"<p>{escape(text, quote=True)}</p>\n"


def test_dollars_and_tags_inside_code_spans_stay_code():
    html = markdown_html(
        "Set `$TMUX` and `$TMUX_PANE`, then run `read <target>`; `$x$` is code too."
    )
    assert "<code>$TMUX</code>" in html and "<code>$TMUX_PANE</code>" in html
    assert "<code>read &lt;target&gt;</code>" in html
    assert "<code>$x$</code>" in html
    assert "<math" not in html


def test_dollars_inside_fenced_code_stay_code():
    html = markdown_html('```sh\ncase "$1" in\n  send) target="$2" ;;\nesac\n```')
    assert "<math" not in html
    assert "case &quot;$1&quot; in" in html


def test_a_captured_table_cell_holding_a_norm_or_an_absolute_value():
    """The capture writes every `|` in a cell as `\\|`, inside formulas too. GFM undoes exactly one
    level, as markdown-it does: an absolute value arrives as `$\\|t\\|$` and a norm as
    `$\\\\|v\\\\|$`, and both come out right -- with the row still two cells wide."""
    table = (
        "| what | formula |\n| --- | --- |\n| abs | $\\|t\\|$ |\n| norm | $\\\\|\\mathbf{x}\\\\|$ |"
    )
    html = markdown_html(table)
    assert html.startswith('<div class="md-table"><table>')
    rows = re.findall(r"<tr>(.*?)</tr>", html, re.S)
    assert [r.count("<td>") + r.count("<th>") for r in rows] == [2, 2, 2]
    assert '<mo stretchy="false">|</mo><mi>t</mi><mo stretchy="false">|</mo>' in rows[1]
    assert "\u2016" in rows[2] and BOLD_X in rows[2]


def test_paren_and_bracket_delimiters():
    html = markdown_html(r"Inline \(a^2+b^2\) and display \[\int_0^1 x\,dx\] in a sentence.")
    assert html.count("<math>") == 1 and html.count('<math display="block">') == 1
    block = markdown_html("\\[\n\\sum_{i=1}^n i\n\\]")
    assert block.startswith('<div class="math-block"><math display="block">')
    # An escaped backslash is not a delimiter.
    assert "<math" not in markdown_html(r"a \\[x\\] b and c \\(y\\)")


def test_aligned_gather_and_equation_are_rewritten_for_the_converter():
    aligned = math_html(r"\begin{aligned} a &= b \\ c &= d \end{aligned}", True)
    assert "<mtable" in aligned and 'class="ma-r"' in aligned and 'class="ma-l"' in aligned
    assert "<mi>&amp;</mi>" not in aligned
    gather = math_html(r"\begin{gather} a=1 \\ b=2 \end{gather}", True)
    assert gather.count("<mtr>") == 2
    equation = math_html(r"\begin{equation} E = mc^2 \end{equation}", True)
    assert "<mtable" not in equation and "<msup><mi>c</mi><mn>2</mn></msup>" in equation
    for html in (aligned, gather, equation):
        assert 'class="tex"' not in html


def test_tex_the_converter_gets_wrong_is_rewritten_first():
    """latex2mathml prints `\\arg` as the literal text "\\arg" (measured on a stored reply's group
    delay formula); a `\\label` prints nothing in LaTeX."""
    html = math_html(r"\tau = -\frac{\partial \arg H}{\partial f} \label{eq:delay}", True)
    presentation = html.split("<annotation", 1)[0]
    assert "<mo>arg</mo>" in presentation
    assert "\\" not in presentation and "eq:delay" not in presentation
    assert r"\label{eq:delay}" in html  # the source keeps it
    assert '<mo movablelimits="true">arg max</mo>' in math_html(r"\argmax_x f", True)


def test_menclose_is_an_mrow_with_a_class():
    html = math_html(r"\boxed{x} + \cancel{y} + \xcancel{z}", False)
    assert "menclose" not in html
    assert '<mrow class="me-box">' in html and '<mrow class="me-up">' in html
    assert '<mrow class="me-up me-down">' in html


def test_the_mathml_carries_its_tex_and_no_namespace():
    html = math_html(r"a<b \text{ & } c", False)
    assert html.startswith("<math><semantics><mrow>")
    assert html.endswith(
        r'<annotation encoding="application/x-tex">a&lt;b \text{ &amp; } c</annotation></semantics></math>'
    )
    assert "xmlns" not in html and "http" not in html


# --------------------------------------------------------------------------- math: hostile TeX
@pytest.mark.parametrize(
    "tex",
    [
        r"\text{<script>alert(1)</script>}",
        r"\text{<img src=x onerror=alert(1)>}",
        r"\verb|<a href=x>|",
        r"\unicode{x3C}script\unicode{x3E}",
    ],
)
def test_markup_inside_tex_is_text(tex):
    html = math_html(tex, False)
    assert "<script" not in html and "<img" not in html and "<a " not in html
    assert "&lt;" in html
    assert _UNESCAPED_AMP_RE.search(html) is None


def test_colours_links_classes_and_styles_from_tex_are_dropped():
    html = math_html(
        r"\color{white}{x} \textcolor{red}{y} \colorbox{red}{z} \href{javascript:alert(1)}{w}"
        r" \class{brand}{u} \style{display:none}{v} \rule{10em}{5em}",
        False,
    )
    presentation = html.split("<annotation", 1)[0]
    for needle in (
        "mathcolor",
        "mathbackground",
        "href",
        "style=",
        "brand",
        "javascript",
        "border",
    ):
        assert needle not in presentation, needle


@pytest.mark.parametrize(
    "tex", [r"\hspace{999em}x", r"\kern{500pt}x", r"\mkern900mu x", r"\hspace{-999em}x"]
)
def test_lengths_are_clamped(tex):  # (offsets and negative space: test_render_hardening.py)
    presentation = math_html(tex, False).split("<annotation", 1)[0]
    lengths = re.findall(
        r'(?:width|voffset|height|depth|lspace)="(-?[\d.]+)(em|pt)?"', presentation
    )
    assert lengths
    for number, unit in lengths:
        assert float(number) <= {"em": 3, "pt": 36, "": 0}[unit]


@pytest.mark.parametrize(
    "tex",
    [
        r"\def\a{xxxxxxxx}\def\b{\a\a\a\a\a\a\a\a}\b",  # macros expand exponentially
        r"\newcommand{\x}{y}\x",
        r"\frac{a",  # a converter error let through as a one-child <mfrac>
        r"x^",
        "x+" * (TEX_MAX_CHARS // 2 + 1),  # over the cap
        "",
    ],
)
def test_tex_the_converter_should_not_take_is_shown_as_escaped_source(tex):
    html = math_html(tex, False)
    assert html == f'<code class="tex">{esc(tex.strip())}</code>'


def test_deeply_nested_tex_never_raises():
    tex = "{" * 1900 + "x" + "}" * 1900  # under the cap, over the recursion limit
    html = math_html(tex, True)
    assert html.startswith("<math") or html.startswith('<code class="tex">')


# --------------------------------------------------------------------------- markdown
def test_headings_inside_a_reply_are_demoted_out_of_the_document_outline(rich_send):
    conv = rich_send()
    reply = "# Overview\n\nText.\n\n## Details\n\n###### Deepest"
    conv.turns[0].responses["claude"] = reply
    doc = build_document(conv, conv.turns[0].id)
    html = render_html_doc(doc)
    assert '<h3 class="md-h">Overview</h3>' in html
    assert '<h4 class="md-h">Details</h4>' in html
    assert '<h6 class="md-h">Deepest</h6>' in html
    # The document's own outline is untouched in the HTML, and the Markdown keeps the reply verbatim.
    assert html_headings(html) == doc_headings(doc)
    md = render_markdown_doc(doc)
    assert reply in md
    assert md_headings(md) != doc_headings(doc, md=True)  # the reply's headings are in there too


def test_markdown_structures_render():
    html = markdown_html(
        "Intro with **bold**, *em*, ~~gone~~ and `code`.\n\n"
        "- one\n- two\n  - nested\n\n"
        "3. third\n4. fourth\n\n"
        "- [ ] open\n- [x] done\n\n"
        "> quoted\n\n---\n\n"
        "| left | centre | right |\n|:--|:-:|--:|\n| a | b | c |"
    )
    for needle in (
        "<strong>bold</strong>",
        "<em>em</em>",
        "<s>gone</s>",
        "<code>code</code>",
        "<li>nested</li>",
        '<ol start="3">',
        '<ul class="md-tasks">',
        '<li class="md-task"><input type="checkbox" disabled> open</li>',
        '<li class="md-task"><input type="checkbox" disabled checked> done</li>',
        "<blockquote>",
        "<hr>",
        '<div class="md-table"><table>',
        '<th class="al-l">left</th>',
        '<td class="al-c">b</td>',
        '<td class="al-r">c</td>',
    ):
        assert needle in html, needle


def test_fence_languages_are_dropped_and_code_is_escaped():
    html = markdown_html("```python\nx = '<y>' & \"z\"\n```")
    assert (
        html
        == '<pre class="md-code"><code>x = &#x27;&lt;y&gt;&#x27; &amp; &quot;z&quot;\n</code></pre>\n'
    )


def test_images_are_their_alt_text_and_never_fetched(rich_send):
    conv = rich_send()
    html = _send_html(
        conv, "Before ![a diagram of the array](https://example.org/array.png) after, and ![]()."
    )
    assert "a diagram of the array" in _md_divs(html)
    assert "example.org" not in html
    assert html.lower().count("<img") == 1  # the brand mark, nothing else


def test_send_reply_links_are_anchors_only_for_safe_schemes(rich_send):
    conv = rich_send()
    html = _send_html(
        conv,
        "See [the docs](https://example.org/a?b=1&c=2), <https://example.net/x>, "
        "[mail](mailto:someone@example.org), [bad](javascript:alert(1)) and [ftp](ftp://example.org/f).",
    )
    body = _md_divs(html)
    assert (
        '<a href="https://example.org/a?b=1&amp;c=2" target="_blank" rel="noreferrer noopener">the docs</a>'
        in body
    )
    assert (
        '<a href="https://example.net/x" target="_blank" rel="noreferrer noopener">https://example.net/x</a>'
        in body
    )
    assert (
        '<a href="mailto:someone@example.org" target="_blank" rel="noreferrer noopener">mail</a>'
        in body
    )
    for anchor in re.findall(r'<a href="([^"]*)"', without_toc_links(html)):
        assert safe_href(unescape(anchor), mailto=True) == unescape(anchor)
    assert "javascript:" not in "".join(re.findall(r"<a [^>]*>", html))
    assert 'href="ftp:' not in html and ">ftp</a>" not in html


@pytest.fixture
def every_kind(rich_send, add_continue, add_analyze, add_refactor, add_fusion):
    """One conversation holding every document kind, ok and degraded."""
    conv = rich_send()
    add_continue(conv)
    analyze = add_analyze(conv)
    add_analyze(conv, status="degraded")
    add_refactor(conv)
    add_refactor(conv, status="degraded")
    fusions = [
        add_fusion(conv, analyze, exit_reason=r)
        for r in ("converged", "max_iterations", "stalemate", "error")
    ]
    make_plan_turn(conv, fusions[0])
    make_plan_turn(conv, fusions[1], status="degraded")
    return conv


LINKED = "Read [the paper](https://example.org/paper) first."


def _plant_everywhere(conv, text: str) -> None:
    """`text` into every prose field the Analyze / Fusion / Refactor / Plan documents quote."""
    for turn in conv.turns:
        if turn.type == "fusion":
            for rnd in turn.rounds:
                for exchange in rnd.exchanges:
                    if exchange.stance != "unavailable":
                        exchange.justification = text
        elif turn.type == "refactor" and turn.refactoring is not None:
            turn.refactoring.question = text
            for reply in turn.refactoring.replies:
                reply.summary = text
        elif turn.type == "plan" and turn.plan is not None:
            turn.plan.objective = text  # (a step's `action` is also a table cell: text, as written)
            turn.plan.steps[0].why = text


def test_no_anchor_namespace_or_url_outside_send_documents(every_kind):
    """An Analyze / Fusion / Refactor / Plan document cites nothing, even when the prose it quotes
    holds a link: the link's text survives, its URL does not. Its only links are the table of
    contents, which name the document's own headings."""
    conv = every_kind
    _plant_everywhere(conv, LINKED)
    for turn in conv.turns:
        if turn.type in ("send", "continue"):
            continue
        html = without_toc_links(export.render_html(conv, turn.id))
        lowered = html.lower()
        assert "<a " not in lowered and "href=" not in lowered, turn.type
        assert "http://" not in lowered and "https://" not in lowered, turn.type
        assert "xmlns" not in lowered, turn.type
        if turn.type in ("fusion", "refactor", "plan") and getattr(turn, "status", "ok") == "ok":
            if turn.type != "fusion" or turn.exit_reason != "error":
                assert "Read the paper first." in html, turn.type


def test_quoted_prose_is_escaped_exactly_like_html_escape(rich_send, add_analyze, add_fusion):
    """The anonymity tests excise `html.escape(planted, quote=True)`: rendered prose must spell a
    planted string exactly that way, both quote characters included."""
    planted = "The \"OpenAI\" figure isn't R2's, and 3 < 4 & 5 > 2."
    conv = rich_send()
    fusion = add_fusion(conv, add_analyze(conv))
    fusion.rounds[0].exchanges[0].justification = planted
    html = export.render_html(conv, fusion.id)
    assert escape(planted, quote=True) in html
    assert find_identity_leaks(html, allow=(escape(planted, quote=True),)) == []
    assert find_identity_leaks(html) != []


def test_a_math_heavy_document_has_no_stray_entity(rich_send):
    conv = rich_send()
    reply = "\n\n".join(
        [
            RUN_TOGETHER,
            NORM_LINE,
            r"Inline $\alpha \le \beta$, $a \ne b$, $\sum_i x_i$, $\int f\,dx$ and $\langle x \rangle$.",
            r"$$\begin{aligned} \rho\ddot R &= p_B - p_\infty \\ q &\lesssim \tfrac{1}{2} \end{aligned}$$",
            r"Text with $\text{a & b}$ and $\%$ and $\$$ and $\&$.",
        ]
    )
    html = _send_html(conv, reply)
    assert _UNESCAPED_AMP_RE.search(html) is None
    assert "&amp;#x" not in html  # no latex2mathml placeholder escaped instead of decoded
    assert 'class="tex"' not in html
    assert html.count("<math") == 3 + 1 + 5 + 1 + 4


# --------------------------------------------------------------------------- the document
def test_each_body_lands_as_its_kind(rich_send, add_analyze):
    conv = rich_send()
    turn = conv.turns[0]
    turn.prompt = "A prompt with **stars** and $x$ that stays as typed."
    html = export.render_html(conv, turn.id)
    # The user's prompt, the error and the reasoning are shown as written.
    assert f'<pre class="body">{escape(turn.prompt, quote=True)}</pre>' in html
    assert f'<pre class="body">{escape(turn.errors["grok"], quote=True)}</pre>' in html
    assert f'<pre class="body">{escape(turn.reasoning["claude"], quote=True)}</pre>' in html
    # The replies (and the partial text of the one that failed) are rendered prose.
    assert (
        '<div class="md">\n<p>The BMI088 gyroscope range is selectable up to <strong>2000 deg/s</strong>.</p>\n</div>'
        in html
    )
    assert '<div class="md">\n<p>The gyro supports ranges from 125</p>\n</div>' in html
    # A raw analyst attempt stays code.
    degraded = add_analyze(conv, status="degraded")
    degraded_html = export.render_html(conv, degraded.id)
    assert '<pre class="code">{&quot;agreements&quot;' in degraded_html
    assert '<div class="md">' not in degraded_html


def test_the_builder_decides_kind_and_links_once(every_kind):
    def bodies(blocks: Any) -> list[Body]:
        out: list[Body] = []
        for block in blocks:
            if isinstance(block, Body):
                out.append(block)
            elif isinstance(block, Details):
                out.extend(bodies(block.blocks))
        return out

    for turn in every_kind.turns:
        found = bodies(build_document(every_kind, turn.id).blocks)
        assert found, turn.type
        for b in found:
            assert b.kind in ("plain", "markdown", "code")
            # Links only ever in a Send / Continue reply.
            assert not b.links or (turn.type in ("send", "continue") and b.kind == "markdown")


def test_cells_bullets_and_checklist_items_typeset_math(rich_send, add_analyze, add_fusion):
    conv = rich_send()
    analyze = add_analyze(conv)
    analyze.extraction.divergences[0].positions[0].claim = r"The range is $\pm 2000$ deg/s."
    analyze.extraction.agreements[
        0
    ].statement = r"Noise density is below $0.014\,\mathrm{dps}/\sqrt{Hz}$."
    html = export.render_html(conv, analyze.id)
    cell = next(c for c in re.findall(r"<td>(.*?)</td>", html) if "The range is" in c)
    assert cell.startswith("The range is <math><semantics>") and cell.endswith("</math> deg/s.")
    bullet = next(li for li in re.findall(r"<li>(.*?)</li>", html, re.S) if "Noise density" in li)
    assert "<msqrt>" in bullet
    fusion = add_fusion(conv, analyze)
    plan = make_plan_turn(
        conv,
        fusion,
        plan=sample_plan().model_copy(update={"done_when": [r"$\theta < 1^\circ$ holds"]}),
    )
    plan_html = export.render_html(conv, plan.id)
    item = re.search(r'<li><input type="checkbox" disabled> (.*?)</li>', plan_html).group(1)
    assert item.startswith("<math>") and item.endswith(" holds")


@pytest.mark.parametrize(
    "value",
    [
        "plain words",
        "It costs $5 and $10, or $10.02.",
        "C:\\path\\to\\file and \\$escaped",
        "  leading and trailing spaces  ",
        "two\nlines\r\nand a \0 null",
        "a <b>tag</b> & 'quotes' \"too\"",
        "under_scores *stars* `ticks` [x](https://example.org)",
        "",
    ],
)
def test_a_value_without_math_is_exactly_its_escaped_text(value):
    assert inline_html(value) == esc(value)


def test_the_document_is_static_and_self_contained(every_kind):
    for turn in every_kind.turns:
        for theme in ("light", "dark", "system"):
            html = export.render_html(every_kind, turn.id, theme)
            head = html[: html.index("</head>")]
            assert head.startswith(
                '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
                f'<meta http-equiv="Content-Security-Policy" content="{export.CSP}">\n'
            )
            lowered = html.lower()
            assert lowered.count("<style>") == 1 and "<script" not in lowered
            assert (
                "url(" not in lowered and "@import" not in lowered and "@font-face" not in lowered
            )
            assert not re.search(
                r"<[a-z][^>]*\son[a-z]+\s*=", lowered
            )  # no event handler attribute


def test_the_policy_allows_only_the_inline_style_and_the_embedded_logo():
    assert export.CSP == "default-src 'none'; style-src 'unsafe-inline'; img-src data:"


@pytest.mark.parametrize("theme", ["light", "dark", "system"])
def test_the_stylesheet_names_no_vendor_and_loads_nothing(theme):
    css = export.theme_css(theme)
    assert find_identity_leaks(css) == []
    rules = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
    assert "url(" not in rules and "position: fixed" not in rules and "@font-face" not in rules


def test_print_rules_cover_math_tables_and_code():
    css = re.sub(r"/\*.*?\*/", "", export.CSS, flags=re.S)
    print_block = css[css.index("@media print") :]
    assert (
        ".math-block" in print_block and ".md-table" in print_block and "pre.md-code" in print_block
    )
    assert re.search(r"pre\.md-code\s*\{[^}]*white-space:\s*pre-wrap", css)


# --------------------------------------------------------------------------- the Markdown export
def _as_before(doc: Document) -> Document:
    """The document as the builder made it before this change: every prose body was `body(text)`."""

    def swap(blocks: Any) -> tuple[Any, ...]:
        out = []
        for block in blocks:
            if isinstance(block, Body) and block.kind == "markdown":
                out.append(export.body(block.text))
            elif isinstance(block, Details):
                out.append(Details(block.summary, swap(block.blocks)))
            else:
                out.append(block)
        return tuple(out)

    return Document(
        kind=doc.kind,
        turn_id=doc.turn_id,
        conversation_id=doc.conversation_id,
        conversation_title=doc.conversation_title,
        title=doc.title,
        ts=doc.ts,
        blocks=swap(doc.blocks),
    )


def test_the_markdown_export_is_byte_for_byte_what_it_was(every_kind):
    """No HTML decision (`kind`, `links`) reaches the Markdown: every document renders the same
    bytes as with the pre-change `body()` everywhere -- including bodies full of math and tags."""
    conv = every_kind
    conv.turns[0].responses["chatgpt"] = (
        RUN_TOGETHER + "\n\n<b>bold</b> and [x](https://example.org)"
    )
    _plant_everywhere(conv, NORM_LINE + "\n\n```\nleft open")
    swapped = 0
    for turn in conv.turns:
        doc = build_document(conv, turn.id)
        before = _as_before(doc)
        swapped += before != doc
        assert render_markdown_doc(doc) == render_markdown_doc(before), turn.type
        for theme in ("light", "dark", "system"):
            assert export.render_doc(doc, "md", theme) == render_markdown_doc(before)
    assert swapped  # the comparison really exercised prose bodies


def test_a_plan_with_math_still_exports_the_same_markdown(rich_send, add_analyze, add_fusion):
    conv = rich_send()
    fusion = add_fusion(conv, add_analyze(conv))
    plan = make_plan_turn(conv, fusion, plan=Plan(objective=r"Keep $\|e\|_2 < 10^{-3}$."))
    doc = build_document(conv, plan.id)
    assert render_markdown_doc(doc) == render_markdown_doc(_as_before(doc))
    assert r"Keep $\|e\|_2 < 10^{-3}$." in render_markdown_doc(doc)
