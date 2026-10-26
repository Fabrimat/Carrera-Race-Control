"""Marshal incident endpoints (docs/PROTOCOL.md "Roadmap wave 1" -> "Incidents")."""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

from fastapi.testclient import TestClient

from tests.test_api import make_client, total_laps, wait_state  # noqa: F401 - pytest fixture
from tests.test_service import make_config


def test_marshal_endpoints_need_a_running_race(make_client: Callable[..., TestClient]) -> None:  # noqa: F811
    client = make_client()
    for path in ("/api/race/incidents/0", "/api/race/incidents/0/clear"):
        r = client.post(path)
        assert r.status_code == 409, path
        assert r.json()["code"] == "race_not_running"


def test_report_and_clear_a_car(make_client: Callable[..., TestClient], tmp_path: Path) -> None:  # noqa: F811
    # a slower simulator: the car must not cross the line between the calls
    client = make_client(config=make_config(tmp_path, sim_time_scale=5.0))
    client.post("/api/connect", json={"mode": "simulator"})
    assert client.post("/api/race/start").status_code == 200
    wait_state(client, lambda s: total_laps(s) >= 2)

    r = client.post("/api/race/incidents/0")
    assert r.status_code == 200, r.text
    car = next(c for c in r.json()["cars"] if c["address"] == 0)
    assert car["incident"]["source"] == "marshal"
    assert car["incidents"] == 1
    # reporting again is a no-op
    again = client.post("/api/race/incidents/0")
    assert again.status_code == 200
    assert next(c for c in again.json()["cars"] if c["address"] == 0)["incidents"] == 1

    r = client.post("/api/race/incidents/0/clear")
    assert r.status_code == 200, r.text
    car = next(c for c in r.json()["cars"] if c["address"] == 0)
    assert car["incident"] is None
    assert car["incident_lost_ms"] >= 0

    r = client.post("/api/race/incidents/0/clear")
    assert r.status_code == 404
    assert r.json()["code"] == "incident_not_found"


def test_unknown_car_and_bad_address(make_client: Callable[..., TestClient]) -> None:  # noqa: F811
    client = make_client()
    client.post("/api/connect", json={"mode": "simulator"})
    client.post("/api/race/start")
    wait_state(client, lambda s: s["race"]["phase"] == "running")
    r = client.post("/api/race/incidents/7")
    assert (r.status_code, r.json()["code"]) == (404, "incident_not_found")
    r = client.post("/api/race/incidents/7/clear")
    assert (r.status_code, r.json()["code"]) == (404, "incident_not_found")
    r = client.post("/api/race/incidents/abc")
    assert (r.status_code, r.json()["code"]) == (422, "invalid_request")
