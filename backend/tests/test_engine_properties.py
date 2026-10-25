"""Property tests: the engine must stay sane for any monotonic (mod 2**32) timer stream."""

from __future__ import annotations

from hypothesis import given, settings
from hypothesis import strategies as st

from app.race.engine import RaceEngine
from app.race.models import RaceConfig, RaceMode, default_cars
from app.track.base import TIMESTAMP_MODULO, Status, Timer

CONFIG = RaceConfig(mode=RaceMode.PRACTICE, min_lap_ms=2000, max_lap_ms=60_000)


def _running_engine() -> RaceEngine:
    clock = iter(range(10**9))  # strictly advancing fake host clock
    engine = RaceEngine(default_cars(), CONFIG, clock=lambda: next(clock) / 1000)
    engine.prepare(CONFIG)
    for light in (1, 2, 3, 4, 5, 6, 7):
        engine.handle(Status(fuel=(15,) * 8, start=light, mode=0, pit=(False,) * 8))
    return engine


steps = st.lists(
    st.tuples(st.integers(0, 5), st.integers(0, 40_000)),  # (address, ms since previous timer)
    min_size=1,
    max_size=120,
)


@settings(max_examples=150, deadline=None)
@given(start=st.integers(0, TIMESTAMP_MODULO - 1), steps=steps)
def test_laps_are_sane_for_monotonic_timestamps(start, steps):
    engine = _running_engine()
    ts = start
    previous_laps: dict[int, int] = {}
    last_race_time = 0
    for address, delta in steps:
        ts = (ts + delta) % TIMESTAMP_MODULO
        engine.handle(Timer(address, ts, 1))
        state = engine.state
        assert state.race_time_ms >= last_race_time
        last_race_time = state.race_time_ms
        for car in state.cars:
            assert car.laps >= previous_laps.get(car.address, 0)
            previous_laps[car.address] = car.laps
            assert len(car.lap_times) == car.laps
    for lap in engine.laps:
        assert lap.lap_ms > 0
        assert lap.lap_ms >= CONFIG.min_lap_ms
        assert lap.valid == (lap.lap_ms <= CONFIG.max_lap_ms)
    for car in engine.state.cars:
        assert all(t >= CONFIG.min_lap_ms for t in car.lap_times)
        if car.best_lap_ms is not None:
            assert car.best_lap_ms <= (car.avg_lap_ms or car.best_lap_ms)
        placed = car.position is not None
        assert placed == (car.total_time_ms is not None)
    positions = [c.position for c in engine.state.cars if c.position is not None]
    assert positions == list(range(1, len(positions) + 1))
