"""Configuration export / import bundles (docs/PROTOCOL.md "Event mode" -> "Export / import").

Pure store logic: :func:`build_bundle` reads, :func:`apply_bundle` writes. A dry run and a real
import run the very same code inside one store transaction, rolled back on a dry run, so the
report always matches what would happen. Validation lives in :func:`bundle_errors` and runs
before anything is written. API keys are not part of any section and photos are never exported.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any, Literal

from app.avatars import ID_RE, AvatarStore
from app.race.models import (
    EventProgram,
    ExportBundle,
    RaceMode,
    Settings,
    TrackLayout,
    TrackRecordInfo,
)
from app.race.store import RaceStore

BUNDLE_VERSION = 1
SECTIONS = ("settings", "drivers", "programs", "layouts", "records")
Mode = Literal["merge", "replace"]
Report = dict[str, dict[str, int]]


def _counts(added: int = 0, updated: int = 0, removed: int = 0) -> dict[str, int]:
    return {"added": added, "updated": updated, "removed": removed}


def build_bundle(store: RaceStore, sections: list[str], app_version: str) -> ExportBundle:
    """Read the requested sections. Unknown names must be rejected by the caller."""
    wanted = set(sections)
    bundle = ExportBundle(version=BUNDLE_VERSION, app_version=app_version)
    if "settings" in wanted:
        bundle.settings = store.load_settings()
    if "drivers" in wanted:
        bundle.drivers = [d.model_copy(update={"has_photo": False}) for d in store.list_drivers()]
    if "programs" in wanted:
        bundle.programs = store.list_programs()
    if "layouts" in wanted:
        bundle.layouts = store.list_layouts()
    if "records" in wanted:
        bundle.records = store.list_records()
    return bundle


def program_errors(program: EventProgram) -> list[str]:
    """Same rules as a program saved through its own endpoint."""
    errors: list[str] = []
    if not program.sessions:
        errors.append(f"Program {program.id!r}: at least one session is required")
    ids = [s.id for s in program.sessions]
    if len(set(ids)) != len(ids):
        errors.append(f"Program {program.id!r}: session ids must be unique")
    for index, session in enumerate(program.sessions):
        if session.grid_from is not None and session.grid_from not in ids[:index]:
            errors.append(
                f"Program {program.id!r}: session {session.id!r} grid_from must be earlier"
            )
    return errors


def _duplicates(values: list[str]) -> list[str]:
    return sorted({v for v in values if values.count(v) > 1})


def bundle_errors(
    bundle: ExportBundle,
    settings_errors: Callable[[Settings], list[str]],
    layout_errors: Callable[[TrackLayout], list[str]],
) -> list[str]:
    """Content problems of a parsed bundle, using the same validators as the endpoints."""
    errors: list[str] = []
    if bundle.settings is not None:
        errors += [f"settings: {e}" for e in settings_errors(bundle.settings)]
    if bundle.drivers is not None:
        errors += [
            f"drivers: invalid id {d.id!r} (lowercase letters, digits and dashes)"
            for d in bundle.drivers
            if not ID_RE.match(d.id)
        ]
        errors += [
            f"drivers: duplicate id {i!r}" for i in _duplicates([d.id for d in bundle.drivers])
        ]
        errors += [
            f"drivers: blank name for {d.id!r}" for d in bundle.drivers if not d.name.strip()
        ]
    if bundle.programs is not None:
        errors += [
            f"programs: invalid id {p.id!r} (lowercase letters, digits and dashes)"
            for p in bundle.programs
            if not ID_RE.match(p.id)
        ]
        errors += [
            f"programs: duplicate id {i!r}" for i in _duplicates([p.id for p in bundle.programs])
        ]
        for program in bundle.programs:
            errors += [f"programs: {e}" for e in program_errors(program)]
    if bundle.layouts is not None:
        errors += [
            f"layouts: duplicate name {n!r}" for n in _duplicates([x.name for x in bundle.layouts])
        ]
        for layout in bundle.layouts:
            errors += [f"layouts: {layout.name!r}: {e}" for e in layout_errors(layout)]
    if bundle.records is not None:
        errors += [
            f"records: duplicate layout {n!r}"
            for n in _duplicates([r.layout for r in bundle.records])
        ]
    return errors


def apply_bundle(
    store: RaceStore,
    avatars: AvatarStore,
    bundle: ExportBundle,
    mode: Mode,
    *,
    dry_run: bool,
) -> tuple[Report, set[str]]:
    """Write the bundle in one transaction; returns the report and the removed driver ids.

    Nothing is committed on a dry run or when anything raises.
    """
    report: Report = {}
    removed_drivers: set[str] = set()
    with store.transaction(commit=not dry_run):
        if bundle.settings is not None:
            changed = store.load_settings() != bundle.settings
            store.save_settings(bundle.settings)
            report["settings"] = _counts(updated=int(changed))
        if bundle.drivers is not None:
            removed_drivers = _import_drivers(store, avatars, bundle, mode, report)
        if bundle.programs is not None:
            _import_programs(store, bundle.programs, mode, report)
        if bundle.layouts is not None:
            _import_layouts(store, bundle.layouts, mode, report)
        if bundle.records is not None:
            _import_records(store, bundle.records, mode, report)
    return report, removed_drivers


def _import_drivers(
    store: RaceStore, avatars: AvatarStore, bundle: ExportBundle, mode: Mode, report: Report
) -> set[str]:
    incoming = bundle.drivers or []
    existing = {d.id for d in store.list_drivers()}
    added = updated = 0
    for driver in incoming:
        added, updated = (added, updated + 1) if driver.id in existing else (added + 1, updated)
        store.save_driver(
            driver.model_copy(update={"has_photo": avatars.get(driver.id) is not None})
        )
    removed: set[str] = set()
    if mode == "replace":
        removed = existing - {d.id for d in incoming}
        for driver_id in removed:
            store.delete_driver(driver_id)
    report["drivers"] = _counts(added, updated, len(removed))
    return removed


def _import_programs(
    store: RaceStore, incoming: list[EventProgram], mode: Mode, report: Report
) -> None:
    existing = {p.id for p in store.list_programs()}
    added = updated = 0
    for program in incoming:
        sessions = [
            s.model_copy(update={"mode": RaceMode.TIMED}) if s.kind == "qualifying" else s
            for s in program.sessions
        ]
        added, updated = (added, updated + 1) if program.id in existing else (added + 1, updated)
        store.save_program(program.model_copy(update={"sessions": sessions}))
    removed = 0
    if mode == "replace":
        for program_id in existing - {p.id for p in incoming}:
            removed += int(store.delete_program(program_id))
    report["programs"] = _counts(added, updated, removed)


def _import_layouts(
    store: RaceStore, incoming: list[TrackLayout], mode: Mode, report: Report
) -> None:
    existing = {x.name for x in store.list_layouts()}
    added = updated = 0
    for layout in incoming:
        added, updated = (added, updated + 1) if layout.name in existing else (added + 1, updated)
        store.save_layout(layout)
    removed = 0
    if mode == "replace":
        for name in existing - {x.name for x in incoming}:
            removed += int(store.delete_layout(name))
    report["layouts"] = _counts(added, updated, removed)


def _import_records(
    store: RaceStore, incoming: list[TrackRecordInfo], mode: Mode, report: Report
) -> None:
    current = {r.layout: r for r in store.list_records()}
    added = updated = 0
    for record in incoming:
        previous = current.get(record.layout)
        if previous is None:
            added += 1
        elif mode == "replace" or record.lap_ms < previous.lap_ms:
            updated += 1
        else:
            continue  # merge keeps the faster lap
        store.set_record(record)
    removed = 0
    if mode == "replace":
        for layout in set(current) - {r.layout for r in incoming}:
            removed += int(store.delete_record(layout))
    report["records"] = _counts(added, updated, removed)


def check_version(raw: Any) -> None:
    """Raise ValueError when ``raw`` (the parsed JSON) declares a version we cannot read."""
    version = raw.get("version") if isinstance(raw, dict) else None
    if isinstance(version, int) and not isinstance(version, bool) and version > BUNDLE_VERSION:
        raise ValueError(f"Bundle version {version} is newer than supported ({BUNDLE_VERSION})")
