"""Exports over a council of 2..5 (2026-09-27): the anonymity note counts the labels, a Send
document names every seated vendor and no other, the Continue aside and the Refactor heading are
count-aware, and the three-council wording is byte for byte what it was."""

from __future__ import annotations

import pytest

from backend import export
from backend.schemas import (
    AnalyzeTurn,
    ContinueTurn,
    Conversation,
    Extraction,
    KnowledgeGraph,
    RefactoredReply,
    Refactoring,
    RefactorTurn,
    SendTurn,
    SlotConfig,
    SlotSpec,
    council_of,
    empty_threads,
)
from backend.store import conversations as store
from tests.export.test_anonymity import without_assets


def _cfg(*slots: str) -> SlotConfig:
    return SlotConfig(
        slots={s: SlotSpec(model=f"vendor/{s}", effort="medium") for s in slots},
        analyst_model="openai/gpt-5.6-luna",
    )


def _conv(cfg: SlotConfig) -> Conversation:
    council = council_of(cfg)
    conv = Conversation(slot_config=cfg, threads=empty_threads(council), anon_map=store.mock_anon_map(council))
    send = SendTurn(prompt="Q?", slot_config=cfg, responses={s: f"reply of {s}" for s in council})
    cont = ContinueTurn(slot=council[0], prompt="more?", response="more.", slot_config=cfg)
    labels = list(store.mock_anon_map(council))
    ref = RefactorTurn(
        of_turn=send.id,
        slot_config=cfg,
        refactoring=Refactoring(
            graph=KnowledgeGraph(),
            question="Q?",
            replies=[RefactoredReply(model=label, summary=f"summary {label}", claims=["c"]) for label in labels],
        ),
    )
    ana = AnalyzeTurn(
        of_turn=send.id,
        slot_config=cfg,
        extraction=Extraction(agreements=[], divergences=[]),
    )
    conv.turns.extend([send, cont, ref, ana])
    return conv


def _doc(conv: Conversation, index: int, fmt: str = "md") -> str:
    return without_assets(export.render_doc(export.build_document(conv, conv.turns[index].id), fmt))


def test_anon_note_and_the_pins():
    assert export.anon_note(3) == export.ANON_NOTE
    assert export.ANON_NOTE.startswith("Each model is shown as R1, R2 or R3, exactly as the pane shows it.")
    assert export.anon_note(2).startswith("Each model is shown as R1 or R2, exactly")
    assert export.anon_note(5).startswith("Each model is shown as R1, R2, R3, R4 or R5, exactly")
    assert export.others_not_called(3) == "the other two slots were not called."
    assert export.others_not_called(2) == "the other slot was not called."
    assert export.others_not_called(5) == "the other four slots were not called."
    assert set(export.SLOT_NAMES) == {"claude", "chatgpt", "grok", "gemini", "deepseek", "qwen", "mimo"}
    assert export.SLOT_NAMES["mimo"] == "MiMo" and export.SLOT_NAMES["deepseek"] == "DeepSeek"


@pytest.mark.parametrize("fmt", ["md", "html"])
def test_a_five_send_document_names_every_seated_vendor_and_no_other(fmt):
    conv = _conv(_cfg("claude", "chatgpt", "grok", "gemini", "deepseek"))
    doc = _doc(conv, 0, fmt)
    for slot in council_of(conv.slot_config):
        assert export.SLOT_NAMES[slot] in doc and f"reply of {slot}" in doc
    assert "Qwen" not in doc and "MiMo" not in doc
    assert "Claude, ChatGPT, Grok, Gemini, DeepSeek" in doc  # the slots meta line, catalog order
    for label in ("R1", "R2", "R3", "R4", "R5"):
        assert label not in doc


@pytest.mark.parametrize("fmt", ["md", "html"])
def test_pair_documents_use_the_pair_wording(fmt):
    conv = _conv(_cfg("chatgpt", "qwen"))
    send = _doc(conv, 0, fmt)
    assert "ChatGPT" in send and "Qwen" in send and "Claude" not in send and "Grok" not in send
    cont = _doc(conv, 1, fmt)
    assert "A solo continuation of the ChatGPT thread; the other slot was not called." in cont
    ref = _doc(conv, 2, fmt)
    assert "The two responses, reduced" in ref and "three responses" not in ref
    assert export.anon_note(2) in ref
    assert "R1" in ref and "R2" in ref and "R3" not in ref
    ana = _doc(conv, 3, fmt)
    assert export.anon_note(2) in ana and "R3" not in ana and "Qwen" not in ana


def test_three_documents_keep_the_old_wording(make_conversation):
    conv = _conv(_cfg("claude", "chatgpt", "grok"))
    cont = _doc(conv, 1)
    assert "A solo continuation of the Claude thread; the other two slots were not called." in cont
    assert "The three responses, reduced" in _doc(conv, 2)
    assert export.ANON_NOTE in _doc(conv, 3)
