"""Incident detection in the engine (docs/PROTOCOL.md "Roadmap wave 1" -> "Incidents")."""

from __future__ import annotations

import pytest

from app.race.engine import RaceEngine
from app.race.models import (
    IncidentCleared,
    IncidentRules,
    IncidentStarted,
    LapCompleted,
    RaceConfig,
    RaceFinished,
    RaceMode,
    RacePhase,
    default_cars,
)
from app.track.base import Timer
from tests.test_engine import FakeClock, of_type, status

LAP = 6000
OVERDUE = int(2.5 * LAP)  # default overdue_factor x expected lap = 15000
PIT = [True] + [False] * 7


class Rig:
    """A running engine whose host clock and CU timestamps move together (race ms = ``t``)."""

    def __init__(self, config: RaceConfig | None = None, sensors: list[int] | None = None):
        self.clock = FakeClock()
        self.engine = RaceEngine(default_cars(), config, clock=self.clock)
        if sensors:
            self.engine.set_declared_sensors(sensors)
        self.engine.prepare(self.engine.config)
        for light in (1, 2, 3, 4, 5, 6):
            self.engine.handle(status(light))
        self.engine.handle(status(7))
        self.t = 0
        self.last: dict[int, int] = {}

    def at(self, ms: int) -> None:
        assert ms >= self.t, (ms, self.t)
        self.clock.advance((ms - self.t) / 1000)
        self.t = ms

    def cross(self, address: int, ms: int | None = None, sector: int = 1):
        if ms is not None:
            self.at(ms)
        if sector == 1:
            self.last[address] = self.t
        return self.engine.handle(Timer(address, 1000 + self.t, sector))

    def tick(self, ms: int | None = None):
        if ms is not None:
            self.at(ms)
        return self.engine.tick()

    def run(self, until: int, movers: tuple[int, ...] = (1,), step: int = 500):
        """Advance to ``until`` ticking every ``step`` ms; ``movers`` cross the line every LAP.

        Returns the incident events only.
        """
        events = []
        while self.t < until:
            self.at(min(until, self.t + step))
            for address in movers:
                if self.t - self.last[address] >= LAP:
                    events += self.cross(address)
            events += self.engine.tick()
        return [e for e in events if isinstance(e, (IncidentStarted, IncidentCleared))]

    def car(self, address: int):
        return next(c for c in self.engine.state.cars if c.address == address)


def rules(**kw) -> RaceConfig:
    return RaceConfig(incidents=IncidentRules(**kw))


def two_cars(config: RaceConfig | None = None) -> Rig:
    """Cars 0 and 1 with a learned 6 s lap; both last crossed the line at t = 12000."""
    rig = Rig(config)
    for t in (0, 6000, 12000):
        rig.cross(0, t)
        rig.cross(1)
    return rig


def flagged(config: RaceConfig | None = None) -> Rig:
    """Car 0 stopped at t = 12000 and was flagged at t = 27001 (car 1 keeps going)."""
    rig = two_cars(config)
    rig.run(27000)
    assert of_type(rig.tick(27001), IncidentStarted)
    return rig


# ---------------------------------------------------------------- detection


def test_no_flag_without_estimate():
    rig = Rig()
    rig.cross(0, 0)
    rig.cross(1)
    assert of_type(rig.tick(120_000), IncidentStarted) == []  # no lap done: no expected time
    assert rig.car(0).incident is None


def test_flag_after_factor_times_expected():
    rig = two_cars()
    assert rig.run(27000) == []  # not strictly over yet
    [started] = of_type(rig.tick(27001), IncidentStarted)
    assert (started.address, started.source, started.count) == (0, "overdue", 1)
    assert (started.from_sensor, started.to_sensor) == (1, 1)
    assert started.race_time_ms == 27001 and started.penalty_ms == 0
    car = rig.car(0)
    assert car.incident is not None and car.incident.started_race_ms == 27001
    assert car.incident.source == "overdue" and car.incidents == 1
    assert rig.car(1).incident is None
    assert rig.run(40000) == []  # one open incident per car, no repeat


def test_not_flagged_in_pit():
    rig = two_cars()
    rig.engine.handle(status(pit=PIT))
    rig.engine.handle(status(pit=PIT))
    assert rig.car(0).in_pit
    assert rig.run(60000) == []


def test_not_flagged_when_finished():
    rig = two_cars()
    rig.engine._cars[0].finished = True
    assert rig.run(60000) == []


def test_pit_exit_restarts_the_watch():
    rig = two_cars()
    rig.engine.handle(status(pit=PIT))
    rig.engine.handle(status(pit=PIT))
    assert rig.run(52000) == []
    rig.engine.handle(status())
    rig.engine.handle(status())
    assert not rig.car(0).in_pit
    assert rig.run(52000 + OVERDUE) == []
    [started] = of_type(rig.tick(52000 + OVERDUE + 1), IncidentStarted)
    assert started.address == 0


def test_nothing_while_paused_and_no_flag_right_after_resume():
    rig = two_cars()
    rig.engine.set_paused(True)
    assert rig.engine.phase is RacePhase.PAUSED
    assert rig.run(60000) == []
    rig.engine.set_paused(False)
    assert rig.run(60000 + OVERDUE) == []
    [started] = of_type(rig.tick(60000 + OVERDUE + 1), IncidentStarted)
    assert started.address == 0


def test_resync_restarts_the_watch():
    rig = two_cars()
    assert rig.run(40000) != []  # car 0 would be flagged by now...
    rig = two_cars()
    rig.run(25000)
    rig.engine.resync_clock()
    assert rig.run(25000 + OVERDUE) == []
    assert of_type(rig.tick(25000 + OVERDUE + 1), IncidentStarted)


def test_all_cars_overdue_flags_none():
    rig = two_cars()
    assert rig.run(100_000, movers=()) == []
    assert rig.car(0).incident is None and rig.car(1).incident is None


def test_a_solo_car_is_flagged():
    rig = Rig()
    for t in (0, 6000, 12000):
        rig.cross(0, t)
    rig.run(12000 + OVERDUE, movers=())
    assert of_type(rig.tick(12000 + OVERDUE + 50), IncidentStarted)


def test_detect_false_disables_detection():
    rig = two_cars(rules(detect=False))
    assert rig.run(60000) == []


def test_overdue_factor_comes_from_the_config():
    rig = two_cars(rules(overdue_factor=1.5))
    assert rig.run(12000 + 9000) == []
    assert of_type(rig.tick(12000 + 9001), IncidentStarted)


def test_stretch_between_check_lanes_is_used():
    rig = Rig(sensors=[2, 3])
    for lap in (0, 6000, 12000):
        for address in (0, 1):
            rig.cross(address, lap if address == 0 else None)
        if lap == 12000:
            break
        for address in (0, 1):
            rig.cross(address, lap + 2000 if address == 0 else None, 2)
        for address in (0, 1):
            rig.cross(address, lap + 4000 if address == 0 else None, 3)
    # lap 3: car 0 reaches sensor 2 at 14000 and stops (stretch 2 > 3, expected 2000)
    rig.cross(0, 14000, 2)
    rig.cross(1, None, 2)
    events = rig.run(14000 + 5001, movers=())  # 2.5 x 2000 = 5000 late: both stopped
    assert events == []
    rig.cross(1, None, 3)  # car 1 moves on, car 0 does not
    [started] = of_type(rig.tick(), IncidentStarted)
    assert (started.address, started.from_sensor, started.to_sensor) == (0, 2, 3)


# ---------------------------------------------------------------- clearing


def test_clear_on_crossing_still_counts_the_lap():
    rig = flagged()
    events = rig.cross(0, 30000)
    [cleared] = of_type(events, IncidentCleared)
    assert (cleared.address, cleared.by, cleared.lost_ms) == (0, "crossing", 30000 - 27001)
    [lap] = of_type(events, LapCompleted)
    assert lap.lap_number == 3 and lap.lap_ms == 18000
    assert events.index(cleared) < events.index(lap)
    car = rig.car(0)
    assert car.incident is None and car.laps == 3
    assert (car.incidents, car.incident_lost_ms) == (1, 30000 - 27001)


def test_after_a_crossing_the_car_is_watched_again():
    rig = flagged()
    rig.cross(0, 30000)
    # the 18 s incident lap is an outlier (> 1.8 x the estimate): the threshold stays 15 s
    limit = OVERDUE
    assert rig.car(0).segment_estimates["1>1"] == LAP
    rig.run(30000 + limit)
    [started] = of_type(rig.tick(30000 + limit + 50), IncidentStarted)
    assert (started.address, started.count) == (0, 2)


def test_clear_on_a_check_lane_crossing():
    rig = Rig(sensors=[2])
    for lap in (0, 6000, 12000):
        for address in (0, 1):
            rig.cross(address, lap if address == 0 else None)
        if lap == 12000:
            break
        for address in (0, 1):
            rig.cross(address, lap + 3000 if address == 0 else None, 2)
    # car 0 stalls after the line at 12000 (stretch 1 > 2, expected 3000)
    assert rig.run(12000 + 7500) == []  # both stalled
    rig.cross(1, None, 2)
    [started] = of_type(rig.tick(12000 + 7501), IncidentStarted)
    assert started.address == 0
    events = rig.cross(0, 21000, 2)
    [cleared] = of_type(events, IncidentCleared)
    assert (cleared.address, cleared.by) == (0, "crossing")
    assert rig.car(0).incident is None and rig.car(0).laps == 2  # not a lap


def test_marshal_clear_and_no_rewatch_until_next_crossing():
    rig = flagged()
    rig.at(28000)
    [cleared] = of_type(rig.engine.marshal_clear_incident(0), IncidentCleared)
    assert (cleared.by, cleared.lost_ms) == ("marshal", 28000 - 27001)
    assert rig.run(90000) == []  # never watched again before it crosses
    rig.cross(0)
    limit = OVERDUE
    rig.run(90000 + limit)
    [started] = of_type(rig.tick(90000 + limit + 50), IncidentStarted)
    assert (started.address, started.count) == (0, 2)


def test_marshal_clear_errors():
    rig = two_cars()
    with pytest.raises(KeyError):
        rig.engine.marshal_clear_incident(0)  # no open incident
    with pytest.raises(KeyError):
        rig.engine.marshal_clear_incident(7)  # no such car


def test_marshal_report_opens_an_incident_and_pays_the_penalty():
    rig = two_cars(rules(penalty_s=10))
    rig.at(13000)
    [started] = of_type(rig.engine.report_incident(0), IncidentStarted)
    assert (started.source, started.count, started.penalty_ms) == ("marshal", 1, 10000)
    assert (started.from_sensor, started.to_sensor) == (1, 1)
    car = rig.car(0)
    assert car.incident is not None and car.incident.source == "marshal"
    assert car.penalty_ms == 10000
    assert rig.engine.report_incident(0) == []  # already open: no-op
    assert rig.car(0).incidents == 1
    with pytest.raises(KeyError):
        rig.engine.report_incident(7)


def test_overdue_incident_pays_the_penalty():
    rig = flagged(rules(penalty_s=20))
    assert rig.car(0).penalty_ms == 20000


def test_marshal_report_works_while_paused_and_with_detect_off():
    rig = two_cars(rules(detect=False))
    rig.engine.set_paused(True)
    rig.at(13000)
    assert of_type(rig.engine.report_incident(1), IncidentStarted)


def test_race_end_clears_before_race_finished_and_penalty_is_in_the_order():
    rig = Rig(rules(penalty_s=30))
    rig.cross(0, 0)
    rig.cross(1, 0)
    rig.cross(0, 6000)  # car 0 is ahead on the road
    rig.cross(1, 6500)
    rig.cross(0, 12000)
    rig.cross(1, 12500)
    rig.last[1] = 12500
    rig.run(27001)
    assert rig.car(0).incident is not None and rig.car(0).penalty_ms == 30000
    events = rig.engine.stop()
    [cleared] = of_type(events, IncidentCleared)
    assert (cleared.address, cleared.by, cleared.lost_ms) == (0, "race_end", 0)
    assert isinstance(events[-1], RaceFinished)
    assert events.index(cleared) < len(events) - 1
    assert events[-1].order == [1, 0]  # the penalty puts car 0 behind
    assert rig.car(0).incident is None


def test_race_finish_clears_open_incidents():
    rig = Rig(RaceConfig(mode=RaceMode.LAPS, target_laps=3, incidents=IncidentRules()))
    for t in (0, 6000, 12000):
        rig.cross(0, t)
        rig.cross(1)
    rig.at(13000)
    rig.engine.report_incident(1)  # car 1 is reported off: it will not finish by itself
    rig.cross(0, 18000)  # the leader finishes
    events = rig.tick(18000 + 8000)
    assert isinstance(events[-1], RaceFinished)
    [cleared] = of_type(events, IncidentCleared)
    assert (cleared.by, cleared.address) == ("race_end", 1)


def test_reset_drops_incident_state():
    rig = flagged()
    rig.engine.reset()
    assert all(c.incident is None and c.incidents == 0 for c in rig.engine.state.cars)
