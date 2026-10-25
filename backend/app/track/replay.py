"""Raw-poll recording and replay (JSONL) for hardware sessions and tests.

File format, one JSON object per line::

    {"t": 1.234, "kind": "timer", "address": 0, "timestamp": 123456, "sector": 1}
    {"t": 1.300, "kind": "status", "fuel": [15, ...], "start": 0, "mode": 5,
     "pit": [false, ...], "display": 6}

``t`` is monotonic seconds since the recording started.
"""

from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path
from typing import IO, Any

from app.track.base import (
    PollResult,
    Status,
    Timer,
    TrackConnectionError,
    TrackDisconnected,
    TrackInterface,
)


def message_to_record(t: float, msg: PollResult) -> dict[str, Any]:
    if isinstance(msg, Timer):
        return {
            "t": round(t, 4),
            "kind": "timer",
            "address": msg.address,
            "timestamp": msg.timestamp,
            "sector": msg.sector,
        }
    return {
        "t": round(t, 4),
        "kind": "status",
        "fuel": list(msg.fuel),
        "start": msg.start,
        "mode": msg.mode,
        "pit": list(msg.pit),
        "display": msg.display,
    }


def record_to_message(rec: dict[str, Any]) -> PollResult:
    if rec["kind"] == "timer":
        return Timer(
            address=int(rec["address"]),
            timestamp=int(rec["timestamp"]),
            sector=int(rec.get("sector", 1)),
        )
    if rec["kind"] == "status":
        return Status(
            fuel=tuple(int(f) for f in rec["fuel"]),
            start=int(rec["start"]),
            mode=int(rec["mode"]),
            pit=tuple(bool(p) for p in rec["pit"]),
            display=int(rec.get("display", 6)),
        )
    raise ValueError(f"unknown record kind: {rec['kind']!r}")


class RecordingTrack:
    """Wraps a TrackInterface and appends every polled message to a JSONL file."""

    def __init__(self, inner: TrackInterface, path: str | Path) -> None:
        self._inner = inner
        self._path = Path(path)
        self._file: IO[str] | None = None
        self._t0: float | None = None

    @property
    def connected(self) -> bool:
        return self._inner.connected

    def _ensure_file(self) -> IO[str]:
        if self._file is None:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            self._file = self._path.open("a", encoding="utf-8")
            self._t0 = time.monotonic()
        return self._file

    async def connect(self) -> None:
        await self._inner.connect()
        self._ensure_file()

    async def poll(self) -> PollResult:
        msg = await self._inner.poll()
        f = self._ensure_file()
        assert self._t0 is not None
        f.write(json.dumps(message_to_record(time.monotonic() - self._t0, msg)) + "\n")
        f.flush()
        return msg

    async def start(self) -> None:
        await self._inner.start()

    async def toggle_pace_car(self) -> None:
        await self._inner.toggle_pace_car()

    async def reset_timer(self) -> None:
        await self._inner.reset_timer()

    async def close(self) -> None:
        try:
            await self._inner.close()
        finally:
            if self._file is not None:
                self._file.close()
                self._file = None


class ReplayTrack:
    """Replays a recorded JSONL session with its original timing scaled by ``speed``.

    ``speed=0`` replays as fast as possible. At end of file ``poll()`` raises
    :class:`TrackDisconnected` (or restarts from the top when ``loop=True``).
    Commands are accepted and ignored.
    """

    def __init__(self, path: str | Path, speed: float = 1.0, loop: bool = False) -> None:
        self._path = Path(path)
        self._speed = speed
        self._loop = loop
        self._records: list[tuple[float, PollResult]] = []
        self._index = 0
        self._connected = False
        self._origin: float | None = None  # event-loop time corresponding to t=0
        self._offset = 0.0  # accumulated file duration across loops

    @property
    def connected(self) -> bool:
        return self._connected

    async def connect(self) -> None:
        try:
            lines = self._path.read_text(encoding="utf-8").splitlines()
            self._records = [
                (float(rec["t"]), record_to_message(rec))
                for rec in (json.loads(line) for line in lines if line.strip())
            ]
        except FileNotFoundError as exc:
            raise TrackConnectionError(
                f"Replay file not found: {self._path}", code="not_found"
            ) from exc
        except PermissionError as exc:
            raise TrackConnectionError(
                f"Cannot read replay file {self._path}: {exc}", code="permission"
            ) from exc
        except (OSError, ValueError, KeyError) as exc:
            raise TrackConnectionError(f"Invalid replay file {self._path}: {exc}") from exc
        self._index = 0
        self._origin = None
        self._offset = 0.0
        self._connected = True

    async def poll(self) -> PollResult:
        if not self._connected:
            raise TrackDisconnected("Replay not connected")
        if self._index >= len(self._records):
            if self._loop and self._records:
                self._offset += self._records[-1][0]
                self._index = 0
            else:
                self._connected = False
                raise TrackDisconnected("End of replay")
        t, msg = self._records[self._index]
        self._index += 1
        if self._speed > 0:
            now = asyncio.get_running_loop().time()
            due = (self._offset + t) / self._speed
            if self._origin is None:
                self._origin = now - due
            await asyncio.sleep(max(self._origin + due - now, 0))
        else:
            await asyncio.sleep(0)
        return msg

    async def start(self) -> None:
        return None

    async def toggle_pace_car(self) -> None:
        return None

    async def reset_timer(self) -> None:
        return None

    async def close(self) -> None:
        self._connected = False
