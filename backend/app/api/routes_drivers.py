"""Drivers roster, photos, assignments, assign-on-next-crossing and voice transcription.

See docs/PROTOCOL.md "Event mode".
"""

from __future__ import annotations

import base64
import binascii
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field

from app.api.routes import controller
from app.avatars import ID_RE, MAX_PHOTO_BYTES, detect_image
from app.commentary.stt import MAX_AUDIO_BYTES, audio_extension
from app.race.models import Driver
from app.service import ControllerError

router = APIRouter()


class DriverCreate(BaseModel):
    name: Annotated[str, Field(min_length=1, max_length=40)]
    nickname: Annotated[str | None, Field(max_length=24)] = None
    bio: Annotated[str, Field(max_length=300)] = ""


class DriverPhotoRequest(BaseModel):
    image_base64: str
    media_type: Literal["image/jpeg", "image/png", "image/webp"]


class AssignmentsRequest(BaseModel):
    assignments: dict[int, str | None]


class ArmRequest(BaseModel):
    driver_id: str


class TranscribeRequest(BaseModel):
    audio_base64: str
    media_type: str
    language: Literal["en", "it"] = "en"


def _decoded_size_cap(limit: int) -> int:
    """Longest base64 text that can still decode to at most ``limit`` bytes."""
    return (limit + 2) // 3 * 4


def _decode(
    text: str,
    limit: int,
    label: str,
    too_large: Literal["image_too_large", "invalid_request"],
    invalid: Literal["invalid_image", "invalid_request"],
) -> bytes:
    """Strict base64 decode with the size cap checked before decoding."""
    if len(text) > _decoded_size_cap(limit):
        raise ControllerError(
            413, f"The {label} is larger than {limit // (1024 * 1024)} MB", too_large
        )
    try:
        data = base64.b64decode(text, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ControllerError(422, f"The {label} is not valid base64", invalid) from exc
    if len(data) > limit:
        raise ControllerError(
            413, f"The {label} is larger than {limit // (1024 * 1024)} MB", too_large
        )
    return data


# --------------------------------------------------------------------------- drivers


@router.get("/api/drivers")
async def list_drivers(request: Request) -> dict[str, Any]:
    return {"drivers": controller(request).list_drivers()}


@router.post("/api/drivers", response_model=Driver)
async def create_driver(request: Request, body: DriverCreate) -> Driver:
    name = body.name.strip()
    if not name:
        raise ControllerError(422, "The name must not be blank", "invalid_request")
    nickname = (body.nickname or "").strip() or None
    return controller(request).create_driver(name, nickname, body.bio.strip())


@router.put("/api/drivers/{driver_id}", response_model=Driver)
async def update_driver(request: Request, driver_id: str, body: Driver) -> Driver:
    # The id in the body is ignored: the path decides.
    if not body.name.strip():
        raise ControllerError(422, "The name must not be blank", "invalid_request")
    clean = body.model_copy(
        update={
            "name": body.name.strip(),
            "nickname": (body.nickname or "").strip() or None,
            "bio": body.bio.strip(),
        }
    )
    return controller(request).update_driver(driver_id, clean)


@router.delete("/api/drivers/{driver_id}")
async def delete_driver(request: Request, driver_id: str) -> dict[str, Any]:
    return {"drivers": controller(request).delete_driver(driver_id)}


# --------------------------------------------------------------------------- photos


@router.put("/api/drivers/{driver_id}/photo", response_model=Driver)
async def put_photo(request: Request, driver_id: str, body: DriverPhotoRequest) -> Driver:
    ctl = controller(request)
    ctl.get_driver(driver_id)  # 404 first
    data = _decode(body.image_base64, MAX_PHOTO_BYTES, "photo", "image_too_large", "invalid_image")
    ext = detect_image(data)
    if ext is None:
        raise ControllerError(422, "The photo must be a JPEG, PNG or WebP image", "invalid_image")
    return ctl.set_driver_photo(driver_id, data, ext)


@router.get("/api/drivers/{driver_id}/photo")
async def get_photo(request: Request, driver_id: str) -> Response:
    photo = controller(request).avatars.get(driver_id) if ID_RE.match(driver_id) else None
    if photo is None:
        raise ControllerError(404, "This driver has no photo", "not_found")
    headers = {"ETag": photo.etag, "Cache-Control": "no-cache"}
    if request.headers.get("if-none-match") == photo.etag:
        return Response(status_code=304, headers=headers)
    return FileResponse(photo.path, media_type=photo.media_type, headers=headers)


@router.delete("/api/drivers/{driver_id}/photo", response_model=Driver)
async def delete_photo(request: Request, driver_id: str) -> Driver:
    return controller(request).delete_driver_photo(driver_id)


# --------------------------------------------------------------------------- assignments


@router.get("/api/event/assignments")
async def get_assignments(request: Request) -> dict[str, Any]:
    return {"assignments": controller(request).assignments()}


@router.put("/api/event/assignments")
async def put_assignments(request: Request, body: AssignmentsRequest) -> dict[str, Any]:
    return {"assignments": await controller(request).set_assignments(body.assignments)}


@router.post("/api/event/assign-next-crossing")
async def arm_next_crossing(request: Request, body: ArmRequest) -> dict[str, bool]:
    controller(request).arm(body.driver_id)
    return {"armed": True}


@router.delete("/api/event/assign-next-crossing")
async def cancel_next_crossing(request: Request) -> dict[str, bool]:
    controller(request).disarm()
    return {"armed": False}


# --------------------------------------------------------------------------- voice


@router.post("/api/event/transcribe")
async def transcribe(request: Request, body: TranscribeRequest) -> dict[str, Any]:
    if audio_extension(body.media_type) is None:
        raise ControllerError(422, "The audio must be webm, ogg, mp4 or wav", "invalid_request")
    audio = _decode(
        body.audio_base64, MAX_AUDIO_BYTES, "audio", "invalid_request", "invalid_request"
    )
    if not audio:
        raise ControllerError(422, "The audio is empty", "invalid_request")
    return await controller(request).transcribe(audio, body.media_type, body.language)
