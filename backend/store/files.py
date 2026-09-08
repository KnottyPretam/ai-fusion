"""Disk layout and atomic file helpers for the conversation store (owner: W2).

Layout under ``settings().data_dir`` (resolved by the caller on every call, never cached):

    <DATA_DIR>/conversations/<uuid4>.json     one document per conversation
    <DATA_DIR>/conversations/_index.json      sidecar listing index (see index.py)

Every write goes to a fresh ``*.tmp`` file in the same directory, is flushed and fsynced, then
``os.replace``d over the target, so a reader (or a crash) never sees a partial document. All the
I/O here is blocking; it is small local JSON and the store calls it while holding the per-id
lock.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
import uuid
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from ..schemas import Conversation

log = logging.getLogger("triplex.store")

CONVERSATIONS_DIRNAME = "conversations"
DOC_SUFFIX = ".json"
TMP_SUFFIX = ".tmp"


def conversations_dir(data_dir: Path) -> Path:
    return data_dir / CONVERSATIONS_DIRNAME


def is_uuid4(value: object) -> bool:
    """True only for the canonical lowercase hyphenated form of a version-4 UUID."""
    if not isinstance(value, str):
        return False
    try:
        u = uuid.UUID(value)
    except ValueError:
        return False
    return u.version == 4 and str(u) == value


def document_path(conversations_dir: Path, conv_id: str) -> Path:
    """Path of the document for a VALIDATED uuid4 id (callers check ``is_uuid4`` first)."""
    if not is_uuid4(conv_id):  # defence in depth: never build a path from arbitrary text
        raise ValueError(f"not a uuid4 conversation id: {conv_id!r}")
    return conversations_dir / f"{conv_id}{DOC_SUFFIX}"


def document_ids(conversations_dir: Path) -> set[str]:
    """Ids of the documents present on disk (no parsing; tmp files and strays ignored)."""
    ids: set[str] = set()
    try:
        with os.scandir(conversations_dir) as it:
            for entry in it:
                name = entry.name
                if name.endswith(DOC_SUFFIX) and entry.is_file():
                    stem = name[: -len(DOC_SUFFIX)]
                    if is_uuid4(stem):
                        ids.add(stem)
    except FileNotFoundError:
        pass
    return ids


# --------------------------------------------------------------------------- json I/O
def write_json_atomic(path: Path, payload: Any) -> None:
    """Serialize ``payload`` to ``path`` via tmp-in-same-dir + fsync + ``os.replace``."""
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(payload, indent=2, ensure_ascii=False)
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=TMP_SUFFIX, dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_name, path)
    except BaseException:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


def read_json(path: Path) -> Any | None:
    """Parsed JSON, or None when the file does not exist."""
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return None


def read_document(path: Path) -> Conversation | None:
    """The validated Conversation at ``path``; None when missing. A corrupt document is logged and
    also reported as missing rather than crashing the caller."""
    try:
        raw = read_json(path)
    except (OSError, ValueError) as e:
        log.error("conversation document unreadable: %s: %s", path, e)
        return None
    if raw is None:
        return None
    try:
        return Conversation.model_validate(raw)
    except ValidationError as e:
        log.error("conversation document invalid: %s: %s", path, e)
        return None


def write_document(path: Path, conv: Conversation) -> None:
    write_json_atomic(path, conv.model_dump(mode="json"))
