"""Photo -> track layout draft, using an Anthropic vision model.

The browser sends a (downscaled, re-encoded) photo of the track; the model returns the
closed centre line as ~40-60 integer points on a 0..1000 grid. We convert it to fractions
of the FULL image (so the editor can overlay the photo exactly), rotate it so the guessed
start/finish straight comes first, smooth and resample it to ~200 points.

The image and the API key are never logged or stored. No retries: one call, one timeout.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import json
import math
import struct
from typing import Any, Literal

from app.race.models import LayoutDraft, TrackLayout

MAX_IMAGE_BYTES = 8 * 1024 * 1024
TIMEOUT_S = 45.0
OUTPUT_POINTS = 200
MIN_POINTS = 8
MIN_PATH_LENGTH = 0.25  # in image fractions; anything shorter is not a track
GRID = 1000.0
MAX_NOTES = 500
DEFAULT_ASPECT = 1.5

VisionCode = Literal["llm_unavailable", "photo_unrecognised", "image_too_large", "invalid_image"]
MediaType = Literal["image/jpeg", "image/png", "image/webp"]

_LANGUAGE_NAMES = {"en": "English", "it": "Italian"}

PROMPT = (
    "The image is a photo or drawing of a slot car (Carrera) race track. Find the closed "
    "track and trace its CENTRE LINE as a polygon, in driving order.\n"
    "Coordinates: integers on a 0..1000 grid over the WHOLE image, x from 0 (left edge) to "
    "1000 (right edge), y from 0 (top edge) to 1000 (bottom edge), whatever the image "
    "aspect ratio. Use about 40 to 60 points, evenly spread along the track, denser in "
    "tight curves. Do not repeat the first point at the end.\n"
    "Pick the start/finish straight (a marked line, the longest straight, or the control "
    "unit area) and give the index of the point on it as start_index (0 if unknown). If "
    "the driving direction is not visible, guess it and say so in the notes.\n"
    'Reply with ONLY one JSON object, no markdown, in this exact shape: {"found": bool, '
    '"points": [[x, y], ...], "start_index": int, "aspect": width/height of the image as a '
    'number, "notes": "short remarks for the user (guessed direction, hidden parts, '
    'confidence) in {language}"}. If there is no track in the image, reply '
    '{"found": false, "points": [], "start_index": 0, "aspect": 1.5, "notes": "why"}.'
)


class VisionError(Exception):
    """Conversion failed; ``code`` is a stable API error code, ``status`` the HTTP status."""

    def __init__(self, status: int, detail: str, code: VisionCode) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail
        self.code: VisionCode = code


# --------------------------------------------------------------------------- image checks


def decode_image(image_base64: str) -> tuple[bytes, MediaType]:
    """Decode base64, enforce the size limit and sniff the real type from magic bytes."""
    if len(image_base64) > MAX_IMAGE_BYTES * 4 // 3 + 16:
        raise VisionError(413, "Image larger than 8 MB", "image_too_large")
    try:
        data = base64.b64decode(image_base64, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise VisionError(422, "The image is not valid base64", "invalid_image") from exc
    if len(data) > MAX_IMAGE_BYTES:
        raise VisionError(413, "Image larger than 8 MB", "image_too_large")
    if data.startswith(b"\xff\xd8\xff"):
        return data, "image/jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return data, "image/png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return data, "image/webp"
    raise VisionError(422, "Only JPEG, PNG and WebP images are accepted", "invalid_image")


def image_aspect(data: bytes, media_type: MediaType) -> float | None:
    """width / height read from the file header, or None when it cannot be parsed."""
    size = _png_size(data) if media_type == "image/png" else None
    if media_type == "image/jpeg":
        size = _jpeg_size(data)
    elif media_type == "image/webp":
        size = _webp_size(data)
    if size is None or size[0] <= 0 or size[1] <= 0:
        return None
    return size[0] / size[1]


def _png_size(data: bytes) -> tuple[int, int] | None:
    if len(data) < 24 or data[12:16] != b"IHDR":
        return None
    return struct.unpack(">II", data[16:24])  # type: ignore[no-any-return]


def _jpeg_size(data: bytes) -> tuple[int, int] | None:
    i = 2
    while i + 9 < len(data):
        if data[i] != 0xFF:
            i += 1
            continue
        marker = data[i + 1]
        if marker == 0xFF:
            i += 1
            continue
        if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
            i += 2
            continue
        length = struct.unpack(">H", data[i + 2 : i + 4])[0]
        if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
            height, width = struct.unpack(">HH", data[i + 5 : i + 9])
            return width, height
        i += 2 + length
    return None


def _webp_size(data: bytes) -> tuple[int, int] | None:
    chunk = data[12:16]
    if chunk == b"VP8X" and len(data) >= 30:
        width = 1 + int.from_bytes(data[24:27], "little")
        height = 1 + int.from_bytes(data[27:30], "little")
        return width, height
    if chunk == b"VP8L" and len(data) >= 25:
        bits = int.from_bytes(data[21:25], "little")
        return (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
    if chunk == b"VP8 " and len(data) >= 30:
        width, height = struct.unpack("<HH", data[26:30])
        return width & 0x3FFF, height & 0x3FFF
    return None


# --------------------------------------------------------------------------- parsing


def extract_json_object(text: str) -> dict[str, Any] | None:
    """First JSON object in ``text``, even when wrapped in prose or a code fence."""
    decoder = json.JSONDecoder()
    index = text.find("{")
    while index != -1:
        try:
            value, _ = decoder.raw_decode(text, index)
        except ValueError:
            index = text.find("{", index + 1)
            continue
        if isinstance(value, dict):
            return value
        index = text.find("{", index + 1)
    return None


def _num(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    return float(value) if math.isfinite(value) else None


def _parse_points(raw: Any) -> list[tuple[float, float]]:
    """Valid [x, y] pairs as image fractions (0..1). Accepts the 0..1000 grid or 0..1."""
    pairs: list[tuple[float, float]] = []
    if not isinstance(raw, list):
        return pairs
    for item in raw:
        if not isinstance(item, list | tuple) or len(item) != 2:
            continue
        x, y = _num(item[0]), _num(item[1])
        if x is not None and y is not None:
            pairs.append((x, y))
    if not pairs:
        return pairs
    scale = 1.0 if max(max(x, y) for x, y in pairs) <= 1.0 else GRID
    return [(min(1.0, max(0.0, x / scale)), min(1.0, max(0.0, y / scale))) for x, y in pairs]


def _dedupe_closed(points: list[tuple[float, float]]) -> list[tuple[float, float]]:
    out: list[tuple[float, float]] = []
    for point in points:
        if not out or math.dist(point, out[-1]) > 1e-6:
            out.append(point)
    while len(out) > 1 and math.dist(out[0], out[-1]) <= 1e-6:
        out.pop()
    return out


def _closed_length(points: list[tuple[float, float]]) -> float:
    return sum(math.dist(points[i], points[(i + 1) % len(points)]) for i in range(len(points)))


def _densify(points: list[tuple[float, float]], steps: int = 8) -> list[tuple[float, float]]:
    """Closed Catmull-Rom spline through the points, ``steps`` samples per segment."""
    n = len(points)
    out: list[tuple[float, float]] = []
    for i in range(n):
        p0, p1, p2, p3 = (points[(i + k) % n] for k in (-1, 0, 1, 2))
        for step in range(steps):
            t = step / steps
            t2, t3 = t * t, t * t * t
            out.append(
                tuple(  # type: ignore[arg-type]
                    0.5
                    * (
                        2 * p1[a]
                        + (-p0[a] + p2[a]) * t
                        + (2 * p0[a] - 5 * p1[a] + 4 * p2[a] - p3[a]) * t2
                        + (-p0[a] + 3 * p1[a] - 3 * p2[a] + p3[a]) * t3
                    )
                    for a in (0, 1)
                )
            )
    return out


def _resample_closed(points: list[tuple[float, float]], count: int) -> list[tuple[float, float]]:
    n = len(points)
    cumulative = [0.0]
    for i in range(n):
        cumulative.append(cumulative[-1] + math.dist(points[i], points[(i + 1) % n]))
    total = cumulative[-1]
    out: list[tuple[float, float]] = []
    seg = 0
    for k in range(count):
        target = total * k / count
        while seg < n - 1 and cumulative[seg + 1] < target:
            seg += 1
        span = cumulative[seg + 1] - cumulative[seg]
        f = (target - cumulative[seg]) / span if span > 0 else 0.0
        a, b = points[seg], points[(seg + 1) % n]
        out.append((a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f))
    return out


def build_draft(reply: str, *, name: str, aspect: float | None) -> LayoutDraft:
    """Turn the model's text reply into a draft; raises VisionError(photo_unrecognised)."""
    data = extract_json_object(reply)
    if data is None:
        raise VisionError(422, "The model reply had no JSON object", "photo_unrecognised")
    notes = data.get("notes")
    notes = notes.strip()[:MAX_NOTES] if isinstance(notes, str) else ""
    if data.get("found") is not True:
        raise VisionError(422, notes or "No closed track found in the photo", "photo_unrecognised")
    points = _dedupe_closed(_parse_points(data.get("points")))
    if len(points) < MIN_POINTS or _closed_length(points) < MIN_PATH_LENGTH:
        raise VisionError(422, "The traced track is too short or too coarse", "photo_unrecognised")
    start = data.get("start_index")
    start_index = start if isinstance(start, int) and not isinstance(start, bool) else 0
    if not 0 <= start_index < len(points):
        start_index = 0
    rotated = points[start_index:] + points[:start_index]
    resampled = _resample_closed(_densify(rotated), OUTPUT_POINTS)
    clamped = [(min(1.0, max(0.0, x)), min(1.0, max(0.0, y))) for x, y in resampled]
    if aspect is None:
        model_aspect = _num(data.get("aspect"))
        aspect = model_aspect if model_aspect is not None else DEFAULT_ASPECT
    aspect = min(9.9, max(0.11, aspect))
    layout = TrackLayout(name=name, points=clamped, aspect=aspect, source="photo")
    return LayoutDraft(layout=layout, notes=notes)


# --------------------------------------------------------------------------- API call


async def _ask(client: Any, model: str, messages: list[dict[str, Any]]) -> Any:
    """One Messages call. Newer models (Opus) want adaptive thinking with a low effort;
    older ones (Haiku) want thinking disabled: on a 400 the other form is tried once."""
    try:
        return await client.messages.create(
            model=model,
            max_tokens=6000,
            thinking={"type": "adaptive"},
            output_config={"effort": "low"},
            messages=messages,
        )
    except Exception as exc:  # noqa: BLE001 - only a 400 about the thinking form is retried
        if getattr(exc, "status_code", None) != 400 or "thinking" not in str(exc).lower():
            raise
    return await client.messages.create(
        model=model,
        max_tokens=4000,
        thinking={"type": "disabled"},
        messages=messages,
    )


async def layout_from_photo(
    *,
    api_key: str | None,
    model: str,
    image_base64: str,
    name: str,
    language: str,
    client: Any | None = None,
    timeout_s: float = TIMEOUT_S,
) -> LayoutDraft:
    """Validate the image, ask the vision model for the centre line and build the draft."""
    if client is None and not api_key:
        raise VisionError(503, "No Anthropic API key configured", "llm_unavailable")
    data, media_type = decode_image(image_base64)
    aspect = image_aspect(data, media_type)
    if client is None:
        from anthropic import AsyncAnthropic

        client = AsyncAnthropic(api_key=api_key, timeout=timeout_s, max_retries=0)
    prompt = PROMPT.replace("{language}", _LANGUAGE_NAMES.get(language, "English"))
    messages = [
        {
            "role": "user",
            "content": [
                {
                    "type": "image",
                    "source": {"type": "base64", "media_type": media_type, "data": image_base64},
                },
                {"type": "text", "text": prompt},
            ],
        }
    ]
    try:
        response = await asyncio.wait_for(_ask(client, model, messages), timeout=timeout_s)
    except asyncio.CancelledError:
        raise
    except TimeoutError as exc:
        raise VisionError(503, "The vision model timed out", "llm_unavailable") from exc
    except Exception as exc:  # noqa: BLE001 - map every SDK failure to an API error code
        status = getattr(exc, "status_code", None)
        if status in (401, 403, 404):
            raise VisionError(
                503, f"Vision model unavailable (HTTP {status})", "llm_unavailable"
            ) from exc
        detail = f"Vision call failed: {type(exc).__name__}" + (
            f" (HTTP {status})" if status else ""
        )
        # The service is down, slow or throttling (no status = connection error): retrying
        # the photo will not help, so this is "unavailable", not "unrecognised".
        if status is None or status == 429 or status >= 500:
            raise VisionError(503, detail, "llm_unavailable") from exc
        raise VisionError(422, detail, "photo_unrecognised") from exc
    text = "".join(
        getattr(block, "text", "") or ""
        for block in getattr(response, "content", [])
        if getattr(block, "type", None) == "text"
    )
    return build_draft(text, name=name, aspect=aspect)
