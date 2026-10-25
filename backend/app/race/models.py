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
    | TrackRecord,
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
