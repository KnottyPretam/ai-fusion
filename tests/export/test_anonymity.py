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
from backend.schemas import DEFAULT_COUNCIL, LABELS, SLOT_IDS
from tests.export.conftest import logo_uris, without_assets
from tests.export.test_plan_document import make_plan_turn
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


# The plan model's string can name a vendor -- the default `anthropic/claude-opus-5.5` does, and so
# does the desktop's `web:claude` -- exactly like `analyst_model`; neither reaches a document.
PLAN_MODELS = ("anthropic/claude-opus-5.5", "web:claude", "web:chatgpt:analyst", "ollama:hermes3")
VENDOR_OBJECTIVE = "Ask Grok to confirm the range OpenAI's documentation gives."


@pytest.fixture
def planned(fused):
    """`fused` plus a plan turn made by `model` (2026-09-27)."""

    def _mk(model: str = PLAN_MODELS[0], **kwargs):
        conv, analyze, fusion = fused(**kwargs)
        plan = make_plan_turn(conv, fusion, model=model)
        return conv, analyze, fusion, plan

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
    for label in LABELS[:3]:
        assert label in doc
    # No slot id, no per-slot model id, no analyst model id, and never the mapping itself.
    lowered = doc.lower()
    for slot in DEFAULT_COUNCIL:
        assert slot not in lowered
        assert conv.slot_config.slots[slot].model.lower() not in lowered
    assert conv.slot_config.analyst_model.lower() not in lowered
    assert "anon_map" not in doc


@pytest.mark.parametrize("fmt", ["md", "html"])
@pytest.mark.parametrize("model", PLAN_MODELS)
def test_a_plan_export_never_names_the_model_that_wrote_it(planned, model, fmt):
    """The Plan document (2026-09-27) quotes the procedure and nothing about who wrote it: no model
    string, no slot id, no per-slot or analyst model id, and never the mapping."""
    conv, _, _, plan = planned(model=model)
    doc = without_assets(export.render_doc(export.build_document(conv, plan.id), fmt))
    assert find_identity_leaks(doc) == []
    lowered = doc.lower()
    assert model.lower() not in lowered
    for slot in DEFAULT_COUNCIL:
        assert slot not in lowered
        assert conv.slot_config.slots[slot].model.lower() not in lowered
    assert conv.slot_config.analyst_model.lower() not in lowered
    assert "anon_map" not in doc
    # The procedure itself IS there (the document is anonymised, not stripped).
    assert "GYRO" in doc


# The bridge's own error texts name the SITE the request went to (`backend/llm/bridge.py`:
# `not_captured` reads "capture is off for <slot>; …", a site failure "<code> on <slot>"); a degraded
# turn keeps them in `turn.error`, so the document must scrub them.
NOT_CAPTURED_ERROR = "capture is off for claude; the reply is in the site pane"
SITE_ERROR = "site_error on claude"


@pytest.mark.parametrize("fmt", ["md", "html"])
@pytest.mark.parametrize("error", [NOT_CAPTURED_ERROR, SITE_ERROR])
def test_a_degraded_plan_export_scrubs_the_transport_error(fused, fmt, error):
    """A plan typed into a pane whose capture is off degrades with the bridge's message, which names
    the site: the document renders it scrubbed, never verbatim."""
    conv, _, fusion = fused()
    plan = make_plan_turn(conv, fusion, status="degraded", model="web:claude")
    plan.error = error
    doc = without_assets(export.render_doc(export.build_document(conv, plan.id), fmt))
    assert find_identity_leaks(doc) == []
    assert "claude" not in doc.lower()
    assert error.replace("claude", "[model]") in doc  # rendered and readable, not dropped


@pytest.mark.parametrize("fmt", ["md", "html"])
@pytest.mark.parametrize("error", [NOT_CAPTURED_ERROR, SITE_ERROR])
def test_a_degraded_refactor_export_scrubs_the_transport_error(fused, add_refactor, fmt, error):
    """The same one-liner in the Refactor document: its analyst can be a site too."""
    conv, _, _ = fused()
    turn = add_refactor(conv, status="degraded")
    turn.error = error
    doc = without_assets(export.render_doc(export.build_document(conv, turn.id), fmt))
    assert find_identity_leaks(doc) == []
    assert "claude" not in doc.lower()
    assert error.replace("claude", "[model]") in doc


def test_a_plan_document_carries_a_vendor_name_only_inside_the_plan_itself(planned):
    """The plan is model-authored text, reproduced verbatim on purpose: with a vendor name planted in
    its objective the document is clean once exactly that string is excised."""
    conv, _, _, plan = planned()
    plan.plan.objective = VENDOR_OBJECTIVE
    for fmt in ("md", "html"):
        doc = without_assets(export.render_doc(export.build_document(conv, plan.id), fmt))
        allow = (VENDOR_OBJECTIVE, escape(VENDOR_OBJECTIVE, quote=True))
        assert find_identity_leaks(doc, allow=allow) == []
        assert VENDOR_OBJECTIVE in doc or escape(VENDOR_OBJECTIVE, quote=True) in doc
        assert find_identity_leaks(doc) != []


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


@pytest.mark.parametrize("which", ["send", "analyze", "fusion", "plan"])
def test_no_document_depends_on_the_anon_map(planned, which):
    """The mapping is never read: the same conversation under a different permutation renders the
    byte-identical document (ids, timestamps and all)."""
    conv, analyze, fusion, plan = planned()
    permuted = conv.model_copy(deep=True)
    permuted.anon_map = dict(OTHER_MAP)
    assert permuted.anon_map != conv.anon_map
    turn_id = {"send": conv.turns[0].id, "analyze": analyze.id, "fusion": fusion.id, "plan": plan.id}[which]
    for fmt in ("md", "html"):
        assert export.render_doc(export.build_document(conv, turn_id), fmt) == export.render_doc(
            export.build_document(permuted, turn_id), fmt
        )


def test_send_export_names_the_slots_and_uses_no_r_labels(fused):
    """The counterpart decision: a Send document is a copy of the labelled columns on screen."""
    conv, _, _ = fused()
    for fmt in ("md", "html"):
        doc = without_assets(export.render_doc(export.build_document(conv, conv.turns[0].id), fmt))
        for slot in DEFAULT_COUNCIL:  # the council's names; SLOT_NAMES covers all seven vendors
            assert export.SLOT_NAMES[slot] in doc
        for slot in set(SLOT_IDS) - set(DEFAULT_COUNCIL):
            assert export.SLOT_NAMES[slot] not in doc
        for label in LABELS[:3]:
            assert label not in doc
        assert "anon_map" not in doc


def test_slot_ids_and_vendors_are_all_in_the_scanned_vocabulary():
    """The leak scan above only means something because the slot ids and the vendor names are part
    of `FORBIDDEN_IDENTITY_STRINGS` (mirrors the assertion in tests/e2e/test_leaks.py)."""
    assert set(SLOT_IDS) <= set(FORBIDDEN_IDENTITY_STRINGS)
    assert {n.lower() for n in export.SLOT_NAMES.values()} <= set(FORBIDDEN_IDENTITY_STRINGS)


@pytest.mark.parametrize("fmt", ["md", "html"])
@pytest.mark.parametrize("which", ["send", "analyze", "fusion", "plan"])
def test_the_only_thing_excised_from_the_scan_is_our_own_logo(planned, which, fmt):
    """The scans above run on the document with `data:` payloads removed, because base64 of any
    image contains arbitrary letter pairs -- "R1" among them -- and a substring scan would fire on
    noise. That is only safe while the payloads are exactly the asset we ship: this pins them, so
    nothing can ride along inside the part that is not read."""
    conv, analyze, fusion, plan = planned()
    turn = {"send": conv.turns[0], "analyze": analyze, "fusion": fusion, "plan": plan}[which]
    raw = export.render_doc(export.build_document(conv, turn.id), fmt)
    expected = branding.logo_data_uri(branding.MARKDOWN_LOGO_PX if fmt == "md" else branding.HTML_LOGO_PX)

    found = logo_uris(raw)
    assert found == ([expected] if expected else []), "exactly one payload, and it is the logo"
    # And removing it removes nothing else: the readable document is the rest, byte for byte.
    assert without_assets(raw).replace("data:image/png;base64,<asset>", "") == raw.replace(found[0] if found else "", "")
