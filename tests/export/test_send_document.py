"""Structure of a Send (and solo Continue) export, in both formats.

A Send document names the slots -- Claude / ChatGPT / Grok -- because the Send columns are
labelled that way on screen (the user's decision; the Analyze/Fusion side of it is
`test_anonymity.py`). Assertions are structural: which sections exist, in which order, and which
value landed in which section -- never a byte snapshot.
"""

from __future__ import annotations

import pytest

from backend import export
from tests.export.conftest import (
    CITATIONS,
    CLAUDE_REASONING,
    GROK_ERROR,
    GROK_PARTIAL,
    html_headings,
    md_headings,
)


@pytest.fixture
def conv(rich_send):
    return rich_send()


def test_send_markdown_sections_in_order(conv):
    turn = conv.turns[0]
    text = export.render_markdown(conv, turn.id)
    headings = md_headings(text)
    assert headings[0] == (1, "Triplex Send — Test conversation")
    assert [h for h in headings if h[0] == 2] == [
        (2, "Prompt"),
        (2, "Claude"),
        (2, "ChatGPT"),
        (2, "Grok"),
    ]
    # The prompt is verbatim and comes before the first slot section.
    assert text.index(turn.prompt) < text.index("## Claude")
    # Each reply sits under its own slot heading, in that slot's section only.
    claude, chatgpt, grok = (text.index(f"## {name}") for name in ("Claude", "ChatGPT", "Grok"))
    assert claude < text.index(conv.turns[0].responses["claude"]) < chatgpt
    assert chatgpt < text.index(conv.turns[0].responses["chatgpt"]) < grok


def test_send_markdown_metadata_line_and_extras(conv):
    turn = conv.turns[0]
    text = export.render_markdown(conv, turn.id)
    # The document header carries the ids and the ISO timestamp.
    assert f"**turn:** {turn.id}" in text
    assert f"**timestamp:** {turn.ts}" in text
    assert f"**conversation id:** {conv.id}" in text
    # Per-slot extras live on a metadata line / in a details block, never in the reply body.
    assert f"**model:** {turn.slot_config.slots['claude'].model}" in text
    assert "**effort:** high (configured: medium)" in text
    assert "**truncated:** yes" in text  # chatgpt only
    assert text.count("**truncated:**") == 1
    reply = turn.responses["claude"]
    assert CLAUDE_REASONING not in reply and CLAUDE_REASONING in text
    assert text.index(reply) < text.index(CLAUDE_REASONING)  # reply body first, extras after


def test_send_markdown_citations_are_links_and_hostile_urls_are_not(conv):
    text = export.render_markdown(conv, conv.turns[0].id)
    assert "1. [bosch-sensortec.com](<https://www.bosch-sensortec.com/bmi088>) — BMI088 product page" in text
    # A javascript: url is shown as text, never as a link target.
    assert "](<javascript:" not in text
    assert CITATIONS[1]["url_citation"]["url"] in text


def test_send_markdown_errored_slot_shows_code_message_and_partial(conv):
    text = export.render_markdown(conv, conv.turns[0].id)
    grok = text[text.index("## Grok") :]
    assert "**outcome:** no reply" in grok
    assert "### Error" in grok
    assert "**error code:** cost_cap_exceeded" in grok
    assert GROK_ERROR in grok
    assert "### Partial text received before the failure" in grok
    assert GROK_PARTIAL in grok
    assert grok.index(GROK_ERROR) < grok.index(GROK_PARTIAL)


def test_send_html_has_the_same_sections_and_marker(conv):
    turn = conv.turns[0]
    html = export.render_html(conv, turn.id)
    assert html.startswith("<!doctype html>")
    headings = html_headings(html)
    assert headings[0] == (1, "Triplex Send — Test conversation")
    assert [h for h in headings if h[0] == 2] == [
        (2, "Prompt"),
        (2, "Claude"),
        (2, "ChatGPT"),
        (2, "Grok"),
    ]
    assert '<meta name="triplex-export-type" content="send">' in html
    assert f'<meta name="triplex-export-turn" content="{turn.id}">' in html
    assert turn.prompt in html
    assert GROK_ERROR in html
    assert '<a href="https://www.bosch-sensortec.com/bmi088"' in html
    assert 'href="javascript:' not in html


def test_both_formats_are_built_from_the_same_document(conv):
    """The two renderers share one document model: the same sections in the same order."""
    turn = conv.turns[0]
    md = [t for _, t in md_headings(export.render_markdown(conv, turn.id))]
    html = [t for _, t in html_headings(export.render_html(conv, turn.id))]
    assert md == html


def test_continue_turn_is_a_single_named_slot(conv, add_continue):
    turn = add_continue(conv, slot="chatgpt")
    text = export.render_markdown(conv, turn.id)
    assert md_headings(text)[0] == (1, "Triplex Continue — Test conversation")
    assert [h for h in md_headings(text) if h[0] == 2] == [(2, "Prompt"), (2, "ChatGPT")]
    assert "**turn type:** continue" in text
    assert turn.response in text
    assert "Claude" not in text and "Grok" not in text
    doc = export.build_document(conv, turn.id)
    assert doc.kind == "continue"


def test_unknown_turn_and_unknown_conversation_are_404(conv):
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as missing_turn:
        export.build_document(conv, "00000000-0000-4000-8000-000000000000")
    assert missing_turn.value.status_code == 404
    assert missing_turn.value.detail == {"error": "not_found", "what": "turn"}

    with pytest.raises(HTTPException) as missing_conv:
        export.build_document(None, conv.turns[0].id)
    assert missing_conv.value.status_code == 404
    assert missing_conv.value.detail == {"error": "not_found", "what": "conversation"}


def test_filename_default_is_a_sensible_save_dialog_suggestion(conv):
    doc = export.build_document(conv, conv.turns[0].id)
    md_name = export.filename_for(doc, "md")
    html_name = export.filename_for(doc, "html")
    assert md_name.startswith("triplex-send-test-conversation-")
    assert md_name.endswith(".md") and html_name.endswith(".html")
    assert md_name[: -len(".md")] == html_name[: -len(".html")]  # one base path, three files
