"""Locking helpers for the conversation store (owner: W2).

Two independent mechanisms live here:

* ``lock_for(key)`` -- a per-key :class:`asyncio.Lock`, created lazily in a module dict. The store
  holds it only around one read-modify-write of a document (or of the sidecar index), never
  across network awaits. Locks are re-created when the running event loop changes: pytest-asyncio
  hands every test a fresh loop and an asyncio.Lock that once had waiters is bound to the loop it
  was used on.
* :class:`BusyGuard` -- the feature-level "one feature call per conversation at a time" guard
  behind ``conversations.busy_guard``. State is a module-level set of busy ids plus a
  :class:`contextvars.ContextVar` of the ids held by the current task (and every task created
  from it, since ``asyncio.create_task`` copies the context). Semantics are spelled out in the
  ``busy_guard`` docstring in ``conversations.py``.
"""

from __future__ import annotations

import asyncio
import contextvars
from contextlib import AbstractAsyncContextManager
from types import TracebackType

from .. import api_errors

# --------------------------------------------------------------------------- per-key locks
_locks: dict[str, tuple[asyncio.AbstractEventLoop, asyncio.Lock]] = {}


def lock_for(key: str) -> asyncio.Lock:
    """The lazily created lock for ``key`` on the running loop (recreated if the loop changed)."""
    loop = asyncio.get_running_loop()
    entry = _locks.get(key)
    if entry is None or entry[0] is not loop:
        lock = asyncio.Lock()
        _locks[key] = (loop, lock)
        return lock
    return entry[1]


# --------------------------------------------------------------------------- busy guard
# conv_id -> acquisition token. Re-entrancy is bound to the SPECIFIC acquisition, not the id:
# a context that once held an id keeps a stale entry after a producer task (a context copy)
# released it, and that stale entry must not let it bypass a later acquisition by another task.
_busy: dict[str, object] = {}
_held: contextvars.ContextVar[dict[str, object] | None] = contextvars.ContextVar(
    "triplex_busy_held", default=None
)


def _held_map() -> dict[str, object]:
    return _held.get() or {}


def is_busy(conv_id: str) -> bool:
    return conv_id in _busy


class BusyGuard(AbstractAsyncContextManager[None]):
    """Async context manager returned by ``conversations.busy_guard``.

    ``__aenter__`` raises ``api_errors.conflict("busy")`` when another acquisition holds the id.
    When the current task (or one it was created from) holds the CURRENT acquisition, entering is
    a no-op and so is the matching exit: only the object that actually acquired the id releases
    it. A stale entry left in a context by an acquisition that was released elsewhere (the
    producer-task pattern) never counts as re-entrant.
    """

    __slots__ = ("_acquired", "_token", "conv_id")

    def __init__(self, conv_id: str) -> None:
        self.conv_id = conv_id
        self._acquired = False
        self._token: object | None = None

    @property
    def acquired(self) -> bool:
        """True while THIS object holds the busy flag for its id."""
        return self._acquired

    async def __aenter__(self) -> None:
        cid = self.conv_id
        current = _busy.get(cid)
        if current is not None:
            if _held_map().get(cid) is current:
                return None  # re-entrant: this task (or an ancestor) holds the live acquisition
            raise api_errors.conflict("busy")
        token = object()
        _busy[cid] = token
        _held.set({**_held_map(), cid: token})
        self._token = token
        self._acquired = True
        return None

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        if not self._acquired:
            return None  # entered as a re-entrant no-op (or never entered): exit is a no-op
        self._acquired = False
        if _busy.get(self.conv_id) is self._token:
            del _busy[self.conv_id]
        # Rebuild rather than ContextVar.reset(): the release usually happens in a producer task
        # whose context is a COPY of the acquiring one, where a reset token would be invalid.
        held = dict(_held_map())
        if held.get(self.conv_id) is self._token:
            del held[self.conv_id]
        _held.set(held)
        self._token = None
        return None
