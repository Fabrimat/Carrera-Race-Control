"""Text-to-speech: ElevenLabs streaming client with disk cache, plus the char budget.

Nothing here raises into the caller: errors are logged once, the client is marked
degraded (`available` is False) and `stream()` simply yields nothing.
"""

from __future__ import annotations

import hashlib
import logging
import os
import time
from collections.abc import AsyncIterator, Callable
from pathlib import Path
from typing import Any, Protocol, runtime_checkable

log = logging.getLogger(__name__)

# Flash v2.5: ElevenLabs' lowest-latency multilingual model (supports Italian and English).
# Id confirmed in the installed SDK: elevenlabs/types/text_to_speech_generation_request.py
# (Literal["eleven_flash_v2_5"]) and elevenlabs/types/tts_conversational_model.py.
DEFAULT_MODEL_ID = "eleven_flash_v2_5"
OUTPUT_FORMAT = "mp3_44100_128"
# 128 kbit/s -> bytes per second of audio, used to compute the real duration of a clip.
MP3_BYTES_PER_SECOND = 16_000

RATE_LIMIT_BACKOFF_S = 60.0
ERROR_BACKOFF_S = 15.0
_CACHE_CHUNK = 16 * 1024


@runtime_checkable
class TTSClient(Protocol):
    @property
    def available(self) -> bool: ...

    def is_cached(self, text: str, *, voice_id: str | None = None) -> bool:
        """True if `stream(text, cacheable=True)` would be served from disk (free)."""
        ...

    def stream(
        self, text: str, *, cacheable: bool = False, voice_id: str | None = None
    ) -> AsyncIterator[bytes]:
        """Yield mp3 chunks. Never raises: on failure it just ends (possibly empty)."""
        ...


class BudgetTracker:
    """Character budget per session and per month. A limit of 0 means no TTS at all."""

    def __init__(
        self,
        session_limit: int,
        monthly_limit: int,
        get_monthly: Callable[[], int],
        add_monthly: Callable[[int], None],
    ) -> None:
        self.session_limit = session_limit
        self.monthly_limit = monthly_limit
        self._get_monthly = get_monthly
        self._add_monthly = add_monthly
        self.session_used = 0

    def update_limits(self, session_limit: int, monthly_limit: int) -> None:
        self.session_limit = session_limit
        self.monthly_limit = monthly_limit

    def reset_session(self) -> None:
        self.session_used = 0

    @property
    def monthly_used(self) -> int:
        try:
            return self._get_monthly()
        except Exception:  # noqa: BLE001
            log.exception("could not read the monthly TTS counter")
            return 0

    def can_afford(self, chars: int) -> bool:
        return (
            self.session_used + chars <= self.session_limit
            and self.monthly_used + chars <= self.monthly_limit
        )

    def consume(self, chars: int) -> bool:
        """Count `chars` before calling the API. False (and nothing counted) if over budget."""
        if not self.can_afford(chars):
            return False
        self.session_used += chars
        try:
            self._add_monthly(chars)
        except Exception:  # noqa: BLE001
            log.exception("could not update the monthly TTS counter")
        return True


def cache_key(model_id: str, voice_id: str, text: str) -> str:
    return hashlib.sha256(f"{model_id}|{voice_id}|{text}".encode()).hexdigest()


class ElevenLabsTTS:
    def __init__(
        self,
        api_key: str | None,
        voice_id: str | None,
        model_id: str = DEFAULT_MODEL_ID,
        cache_dir: str | Path | None = None,
        language_code: str | None = None,
        client: Any | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.voice_id = voice_id
        self.model_id = model_id
        self.language_code = language_code
        self.cache_dir = Path(cache_dir) if cache_dir else None
        self._clock = clock
        self._disabled_reason: str | None = None  # permanent (missing/invalid key)
        self._backoff_until = 0.0
        self._logged: set[str] = set()
        self._client: Any | None = None
        if not api_key and client is None:
            self._mark_permanent("missing ElevenLabs API key")
        elif client is not None:
            self._client = client
        else:
            from elevenlabs import AsyncElevenLabs

            self._client = AsyncElevenLabs(api_key=api_key)

    # ------------------------------------------------------------------ state

    @property
    def available(self) -> bool:
        return self._disabled_reason is None and self._clock() >= self._backoff_until

    def _log_once(self, key: str, message: str) -> None:
        if key not in self._logged:
            self._logged.add(key)
            log.warning(message)

    def _mark_permanent(self, reason: str) -> None:
        self._disabled_reason = reason
        self._log_once(reason, f"TTS disabled: {reason}")

    def _handle_error(self, exc: Exception) -> None:
        status = getattr(exc, "status_code", None)
        if status in (401, 403):
            self._mark_permanent(f"ElevenLabs rejected the API key (HTTP {status})")
        elif status == 429:
            self._backoff_until = self._clock() + RATE_LIMIT_BACKOFF_S
            self._log_once("429", "ElevenLabs rate limit (429), backing off")
        else:
            self._backoff_until = self._clock() + ERROR_BACKOFF_S
            self._log_once(
                f"err:{type(exc).__name__}",
                f"ElevenLabs TTS error ({type(exc).__name__}), text only for a while",
            )

    # ------------------------------------------------------------------ cache

    def _path(self, text: str, voice_id: str | None) -> Path | None:
        voice = voice_id or self.voice_id
        if self.cache_dir is None or not voice:
            return None
        return self.cache_dir / f"{cache_key(self.model_id, voice, text)}.mp3"

    def is_cached(self, text: str, *, voice_id: str | None = None) -> bool:
        path = self._path(text, voice_id)
        return path is not None and path.is_file()

    # ------------------------------------------------------------------ streaming

    async def stream(
        self, text: str, *, cacheable: bool = False, voice_id: str | None = None
    ) -> AsyncIterator[bytes]:
        path = self._path(text, voice_id) if cacheable else None
        if path is not None and path.is_file():
            try:
                data = path.read_bytes()
            except OSError:
                data = b""
            for i in range(0, len(data), _CACHE_CHUNK):
                yield data[i : i + _CACHE_CHUNK]
            if data:
                return
        voice = voice_id or self.voice_id
        if not self.available or not voice or self._client is None:
            if not voice and self._disabled_reason is None:
                self._log_once("novoice", "TTS disabled: no ElevenLabs voice id configured")
            return
        collected: list[bytes] = []
        complete = False
        try:
            kwargs: dict[str, Any] = {
                "text": text,
                "model_id": self.model_id,
                "output_format": OUTPUT_FORMAT,
            }
            if self.language_code:
                kwargs["language_code"] = self.language_code
            async for chunk in self._client.text_to_speech.stream(voice, **kwargs):
                if chunk:
                    collected.append(chunk)
                    yield chunk
            complete = True
        except GeneratorExit:
            raise
        except Exception as exc:  # noqa: BLE001 - TTS must never break the director
            self._handle_error(exc)
            return
        if complete and path is not None and collected:
            self._write_cache(path, b"".join(collected))

    def _write_cache(self, path: Path, data: bytes) -> None:
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(f".{os.getpid()}.tmp")
            tmp.write_bytes(data)
            tmp.replace(path)
        except OSError:
            self._log_once("cache-write", "could not write the TTS cache")
