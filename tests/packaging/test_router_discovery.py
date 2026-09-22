"""The packaged backend must serve every route the source one does.

This guards a bug class that NO other test in this repo can see, because every other test runs from
source. `backend/main.py` finds its routers with `pkgutil.iter_modules`, which works from a checkout
and returns NOTHING inside a PyInstaller archive, so the frozen build only gets the routers that
`packaging/backend.spec` names as hidden imports. Add a router, forget the spec, and the app works
perfectly in development and answers 404 in the installed build.

Measured 2026-09-21: that is exactly what happened to `POST /api/conversations/{id}/refactor` — the
button was right, the request was right, and the packaged backend had no such route.
"""

from __future__ import annotations

import re
from pathlib import Path

from backend.main import create_app

ROOT = Path(__file__).resolve().parents[2]
ROUTER_DIR = ROOT / "backend" / "routers"
SPEC = ROOT / "packaging" / "backend.spec"


def router_modules() -> set[str]:
    return {p.stem for p in ROUTER_DIR.glob("*.py") if p.stem != "__init__"}


def mounted_paths() -> set[str]:
    """The paths the app actually serves. Read from the OpenAPI schema, NOT `app.routes`: this FastAPI
    version wraps each `include_router` as an `_IncludedRouter` with no `.path`, so walking
    `app.routes` reports only the four bare app routes and looks exactly like nothing was mounted."""
    return set(create_app().openapi()["paths"])


def test_every_router_module_is_mounted_from_source():
    """The `pkgutil` auto-discovery contract: a module in `backend/routers/` exporting `router` is
    mounted with no edit to `main.py`. A module that fails to export one is silently absent, which
    looks exactly like the packaging bug from the outside."""
    modules = router_modules()
    assert modules, f"no router modules under {ROUTER_DIR}"
    paths = mounted_paths()
    assert paths, "create_app() mounted nothing at all"
    # Each feature router owns at least one path containing its own name; desktop_app serves static
    # files under /app/ and models/session sit outside the conversations tree, so they are named.
    expected = {
        "analyze": "/api/conversations/{conv_id}/analyze",
        "refactor": "/api/conversations/{conv_id}/refactor",
        "fusion": "/api/conversations/{conv_id}/fusion",
        "conversations": "/api/conversations",
        "models": "/api/models",
        "session": "/api/session/cost",
        "bridge": "/api/bridge/status",
        "export": "/api/conversations/{conv_id}/export/{turn_id}",
    }
    for module, path in expected.items():
        assert module in modules, f"backend/routers/{module}.py is gone"
        assert path in paths, f"{module} is not mounted ({path} missing)"


def test_the_spec_derives_its_router_list_rather_than_hard_coding_it():
    """A hand-written list in the spec is the trap this file exists for: it drifts the moment a router
    is added, and nothing fails until someone runs the installed app. The spec must read the directory.
    """
    text = SPEC.read_text()
    assert "ROUTER_DIR" in text and '.glob("*.py")' in text, (
        "packaging/backend.spec must derive ROUTERS from backend/routers/*.py, not list them by hand"
    )
    # …and it must refuse to build rather than ship a backend with no routers at all.
    assert "SystemExit" in text, "the spec must fail the build when the glob finds nothing"
    # No literal list of router module paths left behind.
    literals = re.findall(r'"backend\.routers\.(\w+)"', text)
    hard_coded = set(literals) - {"analyze", "conversations", "fusion", "send"}  # the required-set guard
    assert not hard_coded, f"spec still hard-codes routers: {sorted(hard_coded)}"


def test_refactor_is_among_them():
    """The specific route that shipped missing, pinned so it cannot regress quietly."""
    assert "refactor" in router_modules()
    assert "/api/conversations/{conv_id}/refactor" in mounted_paths()
