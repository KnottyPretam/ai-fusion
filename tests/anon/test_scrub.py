"""anon.scrub / anon.find_leaks: the word-bounded identity rule and the slug-only code-name rule,
kept in lock-step with tests.helpers.find_identity_leaks."""

from __future__ import annotations

import logging

import pytest
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from backend import anon
from backend.anon import REDACTED, find_leaks, scrub
from backend.config import FORBIDDEN_IDENTITY_STRINGS, FORBIDDEN_MODEL_CODENAMES
from tests.anon.strategies import any_text, leaky_text, vendor_word
from tests.helpers import find_identity_leaks

# (text, expected leaks) -- the expectation is spelled out AND cross-checked against the helper.
CORPUS: list[tuple[str, list[str]]] = [
    ("", []),
    ("R1 claims 2000 deg/s; R2 says 1000 deg/s.", []),
    ("The Luna 9 lander and one sol on Mars; ad astra.", []),
    ("Luna", []),
    ("per sol", []),
    ("ad astra", []),
    ("luna sol astra", []),
    ("console solstice lunar", []),
    ("-solstice -lunar -astral", []),  # slug context but followed by a letter
    ("the encryption key", []),  # 'grok' is not a substring match
    ("claudette and gpt4 and opusculum", []),  # word-bounded
    ("Claude said so", ["claude"]),
    ("CLAUDE, ChatGPT and grok", ["chatgpt", "claude", "grok"]),
    ("use openai/gpt-5.6-luna", ["-luna", "gpt", "openai"]),
    ("gpt-5.6-luna", ["-luna", "gpt"]),
    ("GPT-6-ASTRA", ["-astra", "gpt"]),
    ("openai/gpt-5.6-sol-pro", ["-sol", "gpt", "openai"]),
    ("anthropic/claude-opus-5", ["anthropic", "claude", "opus"]),
    ("anthropic/claude-fable-5.1", ["anthropic", "claude", "fable"]),
    ("x-ai/grok-4.6", ["grok", "x-ai"]),
    ("xAI and SpaceXAI", ["spacexai", "xai"]),
    ("Sonnet 18", ["sonnet"]),  # the rule is literal: any word-bounded product name counts
    ("gpt-4", ["gpt"]),
    ("solar-sol", ["-sol"]),
    ("(claude)", ["claude"]),
    ("claude.", ["claude"]),
    ("grok/claude", ["claude", "grok"]),
    ("R1 quotes claude-sonnet-5 verbatim", ["claude", "sonnet"]),
    ("The Claude model", ["claude"]),
]


@pytest.mark.parametrize(("text", "expected"), CORPUS, ids=[t[0] or "empty" for t in CORPUS])
def test_find_leaks_corpus_matches_helper(text, expected):
    assert find_leaks(text) == expected
    assert find_leaks(text) == find_identity_leaks(text)


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("", ""),
        ("R1 claims 2000 deg/s", "R1 claims 2000 deg/s"),
        ("The Luna 9 lander and one sol on Mars; ad astra.", None),  # None == unchanged
        ("Claude said so", f"{REDACTED} said so"),
        ("CHATGPT, ChatGPT, chatgpt", f"{REDACTED}, {REDACTED}, {REDACTED}"),
        ("use openai/gpt-5.6-luna", f"use {REDACTED}/{REDACTED}-5.6{REDACTED}"),
        ("gpt-6-astra", f"{REDACTED}-6{REDACTED}"),
        ("openai/gpt-5.6-sol-pro", f"{REDACTED}/{REDACTED}-5.6{REDACTED}-pro"),
        ("x-ai/grok-4.6", f"{REDACTED}/{REDACTED}-4.6"),
        ("anthropic/claude-opus-5", f"{REDACTED}/{REDACTED}-{REDACTED}-5"),
        ("claudette gpt4", "claudette gpt4"),
        ("-solstice", "-solstice"),
        ("solar-sol", f"solar{REDACTED}"),
    ],
)
def test_scrub_examples(text, expected):
    assert scrub(text) == (text if expected is None else expected)


def test_scrub_of_none_is_empty_string():
    assert scrub(None) == ""  # type: ignore[arg-type]
    assert find_leaks(None) == []  # type: ignore[arg-type]


@pytest.mark.parametrize("word", FORBIDDEN_IDENTITY_STRINGS)
def test_every_identity_string_is_scrubbed_in_any_case(word):
    for variant in (word, word.upper(), word.capitalize(), word.swapcase()):
        text = f"before {variant} after"
        assert scrub(text) == f"before {REDACTED} after"
        assert find_leaks(text) == [word]


@pytest.mark.parametrize("name", FORBIDDEN_MODEL_CODENAMES)
def test_codenames_need_slug_context(name):
    assert find_leaks(f"the {name} mission") == []
    assert scrub(f"the {name} mission") == f"the {name} mission"
    assert find_leaks(f"model-{name.upper()}") == [f"-{name}"]
    assert scrub(f"model-{name}") == f"model{REDACTED}"


def test_find_leaks_logs_a_warning_and_never_raises(caplog):
    with caplog.at_level(logging.WARNING, logger="triplex.anon"):
        assert find_leaks("no vendors here") == []
        assert not caplog.records
        assert find_leaks("Claude vs gpt-5.6-luna") == ["-luna", "claude", "gpt"]
    assert len(caplog.records) == 1
    assert caplog.records[0].levelno == logging.WARNING
    assert "claude" in caplog.records[0].getMessage()


def test_module_regexes_mirror_the_test_helper():
    """Same source lists, same construction -> identical patterns (belt and braces)."""
    from tests import helpers

    assert anon._IDENTITY_RE.pattern == helpers._FORBIDDEN_RE.pattern
    assert anon._IDENTITY_RE.flags == helpers._FORBIDDEN_RE.flags
    assert anon._CODENAME_RE.pattern == helpers._CODENAME_RE.pattern
    assert anon._CODENAME_RE.flags == helpers._CODENAME_RE.flags


# --------------------------------------------------------------------------- properties
_PROP = settings(max_examples=300, deadline=None, suppress_health_check=[HealthCheck.too_slow])


@_PROP
@given(text=leaky_text)
def test_no_forbidden_string_survives_scrub(text):
    assert find_leaks(text)  # the strategy always plants at least one vendor name
    cleaned = scrub(text)
    assert REDACTED in cleaned
    assert find_leaks(cleaned) == []
    assert find_identity_leaks(cleaned) == []


@_PROP
@given(text=any_text)
def test_scrub_is_idempotent_and_agrees_with_find_leaks(text):
    once = scrub(text)
    assert scrub(once) == once
    assert find_leaks(once) == []
    assert (once != text) == bool(find_leaks(text))


@_PROP
@given(text=any_text)
def test_find_leaks_agrees_with_the_test_helper(text):
    assert find_leaks(text) == find_identity_leaks(text)


@_PROP
@given(word=vendor_word, before=st.text(max_size=8), after=st.text(max_size=8))
def test_a_planted_vendor_word_never_survives_whatever_surrounds_it(word, before, after):
    cleaned = scrub(before + word + after)
    assert find_identity_leaks(cleaned) == []
    assert scrub(cleaned) == cleaned
