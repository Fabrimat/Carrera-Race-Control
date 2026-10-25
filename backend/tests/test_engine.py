"""Engine tests with scripted, deterministic Timer/Status sequences (engine is never mocked)."""

from __future__ import annotations

import pytest

from app.race.engine import RaceEngine
from app.race.models import (
    BestLap,
    CarConfig,
    Idle,
    LapCompleted,
    LowFuel,
    PitEntry,
    PitExit,
    PositionChange,
    RaceConfig,
    RaceFinished,
    RaceMode,
    RacePhase,
    RaceStarted,
    default_cars,
)
from app.track.base import MODE_FUEL, MODE_PIT_LANE, TIMESTAMP_MODULO, Status, Timer


class FakeClock:
    def __init__(self) -> None:
        self.t = 100.0

    def __call__(self) -> float:
        return self.t

    def advance(self, seconds: float) -> None:
        self.t += seconds


def status(start=0, fuel=None, pit=None, mode=0) -> Status:
    return Status(
        fuel=tuple(fuel or [15] * 8),
        start=start,
        mode=mode,
        pit=tuple(pit or [False] * 8),
    )


def of_type(events, cls):
    return [e for e in events if isinstance(e, cls)]


def make(config: RaceConfig | None = None, cars=None):
    clock = FakeClock()
    engine = RaceEngine(cars or default_cars(), config, clock=clock)
    return engine, clock


def go(engine: RaceEngine, config: RaceConfig | None = None):
    """prepare + light sequence; returns the events of the go status."""
    engine.prepare(config or engine.config)
    for light in (1, 2, 3, 4, 5, 6):
        assert engine.handle(status(light)) == []
    return engine.handle(status(7))


def cross(engine: RaceEngine, address: int, ts: int, sector: int = 1):
    return engine.handle(Timer(address, ts, sector))


# ---------------------------------------------------------------- start sequence


def test_start_sequence_emits_race_started_once():
    engine, _ = make()
    engine.prepare(RaceConfig(mode=RaceMode.LAPS, target_laps=3))
    assert engine.state.phase is RacePhase.STARTING
    for light in (1, 2, 3, 4, 5, 6):
        engine.handle(status(light))
        assert engine.state.start_light == light
    events = engine.handle(status(7))
    started = of_type(events, RaceStarted)
    assert len(started) == 1 and started[0].mode is RaceMode.LAPS
    assert started[0].addresses == [0, 1, 2, 3, 4, 5]
    assert engine.state.phase is RacePhase.RUNNING
    assert of_type(engine.handle(status(0)), RaceStarted) == []


def test_start_light_zero_also_starts_after_sequence():
    engine, _ = make()
    engine.prepare(RaceConfig())
    engine.handle(status(3))
    assert of_type(engine.handle(status(0)), RaceStarted)


def test_zero_without_sequence_does_not_start():
    engine, _ = make()
    engine.prepare(RaceConfig())
    engine.handle(status(0))
    assert engine.state.phase is RacePhase.STARTING


@pytest.mark.parametrize("bad", [8, 9])
def test_false_start_no_race_started(bad):
    engine, _ = make()
    engine.prepare(RaceConfig())
    engine.handle(status(1))
    engine.handle(status(2))
    assert engine.handle(status(bad)) == []
    assert engine.state.phase is RacePhase.STARTING
    # Idle status 0 after a false start must not start the race
    assert engine.handle(status(0)) == []
    assert engine.state.phase is RacePhase.STARTING
    # A fresh sequence then works
    engine.handle(status(1))
    engine.handle(status(2))
    assert of_type(engine.handle(status(7)), RaceStarted)


def test_armed_then_dropped_back_to_zero_does_not_start():
    engine, _ = make()
    engine.prepare(RaceConfig())
    engine.handle(status(1))  # armed: no countdown yet
    assert engine.handle(status(0)) == []
    assert engine.state.phase is RacePhase.STARTING
    engine.handle(status(7))
    assert engine.state.phase is RacePhase.STARTING


def test_physical_cu_start_auto_prepares_from_idle():
    engine, _ = make(RaceConfig(mode=RaceMode.LAPS, target_laps=4))
    assert engine.state.phase is RacePhase.IDLE
    engine.handle(status(1))
    assert engine.state.phase is RacePhase.STARTING
    engine.handle(status(2))
    events = engine.handle(status(7))
    assert len(of_type(events, RaceStarted)) == 1
    assert engine.state.config.target_laps == 4


def test_physical_cu_start_auto_prepares_from_finished():
    engine, _ = make(RaceConfig(mode=RaceMode.PRACTICE))
    go(engine)
    engine.stop()
    assert engine.state.phase is RacePhase.FINISHED
    engine.handle(status(2))
    assert engine.state.phase is RacePhase.STARTING


@pytest.mark.parametrize("how", ["stop", "reset"])
def test_stop_while_cu_stays_armed_does_not_auto_prepare(how):
    engine, _ = make(RaceConfig(mode=RaceMode.PRACTICE))
    engine.prepare(engine.config)
    engine.handle(status(1))  # armed, race still STARTING
    getattr(engine, how)()
    expected = RacePhase.FINISHED if how == "stop" else RacePhase.IDLE
    for _ in range(5):  # the CU keeps reporting the same level
        assert engine.handle(status(1)) == []
        assert engine.state.phase is expected
    assert engine.race_id is None
    # A real transition after the stop: back to 0, then a new press arms again.
    engine.handle(status(0))
    assert engine.state.phase is expected
    engine.handle(status(1))
    assert engine.state.phase is RacePhase.STARTING
    for light in (2, 3, 4, 5, 6):
        engine.handle(status(light))
    assert len(of_type(engine.handle(status(7)), RaceStarted)) == 1


def test_light_change_after_stop_counts_as_a_press():
    engine, _ = make(RaceConfig(mode=RaceMode.PRACTICE))
    engine.prepare(engine.config)
    engine.handle(status(1))
    engine.stop()
    engine.handle(status(1))
    assert engine.state.phase is RacePhase.FINISHED
    engine.handle(status(2))  # the countdown began: a new race
    assert engine.state.phase is RacePhase.STARTING


def test_timers_ignored_before_go():
    engine, _ = make()
    engine.prepare(RaceConfig())
    assert cross(engine, 0, 1000) == []
    assert engine.state.cars[0].position is None


def test_start_now_fallback():
    engine, _ = make()
    events = engine.start_now()
    assert len(of_type(events, RaceStarted)) == 1
    assert engine.state.phase is RacePhase.RUNNING
    assert engine.start_now() == []


def test_set_paused():
    engine, _ = make()
    go(engine)
    engine.set_paused(True)
    assert engine.state.phase is RacePhase.PAUSED
    cross(engine, 0, 1000)
    events = cross(engine, 0, 9000)  # laps keep counting while paused
    assert of_type(events, LapCompleted)
    engine.set_paused(False)
    assert engine.state.phase is RacePhase.RUNNING


def test_set_paused_ignored_when_not_running():
    engine, _ = make()
    engine.set_paused(True)
    assert engine.state.phase is RacePhase.IDLE


# ---------------------------------------------------------------- laps


def test_start_pass_is_not_a_lap_and_lap_completed():
    engine, _ = make()
    go(engine)
    assert cross(engine, 0, 5000) == []
    cs = engine.state.cars[0]
    assert cs.laps == 0 and cs.position == 1
    events = cross(engine, 0, 12_340)
    lap = of_type(events, LapCompleted)[0]
    assert (lap.address, lap.lap_number, lap.lap_ms, lap.position) == (0, 1, 7340, 1)
    assert engine.state.cars[0].laps == 1
    assert engine.laps[0].lap_ms == 7340


def test_double_trigger_ignored_and_reference_not_moved():
    engine, _ = make()
    go(engine)
    cross(engine, 0, 5000)
    assert cross(engine, 0, 5030) == []  # double trigger of the start pass
    events = cross(engine, 0, 12_000)
    assert of_type(events, LapCompleted)[0].lap_ms == 7000
    assert cross(engine, 0, 12_040) == []
    events = cross(engine, 0, 19_500)
    assert of_type(events, LapCompleted)[0].lap_ms == 7500
    assert engine.state.cars[0].laps == 2


def test_too_long_lap_counts_but_invalid():
    engine, _ = make(RaceConfig(max_lap_ms=20_000))
    go(engine)
    cross(engine, 0, 1000)
    cross(engine, 0, 8000)  # 7000 valid
    events = cross(engine, 0, 38_000)  # 30000 invalid
    lap = of_type(events, LapCompleted)[0]
    assert lap.valid is False and lap.lap_number == 2
    assert of_type(events, BestLap) == []
    cs = engine.state.cars[0]
    assert cs.laps == 2
    assert cs.best_lap_ms == 7000 and cs.avg_lap_ms == 7000
    assert cs.last_lap_ms == 30_000
    assert [lap.valid for lap in engine.laps] == [True, False]


def test_sector_other_than_one_ignored():
    engine, _ = make()
    go(engine)
    assert cross(engine, 0, 1000, sector=2) == []
    assert engine.state.cars[0].position is None


def test_addresses_6_and_7_ignored_unless_configured():
    engine, _ = make()
    go(engine)
    assert cross(engine, 6, 1000) == []
    assert cross(engine, 7, 1000) == []
    assert all(c.address <= 5 for c in engine.state.cars)

    cars = default_cars() + [CarConfig(address=6, name="Auto")]
    engine2, _ = make(cars=cars)
    go(engine2)
    cross(engine2, 6, 1000)
    assert engine2.state.cars[0].address == 6


def test_car_joining_mid_race():
    engine, _ = make()
    go(engine)
    cross(engine, 0, 1000)
    cross(engine, 0, 8000)
    cross(engine, 0, 15_000)
    assert cross(engine, 1, 15_500) == []  # start pass of a late car
    events = cross(engine, 1, 23_000)
    assert of_type(events, LapCompleted)[0].lap_number == 1
    states = {c.address: c for c in engine.state.cars}
    assert states[0].laps == 2 and states[1].laps == 1
    assert states[1].gap_to_leader_laps == 1 and states[1].gap_to_leader_ms is None


def test_timestamp_wraparound():
    engine, _ = make()
    go(engine)
    base = 2**32 - 3000
    cross(engine, 0, base)
    events = cross(engine, 0, (base + 7000) % 2**32)
    assert of_type(events, LapCompleted)[0].lap_ms == 7000
    cross(engine, 1, base + 500)
    events = cross(engine, 1, (base + 8200) % 2**32)
    assert of_type(events, LapCompleted)[0].lap_ms == 7700
    cs = {c.address: c for c in engine.state.cars}
    assert cs[1].gap_to_leader_ms == 1200  # (8200 - 7000), across the wrap


def test_best_lap_personal_and_overall():
    engine, _ = make()
    go(engine)
    cross(engine, 0, 1000)
    cross(engine, 1, 1200)
    ev = cross(engine, 0, 9000)  # car 0: 8000, first lap of the race -> silent
    assert of_type(ev, BestLap) == []
    ev = cross(engine, 1, 8700)  # car 1: 7500, first lap but beats the overall record
    best = of_type(ev, BestLap)
    assert len(best) == 1 and best[0].overall is True and best[0].previous_ms == 8000
    assert engine.state.best_lap.address == 1
    ev = cross(engine, 0, 16_900)  # car 0: 7900 improves personal, not overall
    best = of_type(ev, BestLap)
    assert len(best) == 1 and best[0].overall is False and best[0].previous_ms == 8000
    ev = cross(engine, 0, 24_000)  # car 0: 7100 beats overall too -> one event overall
    best = of_type(ev, BestLap)
    assert len(best) == 1 and best[0].overall is True and best[0].previous_ms == 7500
    assert engine.state.best_lap.address == 0 and engine.state.best_lap.lap_ms == 7100
    ev = cross(engine, 0, 32_000)  # 8000 slower: nothing
    assert of_type(ev, BestLap) == []


def test_late_joining_car_overall_record_emits_event():
    engine, _ = make()
    go(engine)
    cross(engine, 0, 1000)
    cross(engine, 0, 9000)  # 8000, silent (first lap of the race)
    cross(engine, 0, 16_900)  # 7900 personal best
    cross(engine, 1, 17_000)  # car 1 joins mid-race: start pass
    ev = cross(engine, 1, 24_000)  # 7000: first lap, beats the overall record
    best = of_type(ev, BestLap)
    assert len(best) == 1 and best[0].overall is True and best[0].previous_ms == 7900


def test_first_lap_personal_best_not_emitted_when_not_overall():
    engine, _ = make()
    go(engine)
    cross(engine, 0, 1000)
    cross(engine, 0, 8000)  # 7000 overall record, silent
    cross(engine, 1, 8100)
    ev = cross(engine, 1, 16_100)  # 8000 first lap, neither record
    assert of_type(ev, BestLap) == []


def test_position_change_and_gaps():
    engine, _ = make()
    go(engine)
    cross(engine, 0, 1000)
    cross(engine, 1, 1500)
    cross(engine, 0, 9000)  # car 0 lap 1
    ev = cross(engine, 1, 9300)  # car 1 lap 1, behind car 0
    assert of_type(ev, PositionChange) == []
    cs = {c.address: c for c in engine.state.cars}
    assert cs[0].position == 1 and cs[1].position == 2
    assert cs[1].gap_to_leader_ms == 300 and cs[1].gap_to_ahead_ms == 300
    assert cs[0].gap_to_leader_ms is None
    cross(engine, 0, 17_500)  # car 0 lap 2
    ev = cross(engine, 1, 17_000)  # car 1 lap 2, earlier than car 0 -> overtakes
    pos = of_type(ev, PositionChange)
    assert len(pos) == 1
    assert (pos[0].address, pos[0].old_position, pos[0].new_position) == (1, 2, 1)
    assert pos[0].passed_address == 0 and pos[0].approximate is True


def test_unplaced_cars_last_and_default_roster():
    engine, _ = make()
    go(engine)
    cross(engine, 3, 1000)
    addresses = [c.address for c in engine.state.cars]
    assert addresses == [3, 0, 1, 2, 4, 5]
    assert [c.position for c in engine.state.cars][:2] == [1, None]


def test_update_cars_renames():
    engine, _ = make()
    go(engine)
    cross(engine, 0, 1000)
    engine.update_cars([CarConfig(address=0, name="Ferrari", color="#ff0000")])
    cs = engine.state.cars[0]
    assert cs.name == "Ferrari" and cs.color == "#ff0000" and cs.position == 1


# ---------------------------------------------------------------- pit / fuel


def _pit_setup():
    engine, clock = make()
    go(engine)
    cross(engine, 0, 1000)  # start pass: fuel/pit tracked from here
    return engine, clock


PIT_MODE = MODE_FUEL | MODE_PIT_LANE
IN_PIT = [True] + [False] * 7


def test_pit_entry_exit_and_pit_stops():
    engine, clock = _pit_setup()
    assert engine.handle(status(0, pit=IN_PIT, mode=PIT_MODE)) == []  # first frame: pending
    clock.advance(0.2)
    ev = engine.handle(status(0, pit=IN_PIT, mode=PIT_MODE))  # second frame confirms
    assert [e.address for e in of_type(ev, PitEntry)] == [0]
    assert engine.state.cars[0].in_pit and engine.state.pit_lane
    assert engine.handle(status(0, pit=IN_PIT, mode=PIT_MODE)) == []
    clock.advance(3.3)
    assert engine.handle(status(0, fuel=[15] * 8, mode=PIT_MODE)) == []  # pending exit
    clock.advance(0.2)
    ev = engine.handle(status(0, fuel=[15] * 8, mode=PIT_MODE))
    out = of_type(ev, PitExit)
    # Measured between the first frame of the pit state and the first frame of the exit.
    assert len(out) == 1 and out[0].duration_ms == 3500 and out[0].fuel == 15
    cs = engine.state.cars[0]
    assert not cs.in_pit and cs.pit_stops == 1


def test_single_frame_pit_blip_is_ignored():
    engine, clock = _pit_setup()
    assert engine.handle(status(0, pit=IN_PIT, mode=PIT_MODE)) == []
    clock.advance(0.2)
    assert engine.handle(status(0, mode=PIT_MODE)) == []
    clock.advance(0.2)
    assert engine.handle(status(0, mode=PIT_MODE)) == []
    assert not engine.state.cars[0].in_pit and engine.state.cars[0].pit_stops == 0
    # The same blip while in the pit does not produce a phantom exit/entry either.
    engine.handle(status(0, pit=IN_PIT, mode=PIT_MODE))
    clock.advance(0.2)
    engine.handle(status(0, pit=IN_PIT, mode=PIT_MODE))
    assert engine.state.cars[0].in_pit
    clock.advance(1)
    assert engine.handle(status(0, mode=PIT_MODE)) == []  # one frame out of the pit
    clock.advance(0.2)
    assert engine.handle(status(0, pit=IN_PIT, mode=PIT_MODE)) == []
    cs = engine.state.cars[0]
    assert cs.in_pit and cs.pit_stops == 1


def test_low_fuel_once_and_rearmed():
    engine, _ = make(RaceConfig(low_fuel_threshold=3))
    go(engine)
    cross(engine, 0, 1000)
    mode = MODE_FUEL
    assert engine.handle(status(0, fuel=[5] + [15] * 7, mode=mode)) == []
    ev = engine.handle(status(0, fuel=[3] + [15] * 7, mode=mode))
    low = of_type(ev, LowFuel)
    assert len(low) == 1 and low[0].address == 0 and low[0].fuel == 3
    assert of_type(engine.handle(status(0, fuel=[2] + [15] * 7, mode=mode)), LowFuel) == []
    engine.handle(status(0, fuel=[15] * 8, mode=mode))  # refuel re-arms
    assert of_type(engine.handle(status(0, fuel=[1] + [15] * 7, mode=mode)), LowFuel)
    assert engine.state.cars[0].fuel == 1 and engine.state.fuel_mode


def test_absent_cars_have_no_fuel_and_no_low_fuel():
    engine, _ = make(RaceConfig(low_fuel_threshold=3))
    go(engine)
    cross(engine, 0, 1000)
    mode = MODE_FUEL | MODE_PIT_LANE
    # Slots 1..7 are empty: the CU reports fuel 0 (and could report pit) for them.
    ev = engine.handle(status(0, fuel=[15] + [0] * 7, pit=[False] + [True] * 7, mode=mode))
    assert ev == []
    cars = {c.address: c for c in engine.state.cars}
    assert cars[0].fuel == 15
    for address in range(1, 6):
        assert cars[address].fuel is None
        assert not cars[address].in_pit and cars[address].pit_stops == 0
    # Once the car shows up its fuel is tracked normally.
    cross(engine, 1, 1500)
    ev = engine.handle(status(0, fuel=[15, 2] + [0] * 6, mode=mode))
    assert [e.address for e in of_type(ev, LowFuel)] == [1]


def test_fuel_ignored_without_fuel_mode():
    engine, _ = make()
    go(engine)
    cross(engine, 0, 1000)
    assert engine.handle(status(0, fuel=[0] * 8, mode=0)) == []
    assert engine.state.cars[0].fuel is None and not engine.state.fuel_mode


# ---------------------------------------------------------------- finishing


def test_laps_race_finishes_and_marks_cars_finished():
    engine, _ = make(RaceConfig(mode=RaceMode.LAPS, target_laps=2))
    go(engine)
    cross(engine, 0, 1000)
    cross(engine, 1, 1500)
    cross(engine, 0, 8000)
    cross(engine, 1, 9000)
    assert engine.state.remaining_laps == 1
    ev = cross(engine, 0, 15_000)  # leader finishes
    assert of_type(ev, RaceFinished) == []
    assert engine.state.cars[0].finished and not engine.state.cars[1].finished
    ev = cross(engine, 1, 16_500)  # last runner finishes -> race over
    fin = of_type(ev, RaceFinished)
    assert len(fin) == 1 and fin[0].winner == 0 and fin[0].order == [0, 1]
    assert engine.state.phase is RacePhase.FINISHED
    assert engine.state.remaining_laps == 0
    assert cross(engine, 0, 22_000) == []  # ignored after finish


def test_laps_race_grace_timeout_finishes_with_straggler():
    engine, clock = make(RaceConfig(mode=RaceMode.LAPS, target_laps=2))
    go(engine)
    cross(engine, 0, 1000)
    cross(engine, 1, 1500)
    cross(engine, 0, 8000)
    cross(engine, 1, 9000)
    ev = cross(engine, 0, 15_000)
    assert of_type(ev, RaceFinished) == []
    clock.advance(1)
    assert engine.tick() == []
    clock.advance(20)  # well past 1.25x the slowest best lap
    ev = engine.tick()
    assert len(of_type(ev, RaceFinished)) == 1
    assert engine.state.phase is RacePhase.FINISHED


def test_timed_race_finishes_via_crossings():
    engine, clock = make(RaceConfig(mode=RaceMode.TIMED, duration_s=10))
    go(engine)
    cross(engine, 0, 1000)
    clock.advance(0.5)
    cross(engine, 0, 8000)
    assert 2000 <= engine.state.remaining_ms <= 3000  # CU time 7000 of 10000 (+ host drift)
    ev = cross(engine, 0, 15_000)  # race time 14000 >= 10000: last lap, finishes
    assert len(of_type(ev, RaceFinished)) == 1
    assert engine.state.cars[0].finished


def test_timed_race_ends_on_tick():
    engine, clock = make(RaceConfig(mode=RaceMode.TIMED, duration_s=10))
    go(engine)
    cross(engine, 0, 1000)
    cross(engine, 1, 1200)
    clock.advance(11)
    assert engine.tick() == []  # time is up, cars still have to cross the line
    assert engine.state.remaining_ms == 0
    cross(engine, 0, 9000)
    ev = cross(engine, 1, 9200)
    assert len(of_type(ev, RaceFinished)) == 1


def test_practice_never_finishes_but_stop_does():
    engine, clock = make(RaceConfig(mode=RaceMode.PRACTICE, idle_after_s=5000))
    go(engine)
    cross(engine, 0, 1000)
    for i in range(1, 30):
        assert of_type(cross(engine, 0, 1000 + i * 7000), RaceFinished) == []
    clock.advance(10_000)
    assert of_type(engine.tick(), RaceFinished) == []
    ev = engine.stop()
    assert len(of_type(ev, RaceFinished)) == 1 and ev[0].winner == 0
    assert engine.state.phase is RacePhase.FINISHED
    assert engine.stop() == []


def test_reset_returns_to_idle():
    engine, _ = make()
    go(engine)
    cross(engine, 0, 1000)
    engine.reset()
    st = engine.state
    assert st.phase is RacePhase.IDLE and all(c.position is None for c in st.cars)
    assert engine.laps == []


# ---------------------------------------------------------------- idle


def test_idle_emitted_once_per_idle_period():
    engine, clock = make(RaceConfig(idle_after_s=30))
    go(engine)
    cross(engine, 0, 1000)
    clock.advance(10)
    assert engine.tick() == []
    clock.advance(25)
    ev = engine.tick()
    assert len(of_type(ev, Idle)) == 1 and ev[0].seconds >= 30
    clock.advance(30)
    assert engine.tick() == []  # once per period
    cross(engine, 0, 8000)  # a crossing re-arms
    clock.advance(31)
    assert len(of_type(engine.tick(), Idle)) == 1


def test_no_idle_in_phase_idle_or_paused():
    engine, clock = make(RaceConfig(idle_after_s=5))
    clock.advance(100)
    assert engine.tick() == []
    go(engine)
    engine.set_paused(True)
    clock.advance(100)
    assert engine.tick() == []


# ---------------------------------------------------------------- clock anchoring


def test_clock_anchoring_with_buffered_timers():
    engine, clock = make()
    go(engine)
    clock.advance(2.0)  # first poll answers late: crossing happened in the buffer
    cross(engine, 0, 5_000_000)  # anchors origin: this timer is race_time 2000
    assert engine.state.race_time_ms == 2000
    clock.advance(4.0)
    # Poll arrives 4 s late; lap time and race time come from CU timestamps only
    ev = cross(engine, 0, 5_007_300)
    lap = of_type(ev, LapCompleted)[0]
    assert lap.lap_ms == 7300
    assert lap.race_time_ms == 9300  # CU based, not host (6000)
    cross(engine, 1, 5_000_500)
    ev = cross(engine, 1, 5_008_000)
    assert of_type(ev, LapCompleted)[0].lap_ms == 7500
    cs = {c.address: c for c in engine.state.cars}
    assert cs[1].gap_to_leader_ms == 700  # 8000 - 7300 on CU time


def test_race_time_never_decreases():
    engine, clock = make()
    go(engine)
    seen = [engine.state.race_time_ms]
    clock.advance(1.0)
    engine.tick()
    seen.append(engine.state.race_time_ms)
    clock.advance(8.0)
    seen.append(engine.state.race_time_ms)
    cross(engine, 0, 1_000_000)  # anchored at host elapsed (9000)
    seen.append(engine.state.race_time_ms)
    cross(engine, 1, 999_000)  # crossing older than the anchor: clamped, no regression
    seen.append(engine.state.race_time_ms)
    clock.advance(0.5)
    seen.append(engine.state.race_time_ms)
    cross(engine, 0, 1_000_200)
    seen.append(engine.state.race_time_ms)
    assert seen == sorted(seen)
    assert seen[-1] >= 9000


def test_race_time_extrapolates_between_crossings():
    engine, clock = make()
    go(engine)
    cross(engine, 0, 7_000)
    t0 = engine.state.race_time_ms
    clock.advance(3.0)
    assert engine.state.race_time_ms == t0 + 3000


def _two_car_laps(engine: RaceEngine, clock: FakeClock) -> None:
    """Cars 0 and 1 cross at race 0 / 500 ms (CU 1000 / 1500), then lap in 6000 ms each."""
    cross(engine, 0, 1000)  # anchors cu_origin = 1000 at race 0
    clock.advance(0.5)
    cross(engine, 1, 1500)
    clock.advance(5.5)
    assert [e.lap_ms for e in of_type(cross(engine, 0, 7000), LapCompleted)] == [6000]
    clock.advance(0.5)
    assert [e.lap_ms for e in of_type(cross(engine, 1, 7500), LapCompleted)] == [6000]
    assert engine.state.race_time_ms == 6500


def test_resync_clock_same_domain_keeps_every_lap():
    # Plain link drop: the CU kept running, its timestamps continue in the same domain.
    engine, clock = make()
    go(engine)
    _two_car_laps(engine, clock)
    seen = [engine.state.race_time_ms]
    engine.resync_clock()
    clock.advance(5.5)
    seen.append(engine.state.race_time_ms)
    laps = of_type(cross(engine, 0, 13_000), LapCompleted)
    assert [(e.lap_ms, e.lap_number, e.race_time_ms) for e in laps] == [(6000, 2, 12_000)]
    seen.append(engine.state.race_time_ms)
    clock.advance(0.6)
    laps = of_type(cross(engine, 1, 13_600), LapCompleted)
    assert [(e.lap_ms, e.lap_number, e.race_time_ms) for e in laps] == [(6100, 2, 12_600)]
    seen.append(engine.state.race_time_ms)
    cars = {c.address: c for c in engine.state.cars}
    assert cars[0].laps == 2 and cars[1].laps == 2
    assert cars[0].lap_times == [6000, 6000] and cars[1].lap_times == [6000, 6100]
    assert [lap.lap_ms for lap in engine.laps] == [6000, 6000, 6000, 6100]
    assert seen == sorted(seen) and seen[-1] == 12_600


def test_resync_clock_same_domain_after_long_drop_and_with_buffered_timer():
    engine, clock = make()
    go(engine)
    _two_car_laps(engine, clock)
    engine.resync_clock()
    clock.advance(90)  # the link was down for 1.5 minutes, the clock kept extrapolating
    # The first Timer after reconnect is an old buffered crossing (car 1, sector 2).
    assert cross(engine, 1, 50_000, sector=2) == []
    laps = of_type(cross(engine, 0, 97_000), LapCompleted)
    assert [(e.lap_ms, e.race_time_ms) for e in laps] == [(90_000, 96_000)]
    clock.advance(6)
    laps = of_type(cross(engine, 1, 103_500), LapCompleted)
    assert [(e.lap_ms, e.race_time_ms) for e in laps] == [(96_000, 102_500)]


def test_resync_clock_same_domain_across_32bit_wraparound():
    engine, clock = make()
    go(engine)
    near_wrap = TIMESTAMP_MODULO - 3000
    cross(engine, 0, near_wrap)  # cu_origin just below 2**32
    clock.advance(6)
    assert [e.lap_ms for e in of_type(cross(engine, 0, 3000), LapCompleted)] == [6000]
    engine.resync_clock()
    clock.advance(6)
    laps = of_type(cross(engine, 0, 9000), LapCompleted)  # still the same (wrapped) domain
    assert [(e.lap_ms, e.race_time_ms) for e in laps] == [(6000, 12_000)]


def test_resync_clock_power_cycle_reanchors_every_car_once():
    engine, clock = make()
    go(engine)
    _two_car_laps(engine, clock)
    seen = [engine.state.race_time_ms]
    # The CU was power-cycled: its clock restarts near 0 in a new domain. ts 300 is a
    # small backward jump from cu_origin (1000): ts_diff wraps to ~2**32, i.e. not intact.
    engine.resync_clock()
    clock.advance(6)
    assert cross(engine, 0, 300) == []  # new reference, not a (bogus) lap
    seen.append(engine.state.race_time_ms)
    assert seen[-1] == 12_500
    clock.advance(1)
    assert cross(engine, 1, 1300) == []  # car 1 crosses later: re-anchored too, no lap
    seen.append(engine.state.race_time_ms)
    cars = {c.address: c for c in engine.state.cars}
    assert cars[0].laps == 1 and cars[1].laps == 1
    clock.advance(5)
    laps = of_type(cross(engine, 0, 6300), LapCompleted)
    assert [(e.lap_ms, e.lap_number, e.race_time_ms) for e in laps] == [(6000, 2, 18_500)]
    seen.append(engine.state.race_time_ms)
    clock.advance(1)
    laps = of_type(cross(engine, 1, 7300), LapCompleted)
    assert [(e.lap_ms, e.lap_number, e.race_time_ms) for e in laps] == [(6000, 2, 19_500)]
    seen.append(engine.state.race_time_ms)
    assert [lap.lap_ms for lap in engine.laps] == [6000, 6000, 6000, 6000]
    race_times = [lap.race_time_ms for lap in engine.laps]
    assert race_times == sorted(race_times)
    assert seen == sorted(seen)


def test_resync_clock_power_cycle_detected_by_a_non_lap_timer():
    # The first Timer after the power-cycle is a pace-car pass: every car re-anchors later.
    engine, clock = make()
    go(engine)
    _two_car_laps(engine, clock)
    engine.resync_clock()
    clock.advance(1)
    assert cross(engine, 7, 200) == []
    clock.advance(1)
    assert cross(engine, 0, 1200) == []
    assert cross(engine, 1, 1700) == []
    clock.advance(6)
    assert [e.lap_ms for e in of_type(cross(engine, 0, 7200), LapCompleted)] == [6000]
    assert [e.lap_ms for e in of_type(cross(engine, 1, 7700), LapCompleted)] == [6000]


def test_resync_clock_power_cycle_anchors_on_the_cu_synced_clock():
    # The CU runs ahead of the host clock: the re-anchor must use the CU-synced race clock,
    # not raw host time since go (which would move lap race times backwards).
    engine, clock = make()
    go(engine)
    cross(engine, 0, 1000)
    clock.advance(6)
    cross(engine, 0, 9000)  # CU says 8000 ms, the host only 6000
    assert engine.state.race_time_ms == 8000
    engine.resync_clock()
    clock.advance(1)
    assert cross(engine, 0, 100) == []  # power-cycle: re-anchored at race 9000
    assert engine.state.race_time_ms == 9000
    clock.advance(6)
    laps = of_type(cross(engine, 0, 6100), LapCompleted)
    assert [(e.lap_ms, e.race_time_ms) for e in laps] == [(6000, 15_000)]


def test_resync_clock_before_any_timer_is_a_noop():
    engine, clock = make()
    go(engine)
    engine.resync_clock()
    clock.advance(2)
    assert cross(engine, 0, 5000) == []  # ordinary start pass, anchored at host elapsed
    assert engine.state.race_time_ms == 2000
    clock.advance(6)
    laps = of_type(cross(engine, 0, 11_000), LapCompleted)
    assert [(e.lap_ms, e.race_time_ms) for e in laps] == [(6000, 8000)]
    clock.advance(6)
    laps = of_type(cross(engine, 0, 17_000), LapCompleted)
    assert [(e.lap_ms, e.race_time_ms) for e in laps] == [(6000, 14_000)]


def test_resync_clock_ignores_cars_that_never_crossed():
    engine, clock = make()
    go(engine)
    cross(engine, 0, 1000)
    engine.resync_clock()
    clock.advance(1)
    assert cross(engine, 1, 50) == []  # car 1's very first crossing: ordinary start pass
    clock.advance(6)
    assert of_type(cross(engine, 1, 6050), LapCompleted)
