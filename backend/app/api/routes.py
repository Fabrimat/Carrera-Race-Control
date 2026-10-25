"""REST endpoints and the WebSocket route (see docs/PROTOCOL.md)."""

from __future__ import annotations

import re
from dataclasses import asdict
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Body, Query, Request, WebSocket
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel

from app.api.security import origin_allowed
from app.config import TrackMode
from app.race.export import race_to_csv, race_to_json
from app.race.models import RaceConfig, RaceState, Settings
from app.service import ConnectionInfo, ControllerError, RaceController, Snapshot

router = APIRouter()


class ConnectRequest(BaseModel):
    mode: TrackMode
    address: str | None = None


class MuteRequest(BaseModel):
    muted: bool


class Keys(BaseModel):
    elevenlabs: bool
    anthropic: bool


class SettingsResponse(Settings):
    keys: Keys


def controller(request: Request) -> RaceController:
    return request.app.state.controller  # type: ignore[no-any-return]


def _settings_response(ctl: RaceController) -> SettingsResponse:
    return SettingsResponse(
        **ctl.settings.model_dump(),
        keys=Keys(
            elevenlabs=ctl.config.has_elevenlabs_key(),
            anthropic=ctl.config.has_anthropic_key(),
        ),
    )


# --------------------------------------------------------------------------- state / track


@router.get("/api/state", response_model=Snapshot)
async def get_state(request: Request) -> Snapshot:
    return controller(request).snapshot()


@router.get("/api/track/scan")
async def scan(request: Request) -> dict[str, Any]:
    from app.track.scan import scan_devices

    devices = await scan_devices()
    return {"devices": [asdict(d) for d in devices]}


@router.post("/api/connect", response_model=ConnectionInfo)
async def connect(request: Request, body: ConnectRequest) -> ConnectionInfo:
    return await controller(request).connect(body.mode, body.address)


@router.post("/api/disconnect", response_model=ConnectionInfo)
async def disconnect(request: Request) -> ConnectionInfo:
    return await controller(request).disconnect()


# --------------------------------------------------------------------------- race


@router.post("/api/race/start", response_model=RaceState)
async def race_start(
    request: Request, config: Annotated[RaceConfig | None, Body()] = None
) -> RaceState:
    return await controller(request).start_race(config)


@router.post("/api/race/stop", response_model=RaceState)
async def race_stop(request: Request) -> RaceState:
    return await controller(request).stop_race()


@router.post("/api/race/reset", response_model=RaceState)
async def race_reset(request: Request) -> RaceState:
    return await controller(request).reset_race()


@router.post("/api/race/pace-car", response_model=RaceState)
async def race_pace_car(request: Request) -> RaceState:
    return await controller(request).toggle_pace_car()


# --------------------------------------------------------------------------- settings


@router.get("/api/settings", response_model=SettingsResponse)
async def get_settings(request: Request) -> SettingsResponse:
    return _settings_response(controller(request))


MAX_CARS = 8
MAX_CAR_NAME = 40
_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")


def settings_errors(settings: Settings) -> list[str]:
    """API-level checks on top of the model (models.py is the wire contract, kept as is)."""
    errors: list[str] = []
    if len(settings.cars) > MAX_CARS:
        errors.append(f"At most {MAX_CARS} cars are allowed")
    addresses = [c.address for c in settings.cars]
    duplicates = sorted({a for a in addresses if addresses.count(a) > 1})
    if duplicates:
        errors.append(f"Duplicate car addresses: {duplicates}")
    for car in settings.cars:
        if len(car.name) > MAX_CAR_NAME:
            errors.append(f"Car {car.address}: name longer than {MAX_CAR_NAME} characters")
        if not _COLOR_RE.match(car.color):
            errors.append(f"Car {car.address}: color must look like #RRGGBB")
    return errors


@router.put("/api/settings", response_model=SettingsResponse)
async def put_settings(request: Request, settings: Settings) -> SettingsResponse:
    errors = settings_errors(settings)
    if errors:
        raise ControllerError(422, "; ".join(errors), "settings_invalid")
    ctl = controller(request)
    ctl.update_settings(settings)
    return _settings_response(ctl)


# --------------------------------------------------------------------------- history


@router.get("/api/races")
async def list_races(request: Request) -> dict[str, Any]:
    return {"races": controller(request).store.list_races()}


def _race_or_404(ctl: RaceController, race_id: int) -> dict[str, Any]:
    detail = ctl.store.get_race(race_id)
    if detail is None:
        raise ControllerError(404, f"Race {race_id} not found", "race_not_found")
    return detail


@router.get("/api/races/{race_id}")
async def get_race(request: Request, race_id: int) -> dict[str, Any]:
    return _race_or_404(controller(request), race_id)


@router.get("/api/races/{race_id}/export")
async def export_race(
    request: Request, race_id: int, format: Annotated[Literal["csv", "json"], Query()] = "json"
) -> Response:
    ctl = controller(request)
    detail = _race_or_404(ctl, race_id)
    if format == "csv":
        content = race_to_csv(detail, ctl.settings.cars)
        media = "text/csv; charset=utf-8"
    else:
        content = race_to_json(detail)
        media = "application/json"
    filename = f"race-{race_id}.{format}"
    return Response(
        content=content,
        media_type=media,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# --------------------------------------------------------------------------- track records


@router.get("/api/records")
async def list_records(request: Request) -> dict[str, Any]:
    return {"records": controller(request).store.list_records()}


@router.delete("/api/records/{layout}")
async def delete_record(request: Request, layout: str) -> dict[str, Any]:
    ctl = controller(request)
    if not ctl.delete_record(layout):
        raise ControllerError(404, f"No record for layout {layout!r}", "record_not_found")
    return {"records": ctl.store.list_records()}


# --------------------------------------------------------------------------- commentary


@router.get("/api/commentary/{line_id}/audio")
async def commentary_audio(request: Request, line_id: str) -> StreamingResponse:
    stream = controller(request).director.audio_stream(line_id)
    if stream is None:
        raise ControllerError(404, "No audio for this line", "audio_not_found")
    return StreamingResponse(stream, media_type="audio/mpeg")


@router.post("/api/commentary/mute")
async def mute(request: Request, body: MuteRequest) -> dict[str, bool]:
    return {"muted": controller(request).set_muted(body.muted)}


# --------------------------------------------------------------------------- websocket


@router.websocket("/ws")
async def websocket(ws: WebSocket) -> None:
    if not origin_allowed(ws.headers, ws.app.state.allowed_origins):
        # Cross-site WebSocket hijacking guard: refuse the handshake (HTTP 403).
        await ws.close(code=1008)
        return
    ctl: RaceController = ws.app.state.controller
    await ctl.hub.serve(ws, ctl.snapshot_message)
