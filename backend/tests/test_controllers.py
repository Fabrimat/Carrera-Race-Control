"""Controller settings writer and the pairing wizard (docs/PROTOCOL.md "Roadmap wave 2")."""

from __future__ import annotations

import asyncio
from datetime import timedelta
from pathlib import Path
from typing import Any

import pytest

from app.race.models import (
    CarConfig,
    ControllerSettings,
    Driver,
    RaceConfig,
    RacePhase,
)
from app.service import ControllerError, RaceController
from app.track.base import Timer, TrackDisconnected
from app.track.simulator import SimulatorTrack
from tests.test_service import FakeTrack, hub, make_controller, running, status, wait_for


def cs(speed: int | None = None, brake: int | None = None, fuel: int | None = None):
    return ControllerSettings(speed=speed, brake=brake, fuel=fuel)


def set_car(ctl: RaceController, address: int, **fields: int | None) -> None:
    cars = [
        c.model_copy(update={"controller": cs(**fields)}) if c.address == address else c
        for c in ctl.settings.cars
    ]
    ctl.update_settings(ctl.settings.model_copy(update={"cars": cars}))


def add_driver(ctl: RaceController, driver_id: str, controller: ControllerSettings | None) -> None:
    ctl.store.save_driver(Driver(id=driver_id, name=driver_id.title(), controller=controller))
    ctl._drivers_cache = None


def by_address(ctl: RaceController, address: int):
    return ctl.controller_statuses()[address]


async def settle(ctl: RaceController) -> None:
    """Wait until the writer is idle."""
    await wait_for(lambda: ctl._apply_task is None or ctl._apply_task.done())


class CountingTrack(FakeTrack):
    """Records how many CU commands are in flight at once."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.in_flight = 0
        self.max_in_flight = 0

    async def _write(self, kind: str, address: int, value: int) -> None:
        self.in_flight += 1
        self.max_in_flight = max(self.max_in_flight, self.in_flight)
        try:
            await asyncio.sleep(0.01)
            await super()._write(kind, address, value)
        finally:
            self.in_flight -= 1


# --------------------------------------------------------------------------- effective settings


def test_effective_settings_merge_and_unset(tmp_path: Path) -> None:
    ctl = make_controller(tmp_path)
    set_car(ctl, 0, speed=10, brake=5, fuel=None)
    add_driver(ctl, "kid", cs(speed=3, brake=None, fuel=8))
    add_driver(ctl, "plain", None)

    effective, driver_id = ctl.effective_settings(0)
    assert effective == cs(10, 5, None) and driver_id is None

    ctl._event_state.assignments[0] = "kid"
    effective, driver_id = ctl.effective_settings(0)
    # The driver's non-null fields replace the car's; null ones leave the car's value.
    assert effective == cs(3, 5, 8) and driver_id == "kid"

    # A driver without a profile is still reported, the car's values stay in effect.
    ctl._event_state.assignments[0] = "plain"
    effective, driver_id = ctl.effective_settings(0)
    assert effective == cs(10, 5, None) and driver_id == "plain"

    status0 = by_address(ctl, 0)
    assert status0.pending and status0.applied is None  # works while disconnected
    assert [s.address for s in ctl.controller_statuses()] == [0, 1, 2, 3, 4, 5]
    assert not by_address(ctl, 1).pending  # nothing set: nothing to write
    ctl.store.close()


# --------------------------------------------------------------------------- triggers


async def test_connect_sends_every_non_null_field_once_and_never_the_unset_ones(
    tmp_path: Path,
) -> None:
    track = FakeTrack()
    ctl = make_controller(tmp_path, track)
    set_car(ctl, 0, speed=9, fuel=4)
    set_car(ctl, 2, brake=0)  # a zero is a value, not "unset"

    async def body() -> None:
        await ctl.connect("simulator", None, persist=False)
        await wait_for(lambda: len(track.writes) == 3)
        await settle(ctl)
        assert track.writes == [("speed", 0, 9), ("fuel", 0, 4), ("brake", 2, 0)]
        assert by_address(ctl, 0).applied == cs(speed=9, fuel=4)
        assert not any(s.pending for s in ctl.controller_statuses())
        await asyncio.sleep(0.05)
        assert len(track.writes) == 3  # diff-only: later Statuses write nothing

    await running(ctl, body)


async def test_settings_save_writes_only_what_changed(tmp_path: Path) -> None:
    track = FakeTrack()
    ctl = make_controller(tmp_path, track)
    set_car(ctl, 0, speed=9)

    async def body() -> None:
        await ctl.connect("simulator", None, persist=False)
        await wait_for(lambda: len(track.writes) == 1)
        track.writes.clear()
        set_car(ctl, 0, speed=9, brake=2)  # speed is unchanged
        await wait_for(lambda: len(track.writes) == 1)
        await settle(ctl)
        assert track.writes == [("brake", 0, 2)]
        track.writes.clear()
        set_car(ctl, 0, speed=9, brake=None)  # unset: never sent, applied keeps its value
        await settle(ctl)
        assert track.writes == []
        assert by_address(ctl, 0).applied == cs(speed=9, brake=2)
        assert not by_address(ctl, 0).pending

    await running(ctl, body)


async def test_assignment_and_driver_changes_trigger_writes(tmp_path: Path) -> None:
    track = FakeTrack()
    ctl = make_controller(tmp_path, track)
    set_car(ctl, 1, speed=12)
    add_driver(ctl, "kid", cs(speed=4))

    async def body() -> None:
        await ctl.connect("simulator", None, persist=False)
        await wait_for(lambda: len(track.writes) == 1)
        track.writes.clear()
        await ctl.set_assignments({1: "kid"})  # manual assignment: the handicap is written
        await wait_for(lambda: track.writes == [("speed", 1, 4)])
        track.writes.clear()
        ctl.update_driver("kid", Driver(id="kid", name="Kid", controller=cs(speed=6, fuel=1)))
        await wait_for(lambda: len(track.writes) == 2)
        assert sorted(track.writes) == [("fuel", 1, 1), ("speed", 1, 6)]
        track.writes.clear()
        ctl.delete_driver("kid")  # the car's own value is back in effect
        await wait_for(lambda: track.writes == [("speed", 1, 12)])

    await running(ctl, body)


async def test_update_driver_copies_the_controller_profile(tmp_path: Path) -> None:
    ctl = make_controller(tmp_path)
    add_driver(ctl, "kid", None)
    saved = ctl.update_driver("kid", Driver(id="x", name="Kid", controller=cs(speed=2)))
    assert saved.id == "kid" and saved.controller == cs(speed=2)
    assert ctl.get_driver("kid").controller == cs(speed=2)
    assert ctl.update_driver("kid", Driver(id="x", name="Kid")).controller is None
    ctl.store.close()


async def test_crossing_assignment_triggers_writes(tmp_path: Path) -> None:
    track = FakeTrack()
    ctl = make_controller(tmp_path, track)
    add_driver(ctl, "kid", cs(brake=7))

    async def body() -> None:
        await ctl.connect("simulator", None, persist=False)
        ctl.arm("kid")
        track.items.put_nowait(Timer(3, 1000, 1))
        await wait_for(lambda: track.writes == [("brake", 3, 7)])

    await running(ctl, body)


async def test_reconnect_resets_applied_and_sends_everything_again(tmp_path: Path) -> None:
    track = FakeTrack()
    ctl = make_controller(tmp_path, track)
    set_car(ctl, 0, speed=9, fuel=4)

    async def body() -> None:
        await ctl.connect("simulator", None, persist=False)
        await wait_for(lambda: len(track.writes) == 2)
        await settle(ctl)
        track.items.put_nowait(TrackDisconnected("link lost"))
        await wait_for(lambda: track.connect_calls >= 2)  # reconnected by the poll loop
        await wait_for(lambda: len(track.writes) == 4)  # the CU may be power-cycled
        assert track.writes[2:] == [("speed", 0, 9), ("fuel", 0, 4)]

    await running(ctl, body)


async def test_applied_is_null_after_a_disconnect(tmp_path: Path) -> None:
    track = FakeTrack()
    ctl = make_controller(tmp_path, track)
    set_car(ctl, 0, speed=9)

    async def body() -> None:
        await ctl.connect("simulator", None, persist=False)
        await wait_for(lambda: by_address(ctl, 0).applied is not None)
        await ctl.disconnect()
        status0 = by_address(ctl, 0)
        assert status0.applied is None and status0.pending

    await running(ctl, body)


async def test_nothing_is_written_during_a_race_and_pending_is_written_at_finish(
    tmp_path: Path,
) -> None:
    track = FakeTrack()
    ctl = make_controller(tmp_path, track)

    async def body() -> None:
        await ctl.connect("simulator", None, persist=False)
        await ctl.start_race(RaceConfig())
        for light in (1, 2, 3, 4, 5, 6, 7):
            track.items.put_nowait(status(light))
        await wait_for(lambda: ctl.engine.phase is RacePhase.RUNNING)
        set_car(ctl, 0, speed=5)
        await asyncio.sleep(0.05)
        assert track.writes == []
        assert by_address(ctl, 0).pending
        await ctl.stop_race()
        await wait_for(lambda: track.writes == [("speed", 0, 5)])
        assert not by_address(ctl, 0).pending

    await running(ctl, body)


async def test_reset_race_writes_changes_made_during_the_race(tmp_path: Path) -> None:
    track = FakeTrack()
    ctl = make_controller(tmp_path, track)

    async def body() -> None:
        await ctl.connect("simulator", None, persist=False)
        await ctl.start_race(RaceConfig())
        set_car(ctl, 0, fuel=3)
        assert track.writes == []
        await ctl.reset_race()
        await wait_for(lambda: track.writes == [("fuel", 0, 3)])

    await running(ctl, body)


# --------------------------------------------------------------------------- the writer


async def test_a_batch_aborts_on_its_first_failure_and_the_rest_stays_pending(
    tmp_path: Path,
) -> None:
    track = FakeTrack()
    track.write_errors = [TrackDisconnected("CU did not answer", code="timeout")]
    ctl = make_controller(tmp_path, track)
    set_car(ctl, 0, speed=9, brake=3, fuel=4)

    async def body() -> None:
        await ctl.connect("simulator", None, persist=False)
        await settle(ctl)
        await wait_for(lambda: ctl._apply_task is not None)
        await settle(ctl)
        assert track.writes == []  # the first write failed: nothing else was tried
        assert by_address(ctl, 0).applied is None and by_address(ctl, 0).pending
        # The next trigger (here: any save) picks the pending fields up again.
        set_car(ctl, 0, speed=9, brake=3, fuel=4)
        await wait_for(lambda: len(track.writes) == 3)
        assert track.writes == [("speed", 0, 9), ("brake", 0, 3), ("fuel", 0, 4)]

    await running(ctl, body)


async def test_triggers_coalesce_into_one_serialized_writer(tmp_path: Path) -> None:
    track = CountingTrack()
    ctl = make_controller(tmp_path, track)
    set_car(ctl, 0, speed=9)

    async def body() -> None:
        await ctl.connect("simulator", None, persist=False)
        await wait_for(lambda: ctl._apply_task is not None and not ctl._apply_task.done())
        first = ctl._apply_task
        for value in (1, 2, 3):  # triggers during the batch never start a second writer
            set_car(ctl, 0, speed=9, fuel=value)
            set_car(ctl, 1, speed=value)
            assert ctl._apply_task is first
        await settle(ctl)
        assert track.max_in_flight == 1
        assert by_address(ctl, 0).applied == cs(speed=9, fuel=3)
        assert by_address(ctl, 1).applied == cs(speed=3)
        assert not any(s.pending for s in ctl.controller_statuses())

    await running(ctl, body)


async def test_triggers_never_await_the_batch(tmp_path: Path) -> None:
    track = FakeTrack()
    track.write_gate = asyncio.Event()  # the CU "hangs"
    ctl = make_controller(tmp_path, track)
    set_car(ctl, 0, speed=9)

    async def body() -> None:
        await ctl.connect("simulator", None, persist=False)
        await wait_for(lambda: by_address(ctl, 0).pending and ctl._writing == {0})
        set_car(ctl, 0, speed=10)  # returns at once although a write is in flight
        assert by_address(ctl, 0).pending
        track.write_gate.set()
        await wait_for(lambda: not by_address(ctl, 0).pending)
        assert by_address(ctl, 0).applied == cs(speed=10)

    await running(ctl, body)


async def test_apply_force_writes_everything_and_reports_the_statuses(tmp_path: Path) -> None:
    track = FakeTrack()
    ctl = make_controller(tmp_path, track)
    set_car(ctl, 0, speed=9)
    set_car(ctl, 4, fuel=2)

    async def body() -> None:
        await ctl.connect("simulator", None, persist=False)
        await wait_for(lambda: len(track.writes) == 2)
        await settle(ctl)
        track.writes.clear()
        statuses = await ctl.apply_controllers()
        assert sorted(track.writes) == [("fuel", 4, 2), ("speed", 0, 9)]
        assert not any(s.pending for s in statuses)

    await running(ctl, body)


async def test_apply_joins_a_batch_in_flight(tmp_path: Path) -> None:
    track = FakeTrack()
    track.write_gate = asyncio.Event()
    ctl = make_controller(tmp_path, track)
    set_car(ctl, 0, speed=9)

    async def body() -> None:
        await ctl.connect("simulator", None, persist=False)
        await wait_for(lambda: ctl._writing == {0})
        apply = asyncio.create_task(ctl.apply_controllers())
        await asyncio.sleep(0.05)
        assert not apply.done()  # it waits for the writer instead of starting a second one
        track.write_gate.set()
        statuses = await asyncio.wait_for(apply, 5)
        assert not statuses[0].pending
        assert track.writes == [("speed", 0, 9), ("speed", 0, 9)]  # the forced pass
        assert ctl._apply_task is None or ctl._apply_task.done()

    await running(ctl, body)


async def test_apply_errors(tmp_path: Path) -> None:
    track = FakeTrack()
    ctl = make_controller(tmp_path, track)

    async def body() -> None:
        with pytest.raises(ControllerError) as err:
            await ctl.apply_controllers()
        assert err.value.status == 409 and err.value.code == "not_connected"
        await ctl.connect("simulator", None, persist=False)
        await ctl.start_race(RaceConfig())
        with pytest.raises(ControllerError) as err:
            await ctl.apply_controllers()
        assert err.value.status == 409 and err.value.code == "busy"

    await running(ctl, body)


async def test_the_simulator_applies_speed_and_fuel_end_to_end(tmp_path: Path) -> None:
    sim = SimulatorTrack(num_cars=2, seed=1, time_scale=50.0)
    ctl = make_controller(tmp_path, sim)
    set_car(ctl, 0, speed=5, fuel=7)

    async def body() -> None:
        await ctl.connect("simulator", None, persist=False)
        await wait_for(lambda: not by_address(ctl, 0).pending and by_address(ctl, 0).applied)
        assert sim._core.cars[0].speed == 5 and sim._core.cars[0].fuel == 7

    await running(ctl, body)


async def test_a_trigger_during_a_slow_failing_write_is_not_lost(tmp_path: Path) -> None:
    class SlowFail(FakeTrack):
        async def _write(self, kind: str, address: int, value: int) -> None:
            if self.write_errors:
                await asyncio.sleep(0.15)
            await super()._write(kind, address, value)

    track = SlowFail()
    track.write_errors = [TrackDisconnected("boom")]
    ctl = make_controller(tmp_path, track)
    set_car(ctl, 0, speed=9, fuel=4)

    async def body() -> None:
        await ctl.connect("simulator", None, persist=False)
        await wait_for(lambda: ctl._writing == {0})
        # A new link comes up while the write is failing: its first Status wants a full send.
        ctl._reset_applied()
        ctl._need_full_write = False
        ctl._schedule_apply()
        await wait_for(lambda: len(track.writes) == 2)
        assert sorted(track.writes) == [("fuel", 0, 4), ("speed", 0, 9)]

    await running(ctl, body)


# --------------------------------------------------------------------------- pairing


def car(name: str = "Fulmine", **kw: Any) -> CarConfig:
    return CarConfig(address=0, name=name, color="#112233", nickname=kw.pop("nickname", None), **kw)


def events(ctl: RaceController, kind: str) -> list[Any]:
    return [e for e in hub(ctl).of("event") if e.type == kind]


async def pairing_ctl(tmp_path: Path) -> tuple[RaceController, FakeTrack]:
    track = FakeTrack()
    ctl = make_controller(tmp_path, track)
    await ctl.start(autoconnect=False)
    await ctl.connect("simulator", None, persist=False)
    return ctl, track


async def test_pairing_completes_on_a_target_crossing(tmp_path: Path) -> None:
    ctl, track = await pairing_ctl(tmp_path)
    try:
        profile = car(controller=cs(speed=8, fuel=6))
        pairing = await ctl.start_pairing(2, profile, from_address=4)
        assert pairing.phase == "waiting" and pairing.target_address == 2
        assert pairing.car.address == 2  # car.address is ignored
        assert track.codes == 1
        assert ctl.race_state().pairing is not None
        assert (pairing.expires_at - pairing.started_at).total_seconds() == 60

        track.items.put_nowait(Timer(2, 5000, 1))
        await wait_for(lambda: ctl.race_state().pairing.phase == "paired")
        assert ctl.race_state().pairing.detected_address == 2

        cars = ctl.cars_by_address()
        assert (cars[2].name, cars[2].color) == ("Fulmine", "#112233")
        assert cars[2].controller == cs(speed=8, fuel=6)
        assert cars[4].name == "Car 5" and cars[4].controller == cs()  # slot reset
        assert ctl.store.load_settings().cars[2].name == "Fulmine"  # stored
        (event,) = events(ctl, "car_paired")
        assert (event.address, event.name, event.matches_target) == (2, "Fulmine", True)
        # The target's controller settings are written.
        await wait_for(lambda: sorted(track.writes) == [("fuel", 2, 6), ("speed", 2, 8)])
        assert [c.name for c in ctl.engine.state.cars if c.address == 2] == ["Fulmine"]
    finally:
        await ctl.shutdown()


async def test_pairing_is_stored_at_the_target_and_from_equal_target_is_kept(
    tmp_path: Path,
) -> None:
    ctl, track = await pairing_ctl(tmp_path)
    try:
        await ctl.start_pairing(1, car("Blu"), from_address=1)
        track.items.put_nowait(Timer(1, 5000, 1))
        await wait_for(lambda: ctl.race_state().pairing.phase == "paired")
        assert ctl.cars_by_address()[1].name == "Blu"
        assert ctl.cars_by_address()[0].name == "Car 1"  # nothing else touched
    finally:
        await ctl.shutdown()


async def test_crossing_of_another_address_is_only_a_hint(tmp_path: Path) -> None:
    ctl, track = await pairing_ctl(tmp_path)
    try:
        await ctl.start_pairing(2, car(), None)
        track.items.put_nowait(Timer(4, 5000, 1))
        await wait_for(lambda: ctl.race_state().pairing.detected_address == 4)
        pairing = ctl.race_state().pairing
        assert pairing.phase == "waiting"
        assert ctl.cars_by_address()[2].name == "Car 3"  # not stored
        assert events(ctl, "car_paired") == []
        # Sector 2 / other sectors and the autonomous car do not count.
        track.items.put_nowait(Timer(1, 5100, 2))
        track.items.put_nowait(Timer(6, 5200, 1))
        await wait_for(lambda: track.items.empty())
        await asyncio.sleep(0.03)
        assert ctl.race_state().pairing.detected_address == 4
        # The hint is followed by a second POST with that target (no second CODE press).
        await ctl.start_pairing(4, car(), None)
        assert track.codes == 1
        track.items.put_nowait(Timer(4, 6000, 1))
        await wait_for(lambda: ctl.race_state().pairing.phase == "paired")
        assert ctl.cars_by_address()[4].name == "Fulmine"
    finally:
        await ctl.shutdown()


async def test_a_deleted_logo_is_dropped_when_the_pairing_completes(tmp_path: Path) -> None:
    ctl, track = await pairing_ctl(tmp_path)
    try:
        await ctl.start_pairing(1, car(logo_id="gone"), None)
        await ctl.confirm_pairing()
        assert ctl.cars_by_address()[1].logo_id is None
        assert ctl.store.load_settings().cars[1].name == "Fulmine"
    finally:
        await ctl.shutdown()


async def test_manual_confirm_completes_the_pairing(tmp_path: Path) -> None:
    ctl, track = await pairing_ctl(tmp_path)
    try:
        await ctl.start_pairing(3, car(nickname="Sparky"), None)
        pairing = await ctl.confirm_pairing()
        assert pairing.phase == "paired" and pairing.detected_address is None
        assert ctl.cars_by_address()[3].nickname == "Sparky"
        (event,) = events(ctl, "car_paired")
        assert event.address == 3 and event.name == "Sparky" and event.matches_target
        with pytest.raises(ControllerError) as err:
            await ctl.confirm_pairing()  # nothing waiting any more
        assert err.value.status == 404 and err.value.code == "not_found"
    finally:
        await ctl.shutdown()


async def test_confirm_after_a_hint_reports_a_mismatch(tmp_path: Path) -> None:
    ctl, track = await pairing_ctl(tmp_path)
    try:
        await ctl.start_pairing(3, car(), None)
        track.items.put_nowait(Timer(5, 5000, 1))
        await wait_for(lambda: ctl.race_state().pairing.detected_address == 5)
        await ctl.confirm_pairing()
        (event,) = events(ctl, "car_paired")
        assert event.address == 3 and event.matches_target is False
    finally:
        await ctl.shutdown()


async def test_second_post_replaces_without_pressing_code(tmp_path: Path) -> None:
    ctl, track = await pairing_ctl(tmp_path)
    try:
        await ctl.start_pairing(1, car("A"), 0)
        second = await ctl.start_pairing(2, car("B"), None)
        assert track.codes == 1
        assert second.target_address == 2 and second.car.name == "B"
        assert second.from_address is None and second.detected_address is None
        assert ctl.race_state().pairing.target_address == 2
        # A terminal state is not "waiting": a new POST presses CODE again.
        await ctl.cancel_pairing()
        await ctl.start_pairing(2, car("B"), None)
        assert track.codes == 2
    finally:
        await ctl.shutdown()


async def test_timeout_and_linger(tmp_path: Path) -> None:
    ctl, track = await pairing_ctl(tmp_path)
    clock = [ctl._wall_clock()]
    ctl._wall_clock = lambda: clock[0]
    try:
        await ctl.start_pairing(1, car(), None)
        clock[0] += timedelta(seconds=61)
        await wait_for(lambda: ctl.race_state().pairing.phase == "timeout")
        assert track.codes == 1  # a timeout does not touch the CU
        clock[0] += timedelta(seconds=11)  # 10 s linger, then gone
        await wait_for(lambda: ctl.race_state().pairing is None)
        assert ctl.cars_by_address()[1].name == "Car 2"
    finally:
        await ctl.shutdown()


async def test_cancel_does_not_touch_the_cu_and_404_when_nothing_waits(tmp_path: Path) -> None:
    ctl, track = await pairing_ctl(tmp_path)
    try:
        with pytest.raises(ControllerError) as err:
            await ctl.cancel_pairing()
        assert err.value.status == 404 and err.value.code == "not_found"
        await ctl.start_pairing(1, car(), None)
        cancelled = await ctl.cancel_pairing()
        assert cancelled.phase == "cancelled"
        assert track.codes == 1 and track.starts == 0 and track.paces == 0
        assert ctl.race_state().pairing.phase == "cancelled"
        track.items.put_nowait(Timer(1, 5000, 1))  # a late crossing pairs nothing
        await asyncio.sleep(0.05)
        assert ctl.cars_by_address()[1].name == "Car 2"
    finally:
        await ctl.shutdown()


async def test_a_race_start_cancels_the_pairing(tmp_path: Path) -> None:
    ctl, track = await pairing_ctl(tmp_path)
    try:
        await ctl.start_pairing(1, car(), None)
        await ctl.start_race(RaceConfig())
        pairing = ctl.race_state().pairing
        assert pairing.phase == "cancelled" and pairing.error == "race started"
        with pytest.raises(ControllerError) as err:
            await ctl.start_pairing(1, car(), None)
        assert err.value.status == 409 and err.value.code == "busy"
    finally:
        await ctl.shutdown()


async def test_start_pressed_on_the_cu_cancels_the_pairing(tmp_path: Path) -> None:
    ctl, track = await pairing_ctl(tmp_path)
    try:
        await ctl.start_pairing(1, car(), None)
        for light in (1, 2, 3, 4, 5, 6, 7):
            track.items.put_nowait(status(light))
        await wait_for(lambda: ctl.engine.phase is RacePhase.RUNNING)
        assert ctl.race_state().pairing.phase == "cancelled"
        assert ctl.race_state().pairing.error == "race started"
    finally:
        await ctl.shutdown()


async def test_pairing_takes_the_crossing_before_assign_on_next_crossing(tmp_path: Path) -> None:
    ctl, track = await pairing_ctl(tmp_path)
    try:
        add_driver(ctl, "anna", None)
        ctl.arm("anna")
        await ctl.start_pairing(2, car(), None)
        track.items.put_nowait(Timer(2, 5000, 1))
        await wait_for(lambda: ctl.race_state().pairing.phase == "paired")
        assert ctl.assignments() == {}  # the Timer was not used for the assignment
        assert ctl.event_state.armed_driver_id == "anna"  # the arming stays
        track.items.put_nowait(Timer(3, 6000, 1))  # afterwards it works as before
        await wait_for(lambda: ctl.assignments() == {3: "anna"})
    finally:
        await ctl.shutdown()


async def test_a_hint_crossing_is_not_used_for_the_assignment_either(tmp_path: Path) -> None:
    ctl, track = await pairing_ctl(tmp_path)
    try:
        add_driver(ctl, "anna", None)
        ctl.arm("anna")
        await ctl.start_pairing(2, car(), None)
        track.items.put_nowait(Timer(5, 5000, 1))
        await wait_for(lambda: ctl.race_state().pairing.detected_address == 5)
        assert ctl.assignments() == {}
    finally:
        await ctl.shutdown()


async def test_pairing_errors_not_connected_and_busy(tmp_path: Path) -> None:
    ctl = make_controller(tmp_path, FakeTrack())
    await ctl.start(autoconnect=False)
    try:
        with pytest.raises(ControllerError) as err:
            await ctl.start_pairing(1, car(), None)
        assert err.value.status == 409 and err.value.code == "not_connected"
    finally:
        await ctl.shutdown()


async def test_a_failing_code_press_ends_in_failed(tmp_path: Path) -> None:
    class BrokenCode(FakeTrack):
        async def press_code(self) -> None:
            raise TrackDisconnected("no answer", code="timeout")

    track = BrokenCode()
    ctl = make_controller(tmp_path, track)
    await ctl.start(autoconnect=False)
    await ctl.connect("simulator", None, persist=False)
    try:
        pairing = await ctl.start_pairing(1, car(), None)
        assert pairing.phase == "failed" and "CODE" in (pairing.error or "")
        assert ctl.race_state().pairing.phase == "failed"
    finally:
        await ctl.shutdown()


async def test_pairing_on_the_simulator_end_to_end(tmp_path: Path) -> None:
    """POST -> CODE -> the simulator schedules a crossing of car 0 about 2 s later -> paired."""
    sim = SimulatorTrack(num_cars=3, seed=2, time_scale=1.0, deslot_rate=0.0)
    ctl = make_controller(tmp_path, sim)
    await ctl.start(autoconnect=False)
    await ctl.connect("simulator", None, persist=False)
    try:
        set_car(ctl, 0, speed=14)
        await ctl.start_pairing(0, car(controller=cs(speed=11)), from_address=2)
        await wait_for(lambda: ctl.race_state().pairing.phase == "paired", limit_s=8)
        assert ctl.cars_by_address()[0].name == "Fulmine"
        assert ctl.cars_by_address()[2].name == "Car 3"
        assert [e.type for e in hub(ctl).of("event")] == ["car_paired"]
        await wait_for(lambda: sim._core.cars[0].speed == 11)  # the new profile was written
    finally:
        await ctl.shutdown()


async def test_the_simulator_cross_hook_pairs_deterministically(tmp_path: Path) -> None:
    sim = SimulatorTrack(num_cars=3, seed=2, time_scale=1.0, deslot_rate=0.0)
    ctl = make_controller(tmp_path, sim)
    await ctl.start(autoconnect=False)
    await ctl.connect("simulator", None, persist=False)
    try:
        await ctl.start_pairing(1, car("Blu"), None)
        sim.cross(1)
        await wait_for(lambda: ctl.race_state().pairing.phase == "paired")
        assert ctl.cars_by_address()[1].name == "Blu"
    finally:
        await ctl.shutdown()


# --------------------------------------------------------------------------- garage


async def test_garage_lists_every_car_with_stats_from_real_races_only(tmp_path: Path) -> None:
    ctl = make_controller(tmp_path)
    store = ctl.store
    from app.race.models import Lap

    real = store.create_race(RaceConfig(), ctl.settings.cars, "oval", "ble")
    sim = store.create_race(RaceConfig(), ctl.settings.cars, "oval", "simulator")
    for race, ms in ((real, 6000), (real, 5500), (sim, 100)):
        store.add_lap(race, Lap(address=1, lap_number=1, lap_ms=ms, race_time_ms=ms))
    garage = ctl.garage()
    assert [g.address for g in garage] == [0, 1, 2, 3, 4, 5]
    assert garage[0].races == 0 and garage[0].best_lap_ms is None
    assert garage[1].races == 1 and garage[1].laps == 2
    assert garage[1].best_lap_ms == 5500 and garage[1].best_lap_layout == "oval"
    assert garage[1].car.address == 1
    store.close()


async def test_new_races_store_their_layout_and_track_mode(tmp_path: Path) -> None:
    track = FakeTrack()
    ctl = make_controller(tmp_path, track)

    async def body() -> None:
        await ctl.connect("simulator", None, persist=False)
        await ctl.start_race(RaceConfig())
        row = ctl.store._conn.execute("SELECT layout, track_mode FROM races").fetchone()
        assert (row["layout"], row["track_mode"]) == (ctl.settings.track.layout, "simulator")

    await running(ctl, body)


async def test_no_writes_while_the_pairing_wizard_waits(tmp_path: Path) -> None:
    track = FakeTrack()
    ctl = make_controller(tmp_path, track)

    async def body() -> None:
        await ctl.connect("simulator", None, persist=False)
        await settle(ctl)
        await ctl.start_pairing(2, CarConfig(address=2, name="Fulmine"), None)
        track.writes.clear()
        set_car(ctl, 0, speed=7)  # the CU may be in CODE mode: held back
        await settle(ctl)
        assert track.writes == []
        assert by_address(ctl, 0).pending
        await ctl.cancel_pairing()  # the wizard ends: the held write goes out
        await wait_for(lambda: track.writes == [("speed", 0, 7)])
        await settle(ctl)
        assert not by_address(ctl, 0).pending

    await running(ctl, body)
