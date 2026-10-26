"""Simulated Carrera Control Unit.

Two layers:

* :class:`SimulatedCU` is a deterministic, sleep-free model driven by an explicit virtual time
  in milliseconds. It owns the random generator, the cars, the start light sequence, fuel/pit
  behaviour and the CU's 32-bit millisecond clock.
* :class:`SimulatorTrack` implements :class:`TrackInterface` on top of it, mapping real time
  (scaled by ``time_scale``) to virtual time. :meth:`SimulatorTrack.generate` exposes the same
  model as a plain generator so tests need neither sleeping nor an event loop.
"""

from __future__ import annotations

import asyncio
import heapq
import random
import time
from collections import deque
from collections.abc import Callable, Iterator

from app.track.base import (
    MAX_FUEL,
    MODE_FUEL,
    MODE_PIT_LANE,
    NUM_ADDRESSES,
    TIMESTAMP_MODULO,
    PollResult,
    Status,
    Timer,
    TrackDisconnected,
    check_controller_setting,
)

LIGHT_STEP_MS = 1000  # one start light per second
STATUS_INTERVAL_MS = 100
PIT_FUEL_LEVEL = 2  # cars pit when fuel drops to this level (or below)
SLOW_LAP_RATE = 0.03  # crash / deslot probability per lap
# A car deslots (stops at a point of a lap for DESLOT_MIN_MS..DESLOT_MAX_MS, then goes on)
# rarely; it has its own random stream so it never changes the other timings of a seed.
DESLOT_RATE = 0.004
DESLOT_MIN_MS = 10_000
DESLOT_MAX_MS = 25_000
# Controller settings (an assumption, the real CU's effect is to be verified on the track):
# speed 15 leaves the pace unchanged and every step below adds this much to the lap time.
SPEED_STEP_SLOWDOWN = 0.04
CODE_CROSSING_DELAY_MS = 2000  # press_code(): car 0 "answers" this long after (real time)
# Events that are shifted when a car is held (everything it would do on the track).
_CAR_TRACK_EVENTS = frozenset({"cross", "double", "sensor2", "sensor3"})


class _SimCar:
    def __init__(self, address: int, base_lap_ms: float) -> None:
        self.address = address
        self.base_lap_ms = base_lap_ms
        self.fuel = MAX_FUEL
        self.speed = MAX_FUEL  # controller speed setting, 15 = unchanged pace
        self.fuel_setting: int | None = None  # controller fuel setting, kept over a reset
        self.in_pit = False
        self.crossings = 0


class SimulatedCU:
    """Deterministic CU model. All times are virtual milliseconds since creation."""

    def __init__(
        self,
        num_cars: int,
        rng: random.Random,
        double_trigger_rate: float,
        fuel: bool,
        pit_lane: bool,
        clock_offset_ms: int,
        check_lanes: list[float] | None = None,
        deslot_rate: float = 0.0,
        deslot_rng: random.Random | None = None,
    ) -> None:
        self.rng = rng
        self.deslot_rate = deslot_rate
        self.deslot_rng = deslot_rng or random.Random()
        # Fractions of the lap where Check Lane sensors 2, 3 sit (index 0 -> sensor 2).
        self.check_lanes = list(check_lanes or [])
        self.double_trigger_rate = double_trigger_rate
        self.fuel = fuel
        self.pit_lane = pit_lane
        self.cars = [_SimCar(i, rng.uniform(5000, 8000)) for i in range(num_cars)]
        self.cu_offset = clock_offset_ms % TIMESTAMP_MODULO
        self.cu_zero = 0.0
        self.light = 0
        self.armed = False  # first START press seen (light 1 held)
        self.started = False  # countdown running or done
        self.paused_at: float | None = None
        self._heap: list[tuple[float, int, str, int]] = []
        self._frozen: list[tuple[float, str, int]] = []  # (remaining ms, kind, car)
        self._seq = 0

    # ---- helpers

    def cu_ts(self, t: float) -> int:
        return (self.cu_offset + int(t - self.cu_zero)) % TIMESTAMP_MODULO

    @property
    def mode(self) -> int:
        return (MODE_FUEL if self.fuel else 0) | (MODE_PIT_LANE if self.pit_lane else 0)

    def status(self) -> Status:
        fuel = [0] * NUM_ADDRESSES
        pit = [False] * NUM_ADDRESSES
        for car in self.cars:
            fuel[car.address] = car.fuel
            pit[car.address] = car.in_pit
        return Status(fuel=tuple(fuel), start=self.light, mode=self.mode, pit=tuple(pit))

    def _push(self, t: float, kind: str, arg: int) -> None:
        self._seq += 1
        heapq.heappush(self._heap, (t, self._seq, kind, arg))

    def _push_car_event(self, t: float, kind: str, arg: int) -> None:
        if self.paused_at is not None:
            self._frozen.append((t - self.paused_at, kind, arg))
        else:
            self._push(t, kind, arg)

    @property
    def next_event_time(self) -> float | None:
        return self._heap[0][0] if self._heap else None

    # ---- commands

    def set_speed(self, address: int, value: int) -> None:
        """Scale a car's pace from its next lap on (no-op for an address without a car)."""
        if address < len(self.cars):
            self.cars[address].speed = value

    def set_fuel(self, address: int, value: int) -> None:
        """Set the car's tank level at once (an assumption; no-op without a car)."""
        if address < len(self.cars):
            self.cars[address].fuel = self.cars[address].fuel_setting = value

    def schedule_crossing(self, t: float, address: int) -> None:
        """A single start/finish crossing of ``address`` at virtual time ``t``.

        Unlike a race crossing it starts no lap cycle: the car does not keep circulating.
        """
        self._push(t, "free_cross", address)

    def start(self, t: float) -> None:
        """Like the real CU: the first press arms (light 1 held), the second starts the
        countdown (lights 2..6, then 7 = go); presses while counting are ignored."""
        if self.started:
            return
        if not self.armed:
            self.armed = True
            self.light = 1
            return
        self.started = True
        for step in range(5):  # lights 2..6
            self._push(t + step * LIGHT_STEP_MS, "light", step + 2)
        self._push(t + 5 * LIGHT_STEP_MS, "light", 7)  # go
        self._push(t + 6 * LIGHT_STEP_MS, "light", 0)

    def pause(self, t: float) -> None:
        if self.paused_at is not None:
            return
        self.paused_at = t
        keep = []
        for entry in self._heap:
            when, _, kind, arg = entry
            if kind == "light":
                keep.append(entry)
            else:
                self._frozen.append((when - t, kind, arg))
        self._heap = keep
        heapq.heapify(self._heap)

    def resume(self, t: float) -> None:
        if self.paused_at is None:
            return
        self.paused_at = None
        frozen, self._frozen = self._frozen, []
        for remaining, kind, arg in frozen:
            self._push(t + remaining, kind, arg)

    def toggle_pause(self, t: float) -> None:
        if self.paused_at is None:
            self.pause(t)
        else:
            self.resume(t)

    def deslot(self, t: float, address: int, seconds: float) -> None:
        """Hold car ``address`` for ``seconds`` from virtual time ``t`` (it deslots, then goes on).

        Everything the car still has to do on the track (Check Lanes, the line) happens
        ``seconds`` later; a held car is also held while the pace car is out.
        """
        if not 0 <= address < len(self.cars):
            raise ValueError(f"no car {address}")
        delay = max(0.0, seconds) * 1000
        moved = []
        for when, seq, kind, arg in self._heap:
            if arg == address and kind in _CAR_TRACK_EVENTS:
                when = max(when, t) + delay
            moved.append((when, seq, kind, arg))
        self._heap = moved
        heapq.heapify(self._heap)
        self._frozen = [
            (
                remaining + delay if arg == address and kind in _CAR_TRACK_EVENTS else remaining,
                kind,
                arg,
            )
            for remaining, kind, arg in self._frozen
        ]

    def reset(self, t: float) -> None:
        self.cu_offset = 0
        self.cu_zero = t
        self.light = 0
        self.armed = False
        self.started = False
        self.paused_at = None
        self._heap.clear()
        self._frozen.clear()
        for car in self.cars:
            car.fuel = MAX_FUEL if car.fuel_setting is None else car.fuel_setting
            car.in_pit = False
            car.crossings = 0

    # ---- simulation

    def _lap_ms(self, car: _SimCar) -> float:
        lap = car.base_lap_ms * min(1.1, max(0.9, self.rng.gauss(1.0, 0.015)))
        lap *= 1 + SPEED_STEP_SLOWDOWN * (MAX_FUEL - car.speed)
        if self.rng.random() < SLOW_LAP_RATE:
            lap += self.rng.uniform(4000, 9000)
        if self.fuel and car.fuel == 0:
            lap *= 1.3
        return lap

    def _go(self, t: float) -> None:
        for car in self.cars:
            self._push_car_event(
                t + car.base_lap_ms * self.rng.uniform(0.1, 0.4), "cross", car.address
            )

    def _on_cross(self, t: float, car: _SimCar) -> None:
        car.crossings += 1
        if self.rng.random() < self.double_trigger_rate:
            self._push_car_event(t + self.rng.randint(8, 50), "double", car.address)
        extra = 0.0
        if car.crossings > 1 and self.fuel:
            car.fuel = max(0, car.fuel - self.rng.choice((1, 1, 2)))
            if self.pit_lane and car.fuel <= PIT_FUEL_LEVEL and not car.in_pit:
                car.in_pit = True
                extra = self.rng.uniform(3000, 5000)
                self._push_car_event(t + extra, "pit_end", car.address)
        lap = self._lap_ms(car)
        stop: tuple[float, float] | None = None  # (fraction of the lap, ms) of a deslot
        if self.deslot_rate and self.deslot_rng.random() < self.deslot_rate:
            stop = (
                self.deslot_rng.uniform(0.05, 0.95),
                self.deslot_rng.uniform(DESLOT_MIN_MS, DESLOT_MAX_MS),
            )
        for index, fraction in enumerate(self.check_lanes):
            # Per-passage jitter of about 1 % of the lap keeps the splits realistic.
            jitter = min(1.03, max(0.97, self.rng.gauss(1.0, 0.01)))
            at_fraction = min(fraction * jitter, 0.99)
            at = t + extra + lap * at_fraction
            if stop is not None and at_fraction > stop[0]:
                at += stop[1]
            self._push_car_event(at, f"sensor{index + 2}", car.address)
        self._push_car_event(t + lap + extra + (stop[1] if stop else 0.0), "cross", car.address)

    def advance(self, now: float) -> list[tuple[float, PollResult]]:
        """Process every event due at or before ``now``; returns (time, message) in order."""
        out: list[tuple[float, PollResult]] = []
        while self._heap and self._heap[0][0] <= now:
            t, _, kind, arg = heapq.heappop(self._heap)
            if kind == "light":
                self.light = arg
                out.append((t, self.status()))
                if arg == 7:
                    self._go(t)
            elif kind == "cross":
                out.append((t, Timer(address=arg, timestamp=self.cu_ts(t), sector=1)))
                self._on_cross(t, self.cars[arg])
            elif kind in ("sensor2", "sensor3"):
                out.append((t, Timer(address=arg, timestamp=self.cu_ts(t), sector=int(kind[-1]))))
            elif kind == "free_cross":
                out.append((t, Timer(address=arg, timestamp=self.cu_ts(t), sector=1)))
            elif kind == "double":
                out.append((t, Timer(address=arg, timestamp=self.cu_ts(t), sector=1)))
            elif kind == "pit_end":
                car = self.cars[arg]
                car.in_pit = False
                car.fuel = MAX_FUEL
        return out


class SimulatorTrack:
    """TrackInterface implementation backed by :class:`SimulatedCU`."""

    def __init__(
        self,
        num_cars: int = 4,
        seed: int | None = None,
        time_scale: float = 1.0,
        double_trigger_rate: float = 0.01,
        fuel: bool = True,
        pit_lane: bool = True,
        clock_offset_ms: int | None = None,
        clock: Callable[[], float] = time.monotonic,
        check_lanes: list[float] | None = None,
        deslot_rate: float = DESLOT_RATE,
    ) -> None:
        if not 1 <= num_cars <= 6:
            raise ValueError("num_cars must be between 1 and 6")
        if time_scale <= 0:
            raise ValueError("time_scale must be > 0")
        check_lanes = list(check_lanes or [])
        if len(check_lanes) > 2 or not all(0 < f < 1 for f in check_lanes):
            raise ValueError("check_lanes: at most two fractions, each strictly between 0 and 1")
        rng = random.Random(seed)
        if clock_offset_ms is None:
            clock_offset_ms = rng.randrange(TIMESTAMP_MODULO)
        self.time_scale = time_scale
        self._clock = clock
        self._t0: float | None = None
        self._core = SimulatedCU(
            num_cars,
            rng,
            double_trigger_rate,
            fuel,
            pit_lane,
            clock_offset_ms,
            check_lanes,
            deslot_rate,
            random.Random(seed),  # its own stream: a deslot never shifts other timings
        )
        self._queue: deque[PollResult] = deque()
        self._next_status = 0.0
        self._connected = False
        self._closed = False

    # ---- TrackInterface

    @property
    def connected(self) -> bool:
        return self._connected and not self._closed

    async def connect(self) -> None:
        self._connected = True
        self._closed = False
        if self._t0 is None:
            self._t0 = self._clock()

    def _now(self) -> float:
        if self._t0 is None:
            self._t0 = self._clock()
        return (self._clock() - self._t0) * 1000 * self.time_scale

    def _fill(self, now: float) -> None:
        for _, msg in self._core.advance(now):
            self._queue.append(msg)
        if now >= self._next_status:
            self._queue.append(self._core.status())
            self._next_status += STATUS_INTERVAL_MS
            if self._next_status <= now:
                self._next_status = now + STATUS_INTERVAL_MS

    async def poll(self) -> PollResult:
        while True:
            if self._closed:
                raise TrackDisconnected("simulator closed")
            if not self._queue:
                now = self._now()
                self._fill(now)
            if self._queue:
                # Timers first, otherwise the oldest message.
                for i, msg in enumerate(self._queue):
                    if isinstance(msg, Timer):
                        del self._queue[i]
                        return msg
                return self._queue.popleft()
            due = self._next_status
            nxt = self._core.next_event_time
            if nxt is not None:
                due = min(due, nxt)
            delay = max(0.0, (due - self._now()) / (1000 * self.time_scale))
            await asyncio.sleep(delay)

    async def start(self) -> None:
        now = self._now()
        self._fill(now)
        self._core.start(now)

    async def toggle_pace_car(self) -> None:
        now = self._now()
        self._fill(now)
        self._core.toggle_pause(now)

    def deslot(self, address: int, seconds: float, at_ms: float | None = None) -> None:
        """Make a car deslot now: it stands still for ``seconds`` (simulated time), then goes on.

        Deterministic, for tests and demos. ``at_ms`` is the virtual time to apply it at (for
        :meth:`generate`, which has its own virtual clock); default: the current time.
        """
        now = self._now() if at_ms is None else at_ms
        if at_ms is None:
            self._fill(now)
        self._core.deslot(now, address, seconds)

    async def reset_timer(self) -> None:
        now = self._now()
        self._core.reset(now)
        self._queue.clear()

    async def set_speed(self, address: int, value: int) -> None:
        """Scales the car's pace from its next lap (15 = unchanged, -4 % per step below)."""
        check_controller_setting(address, value)
        self._core.set_speed(address, value)

    async def set_brake(self, address: int, value: int) -> None:
        """Accepted and ignored (the simulated cars do not brake)."""
        check_controller_setting(address, value)

    async def set_fuel(self, address: int, value: int) -> None:
        """Sets the car's tank level at once (an assumption, see SPEED_STEP_SLOWDOWN)."""
        check_controller_setting(address, value)
        self._core.set_fuel(address, value)

    async def press_code(self) -> None:
        """Pairing: car 0 crosses the line about 2 s later (the flow works while idle)."""
        now = self._now()
        self._fill(now)
        self._core.schedule_crossing(now + CODE_CROSSING_DELAY_MS * self.time_scale, 0)

    def cross(self, address: int, at_ms: float | None = None) -> None:
        """Deterministic test hook: one start/finish crossing of ``address`` (0..5) now.

        ``at_ms`` is the virtual time to apply it at (for :meth:`generate`).
        """
        if not 0 <= address < 6:
            raise ValueError("address must be between 0 and 5")
        now = self._now() if at_ms is None else at_ms
        if at_ms is None:
            self._fill(now)
        self._core.schedule_crossing(now, address)

    async def close(self) -> None:
        self._closed = True

    # ---- deterministic, sleep-free driver for tests

    def generate(
        self, status_interval_ms: int = STATUS_INTERVAL_MS, auto_start: bool = True
    ) -> Iterator[tuple[float, PollResult]]:
        """Infinite (virtual time ms, message) stream; starts the light sequence at t=0.

        Do not mix with :meth:`poll` on the same instance.
        """
        if auto_start:
            self._core.start(0.0)  # arm
            self._core.start(0.0)  # countdown
        t = 0.0
        while True:
            yield from self._core.advance(t)
            yield t, self._core.status()
            t += status_interval_ms
