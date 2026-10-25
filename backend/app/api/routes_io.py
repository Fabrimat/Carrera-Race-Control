"""Configuration export / import (docs/PROTOCOL.md "Event mode")."""

from __future__ import annotations

from datetime import date
from importlib import metadata
from typing import Any, Literal

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ValidationError

from app.api.routes import controller, layout_errors, settings_errors
from app.race.bundle import SECTIONS, apply_bundle, build_bundle, bundle_errors, check_version
from app.race.models import ExportBundle
from app.service import ControllerError

router = APIRouter()


class ExportRequest(BaseModel):
    sections: list[str]


class ImportRequest(BaseModel):
    bundle: dict[str, Any]
    mode: Literal["merge", "replace"] = "merge"
    dry_run: bool = False


def _app_version() -> str:
    try:
        return metadata.version("carrera-rms")
    except metadata.PackageNotFoundError:  # pragma: no cover - running from a bare checkout
        return ""


@router.post("/api/export")
async def export_bundle(request: Request, body: ExportRequest) -> JSONResponse:
    unknown = sorted(set(body.sections) - set(SECTIONS))
    if unknown or not body.sections:
        raise ControllerError(
            422,
            f"Unknown or missing sections {unknown or body.sections}; valid: {list(SECTIONS)}",
            "invalid_request",
        )
    bundle = build_bundle(controller(request).store, body.sections, _app_version())
    filename = f"carrera-rms-{date.today().isoformat()}.json"
    content = {k: v for k, v in bundle.model_dump(mode="json").items() if v is not None}
    return JSONResponse(
        content,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post("/api/import")
async def import_bundle(request: Request, body: ImportRequest) -> dict[str, Any]:
    # The version is checked on the raw JSON first, so a newer bundle with fields this app
    # does not know still gets the precise answer.
    try:
        check_version(body.bundle)
    except ValueError as exc:
        raise ControllerError(422, str(exc), "import_unsupported") from exc
    try:
        bundle = ExportBundle.model_validate(body.bundle)
    except ValidationError as exc:
        problems = "; ".join(
            f"{'.'.join(str(p) for p in e['loc'])}: {e['msg']}" for e in exc.errors()[:20]
        )
        raise ControllerError(422, problems, "import_invalid") from exc
    errors = bundle_errors(bundle, settings_errors, layout_errors)
    if errors:
        raise ControllerError(422, "; ".join(errors[:20]), "import_invalid")

    ctl = controller(request)
    report, removed_drivers = apply_bundle(
        ctl.store, ctl.avatars, bundle, body.mode, dry_run=body.dry_run
    )
    if not body.dry_run:
        ctl.refresh_after_import(bundle.settings, removed_drivers)
    return {"report": report, "applied": not body.dry_run}
