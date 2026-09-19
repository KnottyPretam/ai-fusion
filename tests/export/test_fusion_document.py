"""Structure of a Fusion export: which Analyze it fused, the standing ids, every round with every
exchange, the post-round statuses, and the final report with the exit reason spelled out."""

from __future__ import annotations

import pytest

from backend import export
from tests.export.conftest import html_headings, md_headings, md_tables

EXIT_REASONS = ("converged", "stalemate", "max_iterations", "error")


@pytest.fixture
def scenario(rich_send, add_analyze, add_fusion):
    def _mk(exit_reason: str = "converged"):
        conv = rich_send()
        analyze = add_analyze(conv)
        fusion = add_fusion(conv, analyze, exit_reason=exit_reason)
        return conv, analyze, fusion

    return _mk


def test_fusion_markdown_header_and_lineage(scenario):
    conv, analyze, fusion = scenario()
    text = export.render_markdown(conv, fusion.id)
    assert md_headings(text)[0] == (1, "Triplex Fusion — Test conversation")
    assert f"**fused analyze turn:** {analyze.id}" in text
    assert f"**rounds:** {len(fusion.rounds)} of {fusion.max_iterations}" in text
    assert f"**exit reason:** {fusion.exit_reason}" in text
    assert "## The Analyze that was fused" in text
    assert f"**analyze turn:** {analyze.id}" in text
    # The prompt behind the fused Analyze travels with the document.
    assert conv.turns[0].prompt in text
    # The standing ids, with their topics.
    standing = text[text.index("## Standing divergences at the start") : text.index("## Round 1")]
    for divergence_id in fusion.standing:
        assert f"**{divergence_id}**" in standing


def test_fusion_markdown_rounds_hold_every_exchange(scenario):
    conv, _, fusion = scenario()
    text = export.render_markdown(conv, fusion.id)
    assert [h for h in md_headings(text) if h[0] == 2 and h[1].startswith("Round")] == [
        (2, "Round 1"),
        (2, "Round 2"),
    ]
    for rnd in fusion.rounds:
        section = text[text.index(f"## Round {rnd.round}") :]
        if rnd.round < len(fusion.rounds):
            section = section[: section.index(f"## Round {rnd.round + 1}")]
        for exchange in rnd.exchanges:
            stance = exchange.stance
            assert f"### {exchange.divergence_id} · {exchange.model} · {stance}" in section
            if stance == "unavailable":
                assert exchange.error in section
                continue
            assert exchange.justification in section
            assert f"**confidence:** {exchange.confidence:.2f}" in section
            if exchange.revised_claim:
                assert "#### Revised claim" in section
                assert exchange.revised_claim in section
            if exchange.persuaded_by:
                assert "#### Persuaded by" in section
                assert exchange.persuaded_by in section
            if exchange.flagged_unjustified:
                assert "**flagged:** unjustified revision" in section
                assert "anti-sycophancy rule" in section
        # The post-round status table and the "changed" flag close the round.
        assert f"| divergence | status after round {rnd.round} |" in section
        assert f"**anything changed this round:** {'yes' if rnd.changed else 'no'}" in section


def test_fusion_markdown_round_overview_table_lists_stance_and_flag(scenario):
    conv, _, fusion = scenario()
    text = export.render_markdown(conv, fusion.id)
    round_one = text[text.index("## Round 1") : text.index("## Round 2")]
    table = md_tables(round_one)[0]
    assert table[0] == ["divergence", "model", "stance", "confidence", "flagged unjustified"]
    assert [row[:3] for row in table[1:]] == [
        [e.divergence_id, e.model, e.stance] for e in fusion.rounds[0].exchanges
    ]
    # An unavailable exchange has no confidence, and the flagged revise is marked.
    assert ["d1", "R3", "unavailable", "—", "no"] in table
    assert ["d1", "R2", "revise", "0.40", "yes"] in table


def test_fusion_final_report_statuses_and_standing_sides(scenario):
    conv, _, fusion = scenario("max_iterations")
    text = export.render_markdown(conv, fusion.id)
    final = text[text.index("## Final report") :]
    table = md_tables(final)[0]
    assert table[0] == ["divergence", "topic", "status"]
    assert ["d1", "gyroscope full-scale range", "resolved (unjustified)"] in table
    assert ["d2", "accelerometer bandwidth", "standing"] in table
    # resolved_unjustified is never sold as clean convergence.
    assert "not counted as clean convergence" in final
    # A standing divergence reports both sides with their latest words (a revise wins over the
    # extraction claim; the latest justification is the one from the last round that spoke).
    d2 = final[final.index("### d2"):]
    assert "still standing" in d2
    assert "#### R1" in d2 and "#### R3" in d2
    assert "*latest claim*" in d2 and "*latest justification*" in d2
    assert "Table 12 gives the 3 dB bandwidth" in d2  # R1's round-1 justification
    assert "The filter table caps the usable bandwidth at 145 Hz." in d2  # R3's


@pytest.mark.parametrize("exit_reason", EXIT_REASONS)
def test_every_exit_reason_is_spelled_out_in_words(scenario, exit_reason):
    conv, _, fusion = scenario(exit_reason)
    text = export.render_markdown(conv, fusion.id)
    html = export.render_html(conv, fusion.id)
    assert f"**exit reason:** {exit_reason}" in text
    words = export.EXIT_REASONS[exit_reason]
    assert words in text
    assert words in html
    assert text.index("## Final report") < text.index(words, text.index("## Final report"))


def test_all_unavailable_round_reports_the_error_exit(scenario):
    conv, _, fusion = scenario("error")
    text = export.render_markdown(conv, fusion.id)
    assert text.count("· unavailable") == 3
    assert "**error code:** transport_error" in text
    assert "could not be reached" in text
    assert "every challenge in a round came back unavailable" in text


def test_stalemate_round_has_no_revise_and_no_status_change(scenario):
    conv, _, fusion = scenario("stalemate")
    text = export.render_markdown(conv, fusion.id)
    assert "· revise" not in text
    assert "**anything changed this round:** no" in text
    assert "a round came back with every challenged model defending its claim" in text


def test_fusion_html_mirrors_the_markdown_sections(scenario):
    conv, _, fusion = scenario()
    md = export.render_markdown(conv, fusion.id)
    html = export.render_html(conv, fusion.id)
    assert [t for _, t in html_headings(html)] == [t for _, t in md_headings(md)]
    assert '<meta name="triplex-export-type" content="fusion">' in html
    assert f'<meta name="triplex-export-turn" content="{fusion.id}">' in html


def test_fusion_whose_analyze_turn_is_gone_still_renders(rich_send, add_analyze, add_fusion):
    conv = rich_send()
    analyze = add_analyze(conv)
    fusion = add_fusion(conv, analyze)
    conv.turns.remove(analyze)
    for text in (export.render_markdown(conv, fusion.id), export.render_html(conv, fusion.id)):
        assert "no longer part of this conversation" in text
        # Without the extraction there are no topics, and no standing sides to quote.
        assert "(topic unavailable)" in text
        assert "latest claim" not in text
