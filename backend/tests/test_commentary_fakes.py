"""Shared fakes for the commentary tests (no network, no real time)."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator

from app.commentary.director import CommentaryDirector
from app.commentary.llm import TemplateWriter
from app.commentary.tts import BudgetTracker
from app.race.models import (
    CarConfig,
    CarState,
    CommentaryLine,
    CommentarySettings,
    LapCompleted,
    PositionChange,
    RaceFinished,
    RaceMode,
    RaceStarted,
    RaceState,
)

CARS = {
    0: CarConfig(address=0, name="Rosso", nickname="Fulmine"),
    1: CarConfig(address=1, name="Blu"),
    2: CarConfig(address=2, name="Verde"),
}


class FakeClock:
    def __init__(self, t: float = 100.0) -> None:
        self.t = t

    def __call__(self) -> float:
        return self.t

    def advance(self, dt: float) -> None:
        self.t += dt


class FakeTTS:
    def __init__(self, chunks: list[bytes] | None = None, available: bool = True) -> None:
        self._available = available
        self.chunks = chunks if chunks is not None else [b"aaaa", b"bbbb", b"cccc"]
        self.calls: list[str] = []
        self.fail = False
        self.cached: set[str] = set()
        self.gate: asyncio.Event | None = None

    @property
    def available(self) -> bool:
        return self._available

    def is_cached(self, text: str, *, voice_id: str | None = None) -> bool:
        return text in self.cached

    async def stream(
        self, text: str, *, cacheable: bool = False, voice_id: str | None = None
    ) -> AsyncIterator[bytes]:
        self.calls.append(text)
        if self.fail:
            return
        for chunk in self.chunks:
            if self.gate is not None:
                await self.gate.wait()
            yield chunk


class Sink:
    def __init__(self) -> None:
        self.lines: list[CommentaryLine] = []
        self.stops: list[str] = []

    async def on_line(self, line: CommentaryLine) -> None:
        self.lines.append(line)

    async def on_stop(self, line_id: str) -> None:
        self.stops.append(line_id)


def make_director(
    settings: CommentarySettings | None = None,
    tts: FakeTTS | None = None,
    budget: BudgetTracker | None = None,
    writer=None,
    clock: FakeClock | None = None,
    **kwargs,
) -> tuple[CommentaryDirector, Sink, FakeClock]:
    clock = clock or FakeClock()
    sink = Sink()
    director = CommentaryDirector(
        settings or CommentarySettings(),
        lambda: CARS,
        writer or TemplateWriter(),
        tts,
        budget,
        sink.on_line,
        sink.on_stop,
        clock,
        mp3_bytes_per_second=kwargs.pop("mp3_bytes_per_second", None),
        **kwargs,
    )
    return director, sink, clock


def make_budget(session: int = 10_000, monthly: int = 100_000) -> BudgetTracker:
    used = {"m": 0}

    def add(n: int) -> None:
        used["m"] += n

    return BudgetTracker(session, monthly, lambda: used["m"], add)


def state(laps_target: int = 10, mode: RaceMode = RaceMode.LAPS) -> RaceState:
    st = RaceState()
    st.config.mode = mode
    st.config.target_laps = laps_target
    st.cars = [
        CarState(address=0, name="Rosso", color="#f00", position=1, laps=3),
        CarState(address=1, name="Blu", color="#00f", position=2, laps=3),
    ]
    return st


def ev_started() -> RaceStarted:
    return RaceStarted(mode=RaceMode.LAPS, addresses=[0, 1])


def ev_overtake() -> PositionChange:
    return PositionChange(address=1, old_position=2, new_position=1, passed_address=0)


def ev_finished() -> RaceFinished:
    return RaceFinished(winner=0, order=[0, 1])


def ev_lap(address: int = 0, lap: int = 3, position: int | None = 1) -> LapCompleted:
    return LapCompleted(address=address, lap_number=lap, lap_ms=7342, position=position)
