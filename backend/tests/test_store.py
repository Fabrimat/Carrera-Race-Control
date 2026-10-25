from __future__ import annotations

from pathlib import Path

import pytest

from app.race.models import (
    CarConfig,
    CarState,
    Lap,
    RaceConfig,
    RaceMode,
    RacePhase,
    RaceState,
    Settings,
    Verbosity,
)
from app.race.store import RaceStore

CARS = [
    CarConfig(address=0, name="Rossa", color="#e53935", nickname="Rocky"),
    CarConfig(address=1, name="Blu", color="#1e88e5"),
]

SUMMARY_KEYS = {"id", "started_at", "finished_at", "mode", "winner_name", "laps", "best_lap_ms"}
DETAIL_KEYS = SUMMARY_KEYS | {"config", "results", "laps"}
LAP_KEYS = {"address", "lap_number", "lap_ms", "race_time_ms", "valid"}


def _finished_state() -> RaceState:
    # Deliberately unsorted and with an unplaced car, to check ordering in results.
    return RaceState(
        phase=RacePhase.FINISHED,
        cars=[
            CarState(address=1, name="Blu", color="#1e88e5", laps=2, position=2),
            CarState(address=2, name="Verde", color="#43a047", laps=0, position=None),
            CarState(address=0, name="Rossa", color="#e53935", laps=2, position=1),
        ],
    )


@pytest.fixture
def store() -> RaceStore:
    s = RaceStore(":memory:")
    yield s
    s.close()


def test_create_add_finish_roundtrip(store: RaceStore) -> None:
    config = RaceConfig(mode=RaceMode.LAPS, target_laps=2)
    race_id = store.create_race(config, CARS)
    assert isinstance(race_id, int)

    store.add_lap(race_id, Lap(address=0, lap_number=1, lap_ms=6000, race_time_ms=6000))
    store.add_lap(race_id, Lap(address=1, lap_number=1, lap_ms=6500, race_time_ms=6500))
    store.add_lap(
        race_id, Lap(address=0, lap_number=2, lap_ms=130_000, race_time_ms=136_000, valid=False)
    )
    store.add_lap(race_id, Lap(address=0, lap_number=3, lap_ms=5800, race_time_ms=141_800))
    store.finish_race(race_id, _finished_state())

    detail = store.get_race(race_id)
    assert detail is not None
    assert set(detail) == DETAIL_KEYS
    assert detail["id"] == race_id
    assert detail["mode"] == "laps"
    assert detail["started_at"]
    assert detail["finished_at"]
    assert detail["winner_name"] == "Rossa"
    assert detail["laps"] == [
        {"address": 0, "lap_number": 1, "lap_ms": 6000, "race_time_ms": 6000, "valid": True},
        {"address": 1, "lap_number": 1, "lap_ms": 6500, "race_time_ms": 6500, "valid": True},
        {"address": 0, "lap_number": 2, "lap_ms": 130_000, "race_time_ms": 136_000, "valid": False},
        {"address": 0, "lap_number": 3, "lap_ms": 5800, "race_time_ms": 141_800, "valid": True},
    ]
    assert all(set(lap) == LAP_KEYS for lap in detail["laps"])
    # Summary derived fields: lap count is all laps, best is the best VALID lap.
    assert detail["best_lap_ms"] == 5800
    assert len(detail["laps"]) == 4
    assert detail["config"] == config.model_dump(mode="json")
    # Results are CarState dicts ordered by position, unplaced last.
    assert [r["address"] for r in detail["results"]] == [0, 1, 2]
    assert detail["results"][0] == _finished_state().cars[2].model_dump(mode="json")
    assert set(detail["results"][0]) == set(CarState.model_fields)


def test_unfinished_race_has_no_finish_fields(store: RaceStore) -> None:
    race_id = store.create_race(RaceConfig(), CARS)
    detail = store.get_race(race_id)
    assert detail is not None
    assert detail["finished_at"] is None
    assert detail["winner_name"] is None
    assert detail["results"] == []
    assert detail["laps"] == []
    assert detail["best_lap_ms"] is None
    assert detail["mode"] == "practice"


def test_finish_unknown_race_raises(store: RaceStore) -> None:
    with pytest.raises(KeyError):
        store.finish_race(999, _finished_state())


def test_get_race_unknown_id_returns_none(store: RaceStore) -> None:
    assert store.get_race(12345) is None


def test_list_races_newest_first(store: RaceStore) -> None:
    assert store.list_races() == []
    first = store.create_race(RaceConfig(mode=RaceMode.PRACTICE), CARS)
    second = store.create_race(RaceConfig(mode=RaceMode.TIMED), CARS)
    store.add_lap(second, Lap(address=1, lap_number=1, lap_ms=7000, race_time_ms=7000))

    races = store.list_races()
    assert [r["id"] for r in races] == [second, first]
    assert all(set(r) == SUMMARY_KEYS for r in races)
    assert races[0]["mode"] == "timed"
    assert races[0]["laps"] == 1
    assert races[0]["best_lap_ms"] == 7000
    assert races[1]["laps"] == 0
    assert races[1]["best_lap_ms"] is None


def test_settings_defaults_when_empty(store: RaceStore) -> None:
    assert store.load_settings() == Settings()


def test_settings_roundtrip_and_overwrite(store: RaceStore) -> None:
    settings = Settings()
    settings.commentary.verbosity = Verbosity.HIGH
    settings.commentary.voice_id = "voice-abc"
    store.save_settings(settings)
    assert store.load_settings() == settings

    settings.commentary.verbosity = Verbosity.LOW
    store.save_settings(settings)
    assert store.load_settings().commentary.verbosity == Verbosity.LOW


def test_counters(store: RaceStore) -> None:
    key = "tts_chars:2026-10"
    assert store.get_counter(key) == 0
    assert store.add_to_counter(key, 120) == 120
    assert store.add_to_counter(key, 30) == 150
    assert store.get_counter(key) == 150
    assert store.get_counter("tts_chars:2026-11") == 0


def test_file_database_persists_and_creates_parent_dir(tmp_path: Path) -> None:
    db_path = tmp_path / "nested" / "dir" / "race.db"
    store = RaceStore(db_path)
    race_id = store.create_race(RaceConfig(), CARS)
    store.add_lap(race_id, Lap(address=0, lap_number=1, lap_ms=6000, race_time_ms=6000))
    store.save_settings(Settings(cars=CARS))
    store.add_to_counter("k", 7)
    store.close()
    store.close()  # idempotent

    assert db_path.is_file()
    reopened = RaceStore(db_path)
    try:
        detail = reopened.get_race(race_id)
        assert detail is not None
        assert len(detail["laps"]) == 1
        assert reopened.load_settings().cars == CARS
        assert reopened.get_counter("k") == 7
        # Reopening an existing database must not re-initialise the schema version.
        assert reopened.list_races()[0]["id"] == race_id
    finally:
        reopened.close()
