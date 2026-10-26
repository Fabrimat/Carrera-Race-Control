"""Controller settings, pairing and the garage (docs/PROTOCOL.md "Roadmap wave 2")."""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from app.api.routes import _COLOR_RE, MAX_CAR_NAME, controller
from app.race.models import CarConfig, PairingState
from app.service import ControllerError

router = APIRouter()


class PairingRequest(BaseModel):
    target_address: Annotated[int, Field(ge=0, le=5)]
    car: CarConfig  # car.address is ignored: the profile is stored at target_address
    from_address: Annotated[int, Field(ge=0, le=5)] | None = None


def pairing_car_errors(car: CarConfig, known_logo_ids: set[str]) -> list[str]:
    """The same checks PUT /api/settings makes on a car."""
    errors: list[str] = []
    if not car.name.strip():
        errors.append("The car name must not be blank")
    if len(car.name) > MAX_CAR_NAME:
        errors.append(f"Car name longer than {MAX_CAR_NAME} characters")
    if not _COLOR_RE.match(car.color):
        errors.append("Car color must look like #RRGGBB")
    if car.logo_id is not None and car.logo_id not in known_logo_ids:
        errors.append(f"Unknown logo {car.logo_id!r}")
    return errors


@router.get("/api/controllers")
async def get_controllers(request: Request) -> dict[str, Any]:
    return {"controllers": controller(request).controller_statuses()}


@router.post("/api/controllers/apply")
async def apply_controllers(request: Request) -> dict[str, Any]:
    return {"controllers": await controller(request).apply_controllers()}


@router.post("/api/pairing", response_model=PairingState)
async def start_pairing(request: Request, body: PairingRequest) -> PairingState:
    ctl = controller(request)
    errors = pairing_car_errors(body.car, {logo.id for logo in ctl.list_logos()})
    if errors:
        raise ControllerError(422, "; ".join(errors), "invalid_request")
    return await ctl.start_pairing(body.target_address, body.car, body.from_address)


@router.post("/api/pairing/confirm", response_model=PairingState)
async def confirm_pairing(request: Request) -> PairingState:
    return await controller(request).confirm_pairing()


@router.delete("/api/pairing", response_model=PairingState)
async def cancel_pairing(request: Request) -> PairingState:
    return await controller(request).cancel_pairing()


@router.get("/api/garage")
async def get_garage(request: Request) -> dict[str, Any]:
    return {"cars": controller(request).garage()}
