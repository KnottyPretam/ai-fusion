"""Conversation persistence (owner: W2). Frozen signatures — the ONLY module that touches disk.

Layout: one document per conversation at ``<DATA_DIR>/conversations/<uuid4>.json`` plus the
sidecar listing index ``_index.json`` next to them (see ``index.py``). Every write is atomic
(tmp file in the same directory + ``os.replace``, see ``files.py``). Each read-modify-write of a
document runs under that id's lazily created ``asyncio.Lock`` (``locking.lock_for``); the index
has its own lock and is always taken INSIDE a document lock, never the other way round. Nothing
is cached in the process: every call resolves ``settings().data_dir`` afresh.
"""

from __future__ import annotations

import logging
from collections.abc import Sequence
from contextlib import AbstractAsyncContextManager
from pathlib import Path
from typing import Any

from .. import api_errors
from ..config import settings
from ..schemas import (
    DEFAULT_COUNCIL,
    SLOT_IDS,
    Conversation,
    ConversationSummary,
    Label,
    SlotConfig,
    SlotId,
    ThreadMessage,
    Turn,
    TurnAdapter,
    council_labels,
    council_of,
    empty_threads,
    new_anon_map,
    now_iso,
)
from . import files, index, locking

log = logging.getLogger("triplex.store")

# Stamped by create() in mock mode so slot-keyed scenario fixtures are deterministic.
MOCK_ANON_MAP: dict[Label, SlotId] = {"R1": "claude", "R2": "chatgpt", "R3": "grok"}

DEFAULT_TITLE = "New conversation"

_INDEX_LOCK_KEY = "__index__"


def mock_anon_map(council: Sequence[SlotId]) -> dict[Label, SlotId]:
    """The fixed mock map for a council: R1..Rn in catalog order (2026-09-27), so a scenario
    README can name the label of every slot. `mock_anon_map(DEFAULT_COUNCIL) == MOCK_ANON_MAP`."""
    return dict(zip(council_labels(council), council, strict=True))


assert mock_anon_map(DEFAULT_COUNCIL) == MOCK_ANON_MAP


# --------------------------------------------------------------------------- internals
def _dir() -> Path:
    """The conversations directory for the CURRENT settings (never cached)."""
    return files.conversations_dir(settings().data_dir)


def _validate_anon_map(
    anon_map: dict[Label, SlotId], council: Sequence[SlotId] = DEFAULT_COUNCIL
) -> dict[Label, SlotId]:
    """A permutation of the COUNCIL keyed exactly by R1..Rn (validated, copied in label order)."""
    expected = council_labels(council)
    if not isinstance(anon_map, dict) or set(anon_map) != set(expected) or len(anon_map) != len(expected):
        raise ValueError(f"anon_map keys must be exactly {expected}, got {anon_map!r}")
    if sorted(anon_map.values()) != sorted(council):
        raise ValueError(f"anon_map values must be a permutation of {tuple(council)}, got {anon_map!r}")
    return {k: anon_map[k] for k in expected}


def _is_empty(conv: Conversation) -> bool:
    """No turn and no thread message: the only state in which a council may still change."""
    return not conv.turns and not any(conv.threads.values())


def _council_is_settled(conv: Conversation) -> bool:
    """Whether the council may no longer change: something was said, OR a feature call is running
    (`busy_guard`). A running Send has said nothing on disk until its first `slot_done` appends a
    pair, but its coordinator already holds the council it started with -- re-stamping the threads
    and the map under it would leave a turn keyed to slots the document no longer seats."""
    return not _is_empty(conv) or locking.is_busy(conv.id)


def _touch(conv: Conversation) -> None:
    """Bump ``updated_at`` (never backwards)."""
    ts = now_iso()
    if ts > conv.updated_at:
        conv.updated_at = ts


async def _persist(conv: Conversation) -> None:
    """Write the document, then its index entry (caller holds the document lock)."""
    d = _dir()
    files.write_document(files.document_path(d, conv.id), conv)
    async with locking.lock_for(_INDEX_LOCK_KEY):
        index.upsert(d, conv)


def _read(conv_id: str) -> Conversation | None:
    """Read a document for a syntactically valid id; None when missing (or corrupt: logged)."""
    return files.read_document(files.document_path(_dir(), conv_id))


async def _modify(conv_id: str, mutate: Any) -> Conversation:
    """Locked read-modify-write: ``mutate(conv)`` runs on the freshly loaded document, then the
    document and its index entry are written. Raises ``api_errors.not_found()`` when missing."""
    if not files.is_uuid4(conv_id):
        raise api_errors.not_found("conversation")
    async with locking.lock_for(conv_id):
        conv = _read(conv_id)
        if conv is None:
            raise api_errors.not_found("conversation")
        mutate(conv)
        _touch(conv)
        await _persist(conv)
    return conv


# --------------------------------------------------------------------------- public API (frozen)
async def create(
    slot_config: SlotConfig | None = None,
    title: str | None = None,
    *,
    anon_map: dict[Label, SlotId] | None = None,
) -> Conversation:
    """`anon_map`, when given (tests only), is validated as a permutation of the COUNCIL and
    stamped verbatim. Otherwise: `mock_anon_map(council)` when settings().mock_openrouter, else
    `new_anon_map(council=council)`. slot_config defaults to settings().default_slot_config
    (always a fresh object; never the DEFAULT_SLOT_CONFIG singleton); the config is resolved
    FIRST, because its council (`schemas.council_of`, 2..5 slots since 2026-09-27) decides the
    map and the thread keys. Title defaults to "New conversation"."""
    s = settings()
    if slot_config is None:
        cfg = s.default_slot_config  # fresh copy built per settings() call, env-overridable
    else:
        cfg = SlotConfig.model_validate(
            slot_config if isinstance(slot_config, dict) else slot_config.model_dump()
        )  # a fresh, validated object: never alias the caller's (or the DEFAULT) instance
    council = council_of(cfg)
    if anon_map is not None:
        amap = _validate_anon_map(anon_map, council)
    elif s.mock_openrouter:
        amap = mock_anon_map(council)
    else:
        amap = new_anon_map(council=council)
    conv = Conversation(
        title=DEFAULT_TITLE if title is None else title,
        slot_config=cfg,
        threads=empty_threads(council),
        anon_map=amap,
    )
    conv.updated_at = conv.created_at  # one timestamp at creation (never two now_iso() calls)
    async with locking.lock_for(conv.id):
        await _persist(conv)
    log.info("conversation created: %s", conv.id)
    return conv


async def load(conv_id: str) -> Conversation | None:
    if not files.is_uuid4(conv_id):
        return None  # a non-uuid id is "missing", never a path
    async with locking.lock_for(conv_id):
        return _read(conv_id)


async def list_summaries() -> list[ConversationSummary]:
    async with locking.lock_for(_INDEX_LOCK_KEY):
        return index.read_summaries(_dir())


async def delete(conv_id: str) -> bool:
    """False when missing (router maps to 404)."""
    if not files.is_uuid4(conv_id):
        return False
    d = _dir()
    async with locking.lock_for(conv_id):
        path = files.document_path(d, conv_id)
        try:
            path.unlink()
        except FileNotFoundError:
            return False
        async with locking.lock_for(_INDEX_LOCK_KEY):
            index.remove(d, conv_id)
    log.info("conversation deleted: %s", conv_id)
    return True


async def rename(conv_id: str, title: str) -> Conversation:
    if not isinstance(title, str):
        raise TypeError("title must be a str")

    def mutate(conv: Conversation) -> None:
        conv.title = title

    return await _modify(conv_id, mutate)


async def update_slot_config(conv_id: str, cfg: SlotConfig) -> Conversation:
    """REPLACE the stored config. Same council -> exactly as before. A DIFFERENT council (any
    change to the key set, 2026-09-27) is allowed only on an EMPTY conversation -- no turn, no
    thread message, no feature call in flight -- and re-stamps the threads and the anon map for the
    new council; after anything was said, or while a turn is running (`is_busy`, whose coordinator
    holds the council it started with), it is `409 council_changed{current, requested}`, because the
    labels in every persisted turn and the threads on disk belong to the council that produced
    them."""
    # Validate (and copy) up front so a bad config never touches the document.
    new_cfg = SlotConfig.model_validate(cfg if isinstance(cfg, dict) else cfg.model_dump())
    requested = council_of(new_cfg)

    def mutate(conv: Conversation) -> None:
        current = council_of(conv.slot_config)
        if requested != current:
            if _council_is_settled(conv):
                raise api_errors.conflict(
                    "council_changed", current=list(current), requested=list(requested)
                )
            conv.threads = empty_threads(requested)
            if settings().mock_openrouter:
                conv.anon_map = mock_anon_map(requested)
            else:
                conv.anon_map = new_anon_map(council=requested)
        conv.slot_config = new_cfg  # REPLACES the object; nothing mutates a SlotConfig in place

    return await _modify(conv_id, mutate)


async def append_to_thread(conv_id: str, slot: SlotId, msgs: list[ThreadMessage]) -> None:
    """Atomic batch append (user + assistant together). A slot outside the conversation's
    council is a ValueError (nothing written); a slot outside the catalog is one before the load."""
    if slot not in SLOT_IDS:
        raise ValueError(f"unknown slot {slot!r}")
    batch = [m if isinstance(m, ThreadMessage) else ThreadMessage.model_validate(m) for m in msgs]
    if not batch:
        return

    def mutate(conv: Conversation) -> None:
        if slot not in council_of(conv.slot_config):
            raise ValueError(f"slot {slot!r} is not in this conversation's council")
        conv.threads[slot].extend(batch)  # a document missing the key fails THIS append only

    await _modify(conv_id, mutate)


async def append_turn(conv_id: str, turn: Turn) -> None:
    """Never assigns ids; rejects duplicate turn ids."""
    obj = TurnAdapter.validate_python(turn) if isinstance(turn, dict) else turn

    def mutate(conv: Conversation) -> None:
        if any(t.id == obj.id for t in conv.turns):
            raise ValueError(f"duplicate turn id {obj.id!r} in conversation {conv.id}")
        conv.turns.append(obj)

    await _modify(conv_id, mutate)


def busy_guard(conv_id: str) -> AbstractAsyncContextManager[None]:
    """Second concurrent feature call on the same conversation -> api_errors.conflict('busy').

    Entered by the FEATURE before its first yield (`guard = store.busy_guard(conv_id);
    await guard.__aenter__()` raises conflict('busy')) and released via
    `await guard.__aexit__(None, None, None)` in the producer task's `finally` after the last
    persistence write -- never by the generator's own close, so a disconnected client does not
    release it early. Re-entrant per task: implemented with a contextvars.ContextVar of held ids
    plus a module-level set; entering for an id already held by the current task (or a task
    created from it) is a no-op. This is what lets run_fusion call run_analyze.
    Enter the guard as the LAST pre-check, after every 404/409/422 check, so a nested run_analyze
    never raises a pre-stream error while the outer guard is held. A guard object that entered as
    a re-entrant no-op exits as a no-op; only the object that actually acquired the id releases
    it (W2 test: enter twice in one task, exit the inner one, the id is still busy elsewhere).

    The store keeps NO process-level cache of documents or the index: every call resolves
    settings().data_dir afresh (tests switch DATA_DIR per test). Only per-id asyncio.Locks and
    the busy set live in module dicts, created lazily.
    """
    return locking.BusyGuard(conv_id)


def is_busy(conv_id: str) -> bool:
    """Whether some task currently holds ``busy_guard(conv_id)`` (introspection for tests/UI)."""
    return locking.is_busy(conv_id)
