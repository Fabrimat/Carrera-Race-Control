"""RaceController: the concurrency hub wiring track, engine, store, commentary and WebSocket.

Everything runs on the asyncio event loop thread (the engine and store calls are fast and
synchronous; the only blocking IO, carreralib, lives in CarreraTrack's own worker thread),
so engine state is never touched concurrently.

Background tasks (started by :meth:`RaceController.start`, cancelled by :meth:`shutdown`):

* **poll** (one per connection): ``await track.poll()`` -> ``engine.handle`` -> events.
  ``TrackDisconnected`` (or any unexpected poll error) switches the connection to
  "connecting" and reconnects with backoff 1, 2, 4, 8, 10, 10... s until it succeeds or the
  user disconnects. The backoff index is reset only once a message is polled again, so a
  link that drops right after every reconnect keeps backing off. Errors while *processing* a
  message are logged and the loop continues.
* **tick** (~10 Hz): ``engine.tick()`` for time-based events (timed race end, idle) and to
  keep the race clock moving in the UI.
* **state** broadcaster: coalesces "state changed" marks and sends the latest ``RaceState``
  at most every ``state_interval`` seconds (10/s).
* **director**: ``CommentaryDirector.run()``.
* **start watchdog** (per start): if the CU shows no light sequence within
  ``start_fallback_s`` after ``track.start()``, the engine is started with ``start_now()``.

Every domain event goes, in order, to: persistence (laps / race finished), the WebSocket
(``event``), and the commentary director.

A physical START on the CU auto-prepares the engine without an event; the poll loop detects
the IDLE/FINISHED -> STARTING transition and creates the race in the store.
"""

from __future__ import annotations

import asyncio
import contextlib
import inspect
import logging
import re
import time
import unicodedata
from collections import deque
from collections.abc import Awaitable, Callable, Container, Sequence
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

from pydantic import BaseModel

from app.api.ws import WsHub, encode
from app.avatars import AvatarStore
from app.commentary.context import EventCommentary, build_event_commentary
from app.commentary.director import CommentaryDirector
from app.commentary.llm import AnthropicWriter, LineWriter, OpenAIWriter, TemplateWriter
from app.commentary.stt import (
    ElevenLabsTranscriber,
    OpenAITranscriber,
    Transcriber,
    TranscriptionError,
    guess_driver,
)
from app.commentary.tts import DEFAULT_MODEL_ID, BudgetTracker, ElevenLabsTTS, TTSClient
from app.config import AppConfig, TrackMode
from app.logos import MEDIA_TYPES, LogoStore
from app.race.bundle import null_unknown_logos
from app.race.engine import RaceEngine
from app.race.models import (
    CarConfig,
    ClassificationRow,
    CommentaryLine,
    Driver,
    DriverAssigned,
    EventProgram,
    EventState,
    FalseStart,
    IncidentStarted,
    LapCompleted,
    LayoutDraft,
    Logo,
    RaceConfig,
    RaceEvent,
    RaceFinished,
    RaceMode,
    RacePhase,
    RaceStarted,
    RaceState,
    SessionFinished,
    SessionInfo,
    SessionKind,
    SessionResult,
    SessionSpec,
    Settings,
    TrackLayout,
    TrackRecord,
    TrackRecordInfo,
    TrackSettings,
    utcnow,
)
from app.race.position import estimate_positions, sensor_positions
from app.race.store import RaceStore
from app.track.base import (
    Status,
    Timer,
    TrackDisconnected,
    TrackError,
    TrackErrorCode,
    TrackInterface,
)

log = logging.getLogger(__name__)

DEFAULT_BACKOFF: tuple[float, ...] = (1.0, 2.0, 4.0, 8.0, 10.0)
STATE_INTERVAL_S = 0.1
TICK_INTERVAL_S = 0.1
START_FALLBACK_S = 5.0
# A real CU needs two START presses (arm, then countdown): press again if still armed.
START_SECOND_PRESS_S = 2.5
# After a false start "restart" press: how long to wait for the CU to re-arm, and how often
# to look at its lights.
RESTART_WAIT_S = 30.0
RESTART_POLL_S = 0.05
CLOSE_TIMEOUT_S = 5.0
COMMENTARY_HISTORY = 50
ARM_TIMEOUT_S = 60  # "assign on next crossing" stays armed this long
SEEDED_COUNTER = "settings:seeded"
FALLBACK_NOTES = {
    "en": "OpenAI is selected but has no API key: this photo was read by Anthropic.",
    "it": "OpenAI è selezionato ma senza chiave API: questa foto è stata letta da Anthropic.",
}

_ACTIVE = (RacePhase.STARTING, RacePhase.RUNNING, RacePhase.PAUSED)

TrackFactory = Callable[[TrackMode, str | None], TrackInterface]


# --------------------------------------------------------------------------- API shapes


class ConnectionInfo(BaseModel):
    status: Literal["disconnected", "connecting", "connected", "error"] = "disconnected"
    mode: TrackMode = "simulator"
    address: str | None = None
    error: str | None = None  # English, for logs / tooltips
    error_code: TrackErrorCode | None = None  # stable code the UI translates


class Snapshot(BaseModel):
    connection: ConnectionInfo
    race: RaceState
    commentary: list[CommentaryLine]
    muted: bool


ErrorCode = Literal[
    "not_connected",
    "address_required",
    "start_failed",
    "pace_car_failed",
    "connect_failed",
    "connect_cancelled",
    "settings_invalid",
    "race_not_found",
    "record_not_found",
    "audio_not_found",
    "layout_not_found",
    "logo_not_found",
    "llm_unavailable",
    "photo_unrecognised",
    "photo_busy",
    "layout_invalid",
    "image_too_large",
    "invalid_image",
    "forbidden_origin",
    "import_invalid",
    "import_unsupported",
    "invalid_request",
    "transcription_failed",
    "race_not_running",
    "incident_not_found",
    # Track errors (TrackErrorCode) are passed through as they are:
    "busy",
    "not_found",
    "permission",
    "bluetooth_off",
    "timeout",
    "unknown",
]


class ControllerError(Exception):
    """A command could not be executed.

    ``status`` is the HTTP status, ``code`` a stable identifier the UI translates and
    ``detail`` an English message for logs (see docs/PROTOCOL.md "Error codes").
    """

    def __init__(self, status: int, detail: str, code: ErrorCode = "unknown") -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail
        self.code: ErrorCode = code


# --------------------------------------------------------------------------- helpers


class SwitchableWriter:
    """The writer handed to the director: delegates to whichever writer is current, so a
    provider change in the settings takes effect without touching the director."""

    def __init__(self, inner: LineWriter) -> None:
        self.inner = inner

    @property
    def available(self) -> bool:
        return bool(getattr(self.inner, "available", True))

    async def write_line(self, candidate: Any, context: dict[str, Any]) -> str:
        return await self.inner.write_line(candidate, context)


class ScaledClock:
    """Monotonic clock running ``scale`` times faster than real time.

    The engine must run on the simulator's virtual time; changing the scale (a new
    connection) re-bases the clock so it stays continuous and monotonic.
    """

    def __init__(self, scale: float = 1.0, base: Callable[[], float] = time.monotonic) -> None:
        self._base = base
        self._scale = scale
        self._t0 = base()
        self._v0 = 0.0

    def __call__(self) -> float:
        return self._v0 + (self._base() - self._t0) * self._scale

    def set_scale(self, scale: float) -> None:
        now = self._base()
        self._v0 = self._v0 + (now - self._t0) * self._scale
        self._t0 = now
        self._scale = scale


def _month_key(now: datetime | None = None) -> str:
    now = now or datetime.now(UTC)
    return f"tts_chars:{now:%Y-%m}"


def _error_code(exc: BaseException) -> TrackErrorCode:
    return exc.code if isinstance(exc, TrackError) else "unknown"


def _describe(exc: BaseException) -> str:
    return str(exc) or type(exc).__name__


# --------------------------------------------------------------------------- controller


class RaceController:
    def __init__(
        self,
        config: AppConfig,
        store: RaceStore,
        *,
        hub: WsHub | None = None,
        track_factory: TrackFactory | None = None,
        tts: TTSClient | None = None,
        writer: LineWriter | None = None,
        vision_client: Any | None = None,
        transcriber: Transcriber | None = None,
        backoff: Sequence[float] = DEFAULT_BACKOFF,
        start_fallback_s: float = START_FALLBACK_S,
        second_press_s: float = START_SECOND_PRESS_S,
        restart_wait_s: float = RESTART_WAIT_S,
        state_interval: float = STATE_INTERVAL_S,
        tick_interval: float = TICK_INTERVAL_S,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        self.config = config
        self.store = store
        self.hub = hub or WsHub()
        self._track_factory = track_factory or self._default_track
        self._backoff = tuple(backoff) or DEFAULT_BACKOFF
        self._start_fallback_s = start_fallback_s
        self._second_press_s = second_press_s
        self._restart_wait_s = restart_wait_s
        self._state_interval = state_interval
        self._tick_interval = tick_interval
        self._sleep = sleep

        self.settings = self._load_settings()
        self.connection = ConnectionInfo(
            mode=self.settings.track.mode, address=self.settings.track.address
        )
        self.muted = False
        self._record_layout = self.settings.track.layout
        self.track_record: TrackRecordInfo | None = self._load_record(self._record_layout)
        self._first_record_race: int | None = None  # race whose first-ever record was announced
        self.commentary: deque[CommentaryLine] = deque(maxlen=COMMENTARY_HISTORY)

        self.engine_clock = ScaledClock()
        self.engine = RaceEngine(self.settings.cars, self.settings.race, clock=self.engine_clock)
        self._vision_client = vision_client
        self._photo_lock = asyncio.Lock()  # one (costly) photo conversion at a time
        self._layout: TrackLayout | None = None
        self._refresh_layout()

        self.tts = tts if tts is not None else self._default_tts()
        self.budget = BudgetTracker(
            self.settings.commentary.session_char_budget,
            self.settings.commentary.monthly_char_budget,
            get_monthly=lambda: self.store.get_counter(_month_key()),
            add_monthly=lambda n: self.store.add_to_counter(_month_key(), n),
        )
        # An injected writer (tests) is never replaced; the default one follows the settings.
        self._writer_injected = writer is not None
        self._switchable = SwitchableWriter(writer if writer is not None else self._build_writer())
        self._writer_signature = self._writer_key()
        self.director = CommentaryDirector(
            self.settings.commentary,
            cars=self._spoken_cars,
            writer=self._switchable,
            tts=self.tts,
            budget=self.budget,
            on_line=self._on_line,
            on_stop=self._on_stop,
            event_info=self._event_commentary,
        )

        # Event mode: drivers, assignments and "assign on next crossing".
        self.avatars = AvatarStore(config.avatars_dir)
        self.logo_files = LogoStore(config.logos_dir)
        self._transcriber = transcriber
        self._wall_clock: Callable[[], datetime] = utcnow
        self._drivers_cache: dict[str, Driver] | None = None
        self._event_state = self._load_event_state()

        self._track: TrackInterface | None = None
        self._poll_task: asyncio.Task[None] | None = None
        self._watchdog: asyncio.Task[None] | None = None
        self._tasks: list[asyncio.Task[None]] = []
        self._conn_lock = asyncio.Lock()
        self._connecting_track: TrackInterface | None = None
        self._connect_aborted = False
        self._dirty = asyncio.Event()
        self._last_status: Status | None = None
        self._sequence_seen = False
        self._reconnect_attempt = 0
        self._started = False
        # Auto pace car (IncidentRules.auto_pace_car): True while the CU pace car out on the
        # track is ours (we deployed it for an incident and will recall it).
        self._pace_owned = False

        # Event mode (programs and sessions): the active program of `self._event_state`.
        self._active_program: EventProgram | None = None
        self._false_start_restarted = False  # the "restart" rule presses START once per start
        self._restarting = False  # START re-pressed after a false start, no countdown seen yet
        self._refresh_active_program()
        self._apply_idle_config()

    # ------------------------------------------------------------------ construction

    def _load_settings(self) -> Settings:
        settings = self.store.load_settings()
        if self.store.get_counter(SEEDED_COUNTER) == 0:
            # Fresh settings DB: seed the defaults that come from the environment.
            settings.commentary.language = self.config.commentary_lang
            # The LLM writes the lines whenever a key exists; an explicit choice is never flipped.
            settings.commentary.llm_enabled = (
                self.config.has_anthropic_key() or self.config.has_openai_key()
            )
            # The provider whose key exists, preferring Anthropic.
            settings.commentary.llm_provider = (
                "openai"
                if self.config.has_openai_key() and not self.config.has_anthropic_key()
                else "anthropic"
            )
            settings.track = TrackSettings(
                mode=self.config.track_mode, address=self.config.track_address
            )
            self.store.save_settings(settings)
            self.store.add_to_counter(SEEDED_COUNTER, 1)
        return settings

    def _default_tts(self) -> TTSClient:
        key = self.config.elevenlabs_api_key
        return ElevenLabsTTS(
            api_key=key.get_secret_value() if key is not None else None,
            voice_id=self.config.elevenlabs_voice_id,
            model_id=self.config.elevenlabs_model_id or DEFAULT_MODEL_ID,
            cache_dir=self.config.tts_cache_dir,
            language_code=self.settings.commentary.language,
        )

    def _writer_key(self) -> tuple[str, bool]:
        provider = self.settings.commentary.llm_provider
        has_key = (
            self.config.has_openai_key()
            if provider == "openai"
            else self.config.has_anthropic_key()
        )
        return provider, has_key

    def _build_writer(self) -> LineWriter:
        # The director only uses the writer when settings.commentary.llm_enabled is on, so
        # with a key present the chosen provider's writer is always wired and toggling works
        # live. A provider without a key falls back to the templates.
        provider, has_key = self._writer_key()
        if not has_key:
            return TemplateWriter()
        if provider == "openai":
            assert self.config.openai_api_key is not None
            return OpenAIWriter(
                self.config.openai_api_key.get_secret_value(), model=self.config.openai_model
            )
        assert self.config.anthropic_api_key is not None
        return AnthropicWriter(
            self.config.anthropic_api_key.get_secret_value(), model=self.config.anthropic_model
        )

    def _refresh_writer(self) -> None:
        if self._writer_injected or self._writer_key() == self._writer_signature:
            return
        self._writer_signature = self._writer_key()
        self._switchable.inner = self._build_writer()

    def _default_track(self, mode: TrackMode, address: str | None) -> TrackInterface:
        if mode == "simulator":
            if self.config.replay_file is not None:
                from app.track.replay import ReplayTrack

                return ReplayTrack(self.config.replay_file, speed=1.0, loop=True)
            from app.track.simulator import SimulatorTrack

            kwargs: dict[str, Any] = {}
            lanes = self._simulated_check_lanes()
            if lanes:
                if "check_lanes" in inspect.signature(SimulatorTrack).parameters:
                    kwargs["check_lanes"] = lanes
                else:
                    log.warning("this simulator has no Check Lane support, ignoring them")
            return SimulatorTrack(
                num_cars=self.config.sim_cars, time_scale=self.config.sim_time_scale, **kwargs
            )
        from app.track.carrera import CarreraTrack

        assert address is not None
        return CarreraTrack(address, mode=mode)

    def _simulated_check_lanes(self) -> list[float]:
        """Lap fractions of the simulated Check Lanes (sensor-number order); the map wins."""
        if self._layout is not None and self._layout.sensors:
            # The simulator expects them in sensor-number order (index 0 = sensor 2); it
            # cannot express "only sensor 3", so a lone sensor 3 is simulated as sensor 2.
            return [s.s for s in sorted(self._layout.sensors, key=lambda s: s.sensor)]
        return self.config.sim_check_lane_list

    def _clock_scale(self, mode: TrackMode) -> float:
        if mode == "simulator" and self.config.replay_file is None:
            return self.config.sim_time_scale
        return 1.0

    # ------------------------------------------------------------------ lifecycle

    async def start(self, autoconnect: bool = True) -> None:
        """Start the background tasks; auto-connect the simulator if it is configured."""
        if self._started:
            return
        self._started = True
        self._tasks = [
            asyncio.create_task(self._tick_loop(), name="race-tick"),
            asyncio.create_task(self._state_loop(), name="race-state"),
            asyncio.create_task(self.director.run(), name="commentary-director"),
        ]
        for task in self._tasks:
            task.add_done_callback(self._task_died)
        mode = self.config.track_mode if self.config.track_mode_explicit else None
        mode = mode or self.settings.track.mode
        if autoconnect and mode == "simulator":
            try:
                await self.connect("simulator", None, persist=False)
            except ControllerError as exc:
                log.warning("simulator auto-connect failed: %s", exc.detail)

    async def shutdown(self) -> None:
        """Cancel every task, close the track (bounded) and the store. Idempotent."""
        await self._cancel_watchdog()
        tasks = [t for t in (*self._tasks, self._poll_task) if t is not None]
        self._tasks = []
        self._poll_task = None
        for task in tasks:
            task.cancel()
        for task in tasks:
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
        await self._close_track()
        self.hub.close_all()
        with contextlib.suppress(Exception):
            self.store.close()
        self._started = False

    def _task_died(self, task: asyncio.Task[None]) -> None:
        if task.cancelled():
            return
        exc = task.exception()
        if exc is not None:
            log.error("background task %s died", task.get_name(), exc_info=exc)

    # ------------------------------------------------------------------ snapshot / broadcast

    def snapshot(self) -> Snapshot:
        return Snapshot(
            connection=self.connection.model_copy(),
            race=self.race_state(),
            commentary=list(self.commentary),
            muted=self.muted,
        )

    def race_state(self) -> RaceState:
        """Engine state plus the track record of the current layout."""
        state = self.engine.state
        state.track_record = self.track_record.model_copy() if self.track_record else None
        state.layout = self.settings.track.layout
        state.session = self._session_info()
        if self._layout is not None:
            positions = estimate_positions(state, self._layout, state.race_time_ms)
            for car in state.cars:
                car.track_pos = positions.get(car.address)
        self._fill_drivers(state)
        self._fill_incident_places(state)
        return state

    def snapshot_message(self) -> str:
        return encode("snapshot", self.snapshot())

    def _mark_dirty(self) -> None:
        self._dirty.set()

    def _set_connection(self, **changes: object) -> None:
        self.connection = self.connection.model_copy(update=changes)
        self.hub.broadcast("connection", self.connection)

    async def _state_loop(self) -> None:
        while True:
            await self._dirty.wait()
            self._dirty.clear()
            if self.hub.client_count:
                try:
                    self.hub.broadcast("state", self.race_state())
                except Exception:
                    log.exception("state broadcast failed")
            await asyncio.sleep(self._state_interval)

    async def _tick_loop(self) -> None:
        while True:
            await asyncio.sleep(self._tick_interval)
            try:
                events = self.engine.tick()
                if events:
                    await self._process_events(events)
                if self.engine.phase in _ACTIVE:
                    self._mark_dirty()
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("engine tick failed")

    # ------------------------------------------------------------------ commentary callbacks

    async def _on_line(self, line: CommentaryLine) -> None:
        self.commentary.append(line)
        self.hub.broadcast("commentary", line)

    async def _on_stop(self, line_id: str) -> None:
        self.hub.broadcast("commentary_stop", {"id": line_id})

    def set_muted(self, muted: bool) -> bool:
        self.muted = muted
        self.hub.broadcast("muted", {"muted": muted})
        return muted

    # ------------------------------------------------------------------ events

    async def _process_events(self, events: list[RaceEvent]) -> None:
        state = self.race_state()
        for event in events:
            if isinstance(event, IncidentStarted):
                event.s = self._incident_place(event.from_sensor, event.to_sensor)
            self._persist(event, state)
            if isinstance(event, RaceStarted):
                self.budget.reset_session()
            self.hub.broadcast("event", event)
            await self.director.submit(event, state)
        # Records are checked once the whole batch (lap_completed, best_lap, position_change,
        # ...) went out, so the director can drop the best_lap line of a record lap.
        for lap_event in [e for e in events if isinstance(e, LapCompleted)]:
            record_event = self._check_record(lap_event)
            if record_event is not None:
                state = self.race_state()
                self.hub.broadcast("event", record_event)
                if self._announce_record(record_event):
                    await self.director.submit(record_event, state)
        finished = [e for e in events if isinstance(e, RaceFinished)]
        for finish_event in finished:
            session_event = self._finish_session(finish_event)
            if session_event is not None:
                state = self.race_state()
                self.hub.broadcast("event", session_event)
                await self.director.submit(session_event, state)
        if finished:
            self._apply_idle_config()
        await self._sync_auto_pace_car(events)
        self._mark_dirty()

    def _load_record(self, layout: str) -> TrackRecordInfo | None:
        try:
            return self.store.get_record(layout)
        except Exception:
            log.exception("could not load the track record of %r", layout)
            return None

    def _holder_name(self, address: int) -> str:
        car = self.cars_by_address().get(address)
        return (car.nickname or car.name) if car is not None else f"Car {address + 1}"

    def _check_record(self, event: LapCompleted) -> TrackRecord | None:
        """Save and report the lap when it beats the layout's record (valid laps only)."""
        race_id = self.engine.race_id
        if not event.valid or race_id is None or self.connection.mode == "simulator":
            return None  # simulated / replayed laps must not become the real record
        layout = self.settings.track.layout
        previous = self.track_record
        if previous is not None and event.lap_ms >= previous.lap_ms:
            return None
        info = TrackRecordInfo(
            layout=layout,
            lap_ms=event.lap_ms,
            address=event.address,
            holder_name=self._holder_name(event.address),
            race_id=race_id,
            set_at=utcnow(),
        )
        try:
            self.store.set_record(info)
        except Exception:
            log.exception("could not save the track record of %r", layout)
        self.track_record = info
        return TrackRecord(
            race_time_ms=event.race_time_ms,
            address=event.address,
            lap_ms=event.lap_ms,
            layout=layout,
            previous_ms=previous.lap_ms if previous is not None else None,
            previous_holder=previous.holder_name if previous is not None else None,
        )

    def _announce_record(self, event: TrackRecord) -> bool:
        """A first-ever record on a layout is spoken at most once per race."""
        if event.previous_ms is not None:
            return True
        race_id = self.engine.race_id
        if race_id is not None and race_id == self._first_record_race:
            return False
        self._first_record_race = race_id
        return True

    def delete_record(self, layout: str) -> bool:
        """Remove a layout's record; clears the in-memory one when it is the current layout."""
        removed = self.store.delete_record(layout)
        if removed and layout == self.settings.track.layout:
            self.track_record = None
            self._mark_dirty()
        return removed

    def _persist(self, event: RaceEvent, state: RaceState) -> None:
        race_id = self.engine.race_id
        if race_id is None:
            return
        try:
            if isinstance(event, LapCompleted):
                lap = next(
                    (
                        lap
                        for lap in reversed(self.engine.laps)
                        if lap.address == event.address and lap.lap_number == event.lap_number
                    ),
                    None,
                )
                if lap is not None:
                    self.store.add_lap(race_id, lap)
            elif isinstance(event, RaceFinished):
                self.store.finish_race(race_id, state)
        except Exception:
            log.exception("could not persist %s for race %s", event.type, race_id)

    def _new_race_in_store(self, config: RaceConfig) -> None:
        try:
            self.engine.race_id = self.store.create_race(config, self.settings.cars)
        except Exception:
            log.exception("could not create the race in the store")
            self.engine.race_id = None

    # ------------------------------------------------------------------ polling

    async def _poll_loop(self, track: TrackInterface) -> None:
        while True:
            try:
                msg = await track.poll()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                if not isinstance(exc, TrackDisconnected):
                    log.exception("unexpected error while polling the track")
                else:
                    log.warning("track disconnected: %s", _describe(exc))
                await self._reconnect(track, exc)
                continue
            self._reconnect_attempt = 0
            try:
                await self._handle(msg)
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("error while handling %r", msg)

    async def _handle(self, msg: Timer | Status) -> None:
        before = self.engine.phase
        events = self.engine.handle(msg)
        events.extend(self._crossing_assignment(msg, before))
        after = self.engine.phase
        if before in (RacePhase.IDLE, RacePhase.FINISHED) and after in _ACTIVE:
            # Physical START on the CU: the engine auto-prepared, record the race.
            log.info("race started from the Control Unit")
            self._new_race_in_store(self.engine.config)
            self._false_start_restarted = False
            self._restarting = False
        changed = bool(events) or after is not before
        if isinstance(msg, Status):
            self._log_start_light(msg, before, after)
            if after is RacePhase.STARTING:
                if 2 <= msg.start <= 7:
                    self._sequence_seen = True
                    self._restarting = False
                elif msg.start in (8, 9) and not self._restarting:
                    # A false start: the CU aborted the sequence, never fall back to start_now.
                    # After our own re-press the CU may still show 8/9 for a while: then the
                    # watchdog must stay free to press START again.
                    self._sequence_seen = True
            changed = changed or msg != self._last_status
            self._last_status = msg
        else:
            changed = True
        if events:
            await self._process_events(events)
        elif changed:
            self._mark_dirty()
        if any(isinstance(e, FalseStart) and e.action == "restart" for e in events):
            await self._restart_after_false_start()

    def _log_start_light(self, msg: Status, before: RacePhase, after: RacePhase) -> None:
        """Log the raw ``Status.start`` changes around a start (false start diagnosis)."""
        previous = self._last_status.start if self._last_status is not None else None
        if msg.start == previous:
            return
        if RacePhase.STARTING in (before, after) or msg.start >= 8:
            log.info("CU start light %s -> %s (phase %s)", previous, msg.start, after.value)

    async def _restart_after_false_start(self) -> None:
        """The "restart" false start rule: press START again, once per start."""
        track = self._track
        if (
            self._false_start_restarted
            or track is None
            or self.engine.phase is not RacePhase.STARTING
        ):
            return
        self._false_start_restarted = True
        await self._cancel_watchdog()
        self._sequence_seen = False
        self._restarting = True
        log.info("false start: pressing START again to rerun the light sequence")
        try:
            await track.start()
        except Exception as exc:
            log.warning("restart press after a false start failed: %s", _describe(exc))
            self._restarting = False
            return
        self._watchdog = asyncio.create_task(self._restart_watchdog(track), name="restart-watchdog")

    async def _restart_watchdog(self, track: TrackInterface) -> None:
        """After the restart press: press START once more if the CU only arms (light 1).

        The CU may keep showing 8/9 for a while before it arms, so this waits (up to
        ``restart_wait_s``) for light 1 to be shown for ``second_press_s`` and then presses
        exactly once. It never starts the race on the host clock: without a light sequence
        the race simply stays STARTING (the user can press START on the CU).
        """
        deadline = time.monotonic() + self._restart_wait_s
        armed_since: float | None = None
        while time.monotonic() < deadline:
            await asyncio.sleep(RESTART_POLL_S)
            if self.engine.phase is not RacePhase.STARTING or self._sequence_seen:
                return  # the countdown is running (or the race was stopped)
            now = time.monotonic()
            if self._last_status is not None and self._last_status.start == 1:
                armed_since = armed_since if armed_since is not None else now
                if now - armed_since >= self._second_press_s:
                    log.info("the CU is armed (light 1) after the restart, pressing START again")
                    try:
                        await track.start()
                    except Exception as exc:
                        log.warning("second start press failed: %s", _describe(exc))
                    return
            else:
                armed_since = None
        log.warning("no new light sequence after the false start restart: press START on the CU")

    async def _reconnect(self, track: TrackInterface, exc: BaseException) -> None:
        """Reconnect ``track`` with backoff; returns once connected. Cancel to abort."""
        self._set_connection(status="connecting", error=_describe(exc), error_code=_error_code(exc))
        while True:
            delay = self._backoff[min(self._reconnect_attempt, len(self._backoff) - 1)]
            self._reconnect_attempt += 1
            await self._sleep(delay)
            with contextlib.suppress(Exception):
                await track.close()
            try:
                await track.connect()
            except asyncio.CancelledError:
                raise
            except Exception as err:
                log.warning("reconnect failed: %s", _describe(err))
                self._set_connection(
                    status="connecting", error=_describe(err), error_code=_error_code(err)
                )
                continue
            log.info("track reconnected")
            self._last_status = None
            # The CU may have been power-cycled (new timestamp domain): the engine checks the
            # next Timer and re-anchors only if the domain changed.
            self.engine.resync_clock()
            self._set_connection(status="connected", error=None, error_code=None)
            return

    # ------------------------------------------------------------------ connection commands

    async def connect(
        self, mode: TrackMode, address: str | None, *, persist: bool = True
    ) -> ConnectionInfo:
        address = (address or "").strip() or None
        if mode != "simulator" and address is None:
            raise ControllerError(
                422, f"An address is required for {mode} mode", "address_required"
            )
        async with self._conn_lock:
            await self._teardown()
            if self.engine.phase in _ACTIVE:
                # A new link is a new CU timestamp domain: close the race in progress.
                log.info("closing the race in progress before connecting a new track")
                await self._process_events(self.engine.stop())
            self._connect_aborted = False
            self._set_connection(
                status="connecting", mode=mode, address=address, error=None, error_code=None
            )
            try:
                track = self._track_factory(mode, address)
                self._connecting_track = track
                await track.connect()
            except Exception as exc:
                code = _error_code(exc)
                detail = _describe(exc)
                if self._connect_aborted:
                    log.info("connect (%s) cancelled by disconnect", mode)
                    self._set_connection(status="disconnected", error=None, error_code=None)
                    raise ControllerError(
                        409, "Connection cancelled by disconnect", "connect_cancelled"
                    ) from exc
                log.warning("connect (%s) failed: %s", mode, detail)
                self._set_connection(status="error", error=detail, error_code=code)
                # 409: the CU is held by someone else (e.g. the phone app); 503 otherwise.
                raise ControllerError(
                    409 if code == "busy" else 503,
                    detail,
                    code if code != "unknown" else "connect_failed",
                ) from exc
            finally:
                self._connecting_track = None
            self._track = track
            self._reconnect_attempt = 0
            self._last_status = None
            self.engine_clock.set_scale(self._clock_scale(mode))
            self._poll_task = asyncio.create_task(self._poll_loop(track), name="track-poll")
            self._poll_task.add_done_callback(self._poll_died)
            self._set_connection(status="connected", error=None, error_code=None)
            if persist:
                self.settings = self.settings.model_copy(
                    update={
                        "track": self.settings.track.model_copy(
                            update={"mode": mode, "address": address}
                        )
                    }
                )
                self._save_settings()
            return self.connection

    async def disconnect(self) -> ConnectionInfo:
        pending = self._connecting_track
        if pending is not None:
            # Abort a handshake in progress (CarreraTrack.close() cancels its connect()),
            # otherwise we would wait for it under the lock (up to ~30 s with retries).
            self._connect_aborted = True
            with contextlib.suppress(Exception):
                await asyncio.wait_for(pending.close(), CLOSE_TIMEOUT_S)
        async with self._conn_lock:
            await self._teardown()
            self._set_connection(status="disconnected", error=None, error_code=None)
            return self.connection

    def _poll_died(self, task: asyncio.Task[None]) -> None:
        if task.cancelled():
            return
        exc = task.exception()
        if exc is None:
            return
        log.error("track poll task died", exc_info=exc)
        if self._poll_task is task:
            self._set_connection(
                status="error", error=f"Polling stopped: {_describe(exc)}", error_code="unknown"
            )

    async def _teardown(self) -> None:
        await self._cancel_watchdog()
        task, self._poll_task = self._poll_task, None
        if task is not None:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
        await self._close_track()

    async def _close_track(self) -> None:
        track, self._track = self._track, None
        if track is None:
            return
        try:
            await asyncio.wait_for(track.close(), CLOSE_TIMEOUT_S)
        except Exception:
            log.warning("closing the track failed or timed out", exc_info=True)

    def _require_track(self) -> TrackInterface:
        if self._track is None or self.connection.status != "connected":
            raise ControllerError(409, "Not connected to a track", "not_connected")
        return self._track

    # ------------------------------------------------------------------ race commands

    async def start_race(self, config: RaceConfig | None = None) -> RaceState:
        track = self._require_track()
        if self.engine.phase in _ACTIVE:
            # Close the race in progress before starting a new one.
            await self._process_events(self.engine.stop())
        # While an event runs, no body = the current session's spec (and always its rules).
        current = self._current_session()
        if config is None:
            config = self._session_config(current[1]) if current else self.settings.race
        self._apply_session_rules(current[1] if current else None)
        await self._cancel_watchdog()
        self._pace_owned = False
        self.engine.prepare(config)
        self._new_race_in_store(config)
        self._sequence_seen = False
        self._false_start_restarted = False
        self._restarting = False
        self._mark_dirty()
        try:
            await track.start()
        except Exception as exc:
            log.warning("start command failed: %s", _describe(exc))
            self._abort_start()
            raise ControllerError(
                503, f"Start command failed: {_describe(exc)}", "start_failed"
            ) from exc
        self._watchdog = asyncio.create_task(self._start_watchdog(track), name="start-watchdog")
        return self.race_state()

    def _abort_start(self) -> None:
        """The CU never got the start command: leave STARTING and close the stray race row."""
        race_id = self.engine.race_id
        if race_id is not None:
            try:
                self.store.finish_race(race_id, self.engine.state)
            except Exception:
                log.exception("could not close race %s after a failed start", race_id)
        self.engine.reset()
        self.engine.race_id = None
        self._sequence_seen = False
        self._mark_dirty()

    async def _start_watchdog(self, track: TrackInterface) -> None:
        # 1) The CU only armed (light 1, lights off): a second START begins the countdown.
        #    Never pressed once a countdown light (2..9) was seen.
        press_at = min(self._second_press_s, self._start_fallback_s)
        await asyncio.sleep(press_at)
        armed = self._last_status is not None and self._last_status.start == 1
        if self.engine.phase is RacePhase.STARTING and not self._sequence_seen and armed:
            log.info("the CU is armed (light 1), pressing START a second time")
            try:
                await track.start()
            except Exception as exc:
                log.warning("second start press failed: %s", _describe(exc))
        # 2) Still no countdown: start the race on the host clock.
        await asyncio.sleep(self._start_fallback_s - press_at)
        false_start = self._last_status is not None and self._last_status.start in (8, 9)
        if (
            self.engine.phase is RacePhase.STARTING
            and not self._sequence_seen
            and not false_start
            and not self._restarting  # a false start restart never falls back to the host clock
        ):
            log.warning(
                "no start light sequence seen within %.1fs, starting the race now",
                self._start_fallback_s,
            )
            await self._process_events(self.engine.start_now())

    async def _cancel_watchdog(self) -> None:
        task, self._watchdog = self._watchdog, None
        if task is not None and not task.done():
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task

    async def stop_race(self) -> RaceState:
        await self._cancel_watchdog()
        events = self.engine.stop()
        if events:
            await self._process_events(events)
        return self.race_state()

    async def reset_race(self) -> RaceState:
        await self._cancel_watchdog()
        await self._recall_pace_car()
        self.engine.reset()
        self.engine.race_id = None
        self._sequence_seen = False
        self._restarting = False
        self._apply_idle_config()
        if self._track is not None and self.connection.status == "connected":
            try:
                await self._track.reset_timer()
            except Exception as exc:
                log.warning("reset command failed: %s", _describe(exc))
        self._mark_dirty()
        return self.race_state()

    async def toggle_pace_car(self) -> RaceState:
        track = self._require_track()
        try:
            await track.toggle_pace_car()
        except Exception as exc:
            raise ControllerError(
                503, f"Pace car command failed: {_describe(exc)}", "pace_car_failed"
            ) from exc
        self._pace_owned = False  # the user took the pace car over: we stop tracking it
        if self.engine.phase in (RacePhase.RUNNING, RacePhase.PAUSED):
            events = self.engine.set_paused(self.engine.phase is RacePhase.RUNNING)
            if events:
                await self._process_events(events)
        self._mark_dirty()
        return self.race_state()

    # ------------------------------------------------------------------ incidents (marshal)

    def _require_incident_phase(self) -> None:
        if self.engine.phase not in (RacePhase.RUNNING, RacePhase.PAUSED):
            raise ControllerError(409, "No race is running", "race_not_running")

    async def report_incident(self, address: int) -> RaceState:
        """The marshal reports a car off the track (no-op when it already has an incident)."""
        self._require_incident_phase()
        try:
            events = self.engine.report_incident(address)
        except KeyError:
            raise ControllerError(404, f"No car {address}", "incident_not_found") from None
        if events:
            await self._process_events(events)
        return self.race_state()

    async def clear_incident(self, address: int) -> RaceState:
        """The marshal puts the car back on track."""
        self._require_incident_phase()
        try:
            events = self.engine.marshal_clear_incident(address)
        except KeyError:
            raise ControllerError(
                404, f"Car {address} has no open incident", "incident_not_found"
            ) from None
        await self._process_events(events)
        return self.race_state()

    def _incident_place(self, from_sensor: int | None, to_sensor: int | None) -> float | None:
        """Midpoint (0..1 of the lap) of the stretch a car stopped in, through the line."""
        if self._layout is None or from_sensor is None or to_sensor is None:
            return None
        positions = sensor_positions(self._layout)
        if from_sensor not in positions or to_sensor not in positions:
            return None
        start, end = positions[from_sensor], positions[to_sensor]
        if end <= start:
            end += 1.0  # the stretch wraps through the start/finish line
        return round(((start + end) / 2) % 1.0, 4)

    def _fill_incident_places(self, state: RaceState) -> None:
        for car in state.cars:
            if car.incident is not None:
                car.incident.s = self._incident_place(
                    car.incident.from_sensor, car.incident.to_sensor
                )

    # ------------------------------------------------------------------ auto pace car

    async def _sync_auto_pace_car(self, events: list[RaceEvent]) -> None:
        """Deploy the CU pace car for the first open incident and recall it afterwards.

        Toggling the pace car pauses the engine, so "ours is out" is tracked in
        ``_pace_owned`` (the CU status has no pace-car flag). Failures are logged only.
        """
        phase = self.engine.phase
        if self._pace_owned:
            if phase not in (RacePhase.RUNNING, RacePhase.PAUSED) or (
                phase is RacePhase.PAUSED and not self.engine.has_open_incident()
            ):
                await self._recall_pace_car()
            return
        if (
            self.engine.config.incidents.auto_pace_car
            and phase is RacePhase.RUNNING
            and any(isinstance(e, IncidentStarted) for e in events)
        ):
            await self._deploy_pace_car()

    def _connected_track(self) -> TrackInterface | None:
        if self._track is None or self.connection.status != "connected":
            return None
        return self._track

    async def _deploy_pace_car(self) -> None:
        track = self._connected_track()
        if track is None:
            log.warning("auto pace car: not connected, the pace car was not deployed")
            return
        self._pace_owned = True  # before the await: a concurrent batch must not deploy twice
        try:
            await track.toggle_pace_car()
        except Exception as exc:
            self._pace_owned = False
            log.warning("auto pace car: deploying failed: %s", _describe(exc))
            return
        self.engine.set_paused(True)
        log.info("auto pace car deployed for an incident")

    async def _recall_pace_car(self) -> None:
        """Bring our own pace car back (no-op when it is not ours)."""
        if not self._pace_owned:
            return
        self._pace_owned = False
        track = self._connected_track()
        if track is None:
            log.warning("auto pace car: not connected, it could not be recalled")
            return
        try:
            await track.toggle_pace_car()
        except Exception as exc:
            log.warning("auto pace car: recalling failed: %s", _describe(exc))
            return
        self.engine.set_paused(False)
        log.info("auto pace car recalled")
        self._mark_dirty()

    # ------------------------------------------------------------------ settings

    def update_settings(self, settings: Settings) -> Settings:
        layout_changed = settings.track.layout != self.settings.track.layout
        self.settings = settings
        if layout_changed:
            self._refresh_layout()
        if settings.track.layout != self._record_layout:
            self._record_layout = settings.track.layout
            self.track_record = self._load_record(self._record_layout)
        self.engine.update_cars(settings.cars)
        # Used when a race is started from the CU's own START button (event: session spec).
        self._apply_idle_config()
        self.director.update_settings(settings.commentary)
        self._refresh_writer()
        if isinstance(self.tts, ElevenLabsTTS):
            self.tts.language_code = settings.commentary.language
        self._save_settings()
        self._mark_dirty()
        return self.settings

    # ------------------------------------------------------------------ logos
    # Brand logo library (app/logos.py); cars point at one with CarConfig.logo_id.

    def list_logos(self) -> list[Logo]:
        return self.store.list_logos()

    def get_logo(self, logo_id: str) -> Logo:
        logo = self.store.get_logo(logo_id)
        if logo is None:
            raise ControllerError(404, f"Logo {logo_id!r} not found", "logo_not_found")
        return logo

    def _store_logo_file(self, logo_id: str, data: bytes, ext: str) -> None:
        try:
            self.logo_files.save(logo_id, data, ext)
        except OSError as exc:
            log.exception("could not store the logo %s", logo_id)
            raise ControllerError(500, "Could not store the logo", "unknown") from exc

    def create_logo(self, name: str, data: bytes, ext: str) -> Logo:
        taken = {logo.id for logo in self.store.list_logos()}
        logo = Logo(
            id=self._unique_slug(name, taken, "logo"), name=name, media_type=MEDIA_TYPES[ext]
        )
        self._store_logo_file(logo.id, data, ext)
        saved = self.store.save_logo(logo)
        self._mark_dirty()
        return saved

    def update_logo(self, logo_id: str, name: str, image: tuple[bytes, str] | None) -> Logo:
        """Rename, and replace the image when ``image`` (bytes, extension) is given."""
        logo = self.get_logo(logo_id)
        update: dict[str, Any] = {"name": name, "updated_at": utcnow()}
        if image is not None:
            self._store_logo_file(logo_id, image[0], image[1])
            update["media_type"] = MEDIA_TYPES[image[1]]
        saved = self.store.save_logo(logo.model_copy(update=update))
        self._mark_dirty()
        return saved

    def delete_logo(self, logo_id: str) -> list[Logo]:
        self.get_logo(logo_id)
        self.logo_files.delete(logo_id)
        self.store.delete_logo(logo_id)
        if any(car.logo_id == logo_id for car in self.settings.cars):
            cars = [
                car.model_copy(update={"logo_id": None}) if car.logo_id == logo_id else car
                for car in self.settings.cars
            ]
            self.update_settings(self.settings.model_copy(update={"cars": cars}))
        self._mark_dirty()
        return self.store.list_logos()

    # ------------------------------------------------------------------ track layouts

    def _refresh_layout(self) -> None:
        """Reload the current layout and tell the engine about its Check Lane order."""
        try:
            self._layout = self.store.get_layout(self.settings.track.layout)
        except Exception:
            log.exception("could not load the track layout")
            self._layout = None
        sensors = (
            [s.sensor for s in sorted(self._layout.sensors, key=lambda s: s.s)]
            if (self._layout is not None)
            else []
        )
        self.engine.set_declared_sensors(sensors)

    def list_layouts(self) -> list[TrackLayout]:
        return self.store.list_layouts()

    def get_layout(self, name: str) -> TrackLayout:
        layout = self.store.get_layout(name)
        if layout is None:
            raise ControllerError(404, f"Layout {name!r} not found", "layout_not_found")
        return layout

    def save_layout(self, layout: TrackLayout) -> TrackLayout:
        saved = self.store.save_layout(layout)
        if saved.name == self.settings.track.layout:
            self._refresh_layout()
            self._mark_dirty()
        return saved

    def delete_layout(self, name: str) -> list[TrackLayout]:
        if not self.store.delete_layout(name):
            raise ControllerError(404, f"Layout {name!r} not found", "layout_not_found")
        if name == self.settings.track.layout:
            self._refresh_layout()
            self._mark_dirty()
        return self.store.list_layouts()

    async def layout_from_photo(self, image_base64: str, name: str, language: str) -> LayoutDraft:
        """Ask the vision model for a draft map. Nothing is saved and nothing is logged."""
        from app.track.vision import VisionError, layout_from_photo

        # OpenAI selected without its key: fall back to Anthropic when that key exists (and
        # say so in the draft notes), otherwise fail naming OpenAI.
        wants_openai = self.settings.commentary.llm_provider == "openai"
        fell_back = (
            wants_openai and not self.config.has_openai_key() and self.config.has_anthropic_key()
        )
        use_openai = wants_openai and not fell_back
        provider: Literal["anthropic", "openai"] = "openai" if use_openai else "anthropic"
        key = self.config.openai_api_key if use_openai else self.config.anthropic_api_key
        model = (
            self.config.openai_vision_model if use_openai else self.config.anthropic_vision_model
        )
        if self._photo_lock.locked():
            raise ControllerError(429, "Another photo is being analysed", "photo_busy")
        async with self._photo_lock:
            try:
                draft = await layout_from_photo(
                    api_key=key.get_secret_value() if key is not None else None,
                    model=model,
                    provider=provider,
                    image_base64=image_base64,
                    name=name,
                    language=language,
                    client=self._vision_client,
                    reasoning_effort=self.config.openai_vision_reasoning,
                )
            except VisionError as exc:
                raise ControllerError(exc.status, exc.detail, exc.code) from exc
        if fell_back:
            note = FALLBACK_NOTES.get(language, FALLBACK_NOTES["en"])
            draft = draft.model_copy(update={"notes": f"{draft.notes} {note}".strip()})
        return draft

    def _save_settings(self) -> None:
        try:
            self.store.save_settings(self.settings)
        except Exception:
            log.exception("could not save settings")

    def cars_by_address(self) -> dict[int, CarConfig]:
        return {c.address: c for c in self.settings.cars}

    # ------------------------------------------------------------------ configuration import
    # Called after a committed import (app/race/bundle.py); the database is already updated.

    def refresh_after_import(self, settings: Settings | None, removed_driver_ids: set[str]) -> None:
        """Bring the in-memory caches in line with imported data. Never touches the track."""
        self._drivers_cache = None
        if settings is not None:
            known = {logo.id for logo in self.store.list_logos()}
            # also stores the settings and refreshes the UI
            self.update_settings(null_unknown_logos(settings, known))
        self._refresh_layout()
        self._record_layout = self.settings.track.layout
        self.track_record = self._load_record(self._record_layout)
        if removed_driver_ids:

            def drop(state: EventState) -> None:
                state.assignments = {
                    a: d for a, d in state.assignments.items() if d not in removed_driver_ids
                }
                if state.armed_driver_id in removed_driver_ids:
                    state.armed_driver_id = None
                    state.armed_until = None

            self._update_event_state(drop)
            for driver_id in removed_driver_ids:
                self.avatars.delete(driver_id)  # their photos go with them
        # A replace import may have removed or changed the running program.
        self._refresh_active_program()
        if self._event_state.program_id is not None and self._active_program is None:
            self.stop_event()
        else:
            self._apply_idle_config()
        self._mark_dirty()

    # ------------------------------------------------------------------ event mode: drivers
    # Drivers roster, assignments (address -> driver id) and "assign on next crossing".
    # EventState is one persisted row shared with the session runner: always go through
    # `_update_event_state`.

    def _load_event_state(self) -> EventState:
        try:
            state = self.store.load_event_state()
        except Exception:
            log.exception("could not load the event state")
            return EventState()
        if state.armed_until is not None and state.armed_until <= self._wall_clock():
            state.armed_driver_id = None
            state.armed_until = None
        return state

    @property
    def event_state(self) -> EventState:
        return self._event_state

    def _update_event_state(self, fn: Callable[[EventState], None]) -> EventState:
        """Apply ``fn`` to the event state (in place), persist it and refresh the UI."""
        fn(self._event_state)
        try:
            self.store.save_event_state(self._event_state)
        except Exception:
            log.exception("could not save the event state")
        self._mark_dirty()
        return self._event_state

    def _driver_map(self) -> dict[str, Driver]:
        if self._drivers_cache is None:
            self._drivers_cache = {d.id: d for d in self.store.list_drivers()}
        return self._drivers_cache

    def _spoken_cars(self) -> dict[int, CarConfig]:
        """Cars as the commentator names them: an assigned driver replaces the car's name."""
        assignments = self._event_state.assignments
        drivers = self._driver_map() if assignments else {}
        cars: dict[int, CarConfig] = {}
        for car in self.settings.cars:
            driver = drivers.get(assignments.get(car.address, ""))
            if driver is not None:
                car = car.model_copy(update={"name": driver.name, "nickname": driver.nickname})
            cars[car.address] = car
        return cars

    def _fill_drivers(self, state: RaceState) -> None:
        """Copy the assignments into the cars of a published state."""
        assignments = self._event_state.assignments
        if not assignments:
            return
        drivers = self._driver_map()
        for car in state.cars:
            driver = drivers.get(assignments.get(car.address, ""))
            if driver is not None:
                car.driver_id = driver.id
                car.driver_name = driver.nickname or driver.name

    def list_drivers(self) -> list[Driver]:
        return self.store.list_drivers()

    def get_driver(self, driver_id: str) -> Driver:
        driver = self._driver_map().get(driver_id)
        if driver is None:
            raise ControllerError(404, f"Driver {driver_id!r} not found", "not_found")
        return driver

    @staticmethod
    def _unique_slug(name: str, taken: Container[str], fallback: str) -> str:
        folded = unicodedata.normalize("NFKD", name.casefold())
        ascii_name = folded.encode("ascii", "ignore").decode()
        slug = re.sub(r"[^a-z0-9]+", "-", ascii_name).strip("-")[:32].strip("-") or fallback
        candidate, n = slug, 1
        while candidate in taken:
            n += 1
            candidate = f"{slug}-{n}"
        return candidate

    def _unique_driver_id(self, name: str) -> str:
        return self._unique_slug(name, self._driver_map(), "driver")

    def _save_driver(self, driver: Driver) -> Driver:
        saved = self.store.save_driver(driver)
        self._drivers_cache = None
        self._mark_dirty()
        return saved

    def create_driver(self, name: str, nickname: str | None, bio: str) -> Driver:
        driver = Driver(
            id=self._unique_driver_id(name), name=name, nickname=nickname or None, bio=bio
        )
        return self._save_driver(driver)

    def update_driver(self, driver_id: str, new: Driver) -> Driver:
        """Replace name, nickname and bio. The id, photo flag and creation time are the
        server's: whatever the body says about them is ignored."""
        current = self.get_driver(driver_id)
        return self._save_driver(
            current.model_copy(
                update={"name": new.name, "nickname": new.nickname or None, "bio": new.bio}
            )
        )

    def delete_driver(self, driver_id: str) -> list[Driver]:
        self.get_driver(driver_id)
        self.avatars.delete(driver_id)
        self.store.delete_driver(driver_id)
        self._drivers_cache = None

        def drop(state: EventState) -> None:
            state.assignments = {a: d for a, d in state.assignments.items() if d != driver_id}
            if state.armed_driver_id == driver_id:
                state.armed_driver_id = None
                state.armed_until = None

        self._update_event_state(drop)
        return self.store.list_drivers()

    def set_driver_photo(self, driver_id: str, data: bytes, ext: str) -> Driver:
        driver = self.get_driver(driver_id)
        try:
            self.avatars.save(driver_id, data, ext)
        except OSError as exc:
            log.exception("could not store the photo of driver %s", driver_id)
            raise ControllerError(500, "Could not store the photo", "unknown") from exc
        return self._save_driver(driver.model_copy(update={"has_photo": True}))

    def delete_driver_photo(self, driver_id: str) -> Driver:
        driver = self.get_driver(driver_id)
        self.avatars.delete(driver_id)
        return self._save_driver(driver.model_copy(update={"has_photo": False}))

    # ------------------------------------------------------------------ event mode: assignments

    def assignments(self) -> dict[int, str]:
        return dict(self._event_state.assignments)

    async def set_assignments(self, changes: dict[int, str | None]) -> dict[int, str]:
        """Manual assignment: a driver id sets, ``None`` clears; other addresses are kept."""
        drivers = self._driver_map()
        for address, driver_id in changes.items():
            if not 0 <= address <= 5:
                raise ControllerError(
                    422, f"Address {address} is not a controller", "invalid_request"
                )
            if driver_id is not None and driver_id not in drivers:
                raise ControllerError(422, f"Unknown driver {driver_id!r}", "invalid_request")
        events: list[RaceEvent] = []

        def apply(state: EventState) -> None:
            for address, driver_id in changes.items():
                if driver_id is None:
                    state.assignments.pop(address, None)
                    continue
                if state.assignments.get(address) != driver_id:
                    driver = drivers[driver_id]
                    events.append(
                        DriverAssigned(
                            address=address,
                            driver_id=driver_id,
                            driver_name=driver.nickname or driver.name,
                            method="manual",
                        )
                    )
                state.assignments[address] = driver_id

        self._update_event_state(apply)
        if events:
            await self._process_events(events)
        return self.assignments()

    # ------------------------------------------------------------------ event mode: arming

    def _armed_driver_id(self) -> str | None:
        """The armed driver, or None when nobody is armed or the arming expired."""
        state = self._event_state
        if state.armed_driver_id is None:
            return None
        if state.armed_until is None or state.armed_until <= self._wall_clock():
            self.disarm()
            return None
        return state.armed_driver_id

    def arm(self, driver_id: str) -> None:
        """The next car over the line gets this driver. Replaces any earlier arming."""
        self.get_driver(driver_id)
        if self.engine.phase in _ACTIVE:
            raise ControllerError(409, "A race is in progress", "busy")
        until = self._wall_clock() + timedelta(seconds=ARM_TIMEOUT_S)

        def apply(state: EventState) -> None:
            state.armed_driver_id = driver_id
            state.armed_until = until

        self._update_event_state(apply)

    def disarm(self) -> None:
        if self._event_state.armed_driver_id is None and self._event_state.armed_until is None:
            return

        def apply(state: EventState) -> None:
            state.armed_driver_id = None
            state.armed_until = None

        self._update_event_state(apply)

    def _crossing_assignment(self, msg: Timer | Status, phase: RacePhase) -> list[RaceEvent]:
        """A start/finish crossing while no race is on gives the armed driver to that car."""
        if (
            not isinstance(msg, Timer)
            or msg.sector != 1
            or phase not in (RacePhase.IDLE, RacePhase.FINISHED)
            or not 0 <= msg.address <= 5
        ):
            return []
        driver_id = self._armed_driver_id()
        driver = self._driver_map().get(driver_id) if driver_id is not None else None
        if driver is None:
            return []
        address = msg.address

        def apply(state: EventState) -> None:
            # A driver sits in one car only: the arming moves them.
            state.assignments = {a: d for a, d in state.assignments.items() if d != driver.id}
            state.assignments[address] = driver.id
            state.armed_driver_id = None
            state.armed_until = None

        self._update_event_state(apply)
        return [
            DriverAssigned(
                address=address,
                driver_id=driver.id,
                driver_name=driver.nickname or driver.name,
                method="crossing",
            )
        ]

    # ------------------------------------------------------------------ event mode: voice

    def _build_transcriber(self) -> Transcriber:
        if self._transcriber is not None:
            return self._transcriber
        cfg = self.config
        if self.settings.commentary.llm_provider == "openai" and cfg.has_openai_key():
            assert cfg.openai_api_key is not None
            return OpenAITranscriber(cfg.openai_api_key.get_secret_value())
        if cfg.has_elevenlabs_key():
            assert cfg.elevenlabs_api_key is not None
            return ElevenLabsTranscriber(cfg.elevenlabs_api_key.get_secret_value())
        raise ControllerError(503, "No speech-to-text API key is configured", "llm_unavailable")

    async def transcribe(self, audio: bytes, media_type: str, language: str) -> dict[str, Any]:
        """Speech to text, plus the roster driver the text most likely names."""
        transcriber = self._build_transcriber()
        try:
            text = await transcriber.transcribe(audio, media_type, language)
        except TranscriptionError as exc:
            raise ControllerError(exc.status, exc.detail, exc.code) from exc
        if not text:
            raise ControllerError(422, "No speech recognised", "transcription_failed")
        return {"text": text, "name_guess": guess_driver(text, self.store.list_drivers())}

    # ------------------------------------------------------------------ event programs / sessions

    def _refresh_active_program(self) -> None:
        program_id = self.event_state.program_id
        if program_id is None:
            self._active_program = None
            return
        try:
            self._active_program = self.store.get_program(program_id)
        except Exception:
            log.exception("could not load event program %r", program_id)
            self._active_program = None

    def _current_session(self) -> tuple[EventProgram, SessionSpec, int] | None:
        """(program, session spec, index) of the running event, None when no event is active."""
        program = self._active_program
        if self.event_state.program_id is None or program is None or not program.sessions:
            return None
        index = max(0, min(self.event_state.current_index, len(program.sessions) - 1))
        return program, program.sessions[index], index

    def _session_info(self) -> SessionInfo | None:
        current = self._current_session()
        if current is None:
            return None
        program, spec, index = current
        return SessionInfo(
            program_id=program.id,
            program_name=program.name,
            session_id=spec.id,
            kind=spec.kind,
            name=spec.name,
            index=index,
            total=len(program.sessions),
        )

    def _session_config(self, spec: SessionSpec) -> RaceConfig:
        """The race config of a session: the user's race settings with the spec's format."""
        mode = RaceMode.TIMED if spec.kind is SessionKind.QUALIFYING else spec.mode
        return self.settings.race.model_copy(
            update={
                "mode": mode,
                "target_laps": spec.target_laps,
                "duration_s": spec.duration_s,
                "incidents": spec.incidents or self.settings.race.incidents,
                "pits": spec.pits or self.settings.race.pits,
            }
        )

    def _apply_session_rules(self, spec: SessionSpec | None) -> None:
        if spec is None:
            self.engine.set_session_rules()
        else:
            self.engine.set_session_rules(
                qualifying=spec.kind is SessionKind.QUALIFYING, false_start=spec.false_start
            )

    def _apply_idle_config(self) -> None:
        """Make the next race (also one started with the CU's START) run the current session.

        The rules always apply from the next race on; the config only while no race is active.
        """
        current = self._current_session()
        spec = current[1] if current is not None else None
        self._apply_session_rules(spec)
        if self.engine.phase not in _ACTIVE:
            self.engine.config = self._session_config(spec) if spec else self.settings.race
        self._mark_dirty()

    def get_event(self) -> EventState:
        self._armed_driver_id()  # clears (and persists) an expired arming first
        return self.event_state.model_copy(deep=True)

    def _require_no_race(self, action: str) -> None:
        if self.engine.phase in _ACTIVE:
            raise ControllerError(409, f"Cannot {action} while a race is in progress", "busy")

    def start_event(self, program_id: str) -> EventState:
        self._require_no_race("start an event")
        program = self.store.get_program(program_id)
        if program is None or not program.sessions:
            raise ControllerError(
                422, f"Program {program_id!r} not found or empty", "invalid_request"
            )

        def start(state: EventState) -> None:
            state.program_id = program.id
            state.current_index = 0
            state.results = []

        self._update_event_state(start)
        self._active_program = program
        self._apply_idle_config()
        return self.get_event()

    def next_session(self) -> EventState:
        self._require_no_race("change session")
        current = self._current_session()
        if current is None:
            raise ControllerError(409, "No event is running", "invalid_request")
        program, _spec, index = current
        if index + 1 >= len(program.sessions):
            raise ControllerError(409, "This is the last session of the event", "invalid_request")

        def advance(state: EventState) -> None:
            state.current_index = index + 1

        self._update_event_state(advance)
        self._apply_idle_config()
        return self.get_event()

    def stop_event(self) -> EventState:
        """End the event (results are kept until the next start). A running race goes on."""

        def stop(state: EventState) -> None:
            state.program_id = None
            state.current_index = 0

        self._update_event_state(stop)
        self._active_program = None
        self._apply_idle_config()
        return self.get_event()

    def list_programs(self) -> list[EventProgram]:
        return self.store.list_programs()

    def save_program(self, program: EventProgram) -> EventProgram:
        saved = self.store.save_program(program)
        if saved.id == self.event_state.program_id:
            self._active_program = saved
            self._apply_idle_config()
        return saved

    def delete_program(self, program_id: str) -> list[EventProgram]:
        """Delete a program (no error if unknown); deleting the running one stops the event."""
        if program_id == self.event_state.program_id:
            self.stop_event()
        self.store.delete_program(program_id)
        return self.store.list_programs()

    def _classification(self, state: RaceState) -> list[ClassificationRow]:
        """Final classification from the engine order (penalties / qualifying included)."""
        placed = sorted(
            (c for c in state.cars if c.position is not None), key=lambda c: c.position or 0
        )
        return [
            ClassificationRow(
                position=car.position or 0,
                address=car.address,
                driver_id=car.driver_id,
                name=car.driver_name or self._holder_name(car.address),
                laps=car.laps,
                best_lap_ms=car.best_lap_ms,
                total_time_ms=(
                    car.total_time_ms + car.penalty_ms if car.total_time_ms is not None else None
                ),
                penalty_ms=car.penalty_ms,
            )
            for car in placed
        ]

    def _finish_session(self, event: RaceFinished) -> SessionFinished | None:
        """Store (or replace) the result of the current session; None when there is none."""
        current = self._current_session()
        if current is None:
            return None
        _program, spec, _index = current
        rows = self._classification(self.race_state())
        if not rows:
            return None  # nobody crossed the line: nothing to classify
        result = SessionResult(
            session_id=spec.id, kind=spec.kind, race_id=self.engine.race_id, classification=rows
        )

        def store_result(state: EventState) -> None:
            for i, old in enumerate(state.results):
                if old.session_id == spec.id:
                    state.results[i] = result  # a re-run replaces the result
                    return
            state.results.append(result)

        self._update_event_state(store_result)  # kept in memory even if saving fails
        return SessionFinished(
            session_id=spec.id,
            kind=spec.kind,
            order=[row.address for row in rows],
            race_time_ms=event.race_time_ms,
        )

    def _event_commentary(self) -> EventCommentary | None:
        """The ``event`` facts block for the AI commentator (None when no event is active)."""
        current = self._current_session()
        if current is None:
            return None
        program, spec, index = current
        roster = self._driver_map()
        drivers: dict[int, Driver] = {}
        for address, driver_id in self.event_state.assignments.items():
            driver = roster.get(driver_id)
            if driver is not None:
                drivers[int(address)] = driver
        grid: dict[int, tuple[int, str]] = {}
        if spec.grid_from is not None:
            source = next(
                (r for r in self.event_state.results if r.session_id == spec.grid_from), None
            )
            if source is not None:
                grid = {row.address: (row.position, row.name) for row in source.classification}
        return build_event_commentary(program, spec, index, drivers, grid, self.cars_by_address())
