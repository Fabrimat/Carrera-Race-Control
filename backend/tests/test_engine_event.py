"""Engine semantics for event mode: false start inference, penalties and qualifying order."""

from __future__ import annotations

import pytest

from app.race.models import (
    FalseStart,
    FalseStartRule,
    RaceConfig,
    RaceFinished,
    RaceMode,
    RacePhase,
    RaceStarted,
)
from tests.test_engine import cross, make, of_type, status


def countdown_with_jump(engine, rule, *, light: int = 3, address: int = 1, bad: int = 8):
    """prepare + lights up to ``light``, car ``address`` crosses, then the CU reports ``bad``."""
    engine.set_session_rules(false_start=rule)
    engine.prepare(RaceConfig(mode=RaceMode.LAPS, target_laps=2))
    for value in range(1, light + 1):
        engine.handle(status(value))
    assert cross(engine, address, 500) == []
    return engine.handle(status(bad))


@pytest.mark.parametrize("light", [2, 3, 4, 5, 6])
@pytest.mark.parametrize("bad", [8, 9])
def test_crossing_during_lights_2_to_6_is_the_candidate(light, bad):
    engine, _ = make()
    events = countdown_with_jump(engine, FalseStartRule(action="warn"), light=light, bad=bad)
    assert events == [FalseStart(address=1, action="warn", at=events[0].at)]
    assert engine.phase is RacePhase.STARTING


def test_crossing_at_light_1_is_ignored():
    engine, _ = make()
    engine.set_session_rules(false_start=FalseStartRule(action="warn"))
    engine.prepare(RaceConfig())
    engine.handle(status(1))
    cross(engine, 2, 500)  # cars being placed on the line
    engine.handle(status(2))
    events = of_type(engine.handle(status(9)), FalseStart)
    assert len(events) == 1 and events[0].address is None


def test_first_crossing_car_is_the_candidate():
    engine, _ = make()
    engine.set_session_rules(false_start=FalseStartRule(action="warn"))
    engine.prepare(RaceConfig())
    engine.handle(status(1))
    engine.handle(status(4))
    cross(engine, 3, 500)
    cross(engine, 0, 600)
    assert of_type(engine.handle(status(8)), FalseStart)[0].address == 3


def test_ignore_emits_nothing():
    engine, _ = make()
    assert countdown_with_jump(engine, FalseStartRule(action="ignore")) == []


def test_no_session_rules_emit_nothing():
    engine, _ = make()
    assert countdown_with_jump(engine, None) == []


def test_false_start_is_reported_once_per_abort_not_per_frame():
    engine, _ = make()
    events = countdown_with_jump(engine, FalseStartRule(action="warn"))
    assert len(events) == 1
    for _ in range(4):  # the CU keeps reporting 8 for a while
        assert engine.handle(status(8)) == []
    engine.handle(status(9))  # still the same abort (8 -> 9)
    assert of_type(engine.handle(status(9)), FalseStart) == []


def test_restart_action_event_and_new_sequence_runs():
    engine, _ = make()
    events = countdown_with_jump(engine, FalseStartRule(action="restart"))
    assert [(e.address, e.action) for e in events] == [(1, "restart")]
    # The controller presses START: the sequence runs again and the race starts.
    for value in (1, 2, 3, 4, 5, 6):
        engine.handle(status(value))
    assert of_type(engine.handle(status(7)), RaceStarted)


def test_second_false_start_has_its_own_candidate():
    engine, _ = make()
    countdown_with_jump(engine, FalseStartRule(action="warn"), address=1)
    engine.handle(status(1))
    engine.handle(status(2))
    events = of_type(engine.handle(status(9)), FalseStart)
    assert events[0].address is None  # candidate consumed by the first abort


def test_penalty_adds_to_candidate_and_shows_in_state():
    engine, _ = make()
    events = countdown_with_jump(engine, FalseStartRule(action="penalty", penalty_s=5))
    assert [(e.address, e.action, e.penalty_ms) for e in events] == [(1, "penalty", 5000)]
    car = next(c for c in engine.state.cars if c.address == 1)
    assert car.penalty_ms == 5000


def test_penalty_without_candidate_is_a_warning():
    engine, _ = make()
    engine.set_session_rules(false_start=FalseStartRule(action="penalty", penalty_s=5))
    engine.prepare(RaceConfig())
    engine.handle(status(1))
    engine.handle(status(2))
    events = of_type(engine.handle(status(8)), FalseStart)
    assert [(e.address, e.action, e.penalty_ms) for e in events] == [(None, "warn", 0)]
    assert all(c.penalty_ms == 0 for c in engine.state.cars)


def _race_after_penalty(clock, engine):
    """Car 1 got 5 s; car 1 leads on the road by 1 s at every crossing."""
    for value in (1, 2, 3, 4, 5, 6):
        engine.handle(status(value))
    engine.handle(status(7))
    clock.advance(0.1)
    cross(engine, 1, 1000)
    cross(engine, 0, 2000)
    clock.advance(7)
    cross(engine, 1, 7000)
    return cross(engine, 0, 8000)


def test_penalty_affects_order_gaps_and_winner():
    engine, clock = make()
    countdown_with_jump(engine, FalseStartRule(action="penalty", penalty_s=5), address=1)
    _race_after_penalty(clock, engine)
    state = engine.state
    order = [c.address for c in state.cars if c.position is not None]
    assert order[:2] == [0, 1]  # car 1 is a second ahead on the road but has +5 s
    second = state.cars[1]
    assert second.address == 1 and second.gap_to_leader_ms == 4000
    clock.advance(7)
    cross(engine, 1, 13000)
    events = cross(engine, 0, 14000)  # both reach 2 laps
    finished = of_type(events, RaceFinished)
    assert finished and finished[0].winner == 0 and finished[0].order[:2] == [0, 1]


def test_penalty_cleared_by_a_new_race():
    engine, _ = make()
    countdown_with_jump(engine, FalseStartRule(action="penalty", penalty_s=5))
    engine.prepare(RaceConfig())
    assert all(c.penalty_ms == 0 for c in engine.state.cars)


def test_qualifying_order_by_best_lap_and_no_lap_cars_last():
    engine, clock = make()
    engine.set_session_rules(qualifying=True)
    engine.prepare(RaceConfig(mode=RaceMode.TIMED, duration_s=60))
    for value in (1, 2, 7):
        engine.handle(status(value))
    clock.advance(0.1)
    # car 0: many slow laps; car 1: one fast lap; car 2: only the start pass (no lap)
    cross(engine, 0, 1000)
    cross(engine, 1, 1100)
    cross(engine, 2, 1200)
    clock.advance(30)
    cross(engine, 0, 9000)  # 8000
    cross(engine, 0, 17000)  # 8000
    cross(engine, 1, 8100)  # 7000
    state = engine.state
    placed = [c for c in state.cars if c.position is not None]
    assert [c.address for c in placed] == [1, 0, 2]
    assert placed[1].gap_to_leader_ms == 1000
    assert placed[1].gap_to_leader_laps == 0
    assert placed[2].gap_to_leader_ms is None
    finished = engine.stop()
    assert finished[0].winner == 1 and finished[0].order == [1, 0, 2]


def test_rules_change_waits_for_the_next_race():
    engine, clock = make()
    engine.set_session_rules(qualifying=True)
    engine.prepare(RaceConfig(mode=RaceMode.TIMED, duration_s=60))
    for value in (1, 2, 7):
        engine.handle(status(value))
    clock.advance(0.1)
    cross(engine, 0, 1000)
    cross(engine, 1, 1100)
    clock.advance(30)
    cross(engine, 0, 9000)
    cross(engine, 0, 17000)
    cross(engine, 1, 8100)
    engine.stop()
    engine.set_session_rules()  # next session is a race: the finished order stays
    assert engine.qualifying is True
    assert [c.address for c in engine.state.cars if c.position][:2] == [1, 0]
    engine.prepare(RaceConfig())
    assert engine.qualifying is False
    engine.set_session_rules(qualifying=True)
    engine.reset()  # IDLE: applied right away
    assert engine.qualifying is True
    engine.set_session_rules()
    assert engine.qualifying is False
