"""Real Control Unit adapter over carreralib (BLE first, serial fallback).

Threading design
----------------
carreralib is blocking and strictly request/response, so every call into it
(constructor, ``version()``, ``poll()``, button presses, ``close()``) happens on
ONE dedicated worker thread per connection attempt. The asyncio side never
touches the CU:

* commands (start / pace car / reset) are put on a ``queue.Queue`` together with
  a ``concurrent.futures.Future``; the worker executes them between polls and
  resolves the future, the async method awaits it via ``asyncio.wrap_future``
  (so errors propagate and the loop never blocks);
* the worker pushes converted :class:`~app.track.base.Timer` /
  :class:`~app.track.base.Status` messages into an ``asyncio.Queue`` using
  ``loop.call_soon_threadsafe``;
* the worker's idle wait after a Status is a ``Queue.get(timeout=...)`` on the
  command queue, so commands wake it immediately and Status polling runs at
  roughly 10-20 Hz. After a Timer it polls again at once (buffered timers are
  drained as fast as the CU answers);
* a single timeout / transient error is retried; ``max_failures`` consecutive
  failures mean link lost: the worker pushes a sentinel (next ``poll()`` raises
  :class:`TrackDisconnected`), marks the track disconnected and exits.

Note: carreralib's ``BLEConnection`` starts its bleak thread without a connect
timeout. If the CU never answers, ``connect()`` gives up after
``connect_timeout`` and abandons that (daemon) worker; carreralib's own bleak
thread may linger until the process exits.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import logging
import queue
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Literal

from carreralib import ControlUnit
from carreralib import connection as cl_connection

from app.track.base import (
    PollResult,
    Status,
    Timer,
    TrackConnectionError,
    TrackDisconnected,
    TrackErrorCode,
    check_controller_setting,
)

logger = logging.getLogger(__name__)

_DISCONNECTED = object()  # sentinel pushed into the async queue on link loss
_WAKE = object()  # sentinel on the command queue to wake / stop the worker

CONNECT_HINT = (
    "Check that the Control Unit is powered on, Bluetooth is enabled and in range, "
    "and that the Carrera phone app (or any other client) is closed: the Control "
    "Unit accepts only ONE BLE connection at a time."
)


def classify_error(exc: BaseException) -> TrackErrorCode:
    """Map a carreralib / bleak / pyserial / OS exception to a stable error code."""
    text = f"{type(exc).__name__} {exc}".lower()
    if isinstance(exc, PermissionError) or any(
        k in text for k in ("permission", "access is denied", "access denied")
    ):
        return "permission"
    if isinstance(exc, FileNotFoundError) or any(
        k in text for k in ("not found", "no such", "could not find", "cannot find", "not exist")
    ):
        return "not_found"
    if any(
        k in text
        for k in (
            "bluetooth is off",
            "bluetooth off",
            "powered off",
            "turned off",
            "adapter",
            "bluetooth is not",
            "bluetooth not",
            "bluetooth radio",
            "bluetooth device is turned",
        )
    ):
        return "bluetooth_off"
    if any(k in text for k in ("busy", "in use", "refused", "already connected", "already")):
        return "busy"
    if isinstance(exc, cl_connection.TimeoutError | TimeoutError | asyncio.TimeoutError) or any(
        k in text for k in ("timeout", "timed out")
    ):
        return "timeout"
    return "unknown"


def convert(res: Any) -> PollResult | None:
    """Convert a carreralib Timer/Status namedtuple to the base message types."""
    if res is None:
        return None
    if hasattr(res, "timestamp"):
        return Timer(address=int(res.address), timestamp=int(res.timestamp), sector=int(res.sector))
    if hasattr(res, "fuel"):
        return Status(
            fuel=tuple(int(f) for f in res.fuel),
            start=int(res.start),
            mode=int(res.mode),
            pit=tuple(bool(p) for p in res.pit),
            display=int(res.display),
        )
    return None


def _make_connection(address: str, mode: str) -> Any:
    """Build an explicit BLE or serial carreralib connection."""
    if mode == "ble":
        from carreralib.ble import BLEConnection

        return BLEConnection(address)
    from carreralib.serial import SerialConnection

    return SerialConnection(address)


class _Closed(Exception):
    """Internal: close() was called while connect() was in progress."""


@dataclass(eq=False)
class _Session:
    """Everything belonging to ONE connect attempt / worker thread.

    Keeping this per attempt means a late-finishing abandoned worker can never
    touch the state (queues, CU handle) of a newer attempt.
    """

    stop: threading.Event = field(default_factory=threading.Event)
    cmds: queue.Queue[Any] = field(default_factory=queue.Queue)
    out: asyncio.Queue[Any] = field(default_factory=asyncio.Queue)
    ready: concurrent.futures.Future[Any] = field(default_factory=concurrent.futures.Future)
    thread: threading.Thread | None = None
    cu: Any = None
    established: bool = False  # handshake succeeded (worker thread writes)
    lost: bool = False  # worker thread only
    lost_code: TrackErrorCode = "unknown"
    reason: str = "Connection closed"


class CarreraTrack:
    """TrackInterface implementation talking to a real Carrera Control Unit."""

    def __init__(
        self,
        address: str,
        mode: Literal["ble", "serial"] | None = None,
        *,
        max_failures: int = 3,
        connect_attempts: int = 3,
        connect_timeout: float = 10.0,
        backoff_base: float = 0.5,
        status_interval: float = 0.07,
        command_timeout: float = 5.0,
        close_timeout: float = 3.0,
    ) -> None:
        self.address = address
        self.mode = mode
        self._max_failures = max_failures
        self._connect_attempts = connect_attempts
        self._connect_timeout = connect_timeout
        self._backoff_base = backoff_base
        self._status_interval = status_interval
        self._command_timeout = command_timeout
        self._close_timeout = close_timeout

        self._session: _Session | None = None  # established (or lost) session
        self._connecting: _Session | None = None  # session of the attempt in flight
        self._close_gen = 0  # bumped by close(); connect() aborts if it changes
        self._connected = False
        self._loop: asyncio.AbstractEventLoop | None = None

    # -- properties -----------------------------------------------------------------

    @property
    def connected(self) -> bool:
        return self._connected

    @property
    def thread(self) -> threading.Thread | None:
        """The current worker thread (exposed for diagnostics and tests)."""
        return self._session.thread if self._session else None

    # -- connect --------------------------------------------------------------------

    async def connect(self) -> None:
        if self._connected:
            return
        self._loop = asyncio.get_running_loop()
        gen = self._close_gen
        old, self._session = self._session, None
        if old is not None:  # previous link was lost: tear it down, wake stale waiters
            self._stop_session(old, "Replaced by a new connection")
        last_error: BaseException | None = None
        try:
            for attempt in range(self._connect_attempts):
                if attempt:
                    await asyncio.sleep(self._backoff_base * 2 ** (attempt - 1))
                    if gen != self._close_gen:
                        raise _Closed
                try:
                    await self._attempt_connect(gen)
                    return
                except _Closed:
                    raise
                except Exception as exc:  # carreralib/bleak/serial raise many types
                    last_error = exc
                    logger.warning(
                        "CU connect attempt %d/%d failed: %r",
                        attempt + 1,
                        self._connect_attempts,
                        exc,
                    )
        except _Closed:
            raise TrackConnectionError("Connection cancelled: track was closed") from None
        raise TrackConnectionError(
            f"Could not connect to Control Unit at {self.address!r} after "
            f"{self._connect_attempts} attempts ({type(last_error).__name__}: {last_error}). "
            f"{CONNECT_HINT}",
            code=classify_error(last_error) if last_error is not None else "unknown",
        )

    async def _attempt_connect(self, gen: int) -> None:
        s = _Session()
        s.thread = threading.Thread(target=self._worker, args=(s,), name="carrera-cu", daemon=True)
        self._connecting = s
        s.thread.start()
        try:
            await asyncio.wait_for(asyncio.wrap_future(s.ready), self._connect_timeout)
            if gen != self._close_gen:
                raise _Closed
        except BaseException:
            if self._connecting is s:
                self._connecting = None
            self._stop_session(s, "Connect attempt abandoned")
            raise
        # No await between the generation check above and these assignments.
        self._connecting = None
        self._session = s
        self._connected = True

    # -- worker thread --------------------------------------------------------------

    def _push(self, s: _Session, item: Any) -> None:
        loop = self._loop
        if loop is None:
            return
        try:
            loop.call_soon_threadsafe(s.out.put_nowait, item)
        except RuntimeError:  # loop already closed
            pass

    def _open_cu(self) -> Any:
        if self.mode is None:
            return ControlUnit(self.address)
        return ControlUnit(_make_connection(self.address, self.mode))

    def _worker(self, s: _Session) -> None:
        try:
            try:
                s.cu = self._open_cu()
                version = s.cu.version()
            except BaseException as exc:
                try:
                    s.ready.set_exception(exc)
                except concurrent.futures.InvalidStateError:
                    pass  # connect() gave up (timeout / close)
                return
            if s.stop.is_set():  # abandoned while the constructor was running
                return
            try:
                s.ready.set_result(version)
            except concurrent.futures.InvalidStateError:
                return
            s.established = True
            self._loop_polling(s)
        except Exception as exc:  # unexpected worker failure: never die silently
            logger.exception("CU worker crashed")
            self._mark_lost(s, classify_error(exc))
        finally:
            if s.cu is not None:
                try:
                    s.cu.close()
                except Exception:
                    logger.debug("error closing CU", exc_info=True)
            self._fail_pending(s.cmds)
            if s.established and not s.stop.is_set():
                self._mark_lost(s, s.lost_code)  # no-op when already marked

    def _loop_polling(self, s: _Session) -> None:
        cu = s.cu
        failures = 0
        while not s.stop.is_set():
            self._run_commands(s)
            if s.stop.is_set():
                return
            try:
                res = cu.poll()
                failures = 0
            except Exception as exc:
                failures += 1
                logger.warning("CU poll failed (%d/%d): %r", failures, self._max_failures, exc)
                if failures >= self._max_failures:
                    self._mark_lost(s, classify_error(exc))
                    return
                time.sleep(0.05)
                continue
            msg = convert(res)
            if isinstance(msg, Timer):
                self._push(s, msg)
                continue  # drain buffered timers immediately
            if msg is not None:
                self._push(s, msg)
            # Status (or None): idle wait, woken early by a command
            try:
                item = s.cmds.get(timeout=self._status_interval)
            except queue.Empty:
                continue
            if item is not _WAKE:
                self._execute(cu, item)

    def _run_commands(self, s: _Session) -> None:
        while True:
            try:
                item = s.cmds.get_nowait()
            except queue.Empty:
                return
            if item is not _WAKE:
                self._execute(s.cu, item)

    @staticmethod
    def _execute(cu: Any, item: tuple[Callable[[Any], Any], Any]) -> None:
        fn, fut = item
        if not fut.set_running_or_notify_cancel():  # caller already gave up
            return
        try:
            result = fn(cu)
        except Exception as exc:
            logger.warning("CU command failed: %r", exc)
            fut.set_exception(
                TrackDisconnected(f"Command failed: {exc!r}", code=classify_error(exc))
            )
        else:
            fut.set_result(result)

    def _mark_lost(self, s: _Session, code: TrackErrorCode) -> None:
        """Worker thread: flag the link as lost and wake any poll() waiter (once)."""
        if s.lost:
            return
        s.lost = True
        s.lost_code = code
        s.reason = (
            f"Lost connection to the Control Unit ({self._max_failures} consecutive failures)"
        )
        logger.error("CU link lost: %s", s.reason)
        if self._session is s:
            self._connected = False
        self._push(s, _DISCONNECTED)

    @staticmethod
    def _fail_pending(cmds: queue.Queue[Any]) -> None:
        while True:
            try:
                item = cmds.get_nowait()
            except queue.Empty:
                return
            if item is not _WAKE and item[1].set_running_or_notify_cancel():
                item[1].set_exception(TrackDisconnected("Connection closed"))

    @staticmethod
    def _stop_session(s: _Session, reason: str) -> None:
        """Event-loop side: ask the worker to stop and wake poll() waiters on it."""
        s.reason = reason
        s.stop.set()
        s.cmds.put(_WAKE)
        s.out.put_nowait(_DISCONNECTED)
        try:  # abort a connect() still waiting for this session's handshake
            s.ready.set_exception(_Closed())
        except concurrent.futures.InvalidStateError:
            pass

    # -- TrackInterface -------------------------------------------------------------

    async def poll(self) -> PollResult:
        s = self._session
        if s is None:
            raise TrackDisconnected("Not connected to the Control Unit")
        item = await s.out.get()
        if item is _DISCONNECTED:
            s.out.put_nowait(_DISCONNECTED)  # keep raising on later polls
            raise TrackDisconnected(s.reason, code=s.lost_code)
        return item  # type: ignore[no-any-return]

    async def _command(self, fn: Callable[[Any], Any]) -> None:
        s = self._session
        if s is None or not self._connected:
            raise TrackDisconnected("Not connected to the Control Unit")
        fut: concurrent.futures.Future[Any] = concurrent.futures.Future()
        s.cmds.put((fn, fut))
        try:
            await asyncio.wait_for(asyncio.wrap_future(fut), self._command_timeout)
        except TimeoutError:
            raise TrackDisconnected(
                "Control Unit did not answer the command in time", code="timeout"
            ) from None

    async def start(self) -> None:
        await self._command(lambda cu: cu.start())

    async def toggle_pace_car(self) -> None:
        await self._command(lambda cu: cu.press(ControlUnit.PACE_CAR_ESC_BUTTON_ID))

    async def reset_timer(self) -> None:
        await self._command(lambda cu: cu.reset())

    async def set_speed(self, address: int, value: int) -> None:
        check_controller_setting(address, value)
        await self._command(lambda cu: cu.setspeed(address, value))

    async def set_brake(self, address: int, value: int) -> None:
        check_controller_setting(address, value)
        await self._command(lambda cu: cu.setbrake(address, value))

    async def set_fuel(self, address: int, value: int) -> None:
        check_controller_setting(address, value)
        await self._command(lambda cu: cu.setfuel(address, value))

    async def press_code(self) -> None:
        await self._command(lambda cu: cu.press(ControlUnit.CODE_BUTTON_ID))

    @staticmethod
    def _safe_close(cu: Any) -> None:
        try:
            cu.close()
        except Exception:
            logger.debug("forced close failed", exc_info=True)

    async def close(self) -> None:
        """Idempotent. Also aborts a connect() in progress and wakes pending poll()s."""
        self._close_gen += 1
        self._connected = False
        sessions = [s for s in (self._session, self._connecting) if s is not None]
        self._session = None
        self._connecting = None
        for s in sessions:  # synchronous: every waiter is woken before we await anything
            self._stop_session(s, "Connection closed")
        for s in sessions:
            thread = s.thread
            if thread is not None and thread.is_alive():
                await asyncio.to_thread(thread.join, self._close_timeout)
                if thread.is_alive() and s.cu is not None:
                    # CU unresponsive: try to unblock the stuck request by closing from here.
                    logger.warning(
                        "CU worker did not stop in %.1fs; forcing close", self._close_timeout
                    )
                    # Dedicated daemon thread: must not tie up the default executor.
                    threading.Thread(target=self._safe_close, args=(s.cu,), daemon=True).start()
            self._fail_pending(s.cmds)
