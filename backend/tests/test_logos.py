"""Brand logo library: CRUD, validation, headers, settings and import (no network)."""

from __future__ import annotations

import base64
import sqlite3
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.commentary.llm import TemplateWriter
from app.config import AppConfig
from app.logos import validate_logo
from app.main import create_app
from app.race.models import Logo
from app.race.store import SCHEMA_VERSION, RaceStore
from app.service import RaceController
from tests.test_commentary_fakes import FakeTTS
from tests.test_service import make_config
from tests.test_store import _make_v1_db

PNG = bytes.fromhex("89504e470d0a1a0a") + b"\x00" * 32
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 32
WEBP = b"RIFF\x24\x00\x00\x00WEBPVP8 " + b"\x00" * 24
SVG = (
    b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">'
    b'<rect width="10" height="10"/></svg>'
)
CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox"


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


def svg(inner: str, attrs: str = "") -> bytes:
    return f'<svg xmlns="http://www.w3.org/2000/svg" {attrs}>{inner}</svg>'.encode()


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


def add(client: TestClient, name: str = "Ferrari", data: bytes = PNG) -> dict[str, Any]:
    r = client.post("/api/logos", json={"name": name, "image_base64": b64(data)})
    assert r.status_code == 201, r.text
    return r.json()  # type: ignore[no-any-return]


def set_car_logo(client: TestClient, logo_id: str | None, address: int = 0) -> Any:
    settings = client.get("/api/settings").json()
    for car in settings["cars"]:
        if car["address"] == address:
            car["logo_id"] = logo_id
    return client.put("/api/settings", json=settings)


def test_crud_roundtrip(make_client, tmp_path: Path) -> None:
    client = make_client()
    assert client.get("/api/logos").json() == {"logos": []}
    created = add(client, "Ferrari", PNG)
    assert created["id"] == "ferrari" and created["media_type"] == "image/png"
    add(client, "Audi", JPEG)
    assert [x["name"] for x in client.get("/api/logos").json()["logos"]] == ["Audi", "Ferrari"]
    assert (tmp_path / "data" / "logos" / "ferrari.png").read_bytes() == PNG

    r = client.put("/api/logos/ferrari", json={"name": "Ferrari SF", "image_base64": None})
    assert r.status_code == 200 and r.json()["name"] == "Ferrari SF"
    assert r.json()["media_type"] == "image/png"

    # Replace the image with another type: the old file goes away.
    r = client.put("/api/logos/ferrari", json={"name": "Ferrari", "image_base64": b64(WEBP)})
    assert r.status_code == 200 and r.json()["media_type"] == "image/webp"
    assert sorted(p.name for p in (tmp_path / "data" / "logos").glob("ferrari.*")) == [
        "ferrari.webp"
    ]
    assert client.get("/api/logos/ferrari/image").content == WEBP

    r = client.delete("/api/logos/ferrari")
    assert r.status_code == 200 and [x["id"] for x in r.json()["logos"]] == ["audi"]
    assert client.get("/api/logos/ferrari/image").status_code == 404
    assert not list((tmp_path / "data" / "logos").glob("ferrari.*"))
    assert client.put("/api/logos/ferrari", json={"name": "x"}).status_code == 404
    assert client.delete("/api/logos/ferrari").json()["code"] == "logo_not_found"


def test_ids_are_unique_slugs(make_client) -> None:
    client = make_client()
    assert add(client, "Alfa Romeo")["id"] == "alfa-romeo"
    assert add(client, "Alfa Romeo")["id"] == "alfa-romeo-2"
    assert add(client, "???")["id"] == "logo"


@pytest.mark.parametrize(
    ("data", "media"),
    [(PNG, "image/png"), (JPEG, "image/jpeg"), (WEBP, "image/webp"), (SVG, "image/svg+xml")],
)
def test_each_type_is_accepted_and_served_with_the_right_headers(
    make_client, data: bytes, media: str
) -> None:
    client = make_client()
    logo = add(client, "Brand", data)
    assert logo["media_type"] == media
    r = client.get("/api/logos/brand/image")
    assert r.status_code == 200 and r.content == data
    assert r.headers["content-type"].startswith(media)
    assert r.headers["cache-control"] == "no-cache"
    assert r.headers["x-content-type-options"] == "nosniff"
    if media == "image/svg+xml":
        assert r.headers["content-security-policy"] == CSP
    else:
        assert "content-security-policy" not in r.headers
    etag = r.headers["etag"]
    cached = client.get("/api/logos/brand/image", headers={"If-None-Match": etag})
    assert cached.status_code == 304
    assert cached.headers["x-content-type-options"] == "nosniff"
    assert cached.headers["etag"] == etag


@pytest.mark.parametrize(
    "data",
    [
        b"",
        b"GIF89a" + b"\x00" * 20,
        b"MZ\x90\x00",
        b"not an image",
        b"<svg",  # not well-formed
        b"<html><body/></html>",  # root is not svg
        svg("<script>alert(1)</script>"),
        svg('<g><SCRIPT src="x.js"/></g>'),
        svg("<foreignObject><div/></foreignObject>"),
        svg('<rect onload="alert(1)" width="1" height="1"/>'),
        svg('<rect ONCLICK="x()" width="1" height="1"/>'),
        svg('<a href="javascript:alert(1)"><rect/></a>'),
        svg('<a xlink:href="  JavaScript:alert(1)" xmlns:xlink="http://www.w3.org/1999/xlink"/>'),
        svg('<rect fill="javascript:alert(1)"/>'),
        svg('<image href="https://evil.example/x.png"/>'),
        svg('<image xlink:href="http://evil/x" xmlns:xlink="http://www.w3.org/1999/xlink"/>'),
        svg('<use href="other.svg#a"/>'),
        svg("<style>@import 'https://evil/x.css';</style>"),
        svg("<style>rect { fill: url(https://evil/x) }</style>"),
        svg('<rect style="fill:url(http://evil/x)"/>'),
        b'<!DOCTYPE svg [<!ENTITY a "aaaa">]><svg xmlns="http://www.w3.org/2000/svg">&a;</svg>',
        b'<!doctype svg><svg xmlns="http://www.w3.org/2000/svg"/>',
        b'<?xml version="1.0"?><!ENTITY x "y"><svg xmlns="http://www.w3.org/2000/svg"/>',
    ],
)
def test_bad_images_are_rejected(make_client, data: bytes) -> None:
    client = make_client()
    r = client.post("/api/logos", json={"name": "Bad", "image_base64": b64(data)})
    assert r.status_code == 422 and r.json()["code"] == "invalid_image"
    assert client.get("/api/logos").json() == {"logos": []}


def test_safe_svg_features_are_accepted() -> None:
    assert (
        validate_logo(svg('<defs><linearGradient id="g"/></defs><rect fill="url(#g)"/>')) == "svg"
    )
    assert validate_logo(svg("<style>rect{fill:url(#g)}</style>")) == "svg"
    assert validate_logo(svg('<use href="#a"/><image href="data:image/png;base64,AAAA"/>')) == "svg"
    assert validate_logo(b'\xef\xbb\xbf<?xml version="1.0"?>\n' + SVG) == "svg"
    assert validate_logo(b"  \n" + SVG) == "svg"


def test_bad_base64_and_size_limit(make_client) -> None:
    client = make_client()
    r = client.post("/api/logos", json={"name": "Bad", "image_base64": "!!!"})
    assert r.status_code == 422 and r.json()["code"] == "invalid_image"
    ok = PNG + b"\x00" * (512 * 1024 - len(PNG))
    assert (
        client.post("/api/logos", json={"name": "Ok", "image_base64": b64(ok)}).status_code == 201
    )
    big = PNG + b"\x00" * (512 * 1024 - len(PNG) + 1)
    r = client.post("/api/logos", json={"name": "Big", "image_base64": b64(big)})
    assert r.status_code == 413 and r.json()["code"] == "image_too_large"
    big_svg = SVG + b" " * (512 * 1024)
    r = client.post("/api/logos", json={"name": "Big", "image_base64": b64(big_svg)})
    assert r.status_code == 413 and r.json()["code"] == "image_too_large"
    r = client.put("/api/logos/ok", json={"name": "Ok", "image_base64": b64(big)})
    assert r.status_code == 413


def test_blank_or_missing_name(make_client) -> None:
    client = make_client()
    r = client.post("/api/logos", json={"name": "   ", "image_base64": b64(PNG)})
    assert r.status_code == 422 and r.json()["code"] == "invalid_request"
    r = client.post("/api/logos", json={"image_base64": b64(PNG)})
    assert r.status_code == 422


def test_hostile_ids_and_missing_files(make_client, tmp_path: Path) -> None:
    client = make_client()
    add(client, "Ferrari")
    for hostile in ("..%2Fcarrera.sqlite3", "%2e%2e", "A", "a%5Cb", "ferrari.png"):
        assert client.get(f"/api/logos/{hostile}/image").status_code == 404
        if hostile in ("A", "ferrari.png"):
            assert client.get(f"/api/logos/{hostile}/image").json()["code"] == "logo_not_found"
        assert client.put(f"/api/logos/{hostile}", json={"name": "x"}).status_code == 404
        assert client.delete(f"/api/logos/{hostile}").status_code == 404
    # A row whose file vanished has no image.
    (tmp_path / "data" / "logos" / "ferrari.png").unlink()
    r = client.get("/api/logos/ferrari/image")
    assert r.status_code == 404 and r.json()["code"] == "logo_not_found"
    # A file without a row is not served either.
    (tmp_path / "data" / "logos" / "ghost.png").write_bytes(PNG)
    assert client.get("/api/logos/ghost/image").status_code == 404


def test_settings_validate_logo_ids_and_state_carries_them(make_client) -> None:
    client = make_client()
    r = set_car_logo(client, "nope")
    assert r.status_code == 422 and r.json()["code"] == "settings_invalid"
    add(client, "Ferrari")
    assert set_car_logo(client, "ferrari").status_code == 200
    assert set_car_logo(client, None).status_code == 200


def test_deleting_a_logo_clears_it_from_cars(make_client) -> None:
    client = make_client()
    add(client, "Ferrari")
    add(client, "Audi")
    set_car_logo(client, "ferrari", 0)
    set_car_logo(client, "ferrari", 1)
    set_car_logo(client, "audi", 2)
    client.delete("/api/logos/ferrari")
    cars = {c["address"]: c["logo_id"] for c in client.get("/api/settings").json()["cars"]}
    assert cars[0] is None and cars[1] is None and cars[2] == "audi"
    # ...and the saved settings, not just the live ones.
    store = client.app.state.controller.store
    assert [c.logo_id for c in store.load_settings().cars if c.address in (0, 1)] == [None, None]


def test_engine_copies_logo_id_to_car_state(make_client) -> None:
    client = make_client()
    add(client, "Ferrari")
    set_car_logo(client, "ferrari", 0)
    state = client.app.state.controller.engine.state
    assert {c.address: c.logo_id for c in state.cars}[0] == "ferrari"


def test_export_carries_logo_id_and_import_nulls_unknown_ones(make_client) -> None:
    client = make_client()
    add(client, "Ferrari")
    set_car_logo(client, "ferrari", 0)
    bundle = client.post("/api/export", json={"sections": ["settings"]}).json()
    cars = {c["address"]: c for c in bundle["settings"]["cars"]}
    assert cars[0]["logo_id"] == "ferrari"

    # Known id survives a re-import.
    assert client.post("/api/import", json={"bundle": bundle, "mode": "merge"}).status_code == 200
    assert client.get("/api/settings").json()["cars"][0]["logo_id"] == "ferrari"

    # On another machine (no such logo) the id is nulled so the settings stay saveable.
    client.delete("/api/logos/ferrari")
    for car in bundle["settings"]["cars"]:
        if car["address"] == 1:
            car["logo_id"] = "gone"
    bundle["settings"]["cars"][0]["logo_id"] = "ferrari"
    r = client.post("/api/import", json={"bundle": bundle, "mode": "merge"})
    assert r.status_code == 200, r.text
    live = client.get("/api/settings").json()["cars"]
    assert all(c["logo_id"] is None for c in live)
    saved = client.app.state.controller.store.load_settings()
    assert all(c.logo_id is None for c in saved.cars)
    assert client.put("/api/settings", json=client.get("/api/settings").json()).status_code == 200


def test_v4_database_migrates_to_logos(tmp_path: Path) -> None:
    path = tmp_path / "v4.db"
    _make_v1_db(path)
    conn = sqlite3.connect(path)
    conn.execute(
        "CREATE TABLE drivers (id TEXT PRIMARY KEY, name TEXT NOT NULL, json TEXT NOT NULL)"
    )
    conn.execute("UPDATE schema_version SET version = 4")
    conn.commit()
    conn.close()

    store = RaceStore(path)
    try:
        assert store.list_logos() == []
        store.save_logo(Logo(id="ferrari", name="Ferrari", media_type="image/png"))
    finally:
        store.close()
    reopened = RaceStore(path)
    try:
        assert [x.id for x in reopened.list_logos()] == ["ferrari"]
    finally:
        reopened.close()
    conn = sqlite3.connect(path)
    assert conn.execute("SELECT version FROM schema_version").fetchall() == [(SCHEMA_VERSION,)]
    conn.close()


def test_store_logo_crud() -> None:
    store = RaceStore(":memory:")
    try:
        assert store.get_logo("x") is None and store.delete_logo("x") is False
        store.save_logo(Logo(id="b", name="beta", media_type="image/png"))
        store.save_logo(Logo(id="a", name="Zulu", media_type="image/svg+xml"))
        assert [x.id for x in store.list_logos()] == ["b", "a"]  # by name, case-insensitive
        assert store.delete_logo("b") is True
    finally:
        store.close()


_EVIL = '<!DOCTYPE svg [<!ENTITY a "x">]><svg xmlns="http://www.w3.org/2000/svg">&a;</svg>'
_PLAIN = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>'


@pytest.mark.parametrize("codec", ["utf-16", "utf-16-le", "utf-16-be", "utf-32-le"])
@pytest.mark.parametrize("text", [_EVIL, _PLAIN])
def test_non_utf8_svg_is_rejected(codec: str, text: str) -> None:
    assert validate_logo(text.encode(codec)) is None


def test_utf8_bom_is_accepted_and_other_prolog_encodings_are_not() -> None:
    assert validate_logo(b"\xef\xbb\xbf" + _PLAIN.encode()) == "svg"
    latin = '<?xml version="1.0" encoding="ISO-8859-1"?>' + _PLAIN
    assert validate_logo(latin.encode("latin-1")) is None
    utf8 = '<?xml version="1.0" encoding="UTF-8"?>' + _PLAIN
    assert validate_logo(utf8.encode()) == "svg"
    assert validate_logo(_PLAIN.encode().replace(b"<rect", b"<rect\x00")) is None


def test_css_escapes_are_rejected() -> None:
    assert validate_logo(svg("<style>rect{fill:\\75 rl(http://evil/x)}</style>")) is None
