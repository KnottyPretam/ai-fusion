"""Conversation persistence (owner: W2). Frozen signatures — the ONLY module that touches disk."""

from __future__ import annotations

from contextlib import AbstractAsyncContextManager

from ..schemas import Conversation, ConversationSummary, SlotConfig, SlotId, ThreadMessage, Turn


async def create(slot_config: SlotConfig | None = None, title: str | None = None) -> Conversation:
    raise NotImplementedError("W2: backend.store.conversations.create")


async def load(conv_id: str) -> Conversation | None:
    raise NotImplementedError("W2: backend.store.conversations.load")


async def list_summaries() -> list[ConversationSummary]:
    raise NotImplementedError("W2: backend.store.conversations.list_summaries")


async def delete(conv_id: str) -> bool:
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
    """Second concurrent feature call on the same conversation -> api_errors.conflict('busy')."""
    raise NotImplementedError("W2: backend.store.conversations.busy_guard")
