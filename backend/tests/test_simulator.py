"""Simulator tests: deterministic generator and a real-time (scaled) race through the engine."""

from __future__ import annotations

import asyncio
import itertools
import random
import time

import pytest

from app.race.engine import RaceEngine
from app.race.models import (
    LapCompleted,
    RaceConfig,
    RaceFinished,
    RaceMode,
    RacePhase,
    RaceStarted,
    default_cars,
)
from app.track.base import (
    MODE_FUEL,
    MODE_PIT_LANE,
    Status,
    Timer,
    TrackDisconnected,
    TrackInterface,
    ts_diff,
)
from app.track.simulator import SimulatedCU, SimulatorTrack


def take(track: SimulatorTrack, virtual_ms: float):
    out = []
    for t, msg in track.generate():
        if t > virtual_ms:
            return out
        out.append((t, msg))
    return out


def test_is_track_interface():
    assert isinstance(SimulatorTrack(), TrackInterface)


def test_validates_args():
    with pytest.raises(ValueError):
        SimulatorTrack(num_cars=7)
    with pytest.raises(ValueError):
        SimulatorTrack(time_scale=0)


def test_start_sequence_then_cars_run():
    track = SimulatorTrack(num_cars=3, seed=1, double_trigger_rate=0)
    msgs = take(track, 40_000)
    lights = [m.start for _, m in msgs if isinstance(m, Status)]
    dedup = [k for k, _ in itertools.groupby(lights)]
    # generate() arms and presses again at t=0, so light 1 is not seen as a separate status
    assert dedup == [2, 3, 4, 5, 6, 7, 0]
    first_timer = next(t for t, m in msgs if isinstance(m, Timer))
    go_time = next(t for t, m in msgs if isinstance(m, Status) and m.start == 7)
    assert go_time <= first_timer < go_time + 3000  # shortly after go
    assert {m.address for _, m in msgs if isinstance(m, Timer)} == {0, 1, 2}


def test_cu_needs_two_start_presses_and_ignores_presses_while_counting():
    cu = SimulatedCU(2, random.Random(1), 0, True, True, 0)
    assert cu.status().start == 0
    cu.start(0.0)  # first press: armed, light held
    assert cu.status().start == 1 and not cu.started
    assert cu.advance(10_000) == []
    cu.start(10_000.0)  # second press: countdown 2..6, 7, 0
    lights = [m.start for _, m in cu.advance(20_000) if isinstance(m, Status)]
    assert lights == [2, 3, 4, 5, 6, 7, 0]
    cu.start(20_000.0)  # ignored
    assert cu.light == 0


def test_cars_stand_still_without_start():
    track = SimulatorTrack(seed=1)
    msgs = [m for _, m in itertools.islice(track.generate(auto_start=False), 500)]
    assert all(isinstance(m, Status) for m in msgs)


def test_reproducible_with_seed():
    a = take(SimulatorTrack(num_cars=4, seed=42), 60_000)
    b = take(SimulatorTrack(num_cars=4, seed=42), 60_000)
    c = take(SimulatorTrack(num_cars=4, seed=43), 60_000)
    assert a == b
    assert a != c


def test_status_mode_bits_and_fuel_off():
    full = SimulatorTrack(seed=1)
    status = next(m for _, m in full.generate() if isinstance(m, Status))
    assert status.mode == MODE_FUEL | MODE_PIT_LANE and len(status.fuel) == 8
    plain = SimulatorTrack(seed=1, fuel=False, pit_lane=False)
    status = next(m for _, m in plain.generate() if isinstance(m, Status))
    assert status.mode == 0


def test_lap_times_are_slot_car_like():
    track = SimulatorTrack(num_cars=4, seed=3, double_trigger_rate=0)
    laps: dict[int, list[int]] = {}
    last: dict[int, int] = {}
    for _, m in take(track, 120_000):
        if isinstance(m, Timer):
            if m.address in last:
                laps.setdefault(m.address, []).append(ts_diff(m.timestamp, last[m.address]))
            last[m.address] = m.timestamp
    assert len(laps) == 4
    for times in laps.values():
        assert len(times) >= 8
        assert min(times) > 4000
        assert sorted(times)[len(times) // 2] < 9000  # median in the 5-8 s range


def test_double_triggers_are_close_and_filtered_by_engine():
    track = SimulatorTrack(num_cars=2, seed=5, double_trigger_rate=1.0, fuel=False)
    engine = RaceEngine(default_cars(), RaceConfig(mode=RaceMode.PRACTICE), clock=lambda: 0.0)
    engine.prepare(RaceConfig(mode=RaceMode.PRACTICE))
    close = 0
    last: dict[int, int] = {}
    for _, m in take(track, 60_000):
        if isinstance(m, Timer):
            if m.address in last and ts_diff(m.timestamp, last[m.address]) <= 50:
                close += 1
            last[m.address] = m.timestamp
        engine.handle(m)
    assert close > 5
    assert all(lap.lap_ms >= 4000 for lap in engine.laps) and engine.laps


def test_clock_wraparound_through_engine():
    track = SimulatorTrack(
        num_cars=2, seed=7, double_trigger_rate=0, fuel=False, clock_offset_ms=2**32 - 15_000
    )
    engine = RaceEngine(default_cars(), RaceConfig(mode=RaceMode.PRACTICE), clock=lambda: 0.0)
    engine.prepare(RaceConfig(mode=RaceMode.PRACTICE))
    stamps = []
    for _, m in take(track, 60_000):
        if isinstance(m, Timer):
            stamps.append(m.timestamp)
        engine.handle(m)
    assert min(stamps) < 2**31 < max(stamps)  # the CU clock really wrapped
    assert len(engine.laps) >= 6
    assert all(4000 < lap.lap_ms < 20_000 for lap in engine.laps)


def test_fuel_decreases_and_cars_pit():
    track = SimulatorTrack(num_cars=1, seed=2, double_trigger_rate=0)
    fuels, pits = [], []
    for _, m in take(track, 400_000):
        if isinstance(m, Status):
            fuels.append(m.fuel[0])
            pits.append(m.pit[0])
    assert fuels[0] == 15 and min(fuels) <= 2
    assert any(pits)
    assert fuels[pits.index(True) :][-1] >= 0
    # after a pit stop fuel is back to 15
    exit_index = next(i for i in range(1, len(pits)) if pits[i - 1] and not pits[i])
    assert fuels[exit_index] == 15


def test_engine_sees_pit_and_low_fuel_from_simulator():
    from app.race.models import LowFuel, PitEntry, PitExit

    track = SimulatorTrack(num_cars=1, seed=2, double_trigger_rate=0)
    clock = {"t": 0.0}
    engine = RaceEngine(
        default_cars(), RaceConfig(mode=RaceMode.PRACTICE), clock=lambda: clock["t"]
    )
    engine.prepare(RaceConfig(mode=RaceMode.PRACTICE, idle_after_s=3600))
    events = []
    for t, m in take(track, 400_000):
        clock["t"] = t / 1000
        events.extend(engine.handle(m))
    kinds = {type(e) for e in events}
    assert {PitEntry, PitExit, LowFuel} <= kinds


async def test_pace_car_pauses_cars():
    track = SimulatorTrack(num_cars=2, seed=1, time_scale=200, double_trigger_rate=0, fuel=False)
    await track.connect()
    await track.start()  # arm
    await track.start()  # countdown
    stamps: list[tuple[float, int]] = []

    async def collect(seconds: float):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            m = await track.poll()
            if isinstance(m, Timer):
                stamps.append((time.monotonic(), m.address))

    await collect(0.2)  # 40 s virtual: past the start sequence, cars running
    before = len(stamps)
    assert before > 0
    await track.toggle_pace_car()
    mark = len(stamps)
    await collect(0.2)
    assert len(stamps) - mark <= 1  # at most one timer already in the queue
    await track.toggle_pace_car()
    await collect(0.2)
    assert len(stamps) > mark + 1
    await track.close()


async def test_poll_reset_and_close():
    track = SimulatorTrack(num_cars=2, seed=1, time_scale=100, clock_offset_ms=12345)
    await track.connect()
    assert track.connected
    first = await track.poll()
    assert isinstance(first, Status)
    await track.reset_timer()
    msg = await track.poll()
    assert isinstance(msg, Status)
    await track.close()
    await track.close()
    assert not track.connected
    with pytest.raises(TrackDisconnected):
        await track.poll()


@pytest.mark.parametrize("seed", [11, 12])
async def test_three_lap_race_through_engine_is_fast(seed):
    scale = 50.0
    start = time.monotonic()
    track = SimulatorTrack(num_cars=3, seed=seed, time_scale=scale, double_trigger_rate=0.05)
    engine = RaceEngine(
        default_cars(),
        RaceConfig(mode=RaceMode.LAPS, target_laps=3),
        clock=lambda: (time.monotonic() - start) * scale,
    )
    await track.connect()
    engine.prepare(RaceConfig(mode=RaceMode.LAPS, target_laps=3))
    await track.start()  # arm
    await track.start()  # countdown
    events = []
    while engine.state.phase is not RacePhase.FINISHED:
        events.extend(engine.handle(await track.poll()))
        events.extend(engine.tick())
        assert time.monotonic() - start < 10, "race did not finish in time"
    await track.close()

    assert time.monotonic() - start < 10
    assert len([e for e in events if isinstance(e, RaceStarted)]) == 1
    finished = [e for e in events if isinstance(e, RaceFinished)]
    assert len(finished) == 1 and sorted(finished[0].order) == [0, 1, 2]
    laps = engine.laps
    assert {lap.address for lap in laps} == {0, 1, 2}
    assert all(3000 < lap.lap_ms < 25_000 for lap in laps)
    state = engine.state
    assert state.cars[0].laps == 3 and state.cars[0].finished
    completed = [e for e in events if isinstance(e, LapCompleted)]
    assert len(completed) == len(laps)


# ---------------------------------------------------------------- Check Lanes


def test_check_lanes_validation():
    with pytest.raises(ValueError):
        SimulatorTrack(check_lanes=[0.2, 0.5, 0.8])
    with pytest.raises(ValueError):
        SimulatorTrack(check_lanes=[1.2])
    with pytest.raises(ValueError):
        SimulatorTrack(check_lanes=[0.0])


def test_check_lanes_default_keeps_old_stream():
    plain = take(SimulatorTrack(num_cars=3, seed=5), 40_000)
    explicit = take(SimulatorTrack(num_cars=3, seed=5, check_lanes=[]), 40_000)
    assert plain == explicit
    assert {m.sector for _, m in plain if isinstance(m, Timer)} == {1}


def test_check_lanes_emit_sensors_at_the_right_fractions():
    track = SimulatorTrack(
        num_cars=2, seed=3, double_trigger_rate=0, fuel=False, check_lanes=[0.33, 0.66]
    )
    per_car: dict[int, list[tuple[float, int]]] = {0: [], 1: []}
    for t, m in take(track, 90_000):
        if isinstance(m, Timer):
            per_car[m.address].append((t, m.sector))
    for events in per_car.values():
        sectors = [s for _, s in events]
        assert set(sectors) == {1, 2, 3}
        # strictly 1, 2, 3, 1, 2, 3 ... after the start pass (first line crossing)
        assert sectors[:7] == [1, 2, 3, 1, 2, 3, 1]
        lines = [t for t, s in events if s == 1]
        lap = lines[1] - lines[0]
        at2 = next(t for t, s in events if s == 2 and t > lines[0])
        at3 = next(t for t, s in events if s == 3 and t > lines[0])
        assert abs((at2 - lines[0]) / lap - 0.33) < 0.05
        assert abs((at3 - lines[0]) / lap - 0.66) < 0.05


def test_check_lanes_are_reproducible_and_feed_the_engine():
    def run():
        track = SimulatorTrack(
            num_cars=3, seed=11, double_trigger_rate=0.05, check_lanes=[0.33, 0.66]
        )
        engine = RaceEngine(default_cars(), RaceConfig(mode=RaceMode.PRACTICE), clock=lambda: 0.0)
        engine.prepare(RaceConfig(mode=RaceMode.PRACTICE))
        msgs = []
        for _, m in take(track, 80_000):
            msgs.append(m)
            engine.handle(m)
        return msgs, engine

    first, engine = run()
    second, _ = run()
    assert first == second
    assert engine.state.num_sectors == 3
    for c in engine.state.cars:
        if c.laps >= 2:
            assert all(s is not None for s in c.last_sectors)
            assert sum(c.last_sectors) == c.last_lap_ms
            assert set(c.segment_estimates) == {"1>2", "2>3", "3>1"}


# --------------------------------------------------------------------------- controller settings


def laps_of(track: SimulatorTrack, address: int, virtual_ms: float) -> list[float]:
    stamps = [
        m.timestamp
        for _, m in take(track, virtual_ms)
        if isinstance(m, Timer) and m.address == address and m.sector == 1
    ]
    return [ts_diff(b, a) for a, b in zip(stamps, stamps[1:], strict=False)]


def make_sim(**kw) -> SimulatorTrack:
    return SimulatorTrack(num_cars=2, seed=3, double_trigger_rate=0.0, deslot_rate=0.0, **kw)


async def test_set_speed_scales_the_lap_time_four_percent_per_step():
    fast, slow = make_sim(), make_sim()
    await slow.set_speed(0, 10)  # 5 steps below 15: +20 %
    a = laps_of(fast, 0, 200_000)
    b = laps_of(slow, 0, 400_000)
    assert len(a) >= 5 and len(b) >= 5
    assert sum(b[:5]) / 5 == pytest.approx(sum(a[:5]) / 5 * 1.2, rel=0.05)


async def test_set_speed_beyond_the_car_count_is_a_noop():
    track = make_sim()
    await track.set_speed(5, 3)  # only cars 0 and 1 exist
    await track.set_brake(5, 3)
    await track.set_fuel(5, 3)


async def test_set_fuel_sets_the_tank_level_and_brake_is_ignored():
    track = make_sim()
    await track.set_fuel(1, 4)
    await track.set_brake(1, 0)
    status = track._core.status()
    assert status.fuel[1] == 4 and status.fuel[0] == 15


async def test_simulator_validates_controller_values():
    track = make_sim()
    for call in (track.set_speed, track.set_brake, track.set_fuel):
        with pytest.raises(ValueError):
            await call(6, 1)
        with pytest.raises(ValueError):
            await call(0, 16)


def test_cross_is_a_single_deterministic_crossing():
    track = make_sim()
    track.cross(1, at_ms=500)
    stream = itertools.takewhile(lambda x: x[0] <= 20_000, track.generate(auto_start=False))
    timers = [(t, m) for t, m in stream if isinstance(m, Timer)]
    assert [(t, m.address, m.sector) for t, m in timers] == [(500, 1, 1)]  # and no lap cycle


async def test_press_code_schedules_a_crossing_of_car_0_about_two_seconds_later():
    track = SimulatorTrack(num_cars=2, seed=1, time_scale=100.0)
    await track.connect()
    await track.press_code()
    got = []
    deadline = time.monotonic() + 3
    while not got and time.monotonic() < deadline:
        msg = await track.poll()
        if isinstance(msg, Timer):
            got.append(msg)
    assert got and got[0].address == 0 and got[0].sector == 1
    await asyncio.sleep(0.05)
    assert not any(isinstance(m, Timer) for m in track._queue)  # no lap cycle started
    await track.close()


def test_cross_rejects_an_address_outside_0_5():
    with pytest.raises(ValueError):
        make_sim().cross(6)
