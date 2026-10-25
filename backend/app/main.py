"""FastAPI application: lifespan wiring, routers, CORS and the built frontend.

Production is one process: ``uv run uvicorn app.main:app`` serves the API, the WebSocket
and (when ``frontend/dist`` exists) the dashboard at ``/``.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.api.routes import router
from app.config import REPO_ROOT, AppConfig
from app.race.store import RaceStore
from app.service import RaceController

log = logging.getLogger(__name__)

FRONTEND_DIST = REPO_ROOT / "frontend" / "dist"

ControllerFactory = Callable[[AppConfig, RaceStore], RaceController]


def create_app(
    config: AppConfig | None = None,
    *,
    controller_factory: ControllerFactory | None = None,
    autoconnect: bool = True,
    frontend_dist: Path | None = FRONTEND_DIST,
) -> FastAPI:
    cfg = config or AppConfig()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        store = RaceStore(cfg.db_path)
        factory = controller_factory or (lambda c, s: RaceController(c, s))
        controller = factory(cfg, store)
        app.state.controller = controller
        await controller.start(autoconnect=autoconnect)
        log.info("Carrera race control ready")
        try:
            yield
        finally:
            await controller.shutdown()
            log.info("Carrera race control stopped")

    app = FastAPI(title="Carrera Race Control", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=cfg.cors_origin_list,
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(router)
    if frontend_dist is not None and (frontend_dist / "index.html").is_file():
        # Registered last: API and WebSocket routes take precedence over the static mount.
        app.mount("/", StaticFiles(directory=frontend_dist, html=True), name="frontend")
    return app


app = create_app()
