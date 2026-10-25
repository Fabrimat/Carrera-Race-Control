"""RaceController tests: reconnect/backoff, connect errors, start flows, persistence, throttle."""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

import pytest

from app.api.ws import WsHub
from app.commentary.llm import TemplateWriter
from app.config import AppConfig
from app.race.engine import RaceEngine
from app.race.models import (
    CarConfig,
    LayoutSensor,
    RaceConfig,
    RaceMode,
    RacePhase,
    Settings,
    TrackLayout,
    TrackRecord,
    TrackRecordInfo,
    TrackSettings,
)
from app.race.store import RaceStore
from app.service import ControllerError, RaceController, ScaledClock
from app.track.base import (
    MODE_FUEL,
    PollResult,
    Status,
    Timer,
    TrackConnectionError,
    TrackDisconnected,
)
from tests.test_commentary_fakes import FakeTTS

# --------------------------------------------------------------------------- helpers


def make_config(tmp_path: Path, **overrides: Any) -> AppConfig:
    """Hermetic config: explicit values beat whatever is in the developer's env / .env."""
    values: dict[str, Any] = {
        "_env_file": None,
        "data_dir": tmp_path / "data",
        "elevenlabs_api_key": None,
        "elevenlabs_voice_id": None,
        "anthropic_api_key": None,
        "replay_file": None,
        "commentary_lang": "it",
        "sim_cars": 3,
        "sim_time_scale": 50.0,
        "allowed_hosts": "127.0.0.1,localhost,testserver",
    }
    values.update(overrides)
    return AppConfig(**values)


class RecordingHub(WsHub):
    """Pretends one client is connected and records every broadcast with its time."""

    def __init__(self) -> None:
        super().__init__()
        self.messages: list[tuple[float, str, Any]] = []

    @property
    def client_count(self) -> int:
        return 1

    def broadcast(self, msg_type: str, data: Any) -> None:
        self.messages.append((time.monotonic(), msg_type, data))

    def of(self, msg_type: str) -> list[Any]:
        return [d for _, t, d in self.messages if t == msg_type]


def status(start: int = 0, fuel: int = 15, mode: int = MODE_FUEL) -> Status:
    return Status(fuel=(fuel,) * 8, start=start, mode=mode, pit=(False,) * 8)


class FakeTrack:
    """Scripted TrackInterface: ``poll()`` serves items from a queue.

    An item may be a message, an exception instance (raised), or a callable returning one.
    When the queue is empty ``poll()`` returns an idle Status every few ms.
    """

    def __init__(self, items: list[Any] | None = None, connect_errors: int = 0) -> None:
        self.items: asyncio.Queue[Any] = asyncio.Queue()
        for item in items or []:
            self.items.put_nowait(item)
        self.connect_errors = connect_errors
        self.connect_calls = 0
        self.close_calls = 0
        self.starts = 0
        self.paces = 0
        self.resets = 0
        self._connected = False
        self.idle_status = status(0)

    @property
    def connected(self) -> bool:
        return self._connected

    async def connect(self) -> None:
        self.connect_calls += 1
        if self.connect_errors > 0:
            self.connect_errors -= 1
            raise TrackConnectionError("CU not answering", code="timeout")
        self._connected = True

    async def poll(self) -> PollResult:
        try:
            item = self.items.get_nowait()
        except asyncio.QueueEmpty:
            await asyncio.sleep(0.005)
            return self.idle_status
        if isinstance(item, BaseException):
            self._connected = False
            raise item
        return item

    async def start(self) -> None:
        self.starts += 1

    async def toggle_pace_car(self) -> None:
        self.paces += 1

    async def reset_timer(self) -> None:
        self.resets += 1

    async def close(self) -> None:
        self.close_calls += 1
        self._connected = False


def make_controller(
    tmp_path: Path,
    track: FakeTrack | None = None,
    store: RaceStore | None = None,
    sleeps: list[float] | None = None,
    **kwargs: Any,
) -> RaceController:
    config = kwargs.pop("config", None) or make_config(tmp_path)

    async def fake_sleep(delay: float) -> None:
        if sleeps is not None:
            sleeps.append(delay)
        await asyncio.sleep(0)

    factory = (lambda mode, address: track) if track is not None else None
    return RaceController(
        config,
        store or RaceStore(":memory:"),
        hub=RecordingHub(),
        track_factory=factory,
        tts=FakeTTS(available=False),
        writer=TemplateWriter(),
        sleep=fake_sleep,
        **kwargs,
    )


async def wait_for(cond: Callable[[], bool], limit_s: float = 5.0) -> None:
    deadline = time.monotonic() + limit_s
    while not cond():
        if time.monotonic() > deadline:
            raise AssertionError("condition not met in time")
        await asyncio.sleep(0.01)


async def running(ctl: RaceController, body: Callable[[], Awaitable[None]]) -> None:
    await ctl.start(autoconnect=False)
    try:
        await body()
    finally:
        await ctl.shutdown()


def hub(ctl: RaceController) -> RecordingHub:
    assert isinstance(ctl.hub, RecordingHub)
    return ctl.hub


# --------------------------------------------------------------------------- tests


def test_scaled_clock_is_continuous_and_monotonic() -> None:
    now = [0.0]
    clock = ScaledClock(base=lambda: now[0])
    now[0] = 2.0
    assert clock() == 2.0
    clock.set_scale(10.0)
    assert clock() == 2.0
    now[0] = 3.0
    assert clock() == 12.0
    clock.set_scale(1.0)
    now[0] = 4.0
    assert clock() == 13.0


async def test_reconnects_with_backoff_after_disconnects(tmp_path: Path) -> None:
    track = FakeTrack([TrackDisconnected("link lost", code="timeout"), status(0)])
    # Reconnect #1 succeeds, then the link drops again right away (no message in between),
    # then one failed connect attempt, then it works.
    sleeps: list[float] = []
    ctl = make_controller(tmp_path, track, sleeps=sleeps, backoff=(0.1, 0.2, 0.4))

    async def body() -> None:
        await ctl.connect("simulator", None)
        await wait_for(lambda: track.connect_calls >= 2 and ctl.connection.status == "connected")
        # Second drop: poll raises again, first reconnect attempt fails, the next works.
        track.connect_errors = 1
        track.items.put_nowait(TrackDisconnected("link lost again"))
        await wait_for(lambda: track.connect_calls >= 4 and ctl.connection.status == "connected")

    await running(ctl, body)
    # Backoff restarts after a successful poll, then grows while reconnects keep failing.
    assert sleeps == [0.1, 0.1, 0.2]
    statuses = [c.status for c in hub(ctl).of("connection")]
    assert statuses[:2] == ["connecting", "connected"]
    assert "connecting" in statuses[2:]
    connecting = [c for c in hub(ctl).of("connection") if c.status == "connecting" and c.error]
    assert connecting[0].error == "link lost"
    assert connecting[0].error_code == "timeout"
    assert any(c.error == "CU not answering" for c in connecting)


async def test_backoff_keeps_growing_when_link_drops_right_after_reconnect(
    tmp_path: Path,
) -> None:
    drops = [TrackDisconnected("drop") for _ in range(3)]
    track = FakeTrack(drops)
    sleeps: list[float] = []
    ctl = make_controller(tmp_path, track, sleeps=sleeps, backoff=(1, 2, 4))

    async def body() -> None:
        await ctl.connect("simulator", None)
        await wait_for(lambda: track.connect_calls >= 4 and ctl.connection.status == "connected")
        await wait_for(lambda: ctl._reconnect_attempt == 0)

    await running(ctl, body)
    assert sleeps == [1, 2, 4]


async def test_user_disconnect_aborts_reconnect_loop(tmp_path: Path) -> None:
    track = FakeTrack([TrackDisconnected("gone")], connect_errors=0)
    sleeps: list[float] = []
    ctl = make_controller(tmp_path, track, sleeps=sleeps, backoff=(0.01,))

    async def body() -> None:
        await ctl.connect("simulator", None)
        track.connect_errors = 10**6  # never comes back
        await wait_for(lambda: len(sleeps) >= 3)
        info = await ctl.disconnect()
        assert info.status == "disconnected"
        assert ctl._poll_task is None
        n = len(sleeps)
        await asyncio.sleep(0.05)
        assert len(sleeps) == n  # reconnect loop really stopped

    await running(ctl, body)


async def test_connect_error_reports_status_and_code(tmp_path: Path) -> None:
    class BusyTrack(FakeTrack):
        async def connect(self) -> None:
            raise TrackConnectionError("Control Unit busy: close the Carrera app", code="busy")

    ctl = make_controller(tmp_path, BusyTrack())

    async def body() -> None:
        with pytest.raises(ControllerError) as err:
            await ctl.connect("ble", "AA:BB:CC:DD:EE:FF")
        assert err.value.status == 409
        assert "busy" in err.value.detail
        assert ctl.connection.status == "error"
        assert ctl.connection.error_code == "busy"
        assert ctl.connection.mode == "ble"

    await running(ctl, body)


async def test_connect_error_other_codes_are_503(tmp_path: Path) -> None:
    ctl = make_controller(tmp_path, FakeTrack(connect_errors=1))

    async def body() -> None:
        with pytest.raises(ControllerError) as err:
            await ctl.connect("serial", "COM3")
        assert err.value.status == 503
        assert ctl.connection.error_code == "timeout"

    await running(ctl, body)


async def test_address_required_for_ble(tmp_path: Path) -> None:
    ctl = make_controller(tmp_path, FakeTrack())
    with pytest.raises(ControllerError) as err:
        await ctl.connect("ble", None)
    assert err.value.status == 422


async def test_commands_require_connection(tmp_path: Path) -> None:
    ctl = make_controller(tmp_path, FakeTrack())
    with pytest.raises(ControllerError) as err:
        await ctl.start_race()
    assert err.value.status == 409
    with pytest.raises(ControllerError):
        await ctl.toggle_pace_car()


async def test_connect_persists_track_settings(tmp_path: Path) -> None:
    store = RaceStore(":memory:")
    ctl = make_controller(tmp_path, FakeTrack(), store=store)

    async def body() -> None:
        await ctl.connect("serial", "COM7")
        saved = store.load_settings()
        assert saved.track.mode == "serial"
        assert saved.track.address == "COM7"

    await running(ctl, body)


def test_fresh_settings_db_is_seeded_from_env_once(tmp_path: Path) -> None:
    store = RaceStore(tmp_path / "db.sqlite3")
    ctl = make_controller(
        tmp_path,
        store=store,
        config=make_config(
            tmp_path, commentary_lang="en", track_mode="serial", track_address="COM4"
        ),
    )
    assert ctl.settings.commentary.language == "en"
    assert ctl.settings.track.mode == "serial"
    assert ctl.settings.track.address == "COM4"
    assert ctl.settings.commentary.llm_enabled is False  # no Anthropic key configured
    # Later the persisted settings win over the env default.
    store.save_settings(Settings())
    ctl2 = make_controller(
        tmp_path, store=store, config=make_config(tmp_path, commentary_lang="en")
    )
    assert ctl2.settings.commentary.language == "it"
    store.close()


async def test_physical_start_creates_race_and_persists_laps(tmp_path: Path) -> None:
    store = RaceStore(":memory:")
    script: list[Any] = [status(s) for s in (1, 2, 3, 4, 5, 6, 7, 0)]
    script += [Timer(0, 1000), Timer(0, 7000), Timer(0, 13500)]
    track = FakeTrack(script)
    ctl = make_controller(tmp_path, track, store=store)

    async def body() -> None:
        await ctl.connect("simulator", None, persist=False)
        await wait_for(lambda: len(ctl.engine.laps) == 2)
        assert ctl.engine.race_id is not None
        detail = store.get_race(ctl.engine.race_id)
        assert detail is not None
        assert [lap["lap_ms"] for lap in detail["laps"]] == [6000, 6500]
        await ctl.stop_race()
        assert store.get_race(ctl.engine.race_id)["finished_at"] is not None

    await running(ctl, body)
    events = [e.type for e in hub(ctl).of("event")]
    assert events[0] == "race_started"
    assert events.count("lap_completed") == 2
    assert events[-1] == "race_finished"


async def test_start_falls_back_to_start_now_without_light_sequence(tmp_path: Path) -> None:
    track = FakeTrack()  # start() does nothing: no light sequence ever shows up
    ctl = make_controller(tmp_path, track, start_fallback_s=0.05)

    async def body() -> None:
        await ctl.connect("simulator", None, persist=False)
        state = await ctl.start_race(RaceConfig(mode=RaceMode.PRACTICE))
        assert state.phase is RacePhase.STARTING
        assert state.race_id is not None
        assert track.starts == 1
        await wait_for(lambda: ctl.engine.phase is RacePhase.RUNNING)

    await running(ctl, body)
    assert [e.type for e in hub(ctl).of("event")] == ["race_started"]


async def test_light_sequence_prevents_fallback(tmp_path: Path) -> None:
    track = FakeTrack()
    ctl = make_controller(tmp_path, track, start_fallback_s=0.05)

    async def body() -> None:
        await ctl.connect("simulator", None, persist=False)
        await ctl.start_race()
        track.items.put_nowait(status(1))
        track.items.put_nowait(status(2))
        track.idle_status = status(2)  # lights stay on (slow sequence)
        await asyncio.sleep(0.2)
        assert ctl.engine.phase is RacePhase.STARTING

    await running(ctl, body)


async def test_pace_car_toggles_pause_and_reset(tmp_path: Path) -> None:
    track = FakeTrack()
    ctl = make_controller(tmp_path, track, start_fallback_s=0.01)

    async def body() -> None:
        await ctl.connect("simulator", None, persist=False)
        await ctl.start_race()
        await wait_for(lambda: ctl.engine.phase is RacePhase.RUNNING)
        assert (await ctl.toggle_pace_car()).phase is RacePhase.PAUSED
        assert (await ctl.toggle_pace_car()).phase is RacePhase.RUNNING
        assert track.paces == 2
        state = await ctl.reset_race()
        assert state.phase is RacePhase.IDLE
        assert state.race_id is None
        assert track.resets == 1

    await running(ctl, body)


async def test_simulator_laps_race_finishes_and_is_stored(tmp_path: Path) -> None:
    store = RaceStore(":memory:")
    ctl = RaceController(
        make_config(tmp_path, sim_cars=3, sim_time_scale=50.0),
        store,
        hub=RecordingHub(),
        tts=FakeTTS(available=False),
        writer=TemplateWriter(),
        second_press_s=0.05,
    )

    async def body() -> None:
        await ctl.connect("simulator", None, persist=False)
        await ctl.start_race(RaceConfig(mode=RaceMode.LAPS, target_laps=3))
        await wait_for(lambda: ctl.engine.phase is RacePhase.FINISHED, limit_s=15)
        detail = store.get_race(ctl.engine.race_id)
        assert detail is not None
        assert detail["finished_at"] is not None
        assert detail["winner_name"] is not None
        assert len(detail["laps"]) == len(ctl.engine.laps) >= 3
        assert detail["results"][0]["position"] == 1

    await running(ctl, body)
    lines = hub(ctl).of("commentary")
    assert lines, "the commentator said something"
    assert all(line.audio_url is None for line in lines)  # TTS unavailable -> text only


async def test_state_broadcast_is_throttled(tmp_path: Path) -> None:
    ctl = RaceController(
        make_config(tmp_path, sim_cars=6, sim_time_scale=50.0),
        RaceStore(":memory:"),
        hub=RecordingHub(),
        tts=FakeTTS(available=False),
        writer=TemplateWriter(),
        second_press_s=0.05,
    )

    async def body() -> None:
        await ctl.connect("simulator", None, persist=False)
        await ctl.start_race(RaceConfig(mode=RaceMode.PRACTICE))
        await asyncio.sleep(1.5)

    await running(ctl, body)
    times = [t for t, kind, _ in hub(ctl).messages if kind == "state"]
    assert len(times) >= 5  # it does stream
    gaps = [b - a for a, b in zip(times, times[1:], strict=False)]
    assert min(gaps) >= 0.09  # <= 10 per second
    assert len(hub(ctl).of("event")) > len(times) / 3  # many events, coalesced states


async def test_shutdown_cancels_everything(tmp_path: Path) -> None:
    track = FakeTrack()
    ctl = make_controller(tmp_path, track)
    await ctl.start(autoconnect=False)
    await ctl.connect("simulator", None, persist=False)
    tasks = [*ctl._tasks, ctl._poll_task]
    await ctl.shutdown()
    assert all(t is not None and t.done() for t in tasks)
    assert track.close_calls >= 1
    await ctl.shutdown()  # idempotent


async def test_failed_start_command_leaves_no_stray_race(tmp_path: Path) -> None:
    class NoStartTrack(FakeTrack):
        async def start(self) -> None:
            raise TrackDisconnected("CU did not answer", code="timeout")

    store = RaceStore(":memory:")
    ctl = make_controller(tmp_path, NoStartTrack(), store=store)

    async def body() -> None:
        await ctl.connect("simulator", None, persist=False)
        with pytest.raises(ControllerError) as err:
            await ctl.start_race()
        assert err.value.status == 503
        assert ctl.engine.phase is RacePhase.IDLE
        assert ctl.engine.race_id is None
        assert ctl._watchdog is None
        races = store.list_races()
        assert len(races) == 1 and races[0]["finished_at"] is not None

    await running(ctl, body)


async def test_stop_awaits_the_cancelled_start_watchdog(tmp_path: Path) -> None:
    ctl = make_controller(tmp_path, FakeTrack(), start_fallback_s=10)

    async def body() -> None:
        await ctl.connect("simulator", None, persist=False)
        await ctl.start_race()
        watchdog = ctl._watchdog
        assert watchdog is not None and not watchdog.done()
        await ctl.stop_race()
        assert watchdog.done() and ctl._watchdog is None
        await ctl.start_race()
        watchdog = ctl._watchdog
        await ctl.disconnect()  # teardown also cancels and awaits it
        assert watchdog is not None and watchdog.done()

    await running(ctl, body)


async def test_absent_simulated_cars_get_no_fuel_or_low_fuel(tmp_path: Path) -> None:
    ctl = RaceController(
        make_config(tmp_path, sim_cars=2, sim_time_scale=50.0),
        RaceStore(":memory:"),
        hub=RecordingHub(),
        tts=FakeTTS(available=False),
        writer=TemplateWriter(),
        second_press_s=0.05,
    )

    async def body() -> None:
        await ctl.connect("simulator", None, persist=False)
        await ctl.start_race(RaceConfig(mode=RaceMode.PRACTICE))
        await wait_for(lambda: len(ctl.engine.laps) >= 4)

    await running(ctl, body)
    state = ctl.engine.state
    assert state.fuel_mode
    cars = {c.address: c for c in state.cars}
    assert cars[0].fuel is not None and cars[1].fuel is not None
    assert all(cars[a].fuel is None and cars[a].pit_stops == 0 for a in range(2, 6))
    events = hub(ctl).of("event")
    assert not [e for e in events if e.type in ("low_fuel", "pit_entry") and e.address >= 2]
    texts = " ".join(line.text for line in hub(ctl).of("commentary"))
    assert "Car 3" not in texts and "Car 4" not in texts


async def test_connect_while_race_active_closes_the_race(tmp_path: Path) -> None:
    store = RaceStore(":memory:")
    tracks = [FakeTrack(), FakeTrack()]
    ctl = make_controller(tmp_path, store=store, start_fallback_s=0.01)
    ctl._track_factory = lambda mode, address: tracks.pop(0)

    async def body() -> None:
        await ctl.connect("simulator", None, persist=False)
        await ctl.start_race()
        await wait_for(lambda: ctl.engine.phase is RacePhase.RUNNING)
        race_id = ctl.engine.race_id
        await ctl.connect("serial", "COM3", persist=False)
        assert ctl.engine.phase is RacePhase.FINISHED
        assert store.get_race(race_id)["finished_at"] is not None
        assert ctl.connection.status == "connected" and ctl.connection.mode == "serial"

    await running(ctl, body)
    assert [e.type for e in hub(ctl).of("event")][-1] == "race_finished"


async def test_reconnect_same_cu_domain_loses_no_lap(tmp_path: Path) -> None:
    store = RaceStore(":memory:")
    script: list[Any] = [status(s) for s in (1, 2, 3, 4, 5, 6, 7, 0)]
    script += [Timer(0, 4_000_000), Timer(0, 4_006_000)]  # one lap before the drop
    track = FakeTrack(script)
    ctl = make_controller(tmp_path, track, store=store, backoff=(0.01,))

    async def body() -> None:
        await ctl.connect("simulator", None, persist=False)
        await wait_for(lambda: len(ctl.engine.laps) == 1)
        # Plain BLE drop: the CU keeps running, its timestamps continue in the same domain.
        track.items.put_nowait(TrackDisconnected("link lost"))
        track.items.put_nowait(Timer(0, 4_012_500))
        track.items.put_nowait(Timer(0, 4_018_700))
        await wait_for(lambda: len(ctl.engine.laps) == 3)
        assert [lap.lap_ms for lap in ctl.engine.laps] == [6000, 6500, 6200]
        assert track.connect_calls == 2
        cars = {c.address: c for c in ctl.engine.state.cars}
        assert cars[0].laps == 3
        laps = store.get_race(ctl.engine.race_id)["laps"]
        assert [lap["lap_ms"] for lap in laps] == [6000, 6500, 6200]

    await running(ctl, body)


async def test_reconnect_after_cu_power_cycle_resyncs_the_clock(tmp_path: Path) -> None:
    store = RaceStore(":memory:")
    script: list[Any] = [status(s) for s in (1, 2, 3, 4, 5, 6, 7, 0)]
    script += [Timer(0, 4_000_000), Timer(0, 4_006_000)]  # one lap in the old domain
    track = FakeTrack(script)
    ctl = make_controller(tmp_path, track, store=store, backoff=(0.01,))

    async def body() -> None:
        await ctl.connect("simulator", None, persist=False)
        await wait_for(lambda: len(ctl.engine.laps) == 1)
        # CU power-cycled: link drops, clock restarts near 0.
        track.items.put_nowait(TrackDisconnected("power cycle"))
        track.items.put_nowait(Timer(0, 500))
        track.items.put_nowait(Timer(0, 6800))
        await wait_for(lambda: len(ctl.engine.laps) == 2)
        assert [lap.lap_ms for lap in ctl.engine.laps] == [6000, 6300]
        assert {c.address: c.laps for c in ctl.engine.state.cars}[0] == 2
        assert track.connect_calls == 2
        laps = store.get_race(ctl.engine.race_id)["laps"]
        assert [lap["lap_ms"] for lap in laps] == [6000, 6300]

    await running(ctl, body)


async def test_disconnect_aborts_a_pending_connect(tmp_path: Path) -> None:
    class HangingTrack(FakeTrack):
        def __init__(self) -> None:
            super().__init__()
            self.closed = asyncio.Event()

        async def connect(self) -> None:
            await self.closed.wait()  # like a BLE handshake that never answers
            raise TrackConnectionError("Connection cancelled: track was closed")

        async def close(self) -> None:
            await super().close()
            self.closed.set()

    ctl = make_controller(tmp_path, HangingTrack())

    async def body() -> None:
        pending = asyncio.create_task(ctl.connect("ble", "AA:BB:CC:DD:EE:FF"))
        await wait_for(lambda: ctl.connection.status == "connecting")
        started = time.monotonic()
        info = await ctl.disconnect()
        assert time.monotonic() - started < 1
        assert info.status == "disconnected"
        with pytest.raises(ControllerError) as err:
            await pending
        assert err.value.code == "connect_cancelled"
        assert ctl.connection.status == "disconnected"

    await running(ctl, body)


async def test_controller_errors_carry_codes(tmp_path: Path) -> None:
    ctl = make_controller(tmp_path, FakeTrack(connect_errors=1))
    with pytest.raises(ControllerError) as err:
        await ctl.start_race()
    assert err.value.code == "not_connected"
    with pytest.raises(ControllerError) as err:
        await ctl.connect("ble", "")
    assert err.value.code == "address_required"
    with pytest.raises(ControllerError) as err:
        await ctl.connect("serial", "COM1")
    assert err.value.code == "timeout"  # the track's own code is passed through


# --------------------------------------------------------------------------- track records


def _lap_script(*lap_ms: int, start: int = 1000) -> list[Any]:
    script: list[Any] = [status(s) for s in (1, 2, 3, 4, 5, 6, 7, 0)]
    t = start
    script.append(Timer(0, t))
    for ms in lap_ms:
        t += ms
        script.append(Timer(0, t))
    return script


def _record_events(ctl: RaceController) -> list[Any]:
    return [e for e in hub(ctl).of("event") if e.type == "track_record"]


async def test_first_valid_lap_sets_the_record_and_it_persists(tmp_path: Path) -> None:
    store = RaceStore(":memory:")
    ctl = make_controller(tmp_path, FakeTrack(_lap_script(6000, 6500, 5500)), store=store)

    async def body() -> None:
        await ctl.connect("ble", "AA:BB", persist=False)
        await wait_for(lambda: len(ctl.engine.laps) == 3)
        stored = store.get_record("default")
        assert stored is not None and stored.lap_ms == 5500
        assert stored.race_id == ctl.engine.race_id
        assert stored.address == 0
        assert ctl.race_state().track_record == stored
        assert ctl.snapshot().race.track_record == stored

    await running(ctl, body)
    events = _record_events(ctl)
    assert [(e.lap_ms, e.previous_ms) for e in events] == [(6000, None), (5500, 6000)]
    assert events[1].previous_holder


async def test_record_lap_orders_events_and_speaks_only_the_record(tmp_path: Path) -> None:
    ctl = make_controller(tmp_path, FakeTrack(_lap_script(6000, 5500)))

    async def body() -> None:
        await ctl.connect("ble", "AA:BB", persist=False)
        await wait_for(lambda: len(ctl.engine.laps) == 2)
        types = [e.type for e in hub(ctl).of("event")]
        assert types.index("best_lap") < len(types) - 1 - types[::-1].index("track_record")
        assert types.index("lap_completed") < types.index("best_lap")
        queued = [q.candidate.template_key for q in ctl.director._queue]
        assert "best_lap_overall" not in queued and "best_lap_personal" not in queued
        await wait_for(
            lambda: any(line.event_type == "track_record" for line in hub(ctl).of("commentary"))
        )

    await running(ctl, body)
    assert not any(line.event_type == "best_lap" for line in hub(ctl).of("commentary"))


async def test_slower_or_equal_lap_is_not_a_record(tmp_path: Path) -> None:
    store = RaceStore(":memory:")
    store.set_record(TrackRecordInfo(layout="default", lap_ms=6000, address=1, holder_name="Old"))
    ctl = make_controller(tmp_path, FakeTrack(_lap_script(6000, 7000)), store=store)

    async def body() -> None:
        await ctl.connect("ble", "AA:BB", persist=False)
        await wait_for(lambda: len(ctl.engine.laps) == 2)
        assert store.get_record("default").holder_name == "Old"
        assert ctl.race_state().track_record.holder_name == "Old"

    await running(ctl, body)
    assert _record_events(ctl) == []


async def test_beating_a_record_reports_previous_and_uses_nickname(tmp_path: Path) -> None:
    store = RaceStore(":memory:")
    store.set_record(TrackRecordInfo(layout="default", lap_ms=7000, address=1, holder_name="Old"))
    store.save_settings(
        Settings(cars=[CarConfig(address=0, name="Rossa", color="#e53935", nickname="Rocky")])
    )
    ctl = make_controller(tmp_path, FakeTrack(_lap_script(6000)), store=store)

    async def body() -> None:
        await ctl.connect("ble", "AA:BB", persist=False)
        await wait_for(lambda: len(ctl.engine.laps) == 1)
        assert store.get_record("default").holder_name == "Rocky"
        await wait_for(
            lambda: any(line.event_type == "track_record" for line in hub(ctl).of("commentary"))
        )

    await running(ctl, body)
    (event,) = _record_events(ctl)
    assert (event.previous_ms, event.previous_holder, event.lap_ms) == (7000, "Old", 6000)
    lines = hub(ctl).of("commentary")
    assert any(line.event_type == "track_record" for line in lines)
    assert not any(line.event_type == "best_lap" for line in lines)


async def test_invalid_laps_never_count(tmp_path: Path) -> None:
    store = RaceStore(":memory:")
    ctl = make_controller(tmp_path, FakeTrack(_lap_script(130_000)), store=store)

    async def body() -> None:
        await ctl.connect("ble", "AA:BB", persist=False)
        await wait_for(lambda: len(ctl.engine.laps) == 1)
        assert ctl.engine.laps[0].valid is False
        assert store.list_records() == []

    await running(ctl, body)
    assert _record_events(ctl) == []


async def test_no_record_without_a_stored_race(tmp_path: Path) -> None:
    ctl = make_controller(tmp_path, FakeTrack(_lap_script(6000)))
    original = ctl._new_race_in_store

    def no_race(config: RaceConfig) -> None:
        original(config)
        ctl.engine.race_id = None

    ctl._new_race_in_store = no_race  # type: ignore[method-assign]

    async def body() -> None:
        await ctl.connect("ble", "AA:BB", persist=False)
        await wait_for(lambda: len(ctl.engine.laps) == 1)
        assert ctl.store.list_records() == []

    await running(ctl, body)
    assert _record_events(ctl) == []


def test_changing_layout_switches_the_record(tmp_path: Path) -> None:
    store = RaceStore(":memory:")
    store.set_record(TrackRecordInfo(layout="loop", lap_ms=4000, address=0, holder_name="L"))
    ctl = make_controller(tmp_path, store=store)
    assert ctl.race_state().track_record is None
    settings = ctl.settings.model_copy(deep=True)
    settings.track.layout = "loop"
    ctl.update_settings(settings)
    assert ctl.race_state().track_record.lap_ms == 4000
    settings = settings.model_copy(deep=True)
    settings.track.layout = "other"
    ctl.update_settings(settings)
    assert ctl.race_state().track_record is None


async def test_connect_keeps_the_layout(tmp_path: Path) -> None:
    ctl = make_controller(tmp_path, FakeTrack())
    settings = ctl.settings.model_copy(deep=True)
    settings.track.layout = "loop"
    ctl.update_settings(settings)

    async def body() -> None:
        await ctl.connect("simulator", None)
        assert ctl.settings.track.layout == "loop"
        assert ctl.store.load_settings().track.layout == "loop"

    await running(ctl, body)


def test_first_record_is_announced_once_per_race(tmp_path: Path) -> None:
    ctl = make_controller(tmp_path)
    ctl.engine.race_id = 7
    first = TrackRecord(race_time_ms=1, address=0, lap_ms=5000, layout="x")
    assert ctl._announce_record(first) is True
    assert ctl._announce_record(first) is False
    ctl.engine.race_id = 8
    assert ctl._announce_record(first) is True
    beaten = first.model_copy(update={"previous_ms": 6000})
    assert ctl._announce_record(beaten) is True


def test_delete_record_clears_the_current_layout(tmp_path: Path) -> None:
    store = RaceStore(":memory:")
    store.set_record(TrackRecordInfo(layout="default", lap_ms=4000, address=0, holder_name="L"))
    ctl = make_controller(tmp_path, store=store)
    assert ctl.track_record is not None
    assert ctl.delete_record("nope") is False
    assert ctl.track_record is not None
    assert ctl.delete_record("default") is True
    assert ctl.track_record is None and store.get_record("default") is None


async def test_simulator_laps_never_become_a_record(tmp_path: Path) -> None:
    store = RaceStore(":memory:")
    ctl = make_controller(tmp_path, FakeTrack(_lap_script(6000, 5500)), store=store)

    async def body() -> None:
        await ctl.connect("simulator", None, persist=False)
        await wait_for(lambda: len(ctl.engine.laps) == 2)
        assert store.list_records() == []
        assert ctl.race_state().track_record is None

    await running(ctl, body)
    assert _record_events(ctl) == []


# --------------------------------------------------------------------------- second START press


class ArmingTrack(FakeTrack):
    """Behaves like a real CU: the first START arms (light 1), the second runs the countdown."""

    def __init__(self, armed_already: bool = False) -> None:
        super().__init__()
        self.idle_status = status(1 if armed_already else 0)
        self.armed = armed_already

    async def start(self) -> None:
        await super().start()
        if not self.armed:
            self.armed = True
            self.idle_status = status(1)
            return
        for light in (2, 3, 4, 5, 6, 7, 0):
            self.items.put_nowait(status(light))
        self.idle_status = status(0)


async def test_armed_cu_gets_a_second_press_and_runs(tmp_path: Path) -> None:
    track = ArmingTrack()
    ctl = make_controller(tmp_path, track, start_fallback_s=10, second_press_s=0.05)

    async def body() -> None:
        await ctl.connect("simulator", None, persist=False)
        await ctl.start_race()
        await wait_for(lambda: ctl.engine.phase is RacePhase.RUNNING)
        assert track.starts == 2

    await running(ctl, body)


async def test_already_armed_cu_is_not_pressed_twice(tmp_path: Path) -> None:
    track = ArmingTrack(armed_already=True)
    ctl = make_controller(tmp_path, track, start_fallback_s=10, second_press_s=0.2)

    async def body() -> None:
        await ctl.connect("simulator", None, persist=False)
        await asyncio.sleep(0.05)  # the armed status was polled
        await ctl.start_race()  # our single press starts the countdown
        await wait_for(lambda: ctl.engine.phase is RacePhase.RUNNING)
        await asyncio.sleep(0.4)
        assert track.starts == 1

    await running(ctl, body)


async def test_counting_cu_gets_no_second_press(tmp_path: Path) -> None:
    track = FakeTrack()
    track.idle_status = status(3)  # the first press already began the countdown
    ctl = make_controller(tmp_path, track, start_fallback_s=10, second_press_s=0.05)

    async def body() -> None:
        await ctl.connect("simulator", None, persist=False)
        await ctl.start_race()
        await wait_for(lambda: ctl._sequence_seen)
        await asyncio.sleep(0.2)
        assert track.starts == 1

    await running(ctl, body)


async def test_stop_during_the_wait_presses_nothing_and_cleans_up(tmp_path: Path) -> None:
    track = ArmingTrack()
    ctl = make_controller(tmp_path, track, start_fallback_s=10, second_press_s=0.2)

    async def body() -> None:
        await ctl.connect("simulator", None, persist=False)
        await ctl.start_race()
        await wait_for(lambda: ctl._last_status is not None and ctl._last_status.start == 1)
        watchdog = ctl._watchdog
        assert watchdog is not None and not watchdog.done()
        await ctl.stop_race()
        assert watchdog.done() and ctl._watchdog is None
        await asyncio.sleep(0.4)
        assert track.starts == 1

    await running(ctl, body)


async def test_stop_while_cu_stays_armed_does_not_restart(tmp_path: Path) -> None:
    store = RaceStore(":memory:")
    track = ArmingTrack()
    ctl = make_controller(tmp_path, track, store=store, start_fallback_s=10, second_press_s=0.05)

    async def body() -> None:
        await ctl.connect("simulator", None, persist=False)
        await ctl.start_race()
        await wait_for(lambda: ctl._last_status is not None and ctl._last_status.start == 1)
        race_id = ctl.engine.race_id
        await ctl.stop_race()
        assert ctl.engine.phase is RacePhase.FINISHED
        await asyncio.sleep(0.4)  # the armed CU keeps reporting light 1
        assert ctl.engine.phase is RacePhase.FINISHED
        assert ctl.engine.race_id == race_id
        assert len(store.list_races()) == 1
        assert track.starts == 1  # the second-press watchdog was cancelled with the stop
        assert [e.type for e in hub(ctl).of("event")].count("race_started") == 0

    await running(ctl, body)


def test_llm_defaults_on_for_a_fresh_db_with_an_anthropic_key(tmp_path: Path) -> None:
    store = RaceStore(tmp_path / "db.sqlite3")
    config = make_config(tmp_path, anthropic_api_key="k")
    ctl = make_controller(tmp_path, store=store, config=config)
    assert ctl.settings.commentary.llm_enabled is True
    # An explicit user choice is never flipped back.
    settings = store.load_settings()
    settings.commentary.llm_enabled = False
    store.save_settings(settings)
    ctl2 = make_controller(tmp_path, store=store, config=config)
    assert ctl2.settings.commentary.llm_enabled is False
    store.close()


def test_writer_depends_on_the_anthropic_key(tmp_path: Path) -> None:
    from app.commentary.llm import AnthropicWriter

    tts = FakeTTS(available=False)
    ctl = RaceController(make_config(tmp_path), RaceStore(":memory:"), tts=tts)
    assert isinstance(ctl.director._writer, TemplateWriter)
    config = make_config(tmp_path, anthropic_api_key="k")
    ctl = RaceController(config, RaceStore(":memory:"), tts=tts)
    assert isinstance(ctl.director._writer, AnthropicWriter)


# --------------------------------------------------------------------------- track layouts


def _layout(name: str = "default", *sensors: tuple[int, float]) -> TrackLayout:
    points = [(0.1 + 0.1 * i, 0.5 + (0.3 if i % 2 else 0.0)) for i in range(8)]
    return TrackLayout(
        name=name,
        points=points,
        sensors=[LayoutSensor(sensor=n, s=s) for n, s in sensors],
    )


async def test_race_state_carries_layout_name_and_live_positions(tmp_path: Path) -> None:
    store = RaceStore(":memory:")
    store.save_layout(_layout())
    script: list[Any] = [status(s) for s in (1, 2, 3, 4, 5, 6, 7, 0)]
    script += [Timer(0, 1000), Timer(0, 7000)]
    ctl = make_controller(tmp_path, FakeTrack(script), store=store)

    async def body() -> None:
        await ctl.connect("simulator", None, persist=False)
        await wait_for(lambda: len(ctl.engine.laps) == 1)
        state = ctl.race_state()
        assert state.layout == "default"
        pos = state.cars[0].track_pos
        assert pos is not None
        assert (pos.from_sensor, pos.to_sensor) == (1, 1)

    await running(ctl, body)


async def test_no_map_means_no_positions(tmp_path: Path) -> None:
    script: list[Any] = [status(s) for s in (1, 2, 3, 4, 5, 6, 7, 0)]
    script += [Timer(0, 1000), Timer(0, 7000)]
    ctl = make_controller(tmp_path, FakeTrack(script))

    async def body() -> None:
        await ctl.connect("simulator", None, persist=False)
        await wait_for(lambda: len(ctl.engine.laps) == 1)
        state = ctl.race_state()
        assert state.layout == "default"
        assert all(car.track_pos is None for car in state.cars)

    await running(ctl, body)


def _spy_declared(ctl: RaceController) -> list[list[int]]:
    calls: list[list[int]] = []
    ctl.engine.set_declared_sensors = calls.append  # type: ignore[method-assign]
    return calls


def test_declared_sensors_follow_the_layout_sorted_by_s(tmp_path: Path) -> None:
    store = RaceStore(":memory:")
    store.save_layout(_layout("default", (3, 0.3), (2, 0.6)))
    ctl = make_controller(tmp_path, store=store)
    assert ctl._layout is not None and ctl.engine.state.num_sectors >= 1
    calls = _spy_declared(ctl)

    ctl.save_layout(_layout("default", (2, 0.2), (3, 0.7)))
    assert calls[-1] == [2, 3]
    ctl.save_layout(_layout("other", (3, 0.5)))  # not the current layout: no change
    assert calls == [[2, 3]]
    ctl.update_settings(ctl.settings.model_copy(update={"track": TrackSettings(layout="other")}))
    assert calls[-1] == [3]
    ctl.delete_layout("other")
    assert calls[-1] == []


def test_declared_sensors_are_sent_at_startup(tmp_path: Path) -> None:
    store = RaceStore(":memory:")
    store.save_layout(_layout("default", (3, 0.3), (2, 0.6)))
    seen: list[list[int]] = []
    original = RaceEngine.set_declared_sensors
    RaceEngine.set_declared_sensors = lambda self, sensors: (  # type: ignore[method-assign]
        seen.append(list(sensors)),
        original(self, sensors),
    )[1]
    try:
        make_controller(tmp_path, store=store)
    finally:
        RaceEngine.set_declared_sensors = original  # type: ignore[method-assign]
    assert seen == [[3, 2]]


def test_layout_crud_errors(tmp_path: Path) -> None:
    ctl = make_controller(tmp_path)
    with pytest.raises(ControllerError) as info:
        ctl.get_layout("nope")
    assert (info.value.status, info.value.code) == (404, "layout_not_found")
    with pytest.raises(ControllerError) as info:
        ctl.delete_layout("nope")
    assert info.value.code == "layout_not_found"


class _SimWithLanes:
    def __init__(self, num_cars: int, time_scale: float, check_lanes: list[float] = ()) -> None:  # type: ignore[assignment]
        self.check_lanes = list(check_lanes)


class _SimWithoutLanes:
    def __init__(self, num_cars: int, time_scale: float) -> None:
        self.check_lanes: list[float] = []


def test_simulator_gets_check_lanes_from_env_then_layout(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import app.track.simulator as simulator

    monkeypatch.setattr(simulator, "SimulatorTrack", _SimWithLanes)
    store = RaceStore(":memory:")
    ctl = make_controller(
        tmp_path, store=store, config=make_config(tmp_path, sim_check_lanes="0.33, 0.66")
    )
    assert ctl._default_track("simulator", None).check_lanes == [0.33, 0.66]  # type: ignore[attr-defined]
    ctl.save_layout(_layout("default", (3, 0.7), (2, 0.2)))
    assert ctl._default_track("simulator", None).check_lanes == [0.2, 0.7]  # type: ignore[attr-defined]
    ctl.delete_layout("default")
    assert ctl._default_track("simulator", None).check_lanes == [0.33, 0.66]  # type: ignore[attr-defined]


def test_simulator_without_check_lane_support_is_still_built(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import app.track.simulator as simulator

    monkeypatch.setattr(simulator, "SimulatorTrack", _SimWithoutLanes)
    ctl = make_controller(tmp_path, config=make_config(tmp_path, sim_check_lanes="0.5"))
    assert isinstance(ctl._default_track("simulator", None), _SimWithoutLanes)


def test_invalid_sim_check_lanes_are_rejected(tmp_path: Path) -> None:
    for bad in ("0.3,0.5,0.7", "1.2", "0"):
        with pytest.raises(ValueError):
            make_config(tmp_path, sim_check_lanes=bad)


async def test_second_concurrent_photo_conversion_gets_photo_busy(tmp_path: Path) -> None:
    from types import SimpleNamespace

    from tests.test_vision import FakeMessages, b64, make_png, reply

    release = asyncio.Event()

    class Slow(FakeMessages):
        async def create(self, **kwargs: Any) -> Any:
            await release.wait()
            return await super().create(**kwargs)

    client = SimpleNamespace(messages=Slow(reply()))
    ctl = make_controller(tmp_path, vision_client=client)
    first = asyncio.create_task(ctl.layout_from_photo(b64(make_png()), "n", "en"))
    await asyncio.sleep(0.05)
    with pytest.raises(ControllerError) as info:
        await ctl.layout_from_photo(b64(make_png()), "n", "en")
    assert (info.value.status, info.value.code) == (429, "photo_busy")
    release.set()
    assert (await first).layout.source == "photo"
    # The lock is free again afterwards.
    assert (await ctl.layout_from_photo(b64(make_png()), "n", "en")).layout.name == "n"
