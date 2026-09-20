"""Frozen entry point for the backend (PyInstaller).

`python -m backend.main` is the development path; a frozen build has no module runner and no
importable package tree, so this is the script PyInstaller freezes. It is deliberately thin: it
only starts the server the same way `backend/main.py` does under `__main__`, so there is exactly
one definition of what the backend is.

Routers are discovered with `pkgutil.iter_modules` over `backend.routers`, which finds nothing
inside a frozen archive -- the import below pulls every router in explicitly so the analysis keeps
them, and `main.create_app()` then mounts them from the already-imported modules.
"""

from __future__ import annotations

import multiprocessing
import sys


def main() -> int:
    # A frozen app that spawns (uvicorn reload, any executor) must not re-run the bootstrap.
    multiprocessing.freeze_support()

    import uvicorn

    from backend import main as backend_main
    from backend.config import settings

    s = settings()
    uvicorn.run(backend_main.app, host=s.host, port=s.port, log_level=s.log_level.lower())
    return 0


if __name__ == "__main__":
    sys.exit(main())
