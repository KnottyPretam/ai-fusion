"""The vendor catalog behind the council (2026-09-27, "a council anyone can assemble"). Pure.

Seven vendors, in `schemas.SLOT_IDS` order: the classic three (each with a Stage-1 web adapter --
`WEB_SITES`, the bridge's own `BRIDGE_SLOTS`), then the four a council may also seat. Every agent
runs on ONE transport, named by its model string exactly as before (`SlotSpec.model`):

- `web:<slot>`        a subscription session in the desktop app (only a site with an adapter);
- `ollama:<name>`     a local model (the "uncensored" DeepSeek / Qwen / MiMo variants, typically);
- `<org>/<model>`     an OpenRouter slug, billed to the one session key.

`vendor_of_model` is what sorts an OpenRouter catalog into the vendors a council can seat: the slug
prefix names the vendor for the official models, and a family word on the slug tail or the display
name admits the community "uncensored" variants published under other orgs
(`huihui-ai/qwen3-abliterated`, `cognitivecomputations/dolphin-deepseek-...`); a slug that matches
neither belongs to no vendor and never reaches the Agents page. The same words classify an
`ollama:<name>`. Default slugs were checked against the live OpenRouter `/models` on 2026-09-27.

Display names, identities and default models are DATA for the desktop and the export -- nothing
here is ever interpolated into a prompt (every string is an identity the leak tests forbid).
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Sequence
from dataclasses import dataclass

from .llm.bridge_protocol import BRIDGE_SLOTS
from .schemas import SLOT_IDS, Effort, ModelMeta, SlotId, SlotSpec


@dataclass(frozen=True)
class Vendor:
    id: SlotId
    name: str  # the product name a user picks: "ChatGPT", "Qwen"
    prefixes: tuple[str, ...]  # OpenRouter slug orgs ("google/..."), the official models
    family_words: tuple[str, ...]  # model-family words on a slug tail, a name or an Ollama tag
    identity: str  # the organisation behind it, for a row's caption: "Alibaba"
    web_site: bool  # has a Stage-1 web adapter (a `web:<slot>` model is allowed)
    stage2_site: bool  # gets a web adapter in Stage 2 (a site, but no adapter yet)
    default_model: str  # the OpenRouter slug a fresh row starts on
    default_effort: Effort = "medium"  # an effort that slug supports (the catalog is strict)


CATALOG: tuple[Vendor, ...] = (
    Vendor(
        id="claude",
        name="Claude",
        prefixes=("anthropic",),
        family_words=("claude",),
        identity="Anthropic",
        web_site=True,
        stage2_site=False,
        default_model="anthropic/claude-opus-5",
    ),
    Vendor(
        id="chatgpt",
        name="ChatGPT",
        prefixes=("openai",),
        family_words=("gpt",),
        identity="OpenAI",
        web_site=True,
        stage2_site=False,
        default_model="openai/gpt-5.6-sol",
    ),
    Vendor(
        id="grok",
        name="Grok",
        prefixes=("x-ai",),
        family_words=("grok",),
        identity="xAI",
        web_site=True,
        stage2_site=False,
        default_model="x-ai/grok-4.6",
    ),
    Vendor(
        id="gemini",
        name="Gemini",
        prefixes=("google",),
        family_words=("gemini",),
        identity="Google",
        web_site=False,
        stage2_site=True,
        default_model="google/gemini-3.8-flash",
    ),
    Vendor(
        id="deepseek",
        name="DeepSeek",
        prefixes=("deepseek",),
        family_words=("deepseek",),
        identity="DeepSeek",
        web_site=False,
        stage2_site=True,
        default_model="deepseek/deepseek-v4-pro",
        default_effort="high",  # the slug lists high / xhigh only
    ),
    Vendor(
        id="qwen",
        name="Qwen",
        prefixes=("qwen",),
        family_words=("qwen", "qwq"),
        identity="Alibaba",
        web_site=False,
        stage2_site=True,
        default_model="qwen/qwen3.7-max",
    ),
    Vendor(
        id="mimo",
        name="MiMo",
        prefixes=("xiaomi",),
        family_words=("mimo",),
        identity="Xiaomi",
        web_site=False,
        stage2_site=False,  # token or local only: its chat site is not a subscription surface
        default_model="xiaomi/mimo-v2.6-pro",
    ),
)
BY_ID: dict[SlotId, Vendor] = {v.id: v for v in CATALOG}
assert tuple(BY_ID) == SLOT_IDS, "the vendor catalog must list every slot in SLOT_IDS order"

WEB_SITES: tuple[SlotId, ...] = tuple(v.id for v in CATALOG if v.web_site)
assert WEB_SITES == BRIDGE_SLOTS, "the web sites are exactly the bridge's slot vocabulary"
STAGE2_SITES: tuple[SlotId, ...] = tuple(v.id for v in CATALOG if v.stage2_site)

_BY_PREFIX: dict[str, Vendor] = {p: v for v in CATALOG for p in v.prefixes}
# A family word matches at a word START only, digits and hyphens free to follow ("qwen3",
# "gpt-oss"), so "gpt" never fires inside "chatgpt". The tail rule is a best-effort classifier of
# community slugs: a false positive only offers one more model in a row, never a wrong transport.
_FAMILY_RE: dict[str, re.Pattern[str]] = {
    w: re.compile(rf"(?<![a-z]){re.escape(w)}", re.IGNORECASE)
    for v in CATALOG
    for w in v.family_words
}


def display_name(slot: SlotId) -> str:
    return BY_ID[slot].name


def default_slot_spec(slot: SlotId) -> SlotSpec:
    """A fresh `SlotSpec` on the vendor's default OpenRouter slug."""
    v = BY_ID[slot]
    return SlotSpec(model=v.default_model, effort=v.default_effort)


def _by_family(text: str) -> Vendor | None:
    for v in CATALOG:
        for w in v.family_words:
            if _FAMILY_RE[w].search(text):
                return v
    return None


def vendor_of_model(model_id: str, name: str = "") -> Vendor | None:
    """The vendor a model string belongs to, or None (module docstring):

    `web:<slot>[:analyst]` -> that slot's vendor; `ollama:<name>` -> the family word in the name;
    an OpenRouter slug -> its org prefix, else the family word on the slug tail or the display
    name; anything else None."""
    if not isinstance(model_id, str) or not model_id:
        return None
    if model_id.startswith("web:"):
        parts = model_id.split(":")
        return BY_ID.get(parts[1]) if len(parts) in (2, 3) else None  # type: ignore[arg-type]
    if model_id.startswith("ollama:"):
        return _by_family(model_id[len("ollama:") :])
    org, sep, tail = model_id.partition("/")
    if sep:
        by_prefix = _BY_PREFIX.get(org.lower())
        if by_prefix is not None:
            return by_prefix
    return _by_family(tail if sep else model_id) or (_by_family(name) if name else None)


def openrouter_filter[M: ModelMeta](models: Iterable[M]) -> list[M]:
    """The entries of an OpenRouter catalog a council row can seat, in the input order: those
    `vendor_of_model` assigns to a vendor. The objects are returned as given, never copied."""
    return [m for m in models if vendor_of_model(m.id, m.name) is not None]


def vendors_of(models: Sequence[ModelMeta]) -> dict[SlotId, list[ModelMeta]]:
    """`{slot: [entries]}` over the vendors present, catalog order, for a per-row model list."""
    out: dict[SlotId, list[ModelMeta]] = {}
    for m in models:
        v = vendor_of_model(m.id, m.name)
        if v is not None:
            out.setdefault(v.id, []).append(m)
    return {slot: out[slot] for slot in SLOT_IDS if slot in out}


__all__ = [
    "BY_ID",
    "CATALOG",
    "STAGE2_SITES",
    "WEB_SITES",
    "Vendor",
    "default_slot_spec",
    "display_name",
    "openrouter_filter",
    "vendor_of_model",
    "vendors_of",
]
