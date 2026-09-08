"""Golden (syrupy) snapshots of the Analyze report for fixed inputs (PLAN.md §9)."""

from __future__ import annotations

import pytest

LABELLED = ["planted_factual", "baseline", "injection", "two_divergences"]


@pytest.mark.parametrize("scenario", LABELLED)
async def test_extraction_report_snapshot(scenario, scenario_conversation, analyze, snapshot):
    conv = await scenario_conversation(scenario)
    _, events = await analyze(conv.id)
    turn = events[-1]["turn"]
    assert turn["status"] == "ok"
    assert turn["extraction"] == snapshot


async def test_analyst_prompt_snapshot(persisted_conversation, analyze, snapshot):
    from backend.llm import mock

    await analyze(persisted_conversation.id)
    assert mock.calls[0]["messages"] == snapshot
