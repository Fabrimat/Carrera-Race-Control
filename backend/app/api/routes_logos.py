"""Brand logo library. See docs/PROTOCOL.md "Roadmap wave 1" -> "Logos"."""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field

from app.api.routes import controller
from app.api.routes_drivers import _decode
from app.avatars import ID_RE
from app.logos import MAX_LOGO_BYTES, MEDIA_TYPES, validate_logo
from app.race.models import Logo
from app.service import ControllerError

router = APIRouter()

SVG_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox"


class LogoCreate(BaseModel):
    name: Annotated[str, Field(min_length=1, max_length=40)]
    image_base64: str


class LogoUpdate(BaseModel):
    name: Annotated[str, Field(min_length=1, max_length=40)]
    image_base64: str | None = None


def _clean_name(name: str) -> str:
    name = name.strip()
    if not name:
        raise ControllerError(422, "The name must not be blank", "invalid_request")
    return name


def _read_image(text: str) -> tuple[bytes, str]:
    data = _decode(text, MAX_LOGO_BYTES, "logo", "image_too_large", "invalid_image")
    ext = validate_logo(data)
    if ext is None:
        raise ControllerError(
            422, "The logo must be a PNG, JPEG, WebP or a plain SVG image", "invalid_image"
        )
    return data, ext


@router.get("/api/logos")
async def list_logos(request: Request) -> dict[str, Any]:
    return {"logos": controller(request).list_logos()}


@router.post("/api/logos", response_model=Logo, status_code=201)
async def create_logo(request: Request, body: LogoCreate) -> Logo:
    name = _clean_name(body.name)
    data, ext = _read_image(body.image_base64)
    return controller(request).create_logo(name, data, ext)


@router.put("/api/logos/{logo_id}", response_model=Logo)
async def update_logo(request: Request, logo_id: str, body: LogoUpdate) -> Logo:
    ctl = controller(request)
    ctl.get_logo(logo_id)  # 404 first
    name = _clean_name(body.name)
    image = _read_image(body.image_base64) if body.image_base64 is not None else None
    return ctl.update_logo(logo_id, name, image)


@router.get("/api/logos/{logo_id}/image")
async def get_logo_image(request: Request, logo_id: str) -> Response:
    ctl = controller(request)
    stored = ctl.logo_files.get(logo_id) if ID_RE.match(logo_id) else None
    if stored is None or ctl.store.get_logo(logo_id) is None:
        raise ControllerError(404, "Logo not found", "logo_not_found")
    headers = {
        "ETag": stored.etag,
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff",
    }
    if stored.media_type == MEDIA_TYPES["svg"]:
        headers["Content-Security-Policy"] = SVG_CSP
    if request.headers.get("if-none-match") == stored.etag:
        return Response(status_code=304, headers=headers)
    return FileResponse(stored.path, media_type=stored.media_type, headers=headers)


@router.delete("/api/logos/{logo_id}")
async def delete_logo(request: Request, logo_id: str) -> dict[str, Any]:
    return {"logos": controller(request).delete_logo(logo_id)}
