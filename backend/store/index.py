"""Sidecar listing index for the conversation store (owner: W2).

``GET /api/conversations`` must not parse every document, so every write to a conversation
(create / rename / update_slot_config / append_to_thread / append_turn / delete) also upserts or
removes that conversation's :class:`ConversationSummary` in one small JSON file next to the
documents: ``<DATA_DIR>/conversations/_index.json``.

The index is a derived structure. ``read_summaries`` reconciles it against the directory listing
(cheap ``os.scandir``, no document parsing): entries whose document vanished are dropped, and
documents that are not indexed yet (an index lost or written by an older version, or a crash
between the document write and the index write) are parsed once and added. Ordering is by
``updated_at`` (newest first); ties keep "most recently written first" because every upsert moves
the entry to the end of the file and the sort is stable.

Nothing here is cached in the process: the path is resolved from the caller on every call.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from ..schemas import SCHEMA_VERSION, Conversation, ConversationSummary
from . import files

log = logging.getLogger("triplex.store")

INDEX_FILENAME = "_index.json"


def index_path(conversations_dir: Path) -> Path:
    return conversations_dir / INDEX_FILENAME


def summary_of(conv: Conversation) -> ConversationSummary:
    return ConversationSummary(
        id=conv.id,
        title=conv.title,
        created_at=conv.created_at,
        updated_at=conv.updated_at,
        turn_count=len(conv.turns),
    )


# --------------------------------------------------------------------------- raw file access
def _read(conversations_dir: Path) -> dict[str, dict[str, Any]]:
    """Ordered id -> summary dict as stored on disk; empty when the file is missing/corrupt."""
    path = index_path(conversations_dir)
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as e:
        log.error("conversation index unreadable, rebuilding from documents: %s: %s", path, e)
        return {}
    entries: dict[str, dict[str, Any]] = {}
    items = raw.get("conversations") if isinstance(raw, dict) else None
    for item in items or []:
        try:
            s = ConversationSummary.model_validate(item)
        except ValueError:
            log.warning("dropping malformed index entry: %r", item)
            continue
        entries[s.id] = s.model_dump()
    return entries


def _write(conversations_dir: Path, entries: dict[str, dict[str, Any]]) -> None:
    payload = {"schema_version": SCHEMA_VERSION, "conversations": list(entries.values())}
    files.write_json_atomic(index_path(conversations_dir), payload)


# --------------------------------------------------------------------------- mutations
def upsert(conversations_dir: Path, conv: Conversation) -> None:
    """Record ``conv``'s summary; the entry moves to the end (= most recently written)."""
    entries = _read(conversations_dir)
    entries.pop(conv.id, None)
    entries[conv.id] = summary_of(conv).model_dump()
    _write(conversations_dir, entries)


def remove(conversations_dir: Path, conv_id: str) -> None:
    entries = _read(conversations_dir)
    if entries.pop(conv_id, None) is not None:
        _write(conversations_dir, entries)


# --------------------------------------------------------------------------- listing
def read_summaries(conversations_dir: Path) -> list[ConversationSummary]:
    """All summaries, newest ``updated_at`` first, after reconciling the index with the directory."""
    if not conversations_dir.is_dir():
        return []
    entries = _read(conversations_dir)
    on_disk = files.document_ids(conversations_dir)
    dirty = False
    for stale in [cid for cid in entries if cid not in on_disk]:
        entries.pop(stale)
        dirty = True
    for cid in on_disk - entries.keys():
        conv = files.read_document(files.document_path(conversations_dir, cid))
        if conv is None:
            continue
        entries[cid] = summary_of(conv).model_dump()
        dirty = True
        log.info("indexed unlisted conversation %s", cid)
    if dirty:
        _write(conversations_dir, entries)
    ordered = list(entries.values())
    ordered.reverse()  # most recently written first; the stable sort below keeps that for ties
    ordered.sort(key=lambda e: e["updated_at"], reverse=True)
    return [ConversationSummary.model_validate(e) for e in ordered]
