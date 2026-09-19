"""The anonymity gate (the user's binding decision).

An Analyze or Fusion export shows R1 / R2 / R3 -- exactly what the panes show -- and never says
which model is behind a label. A Send (or Continue) export DOES name Claude / ChatGPT / Grok,
because the Send columns are labelled that way on screen.

Scope, exactly as `tests/e2e/test_leaks.py`: the verbatim user prompt and raw model-authored text
(replies, analyst claims, justifications) are out of scope -- a model that names a vendor in its
own answer is the model's doing and the answer is reproduced verbatim on purpose. Everything else
in the document is Triplex-authored and must be clean with NOTHING allowed.
"""

from __future__ import annotations

from html import escape

import pytest

from backend import branding, export
from backend.config import FORBIDDEN_IDENTITY_STRINGS
from backend.schemas import LABELS, SLOT_IDS
from tests.export.conftest import logo_uris, without_assets
from tests.helpers import find_identity_leaks

OTHER_MAP = {"R1": "grok", "R2": "claude", "R3": "chatgpt"}  # not the conftest default

# Planted vendor names: the prompt is the user's, the claim and the justification are the
# analyst's / a model's. Nothing Triplex-authored may add to these.
VENDOR_PROMPT = "Ask ChatGPT and Grok about the Bosch BMI088 register map."
VENDOR_CLAIM = "OpenAI's documentation says the gyroscope tops out at 1000 deg/s."
VENDOR_JUSTIFICATION = "Anthropic's model card lists the same table, so the claim stands."


@pytest.fixture
def fused(rich_send, add_analyze, add_fusion):
    """A conversation carrying a send, an ok analyze and a fusion turn."""

    def _mk(**kwargs):
        conv = rich_send(**kwargs)
        analyze = add_analyze(conv)
        fusion = add_fusion(conv, analyze)
        return conv, analyze, fusion

    return _mk


@pytest.mark.parametrize("fmt", ["md", "html"])
@pytest.mark.parametrize("which", ["analyze", "fusion"])
def test_analyze_and_fusion_exports_are_r_labels_only(fused, which, fmt):
    conv, analyze, fusion = fused()
    turn = analyze if which == "analyze" else fusion
    doc = without_assets(export.render_doc(export.build_document(conv, turn.id), fmt))

    # Nothing allowed: the whole document is Triplex-authored plus vendor-free quoted text.
    assert find_identity_leaks(doc) == []
    # The labels ARE there (the document is anonymised, not stripped).
    for label in LABELS:
        assert label in doc
    # No slot id, no per-slot model id, no analyst model id, and never the mapping itself.
    lowered = doc.lower()
    for slot in SLOT_IDS:
        assert slot not in lowered
        assert conv.slot_config.slots[slot].model.lower() not in lowered
    assert conv.slot_config.analyst_model.lower() not in lowered
    assert "anon_map" not in doc


@pytest.mark.parametrize("which", ["analyze", "fusion"])
def test_only_quoted_text_may_carry_a_vendor_name(fused, which):
    """With vendor names planted in the user prompt and in analyst-authored text, the document is
    clean once exactly those verbatim strings are excised -- i.e. nothing Triplex writes leaks."""
    conv, analyze, fusion = fused(prompt=VENDOR_PROMPT)
    conv.turns[0].prompt = VENDOR_PROMPT
    analyze.extraction.divergences[0].positions[1].claim = VENDOR_CLAIM
    fusion.rounds[0].exchanges[0].justification = VENDOR_JUSTIFICATION
    turn = analyze if which == "analyze" else fusion
    planted = (VENDOR_PROMPT, VENDOR_CLAIM, VENDOR_JUSTIFICATION)

    for fmt in ("md", "html"):
        doc = without_assets(export.render_doc(export.build_document(conv, turn.id), fmt))
        # The HTML escapes quoted text (`OpenAI's` -> `OpenAI&#x27;s`), so the allow list carries
        # both spellings -- which is itself proof that the quoted text was escaped.
        allow = (*planted, *(escape(p, quote=True) for p in planted))
        assert find_identity_leaks(doc, allow=allow) == []
        # The allow list really excised something: the planted text IS in the document, and
        # without the allow list the scan does fire, so the assertion above has teeth.
        assert VENDOR_PROMPT in doc or escape(VENDOR_PROMPT, quote=True) in doc
        assert find_identity_leaks(doc) != []


@pytest.mark.parametrize("which", ["send", "analyze", "fusion"])
def test_no_document_depends_on_the_anon_map(fused, which):
    """The mapping is never read: the same conversation under a different permutation renders the
    byte-identical document (ids, timestamps and all)."""
    conv, analyze, fusion = fused()
    permuted = conv.model_copy(deep=True)
    permuted.anon_map = dict(OTHER_MAP)
    assert permuted.anon_map != conv.anon_map
    turn_id = {"send": conv.turns[0].id, "analyze": analyze.id, "fusion": fusion.id}[which]
    for fmt in ("md", "html"):
        assert export.render_doc(export.build_document(conv, turn_id), fmt) == export.render_doc(
            export.build_document(permuted, turn_id), fmt
        )


def test_send_export_names_the_slots_and_uses_no_r_labels(fused):
    """The counterpart decision: a Send document is a copy of the labelled columns on screen."""
    conv, _, _ = fused()
    for fmt in ("md", "html"):
        doc = without_assets(export.render_doc(export.build_document(conv, conv.turns[0].id), fmt))
        for name in export.SLOT_NAMES.values():
            assert name in doc
        for label in LABELS:
            assert label not in doc
        assert "anon_map" not in doc


def test_slot_ids_and_vendors_are_all_in_the_scanned_vocabulary():
    """The leak scan above only means something because the slot ids and the vendor names are part
    of `FORBIDDEN_IDENTITY_STRINGS` (mirrors the assertion in tests/e2e/test_leaks.py)."""
    assert set(SLOT_IDS) <= set(FORBIDDEN_IDENTITY_STRINGS)
    assert {n.lower() for n in export.SLOT_NAMES.values()} <= set(FORBIDDEN_IDENTITY_STRINGS)


@pytest.mark.parametrize("fmt", ["md", "html"])
@pytest.mark.parametrize("which", ["send", "analyze", "fusion"])
def test_the_only_thing_excised_from_the_scan_is_our_own_logo(fused, which, fmt):
    """The scans above run on the document with `data:` payloads removed, because base64 of any
    image contains arbitrary letter pairs -- "R1" among them -- and a substring scan would fire on
    noise. That is only safe while the payloads are exactly the asset we ship: this pins them, so
    nothing can ride along inside the part that is not read."""
    conv, analyze, fusion = fused()
    turn = {"send": conv.turns[0], "analyze": analyze, "fusion": fusion}[which]
    raw = export.render_doc(export.build_document(conv, turn.id), fmt)
    expected = branding.logo_data_uri(branding.MARKDOWN_LOGO_PX if fmt == "md" else branding.HTML_LOGO_PX)

    found = logo_uris(raw)
    assert found == ([expected] if expected else []), "exactly one payload, and it is the logo"
    # And removing it removes nothing else: the readable document is the rest, byte for byte.
    assert without_assets(raw).replace("data:image/png;base64,<asset>", "") == raw.replace(found[0] if found else "", "")
