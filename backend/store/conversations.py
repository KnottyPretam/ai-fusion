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
from contextlib import AbstractAsyncContextManager
from pathlib import Path
from typing import Any

from .. import api_errors
from ..config import settings
from ..schemas import (
    LABELS,
    SLOT_IDS,
    Conversation,
    ConversationSummary,
    Label,
    SlotConfig,
    SlotId,
    ThreadMessage,
    Turn,
    TurnAdapter,
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


# --------------------------------------------------------------------------- internals
def _dir() -> Path:
    """The conversations directory for the CURRENT settings (never cached)."""
    return files.conversations_dir(settings().data_dir)


def _validate_anon_map(anon_map: dict[Label, SlotId]) -> dict[Label, SlotId]:
    """A permutation of SLOT_IDS keyed exactly by R1/R2/R3 (validated, copied in label order)."""
    if not isinstance(anon_map, dict) or set(anon_map) != set(LABELS):
        raise ValueError(f"anon_map keys must be exactly {LABELS}, got {anon_map!r}")
    if sorted(anon_map.values()) != sorted(SLOT_IDS):
        raise ValueError(f"anon_map values must be a permutation of {SLOT_IDS}, got {anon_map!r}")
    return {k: anon_map[k] for k in LABELS}


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
    """`anon_map`, when given (tests only), is validated as a permutation of SLOT_IDS and stamped
    verbatim. Otherwise: MOCK_ANON_MAP when settings().mock_openrouter, else new_anon_map().
    slot_config defaults to settings().default_slot_config (always a fresh object; never the
    DEFAULT_SLOT_CONFIG singleton). Title defaults to "New conversation"."""
    s = settings()
    if anon_map is not None:
        amap = _validate_anon_map(anon_map)
    elif s.mock_openrouter:
        amap = dict(MOCK_ANON_MAP)
    else:
        amap = new_anon_map()
    if slot_config is None:
        cfg = s.default_slot_config  # fresh copy built per settings() call, env-overridable
    else:
        cfg = SlotConfig.model_validate(
            slot_config if isinstance(slot_config, dict) else slot_config.model_dump()
        )  # a fresh, validated object: never alias the caller's (or the DEFAULT) instance
    conv = Conversation(
        title=DEFAULT_TITLE if title is None else title,
        slot_config=cfg,
        threads=empty_threads(),
        anon_map=amap,
    )
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
    # Validate (and copy) up front so a bad config never touches the document.
    new_cfg = SlotConfig.model_validate(cfg if isinstance(cfg, dict) else cfg.model_dump())

    def mutate(conv: Conversation) -> None:
        conv.slot_config = new_cfg  # REPLACES the object; nothing mutates a SlotConfig in place

    return await _modify(conv_id, mutate)


async def append_to_thread(conv_id: str, slot: SlotId, msgs: list[ThreadMessage]) -> None:
    """Atomic batch append (user + assistant together)."""
    if slot not in SLOT_IDS:
        raise ValueError(f"unknown slot {slot!r}")
    batch = [m if isinstance(m, ThreadMessage) else ThreadMessage.model_validate(m) for m in msgs]
    if not batch:
        return

    def mutate(conv: Conversation) -> None:
        conv.threads[slot].extend(batch)

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
