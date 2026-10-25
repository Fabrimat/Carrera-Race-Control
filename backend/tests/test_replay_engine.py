"""Replay the recorded fixture session through ReplayTrack(speed=0) + RaceEngine."""

from __future__ import annotations

import json
from collections import defaultdict
from pathlib import Path

import pytest

from app.race.engine import RaceEngine
from app.race.models import RaceConfig, RaceMode, RacePhase, default_cars
from app.track.base import TrackDisconnected, ts_diff
from app.track.replay import ReplayTrack

FIXTURE = Path(__file__).parent / "fixtures" / "session_small.jsonl"


def expected_laps(path: Path) -> dict[int, list[int]]:
    """Independent oracle: lap times from consecutive start/finish timers after the go."""
    records = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]
    go_seen = False
    lights_seen = False
    last: dict[int, int] = {}
    laps: dict[int, list[int]] = defaultdict(list)
    for rec in records:
        if rec["kind"] == "status":
            if 1 <= rec["start"] <= 6:
                lights_seen = True
            elif rec["start"] in (0, 7) and lights_seen:
                go_seen = True
            continue
        if not go_seen or rec["sector"] != 1 or rec["address"] > 5:
            continue
        address, ts = rec["address"], rec["timestamp"]
        if address in last:
            lap = ts_diff(ts, last[address])
            if lap < RaceConfig().min_lap_ms:
                continue
            laps[address].append(lap)
        last[address] = ts
    return dict(laps)


async def replay(config: RaceConfig) -> RaceEngine:
    engine = RaceEngine(default_cars(), config)
    engine.prepare(config)
    track = ReplayTrack(FIXTURE, speed=0)
    await track.connect()
    try:
        while True:
            try:
                msg = await track.poll()
            except TrackDisconnected:
                break
            engine.handle(msg)
            engine.tick()
    finally:
        await track.close()
    return engine


async def test_replay_practice_lap_counts_and_best_laps() -> None:
    oracle = expected_laps(FIXTURE)
    assert len(oracle) >= 2 and all(len(v) >= 4 for v in oracle.values())  # fixture sanity

    engine = await replay(RaceConfig(mode=RaceMode.PRACTICE))
    state = engine.state
    assert state.phase is RacePhase.RUNNING
    assert state.fuel_mode and state.pit_lane  # mode 5 = fuel + pit lane

    cars = {c.address: c for c in state.cars}
    for address, laps in oracle.items():
        car = cars[address]
        assert car.laps == len(laps)
        assert car.lap_times == laps
        assert car.best_lap_ms == min(laps)
        assert car.last_lap_ms == laps[-1]
        assert car.fuel is not None and car.fuel < 15
    best_overall = min(min(v) for v in oracle.values())
    assert state.best_lap is not None and state.best_lap.lap_ms == best_overall
    assert [lap.lap_ms for lap in engine.laps if lap.address == 0] == oracle[0]
    # Wraparound across 2**32 inside the session: every lap is a sane slot-car lap.
    assert all(3000 < lap.lap_ms < 15000 for lap in engine.laps)


async def test_replay_fixture_known_values() -> None:
    engine = await replay(RaceConfig(mode=RaceMode.PRACTICE))
    cars = {c.address: c for c in engine.state.cars}
    assert [cars[a].laps for a in range(4)] == [5, 5, 5, 5]
    assert cars[0].lap_times[:2] == [6047, 5995]  # second lap crosses the 2**32 wrap
    positions = [c.address for c in engine.state.cars if c.position is not None]
    assert positions[0] == 0  # car 1 completes its 5th lap first


@pytest.mark.parametrize("target", [3, 5])
async def test_replay_laps_race_finishes(target: int) -> None:
    engine = await replay(RaceConfig(mode=RaceMode.LAPS, target_laps=target))
    state = engine.state
    oracle = expected_laps(FIXTURE)
    # The leader completes `target` laps; the others finish on their next crossing.
    assert state.phase is RacePhase.FINISHED
    assert all(c.laps <= target for c in state.cars)
    leader = state.cars[0]
    assert leader.position == 1 and leader.laps == target
    assert leader.finished
    assert all(c.laps <= len(oracle.get(c.address, [])) for c in state.cars)
