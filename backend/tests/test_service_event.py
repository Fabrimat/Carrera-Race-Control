"""RaceController event mode: session runner, CU-pressed starts, false start restart, results."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import pytest

from app.race.models import (
    CommentaryContext,
    Driver,
    EventProgram,
    FalseStartRule,
    RaceMode,
    RacePhase,
    SessionKind,
    SessionSpec,
)
from app.race.store import RaceStore
from app.service import ControllerError, RaceController
from app.track.base import Timer
from tests.test_service import FakeTrack, hub, make_controller, running, status, wait_for


def program(*sessions: SessionSpec, **kwargs: Any) -> EventProgram:
    return EventProgram(id="cup", name="Cup", sessions=list(sessions), **kwargs)


def race(sid: str = "race", **kwargs: Any) -> SessionSpec:
    return SessionSpec(id=sid, kind=SessionKind.RACE, **kwargs)


def start(ctl: RaceController, prog: EventProgram) -> None:
    ctl.store.save_program(prog)
    ctl.start_event(prog.id)


def event_types(ctl: RaceController) -> list[str]:
    return [e.type for e in hub(ctl).of("event")]


# --------------------------------------------------------------------------- session runner


async def test_cu_pressed_start_runs_the_session_spec(tmp_path: Path) -> None:
    track = FakeTrack()
    ctl = make_controller(tmp_path, track)

    async def body() -> None:
        await ctl.connect("simulator", None, persist=False)
        start(ctl, program(race(mode=RaceMode.LAPS, target_laps=3)))
        assert ctl.engine.config.mode is RaceMode.LAPS
        assert ctl.engine.config.target_laps == 3
        for light in (1, 2, 3, 4, 5, 6, 7):
            track.items.put_nowait(status(light))
        await wait_for(lambda: ctl.engine.phase is RacePhase.RUNNING)
        state = ctl.race_state()
        assert state.config.target_laps == 3
        assert state.session is not None
        assert (state.session.session_id, state.session.index, state.session.total) == (
            "race",
            0,
            1,
        )

    await running(ctl, body)


async def test_start_without_body_uses_the_spec_and_qualifying_is_timed(tmp_path: Path) -> None:
    ctl = make_controller(tmp_path, FakeTrack(), start_fallback_s=10)

    async def body() -> None:
        await ctl.connect("simulator", None, persist=False)
        quali = SessionSpec(id="q", kind=SessionKind.QUALIFYING, mode=RaceMode.LAPS, duration_s=90)
        start(ctl, program(quali, race(target_laps=7)))
        state = await ctl.start_race()
        assert state.config.mode is RaceMode.TIMED and state.config.duration_s == 90
        assert ctl.engine.qualifying is True
        await ctl.stop_race()
        ctl.next_session()
        state = await ctl.start_race()
        assert state.config.mode is RaceMode.LAPS and state.config.target_laps == 7
        assert ctl.engine.qualifying is False
        assert state.session is not None and state.session.session_id == "race"

    await running(ctl, body)


async def test_event_commands_are_refused_while_racing(tmp_path: Path) -> None:
    ctl = make_controller(tmp_path, FakeTrack(), start_fallback_s=10)

    async def body() -> None:
        await ctl.connect("simulator", None, persist=False)
        start(ctl, program(race("a"), race("b")))
        await ctl.start_race()
        with pytest.raises(ControllerError) as err:
            ctl.next_session()
        assert (err.value.status, err.value.code) == (409, "busy")
        with pytest.raises(ControllerError):
            ctl.start_event("cup")
        await ctl.stop_race()
        assert ctl.next_session().current_index == 1
        with pytest.raises(ControllerError) as err:
            ctl.next_session()  # already the last one
        assert err.value.status == 409

    await running(ctl, body)


async def test_stop_event_restores_the_race_settings(tmp_path: Path) -> None:
    ctl = make_controller(tmp_path, FakeTrack())
    start(ctl, program(race(mode=RaceMode.LAPS, target_laps=3)))
    assert ctl.engine.config.target_laps == 3
    state = ctl.stop_event()
    assert state.program_id is None
    assert ctl.engine.config == ctl.settings.race
    assert ctl.race_state().session is None


# --------------------------------------------------------------------------- false start


async def test_restart_rule_presses_start_again_only_once(tmp_path: Path) -> None:
    track = FakeTrack()
    ctl = make_controller(tmp_path, track, second_press_s=0.05, start_fallback_s=10)

    async def body() -> None:
        await ctl.connect("simulator", None, persist=False)
        start(ctl, program(race(false_start=FalseStartRule(action="restart"))))
        await ctl.start_race()
        assert track.starts == 1
        track.idle_status = status(2)  # countdown running
        for item in (status(1), status(2), Timer(1, 500)):
            track.items.put_nowait(item)
        await wait_for(lambda: ctl.engine._jump_candidate == 1)
        track.idle_status = status(8)  # the CU aborts the sequence
        await wait_for(lambda: track.starts == 2)
        # The CU shows 8 a little longer, then arms (light 1): the watchdog presses again.
        await asyncio.sleep(0.02)
        track.idle_status = status(1)
        await wait_for(lambda: track.starts == 3)
        # A second false start in the same start: reported, but no more presses.
        track.idle_status = status(2)
        await wait_for(lambda: ctl._last_status is not None and ctl._last_status.start == 2)
        track.idle_status = status(9)
        await wait_for(lambda: event_types(ctl).count("false_start") == 2)
        await asyncio.sleep(0.2)
        assert track.starts == 3
        assert ctl.engine.phase is RacePhase.STARTING  # never started on the host clock

    await running(ctl, body)
    false_starts = [e for e in hub(ctl).of("event") if e.type == "false_start"]
    assert [(e.address, e.action) for e in false_starts] == [(1, "restart"), (None, "restart")]


async def _false_start_restart(ctl: RaceController, track: FakeTrack) -> None:
    """Start the event race, jump the start: the restart rule presses START (2nd press)."""
    await ctl.connect("simulator", None, persist=False)
    start(ctl, program(race(false_start=FalseStartRule(action="restart"))))
    await ctl.start_race()
    track.idle_status = status(2)
    await wait_for(lambda: ctl._last_status is not None and ctl._last_status.start == 2)
    track.idle_status = status(8)
    await wait_for(lambda: track.starts == 2)


async def test_restart_never_falls_back_to_the_host_clock(tmp_path: Path) -> None:
    track = FakeTrack()
    # A plain start would fall back to start_now after 0.1 s without lights.
    ctl = make_controller(
        tmp_path, track, second_press_s=0.05, start_fallback_s=0.1, restart_wait_s=0.5
    )

    async def body() -> None:
        await _false_start_restart(ctl, track)
        track.idle_status = status(0)  # the CU drops to 0 after the restart press
        await asyncio.sleep(0.8)  # past the fallback and the restart wait
        assert ctl.engine.phase is RacePhase.STARTING
        assert track.starts == 2

    await running(ctl, body)
    assert "race_started" not in event_types(ctl)


async def test_restart_waits_for_the_cu_to_rearm_then_presses_once(tmp_path: Path) -> None:
    track = FakeTrack()
    ctl = make_controller(
        tmp_path, track, second_press_s=0.2, start_fallback_s=0.1, restart_wait_s=10
    )

    async def body() -> None:
        await _false_start_restart(ctl, track)
        await asyncio.sleep(4.0)  # the CU holds the false start lights for 4 s
        assert track.starts == 2
        track.idle_status = status(1)  # then it arms
        await wait_for(lambda: track.starts == 3)
        await asyncio.sleep(0.6)
        assert track.starts == 3  # exactly one more press
        assert ctl.engine.phase is RacePhase.STARTING
        track.idle_status = status(2)
        await wait_for(lambda: ctl._last_status is not None and ctl._last_status.start == 2)
        track.idle_status = status(7)
        await wait_for(lambda: ctl.engine.phase is RacePhase.RUNNING)

    await running(ctl, body)


async def test_get_event_clears_an_expired_arming(tmp_path: Path) -> None:
    from datetime import timedelta

    store = RaceStore(":memory:")
    store.save_driver(Driver(id="anna", name="Anna"))
    ctl = make_controller(tmp_path, FakeTrack(), store=store)
    ctl.arm("anna")
    assert ctl.get_event().armed_driver_id == "anna"
    now = ctl._wall_clock()
    ctl._wall_clock = lambda: now + timedelta(seconds=61)
    state = ctl.get_event()
    assert state.armed_driver_id is None and state.armed_until is None
    assert store.load_event_state().armed_driver_id is None


async def test_restart_is_rearmed_by_a_new_start(tmp_path: Path) -> None:
    track = FakeTrack()
    ctl = make_controller(tmp_path, track, second_press_s=10, start_fallback_s=10)

    async def body() -> None:
        await ctl.connect("simulator", None, persist=False)
        start(ctl, program(race(false_start=FalseStartRule(action="restart"))))
        for _ in range(2):
            starts = track.starts
            await ctl.start_race()
            track.idle_status = status(2)
            await wait_for(lambda: ctl._last_status is not None and ctl._last_status.start == 2)
            track.idle_status = status(8)
            await wait_for(lambda s=starts: track.starts == s + 2)
            await ctl.stop_race()
            track.idle_status = status(0)
            await asyncio.sleep(0.02)

    await running(ctl, body)


# --------------------------------------------------------------------------- results


def _session_script() -> list[Any]:
    """Car 1 jumps the start (penalty 5 s), then beats car 0 on the road by 0.2 s."""
    script: list[Any] = [status(1), status(2), Timer(1, 500), status(8)]
    script += [status(s) for s in (0, 1, 2, 3, 4, 5, 6, 7, 0)]
    script += [Timer(1, 1000), Timer(0, 1100), Timer(1, 7000), Timer(0, 7200)]
    return script


async def test_session_result_with_penalty_is_stored_and_survives_restart(
    tmp_path: Path,
) -> None:
    db = tmp_path / "db.sqlite3"
    store = RaceStore(db)
    track = FakeTrack()
    ctl = make_controller(tmp_path, track, store=store)
    spec = race(
        mode=RaceMode.LAPS,
        target_laps=1,
        false_start=FalseStartRule(action="penalty", penalty_s=5),
    )

    async def body() -> None:
        await ctl.connect("simulator", None, persist=False)
        start(ctl, program(spec))
        for item in _session_script():
            track.items.put_nowait(item)
        await wait_for(lambda: "session_finished" in event_types(ctl))

    await running(ctl, body)
    types = event_types(ctl)
    assert types.index("race_finished") < types.index("session_finished")
    finished = next(e for e in hub(ctl).of("event") if e.type == "race_finished")
    assert finished.winner == 0  # car 1 crossed first but carries +5 s
    session = next(e for e in hub(ctl).of("event") if e.type == "session_finished")
    assert (session.session_id, session.kind, session.order) == ("race", SessionKind.RACE, [0, 1])
    (result,) = ctl.event_state.results
    rows = {r.address: r for r in result.classification}
    assert [r.address for r in result.classification] == [0, 1]
    assert rows[1].penalty_ms == 5000 and rows[0].penalty_ms == 0
    assert rows[1].total_time_ms is not None and rows[0].total_time_ms is not None
    assert rows[1].total_time_ms - rows[0].total_time_ms == 4800
    assert result.race_id is not None
    history = RaceStore(db)
    assert history.get_race(result.race_id)["winner_name"] == "Car 1"
    # A new controller on the same database sees the result.
    again = make_controller(tmp_path, FakeTrack(), store=history)
    assert again.event_state.results == ctl.event_state.results
    assert again.race_state().session is not None
    history.close()


async def test_rerun_replaces_the_session_result(tmp_path: Path) -> None:
    track = FakeTrack()
    ctl = make_controller(tmp_path, track)

    def run(winner: int, loser: int, base: int) -> list[Any]:
        script: list[Any] = [status(s) for s in (1, 2, 7, 0)]
        script += [Timer(winner, base), Timer(loser, base + 100)]
        script += [Timer(winner, base + 6000), Timer(loser, base + 6500)]
        return script

    async def body() -> None:
        await ctl.connect("simulator", None, persist=False)
        start(ctl, program(race(mode=RaceMode.LAPS, target_laps=1)))
        for item in run(0, 1, 1000):
            track.items.put_nowait(item)
        await wait_for(lambda: event_types(ctl).count("session_finished") == 1)
        assert ctl.event_state.results[0].classification[0].address == 0
        for item in run(1, 0, 50_000):
            track.items.put_nowait(item)
        await wait_for(lambda: event_types(ctl).count("session_finished") == 2)
        assert ctl.store.load_event_state().results == ctl.event_state.results

    await running(ctl, body)
    (result,) = ctl.event_state.results
    assert result.classification[0].address == 1


async def test_event_start_clears_results_and_keeps_assignments(tmp_path: Path) -> None:
    ctl = make_controller(tmp_path, FakeTrack())
    start(ctl, program(race()))

    def seed(state: Any) -> None:
        state.assignments = {0: "anna"}
        state.results = []

    ctl._update_event_state(seed)
    ctl.stop_event()
    ctl.start_event("cup")
    assert ctl.event_state.assignments == {0: "anna"}
    assert ctl.store.load_event_state().assignments == {0: "anna"}


# --------------------------------------------------------------------------- commentary facts


async def test_event_commentary_facts_from_program_drivers_and_grid(tmp_path: Path) -> None:
    store = RaceStore(":memory:")
    store.save_driver(Driver(id="anna", name="Anna", bio="Ten years old today."))
    ctl = make_controller(tmp_path, FakeTrack(), store=store)
    assert ctl._event_commentary() is None  # no event
    prog = program(
        SessionSpec(id="q", kind=SessionKind.QUALIFYING),
        race("r", grid_from="q"),
        commentary=CommentaryContext(event_name="Anna's party", tone="family", sponsors=["Gino"]),
    )
    start(ctl, prog)
    from app.race.models import ClassificationRow, SessionResult

    def seed(state: Any) -> None:
        state.assignments = {1: "anna"}
        state.current_index = 1
        state.results = [
            SessionResult(
                session_id="q",
                kind=SessionKind.QUALIFYING,
                classification=[
                    ClassificationRow(position=1, address=0, name="Marco", laps=3),
                    ClassificationRow(position=2, address=1, name="Anna", laps=3),
                ],
            )
        ]

    ctl._update_event_state(seed)
    info = ctl._event_commentary()
    assert info is not None
    assert info.tone == "family" and info.sponsors == ["Gino"]
    assert info.facts["event_name"] == "Anna's party"
    assert info.facts["drivers"] == [
        {"driver": "Marco", "starts_from": "P1"},
        {"driver": "Anna", "bio": "Ten years old today.", "car": "Car 2", "starts_from": "P2"},
    ]
