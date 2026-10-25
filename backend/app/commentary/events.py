"""Domain event -> commentary candidates.

A `Candidate` is a line the director may speak: text already rendered from the templates
of the configured language, a priority, a `cacheable` flag (static phrase, no numbers) and
a compact `facts` dict (what an LLM writer is allowed to talk about).

Languages are registered in `LANGUAGES`: adding one means a `templates_xx.py` module, a
`speech.py` implementation and one entry here.
"""

from __future__ import annotations

import random
from collections.abc import Callable
from dataclasses import dataclass, field
from string import Formatter
from types import ModuleType
from typing import Any

from app.commentary import speech, templates_en, templates_it
from app.race.models import (
    BestLap,
    CarConfig,
    CarState,
    CommentaryPriority,
    Idle,
    LapCompleted,
    LowFuel,
    PitEntry,
    PitExit,
    PositionChange,
    RaceEvent,
    RaceFinished,
    RaceMode,
    RaceStarted,
    RaceState,
    TrackRecord,
    Verbosity,
)

LANGUAGES: dict[str, ModuleType] = {"it": templates_it, "en": templates_en}
DEFAULT_LANGUAGE = "it"

# NORMAL verbosity: the leader's routine lap is commented every N laps.
LEADER_LAP_EVERY_N = 3
# LOW verbosity keeps only these NORMAL-priority template keys.
_LOW_VERBOSITY_NORMAL_KEYS = frozenset({"low_fuel", "final_lap", "pit_entry"})

_Spec = tuple[str, CommentaryPriority, dict[str, str], dict[str, Any], "int | None"]


@dataclass
class Candidate:
    text: str
    priority: CommentaryPriority
    event_type: str
    template_key: str
    cacheable: bool = False
    address: int | None = None
    facts: dict[str, Any] = field(default_factory=dict)
    language: str = DEFAULT_LANGUAGE


class _Safe(dict):
    def __missing__(self, key: str) -> str:
        return ""


def _placeholders(template: str) -> set[str]:
    return {name for _, name, _, _ in Formatter().parse(template) if name}


class TemplateBook:
    """Renders template variants, never repeating the same variant twice in a row per key."""

    def __init__(self, rng: random.Random | None = None) -> None:
        self._rng = rng or random.Random()
        self._last: dict[tuple[str, str], str] = {}

    def render(self, lang: str, key: str, fields: dict[str, str]) -> tuple[str, bool]:
        """Return (text, cacheable). Variants needing missing placeholders are skipped."""
        if lang not in LANGUAGES:
            lang = DEFAULT_LANGUAGE
        module = LANGUAGES[lang]
        variants: list[str] = module.TEMPLATES[key]
        usable = [v for v in variants if _placeholders(v) <= fields.keys()]
        if not usable:
            usable = [v for v in variants if not _placeholders(v)] or variants
        last = self._last.get((lang, key))
        choices = [v for v in usable if v != last] or usable
        chosen = self._rng.choice(choices)
        self._last[(lang, key)] = chosen
        cacheable = _placeholders(chosen) <= module.STATIC_FIELDS
        return chosen.format_map(_Safe(fields)), cacheable


_default_book = TemplateBook()


def display_name(address: int, cars: dict[int, CarConfig]) -> str:
    car = cars.get(address)
    if car is None:
        return str(address + 1)
    return car.nickname or car.name


def _car_state(state: RaceState, address: int) -> CarState | None:
    return next((c for c in state.cars if c.address == address), None)


def candidates(
    event: RaceEvent,
    state: RaceState,
    cars: dict[int, CarConfig],
    verbosity: Verbosity,
    language: str = DEFAULT_LANGUAGE,
    book: TemplateBook | None = None,
) -> list[Candidate]:
    """Commentary candidates for one event, already filtered by verbosity."""
    book = book or _default_book
    lang = language if language in LANGUAGES else DEFAULT_LANGUAGE
    prio = CommentaryPriority
    specs: list[_Spec] = []

    def name(addr: int) -> str:
        return display_name(addr, cars)

    if isinstance(event, RaceStarted):
        specs.append(("race_started", prio.HIGH, {}, {"mode": event.mode.value}, None))
    elif isinstance(event, RaceFinished):
        winner = event.winner if event.winner is not None else next(iter(event.order), None)
        if winner is not None:
            fields = {"winner": name(winner)}
            facts: dict[str, Any] = {"winner": name(winner)}
            if len(event.order) > 1:
                fields["second"] = name(event.order[1])
                facts["second"] = name(event.order[1])
            specs.append(("race_finished", prio.HIGH, fields, facts, winner))
    elif isinstance(event, BestLap):
        car = _car_state(state, event.address)
        leader = car is not None and car.position == 1
        if event.overall:
            key, level = "best_lap_overall", prio.HIGH
        else:
            key, level = "best_lap_personal", (prio.NORMAL if leader else prio.LOW)
        fields = {"name": name(event.address), "lap_time": speech.say_lap_time(event.lap_ms, lang)}
        facts = {"driver": name(event.address), "lap_ms": event.lap_ms, "overall": event.overall}
        specs.append((key, level, fields, facts, event.address))
    elif isinstance(event, TrackRecord):
        fields = {"name": name(event.address), "lap_time": speech.say_lap_time(event.lap_ms, lang)}
        facts = {
            "driver": name(event.address),
            "lap_ms": event.lap_ms,
            "layout": event.layout,
        }
        if event.previous_ms is not None:
            fields["previous_time"] = speech.say_lap_time(event.previous_ms, lang)
            facts["previous_ms"] = event.previous_ms
            if event.previous_holder:
                fields["holder"] = event.previous_holder
                facts["previous_holder"] = event.previous_holder
        # The very first record of a layout is routine; only a beaten record is big news.
        level = prio.HIGH if event.previous_ms is not None else prio.NORMAL
        specs.append(("track_record", level, fields, facts, event.address))
    elif isinstance(event, PositionChange):
        if event.new_position < event.old_position:
            fields = {
                "name": name(event.address),
                "position": speech.say_position(event.new_position, lang),
            }
            facts = {"driver": name(event.address), "new_position": event.new_position}
            if event.passed_address is not None:
                fields["passed"] = name(event.passed_address)
                facts["passed"] = name(event.passed_address)
            specs.append(("position_change", prio.HIGH, fields, facts, event.address))
    elif isinstance(event, PitEntry):
        specs.append(("pit_entry", prio.NORMAL, {"name": name(event.address)}, {}, event.address))
    elif isinstance(event, PitExit):
        fields = {"name": name(event.address)}
        if event.fuel is not None:
            fields["fuel"] = speech.say_number(event.fuel, lang)
        facts = {"driver": name(event.address)}
        specs.append(("pit_exit", prio.NORMAL, fields, facts, event.address))
    elif isinstance(event, LowFuel):
        fields = {"name": name(event.address), "fuel": speech.say_number(event.fuel, lang)}
        specs.append(("low_fuel", prio.NORMAL, fields, {"fuel": event.fuel}, event.address))
    elif isinstance(event, Idle):
        specs.append(("idle", prio.LOW, {}, {"idle_seconds": event.seconds}, None))
    elif isinstance(event, LapCompleted):
        specs.extend(_lap_specs(event, state, verbosity, lang, name))

    result: list[Candidate] = []
    for key, level, fields, facts, address in specs:
        if not _keep(key, level, verbosity):
            continue
        text, cacheable = book.render(lang, key, fields)
        facts = {"event": key, **facts}
        result.append(Candidate(text, level, event.type, key, cacheable, address, facts, lang))
    return result


def _lap_specs(
    event: LapCompleted,
    state: RaceState,
    verbosity: Verbosity,
    lang: str,
    name: Callable[[int], str],
) -> list[_Spec]:
    if not event.valid:
        return []
    prio = CommentaryPriority
    is_leader = event.position == 1
    fields = {
        "name": name(event.address),
        "lap_time": speech.say_lap_time(event.lap_ms, lang),
        "lap": speech.say_number(event.lap_number, lang),
    }
    facts = {"driver": name(event.address), "lap": event.lap_number, "lap_ms": event.lap_ms}
    cfg = state.config
    if (
        is_leader
        and cfg.mode == RaceMode.LAPS
        and cfg.target_laps > 1
        and event.lap_number == cfg.target_laps - 1
    ):
        return [("final_lap", prio.NORMAL, fields, {**facts, "final_lap": True}, event.address)]
    if is_leader:
        every_lap = verbosity == Verbosity.HIGH
        periodic = verbosity == Verbosity.NORMAL and event.lap_number % LEADER_LAP_EVERY_N == 0
        if every_lap or periodic:
            return [("leader_lap", prio.LOW, fields, {**facts, "leader": True}, event.address)]
        return []
    if verbosity == Verbosity.HIGH and event.lap_number % 2 == 0:
        return [("lap_completed", prio.LOW, fields, facts, event.address)]
    return []


def _keep(key: str, level: CommentaryPriority, verbosity: Verbosity) -> bool:
    if verbosity == Verbosity.LOW:
        if level == CommentaryPriority.LOW:
            return False
        if level == CommentaryPriority.NORMAL:
            return key in _LOW_VERBOSITY_NORMAL_KEYS
    return True
