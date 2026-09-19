"""The mark on an exported document (user request, 2026-09-19).

The logo heads every document and, in print, every PAGE -- Chromium repeats a `position: fixed`
element on each sheet, and it is lifted into the page margin so it never lands on a line of text.
It is embedded as a data URI because the document carries no external reference of any kind, and it
is absent rather than fatal when the asset cannot be read: an export must not fail over decoration.
"""

from __future__ import annotations

import base64
import re
from html import escape

import pytest

from backend import branding, export
from backend.config import settings
from tests.export.conftest import logo_uris, without_assets

PNG_1PX = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)


@pytest.fixture(autouse=True)
def _fresh_logo_cache():
    branding.reset_cache()
    yield
    branding.reset_cache()


@pytest.fixture
def fused(rich_send, add_analyze, add_fusion):
    """A conversation carrying a send, an ok analyze and a fusion turn."""

    def _mk(**kwargs):
        conv = rich_send(**kwargs)
        analyze = add_analyze(conv)
        fusion = add_fusion(conv, analyze)
        return conv, analyze, fusion

    return _mk


@pytest.fixture
def logo_dir(tmp_path, monkeypatch):
    """Point the loader at a directory the test controls."""
    monkeypatch.setenv("EXPORT_LOGO_PATH", str(tmp_path))
    return tmp_path


# --------------------------------------------------------------------------- the loader
def test_the_shipped_asset_is_a_real_png_at_both_sizes():
    for px in (branding.MARKDOWN_LOGO_PX, branding.HTML_LOGO_PX):
        uri = branding.logo_data_uri(px)
        assert uri and uri.startswith("data:image/png;base64,")
        assert base64.b64decode(uri.split(",", 1)[1]).startswith(b"\x89PNG\r\n\x1a\n")
    # The markdown copy is the smaller one: it is text the reader may scroll past.
    assert len(branding.logo_data_uri(branding.MARKDOWN_LOGO_PX)) < len(branding.logo_data_uri(branding.HTML_LOGO_PX))


@pytest.mark.parametrize(
    "make,why",
    [
        (lambda p: None, "missing"),
        (lambda p: p.write_bytes(b""), "empty"),
        (lambda p: p.write_bytes(b"GIF89a not a png"), "not a PNG"),
        (lambda p: p.write_bytes(b"\x89PNG\r\n\x1a\n" + b"x" * (branding.MAX_LOGO_BYTES + 1)), "too big"),
    ],
)
def test_a_logo_that_cannot_be_used_is_absent_not_fatal(logo_dir, make, why):
    make(logo_dir / f"icon-{branding.HTML_LOGO_PX}.png")
    assert branding.logo_data_uri(branding.HTML_LOGO_PX) is None, why


def test_the_override_is_read_at_call_time(logo_dir):
    assert branding.logo_data_uri(branding.HTML_LOGO_PX) is None
    (logo_dir / f"icon-{branding.HTML_LOGO_PX}.png").write_bytes(PNG_1PX)
    branding.reset_cache()
    assert branding.logo_data_uri(branding.HTML_LOGO_PX) == "data:image/png;base64," + base64.b64encode(PNG_1PX).decode()


# --------------------------------------------------------------------------- in the documents
@pytest.mark.parametrize("which", ["send", "analyze", "fusion"])
def test_html_heads_the_document_with_the_mark_and_the_product_name(fused, which):
    conv, analyze, fusion = fused()
    turn = {"send": conv.turns[0], "analyze": analyze, "fusion": fusion}[which]
    html = export.render_html(conv, turn.id)

    header = re.search(r'<header class="brand">(.*?)</header>', html, re.S)
    assert header, "every document is headed"
    assert f'<img src="{branding.logo_data_uri(branding.HTML_LOGO_PX)}"' in header.group(1)
    assert escape(settings().app_title, quote=True) in header.group(1)  # the name, escaped like every value
    # It heads the document: before the title, inside the page, once.
    assert html.index('class="brand"') < html.index("<h1>")
    assert html.count('class="brand"') == 1


@pytest.mark.parametrize("which", ["send", "analyze", "fusion"])
def test_markdown_references_the_logo_at_the_top_and_defines_it_at_the_foot(fused, which):
    conv, analyze, fusion = fused()
    turn = {"send": conv.turns[0], "analyze": analyze, "fusion": fusion}[which]
    md = export.render_markdown(conv, turn.id)
    lines = md.rstrip().split("\n")

    ref = f"![{settings().app_title}][{export.MD_LOGO_REF}]"
    assert ref in lines[:3], "the mark heads the document"
    title_line = next(i for i, line in enumerate(lines) if line.startswith("# "))
    assert lines.index(ref) < title_line, "above the title"
    # The base64 is the LAST line, so an editor opens on the title and not on a screen of noise.
    assert lines[-1] == f"[{export.MD_LOGO_REF}]: {branding.logo_data_uri(branding.MARKDOWN_LOGO_PX)}"
    assert without_assets(md).count("base64,<asset>") == 1


def test_a_missing_logo_leaves_a_clean_document_in_both_formats(fused, logo_dir):
    conv, _, _ = fused()
    turn_id = conv.turns[0].id
    html = export.render_html(conv, turn_id)
    md = export.render_markdown(conv, turn_id)

    assert logo_uris(html) == [] and logo_uris(md) == []
    assert "<img" not in html.lower()
    assert export.MD_LOGO_REF not in md
    # The name still heads the HTML, and the markdown is exactly what it was before the logo.
    assert f'<header class="brand"><span>{escape(settings().app_title, quote=True)}</span></header>' in html
    body = [line for line in md.splitlines() if line.strip()]
    assert body[0].startswith("<!-- ") and body[1].startswith("# "), "marker, then straight to the title"


# --------------------------------------------------------------------------- print rules
def test_on_paper_the_in_flow_mark_gives_way_to_the_page_header():
    """The mark heads the SCREEN document in the flow, and every printed PAGE from the margin,
    where the shell's print header draws it. Both at once would print it twice on page one, and
    `position: fixed` -- the usual trick -- was measured putting it at the FOOT of the page in
    Chromium 152, so the in-flow copy is hidden for print instead."""
    css = export.CSS
    rules = re.sub(r"/\*.*?\*/", "", css, flags=re.S)  # declarations only; the comments explain why
    print_block = rules[rules.index("@media print"):]
    assert re.search(r"\.brand\s*\{\s*display:\s*none", print_block)
    assert "position: fixed" not in print_block
    # The page keeps a top margin big enough for the printed header to live in.
    page = re.search(r"@page\s*\{\s*margin:\s*(\d+)mm", css)
    assert page and int(page.group(1)) >= 20
