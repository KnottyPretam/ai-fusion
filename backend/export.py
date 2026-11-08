"""Turn exports (owner: export-backend). Pure document builder for one turn of one conversation.

One conversation turn -- a Send, a solo Continue, an Analyze or a Fusion -- is turned into a
self-contained document in two formats. Both formats are built from ONE intermediate document
model (`build_document`) and then rendered twice (`render_markdown_doc` / `render_html_doc`), so
the Markdown and the HTML can never drift apart: every decision (what a section holds, whether a
model reply is fenced, which metadata line a value lands on) is taken once, in the builder.

    build_document(conv, turn_id) -> Document        # the shared model (404s here)
    render_markdown(conv, turn_id) -> str            # GFM
    render_html(conv, turn_id) -> str                # ONE self-contained HTML document
    filename_for(doc, fmt) -> str                    # the save-dialog default

No I/O and no network: the caller loads the conversation (`store.load`) and hands it over. A
missing conversation (`None`) or an unknown turn id raises `api_errors.not_found`, so the router
stays a three-liner.

PDF is not produced here. The HTML is the print master (embedded CSS, `@page` margins, every
`<details>` rendered open so nothing is lost in a print) and the desktop shell renders it to PDF;
"all three" is three renders of the same document, never three different documents.

ANONYMITY (user decision, binding). An Analyze or Fusion document names R1 / R2 / R3 and nothing
else -- exactly what the panes show. Those two builders never read `slot_config.slots`,
`slot_config.analyst_model` or `SLOT_NAMES`, and `Conversation.anon_map` is never read anywhere in
this module, so no document can map a label back to a vendor. A SEND (or Continue) document does
name the slots -- Claude / ChatGPT / Grok -- because the Send columns are labelled that way on
screen and the export is a copy of what the user is looking at. A PLAN document (2026-09-27) quotes
the procedure and never the model string that wrote it (`PlanTurn.model` can name a vendor, exactly
as `analyst_model` can, and neither ever reaches a document). `tests/export/test_anonymity.py`
is the gate. Out of scope for the leak rule, exactly as in `tests/e2e/test_leaks.py`: the verbatim
user prompt, the conversation title (auto-titled from that prompt) and raw model-authored text
(replies, analyst claims, justifications) -- a model that names a vendor in its own answer is the
model's doing, and the answer is reproduced verbatim on purpose.

QUOTED TEXT. Everything a model or a user wrote is untrusted for the document structure:

* HTML: the document is STATIC -- no script, and a Content-Security-Policy that lets it load
  nothing but its own inline style and the embedded logo -- because the desktop shell prints it to
  PDF with scripting off. Every interpolated value is escaped (`_esc`). A body's `kind` decides how
  it lands, once, in the builder: model PROSE (a reply, a justification, a claim, a plan step;
  `prose()`) is rendered Markdown with typeset math inside `<div class="md">`
  (`export_render.markdown_html`: raw HTML only as an allow-list of attribute-free formatting
  tags, everything else -- `<script>` included -- shown as text); the user's prompt, an error
  message and reasoning are shown as written (`body()`), in `<pre class="body">` -- or in
  `<pre class="code">` when the fence rule below marks them, as it always did; a raw analyst
  attempt is `<pre class="code">`. Prose longer than `export_render.RENDER_MAX_CHARS` is shown as
  written too. A table cell, bullet or checklist item typesets its formulas and is otherwise
  exactly its escaped text (`export_render.inline_html`). Every container of model text clips
  (`overflow: clip`), so nothing it holds -- a formula, a stack of combining marks -- can paint
  over the header or the notice. The document references no external URL of any kind -- no
  stylesheet, font, image or script; the only absolute URLs are anchors: the citation links, and
  the http(s) / mailto links inside a Send or Continue reply (`Body.links`). Every other document
  shows a link's text only. The one other link is the table of contents before the first section
  (2026-10-28): a bare fragment (`#sec-N`) to one of the document's own headings, which loads
  nothing, in every document; the PDF printed from it keeps those links and adds bookmarks.
* Markdown: a quoted body is emitted verbatim -- a model reply IS Markdown, and the panes render
  it with `remark-gfm`, so its own fenced code blocks, lists and tables survive the export. Two
  bodies are wrapped in a fence of their own instead (`Body.code`, decided once in the builder):
  one carrying a raw HTML tag (GFM would pass `<script>` straight through into a rendered page)
  and one whose own fences are left OPEN (everything after it, headings included, would otherwise
  be swallowed into that code block). The wrapping fence is always longer than the longest
  backtick run inside. Inline values (table cells, metadata lines, bullets) are single-lined and
  backslash-escaped.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import Any, Literal
from urllib.parse import urlsplit

from . import anon, api_errors
from .branding import HTML_LOGO_PX, MARKDOWN_LOGO_PX, logo_data_uri
from .config import settings
from .export_render import RENDER_MAX_CHARS, inline_html, markdown_html, safe_href
from .export_render import esc as _esc
from .prompts.council import label_or_list, number_word
from .schemas import (
    LABELS,
    MATERIALITY_RANK,
    SCHEMA_VERSION,
    SLOT_IDS,
    AnalyzeTurn,
    ContinueTurn,
    Conversation,
    Divergence,
    Extraction,
    FusionRound,
    FusionTurn,
    Label,
    PlanTurn,
    RefactorTurn,
    SendTurn,
    SlotConfig,
    SlotId,
    council_of,
)
from .vendors import CATALOG as VENDORS

# ------------------------------------------------------------------ vocabulary / public constants
#: Slot display names, as the Send columns are labelled on screen (frontend `SLOT_LABELS`), from
#: the vendor catalog (2026-09-27: seven vendors, a council seats 2..5 of them).
#: Send / Continue documents only -- never Analyze or Fusion (see the module docstring).
SLOT_NAMES: dict[SlotId, str] = {v.id: v.name for v in VENDORS}

Format = Literal["md", "html"]
FORMATS: tuple[Format, ...] = ("md", "html")
MEDIA_TYPES: dict[Format, str] = {
    "md": "text/markdown; charset=utf-8",
    "html": "text/html; charset=utf-8",
}
EXTENSIONS: dict[Format, str] = {"md": "md", "html": "html"}
# Canonical values are `md` and `html`; the aliases keep an obvious spelling from 422ing.
_FORMAT_ALIASES: dict[str, Format] = {
    "md": "md",
    "markdown": "md",
    "html": "html",
    "htm": "html",
}

DocKind = Literal["send", "continue", "analyze", "fusion", "refactor", "plan"]
KIND_TITLES: dict[str, str] = {
    "send": "Send",
    "continue": "Continue",
    "analyze": "Analyze",
    "fusion": "Fusion",
    "refactor": "Refactor",
    "plan": "Plan",
}

#: The app's own three theme states, so an exported document looks like the app it came from (user
#: request, 2026-09-20). `light`, the default, is `CSS` exactly with no override on top, so a document
#: changes palette only when a theme is asked for. Markdown has no
#: styling at all, so a theme only ever affects the HTML — and the PDF, which is that HTML printed
#: with `printBackground: true` (already the case in desktop/main/export.js, so a dark document really
#: does print dark rather than light-on-white).
Theme = Literal["light", "dark", "system"]
_THEME_ALIASES: dict[str, Theme] = {
    "light": "light",
    "dark": "dark",
    "system": "system",
    "auto": "system",
}

#: The machine-readable marker in the HTML `<head>` (and, as a comment, at the top of the
#: Markdown): the desktop side asserts it rendered the document it asked for.
MARKER_NAME = "triplex-export"
MARKER_VALUE = "triplex"
MARKER_TYPE = "triplex-export-type"
MARKER_TURN = "triplex-export-turn"
MARKER_CONVERSATION = "triplex-export-conversation"
MARKER_SCHEMA = "triplex-export-schema"

#: The caption the Analyze pane puts on its agreements; it travels with them into the document.
CONVERGENCE_CAPTION = "convergence, not verified truth"
UNJUSTIFIED_CAPTION = (
    "resolved only through revisions flagged as unjustified — not counted as clean convergence"
)

#: `FusionTurn.exit_reason` spelled out in words (docs/semantics.md "Fusion").
EXIT_REASONS: dict[str, str] = {
    "converged": "converged — every standing divergence was resolved before the round limit",
    "stalemate": (
        "stalemate — a round came back with every challenged model defending its claim, so no "
        "revision was on the table and the run stopped"
    ),
    "max_iterations": (
        "max iterations — the round limit was reached with at least one divergence still standing"
    ),
    "error": (
        "error — every challenge in a round came back unavailable, so the run stopped before any "
        "convergence check"
    ),
}
STATUS_WORDS: dict[str, str] = {
    "resolved": "resolved",
    "resolved_unjustified": "resolved (unjustified)",
    "standing": "standing",
}
STANCE_WORDS: dict[str, str] = {
    "defend": "defend",
    "revise": "revise",
    "unavailable": "unavailable",
}
NONE_GIVEN = "(none given)"


# --------------------------------------------------------------------------- document model
@dataclass(frozen=True)
class Heading:
    """A section heading. `text` may be quoted text (a topic, a title): inline-escaped."""

    text: str
    level: int = 2


@dataclass(frozen=True)
class Para:
    """Triplex-authored prose (never quoted text)."""

    text: str


@dataclass(frozen=True)
class Caption:
    """Triplex-authored small print: the convergence caption, a threshold note."""

    text: str


@dataclass(frozen=True)
class Meta:
    """A compact metadata line: `label: value` pairs. Values are inline-escaped quoted text."""

    items: tuple[tuple[str, str], ...]


@dataclass(frozen=True)
class Body:
    """Quoted block text (a prompt, a reply, a justification, a raw analyst attempt).

    Everything is decided ONCE, by `body()` / `prose()`, and both renderers only read it:

    * `code` -- the MARKDOWN decision: a body carrying a raw HTML tag, or one whose own code fences
      are left open, is wrapped in a fence of its own; anything else is emitted verbatim.
    * `kind` -- the HTML decision: `"markdown"` (model prose, `prose()`) is rendered Markdown with
      typeset math in `<div class="md">` -- or, past `RENDER_MAX_CHARS`, shown as written like the
      other two; `"plain"` is `<pre class="body">`; `"code"` is `<pre class="code">`. `body()`
      makes a raw attempt `"code"`, and any other body it shows as written (a prompt, an error,
      reasoning) `"code"` when `code` is set, else `"plain"` -- what the HTML always did.
    * `links` -- a `"markdown"` body's http(s) / mailto links become anchors (Send and Continue
      replies only); everywhere else a link is its text."""

    text: str
    code: bool = False
    kind: Literal["plain", "markdown", "code"] = "plain"
    links: bool = False


@dataclass(frozen=True)
class Bullet:
    text: str
    lead: str | None = None
    tags: tuple[str, ...] = ()


@dataclass(frozen=True)
class Bullets:
    items: tuple[Bullet, ...]


@dataclass(frozen=True)
class Checklist:
    """A task list (the plan's "done when", 2026-09-27): unticked boxes in both renderings -- a GFM
    task list in Markdown, disabled checkboxes in HTML -- so a printed copy can be ticked by hand
    and a Markdown viewer shows boxes rather than bullets. Items are quoted text, inline-escaped."""

    items: tuple[str, ...]


@dataclass(frozen=True)
class Table:
    headers: tuple[str, ...]
    rows: tuple[tuple[str, ...], ...]


@dataclass(frozen=True)
class Link:
    label: str
    href: str | None  # None: not an http(s) url, so not a link (shown as text)
    note: str | None = None


@dataclass(frozen=True)
class Links:
    """Citations, as an ordered list of plain anchors (with a Send or Continue reply's own links,
    the only external URLs in the document)."""

    items: tuple[Link, ...]


@dataclass(frozen=True)
class Details:
    """A disclosure block (reasoning, raw analyst attempts). Rendered OPEN so a print keeps it."""

    summary: str
    blocks: tuple[Any, ...]


@dataclass(frozen=True)
class Document:
    kind: DocKind
    turn_id: str
    conversation_id: str
    conversation_title: str
    title: str  # the <title> / H1: "<app title> Send — <conversation title>"
    ts: str  # the turn's ISO timestamp
    blocks: tuple[Any, ...] = field(default_factory=tuple)

    @property
    def stem(self) -> str:
        """The save-dialog default filename without its extension."""
        parts = ["triplex", self.kind, _slug(self.conversation_title)]
        stamp = _stamp(self.ts)
        if stamp:
            parts.append(stamp)
        return "-".join(parts)


# --------------------------------------------------------------------------- escaping helpers
# A raw HTML tag or a code fence: both make a Markdown body unsafe to emit verbatim.
_HTML_TAG_RE = re.compile(r"</?[A-Za-z][A-Za-z0-9:-]*(?:\s[^<>]*)?/?>|<!--")
_FENCE_LINE_RE = re.compile(r"^\s{0,3}(`{3,}|~{3,})")
# Backslash-escaped in inline positions. `_` is left alone on purpose: CommonMark never treats an
# intraword underscore as emphasis, and escaping it would mangle every snake_case code.
_MD_INLINE_RE = re.compile(r"([\\`*\[\]<>|~])")
_WS_RE = re.compile(r"\s+")
_SLUG_RE = re.compile(r"[A-Za-z0-9]+")


def _one_line(value: Any) -> str:
    return _WS_RE.sub(" ", "" if value is None else str(value)).strip()


def _md_inline(value: Any) -> str:
    """One line, with every Markdown/HTML-significant character backslash-escaped."""
    return _MD_INLINE_RE.sub(r"\\\1", _one_line(value))


def _fence_left_open(text: str) -> bool:
    """True when the body's own code fences never close: emitting it verbatim would swallow every
    heading after it into that block."""
    open_marker: str | None = None
    for line in text.splitlines():
        match = _FENCE_LINE_RE.match(line)
        if not match:
            continue
        marker = match.group(1)
        if open_marker is None:
            open_marker = marker
        elif marker[0] == open_marker[0] and len(marker) >= len(open_marker):
            open_marker = None
    return open_marker is not None


def _needs_fence(raw: str) -> bool:
    return bool(_HTML_TAG_RE.search(raw)) or _fence_left_open(raw)


def body(text: Any, *, code: bool | None = None) -> Body:
    """A quoted block shown as written (a prompt, an error, reasoning; `code=True`: a raw attempt),
    with the fence decision taken once for both renderers."""
    raw = "" if text is None else str(text)
    if code is None:
        code = _needs_fence(raw)
    return Body(raw.rstrip(), code=code, kind="code" if code else "plain")


def prose(text: Any, *, links: bool = False) -> Body:
    """Model-authored Markdown (a reply, a claim, a justification, a plan step): verbatim in the
    Markdown -- fenced exactly as `body()` would -- and rendered, math typeset, in the HTML."""
    raw = "" if text is None else str(text)
    return Body(raw.rstrip(), code=_needs_fence(raw), kind="markdown", links=links)


def _fence(text: str) -> str:
    """A fence longer than the longest backtick run inside `text` (never shorter than three)."""
    longest = max((len(m) for m in re.findall(r"`+", text)), default=0)
    return "`" * max(3, longest + 1)


def _slug(text: str, limit: int = 40) -> str:
    ascii_only = unicodedata.normalize("NFKD", text or "").encode("ascii", "ignore").decode("ascii")
    slug = "-".join(_SLUG_RE.findall(ascii_only.lower()))[:limit].strip("-")
    return slug or "conversation"


def _stamp(ts: str) -> str:
    digits = re.sub(r"\D", "", ts or "")
    return f"{digits[:8]}-{digits[8:14]}" if len(digits) >= 14 else ""


def _domain(url: str) -> str:
    host = urlsplit(url).netloc.lower()
    return host[4:] if host.startswith("www.") else host or url


def normalise_format(value: str | None) -> Format:
    """`md` / `html` (plus the obvious aliases); anything else is 422 `unknown_format`.

    Only an ABSENT format (`None`) defaults to Markdown: an explicit `?format=` that is empty or
    misspelled is a client bug and says so, instead of silently exporting the wrong thing."""
    fmt = _FORMAT_ALIASES.get("md" if value is None else value.strip().lower())
    if fmt is None:
        raise api_errors.unprocessable(
            "unknown_format", format=str(value), supported=list(FORMATS)
        )
    return fmt


# --------------------------------------------------------------------------- turn lookup
def normalise_theme(value: str | None) -> Theme:
    """`light` (the default and the historical rendering), `dark`, or `system`. An unknown value is
    `light` rather than a 422: a document is worth having in the wrong palette."""
    if value is None:
        return "light"
    return _THEME_ALIASES.get(str(value).strip().lower(), "light")


def _turn_by_id(conv: Conversation, turn_id: str) -> Any | None:
    for turn in conv.turns:
        if turn.id == turn_id:
            return turn
    return None


# The codes the LLM layer mints (backend/llm/errors.py -- pure, no transport imports). A persisted
# `SendTurn.errors[slot]` is `terminal.message or str(terminal.code)`, i.e. the MESSAGE when there
# was one, so the code is recovered from the message when it is in there (or is the whole of it).
def _error_codes() -> tuple[str, ...]:
    from .llm import errors as llm_errors

    return (
        llm_errors.COST_CAP_EXCEEDED,
        llm_errors.MISSING_API_KEY,
        llm_errors.TIMEOUT,
        llm_errors.TRANSPORT_ERROR,
        llm_errors.HTTP_ERROR,
        llm_errors.MOCK_MISS,
        llm_errors.PARSE_ERROR,
        llm_errors.VALIDATION_ERROR,
        llm_errors.EMPTY_REPLY,
    )


def error_code_of(message: str | None) -> str | None:
    """The minted error code inside a persisted error message, when one is recognisable."""
    text = (message or "").strip()
    if not text:
        return None
    if re.fullmatch(r"[a-z][a-z0-9_]{2,40}", text):
        return text
    for code in _error_codes():
        if re.search(rf"(?<![A-Za-z0-9_]){re.escape(code)}(?![A-Za-z0-9_])", text):
            return code
    return None


def _links(citations: list[dict[str, Any]]) -> Links:
    items: list[Link] = []
    for raw in citations or []:
        cite = (raw or {}).get("url_citation") or {}
        url = cite.get("url")
        href = safe_href(url)
        label = _domain(href) if href else (url if isinstance(url, str) and url else "(no url)")
        title = cite.get("title")
        items.append(Link(label=label, href=href, note=title if isinstance(title, str) else None))
    return Links(tuple(items))


def _usage_blocks(turn: Any) -> list[Any]:
    """The turn's usage TOTALS only: the per-call rows carry `model`/`role`, which would name a
    vendor and a slot inside an Analyze or Fusion document."""
    totals = turn.usage.totals
    if not totals.calls:
        return []
    tokens = f"{totals.prompt_tokens} in / {totals.completion_tokens} out"
    if totals.reasoning_tokens:
        tokens += f" / {totals.reasoning_tokens} reasoning"
    return [
        Heading("Usage", 2),
        Meta(
            (
                ("tokens", tokens),
                ("cost", f"${totals.cost_usd:.4f}"),
                ("latency", f"{totals.latency_ms} ms"),
                ("model calls", str(totals.calls)),
            )
        ),
    ]


def _header(conv: Conversation, turn: Any, extra: tuple[tuple[str, str], ...] = ()) -> Meta:
    items: tuple[tuple[str, str], ...] = (
        ("conversation", conv.title),
        ("conversation id", conv.id),
        ("turn", turn.id),
        ("turn type", turn.type),
        ("timestamp", turn.ts),
    )
    return Meta(items + extra)


def anon_note(n: int) -> str:
    """The anonymity caption for a council of n (`ANON_NOTE` is n=3, byte for byte as before)."""
    return (
        f"Each model is shown as {label_or_list(n)}, exactly as the pane shows it. Which model is "
        "behind which label is not part of this document."
    )


ANON_NOTE = anon_note(3)


def council_size(cfg: SlotConfig) -> int:
    """How many agents the turn's own config seats (every turn stamps its `slot_config`)."""
    return len(council_of(cfg))


def others_not_called(n: int) -> str:
    """The Continue document's aside for a council of n: "the other two slots were not called."
    for the three (byte for byte as before), "the other slot was not called." for a pair."""
    k = n - 1
    if k == 1:
        return "the other slot was not called."
    return f"the other {number_word(k)} slots were not called."


# --------------------------------------------------------------------------- send / continue
def _slot_section(
    *,
    name: str,
    model: str,
    effort_configured: str,
    effort_applied: str | None,
    grounded: bool,
    reply: str | None,
    error: str | None,
    partial: str,
    truncated: bool,
    citations: list[dict[str, Any]],
    reasoning: str,
) -> list[Any]:
    """One named slot: the compact metadata line, then the reply (or the failure), then the
    extras. Nothing but the reply itself ever lands in the body of the reply."""
    applied = effort_applied or effort_configured
    effort = applied if applied == effort_configured else f"{applied} (configured: {effort_configured})"
    meta: list[tuple[str, str]] = [
        ("model", model),
        ("effort", effort),
        ("outcome", "reply" if reply else "no reply"),
    ]
    if grounded:
        meta.append(("grounded", "on"))
    if truncated:
        meta.append(("truncated", "yes — the reply hit the token limit"))
    out: list[Any] = [Heading(name, 2), Meta(tuple(meta))]
    if reply:
        out.append(prose(reply, links=True))
    if error:
        out.append(Heading("Error", 3))
        code = error_code_of(error)
        if code:
            out.append(Meta((("error code", code),)))
        out.append(body(error))
        if partial.strip():
            out.append(Heading("Partial text received before the failure", 3))
            out.append(prose(partial, links=True))
    if citations:
        out.append(Heading("Citations", 3))
        out.append(_links(citations))
    if reasoning.strip():
        out.append(Details("Reasoning", (body(reasoning),)))
    return out


def _send_blocks(conv: Conversation, turn: SendTurn) -> list[Any]:
    slots = [s for s in SLOT_IDS if s in turn.responses or s in turn.errors]
    extra: tuple[tuple[str, str], ...] = (
        ("slots", ", ".join(SLOT_NAMES[s] for s in slots) or "(none)"),
    )
    if turn.slot_config.grounded:
        extra += (("grounded", "on"),)
    out: list[Any] = [_header(conv, turn, extra), Heading("Prompt", 2), body(turn.prompt)]
    for slot in slots:
        spec = turn.slot_config.slots[slot]
        out.extend(
            _slot_section(
                name=SLOT_NAMES[slot],
                model=spec.model,
                effort_configured=spec.effort,
                effort_applied=turn.effort_applied.get(slot),
                grounded=turn.slot_config.grounded,
                reply=turn.responses.get(slot),
                error=turn.errors.get(slot),
                partial=turn.partial.get(slot, ""),
                truncated=bool(turn.truncated.get(slot)),
                citations=turn.citations.get(slot, []),
                reasoning=turn.reasoning.get(slot, ""),
            )
        )
    out.extend(_usage_blocks(turn))
    return out


def _continue_blocks(conv: Conversation, turn: ContinueTurn) -> list[Any]:
    spec = turn.slot_config.slots[turn.slot]
    extra: tuple[tuple[str, str], ...] = (("slot", SLOT_NAMES[turn.slot]),)
    if turn.slot_config.grounded:
        extra += (("grounded", "on"),)
    out: list[Any] = [
        _header(conv, turn, extra),
        Para(
            f"A solo continuation of the {SLOT_NAMES[turn.slot]} thread; "
            + others_not_called(council_size(turn.slot_config))
        ),
        Heading("Prompt", 2),
        body(turn.prompt),
    ]
    out.extend(
        _slot_section(
            name=SLOT_NAMES[turn.slot],
            model=spec.model,
            effort_configured=spec.effort,
            effort_applied=turn.effort_applied,
            grounded=turn.slot_config.grounded,
            reply=turn.response,
            error=turn.error,
            partial="",
            truncated=bool(turn.truncated),
            citations=turn.citations,
            reasoning=turn.reasoning or "",
        )
    )
    out.extend(_usage_blocks(turn))
    return out


# --------------------------------------------------------------------------- analyze
def _ordered_positions(divergence: Divergence) -> list[Any]:
    """R1, R2, R3 order first (deterministic), then any label the analyst invented."""
    order = {label: i for i, label in enumerate(LABELS)}
    return sorted(divergence.positions, key=lambda p: order.get(p.model, len(order)))


def _labels_with_position(divergence: Divergence) -> list[Label]:
    seen: list[Label] = []
    for position in _ordered_positions(divergence):
        if position.model not in seen:
            seen.append(position.model)
    return seen


def _divergence_blocks(extraction: Extraction, materiality_min: str) -> list[Any]:
    min_rank = MATERIALITY_RANK.get(materiality_min, MATERIALITY_RANK["medium"])
    out: list[Any] = [
        Heading("Divergences", 2),
        Caption(f'rows below materiality "{materiality_min}" are not fused'),
    ]
    if not extraction.divergences:
        out.append(Para("No divergences were identified."))
        return out
    out.append(
        Table(
            ("id", "topic", "materiality", "fused"),
            tuple(
                (
                    d.id,
                    d.topic,
                    d.materiality,
                    "yes" if MATERIALITY_RANK.get(d.materiality, -1) >= min_rank else "no",
                )
                for d in extraction.divergences
            ),
        )
    )
    for d in extraction.divergences:
        fused = MATERIALITY_RANK.get(d.materiality, -1) >= min_rank
        out.append(Heading(f"{d.id} — {d.topic}", 3))
        out.append(Meta((("materiality", d.materiality), ("fused", "yes" if fused else "no"))))
        out.append(
            Table(
                ("model", "claim", "evidence cited"),
                tuple(
                    (p.model, p.claim, p.evidence_cited or NONE_GIVEN)
                    for p in _ordered_positions(d)
                ),
            )
        )
    return out


REFACTOR_NOTE = (
    "This is the refactored view of one Send: what the question is about, the question restated, "
    "and each response reduced to its substance. Analyze compares this version, so it is the input "
    "to everything that follows."
)
GRAPH_NOTE = (
    "The question's own structure: the things it involves, and how they relate. Two answers can "
    "only disagree once they are about the same thing."
)


def _refactor_blocks(conv: Conversation, turn: Any) -> list[Any]:
    """The Refactor document: the graph, the restated question, and ALL THREE reduced responses in one
    document (the user's request). R-labels only, exactly as in `_analyze_blocks` — never
    `slot_config.slots` / `analyst_model` (module docstring, "ANONYMITY")."""
    out: list[Any] = [
        _header(
            conv,
            turn,
            (("status", turn.status), ("refactored send turn", turn.of_turn)),
        ),
        Para(REFACTOR_NOTE),
        Para(anon_note(council_size(turn.slot_config))),
    ]
    of_turn = _turn_by_id(conv, turn.of_turn)
    out.append(Heading("The question as asked", 2))
    if isinstance(of_turn, SendTurn):
        out.append(Meta((("send turn", of_turn.id), ("sent", of_turn.ts))))
        out.append(body(of_turn.prompt))
    else:
        out.append(Para("That Send turn is no longer part of this conversation."))

    ref = turn.refactoring
    if ref is None:
        out.append(Heading("Degraded", 2))
        out.append(
            Para(
                "The analyst did not return a usable refactoring, so this turn carries none. "
                "Analyze falls back to comparing the responses as they were sent."
            )
        )
        if turn.error:
            # A transport's own message can name the SITE ("capture is off for claude; …"):
            # scrubbed, like every model-authored string the document quotes.
            out.append(body(anon.scrub(turn.error)))
        attempts = turn.raw_attempts
        inner: list[Any] = []
        for i, attempt in enumerate(attempts, start=1):
            inner.append(Heading(f"attempt {i}", 4))
            inner.append(body(attempt or "(no output)", code=True))
        out.append(Details(f"raw analyst attempts ({len(attempts)})", tuple(inner)))
        out.extend(_usage_blocks(turn))
        return out

    out.append(Heading("The question, restated", 2))
    out.append(prose(ref.question))

    out.append(Heading("What the question is about", 2))
    out.append(Para(GRAPH_NOTE))
    if ref.graph.nodes:
        out.append(
            Table(
                ("id", "thing", "kind"),
                tuple((n.id, n.label, n.kind or NONE_GIVEN) for n in ref.graph.nodes),
            )
        )
    if ref.graph.edges:
        labels = {n.id: n.label for n in ref.graph.nodes}
        out.append(
            Table(
                ("from", "relation", "to"),
                tuple(
                    (labels.get(e.source, e.source), e.relation, labels.get(e.target, e.target))
                    for e in ref.graph.edges
                ),
            )
        )
    if not ref.graph.nodes and not ref.graph.edges:
        out.append(Para("The analyst returned no graph for this question."))

    out.append(Heading(f"The {number_word(council_size(turn.slot_config))} responses, reduced", 2))
    for reply in ref.replies:
        out.append(Heading(reply.model, 3))
        if reply.summary:
            out.append(prose(reply.summary))
        if reply.claims:
            out.append(Bullets(tuple(Bullet(text=c) for c in reply.claims)))
    out.extend(_usage_blocks(turn))
    return out


def _analyze_blocks(conv: Conversation, turn: AnalyzeTurn) -> list[Any]:
    # NEVER read slot_config.slots / slot_config.analyst_model here: an Analyze document is
    # R-labels only (module docstring, "ANONYMITY").
    out: list[Any] = [
        _header(
            conv,
            turn,
            (
                ("status", turn.status),
                ("analysed send turn", turn.of_turn),
                ("materiality threshold", turn.slot_config.materiality_min),
            ),
        ),
        Para(anon_note(council_size(turn.slot_config))),
        Heading("The Send that was analysed", 2),
    ]
    of_turn = _turn_by_id(conv, turn.of_turn)
    if isinstance(of_turn, SendTurn):
        out.append(Meta((("send turn", of_turn.id), ("sent", of_turn.ts))))
        out.append(body(of_turn.prompt))
    else:
        out.append(Para("That Send turn is no longer part of this conversation."))

    if turn.status == "degraded" or turn.extraction is None:
        out.append(Heading("Degraded", 2))
        out.append(
            Para(
                "The analyst did not return a valid extraction after one retry, so this turn "
                "carries no report and Fusion is disabled for it."
            )
        )
        if turn.error:
            out.append(body(turn.error))
        attempts = turn.raw_attempts
        inner: list[Any] = []
        for i, attempt in enumerate(attempts, start=1):
            inner.append(Heading(f"attempt {i}", 4))
            inner.append(body(attempt or "(no output)", code=True))
        out.append(Details(f"raw analyst attempts ({len(attempts)})", tuple(inner)))
        out.extend(_usage_blocks(turn))
        return out

    extraction = turn.extraction
    out.append(Heading("Agreements", 2))
    out.append(Caption(CONVERGENCE_CAPTION))
    if not extraction.agreements:
        out.append(Para("No agreements were identified."))
    else:
        out.append(
            Bullets(
                tuple(
                    Bullet(text=a.statement, lead=a.topic, tags=tuple(a.models))
                    for a in extraction.agreements
                )
            )
        )
    out.extend(_divergence_blocks(extraction, turn.slot_config.materiality_min))
    out.extend(_usage_blocks(turn))
    return out


# --------------------------------------------------------------------------- fusion
def _exchanges_of(
    rounds: list[FusionRound], divergence_id: str, label: str | None = None
) -> list[Any]:
    out: list[Any] = []
    for rnd in rounds:
        for exchange in rnd.exchanges:
            if exchange.divergence_id == divergence_id and (
                label is None or exchange.model == label
            ):
                out.append(exchange)
    return out


def latest_claim(rounds: list[FusionRound], divergence: Divergence, label: str) -> str:
    """The label's most recent revised claim, else its claim from the extraction (mirrors the
    Fusion pane's `latestClaim`)."""
    revises = [
        e
        for e in _exchanges_of(rounds, divergence.id, label)
        if e.stance == "revise" and e.revised_claim
    ]
    if revises:
        return revises[-1].revised_claim
    for position in divergence.positions:
        if position.model == label:
            return position.claim
    return NONE_GIVEN


def latest_justification(rounds: list[FusionRound], divergence: Divergence, label: str) -> str:
    """The label's most recent spoken justification, else its cited evidence (mirrors the Fusion
    pane's `latestJustification`)."""
    spoken = [
        e
        for e in _exchanges_of(rounds, divergence.id, label)
        if e.stance != "unavailable" and e.justification
    ]
    if spoken:
        return spoken[-1].justification
    for position in divergence.positions:
        if position.model == label:
            return position.evidence_cited or NONE_GIVEN
    return NONE_GIVEN


def _round_blocks(rnd: FusionRound) -> list[Any]:
    out: list[Any] = [Heading(f"Round {rnd.round}", 2)]
    out.append(
        Table(
            ("divergence", "model", "stance", "confidence", "flagged unjustified"),
            tuple(
                (
                    e.divergence_id,
                    e.model,
                    STANCE_WORDS.get(e.stance, e.stance),
                    "—" if e.confidence is None else f"{e.confidence:.2f}",
                    "yes" if e.flagged_unjustified else "no",
                )
                for e in rnd.exchanges
            ),
        )
    )
    for exchange in rnd.exchanges:
        stance = STANCE_WORDS.get(exchange.stance, exchange.stance)
        out.append(Heading(f"{exchange.divergence_id} · {exchange.model} · {stance}", 3))
        if exchange.stance == "unavailable":
            out.append(
                Para("This model could not be reached for this divergence in this round; nothing was appended to its thread.")
            )
            if exchange.error:
                code = error_code_of(exchange.error)
                if code:
                    out.append(Meta((("error code", code),)))
                out.append(body(exchange.error))
            continue
        meta: list[tuple[str, str]] = [("stance", stance)]
        if exchange.confidence is not None:
            meta.append(("confidence", f"{exchange.confidence:.2f}"))
        if exchange.flagged_unjustified:
            meta.append(("flagged", "unjustified revision"))
        out.append(Meta(tuple(meta)))
        if exchange.flagged_unjustified:
            out.append(
                Caption(
                    "flagged by the anti-sycophancy rule: a revision with no substantive "
                    "justification or no named peer argument"
                )
            )
        out.append(prose(exchange.justification or NONE_GIVEN))
        if exchange.revised_claim:
            out.append(Heading("Revised claim", 4))
            out.append(prose(exchange.revised_claim))
        if exchange.persuaded_by:
            out.append(Heading("Persuaded by", 4))
            out.append(prose(exchange.persuaded_by))
    out.append(
        Table(
            ("divergence", f"status after round {rnd.round}"),
            tuple((s.divergence_id, STATUS_WORDS.get(s.status, s.status)) for s in rnd.post_round_status),
        )
    )
    out.append(Meta((("anything changed this round", "yes" if rnd.changed else "no"),)))
    return out


def _fusion_blocks(conv: Conversation, turn: FusionTurn) -> list[Any]:
    # R-labels only, exactly as in _analyze_blocks: never slot_config.slots / analyst_model.
    analyze = _turn_by_id(conv, turn.of_analyze)
    extraction = analyze.extraction if isinstance(analyze, AnalyzeTurn) else None
    divergences: dict[str, Divergence] = (
        {d.id: d for d in extraction.divergences} if extraction else {}
    )
    out: list[Any] = [
        _header(
            conv,
            turn,
            (
                ("fused analyze turn", turn.of_analyze),
                ("rounds", f"{len(turn.rounds)} of {turn.max_iterations}"),
                ("exit reason", turn.exit_reason),
            ),
        ),
        Para(anon_note(council_size(turn.slot_config))),
        Heading("The Analyze that was fused", 2),
    ]
    if isinstance(analyze, AnalyzeTurn):
        out.append(Meta((("analyze turn", analyze.id), ("analysed at", analyze.ts))))
        send = _turn_by_id(conv, analyze.of_turn)
        if isinstance(send, SendTurn):
            out.append(Caption("the prompt behind it"))
            out.append(body(send.prompt))
    else:
        out.append(Para("That Analyze turn is no longer part of this conversation."))

    out.append(Heading("Standing divergences at the start", 2))
    if not turn.standing:
        out.append(Para("No divergence was standing."))
    else:
        out.append(
            Bullets(
                tuple(
                    Bullet(
                        text=divergences[d].topic if d in divergences else "(topic unavailable)",
                        lead=d,
                    )
                    for d in turn.standing
                )
            )
        )

    for rnd in turn.rounds:
        out.extend(_round_blocks(rnd))

    out.append(Heading("Final report", 2))
    out.append(
        Table(
            ("divergence", "topic", "status"),
            tuple(
                (
                    s.divergence_id,
                    divergences[s.divergence_id].topic
                    if s.divergence_id in divergences
                    else "(topic unavailable)",
                    STATUS_WORDS.get(s.status, s.status),
                )
                for s in turn.final
            ),
        )
    )
    out.append(Meta((("exit reason", turn.exit_reason),)))
    out.append(Para(EXIT_REASONS.get(turn.exit_reason, turn.exit_reason)))
    for status in turn.final:
        divergence = divergences.get(status.divergence_id)
        topic = divergence.topic if divergence else "(topic unavailable)"
        out.append(Heading(f"{status.divergence_id} — {topic}", 3))
        out.append(Meta((("status", STATUS_WORDS.get(status.status, status.status)),)))
        if status.status == "resolved":
            out.append(Caption(CONVERGENCE_CAPTION))
        elif status.status == "resolved_unjustified":
            out.append(Caption(UNJUSTIFIED_CAPTION))
        elif divergence is not None:
            out.append(Caption("still standing — both sides, with their latest words"))
            for label in _labels_with_position(divergence):
                out.append(Heading(label, 4))
                out.append(Caption("latest claim"))
                out.append(prose(latest_claim(turn.rounds, divergence, label)))
                out.append(Caption("latest justification"))
                out.append(prose(latest_justification(turn.rounds, divergence, label)))
    out.extend(_usage_blocks(turn))
    return out


# --------------------------------------------------------------------------- plan
PLAN_DEGRADED_NOTE = (
    "The plan model did not return a usable procedure after one retry, so this turn carries no plan."
)


def _plan_blocks(conv: Conversation, turn: PlanTurn) -> list[Any]:
    """The Plan document (2026-09-27): the procedure as a table and a checklist. NEVER `turn.model`
    (module docstring, "ANONYMITY": the model string can name a vendor, exactly as `analyst_model`
    can, and the Analyze / Fusion / Refactor documents carry neither)."""
    out: list[Any] = [
        _header(
            conv,
            turn,
            (("planned fusion turn", turn.of_fusion), ("status", turn.status)),
        )
    ]
    plan = turn.plan
    if turn.status == "degraded" or plan is None:
        out.append(Heading("Degraded", 2))
        out.append(Para(PLAN_DEGRADED_NOTE))
        if turn.error:
            # The bridge's errors name the site the plan was typed into ("capture is off for
            # claude; …", "site_error on claude"): scrubbed, never verbatim.
            out.append(body(anon.scrub(turn.error)))
        attempts = turn.raw_attempts
        inner: list[Any] = []
        for i, attempt in enumerate(attempts, start=1):
            inner.append(Heading(f"attempt {i}", 4))
            inner.append(body(attempt or "(no output)", code=True))
        out.append(Details(f"raw attempts ({len(attempts)})", tuple(inner)))
        out.extend(_usage_blocks(turn))
        return out

    out.append(Heading("Objective", 2))
    out.append(prose(plan.objective))

    out.append(Heading("Prerequisites", 2))
    if plan.prerequisites:
        out.append(Bullets(tuple(Bullet(text=p) for p in plan.prerequisites)))
    else:
        out.append(Para("(none)"))

    out.append(Heading("Procedure", 2))
    if not plan.steps:
        out.append(Para("(no steps)"))
    else:
        out.append(
            Table(
                ("#", "step", "action", "verify"),
                tuple((str(s.number), s.title, s.action, s.verify or NONE_GIVEN) for s in plan.steps),
            )
        )
        for step in plan.steps:
            out.append(Heading(f"{step.number}. {step.title}", 3))
            out.append(Caption("action"))
            out.append(prose(step.action))
            if step.why.strip():
                out.append(Caption("why"))
                out.append(prose(step.why))
            if step.inputs:
                out.append(Caption("inputs"))
                out.append(Bullets(tuple(Bullet(text=x) for x in step.inputs)))
            if step.outputs:
                out.append(Caption("outputs"))
                out.append(Bullets(tuple(Bullet(text=x) for x in step.outputs)))
            if step.verify.strip():
                out.append(Caption("verify"))
                out.append(prose(step.verify))

    out.append(Heading("Decision points", 2))
    if not plan.decisions:
        out.append(Para("(none)"))
    for decision in plan.decisions:
        title = decision.topic
        if decision.divergence_id:
            title = f"{decision.divergence_id} — {decision.topic}"
        out.append(Heading(title, 3))
        if decision.options:
            out.append(Caption("options"))
            out.append(Bullets(tuple(Bullet(text=o) for o in decision.options)))
        if decision.recommendation.strip():
            out.append(Caption("recommendation"))
            out.append(prose(decision.recommendation))
        if decision.rationale.strip():
            out.append(Caption("rationale"))
            out.append(prose(decision.rationale))

    out.append(Heading("Risks", 2))
    if plan.risks:
        out.append(
            Bullets(
                tuple(
                    Bullet(text=r.mitigation or NONE_GIVEN, lead=r.risk) for r in plan.risks
                )
            )
        )
    else:
        out.append(Para("(none)"))

    out.append(Heading("Done when", 2))
    if plan.done_when:
        out.append(Checklist(tuple(plan.done_when)))
    else:
        out.append(Para("(none)"))
    out.extend(_usage_blocks(turn))
    return out


# --------------------------------------------------------------------------- public builder
def build_document(conv: Conversation | None, turn_id: str) -> Document:
    """The shared document model for one turn. 404 for an unknown conversation or turn."""
    if conv is None:
        raise api_errors.not_found("conversation")
    turn = _turn_by_id(conv, turn_id)
    if turn is None:
        raise api_errors.not_found("turn")
    if isinstance(turn, SendTurn):
        blocks = _send_blocks(conv, turn)
    elif isinstance(turn, ContinueTurn):
        blocks = _continue_blocks(conv, turn)
    elif isinstance(turn, AnalyzeTurn):
        blocks = _analyze_blocks(conv, turn)
    elif isinstance(turn, FusionTurn):
        blocks = _fusion_blocks(conv, turn)
    elif isinstance(turn, RefactorTurn):
        blocks = _refactor_blocks(conv, turn)
    elif isinstance(turn, PlanTurn):
        blocks = _plan_blocks(conv, turn)
    else:  # unreachable: the Turn union is closed
        raise api_errors.not_found("turn")
    return Document(
        kind=turn.type,
        turn_id=turn.id,
        conversation_id=conv.id,
        conversation_title=conv.title,
        title=f"{settings().app_title} {KIND_TITLES[turn.type]} — {conv.title}",
        ts=turn.ts,
        blocks=tuple(blocks),
    )


def filename_for(doc: Document, fmt: Format) -> str:
    """The save-dialog default: `triplex-<kind>-<title slug>-<YYYYMMDD-HHMMSS>.<ext>`."""
    return f"{doc.stem}.{EXTENSIONS[fmt]}"


def render_doc(doc: Document, fmt: Format, theme: Theme = "light") -> str:
    """`theme` reaches the HTML only — Markdown carries no styling, so it is the same bytes in every
    theme, which is also why a themed export never changes a Markdown golden."""
    return render_html_doc(doc, theme) if fmt == "html" else render_markdown_doc(doc)


def render_markdown(conv: Conversation | None, turn_id: str) -> str:
    return render_markdown_doc(build_document(conv, turn_id))


def render_html(conv: Conversation | None, turn_id: str, theme: Theme = "light") -> str:
    return render_html_doc(build_document(conv, turn_id), theme)


# --------------------------------------------------------------------------- markdown renderer
def _marker_fields(doc: Document) -> tuple[tuple[str, str], ...]:
    return (
        (MARKER_NAME, MARKER_VALUE),
        (MARKER_TYPE, doc.kind),
        (MARKER_TURN, doc.turn_id),
        (MARKER_CONVERSATION, doc.conversation_id),
        (MARKER_SCHEMA, str(SCHEMA_VERSION)),
    )


def _md_href(href: str) -> str:
    return href.replace("<", "%3C").replace(">", "%3E").replace(" ", "%20")


def _md_block(block: Any) -> str:
    if isinstance(block, Heading):
        return "#" * max(1, min(6, block.level)) + " " + _md_inline(block.text)
    if isinstance(block, Para):
        return block.text
    if isinstance(block, Caption):
        return f"*{block.text}*"
    if isinstance(block, Meta):
        return " · ".join(f"**{label}:** {_md_inline(value)}" for label, value in block.items)
    if isinstance(block, Body):
        if not block.text.strip():
            return ""
        if block.code:
            fence = _fence(block.text)
            return f"{fence}\n{block.text}\n{fence}"
        return block.text
    if isinstance(block, Bullets):
        lines = []
        for item in block.items:
            line = "- "
            if item.lead:
                line += f"**{_md_inline(item.lead)}** — "
            line += _md_inline(item.text)
            if item.tags:
                line += " [" + ", ".join(_md_inline(t) for t in item.tags) + "]"
            lines.append(line)
        return "\n".join(lines)
    if isinstance(block, Checklist):
        return "\n".join(f"- [ ] {_md_inline(item)}" for item in block.items)
    if isinstance(block, Table):
        head = "| " + " | ".join(_md_inline(h) for h in block.headers) + " |"
        rule = "| " + " | ".join("---" for _ in block.headers) + " |"
        rows = ["| " + " | ".join(_md_inline(c) for c in row) + " |" for row in block.rows]
        return "\n".join([head, rule, *rows])
    if isinstance(block, Links):
        lines = []
        for i, item in enumerate(block.items, start=1):
            label = _md_inline(item.label)
            text = f"[{label}](<{_md_href(item.href)}>)" if item.href else label
            if item.note:
                text += f" — {_md_inline(item.note)}"
            lines.append(f"{i}. {text}")
        return "\n".join(lines)
    if isinstance(block, Details):
        inner = [_md_block(b) for b in block.blocks]
        return "\n\n".join([f"**{_md_inline(block.summary)}**", *[p for p in inner if p]])
    raise TypeError(f"unknown block {type(block).__name__}")  # pragma: no cover


#: The reference name the markdown logo is defined under, at the FOOT of the document.
MD_LOGO_REF = "sj-logo"


def render_markdown_doc(doc: Document) -> str:
    """GFM. The marker rides in an HTML comment (invisible in every renderer).

    The logo heads the document as a REFERENCE image, with its data URI defined on the last line:
    a reader opening the .md in an editor sees the title, not a screenful of base64.
    """
    marker = " ".join(f"{k}={v}" for k, v in _marker_fields(doc))
    uri = logo_data_uri(MARKDOWN_LOGO_PX)
    title = settings().app_title
    parts = [f"<!-- {marker} -->"]
    if uri:
        parts.append(f"![{_md_inline(title)}][{MD_LOGO_REF}]")
    parts.append(f"# {_md_inline(doc.title)}")
    parts.extend(_md_block(block) for block in doc.blocks)
    body = "\n\n".join(part for part in parts if part).rstrip()
    if uri:
        body += f"\n\n[{MD_LOGO_REF}]: {uri}"
    return body + "\n"


# --------------------------------------------------------------------------- html renderer
#: The document's Content-Security-Policy (a `<meta>` right after the charset): its one inline
#: stylesheet and the embedded `data:` logo load, nothing else can -- no script, frame, font or fetch.
CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:"

# Embedded on purpose: the document must render from a file path with no network at all, and it is
# also the master the desktop shell prints to PDF.
CSS = """
:root {
  --ink: #1b1f24; --muted: #5b6672; --line: #d8dfe6; --rule: #eef2f6;
  --bg: #ffffff; --panel: #f7f9fb; --accent: #4a90e2; --link: #1f6fb2;
  color-scheme: light;
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0; background: var(--bg); color: var(--ink);
  font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
}
.doc { max-width: 52rem; margin: 0 auto; padding: 40px 32px 72px; }
h1 { font-size: 26px; line-height: 1.25; margin: 0 0 4px; }
h2 { font-size: 19px; margin: 34px 0 6px; padding-bottom: 5px; border-bottom: 1px solid var(--line); }
h3 { font-size: 16px; margin: 22px 0 4px; }
h4 { font-size: 13px; margin: 16px 0 2px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
p { margin: 8px 0; }
.meta { color: var(--muted); font-size: 12.5px; margin: 4px 0 12px; }
.meta b { color: var(--ink); font-weight: 600; }
.meta .sep { color: var(--line); padding: 0 2px; }
.caption { color: var(--muted); font-size: 12.5px; font-style: italic; margin: 2px 0 8px; }
pre.body, pre.code {
  margin: 8px 0 16px; padding: 12px 14px; white-space: pre-wrap; overflow-wrap: anywhere;
  border-left: 3px solid var(--accent); background: var(--panel); border-radius: 0 4px 4px 0;
}
pre.body { font: inherit; }
pre.code {
  border: 1px solid var(--line); border-left: 3px solid var(--accent);
  font: 12.5px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-variant-ligatures: none;
}
ul, ol { margin: 8px 0 16px; padding-left: 22px; }
li { margin: 4px 0; }
.tags { color: var(--muted); font-size: 12.5px; }
ul.checklist { list-style: none; padding-left: 4px; }
ul.checklist input { margin: 0 6px 0 0; vertical-align: middle; }
.table-wrap { overflow-x: auto; margin: 8px 0 18px; }
table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 13px; }
th, td {
  border: 1px solid var(--line); padding: 6px 8px; text-align: left; vertical-align: top;
  white-space: pre-wrap; overflow-wrap: anywhere;
}
th { background: var(--panel); font-weight: 600; }
a { color: var(--link); }
/* A rendered reply (export_render.markdown_html): the same left rule and panel as a quoted body. */
.md {
  margin: 8px 0 16px; padding: 2px 14px; overflow-wrap: anywhere;
  border-left: 3px solid var(--accent); background: var(--panel); border-radius: 0 4px 4px 0;
}
/* Model text never paints outside the box that holds it -- not a formula, not a stack of combining
   marks -- so nothing a reply writes can land on the header or the notice. A list clips at the list:
   an item that clips loses its bullet (measured). `clip`, unlike `hidden`, changes no layout. */
.md, td, .doc ul, .doc ol, pre.body, pre.code { overflow: clip; }
.md > :first-child { margin-top: 8px; }
.md > :last-child { margin-bottom: 8px; }
.md .md-h {
  margin: 16px 0 4px; padding: 0; border: 0; color: var(--ink);
  text-transform: none; letter-spacing: normal; font-size: 15px;
}
.md h5.md-h, .md h6.md-h { font-size: 14px; }
.md code, code.tex {
  font: 0.88em/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-variant-ligatures: none; /* a ligature font draws `--` as a dash and `->` as an arrow */
  background: var(--rule); border-radius: 3px; padding: 0 3px;
}
.md pre.md-code {
  margin: 8px 0 12px; padding: 8px 10px; background: var(--bg); border: 1px solid var(--line);
  border-radius: 4px; white-space: pre-wrap; overflow-wrap: anywhere; font-variant-ligatures: none;
}
.md pre.md-code code { background: none; padding: 0; font-size: 12.5px; }
.md blockquote { margin: 8px 0; padding: 0 12px; border-left: 3px solid var(--line); color: var(--muted); }
.md hr { border: 0; border-top: 1px solid var(--line); margin: 14px 0; }
.md ul.md-tasks { list-style: none; padding-left: 4px; }
.md li.md-task input { margin: 0 6px 0 0; vertical-align: middle; }
.md kbd {
  font: 0.85em ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-variant-ligatures: none;
  border: 1px solid var(--line); border-radius: 3px; padding: 0 4px; background: var(--bg);
}
.md-table { overflow-x: auto; margin: 8px 0 12px; }
.md-table table { table-layout: auto; }
.md-table th { background: var(--rule); }
.md-table td, .md-table th { white-space: normal; overflow-wrap: break-word; } /* never mid-word */
.al-l { text-align: left; } .al-c { text-align: center; } .al-r { text-align: right; }
/* Typeset formulas: native MathML Core in an installed OpenType MATH font, named because the
   `math` generic alone was measured falling back to a text font (no stretchy braces); nothing is
   embedded. Windows ships Cambria Math, macOS STIX Two Math, most Linux desktops DejaVu Math. */
math {
  font-family: "Latin Modern Math", "STIX Two Math", "Cambria Math", "DejaVu Math TeX Gyre",
    "Libertinus Math", "Noto Sans Math", math;
}
.math-block { margin: 8px 0; overflow-x: auto; overflow-y: hidden; }
math[display="block"] { margin: 6px 0; }
mtd.ma-l { text-align: left; } mtd.ma-r { text-align: right; } mtd.ma-c { text-align: center; }
mtable.mt-align > mtr > mtd { padding-left: 0; padding-right: 0; }
mtable.mt-align > mtr > mtd.ma-r ~ mtd.ma-r { padding-left: 2em; }
.mv-b { font-weight: bold; } .mv-i { font-style: italic; } .mv-bi { font-weight: bold; font-style: italic; }
.mv-tt { font-family: ui-monospace, monospace; } .mv-sf { font-family: sans-serif; }
.me-box { border: 1px solid currentColor; padding: 0 2px; }
.me-h { background: linear-gradient(currentColor, currentColor) no-repeat center / 100% 1px; }
.me-up { background: linear-gradient(to top right, transparent 47%, currentColor 49%, currentColor 51%, transparent 53%); }
.me-down { background: linear-gradient(to bottom right, transparent 47%, currentColor 49%, currentColor 51%, transparent 53%); }
.me-up.me-down {
  background: linear-gradient(to top right, transparent 47%, currentColor 49%, currentColor 51%, transparent 53%),
    linear-gradient(to bottom right, transparent 47%, currentColor 49%, currentColor 51%, transparent 53%);
}
details { margin: 8px 0 16px; border: 1px solid var(--line); border-radius: 4px; padding: 8px 12px; background: var(--panel); }
summary { cursor: pointer; font-weight: 600; font-size: 13px; }
.brand { display: flex; align-items: center; gap: 10px; margin: 0 0 18px; }
.brand img { width: 34px; height: 34px; display: block; }
.brand span { font-size: 13px; font-weight: 600; letter-spacing: .01em; color: var(--muted); }
/* The table of contents: in the flow before the first section (narrow screens, paper), and on a wide
   screen a sidebar beside the document that stays in view while it scrolls. */
.toc { margin: 16px 0 8px; padding: 10px 14px; border: 1px solid var(--line); border-radius: 4px; background: var(--panel); }
.toc-title { margin: 0 0 4px; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
.toc ol { list-style: none; margin: 0; padding-left: 0; font-size: 13.5px; }
.toc ol ol { padding-left: 16px; font-size: 13px; }
.toc li { margin: 2px 0; }
.toc a { color: var(--link); text-decoration: none; overflow-wrap: anywhere; }
.toc a:hover { text-decoration: underline; }
.doc h2[id], .doc h3[id], .doc h4[id] { scroll-margin-top: 16px; }
@media screen and (min-width: 76rem) {
  .doc:has(> .toc) { position: relative; margin-left: max(18rem, calc((100% - 52rem) / 2)); }
  .toc { position: absolute; top: 0; bottom: 0; right: 100%; width: 16rem; margin: 0; padding: 0; border: 0; background: none; }
  .toc-in {
    position: sticky; top: 0; max-height: 100vh; overflow-y: auto;
    padding: 40px 12px 24px 16px; border-right: 1px solid var(--line);
  }
}
/* The top margin holds the printed page header (the mark and the name). */
@page { margin: 24mm 16mm 16mm; }
@media print {
  .doc { max-width: none; padding: 0; }
  h2, h3, h4 { break-after: avoid; }
  tr, li, pre.body, pre.code, details { break-inside: avoid; }
  /* Paper cannot scroll: a wide table or formula is laid out whole, code wraps, a formula stays on
     one page. MathML Core does not line-break, so a formula wider than the text area is clipped. */
  .md-table, .math-block, .table-wrap { overflow: visible; }
  .md pre.md-code { white-space: pre-wrap; break-inside: auto; }
  /* A long item in a reply may break (kept whole, it left half a page blank); a reply's heading
     stays with what follows it. */
  .md li { break-inside: auto; }
  .md .md-h { break-after: avoid; break-inside: avoid; }
  .md .md-h + * { break-before: avoid; }
  math, .math-block { break-inside: avoid; }
  a { color: inherit; }
  /* On paper the mark is the PAGE header, drawn in the margin of every sheet by the printer (the
     shell's `printToPDF` headerTemplate). `position: fixed` was tried first and Chromium laid it
     out at the FOOT of the page, measured 2026-09-19 -- so the in-flow copy simply goes away here
     rather than appearing twice or in the wrong place. */
  .brand { display: none; }
}
"""

#: The DARK token values, taken from the app's own palette in `frontend/src/index.css` rather than
#: invented, so a document looks like the window it was exported from. Only the eight tokens the
#: document uses are redefined; every rule in `CSS` reads them, so nothing else has to change.
DARK_TOKENS = """
  --ink: #e6edf3; --muted: #9198a1; --line: #30363d; --rule: #21262d;
  --bg: #0d1117; --panel: #161b22; --accent: #58a6ff; --link: #58a6ff;
  color-scheme: dark;
"""


def theme_css(theme: Theme) -> str:
    """`CSS` for `light` (exactly, no override), plus a dark override for `dark` (always) or
    `system` (only under `prefers-color-scheme: dark`, so the reader's own setting decides — the
    same rule the app itself applies)."""
    if theme == "light":
        return CSS
    if theme == "dark":
        return CSS + ":root {" + DARK_TOKENS + "}\n"
    return (
        CSS
        + "@media (prefers-color-scheme: dark) {\n  :root {"
        + DARK_TOKENS
        + "  }\n}\n"
    )


#: The heading levels the table of contents lists: the sections (h2) and what they hold (h3). An h4
#: is a sub-part of one exchange or one attempt ("Revised claim", "attempt 1"); a heading a model
#: wrote inside a reply is part of the reply, not of the document.
TOC_LEVELS = (2, 3)
TOC_TITLE = "Contents"


def _anchor(n: int) -> str:
    """The fragment id of the document's n-th heading (1-based, in document order). Derived from
    nothing a model or a user wrote, so it is always a valid, unique, harmless id."""
    return f"sec-{n}"


def _outline(blocks: tuple[Any, ...]) -> list[tuple[Heading, str]]:
    """Every document heading in rendering order -- inside a `Details` too -- with its fragment id."""
    out: list[tuple[Heading, str]] = []

    def walk(items: tuple[Any, ...]) -> None:
        for block in items:
            if isinstance(block, Heading):
                out.append((block, _anchor(len(out) + 1)))
            elif isinstance(block, Details):
                walk(block.blocks)

    walk(blocks)
    return out


def _toc_html(outline: list[tuple[Heading, str]]) -> str:
    """The table of contents: a STATIC list of in-document links (no script; a fragment is not a
    URL, so it loads nothing) -- clickable in the HTML and in the PDF printed from it. An h3 nests
    under the h2 before it. Empty for a document with fewer than two entries."""
    entries = [(h.level, h.text, anchor) for h, anchor in outline if h.level in TOC_LEVELS]
    if len(entries) < 2:
        return ""
    parts = [
        f'<nav class="toc" aria-label="{TOC_TITLE}"><div class="toc-in">',
        f'<p class="toc-title">{TOC_TITLE}</p>',
        "<ol>",
    ]
    item_open = sub_open = False
    for level, text, anchor in entries:
        link = f'<a href="#{anchor}">{_esc(text)}</a>'
        if level > TOC_LEVELS[0] and item_open:
            if not sub_open:
                parts.append("<ol>")
                sub_open = True
            parts.append(f"<li>{link}</li>")
            continue
        if sub_open:
            parts.append("</ol>")
            sub_open = False
        if item_open:
            parts.append("</li>")
        parts.append(f"<li>{link}")
        item_open = True
    if sub_open:
        parts.append("</ol>")
    parts.append("</li>\n</ol>\n</div></nav>")
    return "\n".join(parts)


def _html_block(block: Any, anchors: Iterator[str]) -> str:
    """`anchors` yields the fragment ids of `_outline`, consumed one per heading in the same order."""
    if isinstance(block, Heading):
        level = max(1, min(6, block.level))
        return f'<h{level} id="{next(anchors)}">{_esc(block.text)}</h{level}>'
    if isinstance(block, Para):
        return f"<p>{_esc(block.text)}</p>"
    if isinstance(block, Caption):
        return f'<p class="caption">{_esc(block.text)}</p>'
    if isinstance(block, Meta):
        cells = [f"<span><b>{_esc(label)}:</b> {_esc(value)}</span>" for label, value in block.items]
        return '<p class="meta">' + '<span class="sep"> · </span>'.join(cells) + "</p>"
    if isinstance(block, Body):
        if not block.text.strip():
            return ""
        if block.kind == "markdown" and len(block.text) <= RENDER_MAX_CHARS:
            return f'<div class="md">\n{markdown_html(block.text, links=block.links)}</div>'
        cls = "code" if block.code or block.kind == "code" else "body"
        return f'<pre class="{cls}">{_esc(block.text)}</pre>'
    if isinstance(block, Bullets):
        items = []
        for item in block.items:
            parts = []
            if item.lead:
                parts.append(f"<b>{inline_html(item.lead)}</b> — ")
            parts.append(inline_html(item.text))
            if item.tags:
                tags = ", ".join(_esc(t) for t in item.tags)
                parts.append(f' <span class="tags">[{tags}]</span>')
            items.append("<li>" + "".join(parts) + "</li>")
        return "<ul>\n" + "\n".join(items) + "\n</ul>"
    if isinstance(block, Checklist):
        items = [
            f'<li><input type="checkbox" disabled> {inline_html(item)}</li>' for item in block.items
        ]
        return '<ul class="checklist">\n' + "\n".join(items) + "\n</ul>"
    if isinstance(block, Table):
        head = "".join(f"<th>{_esc(h)}</th>" for h in block.headers)
        rows = "\n".join(
            "<tr>" + "".join(f"<td>{inline_html(c)}</td>" for c in row) + "</tr>"
            for row in block.rows
        )
        return (
            '<div class="table-wrap"><table>\n<thead><tr>'
            + head
            + "</tr></thead>\n<tbody>\n"
            + rows
            + "\n</tbody>\n</table></div>"
        )
    if isinstance(block, Links):
        items = []
        for item in block.items:
            label = _esc(item.label)
            if item.href:
                inner = f'<a href="{_esc(item.href)}" target="_blank" rel="noreferrer noopener">{label}</a>'
            else:
                inner = label
            if item.note:
                inner += f" — {_esc(item.note)}"
            items.append(f"<li>{inner}</li>")
        return '<ol class="citations">\n' + "\n".join(items) + "\n</ol>"
    if isinstance(block, Details):
        inner = "\n".join(p for p in (_html_block(b, anchors) for b in block.blocks) if p)
        # `open`: a collapsed <details> is invisible in a print, and the PDF is this document.
        return f"<details open>\n<summary>{_esc(block.summary)}</summary>\n{inner}\n</details>"
    raise TypeError(f"unknown block {type(block).__name__}")  # pragma: no cover


def render_html_doc(doc: Document, theme: Theme = "light") -> str:
    """ONE self-contained, STATIC document: embedded CSS, no script, no external reference of any
    kind, every quoted value escaped, and a Content-Security-Policy that allows nothing else to
    load. The only absolute URLs are anchors (citations; a Send or Continue reply's own links).

    The table of contents goes right before the first section, after the metadata line and the
    notes that open the document; every document heading carries the id it links to."""
    markers = "\n".join(
        f'<meta name="{_esc(name)}" content="{_esc(value)}">' for name, value in _marker_fields(doc)
    )
    outline = _outline(doc.blocks)
    toc = _toc_html(outline)
    anchors = iter(anchor for _, anchor in outline)
    parts: list[str] = []
    for block in doc.blocks:
        if toc and isinstance(block, Heading):
            parts.append(toc)
            toc = ""
        parts.append(_html_block(block, anchors))
    blocks = "\n".join(part for part in parts if part)
    return (
        "<!doctype html>\n"
        '<html lang="en">\n<head>\n<meta charset="utf-8">\n'
        f'<meta http-equiv="Content-Security-Policy" content="{CSP}">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
        f"{markers}\n"
        f"<title>{_esc(doc.title)}</title>\n"
        f"<style>{theme_css(theme)}</style>\n"
        "</head>\n<body>\n"
        f'<main class="doc">\n{_html_brand()}<h1>{_esc(doc.title)}</h1>\n{blocks}\n</main>\n'
        "</body>\n</html>\n"
    )


def _html_brand() -> str:
    """The running header: the mark and the product name, embedded, or nothing at all."""
    uri = logo_data_uri(HTML_LOGO_PX)
    title = settings().app_title
    if not uri:
        return f'<header class="brand"><span>{_esc(title)}</span></header>\n'
    return (
        f'<header class="brand"><img src="{_esc(uri)}" alt="" width="34" height="34">'
        f"<span>{_esc(title)}</span></header>\n"
    )
