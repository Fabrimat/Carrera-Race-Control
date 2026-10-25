"""Speech-to-text for "who is driving?": a spoken name becomes text and a roster guess.

ElevenLabs Scribe is the default; OpenAI ``gpt-4o-transcribe`` is used when OpenAI is the
selected provider and its key exists. Neither the audio nor an API key is ever logged.
Errors are :class:`TranscriptionError` with a stable code the UI translates:
``llm_unavailable`` (no key, key rejected, provider down / throttling) or
``transcription_failed`` (the audio could not be turned into text).
"""

from __future__ import annotations

import difflib
import logging
import re
import unicodedata
from collections.abc import Iterable
from typing import Any, Literal, Protocol

import httpx

from app.race.models import Driver

log = logging.getLogger(__name__)

ELEVENLABS_STT_URL = "https://api.elevenlabs.io/v1/speech-to-text"
ELEVENLABS_STT_MODEL = "scribe_v1"
OPENAI_STT_MODEL = "gpt-4o-transcribe"
TIMEOUT_S = 20.0
MATCH_THRESHOLD = 0.6
MAX_AUDIO_BYTES = 2 * 1024 * 1024

# Browsers add parameters ("audio/webm;codecs=opus"): only the base type is compared.
AUDIO_TYPES = {
    "audio/webm": "webm",
    "audio/ogg": "ogg",
    "audio/mp4": "mp4",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/wave": "wav",
}


class TranscriptionError(Exception):
    def __init__(
        self, code: Literal["llm_unavailable", "transcription_failed"], detail: str, status: int
    ) -> None:
        super().__init__(detail)
        self.code = code
        self.detail = detail
        self.status = status


def unavailable(detail: str) -> TranscriptionError:
    return TranscriptionError("llm_unavailable", detail, 503)


def failed(detail: str) -> TranscriptionError:
    return TranscriptionError("transcription_failed", detail, 422)


def base_media_type(media_type: str) -> str:
    return media_type.split(";", 1)[0].strip().lower()


def audio_extension(media_type: str) -> str | None:
    return AUDIO_TYPES.get(base_media_type(media_type))


class Transcriber(Protocol):
    async def transcribe(self, audio: bytes, media_type: str, language: str) -> str:
        """Return the spoken text. Raises :class:`TranscriptionError`."""
        ...


def _status_error(status: int) -> TranscriptionError:
    if status in (401, 403, 404):
        return unavailable(f"The speech-to-text provider refused the request (HTTP {status})")
    if status == 429 or status >= 500:
        return unavailable(f"The speech-to-text provider is busy or failing (HTTP {status})")
    return failed(f"The speech-to-text provider could not read the audio (HTTP {status})")


class ElevenLabsTranscriber:
    def __init__(
        self,
        api_key: str,
        model: str = ELEVENLABS_STT_MODEL,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self._api_key = api_key
        self.model = model
        self._client = client

    async def transcribe(self, audio: bytes, media_type: str, language: str) -> str:
        ext = audio_extension(media_type) or "webm"
        client = self._client or httpx.AsyncClient(timeout=TIMEOUT_S)
        try:
            response = await client.post(
                ELEVENLABS_STT_URL,
                headers={"xi-api-key": self._api_key},
                data={"model_id": self.model, "language_code": language},
                files={"file": (f"speech.{ext}", audio, base_media_type(media_type))},
            )
        except httpx.HTTPError as exc:
            # The exception text can carry the URL only; never headers, still log just the type.
            log.warning("ElevenLabs speech-to-text unreachable (%s)", type(exc).__name__)
            raise unavailable("The speech-to-text provider is unreachable") from exc
        finally:
            if self._client is None:
                await client.aclose()
        if response.status_code != 200:
            log.warning("ElevenLabs speech-to-text failed (HTTP %s)", response.status_code)
            raise _status_error(response.status_code)
        try:
            text = response.json().get("text", "")
        except (ValueError, AttributeError) as exc:
            raise failed("Unreadable speech-to-text answer") from exc
        return text.strip() if isinstance(text, str) else ""


class OpenAITranscriber:
    def __init__(
        self, api_key: str, model: str = OPENAI_STT_MODEL, client: Any | None = None
    ) -> None:
        self.model = model
        if client is not None:
            self._client = client
        else:
            from openai import AsyncOpenAI

            self._client = AsyncOpenAI(api_key=api_key, timeout=TIMEOUT_S, max_retries=0)

    async def transcribe(self, audio: bytes, media_type: str, language: str) -> str:
        ext = audio_extension(media_type) or "webm"
        try:
            result = await self._client.audio.transcriptions.create(
                model=self.model,
                file=(f"speech.{ext}", audio, base_media_type(media_type)),
                language=language,
            )
        except Exception as exc:  # noqa: BLE001 - mapped to a stable code below
            status = getattr(exc, "status_code", None)
            log.warning("OpenAI speech-to-text failed (%s)", status or type(exc).__name__)
            if isinstance(status, int):
                raise _status_error(status) from exc
            raise unavailable("The speech-to-text provider is unreachable") from exc
        text = getattr(result, "text", "")
        return text.strip() if isinstance(text, str) else ""


# --------------------------------------------------------------------------- name matching


def normalise(text: str) -> str:
    """Lower-case, accent-free, letters and digits only (words separated by one space)."""
    folded = unicodedata.normalize("NFKD", text.casefold())
    stripped = "".join(ch for ch in folded if not unicodedata.combining(ch))
    return re.sub(r"[^a-z0-9]+", " ", stripped).strip()


def guess_driver(text: str, drivers: Iterable[Driver]) -> str | None:
    """Id of the roster driver whose name or nickname best matches ``text``, else None.

    The whole text and each of its words are compared with each driver's name, nickname and
    their single words (so "Anna" finds "Anna Rossi"); the best similarity must reach
    :data:`MATCH_THRESHOLD`.
    """
    spoken = normalise(text)
    if not spoken:
        return None
    heard = {spoken, *spoken.split()}
    best_id: str | None = None
    best_score = 0.0
    for driver in drivers:
        names: set[str] = set()
        for label in (driver.name, driver.nickname or ""):
            norm = normalise(label)
            if norm:
                names.add(norm)
                names.update(norm.split())
        for name in names:
            for word in heard:
                score = difflib.SequenceMatcher(None, word, name).ratio()
                if score > best_score:
                    best_score, best_id = score, driver.id
    return best_id if best_score >= MATCH_THRESHOLD else None
