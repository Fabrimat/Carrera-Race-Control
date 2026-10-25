"""Race engine: turns raw Control Unit messages into :class:`RaceState` and domain events.

Pure logic: no IO, no asyncio. The controller feeds it ``Timer``/``Status`` messages via
:meth:`RaceEngine.handle` and calls :meth:`RaceEngine.tick` periodically.

Design notes
------------
* **Clock.** The CU buffers timers, so poll arrival time is *not* crossing time. All inter-car
  math (lap times, ordering, gaps, ``total_time_ms``) uses CU timestamps only. The CU timestamp
  is mapped to race time through ``cu_origin``, anchored once at the first Timer after go:
  ``cu_origin = ts - host_ms_since_go``. Between crossings the race clock is extrapolated from
  the injected host clock (monotonic clamp: it never goes backwards; crossings only re-sync it
  forward). Before the first Timer the race clock is host time elapsed since go. After a
  reconnect (``resync_clock``) the next Timer is checked against the race clock: if the CU
  was power-cycled (new timestamp domain) ``cu_origin`` is re-anchored on the race clock and
  each car's next crossing only sets a new reference; a plain link drop changes nothing.
* **Phases.** ``prepare()`` -> STARTING; the engine goes RUNNING when it sees ``Status.start``
  reach 0 or 7 after having been 1..6. Timers in STARTING/IDLE/FINISHED are ignored. Laps keep
  counting (and events keep flowing) while PAUSED: in Carrera the pace car does not stop timing.
* **Cars in the state.** Every configured car with address 0..5 (placed or not), plus any car
  that has crossed the line (e.g. a configured pace-car address 6/7 or an unconfigured one).
  Timers from addresses 6/7 are ignored unless that address is configured in ``cars``.
  Fuel and pit data are only tracked once a car has crossed the line (the CU reports fuel 0
  for empty slots), so ``fuel`` stays None and no LowFuel/Pit events fire for absent cars.
* **BestLap events.** A new overall record emits one ``overall=True`` event (``previous_ms`` =
  the old record), even on a car's first valid lap; only the very first valid lap of the whole
  race is silent. Personal-best events (``overall=False``) are emitted only when a lap improves
  an existing personal best, so a car's first lap never produces one.
* **Finishing.** LAPS: when the leader completes ``target_laps`` the race enters a "finishing"
  state; every other car is marked ``finished`` on its next crossing (that lap is counted).
  TIMED: finishing starts at the first crossing after the duration (or at ``tick`` past it).
  ``RaceFinished`` fires when every car that has crossed the line is finished, or after a grace
  time of 1.25x the slowest personal best lap (``max_lap_ms`` if none) has passed.
  PRACTICE never finishes by itself.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass, field

from app.race.models import (
    BestLap,
    BestLapRecord,
    CarConfig,
    CarState,
    Idle,
    Lap,
    LapCompleted,
    LowFuel,
    PitEntry,
    PitExit,
    PositionChange,
    RaceConfig,
    RaceEvent,
    RaceFinished,
    RaceMode,
    RacePhase,
    RaceStarted,
    RaceState,
    default_cars,
)
from app.track.base import (
    MODE_FUEL,
    MODE_PIT_LANE,
    TIMESTAMP_MODULO,
    Status,
    Timer,
    ts_diff,
)

_HALF_MODULO = TIMESTAMP_MODULO // 2


# Consecutive Status frames (~180 ms each on the real CU) needed to confirm a pit change.
PIT_CONFIRM_FRAMES = 2


@dataclass
class _Car:
    address: int
    laps: int = 0
    last_ts: int | None = None  # CU timestamp of the last counted crossing (None = not crossed)
    last_lap_ms: int | None = None
    best_lap_ms: int | None = None
    valid_sum: int = 0
    valid_count: int = 0
    lap_times: list[int] = field(default_factory=list)
    total_time_ms: int | None = None
    fuel: int | None = None
    in_pit: bool = False
    pit_entered_ms: int = 0
    pit_change_ms: int | None = None  # race time of the first frame of a pending pit change
    pit_change_frames: int = 0
    pit_stops: int = 0
    low_fuel_armed: bool = True
    finished: bool = False

    @property
    def crossed(self) -> bool:
        return self.last_ts is not None


class RaceEngine:
    def __init__(
        self,
        cars: list[CarConfig],
        config: RaceConfig | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._clock = clock
        self.config = config or RaceConfig()
        self.race_id: int | None = None
        self._configs: dict[int, CarConfig] = {c.address: c for c in cars}
        self._phase = RacePhase.IDLE
        # Light level (1..6) that was showing when the race was stopped / reset: a CU that keeps
        # reporting it has not been pressed again, so it must not auto-prepare a new race.
        self._stale_light: int | None = None
        self._reset_runtime()

    # ------------------------------------------------------------------ lifecycle

    def _reset_runtime(self) -> None:
        self._cars: dict[int, _Car] = {a: _Car(a) for a in self._configs}
        self._laps: list[Lap] = []
        self._best: BestLapRecord | None = None
        self._start_light = 0
        self._fuel_mode = False
        self._pit_lane = False
        self._sequence_seen = False
        self._go_host: float | None = None
        self._cu_origin: int | None = None
        self._resync: set[int] = set()  # cars whose next crossing re-anchors (after resync)
        self._pending_resync = False  # check the CU timestamp domain on the next Timer
        self._race_ms = 0
        self._sync_race_ms = 0
        self._sync_host: float | None = None
        self._last_crossing_ms = 0
        self._idle_emitted = False
        self._finishing = False
        self._finish_started_ms = 0

    def prepare(self, config: RaceConfig) -> None:
        """Arm a new race (phase STARTING) and clear all race data."""
        self.config = config
        self._stale_light = None
        self._reset_runtime()
        self._phase = RacePhase.STARTING

    def reset(self) -> None:
        self._remember_light()
        self._reset_runtime()
        self._phase = RacePhase.IDLE

    def resync_clock(self) -> None:
        """The link to the CU was re-established: verify its timestamp domain on the next Timer.

        A plain link drop keeps the CU running, so its timestamps continue in the same domain
        and laps keep counting normally. If the CU was power-cycled its clock restarted: the
        next Timer then lands far from the race clock, ``cu_origin`` is re-anchored and each
        car's next crossing only sets a new reference (no lap). See :meth:`_check_resync`.
        """
        self._pending_resync = True

    def update_cars(self, cars: list[CarConfig]) -> None:
        """Names/colors may change at any time; runtime data of existing cars is kept."""
        self._configs = {c.address: c for c in cars}
        for address in self._configs:
            self._cars.setdefault(address, _Car(address))

    def start_now(self) -> list[RaceEvent]:
        """Go to RUNNING immediately (fallback when the start lights are not observed)."""
        if self._phase in (RacePhase.RUNNING, RacePhase.PAUSED):
            return []
        if self._phase in (RacePhase.IDLE, RacePhase.FINISHED):
            self.prepare(self.config)
        return self._begin_running()

    def set_paused(self, paused: bool) -> list[RaceEvent]:
        """The controller tells us it toggled the pace car (Status has no pace-car flag)."""
        if paused and self._phase is RacePhase.RUNNING:
            self._phase = RacePhase.PAUSED
        elif not paused and self._phase is RacePhase.PAUSED:
            self._phase = RacePhase.RUNNING
        return []

    def _remember_light(self) -> None:
        self._stale_light = self._start_light if 1 <= self._start_light <= 6 else None

    def stop(self) -> list[RaceEvent]:
        if self._phase in (RacePhase.IDLE, RacePhase.FINISHED):
            return []
        self._remember_light()
        return self._finish_race()

    @property
    def phase(self) -> RacePhase:
        return self._phase

    def _begin_running(self) -> list[RaceEvent]:
        self._phase = RacePhase.RUNNING
        self._go_host = self._clock()
        self._race_ms = 0
        self._sync_race_ms = 0
        self._sync_host = self._go_host
        self._last_crossing_ms = 0
        addresses = sorted(a for a in self._configs if a <= 5)
        return [RaceStarted(mode=self.config.mode, addresses=addresses, race_time_ms=0)]

    # ------------------------------------------------------------------ clock

    def _advance_clock(self) -> None:
        """Extrapolate the race clock with the host clock (monotonic clamp)."""
        if self._go_host is None or self._sync_host is None:
            return
        now = self._clock()
        if self._cu_origin is None:
            candidate = (now - self._go_host) * 1000
        else:
            candidate = self._sync_race_ms + (now - self._sync_host) * 1000
        self._race_ms = max(self._race_ms, int(candidate))

    def _anchor(self, ts: int) -> None:
        """Map ``ts`` to the current race clock (call :meth:`_advance_clock` first)."""
        self._cu_origin = (ts - self._race_ms) % TIMESTAMP_MODULO

    def _check_resync(self, ts: int) -> None:
        """First Timer after :meth:`resync_clock`: keep or re-anchor the CU timestamp domain.

        The domain is intact when ``ts`` maps to (about) the current race clock. Otherwise the
        CU restarted: re-anchor ``cu_origin`` on the CU-synced race clock (so the clock stays
        monotonic and host/CU skew is not reintroduced) and make every car that has crossed
        re-anchor its reference on its next crossing (including the car of this Timer).
        """
        self._pending_resync = False
        if self._cu_origin is None:  # no Timer seen yet: the first one anchors normally
            return
        self._advance_clock()
        diff = ts_diff(ts, self._cu_origin)  # unsigned: a small backward jump is ~2**32
        tolerance = max(60_000, 2 * self.config.max_lap_ms)
        if diff < _HALF_MODULO and abs(diff - self._race_ms) <= tolerance:
            return
        self._anchor(ts)
        self._resync |= {a for a, c in self._cars.items() if c.crossed}

    def _race_time_for(self, ts: int) -> int:
        """Race time of a CU timestamp; anchors ``cu_origin`` on the first call."""
        assert self._go_host is not None
        if self._pending_resync:
            self._check_resync(ts)
        if self._cu_origin is None:
            self._advance_clock()  # before the first Timer: host time elapsed since go
            self._anchor(ts)
        diff = ts_diff(ts, self._cu_origin)
        if diff >= _HALF_MODULO:  # crossing older than the anchor (buffered): clamp
            diff = 0
        if diff >= self._race_ms:  # re-sync forward only
            self._race_ms = diff
            self._sync_race_ms = diff
            self._sync_host = self._clock()
        return diff

    # ------------------------------------------------------------------ state

    def _standings(self) -> list[_Car]:
        placed = [c for c in self._cars.values() if c.crossed]
        placed.sort(key=lambda c: (-c.laps, c.total_time_ms or 0, c.address))
        return placed

    def _name_color(self, address: int) -> tuple[str, str]:
        cfg = self._configs.get(address)
        if cfg is not None:
            return cfg.name, cfg.color
        defaults = default_cars()
        if address < len(defaults):
            return defaults[address].name, defaults[address].color
        return f"Car {address + 1}", "#888888"

    @property
    def laps(self) -> list[Lap]:
        return [lap.model_copy() for lap in self._laps]

    @property
    def state(self) -> RaceState:
        if self._phase in (RacePhase.RUNNING, RacePhase.PAUSED):
            self._advance_clock()
        standings = self._standings()
        cars: list[CarState] = []
        leader = standings[0] if standings else None
        for index, car in enumerate(standings):
            ahead = standings[index - 1] if index > 0 else None
            gap_leader: int | None = None
            gap_laps = 0
            gap_ahead: int | None = None
            if leader is not None and car is not leader:
                if car.laps == leader.laps:
                    gap_leader = (car.total_time_ms or 0) - (leader.total_time_ms or 0)
                else:
                    gap_laps = leader.laps - car.laps
            if ahead is not None and car.laps == ahead.laps:
                gap_ahead = (car.total_time_ms or 0) - (ahead.total_time_ms or 0)
            cars.append(self._car_state(car, index + 1, gap_leader, gap_laps, gap_ahead))
        unplaced = sorted(
            a for a, c in self._cars.items() if not c.crossed and (a <= 5 and a in self._configs)
        )
        cars.extend(self._car_state(self._cars[a], None, None, 0, None) for a in unplaced)

        remaining_ms = None
        remaining_laps = None
        if self.config.mode is RaceMode.TIMED and self._phase is not RacePhase.IDLE:
            remaining_ms = max(0, self.config.duration_s * 1000 - self._race_ms)
        if self.config.mode is RaceMode.LAPS and self._phase is not RacePhase.IDLE:
            done = leader.laps if leader else 0
            remaining_laps = max(0, self.config.target_laps - done)
        return RaceState(
            race_id=self.race_id,
            phase=self._phase,
            config=self.config.model_copy(),
            start_light=self._start_light,
            race_time_ms=self._race_ms,
            remaining_ms=remaining_ms,
            remaining_laps=remaining_laps,
            fuel_mode=self._fuel_mode,
            pit_lane=self._pit_lane,
            cars=cars,
            best_lap=self._best.model_copy() if self._best else None,
        )

    def _car_state(
        self,
        car: _Car,
        position: int | None,
        gap_leader: int | None,
        gap_laps: int,
        gap_ahead: int | None,
    ) -> CarState:
        name, color = self._name_color(car.address)
        avg = round(car.valid_sum / car.valid_count) if car.valid_count else None
        return CarState(
            address=car.address,
            name=name,
            color=color,
            laps=car.laps,
            last_lap_ms=car.last_lap_ms,
            best_lap_ms=car.best_lap_ms,
            avg_lap_ms=avg,
            total_time_ms=car.total_time_ms,
            position=position,
            gap_to_leader_ms=gap_leader,
            gap_to_leader_laps=gap_laps,
            gap_to_ahead_ms=gap_ahead,
            fuel=car.fuel if self._fuel_mode else None,
            in_pit=car.in_pit,
            pit_stops=car.pit_stops,
            finished=car.finished,
            lap_times=list(car.lap_times),
        )

    # ------------------------------------------------------------------ input

    def handle(self, msg: Timer | Status) -> list[RaceEvent]:
        if isinstance(msg, Timer):
            return self._on_timer(msg)
        return self._on_status(msg)

    def _emitting(self) -> bool:
        return self._phase in (RacePhase.RUNNING, RacePhase.PAUSED)

    # ---- status

    def _on_status(self, msg: Status) -> list[RaceEvent]:
        events: list[RaceEvent] = []
        self._start_light = msg.start
        self._fuel_mode = bool(msg.mode & MODE_FUEL)
        self._pit_lane = bool(msg.mode & MODE_PIT_LANE)

        if self._stale_light is not None and msg.start != self._stale_light:
            self._stale_light = None  # the CU's light changed: levels count again
        if (
            self._phase in (RacePhase.IDLE, RacePhase.FINISHED)
            and 1 <= msg.start <= 6
            and self._stale_light is None
        ):
            # The user pressed START on the CU itself (an observed transition into the light
            # sequence, not a level left over from before a stop): do not drop the race.
            self.prepare(self.config)
            self._start_light = msg.start
            self._fuel_mode = bool(msg.mode & MODE_FUEL)
            self._pit_lane = bool(msg.mode & MODE_PIT_LANE)
        if self._phase is RacePhase.STARTING:
            if 2 <= msg.start <= 6:  # light 1 is only "armed": no countdown yet
                self._sequence_seen = True
            elif msg.start in (0, 7) and self._sequence_seen:
                events.extend(self._begin_running())
            elif msg.start in (8, 9):
                self._sequence_seen = False  # false start: stay in STARTING

        self._advance_clock()
        emit = self._emitting()
        threshold = self.config.low_fuel_threshold
        for address in range(min(len(msg.fuel), len(msg.pit))):
            car = self._cars.get(address)
            if car is None or not car.crossed:
                # Empty slots report fuel 0: ignore fuel/pit until the car has crossed the line.
                continue
            if self._fuel_mode:
                fuel = msg.fuel[address]
                car.fuel = fuel
                if fuel <= threshold:
                    if car.low_fuel_armed:
                        car.low_fuel_armed = False
                        if emit:
                            events.append(
                                LowFuel(address=address, fuel=fuel, race_time_ms=self._race_ms)
                            )
                else:
                    car.low_fuel_armed = True
            in_pit = bool(msg.pit[address])
            if in_pit == car.in_pit:
                car.pit_change_ms = None  # back to the settled value: it was a blip
                car.pit_change_frames = 0
                continue
            # Debounce: a corrupted / transient frame must not make a phantom pit stop, so a
            # change counts only after PIT_CONFIRM_FRAMES consecutive frames with the new value.
            if car.pit_change_ms is None:
                car.pit_change_ms = self._race_ms  # first frame of the new state
                car.pit_change_frames = 0
            car.pit_change_frames += 1
            if car.pit_change_frames < PIT_CONFIRM_FRAMES:
                continue
            changed_ms = car.pit_change_ms
            car.pit_change_ms = None
            car.pit_change_frames = 0
            if in_pit:
                car.in_pit = True
                car.pit_entered_ms = changed_ms
                car.pit_stops += 1
                if emit:
                    events.append(PitEntry(address=address, race_time_ms=self._race_ms))
            else:
                car.in_pit = False
                if emit:
                    events.append(
                        PitExit(
                            address=address,
                            duration_ms=max(0, changed_ms - car.pit_entered_ms),
                            fuel=car.fuel if self._fuel_mode else None,
                            race_time_ms=self._race_ms,
                        )
                    )
        return events

    # ---- timer

    def _on_timer(self, msg: Timer) -> list[RaceEvent]:
        if not self._emitting():
            return []
        race_t = self._race_time_for(msg.timestamp)  # anchors the clock on the first Timer
        if msg.sector != 1:
            return []
        address = msg.address
        if address not in self._configs and address > 5:
            return []  # autonomous / pace car
        car = self._cars.get(address)
        if car is None:
            car = self._cars[address] = _Car(address)
        if car.finished:
            return []

        old_order = self._standings()
        old_positions = {c.address: i + 1 for i, c in enumerate(old_order)}

        if car.last_ts is None:  # start pass: not a lap
            car.last_ts = msg.timestamp
            car.total_time_ms = race_t
            return []
        if address in self._resync:  # first crossing after a CU restart: new reference
            self._resync.discard(address)
            car.last_ts = msg.timestamp
            return []

        lap_ms = ts_diff(msg.timestamp, car.last_ts)
        if lap_ms < self.config.min_lap_ms:
            return []  # double trigger: ignored, reference timestamp not moved

        events: list[RaceEvent] = []
        valid = lap_ms <= self.config.max_lap_ms
        car.last_ts = msg.timestamp
        car.total_time_ms = race_t
        car.laps += 1
        car.last_lap_ms = lap_ms
        car.lap_times.append(lap_ms)
        self._last_crossing_ms = race_t
        self._idle_emitted = False
        self._laps.append(
            Lap(
                address=address,
                lap_number=car.laps,
                lap_ms=lap_ms,
                race_time_ms=race_t,
                valid=valid,
            )
        )

        best_event: BestLap | None = None
        if valid:
            previous = car.best_lap_ms
            car.valid_sum += lap_ms
            car.valid_count += 1
            if previous is None or lap_ms < previous:
                car.best_lap_ms = lap_ms
            overall_prev = self._best.lap_ms if self._best else None
            is_overall = overall_prev is None or lap_ms < overall_prev
            if is_overall:
                self._best = BestLapRecord(address=address, lap_ms=lap_ms, lap_number=car.laps)
            if is_overall and overall_prev is not None:
                best_event = BestLap(
                    address=address,
                    lap_ms=lap_ms,
                    previous_ms=overall_prev,
                    overall=True,
                    race_time_ms=race_t,
                )
            elif not is_overall and previous is not None and lap_ms < previous:
                best_event = BestLap(
                    address=address,
                    lap_ms=lap_ms,
                    previous_ms=previous,
                    overall=False,
                    race_time_ms=race_t,
                )

        new_order = self._standings()
        new_positions = {c.address: i + 1 for i, c in enumerate(new_order)}
        events.append(
            LapCompleted(
                address=address,
                lap_number=car.laps,
                lap_ms=lap_ms,
                position=new_positions[address],
                valid=valid,
                race_time_ms=race_t,
            )
        )
        if best_event is not None:
            events.append(best_event)

        old_pos = old_positions[address]
        new_pos = new_positions[address]
        if new_pos < old_pos:
            passed = None
            candidate = new_order[new_pos] if new_pos < len(new_order) else None
            if candidate is not None and old_positions[candidate.address] < old_pos:
                passed = candidate.address
            events.append(
                PositionChange(
                    address=address,
                    old_position=old_pos,
                    new_position=new_pos,
                    passed_address=passed,
                    race_time_ms=race_t,
                )
            )

        events.extend(self._update_finishing(car, race_t))
        return events

    # ---- finishing

    def _begin_finishing(self, race_ms: int) -> None:
        if not self._finishing:
            self._finishing = True
            self._finish_started_ms = race_ms

    def _update_finishing(self, car: _Car, race_t: int) -> list[RaceEvent]:
        """Called after a counted crossing of ``car``."""
        mode = self.config.mode
        if mode is RaceMode.PRACTICE:
            return []
        if not self._finishing:
            if mode is RaceMode.LAPS and car.laps >= self.config.target_laps:
                self._begin_finishing(race_t)
            elif mode is RaceMode.TIMED and race_t >= self.config.duration_s * 1000:
                self._begin_finishing(race_t)
        if self._finishing:
            car.finished = True
            return self._maybe_finish()
        return []

    def _grace_ms(self) -> int:
        bests = [c.best_lap_ms for c in self._cars.values() if c.best_lap_ms is not None]
        if not bests:
            return self.config.max_lap_ms
        return int(max(bests) * 1.25)

    def _maybe_finish(self) -> list[RaceEvent]:
        if not self._finishing or self._phase is RacePhase.FINISHED:
            return []
        running = [c for c in self._cars.values() if c.crossed]
        all_done = all(c.finished for c in running)
        timed_out = self._race_ms - self._finish_started_ms >= self._grace_ms()
        if all_done or timed_out:
            return self._finish_race()
        return []

    def _finish_race(self) -> list[RaceEvent]:
        order = [c.address for c in self._standings()]
        self._phase = RacePhase.FINISHED
        return [
            RaceFinished(
                winner=order[0] if order else None,
                order=order,
                race_time_ms=self._race_ms,
            )
        ]

    # ------------------------------------------------------------------ time-based

    def tick(self) -> list[RaceEvent]:
        if not self._emitting():
            return []
        self._advance_clock()
        events: list[RaceEvent] = []
        mode = self.config.mode
        if (
            mode is RaceMode.TIMED
            and not self._finishing
            and self._race_ms >= self.config.duration_s * 1000
        ):
            self._begin_finishing(self._race_ms)
        if self._finishing:
            events.extend(self._maybe_finish())
            return events
        if (
            self._phase is RacePhase.RUNNING
            and not self._idle_emitted
            and self._race_ms - self._last_crossing_ms >= self.config.idle_after_s * 1000
        ):
            self._idle_emitted = True
            events.append(
                Idle(
                    seconds=(self._race_ms - self._last_crossing_ms) // 1000,
                    race_time_ms=self._race_ms,
                )
            )
        return events
