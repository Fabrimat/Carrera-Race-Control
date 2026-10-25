import asyncio
import threading
import time
from collections import namedtuple

import pytest
from carreralib import connection as cl_connection

from app.track import carrera, scan
from app.track.base import Status, Timer, TrackConnectionError, TrackDisconnected, TrackInterface
from app.track.carrera import CarreraTrack, classify_error

FakeTimer = namedtuple("FakeTimer", "address timestamp sector")
FakeStatus = namedtuple("FakeStatus", "fuel start mode pit display")


def status(start=0):
    return FakeStatus([15] * 8, start, 5, tuple([False] * 8), 6)


class FakeCU:
    """Scriptable stand-in for carreralib.ControlUnit; records the calling threads."""

    PACE_CAR_ESC_BUTTON_ID = 1
    instances: list["FakeCU"] = []
    script: list = []  # items returned by poll(); exceptions are raised
    init_failures = 0
    default = staticmethod(status)

    def __init__(self, device, **kwargs):
        cls = type(self)
        if cls.init_failures > 0:
            cls.init_failures -= 1
            raise cl_connection.TimeoutError("Timeout waiting for BLE connection")
        self.device = device
        self.threads: set[int] = {threading.get_ident()}
        self.calls: list[str] = []
        self.closed = threading.Event()
        self.in_call = False
        self.overlap = False
        cls.instances.append(self)

    def _enter(self, name):
        if self.in_call:
            self.overlap = True
        self.in_call = True
        self.threads.add(threading.get_ident())
        self.calls.append(name)

    def _exit(self):
        self.in_call = False

    def version(self):
        self._enter("version")
        self._exit()
        return "1337"

    def poll(self):
        self._enter("poll")
        try:
            time.sleep(0.001)
            if FakeCU.script:
                item = FakeCU.script.pop(0)
                if isinstance(item, BaseException):
                    raise item
                return item
            return FakeCU.default()
        finally:
            self._exit()

    def start(self):
        self._enter("start")
        self._exit()

    def press(self, button):
        self._enter(f"press{button}")
        self._exit()

    def reset(self):
        self._enter("reset")
        self._exit()

    def close(self):
        self.closed.set()


@pytest.fixture(autouse=True)
def fake_cu(monkeypatch):
    FakeCU.instances = []
    FakeCU.script = []
    FakeCU.init_failures = 0
    FakeCU.default = staticmethod(status)
    monkeypatch.setattr(carrera, "ControlUnit", FakeCU)
    return FakeCU


def make(**kw):
    kw.setdefault("status_interval", 0.005)
    kw.setdefault("backoff_base", 0.001)
    return CarreraTrack("AA:BB:CC:DD:EE:FF", **kw)


def cu_threads():
    return [t for t in threading.enumerate() if t.name == "carrera-cu"]


def raise_timeout():
    raise cl_connection.TimeoutError("t")


async def test_protocol_and_connect():
    track = make()
    assert isinstance(track, TrackInterface)
    assert not track.connected
    await track.connect()
    assert track.connected
    assert FakeCU.instances[0].device == "AA:BB:CC:DD:EE:FF"
    assert FakeCU.instances[0].calls[0] == "version"
    await track.close()
    assert not cu_threads()


async def test_converts_timer_and_status():
    FakeCU.script = [FakeTimer(2, 123456, 1), status(start=3)]
    track = make()
    await track.connect()
    t = await track.poll()
    s = await track.poll()
    assert t == Timer(address=2, timestamp=123456, sector=1)
    assert isinstance(s, Status)
    assert s.start == 3 and s.fuel == (15,) * 8 and s.mode == 5
    assert s.pit == (False,) * 8 and isinstance(s.fuel, tuple)
    await track.close()


async def test_status_is_throttled_timers_are_not():
    track = make(status_interval=0.05)
    await track.connect()
    t0 = time.monotonic()
    for _ in range(5):
        assert isinstance(await track.poll(), Status)
    assert time.monotonic() - t0 >= 0.15  # ~50 ms between statuses
    await track.close()

    FakeCU.script = [FakeTimer(0, i, 1) for i in range(20)]
    track = make(status_interval=0.2)
    await track.connect()
    t0 = time.monotonic()
    got = [await track.poll() for _ in range(20)]
    assert all(isinstance(m, Timer) for m in got)
    assert time.monotonic() - t0 < 0.5  # no throttling between timers
    await track.close()


async def test_commands_run_on_worker_thread_serialized():
    track = make()
    await track.connect()
    cu = FakeCU.instances[0]
    await track.start()
    await track.toggle_pace_car()
    await track.reset_timer()
    assert {"start", "press1", "reset"} <= set(cu.calls)
    await asyncio.sleep(0.05)
    await track.close()
    assert len(cu.threads) == 1
    assert threading.get_ident() not in cu.threads
    assert not cu.overlap


async def test_single_timeout_is_retried():
    FakeCU.script = [cl_connection.TimeoutError("t"), FakeTimer(1, 5, 1)]
    track = make()
    await track.connect()
    assert await track.poll() == Timer(1, 5, 1)
    assert track.connected
    await track.close()


async def test_consecutive_failures_raise_disconnected():
    FakeCU.default = staticmethod(raise_timeout)
    track = make(max_failures=3)
    await track.connect()
    with pytest.raises(TrackDisconnected) as ei:
        await track.poll()
    assert ei.value.code == "timeout"
    assert not track.connected
    with pytest.raises(TrackDisconnected):
        await track.poll()
    with pytest.raises(TrackDisconnected):
        await track.start()
    await track.close()
    assert FakeCU.instances[0].closed.is_set()
    assert not cu_threads()


async def test_connect_retries_then_succeeds():
    FakeCU.init_failures = 2
    track = make()
    await track.connect()
    assert track.connected
    await track.close()


async def test_connect_failure_message_and_code():
    FakeCU.init_failures = 99
    track = make()
    with pytest.raises(TrackConnectionError) as ei:
        await track.connect()
    msg = str(ei.value)
    assert "only ONE BLE connection" in msg and "phone app" in msg and "Bluetooth" in msg
    assert ei.value.code == "timeout"
    assert FakeCU.init_failures == 99 - 3  # exactly 3 attempts
    assert not track.connected
    await track.close()


async def test_connect_timeout_when_cu_hangs(monkeypatch):
    release = threading.Event()

    class Hanging(FakeCU):
        def __init__(self, device, **kw):
            release.wait(5)
            raise OSError("never")

    monkeypatch.setattr(carrera, "ControlUnit", Hanging)
    track = make(connect_attempts=1, connect_timeout=0.05)
    t0 = time.monotonic()
    with pytest.raises(TrackConnectionError) as ei:
        await track.connect()
    assert time.monotonic() - t0 < 1
    assert ei.value.code == "timeout"
    release.set()
    await track.close()


async def test_close_idempotent_and_nonblocking():
    track = make()
    await track.connect()
    await track.close()
    await track.close()
    assert not track.connected
    with pytest.raises(TrackDisconnected):
        await track.poll()
    await make().close()  # never connected


async def test_close_does_not_hang_when_cu_unresponsive():
    unblock = threading.Event()

    def hang():
        unblock.wait(10)
        return status()

    FakeCU.default = staticmethod(hang)
    track = make(close_timeout=0.1)
    await track.connect()
    await asyncio.sleep(0.05)
    t0 = time.monotonic()
    await track.close()
    assert time.monotonic() - t0 < 1.5
    unblock.set()
    for t in cu_threads():
        await asyncio.to_thread(t.join, 2)
    assert not cu_threads()


async def test_loop_stays_responsive():
    track = make()
    await track.connect()
    ticks = 0

    async def ticker():
        nonlocal ticks
        while True:
            await asyncio.sleep(0.005)
            ticks += 1

    task = asyncio.create_task(ticker())
    for _ in range(10):
        await track.poll()
    task.cancel()
    assert ticks >= 3
    await track.close()


@pytest.mark.parametrize(
    ("exc", "code"),
    [
        (PermissionError(13, "Access is denied"), "permission"),
        (FileNotFoundError(2, "No such file or directory"), "not_found"),
        (Exception("Device with address AA:BB was not found"), "not_found"),
        (Exception("Bluetooth device is turned off"), "bluetooth_off"),
        (Exception("No Bluetooth adapters found"), "bluetooth_off"),
        (OSError("Device or resource busy"), "busy"),
        (ConnectionRefusedError("refused"), "busy"),
        (cl_connection.TimeoutError("x"), "timeout"),
        (TimeoutError(), "timeout"),
        (RuntimeError("weird"), "unknown"),
    ],
)
def test_classify_error(exc, code):
    assert classify_error(exc) == code


async def test_command_error_propagates_with_code():
    track = make()
    await track.connect()

    def deny():
        raise PermissionError("denied")

    FakeCU.instances[0].start = deny
    with pytest.raises(TrackDisconnected) as ei:
        await track.start()
    assert ei.value.code == "permission"
    await track.close()


async def test_scan_devices(monkeypatch):
    monkeypatch.setattr(scan, "_ble_scan", lambda: [("AA:BB:CC:DD:EE:FF", "Control_Unit")])
    monkeypatch.setattr(scan, "_serial_scan", lambda: [("COM3", "USB Serial")])
    devices = await scan.scan_devices(timeout=2)
    assert {(d.kind, d.address) for d in devices} == {
        ("ble", "AA:BB:CC:DD:EE:FF"),
        ("serial", "COM3"),
    }


async def test_scan_survives_failure_and_timeout(monkeypatch):
    def boom():
        raise RuntimeError("no adapter")

    def slow():
        time.sleep(0.5)
        return [("X", "late")]

    monkeypatch.setattr(scan, "_ble_scan", boom)
    monkeypatch.setattr(scan, "_serial_scan", slow)
    assert await scan.scan_devices(timeout=0.1) == []


class SlowFirstCU(FakeCU):
    """First constructor call blocks until released, later ones are immediate."""

    release = threading.Event()
    calls = 0

    def __init__(self, device, **kw):
        type(self).calls += 1
        if type(self).calls == 1:
            type(self).release.wait(5)
        super().__init__(device, **kw)


def joinable_threads():
    return [t for t in cu_threads()]


async def join_all_cu_threads():
    for t in joinable_threads():
        await asyncio.to_thread(t.join, 2)


async def test_close_during_backoff_aborts_connect():
    FakeCU.init_failures = 1
    track = make(backoff_base=0.3)
    task = asyncio.create_task(track.connect())
    await asyncio.sleep(0.1)  # first attempt failed, now sleeping in backoff
    await track.close()
    with pytest.raises(TrackConnectionError):
        await task
    assert not track.connected
    await join_all_cu_threads()
    assert not cu_threads()
    assert not FakeCU.instances  # no second attempt was started


async def test_close_during_pending_handshake_aborts_connect(monkeypatch):
    SlowFirstCU.release = threading.Event()
    SlowFirstCU.calls = 0
    SlowFirstCU.instances = []
    monkeypatch.setattr(carrera, "ControlUnit", SlowFirstCU)
    track = make(connect_timeout=5, close_timeout=0.1)
    task = asyncio.create_task(track.connect())
    await asyncio.sleep(0.1)  # constructor still blocked
    await track.close()
    with pytest.raises(TrackConnectionError):
        await task
    assert not track.connected
    SlowFirstCU.release.set()  # late constructor finishes: worker must clean up
    await join_all_cu_threads()
    assert not cu_threads()
    assert not track.connected
    assert all(cu.closed.is_set() for cu in SlowFirstCU.instances)


async def test_close_wakes_blocked_poll_with_hung_cu():
    unblock = threading.Event()

    def hang():
        unblock.wait(10)
        return status()

    FakeCU.default = staticmethod(hang)
    track = make(close_timeout=0.1)
    await track.connect()
    poller = asyncio.create_task(track.poll())
    await asyncio.sleep(0.05)
    assert not poller.done()
    t0 = time.monotonic()
    await track.close()
    with pytest.raises(TrackDisconnected):
        await asyncio.wait_for(poller, 1)
    assert time.monotonic() - t0 < 1.5
    unblock.set()
    await join_all_cu_threads()


async def test_command_timeout_does_not_kill_worker():
    release = threading.Event()
    track = make(command_timeout=0.05)
    await track.connect()

    def slow(cu):
        release.wait(5)

    with pytest.raises(TrackDisconnected) as ei:
        await track._command(slow)
    assert ei.value.code == "timeout"
    release.set()
    assert isinstance(await asyncio.wait_for(track.poll(), 2), Status)
    assert track.connected
    await track.start()  # worker still serves commands
    await track.close()


async def test_worker_crash_is_reported_as_disconnect(monkeypatch):
    def boom(res):
        raise RuntimeError("bug")

    track = make()
    # Patch before connecting: otherwise the worker may already have converted (and queued)
    # a Status by the time the patch lands, and poll() would return it instead of crashing.
    monkeypatch.setattr(carrera, "convert", boom)
    await track.connect()
    with pytest.raises(TrackDisconnected):
        await asyncio.wait_for(track.poll(), 2)
    assert not track.connected
    await track.close()


async def test_late_first_attempt_does_not_clobber_second(monkeypatch):
    SlowFirstCU.release = threading.Event()
    SlowFirstCU.calls = 0
    SlowFirstCU.instances = []
    monkeypatch.setattr(carrera, "ControlUnit", SlowFirstCU)
    track = make(connect_timeout=0.1)
    await track.connect()  # attempt 1 times out, attempt 2 succeeds
    assert track.connected
    SlowFirstCU.release.set()  # attempt 1 constructor now finishes late
    await asyncio.sleep(0.1)
    assert track.connected
    assert isinstance(await asyncio.wait_for(track.poll(), 2), Status)
    # the abandoned worker closed its own CU; the live one is still open
    closed = [cu.closed.is_set() for cu in SlowFirstCU.instances]
    assert sorted(closed) == [False, True]
    await track.close()
    assert all(closed_cu.closed.is_set() for closed_cu in SlowFirstCU.instances)
    await join_all_cu_threads()
