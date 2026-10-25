"""Domain models shared by the engine, commentary, API and (via JSON) the frontend.

These are the integration contract: field names here are exactly what goes over
the wire (see docs/PROTOCOL.md). All times are integer milliseconds.
"""

from __future__ import annotations

from datetime import UTC, datetime
from enum import StrEnum
from typing import Annotated, Literal

from pydantic import BaseModel, Field


def utcnow() -> datetime:
    return datetime.now(UTC)


# --------------------------------------------------------------------------- config


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


class RaceConfig(BaseModel):
    mode: RaceMode = RaceMode.PRACTICE
    target_laps: int = Field(default=10, ge=1, le=999)  # used in LAPS mode
    duration_s: int = Field(default=300, ge=10, le=24 * 3600)  # used in TIMED mode
    min_lap_ms: int = Field(default=2000, ge=100)  # shorter = double trigger, ignored
    max_lap_ms: int = Field(default=120_000, ge=1000)  # longer = not a racing lap (no best lap)
    low_fuel_threshold: int = Field(default=3, ge=0, le=15)
    idle_after_s: int = Field(default=30, ge=5)


class CarConfig(BaseModel):
    address: int = Field(ge=0, le=7)
    name: str
    color: str = "#888888"  # CSS hex color
    nickname: str | None = None  # how the commentator calls the driver


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
    | SectorCompleted,
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
