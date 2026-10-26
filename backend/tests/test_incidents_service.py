"""Incidents through the controller: places, marshal calls, auto pace car, simulator end to end."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from app.race.models import (
    IncidentCleared,
    IncidentRules,
    IncidentStarted,
    LayoutSensor,
    RaceConfig,
    RaceFinished,
    RacePhase,
    TrackLayout,
)
from app.race.store import RaceStore
from app.service import ControllerError, RaceController
from app.track.base import Timer
from app.track.simulator import SimulatorTrack
from tests.test_engine import FakeClock
from tests.test_service import FakeTrack, hub, make_controller, status, wait_for

LAP = 6000
AUTO = RaceConfig(incidents=IncidentRules(auto_pace_car=True))


class Drive:
    """Feeds a controller with scripted crossings on a fake host clock (race ms = ``t``)."""

    def __init__(self, ctl: RaceController, track: FakeTrack):
        self.ctl = ctl
        self.track = track
        self.clock = FakeClock()
        ctl.engine._clock = self.clock
        self.t = 0

    async def start(self, config: RaceConfig) -> None:
        await self.ctl.connect("simulator", None, persist=False)
        await self.ctl.start_race(config)
        for light in (1, 2, 3, 4, 5, 6, 7):
            await self.ctl._handle(status(light))
        assert self.ctl.engine.phase is RacePhase.RUNNING

    def at(self, ms: int) -> None:
        self.clock.advance((ms - self.t) / 1000)
        self.t = ms

    async def cross(self, address: int, ms: int | None = None) -> None:
        if ms is not None:
            self.at(ms)
        await self.ctl._handle(Timer(address, 1000 + self.t, 1))

    async def tick(self, ms: int) -> None:
        self.at(ms)
        await self.ctl._process_events(self.ctl.engine.tick())

    async def learn(self) -> None:
        """Cars 0 and 1: a learned 6 s lap, both last crossed at t = 12000."""
        for t in (0, 6000, 12000):
            await self.cross(0, t)
            await self.cross(1)

    async def flag_car_0(self) -> None:
        """Car 1 keeps going while car 0 stops: car 0 is flagged at t = 27001."""
        await self.learn()
        for t in (18000, 24000):
            await self.cross(1, t)
        await self.tick(27001)
        assert any(c.incident for c in self.ctl.race_state().cars)


def events_of(ctl: RaceController, cls: type) -> list[Any]:
    return [e for e in hub(ctl).of("event") if isinstance(e, cls)]


def incident_cars(ctl: RaceController) -> list[int]:
    return [c.address for c in ctl.race_state().cars if c.incident is not None]


async def setup(tmp_path: Path, config: RaceConfig = AUTO, **kw: Any):
    track = FakeTrack()
    ctl = make_controller(tmp_path, track, **kw)
    drive = Drive(ctl, track)
    await ctl.start(autoconnect=False)
    await drive.start(config)
    return ctl, track, drive


# ---------------------------------------------------------------- marshal endpoints


async def test_marshal_report_and_clear_and_errors(tmp_path: Path) -> None:
    ctl, track, drive = await setup(tmp_path, RaceConfig())
    try:
        await drive.learn()
        state = await ctl.report_incident(1)
        car = next(c for c in state.cars if c.address == 1)
        assert car.incident is not None and car.incident.source == "marshal"
        [started] = events_of(ctl, IncidentStarted)
        assert (started.address, started.source) == (1, "marshal")
        again = await ctl.report_incident(1)  # no-op
        assert next(c for c in again.cars if c.address == 1).incidents == 1
        drive.at(14000)
        state = await ctl.clear_incident(1)
        assert next(c for c in state.cars if c.address == 1).incident is None
        [cleared] = events_of(ctl, IncidentCleared)
        assert (cleared.by, cleared.address) == ("marshal", 1)
        with pytest.raises(ControllerError) as err:
            await ctl.clear_incident(1)
        assert (err.value.status, err.value.code) == (404, "incident_not_found")
        with pytest.raises(ControllerError) as err:
            await ctl.report_incident(7)
        assert (err.value.status, err.value.code) == (404, "incident_not_found")
        assert track.paces == 0  # auto pace car is off
    finally:
        await ctl.shutdown()


async def test_marshal_calls_need_a_running_race(tmp_path: Path) -> None:
    ctl = make_controller(tmp_path, FakeTrack())
    for call in (ctl.report_incident, ctl.clear_incident):
        with pytest.raises(ControllerError) as err:
            await call(0)
        assert (err.value.status, err.value.code) == (409, "race_not_running")
    await ctl.shutdown()


# ---------------------------------------------------------------- place on the layout


@pytest.mark.parametrize(
    ("sensors", "stretch", "expected"),
    [
        ([], (1, 1), 0.5),
        ([(2, 0.3), (3, 0.6)], (1, 2), 0.15),
        ([(2, 0.3), (3, 0.6)], (2, 3), 0.45),
        ([(2, 0.3), (3, 0.6)], (3, 1), 0.8),  # wraps through the line
        ([(2, 0.3)], (2, 3), None),  # sensor 3 is not on the map
    ],
)
async def test_incident_place_is_the_middle_of_the_stretch(
    tmp_path: Path, sensors: list[tuple[int, float]], stretch: tuple[int, int], expected
) -> None:
    store = RaceStore(":memory:")
    points = [(0.1 + 0.1 * i, 0.5 + (0.3 if i % 2 else 0.0)) for i in range(8)]
    store.save_layout(
        TrackLayout(
            name="default",
            points=points,
            sensors=[LayoutSensor(sensor=n, s=s) for n, s in sensors],
        )
    )
    ctl = make_controller(tmp_path, FakeTrack(), store=store)
    got = ctl._incident_place(*stretch)
    assert got == (pytest.approx(expected) if expected is not None else None)
    await ctl.shutdown()


async def test_incident_place_is_none_without_a_layout(tmp_path: Path) -> None:
    ctl = make_controller(tmp_path, FakeTrack())
    assert ctl._incident_place(1, 1) is None
    await ctl.shutdown()


async def test_event_and_state_carry_the_place(tmp_path: Path) -> None:
    store = RaceStore(":memory:")
    points = [(0.1 + 0.1 * i, 0.5 + (0.3 if i % 2 else 0.0)) for i in range(8)]
    store.save_layout(TrackLayout(name="default", points=points, sensors=[]))
    ctl, track, drive = await setup(tmp_path, RaceConfig(), store=store)
    try:
        await drive.flag_car_0()
        [started] = events_of(ctl, IncidentStarted)
        assert started.s == 0.5
        car = next(c for c in ctl.race_state().cars if c.address == 0)
        assert car.incident is not None and car.incident.s == 0.5
    finally:
        await ctl.shutdown()


# ---------------------------------------------------------------- auto pace car


async def test_auto_pace_car_toggles_once_each_way(tmp_path: Path) -> None:
    ctl, track, drive = await setup(tmp_path)
    try:
        await drive.flag_car_0()
        assert incident_cars(ctl) == [0]
        assert track.paces == 1 and ctl.engine.phase is RacePhase.PAUSED
        await ctl.report_incident(1)  # second incident while ours is out: no new toggle
        assert track.paces == 1
        await ctl.clear_incident(0)
        assert track.paces == 1 and ctl.engine.phase is RacePhase.PAUSED  # car 1 still off
        await ctl.clear_incident(1)
        assert track.paces == 2 and ctl.engine.phase is RacePhase.RUNNING
        assert not ctl._pace_owned
    finally:
        await ctl.shutdown()


async def test_auto_pace_car_off_does_not_touch_the_pace_car(tmp_path: Path) -> None:
    ctl, track, drive = await setup(tmp_path, RaceConfig())
    try:
        await drive.flag_car_0()
        assert track.paces == 0 and ctl.engine.phase is RacePhase.RUNNING
    finally:
        await ctl.shutdown()


async def test_a_marshal_report_deploys_it_too(tmp_path: Path) -> None:
    ctl, track, drive = await setup(tmp_path)
    try:
        await drive.learn()
        await ctl.report_incident(0)
        assert track.paces == 1 and ctl.engine.phase is RacePhase.PAUSED
    finally:
        await ctl.shutdown()


async def test_recalled_when_the_race_is_stopped(tmp_path: Path) -> None:
    ctl, track, drive = await setup(tmp_path)
    try:
        await drive.flag_car_0()
        assert track.paces == 1
        await ctl.stop_race()
        assert track.paces == 2 and not ctl._pace_owned
        assert ctl.engine.phase is RacePhase.FINISHED
        assert events_of(ctl, IncidentCleared)[-1].by == "race_end"
        assert events_of(ctl, RaceFinished)
    finally:
        await ctl.shutdown()


async def test_recalled_when_the_race_is_reset(tmp_path: Path) -> None:
    ctl, track, drive = await setup(tmp_path)
    try:
        await drive.flag_car_0()
        await ctl.reset_race()
        assert track.paces == 2 and not ctl._pace_owned
        assert ctl.engine.phase is RacePhase.IDLE
    finally:
        await ctl.shutdown()


async def test_ownership_resets_when_a_new_race_is_prepared(tmp_path: Path) -> None:
    ctl, track, drive = await setup(tmp_path)
    try:
        await drive.flag_car_0()
        await ctl.start_race(AUTO)  # stops this race (recall) and prepares the next
        assert track.paces == 2 and not ctl._pace_owned
        assert ctl.engine.phase is RacePhase.STARTING
    finally:
        await ctl.shutdown()


async def test_not_recalled_when_it_was_not_deployed_by_us(tmp_path: Path) -> None:
    ctl, track, drive = await setup(tmp_path)
    try:
        await drive.learn()
        await ctl.toggle_pace_car()  # the user puts the pace car out
        assert track.paces == 1 and ctl.engine.phase is RacePhase.PAUSED
        await ctl.report_incident(0)  # opens while PAUSED: nothing is deployed
        await ctl.clear_incident(0)
        assert track.paces == 1 and ctl.engine.phase is RacePhase.PAUSED
        await ctl.stop_race()
        assert track.paces == 1
    finally:
        await ctl.shutdown()


async def test_a_manual_toggle_hands_the_pace_car_to_the_user(tmp_path: Path) -> None:
    ctl, track, drive = await setup(tmp_path)
    try:
        await drive.flag_car_0()
        assert ctl._pace_owned and track.paces == 1
        await ctl.toggle_pace_car()  # the user brings it in themselves
        assert track.paces == 2 and not ctl._pace_owned
        assert ctl.engine.phase is RacePhase.RUNNING
        await ctl.clear_incident(0)
        assert track.paces == 2  # nothing is recalled: it is not ours
        await ctl.stop_race()
        assert track.paces == 2
    finally:
        await ctl.shutdown()


async def test_a_failing_pace_car_is_logged_not_raised(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    ctl, track, drive = await setup(tmp_path)
    try:

        async def broken() -> None:
            raise RuntimeError("no link")

        track.toggle_pace_car = broken  # type: ignore[method-assign]
        await drive.flag_car_0()  # must not raise
        assert incident_cars(ctl) == [0]
        assert not ctl._pace_owned and ctl.engine.phase is RacePhase.RUNNING
        assert "deploying failed" in caplog.text
    finally:
        await ctl.shutdown()


async def test_a_failing_recall_is_logged_not_raised(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    ctl, track, drive = await setup(tmp_path)
    try:
        await drive.flag_car_0()

        async def broken() -> None:
            raise RuntimeError("no link")

        track.toggle_pace_car = broken  # type: ignore[method-assign]
        await ctl.clear_incident(0)  # must not raise
        assert not ctl._pace_owned
        assert "recalling failed" in caplog.text
    finally:
        await ctl.shutdown()


# ---------------------------------------------------------------- persistence / history


async def test_history_results_keep_the_incident_fields(tmp_path: Path) -> None:
    ctl, track, drive = await setup(tmp_path, RaceConfig(incidents=IncidentRules(penalty_s=15)))
    try:
        await drive.flag_car_0()
        drive.at(30000)
        await ctl.clear_incident(0)
        race_id = ctl.engine.race_id
        await ctl.stop_race()
        assert race_id is not None
        detail = ctl.store.get_race(race_id)
        assert detail is not None
        car = next(c for c in detail["results"] if c["address"] == 0)
        assert car["incidents"] == 1
        assert car["incident_lost_ms"] == 30000 - 27001
        assert car["penalty_ms"] == 15000
        assert car["incident"] is None
    finally:
        await ctl.shutdown()


# ---------------------------------------------------------------- simulator end to end


async def test_simulator_deslot_makes_an_incident_end_to_end(tmp_path: Path) -> None:
    sim = SimulatorTrack(num_cars=3, seed=11, time_scale=50.0, double_trigger_rate=0, deslot_rate=0)
    # The test config scales the engine clock by 50 as well (sim_time_scale).
    ctl = make_controller(tmp_path, sim, second_press_s=0.05)

    async def body() -> None:
        await ctl.connect("simulator", None, persist=False)
        await ctl.start_race(RaceConfig())

        def laps() -> bool:
            return all(c.laps >= 2 for c in ctl.race_state().cars if c.position is not None) and (
                len([c for c in ctl.race_state().cars if c.position is not None]) == 3
            )

        await wait_for(laps, limit_s=20)
        track = ctl._track
        assert isinstance(track, SimulatorTrack)
        track.deslot(0, 120)  # 120 simulated seconds: way past 2.5 laps
        await wait_for(lambda: incident_cars(ctl) == [0], limit_s=20)
        started = [e for e in hub(ctl).of("event") if isinstance(e, IncidentStarted)]
        assert [e.address for e in started] == [0] and started[0].source == "overdue"
        await wait_for(
            lambda: any(isinstance(e, IncidentCleared) for e in hub(ctl).of("event")), limit_s=30
        )
        cleared = [e for e in hub(ctl).of("event") if isinstance(e, IncidentCleared)]
        assert (cleared[0].address, cleared[0].by) == (0, "crossing")
        assert cleared[0].lost_ms > 0
        assert incident_cars(ctl) == []

    await ctl.start(autoconnect=False)
    try:
        await body()
    finally:
        await ctl.shutdown()
