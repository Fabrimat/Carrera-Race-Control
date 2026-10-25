"""Race exports: CSV (one row per lap) and JSON (the RaceDetail dict)."""

from __future__ import annotations

import csv
import io
import json
from typing import Any

from app.race.models import CarConfig, default_cars

CSV_COLUMNS = [
    "race_id",
    "address",
    "car_name",
    "lap_number",
    "lap_ms",
    "lap_s",
    "race_time_ms",
    "valid",
]


_FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r")


def safe_cell(value: str) -> str:
    """Neutralise spreadsheet formula injection (user-editable text like car names)."""
    return "'" + value if value.startswith(_FORMULA_PREFIXES) else value


def car_names(detail: dict[str, Any], cars: list[CarConfig] | None = None) -> dict[int, str]:
    """Address -> name: final results first, then the given car configs, then defaults."""
    names = {c.address: c.name for c in default_cars()}
    for car in cars or []:
        names[car.address] = car.name
    for result in detail.get("results") or []:
        names[int(result["address"])] = str(result["name"])
    return names


def race_to_csv(detail: dict[str, Any], cars: list[CarConfig] | None = None) -> str:
    names = car_names(detail, cars)
    out = io.StringIO()
    writer = csv.writer(out, lineterminator="\n")
    writer.writerow(CSV_COLUMNS)
    for lap in detail.get("laps") or []:
        address = int(lap["address"])
        writer.writerow(
            [
                detail["id"],
                address,
                safe_cell(names.get(address, f"Car {address + 1}")),
                lap["lap_number"],
                lap["lap_ms"],
                f"{lap['lap_ms'] / 1000:.3f}",
                lap["race_time_ms"],
                "true" if lap["valid"] else "false",
            ]
        )
    return out.getvalue()


def race_to_json(detail: dict[str, Any]) -> str:
    return json.dumps(detail, indent=2, ensure_ascii=False)
