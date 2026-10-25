"""Configuration export / import (no network, no BLE)."""

from __future__ import annotations

import json
from collections.abc import Callable, Iterator
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.commentary.llm import TemplateWriter
from app.config import AppConfig
from app.main import create_app
from app.race.models import EventProgram, TrackRecordInfo
from app.race.store import RaceStore
from app.service import RaceController
from tests.test_commentary_fakes import FakeTTS
from tests.test_service import make_config

PNG = bytes.fromhex("89504e470d0a1a0a") + b"\x00" * 32
ALL = ["settings", "drivers", "programs", "layouts", "records"]


@pytest.fixture
def make_client(tmp_path: Path) -> Iterator[Callable[..., TestClient]]:
    clients: list[TestClient] = []

    def make(config: AppConfig | None = None) -> TestClient:
        def build(cfg: AppConfig, store: RaceStore) -> RaceController:
            return RaceController(cfg, store, tts=FakeTTS(available=False), writer=TemplateWriter())

        app = create_app(
            config or make_config(tmp_path),
            controller_factory=build,
            autoconnect=False,
            frontend_dist=None,
        )
        client = TestClient(app)
        client.__enter__()
        clients.append(client)
        return client

    yield make
    for client in clients:
        client.__exit__(None, None, None)


def ctl_of(client: TestClient) -> RaceController:
    return client.app.state.controller  # type: ignore[no-any-return]


def layout_body(name: str = "oval") -> dict[str, Any]:
    points = [[0.1, 0.1], [0.5, 0.05], [0.9, 0.1], [0.95, 0.5], [0.9, 0.9], [0.5, 0.95]]
    points += [[0.1, 0.9], [0.05, 0.5]]
    return {"name": name, "points": points, "aspect": 1.5}


def program_body(pid: str = "evening") -> dict[str, Any]:
    return {
        "id": pid,
        "name": "Evening",
        "sessions": [
            {"id": "q", "kind": "qualifying", "mode": "timed", "duration_s": 60},
            {"id": "r", "kind": "race", "grid_from": "q"},
        ],
    }


def seed(client: TestClient) -> None:
    """One of everything, written through the store like the endpoints do."""
    ctl = ctl_of(client)
    ctl.create_driver("Anna", "Fulmine", "Likes red")
    ctl.create_driver("Bruno", None, "")
    ctl.store.save_program(EventProgram(**program_body()))
    assert client.put("/api/layouts/oval", json=layout_body()).status_code == 200
    ctl.store.set_record(
        TrackRecordInfo(
            layout="oval",
            lap_ms=5000,
            address=1,
            holder_name="Anna",
            race_id=None,
            set_at=datetime(2026, 1, 1, tzinfo=UTC),
        )
    )
    settings = ctl.settings.model_copy(deep=True)
    settings.cars[0].name = "Rosso"
    assert client.put("/api/settings", json=settings.model_dump(mode="json")).status_code == 200


def export(client: TestClient, sections: list[str] | None = None) -> dict[str, Any]:
    r = client.post("/api/export", json={"sections": sections or ALL})
    assert r.status_code == 200, r.text
    return r.json()


def do_import(
    client: TestClient, bundle: dict[str, Any], mode: str = "merge", dry_run: bool = False
) -> Any:
    return client.post("/api/import", json={"bundle": bundle, "mode": mode, "dry_run": dry_run})


def snapshot(client: TestClient) -> dict[str, Any]:
    """Everything the bundle covers, minus fields the server restamps."""
    data = export(client)
    data.pop("exported_at")
    for key in ("programs", "layouts"):
        for item in data.get(key, []):
            item.pop("updated_at")
    return data


# --------------------------------------------------------------------------- export


def test_export_sections_filename_and_no_secrets(make_client, tmp_path: Path) -> None:
    cfg = make_config(tmp_path, anthropic_api_key="sk-ant-secret", elevenlabs_api_key="el-secret")
    client = make_client(cfg)
    seed(client)
    r = client.post("/api/export", json={"sections": ["drivers", "records"]})
    assert r.status_code == 200
    disposition = r.headers["content-disposition"]
    assert disposition.startswith('attachment; filename="carrera-rms-')
    assert disposition.endswith('.json"')
    body = r.json()
    assert body["format"] == "carrera-rms" and body["version"] == 1
    assert body["app_version"]
    assert set(body) - {"format", "version", "exported_at", "app_version"} == {"drivers", "records"}
    assert all(d["has_photo"] is False for d in body["drivers"])

    full = client.post("/api/export", json={"sections": ALL}).text
    assert "sk-ant-secret" not in full and "el-secret" not in full
    assert "api_key" not in full.lower()


def test_export_never_includes_photos(make_client) -> None:
    client = make_client()
    seed(client)
    import base64

    r = client.put(
        "/api/drivers/anna/photo",
        json={"image_base64": base64.b64encode(PNG).decode(), "media_type": "image/png"},
    )
    assert r.status_code == 200
    anna = next(d for d in export(client, ["drivers"])["drivers"] if d["id"] == "anna")
    assert anna["has_photo"] is False
    assert "image" not in json.dumps(anna)


def test_export_rejects_unknown_sections(make_client) -> None:
    client = make_client()
    for sections in (["nope"], []):
        r = client.post("/api/export", json={"sections": sections})
        assert r.status_code == 422 and r.json()["code"] == "invalid_request"


# --------------------------------------------------------------------------- round trip


def test_round_trip_replace_into_a_fresh_install(make_client, tmp_path: Path) -> None:
    source = make_client(make_config(tmp_path / "a"))
    seed(source)
    bundle = export(source)
    before = snapshot(source)

    target = make_client(make_config(tmp_path / "b"))
    r = do_import(target, bundle, "replace")
    assert r.status_code == 200, r.text
    assert r.json()["applied"] is True
    assert snapshot(target) == before
    assert ctl_of(target).settings.cars[0].name == "Rosso"
    assert [d.id for d in ctl_of(target).list_drivers()] == ["anna", "bruno"]


def test_merge_and_replace_counts(make_client) -> None:
    client = make_client()
    seed(client)
    bundle = export(client)
    # Add things on the server that the bundle does not have.
    ctl_of(client).create_driver("Carla", None, "")
    client.put("/api/layouts/extra", json=layout_body("extra"))
    ctl_of(client).store.set_record(
        TrackRecordInfo(
            layout="extra",
            lap_ms=1,
            address=0,
            holder_name="X",
            race_id=None,
            set_at=datetime.now(UTC),
        )
    )
    merged = do_import(client, bundle, "merge").json()["report"]
    assert merged["drivers"] == {"added": 0, "updated": 2, "removed": 0}
    assert merged["programs"] == {"added": 0, "updated": 1, "removed": 0}
    assert merged["layouts"] == {"added": 0, "updated": 1, "removed": 0}
    assert merged["records"] == {"added": 0, "updated": 0, "removed": 0}
    assert merged["settings"] == {"added": 0, "updated": 0, "removed": 0}
    assert len(ctl_of(client).list_drivers()) == 3

    replaced = do_import(client, bundle, "replace").json()["report"]
    assert replaced["drivers"] == {"added": 0, "updated": 2, "removed": 1}
    assert replaced["layouts"] == {"added": 0, "updated": 1, "removed": 1}
    assert replaced["records"] == {"added": 0, "updated": 1, "removed": 1}
    assert [d.id for d in ctl_of(client).list_drivers()] == ["anna", "bruno"]
    assert [x.name for x in ctl_of(client).list_layouts()] == ["oval"]
    assert [r.layout for r in ctl_of(client).store.list_records()] == ["oval"]


def test_dry_run_changes_nothing_and_matches_the_real_report(make_client, tmp_path: Path) -> None:
    source = make_client(make_config(tmp_path / "a"))
    seed(source)
    bundle = export(source)

    target = make_client(make_config(tmp_path / "b"))
    ctl_of(target).create_driver("Old", None, "")
    before = snapshot(target)
    dry = do_import(target, bundle, "replace", dry_run=True)
    assert dry.status_code == 200 and dry.json()["applied"] is False
    assert snapshot(target) == before
    assert [d.id for d in ctl_of(target).list_drivers()] == ["old"]

    real = do_import(target, bundle, "replace")
    assert real.json()["report"] == dry.json()["report"]
    assert real.json()["report"]["drivers"] == {"added": 2, "updated": 0, "removed": 1}


# --------------------------------------------------------------------------- rejections


def test_version_too_new_is_unsupported_even_with_unknown_fields(make_client) -> None:
    client = make_client()
    r = do_import(client, {"format": "carrera-rms", "version": 2, "future_field": [1]})
    assert r.status_code == 422 and r.json()["code"] == "import_unsupported"


def test_invalid_content_is_reported(make_client) -> None:
    client = make_client()
    seed(client)
    before = snapshot(client)
    cases: list[dict[str, Any]] = [
        {"format": "other", "version": 1},
        {"format": "carrera-rms", "version": 1, "surprise": 1},
        {"format": "carrera-rms", "version": 1, "drivers": [{"id": "Bad Id", "name": "X"}]},
        {
            "format": "carrera-rms",
            "version": 1,
            "drivers": [{"id": "a", "name": "A"}, {"id": "a", "name": "B"}],
        },
        {"format": "carrera-rms", "version": 1, "programs": [{**program_body("Bad_Id")}]},
        {
            "format": "carrera-rms",
            "version": 1,
            "programs": [{"id": "empty", "name": "E", "sessions": []}],
        },
    ]
    for bundle in cases:
        r = do_import(client, bundle, "replace")
        assert r.status_code == 422, bundle
        assert r.json()["code"] == "import_invalid" and r.json()["detail"], bundle
    assert snapshot(client) == before


def test_settings_validation_failure_rolls_back_everything(make_client) -> None:
    client = make_client()
    seed(client)
    bundle = export(client)
    before = snapshot(client)
    bad = json.loads(json.dumps(bundle))
    bad["drivers"].append({"id": "zed", "name": "Zed"})
    bad["settings"]["cars"][1]["color"] = "red"  # same check as PUT /api/settings
    r = do_import(client, bad, "replace")
    assert r.status_code == 422 and r.json()["code"] == "import_invalid"
    assert "color" in r.json()["detail"]
    assert snapshot(client) == before


def test_layout_validation_failure_rolls_back_everything(make_client) -> None:
    client = make_client()
    seed(client)
    before = snapshot(client)
    bundle = export(client)
    bundle["drivers"].append({"id": "zed", "name": "Zed"})
    bundle["layouts"][0]["points"][0] = [3.0, 3.0]  # outside the 0..1 square
    r = do_import(client, bundle, "replace")
    assert r.status_code == 422 and r.json()["code"] == "import_invalid"
    assert snapshot(client) == before


def test_failure_mid_transaction_rolls_back(make_client, monkeypatch) -> None:
    client = make_client()
    seed(client)
    before = snapshot(client)
    bundle = export(client)
    bundle["drivers"].append({"id": "zed", "name": "Zed"})

    def boom(*_: Any, **__: Any) -> None:
        raise RuntimeError("disk on fire")

    monkeypatch.setattr(RaceStore, "set_record", boom)
    with pytest.raises(RuntimeError):
        do_import(client, bundle, "replace")
    monkeypatch.undo()
    assert snapshot(client) == before


# --------------------------------------------------------------------------- semantics


def test_records_merge_keeps_the_faster_lap(make_client) -> None:
    client = make_client()
    seed(client)  # oval: 5000 ms by Anna

    def record(layout: str, lap_ms: int, holder: str) -> dict[str, Any]:
        return {
            "layout": layout,
            "lap_ms": lap_ms,
            "address": 0,
            "holder_name": holder,
            "race_id": None,
            "set_at": "2026-02-02T00:00:00Z",
        }

    slower = {"format": "carrera-rms", "version": 1, "records": [record("oval", 6000, "Slow")]}
    r = do_import(client, slower, "merge")
    assert r.json()["report"]["records"] == {"added": 0, "updated": 0, "removed": 0}
    assert ctl_of(client).store.get_record("oval").holder_name == "Anna"

    faster = {
        "format": "carrera-rms",
        "version": 1,
        "records": [record("oval", 4000, "Fast"), record("new", 9000, "New")],
    }
    r = do_import(client, faster, "merge")
    assert r.json()["report"]["records"] == {"added": 1, "updated": 1, "removed": 0}
    assert ctl_of(client).store.get_record("oval").holder_name == "Fast"
    assert ctl_of(client).store.get_record("new") is not None

    # Replace takes the bundle's lap even when slower.
    r = do_import(client, slower, "replace")
    assert r.json()["report"]["records"] == {"added": 0, "updated": 1, "removed": 1}
    assert ctl_of(client).store.get_record("oval").lap_ms == 6000
    assert ctl_of(client).store.get_record("new") is None


def test_replacing_drivers_purges_assignments_and_armed_driver(make_client) -> None:
    client = make_client()
    ctl = ctl_of(client)
    ctl.create_driver("Anna", None, "")
    ctl.create_driver("Bruno", None, "")
    assert client.put("/api/event/assignments", json={"assignments": {"0": "anna", "1": "bruno"}})
    assert (
        client.post("/api/event/assign-next-crossing", json={"driver_id": "bruno"}).status_code
        == 200
    )
    bundle = {
        "format": "carrera-rms",
        "version": 1,
        "drivers": [{"id": "anna", "name": "Anna"}],
    }
    r = do_import(client, bundle, "replace")
    assert r.status_code == 200
    assert r.json()["report"]["drivers"] == {"added": 0, "updated": 1, "removed": 1}
    assert ctl.assignments() == {0: "anna"}
    assert ctl.event_state.armed_driver_id is None
    assert ctl.store.load_event_state().assignments == {0: "anna"}
    # A merge never removes anyone.
    bundle["drivers"] = [{"id": "carla", "name": "Carla"}]
    do_import(client, bundle, "merge")
    assert ctl.assignments() == {0: "anna"}


def test_imported_drivers_have_no_photo_unless_a_file_exists(make_client) -> None:
    import base64

    client = make_client()
    ctl_of(client).create_driver("Anna", None, "")
    client.put(
        "/api/drivers/anna/photo",
        json={"image_base64": base64.b64encode(PNG).decode(), "media_type": "image/png"},
    )
    bundle = {
        "format": "carrera-rms",
        "version": 1,
        "drivers": [
            {"id": "anna", "name": "Anna", "has_photo": False},
            {"id": "bruno", "name": "Bruno", "has_photo": True},
        ],
    }
    do_import(client, bundle, "merge")
    by_id = {d.id: d for d in ctl_of(client).list_drivers()}
    assert by_id["anna"].has_photo is True and by_id["bruno"].has_photo is False
    assert ctl_of(client).get_driver("bruno").has_photo is False  # cache refreshed


def test_importing_settings_applies_them_without_connecting(make_client, monkeypatch) -> None:
    client = make_client()
    ctl = ctl_of(client)

    async def no_connect(*_: Any, **__: Any) -> None:
        raise AssertionError("an import must never connect or disconnect the track")

    monkeypatch.setattr(RaceController, "connect", no_connect)
    monkeypatch.setattr(RaceController, "disconnect", no_connect)
    mode_before = ctl.connection.mode
    settings = ctl.settings.model_copy(deep=True)
    settings.track.mode = "ble"
    settings.track.address = "AA:BB:CC:DD:EE:FF"
    settings.cars[0].name = "Imported"
    bundle = {
        "format": "carrera-rms",
        "version": 1,
        "settings": settings.model_dump(mode="json"),
    }
    r = do_import(client, bundle, "merge")
    assert r.status_code == 200, r.text
    assert r.json()["report"]["settings"] == {"added": 0, "updated": 1, "removed": 0}
    assert ctl.settings.track.mode == "ble" and ctl.settings.cars[0].name == "Imported"
    assert ctl.store.load_settings().track.address == "AA:BB:CC:DD:EE:FF"
    assert ctl.connection.mode == mode_before
    assert client.get("/api/settings").json()["cars"][0]["name"] == "Imported"


def test_import_refreshes_layout_and_record_caches(make_client) -> None:
    client = make_client()
    ctl = ctl_of(client)
    bundle = {
        "format": "carrera-rms",
        "version": 1,
        "layouts": [layout_body("default")],
        "records": [
            {
                "layout": "default",
                "lap_ms": 4321,
                "address": 2,
                "holder_name": "Zoe",
                "race_id": None,
                "set_at": "2026-02-02T00:00:00Z",
            }
        ],
    }
    assert ctl.track_record is None
    assert do_import(client, bundle, "merge").status_code == 200
    assert ctl.track_record is not None and ctl.track_record.lap_ms == 4321


# --------------------------------------------------------------------------- body limit


def test_import_body_limit_is_5_mb_and_only_for_import(make_client) -> None:
    client = make_client()
    big = {"format": "carrera-rms", "version": 1, "pad": "x" * (2 * 1024 * 1024)}
    r = do_import(client, big)  # 2 MB: above the default 1 MB, below 5 MB
    assert r.status_code == 422 and r.json()["code"] == "import_invalid"

    huge = json.dumps({"bundle": {"pad": "x" * (5 * 1024 * 1024 + 10)}, "mode": "merge"})
    r = client.post("/api/import", content=huge, headers={"content-type": "application/json"})
    assert r.status_code == 413

    r = client.post(
        "/api/export",
        content=json.dumps({"sections": ["x" * (2 * 1024 * 1024)]}),
        headers={"content-type": "application/json"},
    )
    assert r.status_code == 413
