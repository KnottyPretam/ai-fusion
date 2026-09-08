"""Anonymization firewall (owner: W3). Frozen signatures.

Models only ever see each other as R1/R2/R3. The R-label <-> slot mapping is stamped once by
`store.create` (persisted `Conversation.anon_map`), read back here and nowhere else, and never
appears in prompts, API responses or the UI (docs/semantics.md, "Anonymization / leaks").

- `labels` / `label_of` / `slot_of` read the persisted permutation (ValueError on a bad map or an
  unknown id; the mapping is never re-derived from position).
- `render_peer_block` renders what a challenged model is shown about its peers: one
  `prompts.delimited(label, ...)` section per peer other than the challenged label, preceded by
  `prompts.QUOTED_DATA_NOTICE`, in R1/R2/R3 order; every claim and justification is `scrub`bed
  first.
- `scrub` replaces every `config.FORBIDDEN_IDENTITY_STRINGS` match (case-insensitive, word-bounded:
  not preceded/followed by [A-Za-z0-9]) and every `config.FORBIDDEN_MODEL_CODENAMES` match in slug
  context (preceded by "-") with `REDACTED`; `find_leaks` reports the same matches, mirroring
  `tests.helpers.find_identity_leaks` exactly (codenames as "-luna" etc.), logs a warning and
  never raises: runtime leak checks are advisory, never blocking.
"""

from __future__ import annotations

import logging
import re

from .config import FORBIDDEN_IDENTITY_STRINGS, FORBIDDEN_MODEL_CODENAMES
from .prompts import QUOTED_DATA_NOTICE, delimited
from .schemas import LABELS, SLOT_IDS, Conversation, Label, PeerState, SlotId

log = logging.getLogger("triplex.anon")

REDACTED = "[model]"
NONE_GIVEN = "(none given)"
NO_PEERS = "(no peer positions)"

# Both patterns mirror tests/helpers.py verbatim so `find_leaks` and the leak tests agree.
_IDENTITY_RE = re.compile(
    r"(?<![A-Za-z0-9])("
    + "|".join(re.escape(s) for s in FORBIDDEN_IDENTITY_STRINGS)
    + r")(?![A-Za-z0-9])",
    re.IGNORECASE,
)
# Code names collide with ordinary vocabulary ("Luna 9", "per sol", "ad astra"): slug context only.
_CODENAME_RE = re.compile(
    r"-(" + "|".join(re.escape(s) for s in FORBIDDEN_MODEL_CODENAMES) + r")(?![A-Za-z0-9])",
    re.IGNORECASE,
)
_LABEL_ORDER: dict[str, int] = {label: i for i, label in enumerate(LABELS)}


# --------------------------------------------------------------------------- mapping
def labels(conv: Conversation) -> dict[Label, SlotId]:
    """The persisted R-label -> slot permutation, keyed in R1/R2/R3 order (a fresh dict).

    Raises ValueError when the document carries no `anon_map` or the map is not a permutation
    of the slot ids over exactly the labels R1/R2/R3."""
    raw = getattr(conv, "anon_map", None)
    if not isinstance(raw, dict) or not raw:
        raise ValueError("conversation has no anon_map")
    try:
        ok = set(raw) == set(LABELS) and set(raw.values()) == set(SLOT_IDS)
    except TypeError:  # unhashable garbage
        ok = False
    if not ok:
        raise ValueError("anon_map must map exactly R1/R2/R3 to a permutation of the slot ids")
    return {label: raw[label] for label in LABELS}


def label_of(conv: Conversation, slot: SlotId) -> Label:
    """The R-label a slot is shown as in this conversation (ValueError for an unknown slot)."""
    for label, mapped in labels(conv).items():
        if mapped == slot:
            return label
    raise ValueError(f"unknown slot {slot!r}")


def slot_of(conv: Conversation, label: Label) -> SlotId:
    """The slot behind an R-label in this conversation (ValueError for an unknown label)."""
    mapping = labels(conv)
    if label not in mapping:
        raise ValueError(f"unknown label {label!r}")
    return mapping[label]


# --------------------------------------------------------------------------- peer block
def render_peer_block(peers: list[PeerState], exclude: Label) -> str:
    """What the model challenged as `exclude` is shown about its peers.

    `QUOTED_DATA_NOTICE`, then one `delimited(label, ...)` section per peer other than `exclude`
    in deterministic R1, R2, R3 order, each carrying the scrubbed claim and the scrubbed latest
    justification (or "(none given)"). Peer text is quoted data: it is never interpolated
    outside the delimiters and never reaches the prompt unscrubbed."""
    states = [p if isinstance(p, PeerState) else PeerState.model_validate(p) for p in peers]
    shown = sorted(
        (p for p in states if p.label != exclude),
        key=lambda p: _LABEL_ORDER.get(p.label, len(_LABEL_ORDER)),
    )
    parts = [QUOTED_DATA_NOTICE]
    if not shown:
        parts.append(NO_PEERS)
    for peer in shown:
        justification = peer.justification
        if justification is None or not justification.strip():
            justification = NONE_GIVEN
        else:
            justification = scrub(justification.strip())
        body = f"Claim: {scrub(peer.claim.strip())}\nLatest justification: {justification}"
        parts.append(delimited(peer.label, body))
    return "\n\n".join(parts)


# --------------------------------------------------------------------------- scrubbing
def scrub(text: str) -> str:
    """Replace every forbidden identity string (word-bounded, any case) and every model code
    name in slug context ("-luna", "-sol", "-astra") with `REDACTED`. Idempotent; text without
    a match is returned unchanged."""
    if not text:
        return ""
    return _CODENAME_RE.sub(REDACTED, _IDENTITY_RE.sub(REDACTED, text))


def find_leaks(text: str) -> list[str]:
    """Sorted, de-duplicated, lower-cased forbidden matches in `text` (code names reported with
    their leading "-"). Mirrors `tests.helpers.find_identity_leaks(text)` exactly. Logs a
    warning when anything is found; never raises."""
    if not text:
        return []
    found = {m.group(1).lower() for m in _IDENTITY_RE.finditer(text)}
    found |= {"-" + m.group(1).lower() for m in _CODENAME_RE.finditer(text)}
    leaks = sorted(found)
    if leaks:
        log.warning("identity leak in Triplex-authored text: %s", leaks)
    return leaks
