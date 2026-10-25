"""Drivers roster, photos, assignments, assign-next-crossing and speech-to-text (no network)."""

from __future__ import annotations

import base64
import json
from collections.abc import Callable, Iterator
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.commentary.llm import TemplateWriter
from app.commentary.stt import (
    ElevenLabsTranscriber,
    OpenAITranscriber,
    TranscriptionError,
    guess_driver,
)
from app.config import AppConfig
from app.main import create_app
from app.race.models import CarState, Driver, RaceConfig
from app.race.store import RaceStore
from app.service import RaceController
from app.track.base import Timer
from tests.test_commentary_fakes import FakeTTS
from tests.test_service import (
    FakeTrack,
    hub,
    make_config,
    make_controller,
    running,
    wait_for,
)

PNG = bytes.fromhex("89504e470d0a1a0a") + b"\x00" * 32
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 32
WEBP = b"RIFF\x24\x00\x00\x00WEBPVP8 " + b"\x00" * 24
MB = 1024 * 1024


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


def photo_body(data: bytes, media_type: str = "image/png") -> dict[str, str]:
    return {"image_base64": b64(data), "media_type": media_type}


class FakeTranscriber:
    def __init__(self, text: str = "Anna", error: TranscriptionError | None = None) -> None:
        self.text = text
        self.error = error
        self.calls: list[tuple[int, str, str]] = []

    async def transcribe(self, audio: bytes, media_type: str, language: str) -> str:
        self.calls.append((len(audio), media_type, language))
        if self.error is not None:
            raise self.error
        return self.text


@pytest.fixture
def make_client(tmp_path: Path) -> Iterator[Callable[..., TestClient]]:
    clients: list[TestClient] = []

    def make(
        transcriber: FakeTranscriber | None = None, config: AppConfig | None = None
    ) -> TestClient:
        def build(cfg: AppConfig, store: RaceStore) -> RaceController:
            return RaceController(
                cfg,
                store,
                tts=FakeTTS(available=False),
                writer=TemplateWriter(),
                transcriber=transcriber,
            )

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


def add_driver(client: TestClient, name: str, **extra: Any) -> dict[str, Any]:
    r = client.post("/api/drivers", json={"name": name, **extra})
    assert r.status_code == 200, r.text
    return r.json()


# --------------------------------------------------------------------------- CRUD


def test_driver_crud_and_ids(make_client) -> None:
    client = make_client()
    assert client.get("/api/drivers").json() == {"drivers": []}
    anna = add_driver(client, "Anna Rossi", nickname="Fulmine", bio="Loves red cars")
    assert anna["id"] == "anna-rossi" and anna["has_photo"] is False
    assert add_driver(client, "Anna Rossi")["id"] == "anna-rossi-2"
    assert add_driver(client, "Zoë Ñandú")["id"] == "zoe-nandu"
    assert add_driver(client, "!!!")["id"] == "driver"
    assert [d["name"] for d in client.get("/api/drivers").json()["drivers"]][0] == "!!!"

    # PUT: the path wins over a different body id; has_photo / created_at are the server's.
    body = {**anna, "id": "someone-else", "name": "Anna B", "nickname": "", "has_photo": True}
    r = client.put("/api/drivers/anna-rossi", json=body)
    assert r.status_code == 200, r.text
    updated = r.json()
    assert updated["id"] == "anna-rossi" and updated["name"] == "Anna B"
    assert updated["nickname"] is None and updated["has_photo"] is False
    assert updated["created_at"] == anna["created_at"]
    assert client.get("/api/drivers").json()["drivers"].count(updated) == 1
    assert client.put("/api/drivers/nobody", json=body).status_code == 404

    r = client.delete("/api/drivers/anna-rossi")
    assert r.status_code == 200
    assert "anna-rossi" not in [d["id"] for d in r.json()["drivers"]]
    r = client.delete("/api/drivers/anna-rossi")
    assert r.status_code == 404 and r.json()["code"] == "not_found"


@pytest.mark.parametrize(
    "body",
    [{}, {"name": ""}, {"name": "   "}, {"name": "x" * 41}, {"name": "A", "nickname": "n" * 25}],
)
def test_driver_validation(make_client, body: dict[str, Any]) -> None:
    r = make_client().post("/api/drivers", json=body)
    assert r.status_code == 422 and r.json()["code"] == "invalid_request"


def test_generated_id_matches_the_slug_rule(make_client) -> None:
    import re

    client = make_client()
    ids = [add_driver(client, name)["id"] for name in ("A" * 40, "-lead", "x y z", "Élan")]
    assert all(re.match(r"^[a-z0-9][a-z0-9-]{0,39}$", i) for i in ids), ids


# --------------------------------------------------------------------------- photos


@pytest.mark.parametrize(
    ("data", "media", "ext"),
    [(PNG, "image/png", "png"), (JPEG, "image/jpeg", "jpg"), (WEBP, "image/webp", "webp")],
)
def test_photo_roundtrip(make_client, tmp_path: Path, data: bytes, media: str, ext: str) -> None:
    client = make_client()
    add_driver(client, "Anna")
    assert client.get("/api/drivers/anna/photo").status_code == 404
    r = client.put("/api/drivers/anna/photo", json=photo_body(data, media))
    assert r.status_code == 200, r.text
    assert r.json()["has_photo"] is True
    assert (tmp_path / "data" / "avatars" / f"anna.{ext}").read_bytes() == data

    r = client.get("/api/drivers/anna/photo")
    assert r.status_code == 200 and r.content == data
    assert r.headers["content-type"] == media
    assert r.headers["cache-control"] == "no-cache"
    etag = r.headers["etag"]
    cached = client.get("/api/drivers/anna/photo", headers={"If-None-Match": etag})
    assert cached.status_code == 304

    r = client.delete("/api/drivers/anna/photo")
    assert r.status_code == 200 and r.json()["has_photo"] is False
    assert client.get("/api/drivers/anna/photo").status_code == 404
    assert not list((tmp_path / "data" / "avatars").glob("anna.*"))


def test_photo_type_follows_the_content_not_the_declared_type(make_client, tmp_path: Path) -> None:
    client = make_client()
    add_driver(client, "Anna")
    assert client.put("/api/drivers/anna/photo", json=photo_body(PNG)).status_code == 200
    # A JPEG declared as PNG is stored as a JPEG; the old PNG disappears.
    assert client.put("/api/drivers/anna/photo", json=photo_body(JPEG)).status_code == 200
    names = sorted(p.name for p in (tmp_path / "data" / "avatars").iterdir())
    assert names == ["anna.jpg"]
    assert client.get("/api/drivers/anna/photo").headers["content-type"] == "image/jpeg"


@pytest.mark.parametrize(
    "data",
    [b"", b"GIF89a" + b"\x00" * 20, b"<svg></svg>", b"RIFF\x00\x00\x00\x00WAVEfmt ", b"MZ\x90\x00"],
)
def test_photo_with_bad_magic_bytes_is_rejected(make_client, data: bytes) -> None:
    client = make_client()
    add_driver(client, "Anna")
    r = client.put("/api/drivers/anna/photo", json=photo_body(data, "image/png"))
    assert r.status_code == 422 and r.json()["code"] == "invalid_image"
    assert client.get("/api/drivers").json()["drivers"][0]["has_photo"] is False


def test_photo_not_base64_and_unknown_media_type(make_client) -> None:
    client = make_client()
    add_driver(client, "Anna")
    r = client.put(
        "/api/drivers/anna/photo", json={"image_base64": "!!!", "media_type": "image/png"}
    )
    assert r.status_code == 422 and r.json()["code"] == "invalid_image"
    r = client.put("/api/drivers/anna/photo", json=photo_body(PNG, "image/gif"))
    assert r.status_code == 422 and r.json()["code"] == "invalid_request"


def test_photo_size_limit_is_two_megabytes_decoded(make_client) -> None:
    client = make_client()
    add_driver(client, "Anna")
    ok = PNG + b"\x00" * (2 * MB - len(PNG))
    assert client.put("/api/drivers/anna/photo", json=photo_body(ok)).status_code == 200
    big = PNG + b"\x00" * (2 * MB - len(PNG) + 1)
    r = client.put("/api/drivers/anna/photo", json=photo_body(big))
    assert r.status_code == 413 and r.json()["code"] == "image_too_large"
    huge = PNG + b"\x00" * (4 * MB)  # past the transport cap as well
    r = client.put("/api/drivers/anna/photo", json=photo_body(huge))
    assert r.status_code == 413 and r.json()["code"] == "image_too_large"


def test_photo_for_unknown_driver_and_hostile_ids(make_client, tmp_path: Path) -> None:
    client = make_client()
    assert client.put("/api/drivers/nobody/photo", json=photo_body(PNG)).status_code == 404
    assert client.delete("/api/drivers/nobody/photo").status_code == 404
    for hostile in ("..%2Fcarrera.sqlite3", "%2e%2e", "A", "a%5Cb"):
        assert client.get(f"/api/drivers/{hostile}/photo").status_code == 404
        assert client.put(f"/api/drivers/{hostile}/photo", json=photo_body(PNG)).status_code == 404


def test_deleting_a_driver_removes_photo_and_assignments(make_client, tmp_path: Path) -> None:
    client = make_client()
    add_driver(client, "Anna")
    add_driver(client, "Bob")
    client.put("/api/drivers/anna/photo", json=photo_body(PNG))
    client.put("/api/event/assignments", json={"assignments": {"0": "anna", "1": "bob"}})
    client.delete("/api/drivers/anna")
    assert not list((tmp_path / "data" / "avatars").glob("anna.*"))
    assert client.get("/api/event/assignments").json() == {"assignments": {"1": "bob"}}


# --------------------------------------------------------------------------- assignments (API)


def test_assignments_api(make_client) -> None:
    client = make_client()
    add_driver(client, "Anna")
    add_driver(client, "Bob")
    assert client.get("/api/event/assignments").json() == {"assignments": {}}
    r = client.put("/api/event/assignments", json={"assignments": {"0": "anna", "2": "bob"}})
    assert r.status_code == 200 and r.json() == {"assignments": {"0": "anna", "2": "bob"}}
    # null clears one car, other cars are kept
    r = client.put("/api/event/assignments", json={"assignments": {"0": None}})
    assert r.json() == {"assignments": {"2": "bob"}}
    assert client.get("/api/event/assignments").json() == {"assignments": {"2": "bob"}}


@pytest.mark.parametrize(
    "assignments",
    [{"6": "anna"}, {"-1": "anna"}, {"0": "ghost"}, {"x": "anna"}, {"0": 5}],
)
def test_assignments_validation(make_client, assignments: dict[str, Any]) -> None:
    client = make_client()
    add_driver(client, "Anna")
    r = client.put("/api/event/assignments", json={"assignments": assignments})
    assert r.status_code == 422 and r.json()["code"] == "invalid_request"
    assert client.get("/api/event/assignments").json() == {"assignments": {}}


def test_assignments_reach_the_published_state(make_client) -> None:
    client = make_client()
    add_driver(client, "Anna Rossi", nickname="Fulmine")
    add_driver(client, "Bob")
    client.put("/api/event/assignments", json={"assignments": {"0": "anna-rossi", "1": "bob"}})
    client.post("/api/connect", json={"mode": "simulator", "address": None})
    client.post("/api/race/start", json={"mode": "laps", "target_laps": 2})
    import time

    deadline = time.monotonic() + 15
    cars: list[dict[str, Any]] = []
    while time.monotonic() < deadline:
        cars = client.get("/api/state").json()["race"]["cars"]
        if {c["address"] for c in cars} >= {0, 1}:
            break
        time.sleep(0.05)
    by_address = {c["address"]: c for c in cars}
    assert by_address[0]["driver_id"] == "anna-rossi" and by_address[0]["driver_name"] == "Fulmine"
    assert by_address[1]["driver_name"] == "Bob"
    other = [c for a, c in by_address.items() if a > 1]
    assert all(c["driver_id"] is None and c["driver_name"] is None for c in other)


# --------------------------------------------------------------------------- controller


def seed(ctl: RaceController, *names: str) -> list[Driver]:
    return [ctl.create_driver(n, None, "") for n in names]


async def test_manual_assignment_emits_driver_assigned_once_per_change(tmp_path: Path) -> None:
    ctl = make_controller(tmp_path, FakeTrack())
    seed(ctl, "Anna", "Bob")

    async def body() -> None:
        await ctl.set_assignments({0: "anna", 1: "bob"})
        await ctl.set_assignments({0: "anna"})  # unchanged: no event
        await ctl.set_assignments({1: None})
        events = [e for e in hub(ctl).of("event") if e.type == "driver_assigned"]
        assert [(e.address, e.driver_id, e.driver_name, e.method) for e in events] == [
            (0, "anna", "Anna", "manual"),
            (1, "bob", "Bob", "manual"),
        ]

    await running(ctl, body)


async def test_assign_next_crossing_assigns_and_disarms(tmp_path: Path) -> None:
    track = FakeTrack()
    ctl = make_controller(tmp_path, track)
    seed(ctl, "Anna", "Bob")

    async def body() -> None:
        await ctl.connect("simulator", None, persist=False)
        await ctl.set_assignments({0: "anna"})
        ctl.arm("bob")
        assert ctl.event_state.armed_driver_id == "bob"
        assert ctl.event_state.armed_until is not None
        # a sector 2 crossing and an autonomous car do not count
        track.items.put_nowait(Timer(3, 500, 2))
        track.items.put_nowait(Timer(7, 600, 1))
        track.items.put_nowait(Timer(3, 1000, 1))
        await wait_for(lambda: ctl.event_state.assignments.get(3) == "bob")
        assert ctl.event_state.armed_driver_id is None and ctl.event_state.armed_until is None
        assert ctl.assignments() == {0: "anna", 3: "bob"}
        events = [e for e in hub(ctl).of("event") if e.type == "driver_assigned"]
        assert len(events) == 2  # anna (manual) then bob (crossing)
        assert (events[-1].address, events[-1].method, events[-1].driver_name) == (
            3,
            "crossing",
            "Bob",
        )
        # disarmed: a second crossing changes nothing
        track.items.put_nowait(Timer(4, 2000, 1))
        await wait_for(lambda: track.items.empty())
        assert 4 not in ctl.assignments()

    await running(ctl, body)


async def test_crossing_moves_a_driver_who_was_in_another_car(tmp_path: Path) -> None:
    track = FakeTrack()
    ctl = make_controller(tmp_path, track)
    seed(ctl, "Anna")

    async def body() -> None:
        await ctl.connect("simulator", None, persist=False)
        await ctl.set_assignments({0: "anna"})
        ctl.arm("anna")
        track.items.put_nowait(Timer(2, 1000, 1))
        await wait_for(lambda: ctl.assignments() == {2: "anna"})

    await running(ctl, body)


async def test_crossing_is_ignored_while_a_race_runs_and_armed_keeps_waiting(
    tmp_path: Path,
) -> None:
    track = FakeTrack()
    ctl = make_controller(tmp_path, track)
    seed(ctl, "Anna")

    async def body() -> None:
        await ctl.connect("simulator", None, persist=False)
        ctl.arm("anna")
        ctl.engine.prepare(RaceConfig())
        track.items.put_nowait(Timer(1, 1000, 1))
        await wait_for(lambda: track.items.empty())
        assert ctl.assignments() == {}
        assert ctl.event_state.armed_driver_id == "anna"

    await running(ctl, body)


async def test_arming_is_busy_during_a_race_and_one_at_a_time(tmp_path: Path) -> None:
    ctl = make_controller(tmp_path, FakeTrack())
    seed(ctl, "Anna", "Bob")
    ctl.arm("anna")
    ctl.arm("bob")
    assert ctl.event_state.armed_driver_id == "bob"
    ctl.disarm()
    assert ctl.event_state.armed_driver_id is None
    ctl.engine.prepare(RaceConfig())
    with pytest.raises(Exception) as err:
        ctl.arm("anna")
    assert (err.value.status, err.value.code) == (409, "busy")  # type: ignore[attr-defined]
    ctl.store.close()


async def test_arming_expires_after_sixty_seconds(tmp_path: Path) -> None:
    track = FakeTrack()
    ctl = make_controller(tmp_path, track)
    seed(ctl, "Anna")
    now = ctl._wall_clock()
    ctl._wall_clock = lambda: now

    async def body() -> None:
        await ctl.connect("simulator", None, persist=False)
        ctl.arm("anna")
        assert ctl.event_state.armed_until == now + timedelta(seconds=60)
        ctl._wall_clock = lambda: now + timedelta(seconds=61)
        track.items.put_nowait(Timer(0, 1000, 1))
        await wait_for(lambda: track.items.empty())
        assert ctl.assignments() == {}
        await wait_for(lambda: ctl.event_state.armed_driver_id is None)

    await running(ctl, body)


async def test_arm_unknown_driver_is_404(tmp_path: Path) -> None:
    ctl = make_controller(tmp_path, FakeTrack())
    with pytest.raises(Exception) as err:
        ctl.arm("ghost")
    assert err.value.status == 404  # type: ignore[attr-defined]
    ctl.store.close()


def test_arm_api(make_client) -> None:
    client = make_client()
    add_driver(client, "Anna")
    assert (
        client.post("/api/event/assign-next-crossing", json={"driver_id": "x"}).status_code == 404
    )
    r = client.post("/api/event/assign-next-crossing", json={"driver_id": "anna"})
    assert r.status_code == 200 and r.json() == {"armed": True}
    ctl = client.app.state.controller
    assert ctl.event_state.armed_driver_id == "anna"
    r = client.delete("/api/event/assign-next-crossing")
    assert r.status_code == 200 and r.json() == {"armed": False}
    assert ctl.event_state.armed_driver_id is None
    ctl.engine.prepare(RaceConfig())
    r = client.post("/api/event/assign-next-crossing", json={"driver_id": "anna"})
    assert r.status_code == 409 and r.json()["code"] == "busy"


async def test_assignments_and_arming_survive_a_restart(tmp_path: Path) -> None:
    db = tmp_path / "restart.sqlite3"
    store = RaceStore(db)
    ctl = make_controller(tmp_path, FakeTrack(), store=store)
    seed(ctl, "Anna", "Bob")

    async def body() -> None:
        await ctl.set_assignments({0: "anna", 5: "bob"})
        ctl.arm("bob")

    await running(ctl, body)

    ctl2 = make_controller(tmp_path, FakeTrack(), store=RaceStore(db))
    assert ctl2.assignments() == {0: "anna", 5: "bob"}
    assert ctl2.event_state.armed_driver_id == "bob"
    state = ctl2.engine.state
    ctl2._fill_drivers(state)
    ctl2.store.close()

    # an arming that expired while the app was down is dropped at startup
    store3 = RaceStore(db)
    saved = store3.load_event_state()
    saved.armed_until = saved.armed_until - timedelta(minutes=5)  # type: ignore[operator]
    store3.save_event_state(saved)
    ctl3 = make_controller(tmp_path, FakeTrack(), store=store3)
    assert ctl3.event_state.armed_driver_id is None and ctl3.assignments() == {0: "anna", 5: "bob"}
    ctl3.store.close()


async def test_race_state_names_follow_the_roster(tmp_path: Path) -> None:
    def car(address: int) -> CarState:
        return CarState(address=address, name=f"Car {address + 1}", color="#ffffff")

    ctl = make_controller(tmp_path, FakeTrack())
    seed(ctl, "Anna")
    ctl._event_state.assignments = {0: "anna", 1: "ghost"}
    state = ctl.engine.state
    state.cars = [car(0), car(1), car(2)]
    ctl._fill_drivers(state)
    assert [(c.driver_id, c.driver_name) for c in state.cars] == [
        ("anna", "Anna"),
        (None, None),
        (None, None),
    ]
    ctl.update_driver("anna", Driver(id="anna", name="Anna", nickname="Fulmine"))
    ctl._fill_drivers(state)
    assert state.cars[0].driver_name == "Fulmine"
    ctl.store.close()


# --------------------------------------------------------------------------- commentary


def test_driver_assigned_commentary_templates() -> None:
    from app.commentary.events import candidates
    from app.race.models import DriverAssigned, RaceState, Verbosity

    event = DriverAssigned(address=1, driver_id="anna", driver_name="Anna", method="crossing")
    for lang, word in (("en", "car"), ("it", "macchina")):
        cands = candidates(event, RaceState(), {}, Verbosity.NORMAL, lang)
        assert len(cands) == 1, lang
        assert "Anna" in cands[0].text and word in cands[0].text.lower()
        assert cands[0].facts["event"] == "driver_assigned"


# --------------------------------------------------------------------------- speech to text


AUDIO = b"fake-audio-bytes"


def test_transcribe_api_with_name_guess(make_client) -> None:
    fake = FakeTranscriber("Anna")
    client = make_client(fake)
    add_driver(client, "Anna Rossi")
    add_driver(client, "Bob")
    body = {"audio_base64": b64(AUDIO), "media_type": "audio/webm;codecs=opus", "language": "it"}
    r = client.post("/api/event/transcribe", json=body)
    assert r.status_code == 200, r.text
    assert r.json() == {"text": "Anna", "name_guess": "anna-rossi"}
    assert fake.calls == [(len(AUDIO), "audio/webm;codecs=opus", "it")]


def test_transcribe_no_match_gives_null(make_client) -> None:
    client = make_client(FakeTranscriber("quasimodo"))
    add_driver(client, "Anna")
    body = {"audio_base64": b64(AUDIO), "media_type": "audio/wav", "language": "en"}
    assert client.post("/api/event/transcribe", json=body).json() == {
        "text": "quasimodo",
        "name_guess": None,
    }


@pytest.mark.parametrize("media", ["audio/webm", "audio/ogg", "audio/mp4", "audio/wav"])
def test_transcribe_accepts_the_documented_types(make_client, media: str) -> None:
    client = make_client(FakeTranscriber())
    body = {"audio_base64": b64(AUDIO), "media_type": media, "language": "en"}
    assert client.post("/api/event/transcribe", json=body).status_code == 200


@pytest.mark.parametrize(
    ("body", "status"),
    [
        ({"audio_base64": "AAAA", "media_type": "audio/mpeg"}, 422),
        ({"audio_base64": "AAAA", "media_type": "video/webm"}, 422),
        ({"audio_base64": "###", "media_type": "audio/webm"}, 422),
        ({"audio_base64": "", "media_type": "audio/webm"}, 422),
        ({"audio_base64": "AAAA", "media_type": "audio/webm", "language": "fr"}, 422),
    ],
)
def test_transcribe_validation(make_client, body: dict[str, str], status: int) -> None:
    r = make_client(FakeTranscriber()).post("/api/event/transcribe", json=body)
    assert r.status_code == status and r.json()["code"] == "invalid_request"


def test_transcribe_size_limit(make_client) -> None:
    client = make_client(FakeTranscriber())
    body = {"audio_base64": b64(b"\x00" * (2 * MB)), "media_type": "audio/webm"}
    assert client.post("/api/event/transcribe", json=body).status_code == 200
    body["audio_base64"] = b64(b"\x00" * (2 * MB + 1))
    r = client.post("/api/event/transcribe", json=body)
    assert r.status_code == 413 and r.json()["code"] == "invalid_request"
    body["audio_base64"] = b64(b"\x00" * (4 * MB))
    assert client.post("/api/event/transcribe", json=body).status_code == 413


def test_transcribe_error_codes(make_client) -> None:
    body = {"audio_base64": b64(AUDIO), "media_type": "audio/webm"}
    down = TranscriptionError("llm_unavailable", "down", 503)
    r = make_client(FakeTranscriber(error=down)).post("/api/event/transcribe", json=body)
    assert (r.status_code, r.json()["code"]) == (503, "llm_unavailable")
    bad = TranscriptionError("transcription_failed", "bad", 422)
    r = make_client(FakeTranscriber(error=bad)).post("/api/event/transcribe", json=body)
    assert (r.status_code, r.json()["code"]) == (422, "transcription_failed")
    r = make_client(FakeTranscriber("")).post("/api/event/transcribe", json=body)
    assert (r.status_code, r.json()["code"]) == (422, "transcription_failed")


def test_transcribe_without_any_key_is_llm_unavailable(make_client) -> None:
    body = {"audio_base64": b64(AUDIO), "media_type": "audio/webm"}
    r = make_client().post("/api/event/transcribe", json=body)
    assert (r.status_code, r.json()["code"]) == (503, "llm_unavailable")


def test_transcriber_choice_follows_the_provider(tmp_path: Path) -> None:
    keys = {
        "elevenlabs_api_key": SecretStr("el"),
        "openai_api_key": SecretStr("oa"),
        "anthropic_api_key": SecretStr("an"),
    }
    ctl = make_controller(tmp_path, config=make_config(tmp_path, **keys))
    assert isinstance(ctl._build_transcriber(), ElevenLabsTranscriber)
    ctl.settings.commentary.llm_provider = "openai"
    assert isinstance(ctl._build_transcriber(), OpenAITranscriber)
    ctl.store.close()
    # OpenAI selected without its key: ElevenLabs
    ctl = make_controller(
        tmp_path,
        config=make_config(tmp_path, elevenlabs_api_key=SecretStr("el"), openai_api_key=None),
    )
    ctl.settings.commentary.llm_provider = "openai"
    assert isinstance(ctl._build_transcriber(), ElevenLabsTranscriber)
    ctl.store.close()


async def test_elevenlabs_transcriber_request_and_errors() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"text": " Anna ", "language_code": "ita"})

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    stt = ElevenLabsTranscriber("secret-key", client=client)
    assert await stt.transcribe(AUDIO, "audio/webm;codecs=opus", "it") == "Anna"
    request = seen[0]
    assert str(request.url) == "https://api.elevenlabs.io/v1/speech-to-text"
    assert request.headers["xi-api-key"] == "secret-key"
    content = request.content
    assert b'name="model_id"' in content and b"scribe_v1" in content
    assert b'name="language_code"' in content and AUDIO in content

    async def status(code: int) -> TranscriptionError:
        c = httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(code)))
        with pytest.raises(TranscriptionError) as err:
            await ElevenLabsTranscriber("k", client=c).transcribe(AUDIO, "audio/webm", "en")
        return err.value

    for code, expected in (
        (401, "llm_unavailable"),
        (429, "llm_unavailable"),
        (503, "llm_unavailable"),
        (400, "transcription_failed"),
    ):
        assert (await status(code)).code == expected, code

    def boom(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("no route")

    c = httpx.AsyncClient(transport=httpx.MockTransport(boom))
    with pytest.raises(TranscriptionError) as err:
        await ElevenLabsTranscriber("k", client=c).transcribe(AUDIO, "audio/webm", "en")
    assert err.value.code == "llm_unavailable"


async def test_openai_transcriber_request_and_errors() -> None:
    calls: list[dict[str, Any]] = []

    class Transcriptions:
        async def create(self, **kwargs: Any) -> Any:
            calls.append(kwargs)
            if kwargs["language"] == "fr":
                raise RejectedKey(401)
            return SimpleNamespace(text=" Bob ")

    class RejectedKey(Exception):
        def __init__(self, status_code: int) -> None:
            self.status_code = status_code

    client = SimpleNamespace(audio=SimpleNamespace(transcriptions=Transcriptions()))
    stt = OpenAITranscriber("k", client=client)
    assert await stt.transcribe(AUDIO, "audio/mp4", "en") == "Bob"
    assert calls[0]["model"] == "gpt-4o-transcribe" and calls[0]["language"] == "en"
    assert calls[0]["file"] == ("speech.mp4", AUDIO, "audio/mp4")
    with pytest.raises(TranscriptionError) as err:
        await stt.transcribe(AUDIO, "audio/mp4", "fr")
    assert err.value.code == "llm_unavailable"


def roster() -> list[Driver]:
    return [
        Driver(id="anna-rossi", name="Anna Rossi", nickname="Fulmine"),
        Driver(id="jose", name="José Álvarez"),
        Driver(id="bob", name="Bob"),
    ]


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("Anna", "anna-rossi"),
        ("anna rossi.", "anna-rossi"),
        ("fulmine", "anna-rossi"),
        ("Fulmini", "anna-rossi"),
        ("Jose", "jose"),
        ("it's JOSÉ!", "jose"),
        ("the driver is Bob please", "bob"),
        ("Bobby", "bob"),
        ("quasimodo", None),
        ("", None),
        ("   ", None),
        ("xyz", None),
    ],
)
def test_guess_driver(text: str, expected: str | None) -> None:
    assert guess_driver(text, roster()) == expected


def test_guess_driver_empty_roster_and_threshold() -> None:
    assert guess_driver("Anna", []) is None
    assert guess_driver("Ann", [Driver(id="anna", name="Anna")]) == "anna"
    assert guess_driver("Anselmo", [Driver(id="anna", name="Anna")]) is None


def test_no_key_or_audio_in_the_log_output(make_client, caplog) -> None:
    secret_audio = b"SECRET-AUDIO-BYTES"
    client = make_client(FakeTranscriber(error=TranscriptionError("llm_unavailable", "x", 503)))
    body = {"audio_base64": b64(secret_audio), "media_type": "audio/webm"}
    with caplog.at_level("DEBUG"):
        client.post("/api/event/transcribe", json=body)
    assert "SECRET-AUDIO" not in caplog.text and b64(secret_audio) not in caplog.text
    assert json.dumps(body) not in caplog.text


def test_commentator_names_assigned_drivers_instead_of_cars(make_client) -> None:
    from app.race.models import CarConfig

    client = make_client()
    ctl = client.app.state.controller
    ctl.settings.cars = [
        CarConfig(address=0, name="Rosso 1", color="#ff0000", nickname="Rosso"),
        CarConfig(address=1, name="Blue Arrow", color="#0000ff", nickname=None),
    ]
    ctl.store.save_driver(Driver(id="paolo", name="Paolo", nickname="Il Fulmine"))
    ctl._drivers_cache = None
    ctl._update_event_state(lambda s: s.assignments.update({0: "paolo"}))
    spoken = ctl._spoken_cars()
    assert (spoken[0].name, spoken[0].nickname) == ("Paolo", "Il Fulmine")
    assert spoken[1].name == "Blue Arrow"
    assert ctl.settings.cars[0].name == "Rosso 1"  # settings untouched
