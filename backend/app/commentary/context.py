"""Compact, verbalised race context for the LLM writer.

Everything the model may talk about is gathered here: the live standings, the involved
car, the records and the latest events. All times are spelled out in the target language
with `speech.py` (so the TTS reads them naturally); raw millisecond values never reach
the prompt.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from app.commentary import speech
from app.race.models import (
    BestLap,
    CarConfig,
    CarState,
    Driver,
    DriverAssigned,
    EventProgram,
    FalseStart,
    LapCompleted,
    PositionChange,
    RaceEvent,
    RaceFinished,
    RaceMode,
    RaceStarted,
    RaceState,
    SectorCompleted,
    SessionFinished,
    SessionSpec,
    TrackRecord,
)

TOP_N = 3
RECENT_EVENTS = 5
RECENT_LINES = 4
_FUEL_EVENTS = frozenset({"low_fuel", "pit_entry", "pit_exit", "fuel_strategy", "pit_missed"})


def _name(address: int, cars: dict[int, CarConfig]) -> str:
    car = cars.get(address)
    if car is None:
        return str(address + 1)
    return car.nickname or car.name


_FUEL_WORDS = {
    "it": ("quasi a secco", "riserva", "metà", "pieno"),
    "en": ("almost empty", "low", "half", "full"),
}
_FUEL_FULL_FROM = 12


def fuel_state(fuel: int | None, low_threshold: int, lang: str) -> str | None:
    """Qualitative fuel (the raw 0..15 level is never given to the model)."""
    if fuel is None:
        return None
    words = _FUEL_WORDS.get(lang, _FUEL_WORDS["it"])
    if fuel <= low_threshold // 2:
        return words[0]
    if fuel <= low_threshold:
        return words[1]
    return words[3] if fuel >= _FUEL_FULL_FROM else words[2]


def verbalise_facts(facts: dict[str, Any], lang: str) -> dict[str, Any]:
    """Replace `*_ms` values by spoken times (`lap_ms` -> `lap_time`)."""
    out: dict[str, Any] = {}
    for key, value in facts.items():
        if key.endswith("_ms") and isinstance(value, int) and not isinstance(value, bool):
            out[key[:-3] + "_time"] = speech.say_lap_time(value, lang)
        elif key == "fuel":
            continue  # never pass the raw number: the context carries a qualitative fuel_state
        else:
            out[key] = value
    return out


def summarise_event(event: RaceEvent, cars: dict[int, CarConfig], lang: str) -> dict[str, Any]:
    """One short line of history for the "recent events" list."""
    summary: dict[str, Any] = {"event": event.type}
    address = getattr(event, "address", None)
    if address is not None:
        summary["driver"] = _name(address, cars)
    if isinstance(event, DriverAssigned):
        summary["driver"] = event.driver_name
    elif isinstance(event, LapCompleted):
        summary["lap"] = event.lap_number
        summary["lap_time"] = speech.say_lap_time(event.lap_ms, lang)
    elif isinstance(event, BestLap):
        summary["lap_time"] = speech.say_lap_time(event.lap_ms, lang)
        summary["overall"] = event.overall
    elif isinstance(event, TrackRecord):
        summary["lap_time"] = speech.say_lap_time(event.lap_ms, lang)
    elif isinstance(event, SectorCompleted):
        summary["sector"] = event.sector
        summary["split_time"] = speech.say_lap_time(event.split_ms, lang)
        summary["overall_best"] = event.overall_best
    elif isinstance(event, PositionChange):
        summary["new_position"] = event.new_position
        if event.passed_address is not None:
            summary["passed"] = _name(event.passed_address, cars)
    elif isinstance(event, RaceFinished) and event.winner is not None:
        summary["winner"] = _name(event.winner, cars)
    elif isinstance(event, RaceStarted):
        summary["mode"] = event.mode.value
    elif isinstance(event, FalseStart):
        summary["action"] = event.action
    elif isinstance(event, SessionFinished):
        summary["session_kind"] = event.kind.value
        if event.order:
            summary["winner"] = _name(event.order[0], cars)
    return summary


# --------------------------------------------------------------------------- event mode


@dataclass
class EventCommentary:
    """What the active event adds to the commentary (see docs/PROTOCOL.md "Event mode").

    ``facts`` goes to the LLM as the ``event`` block; ``sponsors`` are added to it by the
    director only when its sponsor rate limit allows; ``tone`` selects the prompt style;
    ``avoid_words`` are enforced on the LLM text after the fact.
    """

    facts: dict[str, Any] = field(default_factory=dict)
    tone: str | None = None
    sponsors: list[str] = field(default_factory=list)
    avoid_words: list[str] = field(default_factory=list)


def mentions_any(text: str, words: list[str]) -> bool:
    """True when ``text`` contains one of ``words`` as a whole word/phrase (case-insensitive)."""
    folded = text.casefold()
    for word in words:
        needle = word.strip().casefold()
        if needle and re.search(rf"(?<!\w){re.escape(needle)}(?!\w)", folded):
            return True
    return False


def build_event_commentary(
    program: EventProgram,
    spec: SessionSpec,
    index: int,
    drivers: dict[int, Driver],
    grid: dict[int, tuple[int, str]],
    cars: dict[int, CarConfig],
) -> EventCommentary:
    """The ``event`` facts block for the LLM.

    ``drivers``: address -> assigned driver; ``grid``: address -> (position, name) from the
    session named by ``spec.grid_from`` (display only: "starts from P2").
    """
    ctx = program.commentary
    facts: dict[str, Any] = {}
    for key in ("event_name", "location", "notes"):
        value = getattr(ctx, key).strip()
        if value:
            facts[key] = value
    session: dict[str, Any] = {
        "kind": spec.kind.value,
        "number": index + 1,
        "of": len(program.sessions),
    }
    if spec.name:
        session["name"] = spec.name
    facts["session"] = session
    people: list[dict[str, Any]] = []
    for address in sorted(set(drivers) | set(grid)):
        driver = drivers.get(address)
        entry: dict[str, Any] = {}
        if driver is not None:
            entry["driver"] = driver.nickname or driver.name
            if driver.nickname:
                entry["full_name"] = driver.name
            if driver.bio.strip():
                entry["bio"] = driver.bio.strip()
            if address in cars:
                entry["car"] = cars[address].nickname or cars[address].name
        elif address in grid:
            entry["driver"] = grid[address][1]
        if address in grid:
            entry["starts_from"] = f"P{grid[address][0]}"
        people.append(entry)
    if people:
        facts["drivers"] = people
    return EventCommentary(
        facts=facts,
        tone=ctx.tone,
        sponsors=[s.strip() for s in ctx.sponsors if s.strip()],
        avoid_words=[w.strip() for w in ctx.avoid_words if w.strip()],
    )


def _spoken_sectors(values: list[int | None], lang: str) -> dict[str, str]:
    """{"1": "spoken time", ...} for the sectors that have a value (missing ones are omitted)."""
    return {str(i + 1): speech.say_lap_time(v, lang) for i, v in enumerate(values) if v is not None}


def _car_summary(car: CarState, cars: dict[int, CarConfig], lang: str) -> dict[str, Any]:
    info: dict[str, Any] = {"driver": _name(car.address, cars), "laps": car.laps}
    if car.position is not None:
        info["position"] = car.position
    if car.last_lap_ms is not None:
        info["last_lap"] = speech.say_lap_time(car.last_lap_ms, lang)
    if car.best_lap_ms is not None:
        info["best_lap"] = speech.say_lap_time(car.best_lap_ms, lang)
    return info


def build_context(
    state: RaceState,
    cars: dict[int, CarConfig],
    lang: str,
    address: int | None,
    event_key: str,
    recent_events: list[dict[str, Any]],
) -> dict[str, Any]:
    """The live situation around one commentary candidate."""
    cfg = state.config
    ctx: dict[str, Any] = {"mode": cfg.mode.value, "phase": state.phase.value}
    placed = [c for c in state.cars if c.position is not None]
    leader = min(placed, key=lambda c: c.position or 99, default=None)
    if cfg.mode == RaceMode.LAPS:
        if leader is not None:
            ctx["leader_lap"] = min(leader.laps + 1, cfg.target_laps)
        ctx["total_laps"] = cfg.target_laps
        if state.remaining_laps is not None:
            ctx["laps_to_go"] = state.remaining_laps
    elif cfg.mode == RaceMode.TIMED and state.remaining_ms is not None:
        ctx["time_remaining"] = speech.say_lap_time(max(0, state.remaining_ms), lang)

    standings: list[dict[str, Any]] = []
    for car in sorted(placed, key=lambda c: c.position or 99)[:TOP_N]:
        row = _car_summary(car, cars, lang)
        if car.gap_to_leader_laps > 0:
            row["laps_behind"] = car.gap_to_leader_laps
        elif car.gap_to_leader_ms and car.position != 1:
            row["gap_to_leader"] = speech.say_gap(car.gap_to_leader_ms, lang)
        standings.append(row)
    if standings:
        ctx["standings"] = standings

    involved = next((c for c in state.cars if c.address == address), None)
    if involved is not None:
        car_info = _car_summary(involved, cars, lang)
        if involved.gap_to_ahead_ms and involved.position not in (None, 1):
            car_info["gap_to_car_ahead"] = speech.say_gap(involved.gap_to_ahead_ms, lang)
        if event_key in _FUEL_EVENTS:
            fuel = fuel_state(involved.fuel, cfg.low_fuel_threshold, lang)
            if fuel is None and event_key == "low_fuel":
                fuel = fuel_state(0, cfg.low_fuel_threshold, lang)
            if fuel is not None:
                car_info["fuel_state"] = fuel
            car_info["pit_stops"] = involved.pit_stops
            car_info["in_pit"] = involved.in_pit
            strategy = involved.fuel_strategy
            if strategy is not None:
                if strategy.laps_left is not None:
                    car_info["laps_left"] = round(strategy.laps_left, 1)
                car_info["must_pit"] = strategy.must_pit
                if strategy.pit_by_lap is not None:
                    car_info["pit_by_lap"] = strategy.pit_by_lap
            if cfg.pits.min_stops > 0:
                car_info["required_stops"] = cfg.pits.min_stops
        if state.num_sectors > 1:
            current = _spoken_sectors(involved.current_sectors, lang)
            last = _spoken_sectors(involved.last_sectors, lang)
            if current:
                car_info["current_lap_sectors"] = current
            if last:
                car_info["last_lap_sectors"] = last
        ctx["involved_car"] = car_info

    if state.best_lap is not None:
        ctx["best_lap_overall"] = {
            "driver": _name(state.best_lap.address, cars),
            "time": speech.say_lap_time(state.best_lap.lap_ms, lang),
        }
    if state.num_sectors > 1:
        best_sectors = _spoken_sectors(state.best_sectors, lang)
        if best_sectors:
            ctx["best_sectors_overall"] = best_sectors
            ctx["num_sectors"] = state.num_sectors
    if state.track_record is not None:
        ctx["track_record"] = {
            "holder": state.track_record.holder_name,
            "time": speech.say_lap_time(state.track_record.lap_ms, lang),
        }
    if recent_events:
        ctx["recent_events"] = recent_events[-RECENT_EVENTS:]
    return ctx
