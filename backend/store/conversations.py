"""Conversation persistence (owner: W2). Frozen signatures — the ONLY module that touches disk."""

from __future__ import annotations

from contextlib import AbstractAsyncContextManager

from ..schemas import (
    Conversation,
    ConversationSummary,
    Label,
    SlotConfig,
    SlotId,
    ThreadMessage,
    Turn,
)

# Stamped by create() in mock mode so slot-keyed scenario fixtures are deterministic.
MOCK_ANON_MAP: dict[Label, SlotId] = {"R1": "claude", "R2": "chatgpt", "R3": "grok"}


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
    raise NotImplementedError("W2: backend.store.conversations.create")


async def load(conv_id: str) -> Conversation | None:
    raise NotImplementedError("W2: backend.store.conversations.load")


async def list_summaries() -> list[ConversationSummary]:
    raise NotImplementedError("W2: backend.store.conversations.list_summaries")


async def delete(conv_id: str) -> bool:
    """False when missing (router maps to 404)."""
    raise NotImplementedError("W2: backend.store.conversations.delete")


async def rename(conv_id: str, title: str) -> Conversation:
    raise NotImplementedError("W2: backend.store.conversations.rename")


async def update_slot_config(conv_id: str, cfg: SlotConfig) -> Conversation:
    raise NotImplementedError("W2: backend.store.conversations.update_slot_config")


async def append_to_thread(conv_id: str, slot: SlotId, msgs: list[ThreadMessage]) -> None:
    """Atomic batch append (user + assistant together)."""
    raise NotImplementedError("W2: backend.store.conversations.append_to_thread")


async def append_turn(conv_id: str, turn: Turn) -> None:
    """Never assigns ids; rejects duplicate turn ids."""
    raise NotImplementedError("W2: backend.store.conversations.append_turn")


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
    raise NotImplementedError("W2: backend.store.conversations.busy_guard")
