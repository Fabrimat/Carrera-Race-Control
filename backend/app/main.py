"""FastAPI application: lifespan wiring, routers, CORS and the built frontend.

Production is one process: ``uv run uvicorn app.main:app`` serves the API, the WebSocket
and (when ``frontend/dist`` exists) the dashboard at ``/``.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.trustedhost import TrustedHostMiddleware

from app.api.routes import router
from app.api.routes_controllers import router as controllers_router
from app.api.routes_drivers import router as drivers_router
from app.api.routes_event import router as event_router
from app.api.routes_io import router as io_router
from app.api.routes_logos import router as logos_router
from app.api.security import BodyLimitMiddleware, CSRFMiddleware, normalise_origins
from app.config import REPO_ROOT, AppConfig
from app.race.store import RaceStore
from app.service import ControllerError, RaceController

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
    allowed_origins = normalise_origins(cfg.cors_origin_list)
    app.state.allowed_origins = allowed_origins
    # Added innermost first: TrustedHost runs first, then CSRF, then CORS.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=cfg.cors_origin_list,
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.add_middleware(CSRFMiddleware, allowed_origins=allowed_origins)
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=cfg.allowed_host_list)
    app.add_middleware(BodyLimitMiddleware)  # outermost: oversized bodies never get further

    @app.exception_handler(ControllerError)
    async def controller_error(request: Request, exc: ControllerError) -> JSONResponse:
        return JSONResponse({"detail": exc.detail, "code": exc.code}, status_code=exc.status)

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
        return JSONResponse(
            {
                # Never echo the offending input back (it can be a ~10 MB photo).
                "detail": jsonable_encoder(
                    [{k: v for k, v in e.items() if k != "input"} for e in exc.errors()]
                ),
                "code": "invalid_request",
            },
            status_code=422,
        )

    app.include_router(router)
    app.include_router(drivers_router)
    app.include_router(event_router)
    app.include_router(io_router)
    app.include_router(logos_router)
    app.include_router(controllers_router)
    if frontend_dist is not None and (frontend_dist / "index.html").is_file():
        # Registered last: API and WebSocket routes take precedence over the static mount.
        app.mount("/", StaticFiles(directory=frontend_dist, html=True), name="frontend")
    return app


app = create_app()
