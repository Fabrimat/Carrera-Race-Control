"""REST tests for event programs and the session runner (docs/PROTOCOL.md "Event mode")."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import pytest
from fastapi.testclient import TestClient

from tests.test_api import make_client  # noqa: F401 - pytest fixture
from tests.test_service import FakeTrack


def session(sid: str, kind: str = "race", **extra: Any) -> dict[str, Any]:
    return {"id": sid, "kind": kind, **extra}


def program(pid: str = "cup", *sessions: dict[str, Any], **extra: Any) -> dict[str, Any]:
    return {"id": pid, "name": "Cup", "sessions": list(sessions) or [session("r")], **extra}


def put(client: TestClient, body: dict[str, Any], pid: str | None = None):
    return client.put(f"/api/programs/{pid or body['id']}", json=body)


def test_programs_crud_and_normalisation(make_client: Callable[..., TestClient]) -> None:  # noqa: F811
    client = make_client()
    assert client.get("/api/programs").json() == {"programs": []}
    body = program(
        "cup",
        session("q", "qualifying", mode="laps", duration_s=120),
        session("r", "race", mode="laps", target_laps=5, grid_from="q"),
    )
    body["id"] = "other-id-in-body"
    res = client.put("/api/programs/cup", json=body)
    assert res.status_code == 200, res.text
    saved = res.json()
    assert saved["id"] == "cup"  # the URL wins
    assert saved["sessions"][0]["mode"] == "timed"  # qualifying is always timed
    assert saved["sessions"][1]["mode"] == "laps"
    programs = client.get("/api/programs").json()["programs"]
    assert [p["id"] for p in programs] == ["cup"]
    res = client.delete("/api/programs/cup")
    assert res.status_code == 200 and res.json() == {"programs": []}


@pytest.mark.parametrize(
    ("sessions", "message"),
    [
        ([], "at least one session"),
        ([session("a"), session("a")], "Duplicate session id"),
        ([session("a", grid_from="b"), session("b")], "earlier session"),
        ([session("a", grid_from="a")], "earlier session"),
        ([session("a", grid_from="nope")], "earlier session"),
    ],
)
def test_invalid_programs_are_422(
    make_client: Callable[..., TestClient],  # noqa: F811
    sessions: list[dict[str, Any]],
    message: str,
) -> None:
    client = make_client()
    body = {"id": "cup", "name": "Cup", "sessions": sessions}
    res = client.put("/api/programs/cup", json=body)
    assert res.status_code == 422
    assert res.json()["code"] == "invalid_request"
    assert message in res.json()["detail"]


def test_event_runner_endpoints(make_client: Callable[..., TestClient]) -> None:  # noqa: F811
    track = FakeTrack()
    client = make_client(track_factory=lambda mode, address: track)
    assert client.get("/api/event").json()["program_id"] is None
    put(client, program("cup", session("q", "qualifying", duration_s=60), session("r")))
    res = client.post("/api/event/start", json={"program_id": "missing"})
    assert res.status_code == 422 and res.json()["code"] == "invalid_request"
    res = client.post("/api/event/next")
    assert res.status_code == 409  # no event running

    state = client.post("/api/event/start", json={"program_id": "cup"}).json()
    assert (state["program_id"], state["current_index"], state["results"]) == ("cup", 0, [])
    race = client.get("/api/state").json()["race"]
    assert race["session"]["session_id"] == "q" and race["session"]["kind"] == "qualifying"
    assert race["config"]["mode"] == "timed" and race["config"]["duration_s"] == 60

    assert client.post("/api/connect", json={"mode": "simulator"}).status_code == 200
    started = client.post("/api/race/start")  # no body: the session spec
    assert started.status_code == 200
    assert started.json()["config"]["duration_s"] == 60
    busy = client.post("/api/event/next")
    assert busy.status_code == 409 and busy.json()["code"] == "busy"
    client.post("/api/race/stop")

    state = client.post("/api/event/next").json()
    assert state["current_index"] == 1
    assert client.get("/api/state").json()["race"]["session"]["session_id"] == "r"
    assert client.post("/api/event/next").status_code == 409  # last session

    state = client.post("/api/event/stop").json()
    assert state["program_id"] is None
    assert client.get("/api/state").json()["race"]["session"] is None


def test_deleting_the_running_program_stops_the_event(
    make_client: Callable[..., TestClient],  # noqa: F811
) -> None:
    client = make_client()
    put(client, program("cup"))
    client.post("/api/event/start", json={"program_id": "cup"})
    client.delete("/api/programs/cup")
    assert client.get("/api/event").json()["program_id"] is None
