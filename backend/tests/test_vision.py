"""Photo -> layout draft (fake Anthropic client, no network)."""

from __future__ import annotations

import base64
import json
import math
import struct
import zlib
from types import SimpleNamespace
from typing import Any

import pytest

from app.track.vision import (
    MAX_IMAGE_BYTES,
    VisionError,
    build_draft,
    decode_image,
    extract_json_object,
    image_aspect,
    layout_from_photo,
)


def make_png(width: int = 120, height: int = 80) -> bytes:
    """A tiny valid PNG (white image with a black rectangle outline), stdlib only."""
    rows = bytearray()
    for y in range(height):
        rows.append(0)
        for x in range(width):
            edge = (x in (10, width - 11) and 10 <= y <= height - 11) or (
                y in (10, height - 11) and 10 <= x <= width - 11
            )
            rows += b"\x00\x00\x00" if edge else b"\xff\xff\xff"

    def chunk(kind: bytes, body: bytes) -> bytes:
        crc = zlib.crc32(kind + body) & 0xFFFFFFFF
        return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", crc)

    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(bytes(rows)))
        + chunk(b"IEND", b"")
    )


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


def oval(count: int = 48) -> list[list[int]]:
    return [
        [
            round(500 + 400 * math.cos(2 * math.pi * i / count)),
            round(500 + 250 * math.sin(2 * math.pi * i / count)),
        ]
        for i in range(count)
    ]


def reply(**overrides: Any) -> str:
    body = {"found": True, "points": oval(), "start_index": 0, "aspect": 1.5, "notes": "ok"}
    body.update(overrides)
    return json.dumps(body)


class FakeMessages:
    def __init__(self, text: str | None = None, error: Exception | None = None) -> None:
        self.text = text
        self.error = error
        self.calls: list[dict[str, Any]] = []

    async def create(self, **kwargs: Any) -> Any:
        self.calls.append(kwargs)
        if self.error is not None:
            raise self.error
        return SimpleNamespace(content=[SimpleNamespace(type="text", text=self.text)])


def fake_client(text: str | None = None, error: Exception | None = None) -> Any:
    return SimpleNamespace(messages=FakeMessages(text, error))


class ThinkingError(Exception):
    def __init__(self, status_code: int) -> None:
        super().__init__('"thinking.type.disabled" is not supported for this model')
        self.status_code = status_code


class ApiError(Exception):
    def __init__(self, status_code: int) -> None:
        super().__init__("api error")
        self.status_code = status_code


# --------------------------------------------------------------------------- image checks


def test_decode_image_sniffs_type_and_aspect() -> None:
    data, media = decode_image(b64(make_png(120, 80)))
    assert media == "image/png"
    assert image_aspect(data, media) == pytest.approx(1.5)


def test_decode_image_rejects_unknown_magic_and_bad_base64() -> None:
    with pytest.raises(VisionError) as info:
        decode_image(b64(b"GIF89a-not-allowed"))
    assert info.value.code == "invalid_image"
    with pytest.raises(VisionError) as info:
        decode_image("not base64 !!!")
    assert info.value.code == "invalid_image"


def test_decode_image_size_limit() -> None:
    big = b"\x89PNG\r\n\x1a\n" + b"\0" * (MAX_IMAGE_BYTES + 1)
    with pytest.raises(VisionError) as info:
        decode_image(b64(big))
    assert info.value.code == "image_too_large"
    assert info.value.status == 413


def test_jpeg_and_webp_headers() -> None:
    sof = (
        b"\xff\xc0\x00\x11\x08" + struct.pack(">HH", 400, 300) + b"\x03" + b"\0" * 9
    )  # height, width
    jpeg = b"\xff\xd8\xff\xe0\x00\x04\x00\x00" + sof
    assert image_aspect(jpeg, "image/jpeg") == pytest.approx(0.75)
    webp = (
        b"RIFF\0\0\0\0WEBPVP8X"
        + b"\0" * 8
        + (199).to_bytes(3, "little")
        + (99).to_bytes(3, "little")
    )
    assert image_aspect(webp, "image/webp") == pytest.approx(2.0)
    assert image_aspect(b"\xff\xd8\xff", "image/jpeg") is None


# --------------------------------------------------------------------------- parsing


def test_extract_json_object_from_wrapped_text() -> None:
    assert extract_json_object('Sure!\n```json\n{"a": {"b": 1}}\n```\nbye') == {"a": {"b": 1}}
    assert extract_json_object("no json {broken") is None
    assert extract_json_object("[1, 2]") is None


def test_build_draft_resamples_and_keeps_image_fractions() -> None:
    draft = build_draft(reply(), name="Oval", aspect=1.5)
    layout = draft.layout
    assert layout.source == "photo"
    assert layout.name == "Oval"
    assert layout.aspect == pytest.approx(1.5)
    assert len(layout.points) == 200
    assert layout.points[0] == pytest.approx((0.9, 0.5), abs=0.01)
    xs = [x for x, _ in layout.points]
    ys = [y for _, y in layout.points]
    # Not renormalised to the bbox: the oval spans 0.1..0.9 x 0.25..0.75 of the image.
    assert min(xs) == pytest.approx(0.1, abs=0.02) and max(xs) == pytest.approx(0.9, abs=0.02)
    assert min(ys) == pytest.approx(0.25, abs=0.02) and max(ys) == pytest.approx(0.75, abs=0.02)
    assert all(0 <= v <= 1 for v in xs + ys)
    assert draft.notes == "ok"


def test_build_draft_rotates_to_start_index() -> None:
    draft = build_draft(reply(start_index=12), name="Oval", aspect=1.5)
    # Point 12 of 48 on the oval is at the top (angle 90 deg): x=0.5, y=0.75 (y down grid).
    assert draft.layout.points[0] == pytest.approx((0.5, 0.75), abs=0.01)


def test_bad_start_index_falls_back_to_zero() -> None:
    draft = build_draft(reply(start_index=999), name="Oval", aspect=1.5)
    assert draft.layout.points[0] == pytest.approx((0.9, 0.5), abs=0.01)


def test_model_aspect_used_only_when_image_aspect_unknown() -> None:
    assert build_draft(reply(aspect=2.0), name="n", aspect=None).layout.aspect == 2.0
    assert build_draft(reply(aspect=2.0), name="n", aspect=1.0).layout.aspect == 1.0


def test_unit_fractions_are_accepted_too() -> None:
    points = [[x / 1000, y / 1000] for x, y in oval()]
    draft = build_draft(reply(points=points), name="n", aspect=1.0)
    assert draft.layout.points[0] == pytest.approx((0.9, 0.5), abs=0.01)


@pytest.mark.parametrize(
    "text",
    [
        "I cannot see a track",
        reply(found=False, points=[], notes="just a cat"),
        reply(points=oval()[:5]),
        reply(points=[[500, 500]] * 20),
        reply(points="nope"),
        reply(points=[[1, 2, 3]] * 20),
    ],
)
def test_unrecognised_photos(text: str) -> None:
    with pytest.raises(VisionError) as info:
        build_draft(text, name="n", aspect=1.0)
    assert (info.value.status, info.value.code) == (422, "photo_unrecognised")


def test_found_false_surfaces_the_model_notes() -> None:
    with pytest.raises(VisionError) as info:
        build_draft(reply(found=False, notes="just a cat"), name="n", aspect=1.0)
    assert "just a cat" in info.value.detail


# --------------------------------------------------------------------------- API call


async def test_layout_from_photo_builds_the_request() -> None:
    client = fake_client("Here you go: " + reply())
    draft = await layout_from_photo(
        api_key="k",
        model="vision-model",
        image_base64=b64(make_png(120, 80)),
        name="Oval",
        language="it",
        client=client,
    )
    assert draft.layout.aspect == pytest.approx(1.5)
    call = client.messages.calls[0]
    assert call["model"] == "vision-model"
    assert call["thinking"] == {"type": "adaptive"}
    assert call["output_config"] == {"effort": "low"}
    image, text = call["messages"][0]["content"]
    assert image["type"] == "image"
    assert image["source"]["media_type"] == "image/png"
    assert "Italian" in text["text"]


async def test_no_key_is_llm_unavailable() -> None:
    with pytest.raises(VisionError) as info:
        await layout_from_photo(
            api_key=None,
            model="m",
            image_base64=b64(make_png()),
            name="n",
            language="en",
        )
    assert (info.value.status, info.value.code) == (503, "llm_unavailable")


@pytest.mark.parametrize("status", [401, 403, 404])
async def test_auth_and_model_errors_are_llm_unavailable(status: int) -> None:
    with pytest.raises(VisionError) as info:
        await layout_from_photo(
            api_key="k",
            model="m",
            image_base64=b64(make_png()),
            name="n",
            language="en",
            client=fake_client(error=ApiError(status)),
        )
    assert (info.value.status, info.value.code) == (503, "llm_unavailable")


@pytest.mark.parametrize("status", [429, 500, 529])
async def test_throttling_and_server_errors_are_llm_unavailable(status: int) -> None:
    with pytest.raises(VisionError) as info:
        await layout_from_photo(
            api_key="k",
            model="m",
            image_base64=b64(make_png()),
            name="n",
            language="en",
            client=fake_client(error=ApiError(status)),
        )
    assert (info.value.status, info.value.code) == (503, "llm_unavailable")


async def test_connection_error_is_llm_unavailable() -> None:
    with pytest.raises(VisionError) as info:
        await layout_from_photo(
            api_key="k",
            model="m",
            image_base64=b64(make_png()),
            name="n",
            language="en",
            client=fake_client(error=ConnectionError("down")),
        )
    assert (info.value.status, info.value.code) == (503, "llm_unavailable")


async def test_other_api_errors_are_photo_unrecognised_without_leaking() -> None:
    with pytest.raises(VisionError) as info:
        await layout_from_photo(
            api_key="sk-secret",
            model="m",
            image_base64=b64(make_png()),
            name="n",
            language="en",
            client=fake_client(error=ApiError(400)),
        )
    assert (info.value.status, info.value.code) == (422, "photo_unrecognised")
    assert "ApiError" in info.value.detail and "sk-secret" not in info.value.detail


async def test_timeout_is_llm_unavailable() -> None:
    with pytest.raises(VisionError) as info:
        await layout_from_photo(
            api_key="k",
            model="m",
            image_base64=b64(make_png()),
            name="n",
            language="en",
            client=fake_client(error=TimeoutError()),
        )
    assert (info.value.status, info.value.code) == (503, "llm_unavailable")


async def test_invalid_image_is_checked_before_any_call() -> None:
    client = fake_client(reply())
    with pytest.raises(VisionError) as info:
        await layout_from_photo(
            api_key="k",
            model="m",
            image_base64=b64(b"hello"),
            name="n",
            language="en",
            client=client,
        )
    assert info.value.code == "invalid_image"
    assert client.messages.calls == []


async def test_400_on_thinking_form_retries_once_with_the_other_form() -> None:
    class Flaky(FakeMessages):
        async def create(self, **kwargs: Any) -> Any:
            if "output_config" in kwargs:
                self.calls.append(kwargs)
                raise ThinkingError(400)
            return await super().create(**kwargs)

    client = SimpleNamespace(messages=Flaky(reply()))
    draft = await layout_from_photo(
        api_key="k",
        model="m",
        image_base64=b64(make_png()),
        name="n",
        language="en",
        client=client,
    )
    assert len(draft.layout.points) == 200
    assert [c["thinking"]["type"] for c in client.messages.calls] == ["adaptive", "disabled"]


async def test_400_not_about_thinking_is_not_retried() -> None:
    class Rejecting(FakeMessages):
        async def create(self, **kwargs: Any) -> Any:
            self.calls.append(kwargs)
            raise ApiError(400)  # message is "api error": nothing about thinking

    client = SimpleNamespace(messages=Rejecting())
    with pytest.raises(VisionError) as info:
        await layout_from_photo(
            api_key="k",
            model="m",
            image_base64=b64(make_png()),
            name="n",
            language="en",
            client=client,
        )
    assert info.value.code == "photo_unrecognised"
    assert len(client.messages.calls) == 1


# --------------------------------------------------------------------------- OpenAI


class FakeResponses:
    def __init__(self, text: str | None, error: Exception | None) -> None:
        self.text = text
        self.error = error
        self.calls: list[dict[str, Any]] = []

    async def create(self, **kwargs: Any) -> Any:
        self.calls.append(kwargs)
        if self.error is not None:
            raise self.error
        block = SimpleNamespace(type="output_text", text=self.text)
        return SimpleNamespace(output=[SimpleNamespace(type="message", content=[block])])


def fake_openai(text: str | None = None, error: Exception | None = None) -> Any:
    return SimpleNamespace(responses=FakeResponses(text, error))


async def test_openai_request_is_a_data_url_image_plus_the_same_prompt() -> None:
    client = fake_openai("Here you go: " + reply())
    image_b64 = b64(make_png(120, 80))
    draft = await layout_from_photo(
        api_key="k",
        model="vision-model",
        image_base64=image_b64,
        name="Oval",
        language="it",
        client=client,
        provider="openai",
    )
    assert draft.layout.aspect == pytest.approx(1.5)
    assert len(draft.layout.points) == 200
    call = client.responses.calls[0]
    assert call["model"] == "vision-model"
    assert call["store"] is False
    text, image = call["input"][0]["content"]
    assert image["type"] == "input_image"
    assert image["image_url"] == f"data:image/png;base64,{image_b64}"
    assert text["type"] == "input_text" and "Italian" in text["text"]
    assert "0..1000 grid" in text["text"]


async def test_openai_no_key_is_llm_unavailable() -> None:
    with pytest.raises(VisionError) as info:
        await layout_from_photo(
            api_key=None,
            model="m",
            image_base64=b64(make_png()),
            name="n",
            language="en",
            provider="openai",
        )
    assert (info.value.status, info.value.code) == (503, "llm_unavailable")
    assert "OpenAI" in info.value.detail


@pytest.mark.parametrize(
    ("status", "code"),
    [
        (401, "llm_unavailable"),
        (403, "llm_unavailable"),
        (404, "llm_unavailable"),
        (429, "llm_unavailable"),
        (500, "llm_unavailable"),
        (None, "llm_unavailable"),
        (400, "photo_unrecognised"),
    ],
)
async def test_openai_errors_map_like_anthropic(status: int | None, code: str) -> None:
    error = ApiError(status) if status else ConnectionError("down")
    with pytest.raises(VisionError) as info:
        await layout_from_photo(
            api_key="k",
            model="m",
            image_base64=b64(make_png()),
            name="n",
            language="en",
            client=fake_openai(error=error),
            provider="openai",
        )
    assert info.value.code == code


async def test_openai_unusable_reply_is_photo_unrecognised() -> None:
    with pytest.raises(VisionError) as info:
        await layout_from_photo(
            api_key="k",
            model="m",
            image_base64=b64(make_png()),
            name="n",
            language="en",
            client=fake_openai("sorry, no json"),
            provider="openai",
        )
    assert info.value.code == "photo_unrecognised"
