"""Static HTML for the quoted text of an export (owner: export-backend; used by `backend/export.py`).

A model reply IS Markdown, often with TeX in it, so the HTML export renders it -- and the PDF is
that HTML printed by the desktop shell in a window with scripting OFF (desktop/main/export.js). So
everything here is decided on the server and the output is STATIC: no script, no external URL of
any kind, nothing a reader's browser has to fetch or run.

    esc(value) -> str                       # the one HTML escaper (quotes included)
    safe_href(url, mailto=False) -> str|None  # the only way a URL becomes an anchor
    markdown_html(text, links=) -> str      # a whole reply: Markdown + math, rendered
    inline_html(value) -> str               # one cell / bullet: math only, else esc(value)
    math_html(tex, display) -> str          # TeX -> MathML Core (or an escaped <code> fallback)

MARKDOWN. markdown-it-py's CommonMark parser with GFM tables, strikethrough and task lists. Every
text node, code span and attribute goes through `esc()`. Raw HTML is NOT passed through: CommonMark
HTML BLOCKS are switched off (a line starting with `<div>` or `<table>` would otherwise swallow every
line after it), and each inline tag is matched STRICTLY against an allow-list of attribute-free
formatting tags (`ALLOWED_TAGS`). Anything else -- an attribute, another tag, a comment, `<script>`
-- is shown as escaped text, exactly as the panes show it. Allowed tags are balanced per inline
run (a paragraph, a heading, a table cell): one still open at the end is closed, a closer with no
opener is text, at most `_RAW_OPEN_MAX` are open at once (one more is text), and a tag crossing a
Markdown emphasis is closed and reopened around it. Headings inside a reply are demoted below the
document's own (`#` -> h3, class `md-h`), tables are wrapped in `div.md-table`, fence info strings
are dropped, an image is its alt text (never fetched), and every link is tokenized -- markdown-it's
own `validateLink` is off -- so that it is an anchor only when the caller allows links AND
`safe_href` passes, and otherwise its text (`[js](javascript:…)` included).

MATH. `$…$` / `\\(…\\)` inline and `$$…$$` / `\\[…\\]` display. Currency stays text: no space just
inside a delimiter and no digit just outside it (`$5 and $10`, `$10.02`). A code span binds
tighter than a formula: `$` inside one is code (text, in a cell), even when a currency amount
earlier in the paragraph would otherwise close on it. A shell path (`$PATH/$HOME/bin`) and escaped
brackets in prose (`array\\[0\\]`, `\\[-1, 1\\]`) stay text. Display formulas the web capture writes
run together on one line (`$$a$$$$b$$`) are split. TeX becomes MathML through
`latex2mathml.converter.convert_to_element` -- never its `convert()`, which un-escapes its own
output -- and OUR serializer, which keeps only MathML Core elements and attributes: no colours, no
links, no classes or styles from the TeX, lengths clamped, no `xmlns`. A formula never paints
outside its own box: no `voffset`, no `mpadded` smaller than what it holds (`\\raise`, `\\lower`,
`\\smash`, `\\rlap` are typeset in place), and only an `mspace` width may be negative, at most
`NEGATIVE_SPACE_MAX_EM` in the whole formula -- each of these passed a per-value clamp and still
added up to a line drawn over the page header. MathML Core ignores `mathvariant` except "normal",
so bold / double-struck / script / fraktur / … letters are rewritten as Unicode Mathematical
Alphanumerics; a unary sign is `form="prefix"` and a solidus is set tight, as TeX sets them. The
TeX source rides along in `<annotation encoding="application/x-tex">`. Over `TEX_MAX_CHARS`, a
macro definition, or ANY exception, the formula is shown as escaped `<code class="tex">` instead.

COST. Linear in the text, whatever a model writes: delimiter positions are indexed once per inline
run, multi-line formula scans draw on a budget of lines, an unmatched closer is refused in O(1),
and text past `RENDER_MAX_CHARS` is not rendered at all (markdown-it-py itself is quadratic on a
long run of punctuation) -- the export renders on the backend's event loop.
"""

from __future__ import annotations

import math
import re
import unicodedata
from bisect import bisect_left
from functools import lru_cache
from html import escape as _html_escape
from typing import Any
from urllib.parse import urlsplit
from xml.etree.ElementTree import Element

from markdown_it import MarkdownIt
from markdown_it.rules_block import StateBlock
from markdown_it.rules_inline import StateInline
from markdown_it.rules_inline.backticks import backtick as _backtick
from markdown_it.token import Token
from mdit_py_plugins.dollarmath.index import math_inline_dollar


# --------------------------------------------------------------------------- escaping / hrefs
def esc(value: Any) -> str:
    """HTML-escape, quotes included: the only way a value reaches the HTML document."""
    return _html_escape("" if value is None else str(value), quote=True)


_MAILTO_BAD_RE = re.compile(r"[\x00-\x20\x7f<>\"'`\\]")


def safe_href(url: Any, *, mailto: bool = False) -> str | None:
    """Only an absolute http(s) URL may become an anchor (mirrors `safeCitationHref` in the UI);
    with `mailto=True` (a link inside a reply) a plain `mailto:` address may too."""
    if not isinstance(url, str):
        return None
    try:
        parts = urlsplit(url)
    except ValueError:
        return None
    if parts.scheme in ("http", "https") and parts.netloc:
        return url
    if mailto and parts.scheme == "mailto" and parts.path and not _MAILTO_BAD_RE.search(url):
        return url
    return None


# --------------------------------------------------------------------------- raw inline HTML
#: Attribute-free formatting tags a reply may use; every other tag is shown as text.
ALLOWED_TAGS: frozenset[str] = frozenset(
    {"br", "sub", "sup", "b", "strong", "i", "em", "u", "s", "del", "ins", "mark", "kbd", "small"}
)
_VOID_TAGS = frozenset({"br"})
_RAW_TAG_RE = re.compile(r"^<(/?)([A-Za-z]+)\s*(/?)>$")


def _allowed_tag(raw: str) -> tuple[str, str] | None:
    """`("open"|"close"|"void", name)` for an allow-listed tag written exactly, else None."""
    match = _RAW_TAG_RE.match(raw)
    if not match:
        return None
    closing, name, slash = match.group(1), match.group(2).lower(), match.group(3)
    if name not in ALLOWED_TAGS:
        return None
    if name in _VOID_TAGS:
        return None if closing else ("void", name)
    if slash:  # `</b/>` or `<b/>`: not a tag a reply means to write
        return None
    return ("close" if closing else "open", name)


# --------------------------------------------------------------------------- math delimiters
def _escaped(src: str, pos: int) -> bool:
    """True when the character at `pos` is preceded by an odd number of backslashes."""
    count = 0
    while pos - count - 1 >= 0 and src[pos - count - 1] == "\\":
        count += 1
    return count % 2 == 1


_dollar = math_inline_dollar(allow_space=False, allow_digits=False, allow_double=True)
#: `$PATH/$HOME/bin`, `$MY_TOOL/bin:$PATH`: a shell variable in prose, not a formula. Two capitals
#: first, so `$X_1/X_2$` and `$N/2$` are still math.
_SHELL_PATH_RE = re.compile(r"[A-Z]{2}[A-Z0-9_]*[/:]")


def _math_dollar(state: StateInline, silent: bool) -> bool:
    """mdit-py-plugins' `$…$` / `$$…$$` -- no space just inside a delimiter and no digit just
    outside, so currency stays text -- refused three more ways: a closer past the end of this
    inline run; a formula holding a backtick (in `$10 … `$HOME``, the closer is inside a code span,
    and a code span binds tighter than anything); a shell path (`$PATH/$HOME/bin`)."""
    start = state.pos
    if not _dollar(state, True):
        return False
    end, state.pos = state.pos, start
    width = 2 if state.src.startswith("$$", start) else 1
    content = state.src[start + width : end - width]
    if end > state.posMax or "`" in content or (width == 1 and _SHELL_PATH_RE.match(content)):
        return False
    if not silent:
        token = state.push("math_inline_double" if width == 2 else "math_inline", "math", 0)
        token.content = content
        token.markup = "$" * width
    state.pos = end
    return True


#: What an inline `\[…\]` must hold to be a formula rather than escaped brackets in prose
#: (`array\[0\]`, `\[1\]`, `\[-1, 1\]`): a TeX command, or `= ^ _ { } < >`.
_TEXLIKE_RE = re.compile(r"\\[A-Za-z]|[=^_{}<>]")


def _paren_index(state: StateInline, closer: str) -> tuple[list[int], list[int], list[int]]:
    """Where, in this inline run, every unescaped `closer`, every backtick and every TeX-like mark
    sits -- found once per run, so each opener is decided by bisection and a run of thousands of
    unclosed `\\(` is linear, not quadratic."""
    cache = state.env.setdefault("_math_paren_index", {})
    key = (state.src, closer)
    if key not in cache:
        src = state.src
        cache[key] = (
            [
                m.start()
                for m in re.finditer(re.escape(closer), src)
                if not _escaped(src, m.start())
            ],
            [m.start() for m in re.finditer("`", src)],
            [m.start() for m in _TEXLIKE_RE.finditer(src)],
        )
    return cache[key]


def _first_from(positions: list[int], start: int) -> int | None:
    index = bisect_left(positions, start)
    return positions[index] if index < len(positions) else None


def _math_paren(state: StateInline, silent: bool) -> bool:
    """`\\(…\\)` inline and `\\[…\\]` display inside a paragraph (runs before `escape`)."""
    src, pos = state.src, state.pos
    if src[pos] != "\\" or pos + 1 >= state.posMax:
        return False
    opener = src[pos + 1]
    if opener == "(":
        closer, display = "\\)", False
    elif opener == "[":
        closer, display = "\\]", True
    else:
        return False
    closers, ticks, texlike = _paren_index(state, closer)
    end = _first_from(closers, pos + 2)
    if end is None or end + 2 > state.posMax:
        return False
    tick = _first_from(ticks, pos + 2)
    if tick is not None and tick < end:
        return False  # a backtick first: its code span binds tighter than the formula
    if display:
        mark = _first_from(texlike, pos + 2)
        if mark is None or mark >= end:
            return False
    content = src[pos + 2 : end]
    if not content.strip():
        return False
    if not silent:
        token = state.push("math_inline_double" if display else "math_inline", "math", 0)
        token.content = content
        token.markup = "\\" + opener
    state.pos = end + 2
    return True


def _math_block(state: StateBlock, startLine: int, endLine: int, silent: bool) -> bool:
    """A paragraph-level `$$…$$` or `\\[…\\]`, on one line or several (no blank line inside).

    The web capture writes each display formula as `$$tex$$` with no line break between them, so a
    line can hold several run together (`$$a$$$$b$$`): those become separate display formulas. A
    line that mixes formulas with prose is left to the inline rules instead."""
    if state.sCount[startLine] - state.blkIndent >= 4:
        return False
    start = state.bMarks[startLine] + state.tShift[startLine]
    line = state.src[start : state.eMarks[startLine]]
    if line.startswith("$$"):
        opener, closer = "$$", "$$"
    elif line.startswith("\\["):
        opener, closer = "\\[", "\\]"
    else:
        return False
    first = line[len(opener) :].rstrip()
    next_line = startLine
    if first.endswith(closer) and not (closer == "\\]" and _escaped(first, len(first) - 2)):
        content = first[: -len(closer)]
    else:
        parts = [first]
        while True:
            next_line += 1
            if next_line >= endLine or not _scan_one_line(state):
                return False
            text = state.src[
                state.bMarks[next_line] + state.tShift[next_line] : state.eMarks[next_line]
            ]
            text = text.rstrip()
            if not text:
                return False  # no blank line inside a formula
            if text.endswith(closer) and not (closer == "\\]" and _escaped(text, len(text) - 2)):
                parts.append(text[: -len(closer)])
                break
            parts.append(text)
        content = "\n".join(parts)
    if opener == "$$":
        pieces = content.split("$$")
        if len(pieces) % 2 == 0 or any(p.strip() for p in pieces[1::2]):
            return False
        formulas = pieces[0::2]
    else:
        if re.search(r"(?<!\\)(?:\\\\)*\\[\[\]]", content):
            return False
        formulas = [content]
    if not all(f.strip() for f in formulas):
        return False
    if silent:
        return True
    token = state.push("math_block", "math", 0)
    token.block = True
    token.meta = {"formulas": [f.strip() for f in formulas]}
    token.map = [startLine, next_line + 1]
    state.line = next_line + 1
    return True


def _scan_one_line(state: StateBlock) -> bool:
    """Spend one line of a multi-line formula scan from a budget of two per line of the reply.

    A scan that finds no closer runs to the next blank line, and a heading after every `$$a` line
    would make every opener rescan the rest of the reply (quadratic: 64 KB took 10 s). An ordinary
    reply never comes near the budget; a hostile one runs out, and its later multi-line openers are
    then just text."""
    left = state.env.get("_math_block_lines")
    if left is None:
        left = 2 * state.lineMax + 64
    state.env["_math_block_lines"] = left - 1
    return left > 0


def _code_as_text(state: StateInline, silent: bool) -> bool:
    """For a single value (`inline_html`): a code span is its own text, exactly as written, so a
    `$` inside it is never the start or end of a formula."""
    start, count = state.pos, len(state.tokens)
    if not _backtick(state, silent):
        return False
    if not silent and len(state.tokens) > count and state.tokens[-1].type == "code_inline":
        token = state.tokens[-1]
        token.type, token.tag, token.markup = "text", "", ""
        token.content = state.src[start : state.pos]
    return True


def _math_rules(md: MarkdownIt) -> MarkdownIt:
    md.inline.ruler.before("escape", "math_paren", _math_paren)
    md.inline.ruler.before("escape", "math_dollar", _math_dollar)
    return md


def _block_parser() -> MarkdownIt:
    md = MarkdownIt(
        "commonmark",
        {
            "html": True,  # inline tags only, each matched against ALLOWED_TAGS when rendered
            "linkify": False,
            "typographer": False,
            "xhtmlOut": False,
            "breaks": False,
            "tasklists": True,
        },
    )
    md.enable(["table", "strikethrough"])
    md.disable("html_block")  # a `<div>` line must never swallow the lines after it
    md.block.ruler.before("fence", "math_block", _math_block)
    # Every link is tokenized -- `javascript:` included -- so that `safe_href` alone decides between
    # an anchor and the link's text; markdown-it's own check would leave `[js](javascript:…)` as
    # raw Markdown on the page.
    md.validateLink = lambda url: True
    return _math_rules(md)


def _inline_parser() -> MarkdownIt:
    """Math only, for single values: everything that is not a formula stays byte-for-byte text."""
    md = MarkdownIt("zero")
    md.core.ruler.disable("normalize")
    md.inline.ruler.before("escape", "code_as_text", _code_as_text)
    return _math_rules(md)


_BLOCK_MD = _block_parser()
_INLINE_MD = _inline_parser()


# --------------------------------------------------------------------------- markdown rendering
_HEADING_SHIFT = 2  # a reply's `#` sits below the document's own h2 sections
_ALIGN_CLASSES = {
    "text-align:left": "al-l",
    "text-align:center": "al-c",
    "text-align:right": "al-r",
}


#: The longest text rendered as Markdown (4x the longest stored reply). markdown-it-py itself is
#: quadratic on a long run of punctuation (it grows its pending text by `+=`: 512 KB of `+` took
#: 2 s), so a body over this is shown as written instead -- in the export's `<pre class="body">`,
#: or as `esc(value)` in a cell -- and a hostile reply cannot stall the backend that renders it.
RENDER_MAX_CHARS = 100_000


def markdown_html(text: str, *, links: bool = False) -> str:
    """A reply, rendered: the inner HTML of the export's `div.md` (static, every value escaped).
    The caller keeps `text` within `RENDER_MAX_CHARS`."""
    return _render_blocks(_BLOCK_MD.parse(text or ""), links=links)


def inline_html(value: Any) -> str:
    """One table cell, bullet or checklist item: formulas typeset, everything else `esc(value)` --
    byte-for-byte that when there is no formula, so no other Markdown is ever interpreted."""
    raw = "" if value is None else str(value)
    if ("$" not in raw and "\\" not in raw) or len(raw) > RENDER_MAX_CHARS:
        return esc(raw)
    out: list[str] = []
    for token in _INLINE_MD.parseInline(raw):
        for child in token.children or []:
            if child.type == "math_inline":
                out.append(math_html(child.content, False))
            elif child.type == "math_inline_double":
                out.append(math_html(child.content, True))
            else:
                out.append(esc(child.content))
    return "".join(out)


def _render_blocks(tokens: list[Token], *, links: bool) -> str:
    out: list[str] = []
    for token in tokens:
        kind = token.type
        if kind == "inline":
            out.append(_render_inline(token.children or [], links=links))
        elif kind == "paragraph_open":
            out.append("" if token.hidden else "<p>")
        elif kind == "paragraph_close":
            out.append("" if token.hidden else "</p>\n")
        elif kind == "heading_open":
            out.append(f'<h{_heading_level(token)} class="md-h">')
        elif kind == "heading_close":
            out.append(f"</h{_heading_level(token)}>\n")
        elif kind == "bullet_list_open":
            tasks = "contains-task-list" in str(token.attrGet("class") or "")
            out.append('<ul class="md-tasks">\n' if tasks else "<ul>\n")
        elif kind == "bullet_list_close":
            out.append("</ul>\n")
        elif kind == "ordered_list_open":
            start = str(token.attrGet("start") or "")
            out.append(f'<ol start="{int(start)}">\n' if start.isdigit() else "<ol>\n")
        elif kind == "ordered_list_close":
            out.append("</ol>\n")
        elif kind == "list_item_open":
            if token.meta and "checked" in token.meta:
                checked = " checked" if token.meta["checked"] else ""
                out.append(f'<li class="md-task"><input type="checkbox" disabled{checked}> ')
            else:
                out.append("<li>")
        elif kind == "list_item_close":
            out.append("</li>\n")
        elif kind == "blockquote_open":
            out.append("<blockquote>\n")
        elif kind == "blockquote_close":
            out.append("</blockquote>\n")
        elif kind == "hr":
            out.append("<hr>\n")
        elif kind in ("code_block", "fence"):
            out.append(f'<pre class="md-code"><code>{esc(token.content)}</code></pre>\n')
        elif kind == "math_block":
            formulas = "\n".join(math_html(f, True) for f in token.meta["formulas"])
            out.append(f'<div class="math-block">{formulas}</div>\n')
        elif kind == "table_open":
            out.append('<div class="md-table"><table>\n')
        elif kind == "table_close":
            out.append("</table></div>\n")
        elif kind in ("thead_open", "tbody_open", "tr_open"):
            out.append(f"<{token.tag}>\n" if kind != "tr_open" else "<tr>")
        elif kind in ("thead_close", "tbody_close", "tr_close"):
            out.append(f"</{token.tag}>\n")
        elif kind in ("th_open", "td_open"):
            align = _ALIGN_CLASSES.get(str(token.attrGet("style") or ""))
            out.append(f'<{token.tag} class="{align}">' if align else f"<{token.tag}>")
        elif kind in ("th_close", "td_close"):
            out.append(f"</{token.tag}>")
        else:  # html_block is disabled; anything unforeseen is shown as text, never as markup
            if token.content:
                out.append(f"<p>{esc(token.content)}</p>\n")
    return "".join(out)


def _heading_level(token: Token) -> int:
    return min(6, int(token.tag[1]) + _HEADING_SHIFT)


#: The most allow-listed raw tags open at once; a further opener is shown as text. Browsers bound
#: misnesting the same way (the adoption agency gives up after 8 steps): without it, closing a tag
#: under N others reopens all N, and `<b>`×N `<i>`×M `</b>`×N grew as N×M (10 KB in, 7 MB out).
_RAW_OPEN_MAX = 8


def _render_inline(children: list[Token], *, links: bool) -> str:
    """One inline run. Markdown's own emphasis and the allow-listed raw tags share one stack of
    open elements, so the output is always properly nested, and the run ends with nothing open."""
    out: list[str] = []
    stack: list[tuple[str, str, str]] = []  # (name, opening html, "md" | "raw")
    open_count: dict[tuple[str, str], int] = {}  # a closer with no opener is refused in O(1)
    raw_open = 0

    def close_to(name: str, origin: str) -> bool:
        nonlocal raw_open
        if not open_count.get((name, origin)):
            return False
        index = next(
            i
            for i in range(len(stack) - 1, -1, -1)
            if stack[i][0] == name and stack[i][2] == origin
        )
        above = stack[index + 1 :]
        for entry in reversed(above):
            out.append(_closer(entry))
        out.append(_closer(stack[index]))
        del stack[index:]
        for entry in above:  # reopen what had to close for the nesting to stay valid
            out.append(entry[1])
            stack.append(entry)
        open_count[(name, origin)] -= 1
        raw_open -= origin == "raw"
        return True

    def open_(name: str, html: str, origin: str) -> None:
        nonlocal raw_open
        out.append(html)
        stack.append((name, html, origin))
        open_count[(name, origin)] = open_count.get((name, origin), 0) + 1
        raw_open += origin == "raw"

    for token in children:
        kind = token.type
        if kind == "text":
            out.append(esc(token.content))
        elif kind == "softbreak":
            out.append("\n")
        elif kind == "hardbreak":
            out.append("<br>\n")
        elif kind == "code_inline":
            out.append(f"<code>{esc(token.content)}</code>")
        elif kind in ("em_open", "strong_open", "s_open"):
            open_(kind, f"<{token.tag}>", "md")
        elif kind in ("em_close", "strong_close", "s_close"):
            close_to(kind.replace("_close", "_open"), "md")
        elif kind == "link_open":
            href = safe_href(token.attrGet("href"), mailto=True) if links else None
            html = (
                f'<a href="{esc(href)}" target="_blank" rel="noreferrer noopener">' if href else ""
            )
            open_("link_open", html, "md")
        elif kind == "link_close":
            close_to("link_open", "md")
        elif kind == "image":
            out.append(esc(_plain_text(token.children or [])))
        elif kind in ("math_inline", "math_inline_double"):
            out.append(math_html(token.content, kind == "math_inline_double"))
        elif kind == "html_inline":
            tag = _allowed_tag(token.content)
            if tag is None:
                out.append(esc(token.content))
            elif tag[0] == "void":
                out.append(f"<{tag[1]}>")
            elif tag[0] == "open" and raw_open >= _RAW_OPEN_MAX:
                out.append(esc(token.content))
            elif tag[0] == "open":
                open_(tag[1], f"<{tag[1]}>", "raw")
            elif not close_to(tag[1], "raw"):
                out.append(esc(token.content))  # a closer with no opener is text
        else:
            out.append(esc(token.content))
    for entry in reversed(stack):
        out.append(_closer(entry))
    return "".join(out)


def _closer(entry: tuple[str, str, str]) -> str:
    name, html, _ = entry
    if not html:
        return ""  # a link rendered as its text only
    if name == "link_open":
        return "</a>"
    tag = re.match(r"<([a-z]+)", html)
    return f"</{tag.group(1)}>" if tag else ""


def _plain_text(children: list[Token]) -> str:
    parts: list[str] = []
    for child in children:
        if child.children:
            parts.append(_plain_text(child.children))
        elif child.type in ("softbreak", "hardbreak"):
            parts.append(" ")
        else:
            parts.append(child.content)
    return "".join(parts)


# --------------------------------------------------------------------------- TeX -> MathML Core
#: A formula longer than this is shown as source; it bounds the converter's work per formula.
TEX_MAX_CHARS = 4000
# Macro definitions can expand exponentially within a few hundred characters: shown as source.
_MACRO_DEF_RE = re.compile(
    r"\\(?:def|edef|gdef|xdef|let|newcommand|renewcommand|providecommand|newenvironment"
    r"|renewenvironment|DeclareMathOperator)(?![A-Za-z])"
)
# latex2mathml has no aligned / gather / equation environments: rewritten to ones it has.
_ENV_RE = re.compile(
    r"\\(begin|end)\s*\{(aligned|alignedat|align\*?|alignat\*?|flalign\*?|gather\*?|gathered"
    r"|multline\*?|equation\*?|displaymath)\}"
)
_ENV_ARG_RE = re.compile(r"\s*(?:\[[tbc]\]|\{\d+\})")
# `\arg` is a standard operator name latex2mathml prints as the literal text "\arg"; a `\label`
# prints nothing in LaTeX, so its key is dropped here too.
_ARG_RE = re.compile(r"\\arg(?![A-Za-z])")
_LABEL_RE = re.compile(r"\\label\s*\{[^{}]*\}")


def _rewrite_tex(tex: str) -> str:
    """The TeX latex2mathml would get wrong, rewritten to TeX it gets right."""
    tex = _LABEL_RE.sub("", _ARG_RE.sub(r"\\operatorname{arg}", tex))
    out: list[str] = []
    pos = 0
    for match in _ENV_RE.finditer(tex):
        out.append(tex[pos : match.start()])
        pos = match.end()
        which, env = match.group(1), match.group(2).rstrip("*")
        if env in ("aligned", "alignedat", "align", "alignat", "flalign"):
            out.append(f"\\{which}{{align*}}")
        elif env in ("gather", "gathered", "multline"):
            out.append("\\displaylines{" if which == "begin" else "}")
        # equation / displaymath: just the formula
        if which == "begin":
            arg = _ENV_ARG_RE.match(tex, pos)
            if arg and env in ("aligned", "alignedat", "alignat", "gathered"):
                pos = arg.end()
    out.append(tex[pos:])
    return "".join(out)


#: MathML Core presentation elements. `menclose` (not in Core) becomes an `mrow` with a class.
_ELEMENTS = frozenset(
    {
        "mrow", "mi", "mn", "mo", "ms", "mtext", "mspace", "msub", "msup", "msubsup", "munder",
        "mover", "munderover", "mmultiscripts", "mprescripts", "none", "mfrac", "msqrt", "mroot",
        "mstyle", "merror", "mpadded", "mphantom", "mtable", "mtr", "mtd",
    }
)  # fmt: skip
#: MathML Core lays these out only with exactly this many children; anything else (a TeX error the
#: converter let through, such as `\frac{a`) is shown as source rather than as a broken formula.
_ARITY = {
    "mfrac": 2, "mroot": 2, "msub": 2, "msup": 2, "munder": 2, "mover": 2,
    "msubsup": 3, "munderover": 3,
}  # fmt: skip
_BOOL_ATTRS = {
    "mo": ("fence", "separator", "stretchy", "symmetric", "largeop", "movablelimits"),
    "mover": ("accent",),
    "munder": ("accentunder",),
    "munderover": ("accent", "accentunder"),
}
#: Lengths each element may keep (an `mpadded`'s are decided by `_mpadded_box`). Only an `mspace`
#: width may be negative, and only within `NEGATIVE_SPACE_MAX_EM` per formula.
_LENGTH_ATTRS = {
    "mo": ("lspace", "rspace", "minsize", "maxsize"),
    "mspace": ("width", "height", "depth"),
    "mfrac": ("linethickness",),
}
#: All the negative space one formula may use (`\!` is a sixth of an em): enough for TeX's own
#: kerning, never enough to draw over more than the symbol beside it. Per value is not enough --
#: twenty `\kern-3em` each pass a per-value cap.
NEGATIVE_SPACE_MAX_EM = 1.0
#: Rough em sizes, used only to charge negative space against that budget.
_EM_PER_UNIT = {
    "em": 1.0,
    "ex": 0.5,
    "px": 1 / 16,
    "pt": 1 / 12,
    "mm": 0.236,
    "cm": 2.36,
    "in": 6.0,
}
_NOT_SLASH = "⧸"  # what latex2mathml overlays for `\not`
_SIGNS = frozenset("+−±∓")
#: Operators after which a sign stays binary (TeX: after a closing atom, `(a)-b`, `n!-1`); after any
#: other operator -- a relation, an opening fence, punctuation, `\sum` -- a sign is unary.
_CLOSING_OPS = frozenset(")]}|!%‖′″⌉⌋⟩")
#: Elements whose children are a row, where a sign at the start is unary.
_ROWS = frozenset({"mrow", "mstyle", "mtd", "msqrt", "mphantom", "merror", "mpadded"})
_NAMED_SPACES = {
    "veryverythinmathspace": 1 / 18,
    "verythinmathspace": 2 / 18,
    "thinmathspace": 3 / 18,
    "mediummathspace": 4 / 18,
    "thickmathspace": 5 / 18,
    "verythickmathspace": 6 / 18,
    "veryverythickmathspace": 7 / 18,
}
_LENGTH_RE = re.compile(r"^(-?)(\d+(?:\.\d*)?|\.\d+)(em|ex|px|pt|mm|cm|in|mu)?$")
#: The most any one length may be, per unit (about 3em): `\hspace{999em}` cannot push text off A4.
_LENGTH_MAX = {"em": 3.0, "ex": 6.0, "px": 48.0, "pt": 36.0, "mm": 12.0, "cm": 1.2, "in": 0.5}
_MENCLOSE_CLASSES = {
    "box": "me-box",
    "roundedbox": "me-box",
    "updiagonalstrike": "me-up",
    "downdiagonalstrike": "me-down",
    "horizontalstrike": "me-h",
}
_MTEXT_CLASSES = {
    "bold": "mv-b",
    "italic": "mv-i",
    "bold-italic": "mv-bi",
    "monospace": "mv-tt",
    "sans-serif": "mv-sf",
}
_ALIGN_CELL = {"left": "ma-l", "right": "ma-r", "center": "ma-c"}
_ENTITY_RE = re.compile(r"&#x([0-9A-Fa-f]{1,6});")


def _decode(text: str | None) -> str:
    """latex2mathml stores glyphs as `&#x…;` placeholders inside element TEXT: decoded once here,
    then escaped on the way out, so no entity but the five `esc()` makes ever reaches the page."""

    def one(match: re.Match[str]) -> str:
        code = int(match.group(1), 16)
        if code < 0x20 or 0xD800 <= code <= 0xDFFF or code > 0x10FFFF or 0x7F <= code < 0xA0:
            return match.group(0)
        return chr(code)

    return _ENTITY_RE.sub(one, text or "")


def _number(value: float) -> str:
    return f"{value:.4f}".rstrip("0").rstrip(".")


def _length(value: str) -> tuple[float, str] | None:
    """`(signed size in em, MathML Core length)`, the size clamped per unit (`_LENGTH_MAX`) and
    rounded as written, so what is charged against a budget is what is drawn; None for anything
    that is not a length MathML Core takes."""
    value = value.strip()
    named = value[8:] if value.startswith("negative") else value
    if named in _NAMED_SPACES:
        number, unit, negative = _NAMED_SPACES[named], "em", named != value
    else:
        match = _LENGTH_RE.match(value)
        if not match:
            return None  # `+2em`, `-1width`, percentages: not a MathML Core length
        sign, number, unit = match.group(1), float(match.group(2)), match.group(3)
        if unit is None:
            return (0.0, "0") if number == 0 else None
        if unit == "mu":
            number, unit = number / 18, "em"
        number = min(number, _LENGTH_MAX[unit])
        negative = bool(sign)
    text = _number(number)
    negative = negative and float(text) > 0
    em = float(text) * _EM_PER_UNIT[unit] * (-1 if negative else 1)
    return em, f"{'-' if negative else ''}{text}{unit}"


def _mpadded_box(el: Element) -> tuple[tuple[str, ...], str]:
    """`(lengths kept, tag)` for an `mpadded`. Its offsets and its box smaller than its ink are what
    let a formula paint outside its own box, and they add up when nested: fourteen `\\raise{3em}`
    drew a forged line over the brand header. So only two harmless boxes keep any size -- around an
    `mphantom`, which paints nothing (`\\vphantom`, `\\mathstrut`), and the zero width `\\not`
    overlays its one slash with. Everything else (`\\raise`, `\\lower`, `\\smash`, `\\rlap`, `\\llap`,
    an arrow's label) is typeset in place, as an `mrow`."""
    kids = list(el)
    if len(kids) == 1 and kids[0].tag == "mphantom":
        return ("width", "height", "depth"), "mpadded"
    if (
        len(kids) == 1
        and kids[0].tag == "mtext"
        and len(kids[0]) == 0
        and _decode(kids[0].text) == _NOT_SLASH
        and el.get("width") == "0"
    ):
        return ("width",), "mpadded"
    return (), "mrow"


# Holes in the Mathematical Alphanumeric block: these letters live in Letterlike Symbols.
_LETTERLIKE = {
    ("ITALIC", "h"): "\u210e",
    ("SCRIPT", "B"): "\u212c", ("SCRIPT", "E"): "\u2130", ("SCRIPT", "F"): "\u2131",
    ("SCRIPT", "H"): "\u210b", ("SCRIPT", "I"): "\u2110", ("SCRIPT", "L"): "\u2112",
    ("SCRIPT", "M"): "\u2133", ("SCRIPT", "R"): "\u211b", ("SCRIPT", "e"): "\u212f",
    ("SCRIPT", "g"): "\u210a", ("SCRIPT", "o"): "\u2134",
    ("FRAKTUR", "C"): "\u212d", ("FRAKTUR", "H"): "\u210c", ("FRAKTUR", "I"): "\u2111",
    ("FRAKTUR", "R"): "\u211c", ("FRAKTUR", "Z"): "\u2128",
    ("DOUBLE-STRUCK", "C"): "\u2102", ("DOUBLE-STRUCK", "H"): "\u210d",
    ("DOUBLE-STRUCK", "N"): "\u2115", ("DOUBLE-STRUCK", "P"): "\u2119",
    ("DOUBLE-STRUCK", "Q"): "\u211a", ("DOUBLE-STRUCK", "R"): "\u211d",
    ("DOUBLE-STRUCK", "Z"): "\u2124",
}  # fmt: skip
_VARIANTS = {
    "bold": "BOLD",
    "italic": "ITALIC",
    "bold-italic": "BOLD ITALIC",
    "double-struck": "DOUBLE-STRUCK",
    "script": "SCRIPT",
    "bold-script": "BOLD SCRIPT",
    "fraktur": "FRAKTUR",
    "bold-fraktur": "BOLD FRAKTUR",
    "sans-serif": "SANS-SERIF",
    "bold-sans-serif": "SANS-SERIF BOLD",
    "sans-serif-italic": "SANS-SERIF ITALIC",
    "sans-serif-bold-italic": "SANS-SERIF BOLD ITALIC",
    "monospace": "MONOSPACE",
}


@lru_cache(maxsize=2048)
def styled_char(variant: str, char: str) -> str:
    """`char` in a math alphabet (`styled_char("bold", "x")` is U+1D431), or `char` unchanged."""
    prefix = _VARIANTS.get(variant)
    if prefix is None or len(char) != 1:
        return char
    if (prefix, char) in _LETTERLIKE:
        return _LETTERLIKE[(prefix, char)]
    try:
        name = unicodedata.name(char)
    except ValueError:
        return char
    for old, new in (
        ("LATIN CAPITAL LETTER ", "CAPITAL "),
        ("LATIN SMALL LETTER ", "SMALL "),
        ("GREEK CAPITAL LETTER ", "CAPITAL "),
        ("GREEK SMALL LETTER ", "SMALL "),
        ("DIGIT ", "DIGIT "),
    ):
        if name.startswith(old):
            try:
                return unicodedata.lookup(f"MATHEMATICAL {prefix} {new}{name[len(old) :]}")
            except KeyError:
                return char
    return char


def _serialize(el: Element, budget: list[float], unary: bool = False) -> str:
    """One element as MathML Core. `budget` is the negative space this formula has left; `unary`
    says a sign here is unary (it starts a row, or follows an operator that is not a closer)."""
    tag = el.tag if isinstance(el.tag, str) else ""
    attrs: dict[str, str] = {}
    classes: list[str] = []
    text = _decode(el.text)
    lengths = _LENGTH_ATTRS.get(tag, ())
    if tag == "menclose":
        classes += [
            _MENCLOSE_CLASSES[n]
            for n in str(el.get("notation", "")).split()
            if n in _MENCLOSE_CLASSES
        ]
        tag = "mrow"
    elif tag == "mpadded":
        lengths, tag = _mpadded_box(el)
    elif tag not in _ELEMENTS:
        tag = "mrow"
    elif tag == "mi" and text in _SIGNS and len(el) == 0:
        tag = "mo"  # latex2mathml writes `\pm` as an identifier: no operator spacing at all
    if tag in _ARITY and len(el) != _ARITY[tag]:
        raise ValueError(f"<{tag}> needs {_ARITY[tag]} children")
    for name in _BOOL_ATTRS.get(tag, ()):
        value = el.get(name)
        if value in ("true", "false"):
            attrs[name] = value
    for name in lengths:
        value = el.get(name)
        parsed = None if value is None else _length(value)
        if parsed is None:
            continue
        em, length = parsed
        if em < 0:
            if (tag, name) != ("mspace", "width"):
                continue  # a negative size, depth or offset only ever moves ink off its box
            if -em > budget[0]:
                left = math.floor(budget[0] * 10_000) / 10_000  # rounded down: never over
                if left <= 0:
                    continue
                em, length = -left, f"-{_number(left)}em"
            budget[0] += em
        attrs[name] = length
    if tag == "mo" and el.get("form") in ("prefix", "infix", "postfix"):
        attrs["form"] = str(el.get("form"))
    if el.get("displaystyle") in ("true", "false"):
        attrs["displaystyle"] = str(el.get("displaystyle"))
    level = str(el.get("scriptlevel", ""))
    if re.fullmatch(r"\+?[0-7]", level):  # never negative: a script level only ever shrinks
        attrs["scriptlevel"] = level
    variant = el.get("mathvariant")
    if variant == "normal" and tag == "mi":
        attrs["mathvariant"] = "normal"
    elif variant and tag in ("mi", "mn", "mo"):
        text = "".join(styled_char(variant, c) for c in text)
    elif variant and tag in ("mtext", "ms") and variant in _MTEXT_CLASSES:
        classes.append(_MTEXT_CLASSES[variant])
    if tag == "mtd" and el.get("columnalign") in _ALIGN_CELL:
        classes.append(_ALIGN_CELL[str(el.get("columnalign"))])
    if tag == "mtable" and str(el.get("columnspacing", "")).startswith("0em"):
        classes.append("mt-align")  # align / split: the r|l column pairs sit flush
    if tag == "mo" and text in _SIGNS and unary and "form" not in attrs:
        attrs["form"] = "prefix"  # `= -2` is set `= −2`, not `= − 2`
    if tag == "mo" and text == "/":
        attrs.setdefault("lspace", "0")  # TeX sets a solidus tight: `1/f²`, not `1 / f²`
        attrs.setdefault("rspace", "0")
    if classes:
        attrs["class"] = " ".join(dict.fromkeys(classes))
    rendered = "".join(f' {name}="{esc(value)}"' for name, value in attrs.items())
    parts = [esc(text)]
    previous: Element | None = None
    for child in el:
        starts_unary = tag in _ROWS and (
            previous is None
            or (previous.tag == "mo" and _decode(previous.text).strip() not in _CLOSING_OPS)
        )
        parts.append(_serialize(child, budget, starts_unary) + esc(_decode(child.tail)))
        previous = child
    return f"<{tag}{rendered}>{''.join(parts)}</{tag}>"


@lru_cache(maxsize=1024)
def math_html(tex: str, display: bool) -> str:
    """One formula as MathML Core, with its TeX in an annotation; an escaped `<code class="tex">`
    for anything the converter cannot take (it never raises)."""
    source = tex.strip()
    try:
        if not source or len(source) > TEX_MAX_CHARS or _MACRO_DEF_RE.search(source):
            raise ValueError("not converted")
        # Imported here: its symbol table is a data file read at import time, and a broken install
        # must cost the formulas, not the backend that imports this module at startup.
        from latex2mathml.converter import convert_to_element

        root = convert_to_element(_rewrite_tex(source), display="block" if display else "inline")
        rows = list(root)
        if len(rows) != 1:
            raise ValueError("unexpected MathML shape")
        presentation = _serialize(rows[0], [NEGATIVE_SPACE_MAX_EM])
    except Exception:  # any failure is shown as source, never as a broken page
        return f'<code class="tex">{esc(source)}</code>'
    mode = ' display="block"' if display else ""
    return (
        f"<math{mode}><semantics>{presentation}"
        f'<annotation encoding="application/x-tex">{esc(source)}</annotation></semantics></math>'
    )
