"""Hypothesis strategies shared by the tests/anon property tests."""

from __future__ import annotations

from hypothesis import strategies as st

from backend.config import FORBIDDEN_IDENTITY_STRINGS, FORBIDDEN_MODEL_CODENAMES

# Vendor / product names plus real slugs (code names only leak in slug context).
VENDOR_WORDS: tuple[str, ...] = FORBIDDEN_IDENTITY_STRINGS + (
    "gpt-5.6-luna",
    "gpt-5.6-sol",
    "gpt-6-astra",
    "openai/gpt-5.6-luna",
    "anthropic/claude-opus-5",
    "anthropic/claude-fable-5.1",
    "x-ai/grok-4.6",
    "claude-sonnet-5",
)
# Ordinary vocabulary that contains a code name but must NOT count as a leak.
INNOCENT_WORDS: tuple[str, ...] = tuple(
    w.capitalize() if i % 2 else w
    for i, w in enumerate(FORBIDDEN_MODEL_CODENAMES + ("Luna 9", "per sol", "ad astra", "console"))
)


def _random_case(word: str) -> st.SearchStrategy[str]:
    return st.lists(st.booleans(), min_size=len(word), max_size=len(word)).map(
        lambda mask: "".join(
            c.upper() if up else c.lower() for c, up in zip(word, mask, strict=True)
        )
    )


vendor_word = st.sampled_from(VENDOR_WORDS).flatmap(_random_case)
innocent_word = st.sampled_from(INNOCENT_WORDS)
filler = st.text(max_size=24)

# Arbitrary text with vendor names in random casing at random positions. Chunks are glued
# without separators (so vendor names may also land inside longer words, where they are NOT
# leaks by the word-boundary rule); one space-padded vendor word is always planted so every
# example carries at least one real leak.
leaky_text = st.lists(
    st.one_of(filler, vendor_word, innocent_word), min_size=1, max_size=12
).flatmap(
    lambda chunks: st.tuples(st.integers(min_value=0, max_value=len(chunks)), vendor_word).map(
        lambda ins: "".join(chunks[: ins[0]] + [f" {ins[1]} "] + chunks[ins[0] :])
    )
)

# Text that may or may not contain vendor names.
any_text = st.one_of(st.text(), leaky_text)
