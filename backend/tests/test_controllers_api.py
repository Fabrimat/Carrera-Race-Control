"""REST endpoints of controller settings, pairing and the garage (no network)."""

from __future__ import annotations

import time
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.commentary.events import candidates
from app.commentary.llm import TemplateWriter
from app.config import AppConfig
from app.main import create_app
from app.race.models import CarPaired, RaceState, Verbosity
from app.race.store import RaceStore
from app.service import RaceController
from app.track.base import Timer
from tests.test_commentary_fakes import FakeTTS
from tests.test_service import FakeTrack, make_config


@pytest.fixture
def make_client(tmp_path: Path) -> Iterator[Callable[..., TestClient]]:
    clients: list[TestClient] = []

    def make(track: FakeTrack | None = None) -> TestClient:
        def build(cfg: AppConfig, store: RaceStore) -> RaceController:
            return RaceController(
                cfg,
                store,
                tts=FakeTTS(available=False),
                writer=TemplateWriter(),
                track_factory=(lambda mode, address: track) if track is not None else None,
            )

        app = create_app(make_config(tmp_path), controller_factory=build, autoconnect=False)
        client = TestClient(app)
        client.__enter__()
        clients.append(client)
        return client

    yield make
    for client in clients:
        client.__exit__(None, None, None)


def until(cond: Callable[[], bool], limit_s: float = 5.0) -> None:
    deadline = time.monotonic() + limit_s
    while not cond():
        assert time.monotonic() < deadline, "condition not met in time"
        time.sleep(0.02)


def connect(client: TestClient) -> None:
    assert client.post("/api/connect", json={"mode": "simulator"}).status_code == 200


def car_body(**extra: Any) -> dict[str, Any]:
    return {"address": 0, "name": "Fulmine", "color": "#112233", **extra}


# --------------------------------------------------------------------------- controllers


def test_get_controllers_works_while_disconnected(make_client) -> None:
    client = make_client()
    body = client.get("/api/controllers").json()
    assert [c["address"] for c in body["controllers"]] == [0, 1, 2, 3, 4, 5]
    first = body["controllers"][0]
    assert first == {
        "address": 0,
        "effective": {"speed": None, "brake": None, "fuel": None},
        "applied": None,
        "pending": False,
        "driver_id": None,
    }


def test_settings_save_then_apply_and_statuses(make_client) -> None:
    track = FakeTrack()
    client = make_client(track)
    settings = client.get("/api/settings").json()
    settings["cars"][1]["controller"] = {"speed": 7, "brake": None, "fuel": 3}
    assert client.put("/api/settings", json=settings).status_code == 200
    pending = client.get("/api/controllers").json()["controllers"][1]
    assert pending["pending"] is True and pending["effective"]["speed"] == 7

    connect(client)  # the first Status after connecting writes everything
    until(lambda: len(track.writes) == 2)
    until(lambda: not client.get("/api/controllers").json()["controllers"][1]["pending"])
    status = client.get("/api/controllers").json()["controllers"][1]
    assert status["applied"] == {"speed": 7, "brake": None, "fuel": 3}

    track.writes.clear()
    r = client.post("/api/controllers/apply")
    assert r.status_code == 200
    assert sorted(track.writes) == [("fuel", 1, 3), ("speed", 1, 7)]  # forced
    assert [c["pending"] for c in r.json()["controllers"]] == [False] * 6


def test_apply_errors(make_client) -> None:
    client = make_client(FakeTrack())
    r = client.post("/api/controllers/apply")
    assert r.status_code == 409 and r.json()["code"] == "not_connected"
    connect(client)
    assert client.post("/api/race/start", json=None).status_code == 200
    r = client.post("/api/controllers/apply")
    assert r.status_code == 409 and r.json()["code"] == "busy"


def test_driver_put_passes_the_controller_profile_through(make_client) -> None:
    client = make_client()
    client.post("/api/drivers", json={"name": "Anna"})
    body = {"id": "anna", "name": "Anna", "controller": {"speed": 4, "brake": None, "fuel": None}}
    r = client.put("/api/drivers/anna", json=body)
    assert r.status_code == 200 and r.json()["controller"]["speed"] == 4
    assert client.get("/api/drivers").json()["drivers"][0]["controller"]["speed"] == 4
    # POST does not take a profile.
    created = client.post("/api/drivers", json={"name": "Bob", "controller": {"speed": 1}}).json()
    assert created["controller"] is None


def test_driver_assignment_shows_in_the_statuses(make_client) -> None:
    client = make_client()
    client.post("/api/drivers", json={"name": "Anna"})
    client.put(
        "/api/drivers/anna",
        json={"id": "anna", "name": "Anna", "controller": {"speed": 2}},
    )
    client.put("/api/event/assignments", json={"assignments": {"3": "anna"}})
    status = client.get("/api/controllers").json()["controllers"][3]
    assert status["driver_id"] == "anna" and status["effective"]["speed"] == 2
    assert status["pending"] is True


# --------------------------------------------------------------------------- pairing


def test_pairing_flow_over_http(make_client) -> None:
    track = FakeTrack()
    client = make_client(track)
    body = {"target_address": 2, "car": car_body(controller={"speed": 9}), "from_address": 5}

    r = client.post("/api/pairing", json=body)
    assert r.status_code == 409 and r.json()["code"] == "not_connected"
    connect(client)
    r = client.post("/api/pairing", json=body)
    assert r.status_code == 200, r.text
    assert r.json()["phase"] == "waiting" and r.json()["car"]["address"] == 2
    assert track.codes == 1
    assert client.get("/api/state").json()["race"]["pairing"]["phase"] == "waiting"

    track.items.put_nowait(Timer(2, 5000, 1))
    until(lambda: client.get("/api/state").json()["race"]["pairing"]["phase"] == "paired")
    cars = {c["address"]: c for c in client.get("/api/settings").json()["cars"]}
    assert cars[2]["name"] == "Fulmine" and cars[2]["controller"]["speed"] == 9
    assert cars[5]["name"] == "Car 6"
    until(lambda: ("speed", 2, 9) in track.writes)


def test_pairing_confirm_and_cancel_endpoints(make_client) -> None:
    track = FakeTrack()
    client = make_client(track)
    connect(client)
    assert client.delete("/api/pairing").status_code == 404
    assert client.post("/api/pairing/confirm").json()["code"] == "not_found"

    body = {"target_address": 1, "car": car_body()}
    client.post("/api/pairing", json=body)
    assert (
        client.post("/api/pairing", json={**body, "target_address": 3}).json()["target_address"]
        == 3
    )
    assert track.codes == 1  # the second POST does not press CODE again
    r = client.post("/api/pairing/confirm")
    assert r.status_code == 200 and r.json()["phase"] == "paired"

    client.post("/api/pairing", json=body)
    r = client.delete("/api/pairing")
    assert r.status_code == 200 and r.json()["phase"] == "cancelled"


def test_pairing_busy_during_a_race(make_client) -> None:
    client = make_client(FakeTrack())
    connect(client)
    assert client.post("/api/race/start", json=None).status_code == 200
    r = client.post("/api/pairing", json={"target_address": 1, "car": car_body()})
    assert r.status_code == 409 and r.json()["code"] == "busy"


@pytest.mark.parametrize(
    "body",
    [
        {"target_address": 6, "car": car_body()},
        {"target_address": -1, "car": car_body()},
        {"target_address": 1, "car": car_body(), "from_address": 6},
        {"target_address": 1, "car": car_body(name="  ")},
        {"target_address": 1, "car": car_body(color="red")},
        {"target_address": 1, "car": car_body(logo_id="nope")},
        {"target_address": 1},
    ],
)
def test_pairing_request_validation(make_client, body) -> None:
    client = make_client(FakeTrack())
    connect(client)
    r = client.post("/api/pairing", json=body)
    assert r.status_code == 422 and r.json()["code"] == "invalid_request"


# --------------------------------------------------------------------------- garage


def test_garage_endpoint(make_client) -> None:
    client = make_client()
    cars = client.get("/api/garage").json()["cars"]
    assert [c["address"] for c in cars] == [0, 1, 2, 3, 4, 5]
    assert cars[0]["races"] == 0 and cars[0]["best_lap_ms"] is None
    assert cars[0]["car"]["name"] == "Car 1"


# --------------------------------------------------------------------------- commentary


def test_car_paired_commentary_templates() -> None:
    event = CarPaired(address=2, name="Fulmine", matches_target=True)
    for lang, word in (("en", "controller"), ("it", "controller")):
        cands = candidates(event, RaceState(), {}, Verbosity.NORMAL, lang)
        assert len(cands) == 1, lang
        assert "Fulmine" in cands[0].text and word in cands[0].text.lower()
        assert ("three" if lang == "en" else "tre") in cands[0].text.lower()
        assert cands[0].facts["event"] == "car_paired"
        assert cands[0].priority.value == "normal"
