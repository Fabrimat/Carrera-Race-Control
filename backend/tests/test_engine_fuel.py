"""Fuel strategy and mandatory pit stops (docs/PROTOCOL.md "Fuel strategy")."""

from __future__ import annotations

from app.race.models import (
    PitMissed,
    PitRules,
    RaceConfig,
    RaceFinished,
    RaceMode,
    RacePhase,
)
from app.track.base import MODE_FUEL, MODE_PIT_LANE
from tests.test_engine import cross, go, make, of_type, status

FUEL = MODE_FUEL | MODE_PIT_LANE
LAP = 10_000


def fuel_status(levels: dict[int, int], pit=(), start=0, mode=FUEL):
    fuel = [15] * 8
    for address, level in levels.items():
        fuel[address] = level
    pits = [a in pit for a in range(8)]
    return status(start, fuel=fuel, pit=pits, mode=mode)


def lap(engine, clock, address, n, level, mode=FUEL, others=None):
    """Car ``address`` crosses the line for the n-th time (n=0: start pass), then Status."""
    levels = {address: level, **(others or {})}
    if n > 0:  # the CU reports the level before the car reaches the line
        engine.handle(fuel_status(levels, mode=mode))
    cross(engine, address, 1000 + n * LAP)
    engine.handle(fuel_status(levels, mode=mode))


def car(engine, address=0):
    return next(c for c in engine.state.cars if c.address == address)


def start_race(config):
    engine, clock = make(config)
    go(engine, config)
    return engine, clock


def in_pit(engine, clock, address, levels):
    """Two frames with the pit flag set (debounce), then two without."""
    pit_frames = [fuel_status(levels, pit=(address,)) for _ in range(2)]
    for frame in pit_frames:
        clock.advance(0.2)
        engine.handle(frame)


def out_of_pit(engine, clock, levels):
    for _ in range(2):
        clock.advance(0.2)
        engine.handle(fuel_status(levels))


# ---------------------------------------------------------------- fuel_laps


def test_fuel_laps_one_entry_per_lap_with_the_level_at_lap_end():
    engine, clock = start_race(RaceConfig(mode=RaceMode.LAPS, target_laps=20))
    lap(engine, clock, 0, 0, 15)
    for n, level in enumerate([14, 14, 13, 12], start=1):
        lap(engine, clock, 0, n, level)
    cs = car(engine)
    assert cs.laps == 4
    assert cs.fuel_laps == [14, 14, 13, 12]
    assert len(cs.fuel_laps) == cs.laps


def test_fuel_laps_null_when_level_unknown_and_empty_without_fuel_mode():
    engine, clock = start_race(RaceConfig(mode=RaceMode.LAPS, target_laps=20))
    cross(engine, 0, 1000)
    engine.handle(status(0, mode=0))  # no fuel mode: level unknown
    cross(engine, 0, 1000 + LAP)
    engine.handle(status(0, mode=0))
    cs = car(engine)
    assert cs.laps == 1 and cs.fuel_laps == [] and cs.fuel_strategy is None
    # the length invariant holds once fuel mode comes on again
    cross(engine, 0, 1000 + 2 * LAP)
    engine.handle(fuel_status({0: 13}))
    cross(engine, 0, 1000 + 3 * LAP)
    engine.handle(fuel_status({0: 12}))
    cs = car(engine)
    assert cs.laps == 3 and cs.fuel_laps == [None, None, 13]


# ---------------------------------------------------------------- per lap / laps left


def test_per_lap_needs_two_laps_and_a_level_drop():
    engine, clock = start_race(RaceConfig(mode=RaceMode.LAPS, target_laps=20))
    lap(engine, clock, 0, 0, 15)
    assert car(engine).fuel_strategy.per_lap is None
    lap(engine, clock, 0, 1, 15)  # one lap, no drop
    assert car(engine).fuel_strategy.per_lap is None
    lap(engine, clock, 0, 2, 15)  # two laps but no level drop yet
    fs = car(engine).fuel_strategy
    assert fs.per_lap is None and fs.laps_left is None and not fs.must_pit
    lap(engine, clock, 0, 3, 13)  # 2 levels over 3 laps
    fs = car(engine).fuel_strategy
    assert fs.per_lap == 2 / 3
    assert fs.laps_left == 13 / (2 / 3)


def test_stint_rate_is_kept_after_a_pit_and_replaced_by_the_new_stint():
    engine, clock = start_race(RaceConfig(mode=RaceMode.LAPS, target_laps=40))
    lap(engine, clock, 0, 0, 15)
    lap(engine, clock, 0, 1, 14)
    lap(engine, clock, 0, 2, 13)
    assert car(engine).fuel_strategy.per_lap == 1.0
    in_pit(engine, clock, 0, {0: 13})
    assert car(engine).in_pit
    assert car(engine).fuel_strategy.per_lap == 1.0  # frozen while in the pit
    out_of_pit(engine, clock, {0: 15})
    cs = car(engine)
    assert not cs.in_pit and cs.pit_stops == 1
    assert cs.fuel_strategy.per_lap == 1.0  # carried over: new stint has no laps yet
    lap(engine, clock, 0, 3, 15)  # one lap into the new stint: still carried over
    assert car(engine).fuel_strategy.per_lap == 1.0
    lap(engine, clock, 0, 4, 14)
    lap(engine, clock, 0, 5, 13)  # the stint began at 15: 2 levels over 3 laps
    fs = car(engine).fuel_strategy
    assert fs.per_lap == 2 / 3
    assert fs.laps_left == 13 / (2 / 3)


def test_levels_are_quantised_so_the_rate_is_an_average():
    engine, clock = start_race(RaceConfig(mode=RaceMode.LAPS, target_laps=40))
    lap(engine, clock, 0, 0, 15)
    for n, level in enumerate([15, 14, 14, 13], start=1):
        lap(engine, clock, 0, n, level)
    assert car(engine).fuel_strategy.per_lap == 0.5  # 2 levels / 4 laps


# ---------------------------------------------------------------- laps to go / must pit


def test_laps_mode_laps_to_go_is_leader_based_incl_a_lapped_car():
    engine, clock = start_race(RaceConfig(mode=RaceMode.LAPS, target_laps=10))
    lap(engine, clock, 0, 0, 15)
    lap(engine, clock, 1, 0, 15)
    for n in range(1, 5):  # car 0 does 4 laps, car 1 stays at 0 (lapped)
        lap(engine, clock, 0, n, 15 - n)
    assert car(engine, 0).fuel_strategy.laps_to_go == 6
    assert car(engine, 1).fuel_strategy.laps_to_go == 6  # leader-based, even for the lapped car


def test_must_pit_and_pit_by_lap():
    engine, clock = start_race(RaceConfig(mode=RaceMode.LAPS, target_laps=10))
    lap(engine, clock, 0, 0, 15)
    lap(engine, clock, 0, 1, 12)
    lap(engine, clock, 0, 2, 9)  # 3 levels / lap, 9 left: 3 laps; 7 laps to go
    fs = car(engine).fuel_strategy
    assert fs.per_lap == 3.0 and fs.laps_left == 3.0 and fs.laps_to_go == 8
    assert fs.must_pit and fs.pit_by_lap == 2 + 3


def test_must_pit_false_when_it_can_finish_and_false_in_the_pit():
    engine, clock = start_race(RaceConfig(mode=RaceMode.LAPS, target_laps=5))
    lap(engine, clock, 0, 0, 15)
    lap(engine, clock, 0, 1, 14)
    lap(engine, clock, 0, 2, 13)
    assert not car(engine).fuel_strategy.must_pit  # 13 laps of fuel for 2 to go
    engine2, clock2 = start_race(RaceConfig(mode=RaceMode.LAPS, target_laps=10))
    lap(engine2, clock2, 0, 0, 15)
    lap(engine2, clock2, 0, 1, 11)
    lap(engine2, clock2, 0, 2, 7)
    assert car(engine2).fuel_strategy.must_pit
    in_pit(engine2, clock2, 0, {0: 7})
    fs = car(engine2).fuel_strategy
    assert car(engine2).in_pit and not fs.must_pit and fs.pit_by_lap is None


def test_timed_mode_laps_to_go_from_remaining_time_and_average_lap():
    engine, clock = start_race(RaceConfig(mode=RaceMode.TIMED, duration_s=100))
    lap(engine, clock, 0, 0, 15)
    assert car(engine).fuel_strategy.laps_to_go is None  # no average lap yet
    lap(engine, clock, 0, 1, 14)
    lap(engine, clock, 0, 2, 13)
    # race time 20 s, 80 s left, 10 s average lap
    assert car(engine).fuel_strategy.laps_to_go == 8
    assert car(engine).fuel_strategy.laps_left == 13.0


def test_practice_has_no_laps_to_go_and_never_must_pit():
    engine, clock = start_race(RaceConfig(mode=RaceMode.PRACTICE))
    lap(engine, clock, 0, 0, 15)
    lap(engine, clock, 0, 1, 12)
    lap(engine, clock, 0, 2, 9)
    fs = car(engine).fuel_strategy
    assert fs.per_lap == 3.0 and fs.laps_left == 3.0
    assert fs.laps_to_go is None and not fs.must_pit and fs.pit_by_lap is None


def test_laps_to_go_is_zero_while_finishing():
    engine, clock = start_race(RaceConfig(mode=RaceMode.LAPS, target_laps=3))
    lap(engine, clock, 0, 0, 15)
    lap(engine, clock, 1, 0, 15)
    lap(engine, clock, 0, 1, 12)
    lap(engine, clock, 0, 2, 9)
    lap(engine, clock, 0, 3, 6)  # leader finishes: finishing
    assert car(engine, 1).fuel_strategy.laps_to_go == 0
    assert not car(engine, 1).fuel_strategy.must_pit


# ---------------------------------------------------------------- strategy availability


def test_strategy_null_without_fuel_mode_and_when_it_turns_off():
    engine, clock = start_race(RaceConfig(mode=RaceMode.LAPS, target_laps=20))
    cross(engine, 0, 1000)
    engine.handle(status(0, mode=0))
    assert car(engine).fuel_strategy is None and car(engine).fuel_laps == []
    lap(engine, clock, 0, 1, 14)
    lap(engine, clock, 0, 2, 13)
    assert car(engine).fuel_strategy is not None and car(engine).fuel_laps
    engine.handle(status(0, mode=0))  # fuel mode off mid-race
    assert car(engine).fuel_strategy is None and car(engine).fuel_laps == []


# ---------------------------------------------------------------- mandatory pit stops


def finish_laps_race(engine, clock, pit_stops_for=()):
    """Two cars, car 0 finishes first. Returns the events of the last crossing."""
    lap(engine, clock, 0, 0, 15)
    lap(engine, clock, 1, 0, 15)
    events = []
    for n in range(1, 4):
        cross(engine, 1, 1000 + n * LAP + 100)
        events = cross(engine, 0, 1000 + n * LAP)
    return events


def test_missed_pit_penalty_changes_order_winner_and_classification():
    config = RaceConfig(
        mode=RaceMode.LAPS, target_laps=3, pits=PitRules(min_stops=1, missed_penalty_s=30)
    )
    engine, clock = start_race(config)
    lap(engine, clock, 0, 0, 15)
    lap(engine, clock, 1, 0, 15)
    # car 1 makes its stop, car 0 does not
    in_pit(engine, clock, 1, {1: 4})
    out_of_pit(engine, clock, {1: 15})
    cross(engine, 1, 1000 + LAP + 3000)
    cross(engine, 0, 1000 + LAP)
    cross(engine, 1, 1000 + 2 * LAP + 3000)
    cross(engine, 0, 1000 + 2 * LAP)
    events = cross(engine, 1, 1000 + 3 * LAP + 3000)
    events += cross(engine, 0, 1000 + 3 * LAP)
    missed = of_type(events, PitMissed)
    assert [(m.address, m.stops, m.required, m.penalty_ms) for m in missed] == [(0, 0, 1, 30_000)]
    finished = of_type(events, RaceFinished)[0]
    assert finished.order == [1, 0] and finished.winner == 1  # car 0 was ahead on the road
    assert events.index(missed[0]) < events.index(finished)
    assert engine.state.phase is RacePhase.FINISHED
    assert car(engine, 0).penalty_ms == 30_000
    assert [c.address for c in engine.state.cars][:2] == [1, 0]


def test_penalty_is_per_missing_stop():
    config = RaceConfig(
        mode=RaceMode.LAPS, target_laps=5, pits=PitRules(min_stops=3, missed_penalty_s=10)
    )
    engine, clock = start_race(config)
    lap(engine, clock, 0, 0, 15)
    in_pit(engine, clock, 0, {0: 15})
    out_of_pit(engine, clock, {0: 15})
    events = engine.stop()
    missed = of_type(events, PitMissed)
    assert len(missed) == 1
    assert missed[0].stops == 1 and missed[0].required == 3 and missed[0].penalty_ms == 20_000


def test_penalty_on_stop_in_laps_and_timed_but_not_practice():
    for mode, expected in ((RaceMode.LAPS, 1), (RaceMode.TIMED, 1), (RaceMode.PRACTICE, 0)):
        config = RaceConfig(mode=mode, pits=PitRules(min_stops=1, missed_penalty_s=30))
        engine, clock = start_race(config)
        lap(engine, clock, 0, 0, 15)
        events = engine.stop()
        assert len(of_type(events, PitMissed)) == expected, mode
        assert car(engine).penalty_ms == expected * 30_000


def test_no_penalty_when_min_stops_is_zero_or_the_stop_was_made():
    engine, clock = start_race(RaceConfig(mode=RaceMode.LAPS, target_laps=3))
    lap(engine, clock, 0, 0, 15)
    assert of_type(engine.stop(), PitMissed) == []
    config = RaceConfig(mode=RaceMode.LAPS, pits=PitRules(min_stops=1))
    engine, clock = start_race(config)
    lap(engine, clock, 0, 0, 15)
    in_pit(engine, clock, 0, {0: 15})
    assert of_type(engine.stop(), PitMissed) == []


def test_pit_rules_come_from_the_config_given_to_prepare():
    """A session override reaches the engine through the config of ``prepare``."""
    engine, clock = make(RaceConfig(mode=RaceMode.LAPS))
    go(engine, RaceConfig(mode=RaceMode.LAPS, pits=PitRules(min_stops=2, missed_penalty_s=5)))
    lap(engine, clock, 0, 0, 15)
    missed = of_type(engine.stop(), PitMissed)
    assert missed[0].penalty_ms == 10_000
