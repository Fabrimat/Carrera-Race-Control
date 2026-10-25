"""API + WebSocket tests against the simulator at high time_scale (no network)."""

from __future__ import annotations

import base64
import csv
import io
import json
import math
import time
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.commentary.llm import TemplateWriter
from app.config import AppConfig
from app.main import create_app
from app.race.store import RaceStore
from app.service import RaceController, TrackFactory
from app.track.base import TrackConnectionError
from tests.test_commentary_fakes import FakeTTS
from tests.test_service import FakeTrack, make_config
from tests.test_vision import fake_client, make_png, reply

SECRET_EL = "el-secret-value-123"
SECRET_ANT = "ant-secret-value-456"
PNG_MAGIC = bytes.fromhex("89504e470d0a1a0a")


def factory(
    tts: FakeTTS | None = None,
    track_factory: TrackFactory | None = None,
    vision_client: Any | None = None,
) -> Callable[[AppConfig, RaceStore], RaceController]:
    def build(config: AppConfig, store: RaceStore) -> RaceController:
        return RaceController(
            config,
            store,
            tts=tts or FakeTTS(available=False),
            writer=TemplateWriter(),
            track_factory=track_factory,
            vision_client=vision_client,
            second_press_s=0.05,
        )

    return build


@pytest.fixture
def make_client(tmp_path: Path) -> Iterator[Callable[..., TestClient]]:
    clients: list[TestClient] = []

    def make(
        config: AppConfig | None = None,
        tts: FakeTTS | None = None,
        track_factory: TrackFactory | None = None,
        autoconnect: bool = False,
        frontend_dist: Path | None = None,
        vision_client: Any | None = None,
    ) -> TestClient:
        app = create_app(
            config or make_config(tmp_path),
            controller_factory=factory(tts, track_factory, vision_client),
            autoconnect=autoconnect,
            frontend_dist=frontend_dist,
        )
        client = TestClient(app)
        client.__enter__()
        clients.append(client)
        return client

    yield make
    for client in clients:
        client.__exit__(None, None, None)


def wait_state(client: TestClient, cond: Callable[[dict[str, Any]], bool], timeout=15.0):
    deadline = time.monotonic() + timeout
    while True:
        snap = client.get("/api/state").json()
        if cond(snap):
            return snap
        if time.monotonic() > deadline:
            raise AssertionError(f"state condition not met: {snap['race']['phase']}")
        time.sleep(0.05)


def total_laps(snap: dict[str, Any]) -> int:
    return sum(c["laps"] for c in snap["race"]["cars"])


# --------------------------------------------------------------------------- race flow


def test_full_race_history_and_exports(make_client) -> None:
    client = make_client()
    snap = client.get("/api/state").json()
    assert snap["connection"]["status"] == "disconnected"
    assert snap["race"]["phase"] == "idle"
    assert snap["commentary"] == [] and snap["muted"] is False

    r = client.post("/api/connect", json={"mode": "simulator", "address": None})
    assert r.status_code == 200, r.text
    assert r.json() == {
        "status": "connected",
        "mode": "simulator",
        "address": None,
        "error": None,
        "error_code": None,
    }

    r = client.post("/api/race/start", json={"mode": "laps", "target_laps": 3})
    assert r.status_code == 200, r.text
    assert r.json()["phase"] == "starting"
    race_id = r.json()["race_id"]
    assert race_id is not None

    snap = wait_state(client, lambda s: total_laps(s) > 0)
    assert snap["race"]["phase"] in ("running", "finished")
    snap = wait_state(client, lambda s: s["race"]["phase"] == "finished")
    leader = snap["race"]["cars"][0]
    assert leader["position"] == 1 and leader["laps"] >= 3 and leader["best_lap_ms"] > 0

    races = client.get("/api/races").json()["races"]
    assert len(races) == 1
    summary = races[0]
    assert summary["id"] == race_id and summary["mode"] == "laps"
    assert summary["finished_at"] is not None and summary["winner_name"] == leader["name"]

    detail = client.get(f"/api/races/{race_id}").json()
    assert len(detail["laps"]) == summary["laps"] == total_laps(snap)
    assert detail["results"][0]["address"] == leader["address"]
    assert detail["config"]["target_laps"] == 3

    r = client.get(f"/api/races/{race_id}/export?format=csv")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/csv")
    assert f"race-{race_id}.csv" in r.headers["content-disposition"]
    rows = list(csv.DictReader(io.StringIO(r.text)))
    assert len(rows) == len(detail["laps"])
    assert {row["car_name"] for row in rows} <= {c["name"] for c in snap["race"]["cars"]}
    assert int(rows[0]["lap_ms"]) == detail["laps"][0]["lap_ms"]

    r = client.get(f"/api/races/{race_id}/export?format=json")
    assert r.status_code == 200
    assert "attachment" in r.headers["content-disposition"]
    assert json.loads(r.text) == detail

    assert client.get("/api/races/999").status_code == 404
    assert client.get("/api/races/999/export?format=csv").status_code == 404
    assert client.get(f"/api/races/{race_id}/export?format=xml").status_code == 422


def test_start_without_body_stop_reset_and_pace(make_client) -> None:
    client = make_client()
    client.post("/api/connect", json={"mode": "simulator"})
    r = client.post("/api/race/start")  # no body: defaults to settings.race (practice)
    assert r.status_code == 200, r.text
    assert r.json()["config"]["mode"] == "practice"
    wait_state(client, lambda s: total_laps(s) >= 2)

    r = client.post("/api/race/pace-car")
    assert r.status_code == 200 and r.json()["phase"] == "paused"
    r = client.post("/api/race/pace-car")
    assert r.json()["phase"] == "running"

    r = client.post("/api/race/stop")
    assert r.status_code == 200 and r.json()["phase"] == "finished"
    races = client.get("/api/races").json()["races"]
    assert races[0]["finished_at"] is not None and races[0]["laps"] >= 2

    r = client.post("/api/race/reset")
    assert r.status_code == 200
    assert r.json()["phase"] == "idle" and r.json()["race_id"] is None

    r = client.post("/api/disconnect")
    assert r.json()["status"] == "disconnected"


def test_autoconnects_simulator_on_startup(make_client) -> None:
    client = make_client(autoconnect=True)
    snap = client.get("/api/state").json()
    assert snap["connection"]["status"] == "connected"
    assert snap["connection"]["mode"] == "simulator"


def test_does_not_autoconnect_ble(make_client, tmp_path: Path) -> None:
    config = make_config(tmp_path, track_mode="ble", track_address="AA:BB:CC:DD:EE:FF")
    client = make_client(config=config, autoconnect=True)
    snap = client.get("/api/state").json()
    assert snap["connection"]["status"] == "disconnected"
    assert snap["connection"]["mode"] == "ble"
    assert snap["connection"]["address"] == "AA:BB:CC:DD:EE:FF"


def test_commands_without_connection_are_409(make_client) -> None:
    client = make_client()
    r = client.post("/api/race/start")
    assert r.status_code == 409
    assert "Not connected" in r.json()["detail"]
    assert client.post("/api/race/pace-car").status_code == 409


def test_connect_failure_is_reported(make_client) -> None:
    class BusyTrack(FakeTrack):
        async def connect(self) -> None:
            raise TrackConnectionError("Control Unit busy: close the Carrera app", code="busy")

    client = make_client(track_factory=lambda mode, address: BusyTrack())
    r = client.post("/api/connect", json={"mode": "ble", "address": "AA:BB:CC:DD:EE:FF"})
    assert r.status_code == 409
    assert r.json()["detail"] == "Control Unit busy: close the Carrera app"
    conn = client.get("/api/state").json()["connection"]
    assert conn["status"] == "error" and conn["error_code"] == "busy"

    r = client.post("/api/connect", json={"mode": "ble"})
    assert r.status_code == 422
    r = client.post("/api/connect", json={"mode": "bogus"})
    assert r.status_code == 422


# --------------------------------------------------------------------------- settings


def _assert_no_secrets(text: str) -> None:
    assert SECRET_EL not in text
    assert SECRET_ANT not in text


def test_settings_roundtrip_never_leaks_keys(make_client, tmp_path: Path) -> None:
    config = make_config(tmp_path, elevenlabs_api_key=SECRET_EL, anthropic_api_key=SECRET_ANT)
    client = make_client(config=config)
    r = client.get("/api/settings")
    assert r.status_code == 200
    _assert_no_secrets(r.text)
    body = r.json()
    assert body["keys"] == {"elevenlabs": True, "anthropic": True, "openai": False}
    assert body["commentary"]["language"] == "it"

    body["cars"][0]["name"] = "Ferrari"
    body["cars"][0]["nickname"] = "il Cavallino"
    body["commentary"]["language"] = "en"
    body["ui_language"] = "it"
    r = client.put("/api/settings", json=body)  # extra "keys" field is ignored
    assert r.status_code == 200, r.text
    _assert_no_secrets(r.text)
    assert r.json()["cars"][0]["name"] == "Ferrari"
    assert r.json()["commentary"]["language"] == "en"

    again = client.get("/api/settings")
    _assert_no_secrets(again.text)
    assert again.json()["ui_language"] == "it"
    names = [c["name"] for c in client.get("/api/state").json()["race"]["cars"]]
    assert "Ferrari" in names
    _assert_no_secrets(client.get("/api/state").text)

    bad = dict(body, commentary=dict(body["commentary"], language="fr"))
    assert client.put("/api/settings", json=bad).status_code == 422


def test_keys_from_environment_are_not_leaked(
    make_client, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("ELEVENLABS_API_KEY", SECRET_EL)
    monkeypatch.setenv("ANTHROPIC_API_KEY", SECRET_ANT)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.setenv("DATA_DIR", str(tmp_path / "envdata"))
    monkeypatch.setenv("ALLOWED_HOSTS", "testserver")
    config = AppConfig(_env_file=None)
    assert config.has_elevenlabs_key() and config.has_anthropic_key()
    assert SECRET_EL not in repr(config)
    client = make_client(config=config)
    r = client.get("/api/settings")
    _assert_no_secrets(r.text)
    assert r.json()["keys"] == {"elevenlabs": True, "anthropic": True, "openai": False}


def test_missing_keys_reported_false(make_client) -> None:
    client = make_client()
    assert client.get("/api/settings").json()["keys"] == {
        "elevenlabs": False,
        "anthropic": False,
        "openai": False,
    }


# --------------------------------------------------------------------------- commentary


def test_mute_and_audio_stream(make_client) -> None:
    tts = FakeTTS(chunks=[b"ID3", b"abc", b"def"])
    client = make_client(tts=tts)
    r = client.post("/api/commentary/mute", json={"muted": True})
    assert r.json() == {"muted": True}
    assert client.get("/api/state").json()["muted"] is True

    client.post("/api/connect", json={"mode": "simulator"})
    client.post("/api/race/start")
    snap = wait_state(client, lambda s: any(c["audio_url"] for c in s["commentary"]))
    line = next(c for c in snap["commentary"] if c["audio_url"])
    assert line["audio_url"] == f"/api/commentary/{line['id']}/audio"
    r = client.get(line["audio_url"])
    assert r.status_code == 200
    assert r.headers["content-type"] == "audio/mpeg"
    assert r.content == b"ID3abcdef"
    assert client.get("/api/commentary/nope/audio").status_code == 404


def test_scan_endpoint(make_client, monkeypatch: pytest.MonkeyPatch) -> None:
    from app.track import scan

    async def fake_scan(*_args: Any, **_kwargs: Any) -> list[scan.DeviceInfo]:
        return [
            scan.DeviceInfo(address="AA:BB:CC:DD:EE:FF", name="Control_Unit", kind="ble"),
            scan.DeviceInfo(address="COM3", name="USB Serial", kind="serial"),
        ]

    monkeypatch.setattr(scan, "scan_devices", fake_scan)
    client = make_client()
    r = client.get("/api/track/scan")
    assert r.status_code == 200
    assert r.json() == {
        "devices": [
            {"address": "AA:BB:CC:DD:EE:FF", "name": "Control_Unit", "kind": "ble"},
            {"address": "COM3", "name": "USB Serial", "kind": "serial"},
        ]
    }


# --------------------------------------------------------------------------- websocket


def test_websocket_snapshot_then_live_messages(make_client) -> None:
    client = make_client()
    client.post("/api/connect", json={"mode": "simulator"})
    with client.websocket_connect("/ws") as ws:
        first = ws.receive_json()
        assert first["type"] == "snapshot"
        assert set(first["data"]) == {"connection", "race", "commentary", "muted"}
        assert first["data"]["connection"]["status"] == "connected"

        client.post("/api/race/start", json={"mode": "practice"})
        seen: dict[str, int] = {}
        state_times: list[float] = []
        started = time.monotonic()
        while time.monotonic() - started < 2.0:
            msg = ws.receive_json()
            seen[msg["type"]] = seen.get(msg["type"], 0) + 1
            if msg["type"] == "state":
                state_times.append(time.monotonic())
                assert "cars" in msg["data"] and "phase" in msg["data"]
            if msg["type"] == "event":
                assert "type" in msg["data"] and "race_time_ms" in msg["data"]
        elapsed = time.monotonic() - started

        assert seen.get("state", 0) >= 5
        assert seen.get("event", 0) >= 1
        # Throttle: at most 10 state messages per second (+1 for window edges).
        assert seen["state"] <= 10 * elapsed + 1

        client.post("/api/commentary/mute", json={"muted": True})
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            msg = ws.receive_json()
            if msg["type"] == "muted":
                assert msg["data"] == {"muted": True}
                break
        else:
            raise AssertionError("no muted message")


def test_websocket_connection_messages(make_client) -> None:
    client = make_client()
    with client.websocket_connect("/ws") as ws:
        assert ws.receive_json()["type"] == "snapshot"
        client.post("/api/connect", json={"mode": "simulator"})
        statuses = []
        while "connected" not in statuses:
            msg = ws.receive_json()
            if msg["type"] == "connection":
                statuses.append(msg["data"]["status"])
        assert statuses == ["connecting", "connected"]


# --------------------------------------------------------------------------- static frontend


def test_serves_built_frontend_when_present(make_client, tmp_path: Path) -> None:
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("<html>carrera</html>", encoding="utf-8")
    client = make_client(frontend_dist=dist)
    r = client.get("/")
    assert r.status_code == 200 and "carrera" in r.text
    assert client.get("/api/state").status_code == 200


# --------------------------------------------------------------------------- validation / export


@pytest.mark.parametrize(
    ("mutate", "message"),
    [
        (
            lambda b: b["cars"].extend(dict(b["cars"][0], address=min(6 + i, 7)) for i in range(3)),
            "At most",
        ),
        (lambda b: b["cars"][1].update(address=0), "Duplicate"),
        (lambda b: b["cars"][0].update(name="x" * 41), "longer than 40"),
        (lambda b: b["cars"][0].update(color="red"), "#RRGGBB"),
        (lambda b: b["cars"][0].update(color="#12345G"), "#RRGGBB"),
        (lambda b: b["cars"][0].update(color="#1234567"), "#RRGGBB"),
    ],
)
def test_put_settings_rejects_invalid_cars(make_client, mutate, message: str) -> None:
    client = make_client()
    body = client.get("/api/settings").json()
    before = json.dumps(body["cars"])
    mutate(body)
    r = client.put("/api/settings", json=body)
    assert r.status_code == 422
    assert message in r.json()["detail"]
    assert json.dumps(client.get("/api/settings").json()["cars"]) == before  # unchanged


def test_put_settings_accepts_limits(make_client) -> None:
    client = make_client()
    body = client.get("/api/settings").json()
    body["cars"] += [dict(body["cars"][0], address=a) for a in (6, 7)]  # 8 cars
    body["cars"][0].update(name="x" * 40, color="#aBcDeF")
    r = client.put("/api/settings", json=body)
    assert r.status_code == 200, r.text
    assert len(r.json()["cars"]) == 8


def test_csv_export_neutralises_formulas() -> None:
    from app.race.export import race_to_csv, safe_cell

    detail = {
        "id": 7,
        "results": [
            {"address": 0, "name": '=HYPERLINK("http://x")'},
            {"address": 1, "name": "+1"},
            {"address": 2, "name": "-2"},
            {"address": 3, "name": "@SUM(A1)"},
            {"address": 4, "name": "\tTab"},
            {"address": 5, "name": "\rCR"},
        ],
        "laps": [
            {"address": a, "lap_number": 1, "lap_ms": 6000, "race_time_ms": 7000, "valid": True}
            for a in range(6)
        ]
        + [{"address": 6, "lap_number": 1, "lap_ms": 6000, "race_time_ms": 7000, "valid": False}],
    }
    rows = list(csv.DictReader(io.StringIO(race_to_csv(detail))))
    names = [row["car_name"] for row in rows]
    assert names[:6] == [
        '\'=HYPERLINK("http://x")',
        "'+1",
        "'-2",
        "'@SUM(A1)",
        "'\tTab",
        "'\rCR",
    ]
    assert names[6] == "Car 7"
    assert safe_cell("Ferrari") == "Ferrari"


# --------------------------------------------------------------------------- error codes


def test_rest_errors_have_stable_codes(make_client) -> None:
    client = make_client()
    r = client.post("/api/race/start")
    assert r.status_code == 409
    assert r.json() == {"detail": "Not connected to a track", "code": "not_connected"}
    assert client.post("/api/race/pace-car").json()["code"] == "not_connected"

    r = client.post("/api/connect", json={"mode": "serial", "address": ""})
    assert r.status_code == 422 and r.json()["code"] == "address_required"
    assert isinstance(r.json()["detail"], str)

    r = client.post("/api/connect", json={"mode": "bogus"})
    assert r.status_code == 422 and r.json()["code"] == "invalid_request"

    r = client.get("/api/races/42")
    assert r.status_code == 404 and r.json()["code"] == "race_not_found"
    assert client.get("/api/races/42/export").json()["code"] == "race_not_found"
    assert client.get("/api/commentary/x/audio").json()["code"] == "audio_not_found"

    body = client.get("/api/settings").json()
    body["cars"][0]["color"] = "blue"
    r = client.put("/api/settings", json=body)
    assert r.status_code == 422 and r.json()["code"] == "settings_invalid"


def test_track_error_code_is_passed_through(make_client) -> None:
    class BusyTrack(FakeTrack):
        async def connect(self) -> None:
            raise TrackConnectionError("Control Unit busy", code="busy")

    client = make_client(track_factory=lambda mode, address: BusyTrack())
    r = client.post("/api/connect", json={"mode": "ble", "address": "AA:BB:CC:DD:EE:FF"})
    assert r.status_code == 409
    assert r.json() == {"detail": "Control Unit busy", "code": "busy"}


# --------------------------------------------------------------------------- security


@pytest.mark.parametrize(
    "headers",
    [
        {"Origin": "http://evil.example"},
        {"Origin": "null"},
        {"Origin": "http://127.0.0.1:5173", "Sec-Fetch-Site": "cross-site"},
        {"Sec-Fetch-Site": "cross-site"},
    ],
)
def test_cross_origin_unsafe_requests_are_refused(make_client, headers) -> None:
    client = make_client()
    r = client.post("/api/commentary/mute", json={"muted": True}, headers=headers)
    assert r.status_code == 403
    assert r.json()["code"] == "forbidden_origin"
    r = client.put("/api/settings", json={}, headers=headers)
    assert r.status_code == 403
    assert client.get("/api/state").json()["muted"] is False


@pytest.mark.parametrize(
    "headers",
    [
        {},  # curl / scripts
        {"Origin": "http://testserver"},  # same origin (served frontend)
        {"Origin": "http://127.0.0.1:5173", "Sec-Fetch-Site": "same-origin"},  # Vite proxy
        {"Origin": "http://localhost:5173"},
    ],
)
def test_same_origin_and_originless_requests_pass(make_client, headers) -> None:
    client = make_client()
    r = client.post("/api/commentary/mute", json={"muted": True}, headers=headers)
    assert r.status_code == 200, r.text
    # Reads are never blocked (CORS keeps other sites from reading them).
    assert client.get("/api/state", headers={"Origin": "http://evil.example"}).status_code == 200


def test_cross_origin_websocket_is_rejected(make_client) -> None:
    from starlette.websockets import WebSocketDisconnect

    client = make_client()
    with pytest.raises(WebSocketDisconnect) as err:
        with client.websocket_connect("/ws", headers={"Origin": "http://evil.example"}) as ws:
            ws.receive_json()
    assert err.value.code == 1008
    for origin in ("http://127.0.0.1:5173", "http://testserver"):
        with client.websocket_connect("/ws", headers={"Origin": origin}) as ws:
            assert ws.receive_json()["type"] == "snapshot"


def test_unknown_host_is_rejected(make_client) -> None:
    client = make_client()
    r = client.get("/api/state", headers={"Host": "attacker.example"})
    assert r.status_code == 400
    assert client.get("/api/state", headers={"Host": "127.0.0.1:8000"}).status_code == 200
    assert client.get("/api/state", headers={"Host": "localhost:8000"}).status_code == 200


def test_records_endpoints(make_client) -> None:
    from app.race.models import TrackRecordInfo

    client = make_client()
    ctl = client.app.state.controller
    assert client.get("/api/records").json() == {"records": []}

    ctl.store.set_record(TrackRecordInfo(layout="b", lap_ms=5000, address=1, holder_name="Blu"))
    ctl.store.set_record(TrackRecordInfo(layout="default", lap_ms=4000, address=0, holder_name="R"))
    ctl.track_record = ctl.store.get_record("default")
    records = client.get("/api/records").json()["records"]
    assert [r["layout"] for r in records] == ["b", "default"]
    assert records[0]["lap_ms"] == 5000 and records[0]["holder_name"] == "Blu"
    assert client.get("/api/state").json()["race"]["track_record"]["lap_ms"] == 4000

    r = client.delete("/api/records/nope")
    assert r.status_code == 404 and r.json()["code"] == "record_not_found"

    r = client.delete("/api/records/default")
    assert r.status_code == 200
    assert [x["layout"] for x in r.json()["records"]] == ["b"]
    assert client.get("/api/state").json()["race"]["track_record"] is None
    assert client.delete("/api/records/default").status_code == 404


def test_record_layout_is_only_a_lookup_key(make_client) -> None:
    client = make_client()
    r = client.delete("/api/records/x%27%3B%20DROP%20TABLE%20track_records%3B--")
    assert r.status_code == 404 and r.json()["code"] == "record_not_found"
    assert client.get("/api/records").status_code == 200


# --------------------------------------------------------------------------- track layouts


def layout_body(name: str = "main", **overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "name": name,
        "points": [
            [0.5 + 0.4 * math.cos(2 * math.pi * i / 12), 0.5 + 0.3 * math.sin(2 * math.pi * i / 12)]
            for i in range(12)
        ],
        "aspect": 1.5,
        "sensors": [{"sensor": 3, "s": 0.7}, {"sensor": 2, "s": 0.3}],
        "pit_s": 0.9,
        "source": "drawn",
    }
    body.update(overrides)
    return body


def test_layout_crud_roundtrip(make_client) -> None:
    client = make_client()
    assert client.get("/api/layouts").json() == {"layouts": []}
    missing = client.get("/api/layouts/main")
    assert (missing.status_code, missing.json()["code"]) == (404, "layout_not_found")

    saved = client.put("/api/layouts/main", json=layout_body())
    assert saved.status_code == 200
    assert saved.json()["name"] == "main"
    assert client.get("/api/layouts/main").json()["sensors"][0]["sensor"] == 3
    client.put("/api/layouts/alpha", json=layout_body("alpha"))
    assert [item["name"] for item in client.get("/api/layouts").json()["layouts"]] == [
        "alpha",
        "main",
    ]

    gone = client.delete("/api/layouts/main")
    assert [item["name"] for item in gone.json()["layouts"]] == ["alpha"]
    again = client.delete("/api/layouts/main")
    assert (again.status_code, again.json()["code"]) == (404, "layout_not_found")


def test_current_layout_shows_up_in_the_race_state(make_client) -> None:
    client = make_client()
    client.put("/api/layouts/default", json=layout_body("default"))
    assert client.get("/api/state").json()["race"]["layout"] == "default"


@pytest.mark.parametrize(
    "mutate",
    [
        lambda b: b.update(name="other"),  # name must match the URL
        lambda b: b.update(points=[[0.1, 0.1]] * 12),  # degenerate and duplicate
        lambda b: b.update(points=[[0.5 + 0.01 * i, 0.5] for i in range(12)]),  # too short
        lambda b: b.update(points=[[1.5, 0.5]] + b["points"][1:]),  # outside the square
        lambda b: b.update(sensors=[{"sensor": 2, "s": 0.3}, {"sensor": 2, "s": 0.6}]),
        lambda b: b.update(sensors=[{"sensor": 2, "s": 0.3}, {"sensor": 3, "s": 0.305}]),
        lambda b: b.update(sensors=[{"sensor": 2, "s": 0.005}]),  # on the line
        lambda b: b.update(sensors=[{"sensor": 2, "s": 0.995}]),  # on the line (wrapped)
    ],
)
def test_layout_put_rejects_bad_geometry(make_client, mutate) -> None:
    client = make_client()
    body = layout_body()
    mutate(body)
    response = client.put("/api/layouts/main", json=body)
    assert (response.status_code, response.json()["code"]) == (422, "layout_invalid")
    assert client.get("/api/layouts").json() == {"layouts": []}


def test_layout_put_schema_errors_are_invalid_request(make_client) -> None:
    response = make_client().put("/api/layouts/main", json=layout_body(points=[[0, 0]]))
    assert (response.status_code, response.json()["code"]) == (422, "invalid_request")


def photo_request(data: bytes | None = None, **overrides: Any) -> dict[str, Any]:
    body = {
        "image_base64": base64.b64encode(data or make_png()).decode(),
        "media_type": "image/png",
        "name": "Oval",
        "language": "en",
    }
    body.update(overrides)
    return body


def test_from_photo_returns_an_unsaved_draft(make_client) -> None:
    client = make_client(vision_client=fake_client(reply(notes="direction guessed")))
    response = client.post("/api/layouts/from-photo", json=photo_request())
    assert response.status_code == 200
    draft = response.json()
    assert draft["notes"] == "direction guessed"
    assert draft["layout"]["source"] == "photo"
    assert draft["layout"]["aspect"] == pytest.approx(1.5)
    assert len(draft["layout"]["points"]) == 200
    assert client.get("/api/layouts").json() == {"layouts": []}  # not persisted


def test_from_photo_without_key_is_503(make_client) -> None:
    response = make_client().post("/api/layouts/from-photo", json=photo_request())
    assert (response.status_code, response.json()["code"]) == (503, "llm_unavailable")


@pytest.mark.parametrize(
    ("data", "status", "code"),
    [
        (b"GIF89a....", 422, "invalid_image"),
        (PNG_MAGIC + bytes(8 * 1024 * 1024 + 1), 413, "image_too_large"),
    ],
    ids=["invalid", "too_large"],
)
def test_from_photo_image_errors(make_client, data: bytes, status: int, code: str) -> None:
    client = make_client(vision_client=fake_client(reply()))
    response = client.post("/api/layouts/from-photo", json=photo_request(data))
    assert (response.status_code, response.json()["code"]) == (status, code)


def test_from_photo_model_says_not_found(make_client) -> None:
    client = make_client(vision_client=fake_client(reply(found=False, notes="no track")))
    response = client.post("/api/layouts/from-photo", json=photo_request())
    assert (response.status_code, response.json()["code"]) == (422, "photo_unrecognised")


# --------------------------------------------------------------------------- body size cap


def test_oversized_content_length_is_413(make_client) -> None:
    client = make_client()
    big = client.put("/api/settings", content=bytes(1024 * 1024 + 1))
    assert big.status_code == 413
    photo = client.post("/api/layouts/from-photo", content=bytes(12 * 1024 * 1024 + 1))
    assert (photo.status_code, photo.json()["code"]) == (413, "image_too_large")


def test_chunked_oversize_is_413(make_client) -> None:
    client = make_client()

    def chunks() -> Iterator[bytes]:
        for _ in range(3):
            yield bytes(512 * 1024)

    response = client.put(
        "/api/settings", content=chunks(), headers={"content-type": "application/json"}
    )
    assert response.status_code == 413


def test_photo_between_the_limits_is_not_capped(make_client) -> None:
    # 2 MB of body: above the generic cap but fine for the photo endpoint (then invalid).
    body = photo_request(PNG_MAGIC + bytes(1_500_000))
    response = make_client().post("/api/layouts/from-photo", json=body)
    assert response.status_code != 413


def test_normal_put_settings_still_passes(make_client) -> None:
    client = make_client()
    settings = client.get("/api/settings").json()
    assert client.put("/api/settings", json=settings).status_code == 200


def test_validation_errors_do_not_echo_the_input(make_client) -> None:
    body = photo_request()
    del body["name"]
    response = make_client(vision_client=fake_client(reply())).post(
        "/api/layouts/from-photo", json=body
    )
    assert (response.status_code, response.json()["code"]) == (422, "invalid_request")
    assert body["image_base64"] not in response.text
    assert len(response.text) < 1000
