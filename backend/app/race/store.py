"""SQLite persistence for races, laps, settings and counters.

Plain sqlite3, no ORM. The connection is shared between threads
(check_same_thread=False) and every operation holds a lock, so the methods can be
called from the asyncio thread. All operations are small and fast.
"""

from __future__ import annotations

import json
import sqlite3
import threading
from datetime import datetime
from pathlib import Path
from typing import Any

from app.race.models import (
    CarConfig,
    Lap,
    RaceConfig,
    RaceState,
    Settings,
    TrackRecordInfo,
    utcnow,
)

SCHEMA_VERSION = 2

# Version 1 baseline (also what a fresh database starts from before migrating).
_SCHEMA = """
CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS races (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    mode TEXT NOT NULL,
    config_json TEXT NOT NULL,
    cars_json TEXT NOT NULL,
    winner_name TEXT,
    results_json TEXT
);
CREATE TABLE IF NOT EXISTS laps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    race_id INTEGER NOT NULL REFERENCES races(id) ON DELETE CASCADE,
    address INTEGER NOT NULL,
    lap_number INTEGER NOT NULL,
    lap_ms INTEGER NOT NULL,
    race_time_ms INTEGER NOT NULL,
    valid INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS laps_race ON laps(race_id, id);
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS counters (
    key TEXT PRIMARY KEY,
    value INTEGER NOT NULL
);
"""

# Upgrade steps: target version -> statements (idempotent), applied in order on open.
_MIGRATIONS: dict[int, tuple[str, ...]] = {
    2: (
        """
        CREATE TABLE IF NOT EXISTS track_records (
            layout TEXT PRIMARY KEY,
            lap_ms INTEGER NOT NULL,
            address INTEGER NOT NULL,
            holder_name TEXT NOT NULL,
            race_id INTEGER,
            set_at TEXT NOT NULL
        )
        """,
    ),
}

# One row per race with derived lap count and best valid lap. Used by list and detail.
_SUMMARY_SQL = """
SELECT
    r.id AS id,
    r.started_at AS started_at,
    r.finished_at AS finished_at,
    r.mode AS mode,
    r.winner_name AS winner_name,
    (SELECT COUNT(*) FROM laps l WHERE l.race_id = r.id) AS laps,
    (SELECT MIN(l.lap_ms) FROM laps l WHERE l.race_id = r.id AND l.valid = 1) AS best_lap_ms
FROM races r
"""


class RaceStore:
    """Single-file SQLite store. Use ``":memory:"`` for an in-process database."""

    def __init__(self, path: str | Path) -> None:
        self._lock = threading.Lock()
        if str(path) == ":memory:":
            db_target = ":memory:"
        else:
            db_path = Path(path)
            db_path.parent.mkdir(parents=True, exist_ok=True)
            db_target = str(db_path)
        self._conn = sqlite3.connect(db_target, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA foreign_keys = ON")
        self._init_schema()

    # ------------------------------------------------------------------ setup

    def _init_schema(self) -> None:
        with self._lock, self._conn:
            self._conn.executescript(_SCHEMA)
            row = self._conn.execute("SELECT version FROM schema_version").fetchone()
            if row is None:
                self._conn.execute("INSERT INTO schema_version (version) VALUES (1)")
                version = 1
            else:
                version = int(row["version"])
            if version > SCHEMA_VERSION:
                raise RuntimeError(
                    f"Database schema version {version} is newer than supported ({SCHEMA_VERSION})"
                )
            for target in range(version + 1, SCHEMA_VERSION + 1):
                for statement in _MIGRATIONS[target]:
                    self._conn.execute(statement)
                self._conn.execute("UPDATE schema_version SET version = ?", (target,))

    def close(self) -> None:
        """Close the underlying connection. Safe to call more than once."""
        with self._lock:
            self._conn.close()

    # ------------------------------------------------------------------ races

    def create_race(self, config: RaceConfig, cars: list[CarConfig]) -> int:
        """Insert a new race and return its id."""
        cars_json = json.dumps([c.model_dump(mode="json") for c in cars])
        with self._lock, self._conn:
            cursor = self._conn.execute(
                "INSERT INTO races (started_at, mode, config_json, cars_json) VALUES (?, ?, ?, ?)",
                (utcnow().isoformat(), config.mode.value, config.model_dump_json(), cars_json),
            )
            race_id = cursor.lastrowid
        if race_id is None:  # pragma: no cover - sqlite always sets lastrowid on INSERT
            raise RuntimeError("SQLite did not return a race id")
        return race_id

    def add_lap(self, race_id: int, lap: Lap) -> None:
        """Append a completed lap to a race. Raises sqlite3.IntegrityError for unknown races."""
        with self._lock, self._conn:
            self._conn.execute(
                "INSERT INTO laps (race_id, address, lap_number, lap_ms, race_time_ms, valid) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (
                    race_id,
                    lap.address,
                    lap.lap_number,
                    lap.lap_ms,
                    lap.race_time_ms,
                    int(lap.valid),
                ),
            )

    def finish_race(self, race_id: int, state: RaceState) -> None:
        """Mark a race finished and store the final standings (cars by position)."""
        results = sorted(state.cars, key=lambda c: (c.position is None, c.position or 0))
        winner = next((c for c in results if c.position == 1), None)
        results_json = json.dumps([c.model_dump(mode="json") for c in results])
        with self._lock, self._conn:
            cursor = self._conn.execute(
                "UPDATE races SET finished_at = ?, winner_name = ?, results_json = ? WHERE id = ?",
                (
                    utcnow().isoformat(),
                    winner.name if winner is not None else None,
                    results_json,
                    race_id,
                ),
            )
            if cursor.rowcount == 0:
                raise KeyError(f"Unknown race id {race_id}")

    def list_races(self) -> list[dict[str, Any]]:
        """RaceSummary dicts, newest first."""
        with self._lock:
            rows = self._conn.execute(_SUMMARY_SQL + " ORDER BY r.id DESC").fetchall()
        return [_summary_from_row(row) for row in rows]

    def get_race(self, race_id: int) -> dict[str, Any] | None:
        """RaceDetail dict (summary + config, results, laps chronological), or None."""
        with self._lock:
            row = self._conn.execute(_SUMMARY_SQL + " WHERE r.id = ?", (race_id,)).fetchone()
            if row is None:
                return None
            config_row = self._conn.execute(
                "SELECT config_json, results_json FROM races WHERE id = ?", (race_id,)
            ).fetchone()
            lap_rows = self._conn.execute(
                "SELECT address, lap_number, lap_ms, race_time_ms, valid FROM laps "
                "WHERE race_id = ? ORDER BY id",
                (race_id,),
            ).fetchall()
        results_json = config_row["results_json"]
        return {
            **_summary_from_row(row),
            "config": json.loads(config_row["config_json"]),
            "results": json.loads(results_json) if results_json is not None else [],
            "laps": [
                {
                    "address": lap["address"],
                    "lap_number": lap["lap_number"],
                    "lap_ms": lap["lap_ms"],
                    "race_time_ms": lap["race_time_ms"],
                    "valid": bool(lap["valid"]),
                }
                for lap in lap_rows
            ],
        }

    # ------------------------------------------------------------------ settings

    def load_settings(self) -> Settings:
        """Persisted settings, or defaults when nothing was saved yet."""
        with self._lock:
            row = self._conn.execute(
                "SELECT value_json FROM settings WHERE key = 'settings'"
            ).fetchone()
        if row is None:
            return Settings()
        return Settings.model_validate_json(row["value_json"])

    def save_settings(self, settings: Settings) -> None:
        with self._lock, self._conn:
            self._conn.execute(
                "INSERT OR REPLACE INTO settings (key, value_json) VALUES ('settings', ?)",
                (settings.model_dump_json(),),
            )

    # ------------------------------------------------------------------ track records

    def get_record(self, layout: str) -> TrackRecordInfo | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM track_records WHERE layout = ?", (layout,)
            ).fetchone()
        return _record_from_row(row) if row is not None else None

    def list_records(self) -> list[TrackRecordInfo]:
        """All records, sorted by layout name."""
        with self._lock:
            rows = self._conn.execute("SELECT * FROM track_records ORDER BY layout").fetchall()
        return [_record_from_row(row) for row in rows]

    def set_record(self, info: TrackRecordInfo) -> None:
        """Insert or replace the record of ``info.layout``."""
        with self._lock, self._conn:
            self._conn.execute(
                "INSERT OR REPLACE INTO track_records "
                "(layout, lap_ms, address, holder_name, race_id, set_at) VALUES (?, ?, ?, ?, ?, ?)",
                (
                    info.layout,
                    info.lap_ms,
                    info.address,
                    info.holder_name,
                    info.race_id,
                    info.set_at.isoformat(),
                ),
            )

    def delete_record(self, layout: str) -> bool:
        """Remove a layout's record; False when there was none."""
        with self._lock, self._conn:
            cursor = self._conn.execute("DELETE FROM track_records WHERE layout = ?", (layout,))
        return cursor.rowcount > 0

    # ------------------------------------------------------------------ counters

    def get_counter(self, key: str) -> int:
        with self._lock:
            row = self._conn.execute("SELECT value FROM counters WHERE key = ?", (key,)).fetchone()
        return int(row["value"]) if row is not None else 0

    def add_to_counter(self, key: str, amount: int) -> int:
        """Add ``amount`` to the counter (created at 0 if missing); return the new value."""
        with self._lock, self._conn:
            self._conn.execute(
                "INSERT INTO counters (key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = value + excluded.value",
                (key, amount),
            )
            row = self._conn.execute("SELECT value FROM counters WHERE key = ?", (key,)).fetchone()
        return int(row["value"])


def _summary_from_row(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "started_at": row["started_at"],
        "finished_at": row["finished_at"],
        "mode": row["mode"],
        "winner_name": row["winner_name"],
        "laps": row["laps"],
        "best_lap_ms": row["best_lap_ms"],
    }


def _record_from_row(row: sqlite3.Row) -> TrackRecordInfo:
    return TrackRecordInfo(
        layout=row["layout"],
        lap_ms=row["lap_ms"],
        address=row["address"],
        holder_name=row["holder_name"],
        race_id=row["race_id"],
        set_at=datetime.fromisoformat(row["set_at"]),
    )
