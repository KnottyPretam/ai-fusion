# PyInstaller spec for the backend — `uv run --group packaging pyinstaller packaging/backend.spec`.
#
# onedir, not onefile: onefile unpacks to a temp directory on every launch, which costs a second of
# startup and leaves the app's own backend looking like a fresh binary to the OS each time. The
# directory is shipped whole as an Electron extraResource.
#
# `backend/main.py` finds its routers with `pkgutil.iter_modules`, which sees nothing inside a
# frozen archive, so every router is named as a hidden import here. Anything under `backend/` that
# is imported lazily (the routers, uvicorn's protocol implementations) has to be listed or it is
# simply not in the build.

from pathlib import Path

from PyInstaller.utils.hooks import collect_submodules

# `SPECPATH` is injected by PyInstaller: the directory holding this file. Resolving the repo from it
# rather than from the working directory means the build is the same wherever it is started.
ROOT = Path(SPECPATH).resolve().parent

# DERIVED from the filesystem, not hand-maintained. A hand-written list is a trap: adding a router is
# a one-line change in `backend/routers/` that works perfectly from source (pkgutil finds it) and
# silently 404s in the packaged app (pkgutil sees nothing in a frozen archive, so only this list gets
# it imported). That is exactly what happened on 2026-09-21 — `refactor` shipped without its route and
# the button answered 404 — and the class of bug is invisible to every offline test, because they all
# run from source.
_ROUTER_DIR = ROOT / "backend" / "routers"
ROUTERS = sorted(
    f"backend.routers.{path.stem}"
    for path in _ROUTER_DIR.glob("*.py")
    if path.stem != "__init__"
)
# A glob that silently returns nothing would build a backend that answers 404 for everything, which is
# far worse than a build error. These four have existed since Stage 0; if they are missing, the layout
# moved and the spec has to be looked at rather than quietly shipped.
_REQUIRED = {
    "backend.routers.analyze",
    "backend.routers.conversations",
    "backend.routers.fusion",
    "backend.routers.send",
}
_missing = _REQUIRED - set(ROUTERS)
if _missing:
    raise SystemExit(f"backend.spec: no routers found at {_ROUTER_DIR} (missing {sorted(_missing)})")

HIDDEN = [
    *ROUTERS,
    # uvicorn picks these by name at runtime; none of them is a static import.
    *collect_submodules("uvicorn"),
    "uvicorn.logging",
    "uvicorn.loops.auto",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.lifespan.on",
]

a = Analysis(
    [str(Path(SPECPATH) / "backend_entry.py")],
    pathex=[str(ROOT)],
    binaries=[],
    # The catalog fallback the app uses when OpenRouter is unreachable, and the mock fixtures the
    # offline scenarios replay: both are read from disk at runtime, so they travel with the build.
    datas=[
        (str(ROOT / "backend" / "llm" / "fixtures" / "models.json"), "backend/llm/fixtures"),
    ],
    hiddenimports=HIDDEN,
    hookspath=[],
    runtime_hooks=[],
    # Never ship the test tooling or the dev-only extras in a user-facing build.
    excludes=["pytest", "hypothesis", "syrupy", "respx", "ruff", "tkinter", "PyInstaller"],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="triplex-backend",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,  # stdout is piped into the app's backend.log
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="backend",
)
