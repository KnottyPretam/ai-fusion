"""Triplex FastAPI app factory.

Routers are auto-discovered from backend/routers: any module there exporting a module-level
`router` is included. Adding a feature adds ZERO lines to this file. Run from the repo root as
`python -m backend.main` (relative imports).
"""

from __future__ import annotations

import importlib
import logging
import os
import pkgutil

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import routers as routers_pkg
from .config import settings
from .schemas import SCHEMA_VERSION

log = logging.getLogger("triplex")


def create_app() -> FastAPI:
    s = settings()
    logging.basicConfig(
        level=getattr(logging, s.log_level, logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    app = FastAPI(title=f"{s.app_title} API")
    if os.environ.get("TRIPLEX_DESKTOP", "0") == "1":
        # Desktop mode: this loopback HTTP API drives the user's logged-in browser sessions, so a
        # DNS-rebinding page must never reach it — only loopback Host headers are served
        # ("testserver" is starlette's TestClient). The bridge router adds the WebSocket Origin check.
        from starlette.middleware.trustedhost import TrustedHostMiddleware

        app.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost", "testserver"])
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            "http://localhost:5173",
            "http://localhost:5174",
            "http://localhost:3000",
            "http://127.0.0.1:5173",
            "http://127.0.0.1:5174",
        ],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/")
    async def root() -> dict:
        return {
            "status": "ok",
            "service": f"{s.app_title} API",
            "schema_version": SCHEMA_VERSION,
            "mock": s.mock_openrouter,
        }

    for m in pkgutil.iter_modules(routers_pkg.__path__):
        mod = importlib.import_module(f"{routers_pkg.__name__}.{m.name}")
        router = getattr(mod, "router", None)
        if router is not None:
            app.include_router(router)
            log.info("router mounted: %s", m.name)
    return app


app = create_app()

if __name__ == "__main__":
    import uvicorn

    s = settings()
    uvicorn.run(app, host=s.host, port=s.port, log_level=s.log_level.lower())
