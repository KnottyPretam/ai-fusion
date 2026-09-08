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
_busy: set[str] = set()
_held: contextvars.ContextVar[frozenset[str]] = contextvars.ContextVar(
    "triplex_busy_held", default=frozenset()
)


def is_busy(conv_id: str) -> bool:
    return conv_id in _busy


class BusyGuard(AbstractAsyncContextManager[None]):
    """Async context manager returned by ``conversations.busy_guard``.

    ``__aenter__`` raises ``api_errors.conflict("busy")`` when another task holds the id. When the
    current task (or one it was created from) already holds it, entering is a no-op and so is the
    matching exit: only the object that actually acquired the id releases it.
    """

    __slots__ = ("_acquired", "conv_id")

    def __init__(self, conv_id: str) -> None:
        self.conv_id = conv_id
        self._acquired = False

    @property
    def acquired(self) -> bool:
        """True while THIS object holds the busy flag for its id."""
        return self._acquired

    async def __aenter__(self) -> None:
        cid = self.conv_id
        if cid in _busy:
            if cid in _held.get():
                return None  # re-entrant: held by this task or an ancestor -> no-op
            raise api_errors.conflict("busy")
        _busy.add(cid)
        _held.set(_held.get() | {cid})
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
        _busy.discard(self.conv_id)
        # Set-difference rather than ContextVar.reset(): the release usually happens in a
        # producer task whose context is a COPY of the acquiring one, where a reset token would
        # be invalid, and a reset could also clobber ids acquired later in the same context.
        _held.set(_held.get() - {self.conv_id})
        return None
