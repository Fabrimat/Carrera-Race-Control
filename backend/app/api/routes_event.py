"""Event programs and the session runner (docs/PROTOCOL.md "Event mode")."""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from app.api.routes import controller
from app.race.models import EventProgram, EventState, RaceMode, SessionKind
from app.service import ControllerError

router = APIRouter()


class StartEventRequest(BaseModel):
    program_id: Annotated[str, Field(min_length=1, max_length=40)]


def normalise_program(program: EventProgram) -> EventProgram:
    """Qualifying sessions always run as ``timed`` (ranked by best lap within the duration)."""
    sessions = [
        s.model_copy(update={"mode": RaceMode.TIMED}) if s.kind is SessionKind.QUALIFYING else s
        for s in program.sessions
    ]
    return program.model_copy(update={"sessions": sessions})


def program_errors(program: EventProgram) -> list[str]:
    """API-level checks on top of the model (models.py is the wire contract, kept as is)."""
    errors: list[str] = []
    if not program.sessions:
        errors.append("A program needs at least one session")
    seen: list[str] = []
    for session in program.sessions:
        if session.id in seen:
            errors.append(f"Duplicate session id {session.id!r}")
        if session.grid_from is not None and session.grid_from not in seen:
            errors.append(
                f"Session {session.id!r}: grid_from must name an earlier session of the program"
            )
        seen.append(session.id)
    return errors


@router.get("/api/programs")
async def list_programs(request: Request) -> dict[str, Any]:
    return {"programs": controller(request).list_programs()}


@router.put("/api/programs/{program_id}", response_model=EventProgram)
async def put_program(request: Request, program_id: str, program: EventProgram) -> EventProgram:
    # The URL names the program: a different id in the body is ignored.
    program = normalise_program(program.model_copy(update={"id": program_id}))
    errors = program_errors(program)
    if not 1 <= len(program_id) <= 40:
        errors.insert(0, "The program id must be 1..40 characters")
    if errors:
        raise ControllerError(422, "; ".join(errors), "invalid_request")
    return controller(request).save_program(program)


@router.delete("/api/programs/{program_id}")
async def delete_program(request: Request, program_id: str) -> dict[str, Any]:
    return {"programs": controller(request).delete_program(program_id)}


@router.get("/api/event", response_model=EventState)
async def get_event(request: Request) -> EventState:
    return controller(request).get_event()


@router.post("/api/event/start", response_model=EventState)
async def start_event(request: Request, body: StartEventRequest) -> EventState:
    return controller(request).start_event(body.program_id)


@router.post("/api/event/next", response_model=EventState)
async def next_session(request: Request) -> EventState:
    return controller(request).next_session()


@router.post("/api/event/stop", response_model=EventState)
async def stop_event(request: Request) -> EventState:
    return controller(request).stop_event()
