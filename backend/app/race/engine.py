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
* **Sectors (Check Lanes).** ``Timer.sector`` 2/3 are Check Lane crossings (1 = start/finish).
  Sector numbering is stable for the whole race and never shifts: the sensors are kept in a
  driving ``order``. With a declared layout (:meth:`RaceEngine.set_declared_sensors`) the order
  is the declared one (plus any extra sensor number seen, appended by number). Without it the
  slots are fixed by sensor NUMBER: ``order = [2, 3][:max sensor seen - 1]``, so if sensor 3
  shows up before 2 was ever seen the order is already [2, 3] and sector 2 simply stays None.
  Sector ``i`` (1-based) ends at ``order[i-1]``; the last sector (``len(order) + 1``) ends at the
  line, so ``num_sectors = 1 + len(order)``. Splits come from CU timestamps; the line-to-first-
  sensor split starts at the lap reference ``last_ts``. A missed sensor leaves ``None`` entries,
  never an invented value. Sensor crossings never touch ``last_ts`` (lap reference), are ignored
  for cars awaiting a CU re-anchor, and ``SectorCompleted.lap_number`` is the lap in progress.
  When the sector order changes (declared layout changed or a new sensor number appears) the
  data of every stretch whose start/end sensors changed is dropped (others are kept).
  Without Check Lanes ``num_sectors`` is 1: ``last_sectors`` / ``best_sectors`` hold the lap
  time / best lap, ``current_sectors`` is ``[None]`` and no ``SectorCompleted`` is emitted.
  Overall-best flags follow the BestLap rule: ``overall_best`` only when an existing race best
  of that sector is beaten (the very first split of a sector is silent); ``personal_best`` only
  when an existing personal best is beaten without being an overall best.
* **Ranking.** Laps desc, then ``total_time_ms + penalty_ms`` (time penalties count in the
  live standings, the gaps and the ``RaceFinished`` order). In a qualifying session
  (:meth:`RaceEngine.set_session_rules`) cars are ranked by best valid lap asc, cars without
  one after them (by laps / time); the gaps are then best-lap deltas.
* **False start.** The CU aborts the sequence by itself (``Status.start`` 8/9) and does not say
  which car jumped. A start/finish crossing while STARTING with lights 2..6 marks the first
  such car as the candidate (light 1 = cars being placed, ignored). On the transition into 8/9
  the session's :class:`FalseStartRule` decides: ``ignore`` nothing; ``warn`` a ``FalseStart``
  event; ``penalty`` adds ``penalty_s`` to the candidate's ``penalty_ms`` (a ``warn`` event
  without address when there is no candidate); ``restart`` an event (the controller presses
  START again). Without session rules (no event running) false starts emit nothing.
* **Segment learning.** Per car, ``segment_estimates["a>b"]`` (sensors in driving order, line =
  1, the last one wrapping to the line; with no Check Lanes just ``"1>1"``, the full lap) is an
  EWMA (alpha 0.3) of valid segment times, seeded by the first one. Segments longer than 1.8x
  the current estimate (crash) and segments that included a pit stop are not learned.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Literal

from app.race.models import (
    BestLap,
    BestLapRecord,
    CarConfig,
    CarState,
    Crossing,
    FalseStart,
    FalseStartRule,
    FuelStrategy,
    Idle,
    Incident,
    IncidentCleared,
    IncidentStarted,
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
    SectorCompleted,
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
# Same car triggering the same Check Lane again within this window is a double trigger.
SENSOR_DEBOUNCE_MS = 300
SEGMENT_ALPHA = 0.3
SEGMENT_OUTLIER_FACTOR = 1.8


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
    penalty_ms: int = 0  # time penalties (false start), part of the ranking
    low_fuel_armed: bool = True
    finished: bool = False
    # sectors
    marks: dict[int, int] = field(default_factory=dict)  # sensor -> CU ts, current lap
    sensor_ts: dict[int, int] = field(default_factory=dict)  # sensor -> last accepted CU ts
    cur: dict[int, int | None] = field(default_factory=dict)  # closing sensor -> split
    last: dict[int, int | None] = field(default_factory=dict)
    best_sec: dict[int, int] = field(default_factory=dict)
    seg_est: dict[str, int] = field(default_factory=dict)
    line_ok: bool = True  # last_ts is this lap's start (False after a missed line crossing)
    seg_pit: bool = False  # the segment in progress included a pit stop
    last_crossing: Crossing | None = None
    # Roadmap wave 1 (docs/PROTOCOL.md). Incidents (brief IB):
    incident: Incident | None = None
    incidents: int = 0
    incident_lost_ms: int = 0
    watch_from_ms: int = 0  # overdue detection anchor (see PROTOCOL "Incidents")
    watch_after_crossing: bool = False  # no detection until the next counted crossing
    # Fuel strategy (brief F):
    fuel_laps: list[int | None] = field(default_factory=list)  # level at the end of each lap
    fuel_strategy: FuelStrategy | None = None
    lap_pit: bool = False  # the lap in progress included a pit stop

    @property
    def crossed(self) -> bool:
        return self.last_ts is not None

    @property
    def ranked_time_ms(self) -> int:
        """Race time used for the ranking: last crossing plus time penalties."""
        return (self.total_time_ms or 0) + self.penalty_ms


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
        self._declared: list[int] = []
        # Session rules (event mode): kept across races until changed by the controller.
        self._qualifying = False
        self._false_start_rule: FalseStartRule | None = None
        self._next_rules: tuple[bool, FalseStartRule | None] = (False, None)
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
        self._jump_candidate: int | None = None  # first car crossing during lights 2..6
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
        self._seen_sensors: set[int] = set()
        self._best_sec: dict[int, int] = {}  # closing sensor -> overall best split
        self._order: list[int] = []
        self._rebuild_order()

    # ------------------------------------------------------------------ sectors setup

    def set_declared_sensors(self, sensors: list[int]) -> None:
        """Declare the Check Lane sensors of the layout in DRIVING order (e.g. ``[2, 3]``).

        Values other than 2/3 and duplicates are dropped. An empty list means "undeclared":
        the order is then fixed by sensor number as sensors are seen. Safe to call at any
        time; if the resulting sector order changes, data of the redefined stretches is
        dropped (see module docstring).
        """
        seen: list[int] = []
        for sensor in sensors:
            if sensor in (2, 3) and sensor not in seen:
                seen.append(sensor)
        self._declared = seen
        self._rebuild_order()

    def _rebuild_order(self) -> None:
        top = max(self._seen_sensors, default=1)
        order = list(self._declared)
        order += [n for n in range(2, top + 1) if n not in order]
        if order != self._order:
            old = self._stretches(self._order)
            self._order = order
            self._drop_redefined(old, self._stretches(order))

    @staticmethod
    def _stretches(order: list[int]) -> dict[int, int]:
        """Sector closing sensor -> sensor it starts from (the line is 1)."""
        return dict(zip([*order, 1], [1, *order], strict=True))

    def _drop_redefined(self, old: dict[int, int], new: dict[int, int]) -> None:
        """Forget sector data and segment estimates of stretches whose endpoints changed.

        Stretches that still run between the same two sensors keep their data, so discovering
        sensor 3 does not wipe what was learned for line -> sensor 2.
        """
        stale = {k for k, start in old.items() if new.get(k) != start}
        stale_segments = {f"{start}>{k}" for k, start in old.items() if k in stale}
        for key in stale:
            self._best_sec.pop(key, None)
        for car in self._cars.values():
            for key in stale:
                car.cur.pop(key, None)
                car.last.pop(key, None)
                car.best_sec.pop(key, None)
            for seg in stale_segments:
                car.seg_est.pop(seg, None)

    def set_session_rules(
        self, *, qualifying: bool = False, false_start: FalseStartRule | None = None
    ) -> None:
        """Ranking and false start accounting of the event session (defaults: no event).

        They take effect at the next :meth:`prepare` (also the automatic one when START is
        pressed on the CU) or :meth:`reset`, right away while IDLE: a race in progress or a
        finished one keeps the rules it ran with (its final order does not change).
        """
        self._next_rules = (qualifying, false_start)
        if self._phase is RacePhase.IDLE:
            self._apply_rules()

    def _apply_rules(self) -> None:
        self._qualifying, self._false_start_rule = self._next_rules

    @property
    def qualifying(self) -> bool:
        return self._qualifying

    @property
    def false_start_rule(self) -> FalseStartRule | None:
        return self._false_start_rule

    def prepare(self, config: RaceConfig) -> None:
        """Arm a new race (phase STARTING) and clear all race data."""
        self.config = config
        self._stale_light = None
        self._apply_rules()
        self._reset_runtime()
        self._phase = RacePhase.STARTING

    def reset(self) -> None:
        self._apply_rules()
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
        if self._emitting():  # the silence of the link is not a stalled car
            self._advance_clock()
            self._restart_watch()

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
            self._advance_clock()
            self._restart_watch()  # cars were held by the pace car: watch them from now
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
        self._jump_candidate = None
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
        if self._qualifying:
            # Best valid lap asc; cars without one after them, by the race order.
            placed.sort(
                key=lambda c: (
                    c.best_lap_ms is None,
                    c.best_lap_ms or 0,
                    -c.laps,
                    c.ranked_time_ms,
                    c.address,
                )
            )
        else:
            placed.sort(key=lambda c: (-c.laps, c.ranked_time_ms, c.address))
        return placed

    def _gap(self, car: _Car, other: _Car) -> tuple[int | None, int]:
        """(gap in ms, gap in laps) of ``car`` behind ``other`` in the current ranking."""
        if self._qualifying:
            if car.best_lap_ms is None or other.best_lap_ms is None:
                return None, 0
            return car.best_lap_ms - other.best_lap_ms, 0
        if car.laps == other.laps:
            return car.ranked_time_ms - other.ranked_time_ms, 0
        return None, other.laps - car.laps

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
                gap_leader, gap_laps = self._gap(car, leader)
            if ahead is not None:
                gap_ahead, _ = self._gap(car, ahead)
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
            num_sectors=self._num_sectors,
            best_sectors=self._overall_best_sectors(),
        )

    @property
    def _num_sectors(self) -> int:
        return 1 + len(self._order)

    def _sector_keys(self) -> list[int]:
        """Closing sensor of each sector in order; the last sector closes at the line (1)."""
        return [*self._order, 1]

    def _overall_best_sectors(self) -> list[int | None]:
        if not self._order:
            return [self._best.lap_ms if self._best else None]
        return [self._best_sec.get(k) for k in self._sector_keys()]

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
        keys = self._sector_keys()
        if self._order:
            current = [car.cur.get(k) for k in keys]
            last = [car.last.get(k) for k in keys]
            best = [car.best_sec.get(k) for k in keys]
        else:
            current = [None]
            last = [car.last_lap_ms]
            best = [car.best_lap_ms]
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
            current_sectors=current,
            last_sectors=last,
            best_sectors=best,
            last_crossing=car.last_crossing.model_copy() if car.last_crossing else None,
            segment_estimates=dict(car.seg_est),
            penalty_ms=car.penalty_ms,
            logo_id=self._configs[car.address].logo_id if car.address in self._configs else None,
            incident=car.incident.model_copy() if car.incident else None,
            incidents=car.incidents,
            incident_lost_ms=car.incident_lost_ms,
            fuel_strategy=(
                car.fuel_strategy.model_copy() if car.fuel_strategy and self._fuel_mode else None
            ),
            fuel_laps=list(car.fuel_laps) if self._fuel_mode else [],
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
        previous_light = self._start_light
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
                if previous_light not in (8, 9):  # once per false start, not per frame
                    events.extend(self._false_start())

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
                car.seg_pit = True
                car.pit_stops += 1
                if emit:
                    events.append(PitEntry(address=address, race_time_ms=self._race_ms))
            else:
                car.in_pit = False
                car.watch_from_ms = self._race_ms  # incident watch restarts at the pit exit
                if emit:
                    events.append(
                        PitExit(
                            address=address,
                            duration_ms=max(0, changed_ms - car.pit_entered_ms),
                            fuel=car.fuel if self._fuel_mode else None,
                            race_time_ms=self._race_ms,
                        )
                    )
        self._update_fuel_strategy()
        return events

    def _false_start(self) -> list[RaceEvent]:
        """Apply the session's false start rule to the inferred candidate (see module doc)."""
        candidate, self._jump_candidate = self._jump_candidate, None
        rule = self._false_start_rule
        if rule is None or rule.action == "ignore":
            return []
        if rule.action == "penalty":
            if candidate is None:
                return [FalseStart(address=None, action="warn")]
            penalty = rule.penalty_s * 1000
            car = self._cars.get(candidate)
            if car is None:
                car = self._cars[candidate] = _Car(candidate)
            car.penalty_ms += penalty
            return [FalseStart(address=candidate, action="penalty", penalty_ms=penalty)]
        return [FalseStart(address=candidate, action=rule.action)]

    # ---- timer

    def _note_jump(self, msg: Timer) -> None:
        """A line crossing during the countdown (lights 2..6): remember the first car."""
        if (
            self._phase is RacePhase.STARTING
            and 2 <= self._start_light <= 6
            and msg.sector == 1
            and self._jump_candidate is None
            and (msg.address <= 5 or msg.address in self._configs)
        ):
            self._jump_candidate = msg.address

    def _on_timer(self, msg: Timer) -> list[RaceEvent]:
        if not self._emitting():
            self._note_jump(msg)
            return []
        race_t = self._race_time_for(msg.timestamp)  # anchors the clock on the first Timer
        if msg.sector not in (1, 2, 3):
            return []
        address = msg.address
        if address not in self._configs and address > 5:
            return []  # autonomous / pace car
        car = self._cars.get(address)
        if car is None:
            car = self._cars[address] = _Car(address)
        if car.finished:
            return []
        if msg.sector != 1:
            return self._on_sensor(car, msg.sector, msg.timestamp, race_t)

        old_order = self._standings()
        old_positions = {c.address: i + 1 for i, c in enumerate(old_order)}

        if car.last_ts is None:  # start pass: not a lap
            car.last_ts = msg.timestamp
            car.total_time_ms = race_t
            self._new_lap_marks(car, race_t)
            return self._clear_incident(car, "crossing", race_t)
        if address in self._resync:  # first crossing after a CU restart: new reference
            self._resync.discard(address)
            car.last_ts = msg.timestamp
            self._new_lap_marks(car, race_t)
            return self._clear_incident(car, "crossing", race_t)

        lap_ms = ts_diff(msg.timestamp, car.last_ts)
        if lap_ms < self.config.min_lap_ms:
            return []  # double trigger: ignored, reference timestamp not moved

        events: list[RaceEvent] = self._clear_incident(car, "crossing", race_t)
        valid = lap_ms <= self.config.max_lap_ms
        sector_events = self._close_lap(car, msg.timestamp, lap_ms, valid, race_t)
        car.last_ts = msg.timestamp
        car.total_time_ms = race_t
        car.laps += 1
        car.last_lap_ms = lap_ms
        car.lap_times.append(lap_ms)
        self._record_fuel_lap(car)
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
        events.extend(sector_events)
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

    # ---- sectors

    def _new_lap_marks(self, car: _Car, race_t: int) -> None:
        """A line crossing that starts a fresh lap without closing one (start pass / re-anchor)."""
        car.marks.clear()
        car.cur.clear()
        car.sensor_ts.clear()  # a re-anchored CU clock makes old sensor timestamps meaningless
        car.line_ok = True
        car.seg_pit = car.in_pit
        car.last_crossing = Crossing(sensor=1, race_time_ms=race_t)
        self._watch_from_crossing(car, race_t)

    def _record_sector(self, car: _Car, key: int, split: int) -> tuple[bool, bool]:
        """Update personal/overall bests; returns (personal_best, overall_best) flags."""
        previous = car.best_sec.get(key)
        overall_prev = self._best_sec.get(key)
        is_overall = overall_prev is None or split < overall_prev
        if previous is None or split < previous:
            car.best_sec[key] = split
        if is_overall:
            self._best_sec[key] = split
        overall_flag = is_overall and overall_prev is not None
        personal_flag = not is_overall and previous is not None and split < previous
        return personal_flag, overall_flag

    def _learn_segment(self, car: _Car, a: int, b: int, duration: int, tainted: bool) -> None:
        """EWMA of valid segment times; ignores outliers and segments with a pit stop."""
        if tainted or duration <= 0:
            return
        key = f"{a}>{b}"
        estimate = car.seg_est.get(key)
        if estimate is None:
            car.seg_est[key] = duration
        elif duration <= SEGMENT_OUTLIER_FACTOR * estimate:
            car.seg_est[key] = round(SEGMENT_ALPHA * duration + (1 - SEGMENT_ALPHA) * estimate)

    def _on_sensor(self, car: _Car, sensor: int, ts: int, race_t: int) -> list[RaceEvent]:
        """A Check Lane crossing (sensor 2 or 3)."""
        if not car.crossed or car.address in self._resync:
            return []
        previous_same = car.sensor_ts.get(sensor)
        if previous_same is not None and ts_diff(ts, previous_same) < SENSOR_DEBOUNCE_MS:
            return []  # double trigger
        if sensor not in self._seen_sensors:
            self._seen_sensors.add(sensor)
            self._rebuild_order()
        if sensor not in self._order:  # cannot happen: the order covers every seen number
            return []
        index = self._order.index(sensor)
        prev_sensor = self._order[index - 1] if index > 0 else 1
        if sensor in car.marks:  # the line crossing of this lap was missed
            car.marks.clear()
            car.cur.clear()
            car.line_ok = False
        if prev_sensor == 1:
            prev_ts = car.last_ts if car.line_ok else None
        else:
            prev_ts = car.marks.get(prev_sensor)
        split: int | None = None
        if prev_ts is not None:
            split = ts_diff(ts, prev_ts)
            if split > self.config.max_lap_ms:
                return []  # impossible split
        tainted = car.seg_pit or car.in_pit
        car.sensor_ts[sensor] = ts
        car.marks[sensor] = ts
        car.cur[sensor] = split
        car.last_crossing = Crossing(sensor=sensor, race_time_ms=race_t)
        self._watch_from_crossing(car, race_t)
        events = self._clear_incident(car, "crossing", race_t)
        car.seg_pit = car.in_pit
        if split is None:
            return events
        self._learn_segment(car, prev_sensor, sensor, split, tainted)
        personal, overall = self._record_sector(car, sensor, split)
        return events + [
            SectorCompleted(
                address=car.address,
                lap_number=car.laps + 1,
                sector=index + 1,
                split_ms=split,
                personal_best=personal,
                overall_best=overall,
                race_time_ms=race_t,
            )
        ]

    def _close_lap(
        self, car: _Car, ts: int, lap_ms: int, valid: bool, race_t: int
    ) -> list[RaceEvent]:
        """Line crossing that completes a lap: closes the last sector and rolls the lap data.

        Called before ``car.laps`` is incremented and before ``last_ts`` moves.
        """
        events: list[RaceEvent] = []
        tainted = car.seg_pit or car.in_pit
        if not self._order:
            if valid:
                self._learn_segment(car, 1, 1, lap_ms, tainted)
        else:
            last_sensor = self._order[-1]
            split: int | None = None
            mark = car.marks.get(last_sensor)
            if mark is not None:
                split = ts_diff(ts, mark)
                if split > self.config.max_lap_ms:
                    split = None
            car.cur[1] = split
            if split is not None:
                personal = overall = False
                if valid:
                    self._learn_segment(car, last_sensor, 1, split, tainted)
                    personal, overall = self._record_sector(car, 1, split)
                events.append(
                    SectorCompleted(
                        address=car.address,
                        lap_number=car.laps + 1,  # not yet incremented: the lap just closed
                        sector=len(self._order) + 1,
                        split_ms=split,
                        personal_best=personal,
                        overall_best=overall,
                        race_time_ms=race_t,
                    )
                )
        car.last = dict(car.cur)
        car.cur.clear()
        car.marks.clear()
        car.line_ok = True
        car.seg_pit = car.in_pit
        car.last_crossing = Crossing(sensor=1, race_time_ms=race_t)
        self._watch_from_crossing(car, race_t)
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
        events = self._close_incidents_at_end() + self._apply_pit_penalties()
        order = [c.address for c in self._standings()]
        self._phase = RacePhase.FINISHED
        return events + [
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
        events: list[RaceEvent] = self._check_incidents()
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

    # ------------------------------------------------------------------ roadmap wave 1 hooks
    # Call sites are fixed (contract commit); briefs IB and F fill in the bodies.

    # ---- incidents (brief IB; docs/PROTOCOL.md "Incidents")

    def _watch_from_crossing(self, car: _Car, race_t: int) -> None:
        """A counted crossing (it updated ``last_crossing``) restarts the incident watch."""
        car.watch_from_ms = race_t
        car.watch_after_crossing = False

    def _restart_watch(self) -> None:
        """Resume from PAUSED / CU resync: every car is watched from the current race time."""
        for car in self._cars.values():
            car.watch_from_ms = self._race_ms

    def _stretch(self, car: _Car) -> tuple[int, int] | None:
        """(from sensor, to sensor) of the stretch the car is driving; the line is 1."""
        crossing = car.last_crossing
        if crossing is None:
            return None
        if not self._order:
            return (1, 1)
        if crossing.sensor == 1:
            return (1, self._order[0])
        if crossing.sensor in self._order:
            index = self._order.index(crossing.sensor)
            following = self._order[index + 1] if index + 1 < len(self._order) else 1
            return (crossing.sensor, following)
        return None

    def _expected_ms(self, car: _Car) -> int | None:
        """Time the car normally needs for its current stretch (None = not known yet)."""
        stretch = self._stretch(car)
        if stretch is None:
            return None
        if not self._order:
            return car.seg_est.get("1>1")  # outlier-protected lap estimate
        return car.seg_est.get(f"{stretch[0]}>{stretch[1]}")

    def _open_incident(self, car: _Car, source: Literal["overdue", "marshal"]) -> list[RaceEvent]:
        stretch = self._stretch(car)
        incident = Incident(
            started_race_ms=self._race_ms,
            source=source,
            from_sensor=stretch[0] if stretch else None,
            to_sensor=stretch[1] if stretch else None,
        )
        car.incident = incident
        car.incidents += 1
        penalty_ms = self.config.incidents.penalty_s * 1000
        car.penalty_ms += penalty_ms
        return [
            IncidentStarted(
                address=car.address,
                source=source,
                from_sensor=incident.from_sensor,
                to_sensor=incident.to_sensor,
                count=car.incidents,
                penalty_ms=penalty_ms,
                race_time_ms=self._race_ms,
            )
        ]

    def _check_incidents(self) -> list[RaceEvent]:
        """Open overdue incidents (tick, RUNNING only, also while finishing)."""
        rules = self.config.incidents
        if self._phase is not RacePhase.RUNNING or not rules.detect:
            return []
        watched = 0
        overdue: list[_Car] = []
        for car in sorted(self._cars.values(), key=lambda c: c.address):
            if (
                car.last_crossing is None
                or car.in_pit
                or car.finished
                or car.incident is not None
                or car.watch_after_crossing
            ):
                continue
            expected = self._expected_ms(car)
            if expected is None:
                continue
            watched += 1
            anchor = max(car.last_crossing.race_time_ms, car.watch_from_ms)
            if self._race_ms - anchor > rules.overdue_factor * expected:
                overdue.append(car)
        if not overdue or (watched >= 2 and len(overdue) == watched):
            # nobody late, or every car of several (a deliberate halt / a CU hiccup)
            return []
        events: list[RaceEvent] = []
        for car in overdue:
            events.extend(self._open_incident(car, "overdue"))
        return events

    def report_incident(self, address: int) -> list[RaceEvent]:
        """The marshal reports a car off the track (no-op when it already has an incident).

        Raises :class:`KeyError` for an address with no car.
        """
        car = self._cars.get(address)
        if car is None:
            raise KeyError(address)
        if not self._emitting() or car.incident is not None:
            return []
        self._advance_clock()
        return self._open_incident(car, "marshal")

    def marshal_clear_incident(self, address: int) -> list[RaceEvent]:
        """The marshal puts the car back on track.

        Raises :class:`KeyError` when there is no such car or it has no open incident.
        """
        car = self._cars.get(address)
        if car is None or car.incident is None:
            raise KeyError(address)
        self._advance_clock()
        return self._clear_incident(car, "marshal", self._race_ms)

    def has_open_incident(self) -> bool:
        return any(car.incident is not None for car in self._cars.values())

    def _clear_incident(
        self, car: _Car, by: Literal["crossing", "marshal", "race_end"], race_t: int
    ) -> list[RaceEvent]:
        """Close ``car``'s open incident (a counted crossing, the marshal, the race end)."""
        if car.incident is None:
            return []
        lost = max(0, race_t - car.incident.started_race_ms)
        car.incident = None
        car.incident_lost_ms += lost
        if by == "marshal":
            car.watch_after_crossing = True  # not watched again until its next crossing
        return [IncidentCleared(address=car.address, by=by, lost_ms=lost, race_time_ms=race_t)]

    def _close_incidents_at_end(self) -> list[RaceEvent]:
        """Close every open incident with ``by="race_end"`` before RaceFinished."""
        events: list[RaceEvent] = []
        for car in sorted(self._cars.values(), key=lambda c: c.address):
            events.extend(self._clear_incident(car, "race_end", self._race_ms))
        return events

    # ---- fuel strategy / pit rules (brief F)

    def _apply_pit_penalties(self) -> list[RaceEvent]:
        """Brief F: mandatory pit stop penalties (PitMissed) before the final order."""
        return []

    def _record_fuel_lap(self, car: _Car) -> None:
        """Brief F: append the fuel level at the end of the lap just counted."""

    def _update_fuel_strategy(self) -> None:
        """Brief F: refresh every car's FuelStrategy after a Status frame."""
