"""Domain models shared by the engine, commentary, API and (via JSON) the frontend.

These are the integration contract: field names here are exactly what goes over
the wire (see docs/PROTOCOL.md). All times are integer milliseconds.
"""

from __future__ import annotations

from datetime import UTC, datetime
from enum import StrEnum
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field


def utcnow() -> datetime:
    return datetime.now(UTC)


# --------------------------------------------------------------------------- config


class SessionKind(StrEnum):
    PRACTICE = "practice"
    QUALIFYING = "qualifying"
    RACE = "race"


class RaceMode(StrEnum):
    PRACTICE = "practice"
    LAPS = "laps"
    TIMED = "timed"


class RacePhase(StrEnum):
    IDLE = "idle"  # no race configured / reset
    STARTING = "starting"  # start lights sequence in progress
    RUNNING = "running"
    PAUSED = "paused"  # pace car deployed / race stopped by CU
    FINISHED = "finished"


class IncidentRules(BaseModel):
    """Probable-incident detection (docs/PROTOCOL.md "Roadmap wave 1" -> "Incidents")."""

    detect: bool = True
    # A car is probably off once it is overdue on its current stretch by this multiple
    # of the expected stretch time (CarState.segment_estimates).
    overdue_factor: float = Field(default=2.5, ge=1.5, le=10.0)
    auto_pace_car: bool = False  # deploy the CU pace car while an incident is open
    penalty_s: int = Field(default=0, ge=0, le=120)  # added to penalty_ms per incident


class PitRules(BaseModel):
    """Mandatory pit stops (docs/PROTOCOL.md "Roadmap wave 1" -> "Fuel strategy")."""

    min_stops: int = Field(default=0, ge=0, le=20)  # 0 = no mandatory stop
    missed_penalty_s: int = Field(default=30, ge=0, le=600)  # per missing stop, at the finish


class RaceConfig(BaseModel):
    mode: RaceMode = RaceMode.PRACTICE
    target_laps: int = Field(default=10, ge=1, le=999)  # used in LAPS mode
    duration_s: int = Field(default=300, ge=10, le=24 * 3600)  # used in TIMED mode
    min_lap_ms: int = Field(default=2000, ge=100)  # shorter = double trigger, ignored
    max_lap_ms: int = Field(default=120_000, ge=1000)  # longer = not a racing lap (no best lap)
    low_fuel_threshold: int = Field(default=3, ge=0, le=15)
    idle_after_s: int = Field(default=30, ge=5)
    incidents: IncidentRules = Field(default_factory=IncidentRules)
    pits: PitRules = Field(default_factory=PitRules)


class ControllerSettings(BaseModel):
    """Per-controller values the app writes to the CU (docs/PROTOCOL.md "Roadmap wave 2").

    Raw CU values 0..15 (carreralib setspeed / setbrake / setfuel). None = leave the CU's
    own value untouched. Semantics on the real CU are still to be verified on the track.
    """

    speed: int | None = Field(default=None, ge=0, le=15)
    brake: int | None = Field(default=None, ge=0, le=15)
    fuel: int | None = Field(default=None, ge=0, le=15)


class CarConfig(BaseModel):
    address: int = Field(ge=0, le=7)
    name: str
    color: str = "#888888"  # CSS hex color
    nickname: str | None = None  # how the commentator calls the driver
    logo_id: str | None = None  # Logo.id from the logo library (GET /api/logos/{id}/image)
    controller: ControllerSettings = Field(default_factory=ControllerSettings)  # wave 2


DEFAULT_CAR_COLORS = ["#e53935", "#1e88e5", "#43a047", "#fdd835", "#8e24aa", "#fb8c00"]


def default_cars() -> list[CarConfig]:
    return [
        CarConfig(address=i, name=f"Car {i + 1}", color=DEFAULT_CAR_COLORS[i]) for i in range(6)
    ]


# --------------------------------------------------------------------------- state


class Lap(BaseModel):
    address: int
    lap_number: int  # 1-based, the lap just completed
    lap_ms: int
    race_time_ms: int  # race clock when the lap was completed
    valid: bool = True  # False when > max_lap_ms (e.g. after a crash / pit)


class Crossing(BaseModel):
    """A car passing a sensor: 1 = start/finish line, 2 and 3 = Check Lanes."""

    sensor: int = Field(ge=1, le=3)
    race_time_ms: int  # CU-timestamp based race clock of the crossing


class TrackPosition(BaseModel):
    """Where a car probably is, as a fraction of the lap along the layout path.

    The browser animates s(t) between s_from and s_to:
        s = s_from + (s_to - s_from) * clamp((race_now - anchor_race_ms) / expected_ms)
    capped just before s_to (a car cannot pass a sensor unseen). When s_to < s_from the
    stretch wraps through the start/finish line (s = 1.0 == 0.0).
    """

    from_sensor: int
    to_sensor: int
    s_from: float = Field(ge=0, lt=1)
    s_to: float = Field(ge=0, lt=1)
    anchor_race_ms: int  # race time when the car passed from_sensor
    expected_ms: int | None = None  # None = no history yet: show the car at s_from
    in_pit: bool = False
    confidence: Literal["measured", "estimated", "stale"] = "estimated"
    # stale = expected time exceeded by a wide margin (crash, deslot, stopped)


class Incident(BaseModel):
    """An open incident: the car is probably off the track or stopped."""

    started_race_ms: int
    source: Literal["overdue", "marshal"]  # detected by the engine, or reported by hand
    from_sensor: int | None = None  # the stretch the car was driving (see TrackPosition)
    to_sensor: int | None = None
    s: float | None = None  # estimated place on the layout path (0..1), None without a map


class FuelStrategy(BaseModel):
    """Fuel prediction for one car (needs CU fuel mode). Levels are the CU's 0..15."""

    per_lap: float | None = None  # levels used per lap, learned from laps without a pit stop
    laps_left: float | None = None  # laps the current level lasts at per_lap
    laps_to_go: int | None = None  # laps this car still has to drive (LAPS mode / estimate)
    must_pit: bool = False  # cannot reach the finish without stopping
    pit_by_lap: int | None = None  # latest lap to enter the pit, when must_pit


class CarState(BaseModel):
    address: int
    name: str
    color: str
    laps: int = 0
    last_lap_ms: int | None = None
    best_lap_ms: int | None = None
    avg_lap_ms: int | None = None
    total_time_ms: int | None = None  # race time at last line crossing
    position: int | None = None  # 1-based; None until first crossing
    gap_to_leader_ms: int | None = None
    gap_to_leader_laps: int = 0  # >0 when lapped; then gap_to_leader_ms is None
    gap_to_ahead_ms: int | None = None
    fuel: int | None = None  # 0..15, None when CU does not report fuel
    in_pit: bool = False
    pit_stops: int = 0
    finished: bool = False
    lap_times: list[int] = Field(default_factory=list)  # all completed lap times, in order
    # Sector timing (Check Lane sensors). Sector i is the stretch that ENDS at the i-th
    # sensor in driving order: with Check Lanes 2 and 3 installed, sector 1 runs from the
    # start/finish line to sensor 2, sector 2 from sensor 2 to sensor 3, sector 3 from
    # sensor 3 back to the line. Lists have RaceState.num_sectors entries.
    current_sectors: list[int | None] = Field(default_factory=list)  # lap in progress
    last_sectors: list[int | None] = Field(default_factory=list)  # last completed lap
    best_sectors: list[int | None] = Field(default_factory=list)  # personal bests
    last_crossing: Crossing | None = None  # most recent sensor passed by this car
    # Expected time (ms) to drive each segment, learned from previous laps (e.g. EWMA).
    # Key "a>b" = from sensor a to sensor b, sensors being 1 (start/finish), 2, 3.
    segment_estimates: dict[str, int] = Field(default_factory=dict)
    track_pos: TrackPosition | None = None  # only when the current layout has a map
    # Event mode: the person driving this controller in the current session (None = the
    # car's own name/nickname is shown). See Driver / SessionInfo.
    driver_id: str | None = None
    driver_name: str | None = None  # display name (nickname or name) of that driver
    penalty_ms: int = 0  # time penalties added to the result (false start, incidents)
    # Roadmap wave 1
    logo_id: str | None = None  # copied from CarConfig.logo_id
    incident: Incident | None = None  # open incident, None while racing normally
    incidents: int = 0  # incidents in this race
    incident_lost_ms: int = 0  # time spent in closed incidents
    fuel_strategy: FuelStrategy | None = None  # only in fuel mode
    fuel_laps: list[int | None] = Field(default_factory=list)  # fuel level at each lap end


class BestLapRecord(BaseModel):
    address: int
    lap_ms: int
    lap_number: int


class TrackRecordInfo(BaseModel):
    """All-time best valid lap on a track layout, across races."""

    layout: str
    lap_ms: int
    address: int
    holder_name: str  # car name/nickname at the time the record was set
    race_id: int | None = None
    set_at: datetime = Field(default_factory=utcnow)


class SessionInfo(BaseModel):
    """Which session of the running event program this race is."""

    program_id: str
    program_name: str
    session_id: str
    kind: SessionKind
    name: str
    index: int  # 0-based position in the program
    total: int  # number of sessions in the program


class PairingState(BaseModel):
    """The car <-> controller pairing wizard (CU CODE button), see PROTOCOL "Pairing"."""

    phase: Literal["waiting", "paired", "timeout", "cancelled", "failed"]
    target_address: int = Field(ge=0, le=5)  # the controller the user is coding the car to
    car: CarConfig  # the car profile to store at that address once paired
    started_at: datetime
    expires_at: datetime
    from_address: int | None = None  # re-coding: this slot is reset once paired
    detected_address: int | None = None  # last address seen crossing the line (a hint)
    error: str | None = None  # English, for logs (failed)


class RaceState(BaseModel):
    race_id: int | None = None
    phase: RacePhase = RacePhase.IDLE
    config: RaceConfig = Field(default_factory=RaceConfig)
    start_light: int = 0  # Status.start passthrough, drives the UI lights
    race_time_ms: int = 0  # elapsed race clock
    remaining_ms: int | None = None  # TIMED mode
    remaining_laps: int | None = None  # LAPS mode, for the leader
    fuel_mode: bool = False
    pit_lane: bool = False
    cars: list[CarState] = Field(default_factory=list)  # sorted by position, unplaced last
    best_lap: BestLapRecord | None = None
    track_record: TrackRecordInfo | None = None  # for the current settings.track_layout
    layout: str = "default"  # current settings.track.layout
    num_sectors: int = 1  # 1 + number of Check Lane sensors (layout-declared or seen)
    best_sectors: list[int | None] = Field(default_factory=list)  # overall best per sector
    session: SessionInfo | None = None  # set while an event program is running
    pairing: PairingState | None = None  # wave 2: the pairing wizard, while not idle


# --------------------------------------------------------------------------- events


class _EventBase(BaseModel):
    at: datetime = Field(default_factory=utcnow)
    race_time_ms: int = 0


class RaceStarted(_EventBase):
    type: Literal["race_started"] = "race_started"
    mode: RaceMode
    addresses: list[int] = Field(default_factory=list)


class LapCompleted(_EventBase):
    type: Literal["lap_completed"] = "lap_completed"
    address: int
    lap_number: int
    lap_ms: int
    position: int | None = None
    valid: bool = True


class BestLap(_EventBase):
    type: Literal["best_lap"] = "best_lap"
    address: int
    lap_ms: int
    previous_ms: int | None = None
    overall: bool  # True = new best of the whole race, False = personal best only


class PositionChange(_EventBase):
    type: Literal["position_change"] = "position_change"
    address: int
    old_position: int
    new_position: int
    passed_address: int | None = None  # car overtaken, when known
    approximate: bool = True  # derived from line crossings only


class PitEntry(_EventBase):
    type: Literal["pit_entry"] = "pit_entry"
    address: int


class PitExit(_EventBase):
    type: Literal["pit_exit"] = "pit_exit"
    address: int
    duration_ms: int | None = None
    fuel: int | None = None


class LowFuel(_EventBase):
    type: Literal["low_fuel"] = "low_fuel"
    address: int
    fuel: int


class RaceFinished(_EventBase):
    type: Literal["race_finished"] = "race_finished"
    winner: int | None = None
    order: list[int] = Field(default_factory=list)  # addresses by final position


class Idle(_EventBase):
    type: Literal["idle"] = "idle"
    seconds: int


class TrackRecord(_EventBase):
    """A valid lap beat the all-time record of the current layout (emitted by the controller)."""

    type: Literal["track_record"] = "track_record"
    address: int
    lap_ms: int
    layout: str
    previous_ms: int | None = None  # None when this layout had no record yet
    previous_holder: str | None = None


class SectorCompleted(_EventBase):
    """A car finished a sector (needs Check Lane sensors). Emitted while RUNNING/PAUSED."""

    type: Literal["sector_completed"] = "sector_completed"
    address: int
    lap_number: int  # the lap this sector belongs to (1-based)
    sector: int  # 1..num_sectors, see CarState.current_sectors
    split_ms: int
    personal_best: bool = False
    overall_best: bool = False


class FalseStart(_EventBase):
    """The CU reported a false start (Status.start 8/9). The CU does not say which car
    jumped, so `address` is set only if it could be inferred (else None)."""

    type: Literal["false_start"] = "false_start"
    address: int | None = None
    action: Literal["ignore", "warn", "penalty", "restart"]
    penalty_ms: int = 0


class DriverAssigned(_EventBase):
    """A driver was assigned to a controller (manually, by voice or by first crossing)."""

    type: Literal["driver_assigned"] = "driver_assigned"
    address: int
    driver_id: str
    driver_name: str
    method: Literal["manual", "crossing", "voice"]


class SessionFinished(_EventBase):
    """An event-program session ended; results are stored in the event state."""

    type: Literal["session_finished"] = "session_finished"
    session_id: str
    kind: SessionKind
    order: list[int] = Field(default_factory=list)  # addresses by final classification


class IncidentStarted(_EventBase):
    type: Literal["incident_started"] = "incident_started"
    address: int
    source: Literal["overdue", "marshal"]
    from_sensor: int | None = None
    to_sensor: int | None = None
    s: float | None = None
    count: int  # incidents of this car in the race, this one included
    penalty_ms: int = 0  # penalty added for it (IncidentRules.penalty_s)


class IncidentCleared(_EventBase):
    type: Literal["incident_cleared"] = "incident_cleared"
    address: int
    by: Literal["crossing", "marshal", "race_end"]
    lost_ms: int  # race time between start and clear


class PitMissed(_EventBase):
    """At the finish: a car did fewer pit stops than PitRules.min_stops."""

    type: Literal["pit_missed"] = "pit_missed"
    address: int
    stops: int
    required: int
    penalty_ms: int


class CarPaired(_EventBase):
    """The pairing wizard saw the coded car cross the line."""

    type: Literal["car_paired"] = "car_paired"
    address: int
    name: str
    matches_target: bool  # False: the car answered on another controller than chosen


RaceEvent = Annotated[
    RaceStarted
    | LapCompleted
    | BestLap
    | PositionChange
    | PitEntry
    | PitExit
    | LowFuel
    | RaceFinished
    | Idle
    | TrackRecord
    | SectorCompleted
    | FalseStart
    | DriverAssigned
    | SessionFinished
    | IncidentStarted
    | IncidentCleared
    | PitMissed
    | CarPaired,
    Field(discriminator="type"),
]


# --------------------------------------------------------------------------- commentary


class CommentaryPriority(StrEnum):
    LOW = "low"
    NORMAL = "normal"
    HIGH = "high"


class CommentaryLine(BaseModel):
    id: str
    text: str
    priority: CommentaryPriority
    event_type: str
    at: datetime = Field(default_factory=utcnow)
    source: Literal["template", "llm"] = "template"
    audio_url: str | None = None  # set when TTS audio is available for the browser


# --------------------------------------------------------------------------- settings


class Verbosity(StrEnum):
    LOW = "low"
    NORMAL = "normal"
    HIGH = "high"


Language = Literal["en", "it"]


class CommentarySettings(BaseModel):
    enabled: bool = True
    language: Language = "it"
    voice_id: str | None = None  # None -> ELEVENLABS_VOICE_ID from .env
    verbosity: Verbosity = Verbosity.NORMAL
    tts_enabled: bool = True
    llm_enabled: bool = False
    llm_provider: Literal["anthropic", "openai"] = "anthropic"
    audio_output: Literal["browser", "local"] = "browser"
    session_char_budget: int = Field(default=20_000, ge=0)
    monthly_char_budget: int = Field(default=100_000, ge=0)


class TrackSettings(BaseModel):
    mode: Literal["simulator", "ble", "serial"] = "simulator"
    address: str | None = None  # BLE address or serial port
    # Name of the current track layout; all-time lap records are kept per layout.
    layout: str = Field(default="default", min_length=1, max_length=40)


class Settings(BaseModel):
    """User-editable settings persisted in SQLite. API keys are never part of this."""

    ui_language: Language = "en"
    cars: list[CarConfig] = Field(default_factory=default_cars)
    commentary: CommentarySettings = Field(default_factory=CommentarySettings)
    track: TrackSettings = Field(default_factory=TrackSettings)
    race: RaceConfig = Field(default_factory=RaceConfig)
    # Keyboard shortcut overrides: action id -> key combo (e.g. "Shift+P"); "" disables the
    # action. Missing actions use the defaults defined by the frontend.
    shortcuts: dict[str, str] = Field(default_factory=dict)  # limits: settings_errors()


# --------------------------------------------------------------------------- track map


class LayoutSensor(BaseModel):
    """Where a Check Lane sensor sits on the drawn path."""

    sensor: int = Field(ge=2, le=3)  # the sector number the CU reports for it
    s: float = Field(gt=0, lt=1)  # fraction of the lap from the start/finish line


class TrackLayout(BaseModel):
    """A drawn (or photo-derived) map of a track layout.

    `points` is the closed centre line in DRIVING ORDER, normalised to 0..1 in both axes
    (x right, y down), starting at the start/finish line: points[0] is the line and the
    path implicitly closes from points[-1] back to points[0]. `aspect` = width / height of
    the drawing. Fractions `s` (sensors, pit, car positions) are measured by path length
    in DISPLAY space, i.e. on the points scaled to (x * aspect, y), so that equal track
    lengths map to equal `s` whatever the drawing's proportions.
    """

    name: str = Field(min_length=1, max_length=40)  # == TrackSettings.layout
    points: list[tuple[float, float]] = Field(min_length=8, max_length=2000)
    aspect: float = Field(default=1.5, gt=0.1, lt=10)
    sensors: list[LayoutSensor] = Field(default_factory=list, max_length=2)
    pit_s: float | None = Field(default=None, ge=0, lt=1)  # where to show cars in the pit
    source: Literal["drawn", "photo"] = "drawn"
    updated_at: datetime = Field(default_factory=utcnow)


class LayoutDraft(BaseModel):
    """Result of converting a photo to a map; NOT saved until the user confirms it."""

    layout: TrackLayout
    notes: str = ""  # model's remarks (e.g. "start line guessed"), in the UI language


# --------------------------------------------------------------------------- controllers


class ControllerStatus(BaseModel):
    """GET /api/controllers: what the app wants on each controller and what it last wrote."""

    address: int
    effective: ControllerSettings  # car settings with the assigned driver's overrides
    applied: ControllerSettings | None = None  # last values written successfully, None = never
    pending: bool = False  # effective differs from applied (waits for connect / race end)
    driver_id: str | None = None  # whose profile is in effect, if any


class GarageCar(BaseModel):
    """GET /api/garage: a car with its all-time stats from the race history."""

    address: int
    car: CarConfig
    races: int = 0
    laps: int = 0
    best_lap_ms: int | None = None  # all-time best valid lap on any layout
    best_lap_layout: str | None = None


# --------------------------------------------------------------------------- logos


class Logo(BaseModel):
    """A brand logo in the library, reusable by several cars (CarConfig.logo_id)."""

    id: str = Field(min_length=1, max_length=40)  # generated by the backend, like Driver.id
    name: str = Field(min_length=1, max_length=40)  # e.g. "Ferrari"
    media_type: Literal["image/png", "image/jpeg", "image/webp", "image/svg+xml"]
    updated_at: datetime = Field(default_factory=utcnow)


# --------------------------------------------------------------------------- event mode


class Driver(BaseModel):
    """A person in the roster, reused across sessions and events (cars stay CarConfig)."""

    id: str = Field(min_length=1, max_length=40)  # stable slug/uuid, generated by the backend
    name: str = Field(min_length=1, max_length=40)
    nickname: str | None = Field(default=None, max_length=24)
    bio: str = Field(default="", max_length=300)  # facts the AI commentator may use
    has_photo: bool = False  # avatar stored by the backend (GET /api/drivers/{id}/photo)
    # Handicap profile (wave 2): non-null fields override the car's controller settings
    # while this driver is assigned to it.
    controller: ControllerSettings | None = None
    created_at: datetime = Field(default_factory=utcnow)


class FalseStartRule(BaseModel):
    action: Literal["ignore", "warn", "penalty", "restart"] = "warn"
    penalty_s: int = Field(default=5, ge=0, le=120)  # used by "penalty"


class SessionSpec(BaseModel):
    """One session of an event program."""

    id: str = Field(min_length=1, max_length=40)
    kind: SessionKind
    name: str = Field(default="", max_length=40)  # "" = derived from kind in the UI
    # practice: duration_s or open-ended; qualifying: best lap within duration_s (or
    # target_laps laps); race: target_laps or duration_s
    mode: RaceMode = RaceMode.LAPS
    target_laps: int = Field(default=10, ge=1, le=999)
    duration_s: int = Field(default=300, ge=10, le=24 * 3600)
    false_start: FalseStartRule = Field(default_factory=FalseStartRule)
    grid_from: str | None = None  # session id whose classification sets the order shown
    incidents: IncidentRules | None = None  # None = settings.race.incidents
    pits: PitRules | None = None  # None = settings.race.pits


class CommentaryContext(BaseModel):
    """Extra facts and style for the AI commentator (passed with the race facts)."""

    event_name: str = Field(default="", max_length=80)
    location: str = Field(default="", max_length=80)
    sponsors: list[str] = Field(default_factory=list, max_length=10)
    tone: Literal["family", "enthusiastic", "technical", "ironic"] = "enthusiastic"
    notes: str = Field(default="", max_length=2000)
    avoid_words: list[str] = Field(default_factory=list, max_length=50)


class EventProgram(BaseModel):
    id: str = Field(min_length=1, max_length=40)
    name: str = Field(min_length=1, max_length=80)
    sessions: list[SessionSpec] = Field(default_factory=list, max_length=20)
    commentary: CommentaryContext = Field(default_factory=CommentaryContext)
    updated_at: datetime = Field(default_factory=utcnow)


class ClassificationRow(BaseModel):
    position: int
    address: int
    driver_id: str | None = None
    name: str  # driver or car display name at the time
    laps: int
    best_lap_ms: int | None = None
    total_time_ms: int | None = None  # including penalty_ms
    penalty_ms: int = 0


class SessionResult(BaseModel):
    session_id: str
    kind: SessionKind
    race_id: int | None = None
    finished_at: datetime = Field(default_factory=utcnow)
    classification: list[ClassificationRow] = Field(default_factory=list)


class EventState(BaseModel):
    """Runtime state of the active event (persisted; survives restarts)."""

    program_id: str | None = None
    current_index: int = 0  # session to run next / running
    assignments: dict[int, str] = Field(default_factory=dict)  # address -> driver id
    # One per session_id: re-running a session replaces its result.
    results: list[SessionResult] = Field(default_factory=list)
    # "Assign on next crossing": the armed driver and when the arming expires (60 s).
    armed_driver_id: str | None = None
    armed_until: datetime | None = None


class ExportBundle(BaseModel):
    """A portable JSON export of the configuration. API keys and photos are never included."""

    model_config = ConfigDict(extra="forbid")

    format: Literal["carrera-rms"] = "carrera-rms"
    version: int = 1
    exported_at: datetime = Field(default_factory=utcnow)
    app_version: str = ""
    settings: Settings | None = None
    drivers: list[Driver] | None = None
    programs: list[EventProgram] | None = None
    layouts: list[TrackLayout] | None = None
    records: list[TrackRecordInfo] | None = None
