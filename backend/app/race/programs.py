"""Rules for event programs, shared by the program endpoint and the configuration import."""

from __future__ import annotations

from app.race.models import EventProgram, RaceMode, SessionKind


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
