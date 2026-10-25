"""Track abstraction shared by the simulator and the real carreralib adapter.

The message shapes mirror ``carreralib.ControlUnit.Timer`` / ``ControlUnit.Status``
(carreralib 2.0, verified against its source):

* ``Timer.address`` is 0-based (carreralib already subtracts 1): 0..5 are the
  six regular controllers, 6 is the autonomous car, 7 the pace car.
* ``Timer.timestamp`` is the CU's 32-bit millisecond clock. It wraps at 2**32;
  always subtract with :func:`ts_diff`.
* ``Timer.sector`` is 1 for start/finish, 2 or 3 for Check Lane sensors.
* ``Status.fuel`` has 8 levels 0..15, ``Status.pit`` 8 booleans.
* ``Status.start`` is the start light state: 0 = racing / no lights, 1 = start
  sequence armed, 2..6 = red lights 1..5 lit, 7 = go (lights out),
  8 and 9 = false start / blinking.
* ``Status.mode`` is a bit mask, see the ``MODE_*`` constants.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Protocol, runtime_checkable

TIMESTAMP_MODULO = 2**32

MODE_FUEL = 0x1
MODE_REAL_FUEL = 0x2
MODE_PIT_LANE = 0x4
MODE_LAP_COUNTER = 0x8

MAX_FUEL = 15
NUM_ADDRESSES = 8


def ts_diff(later: int, earlier: int) -> int:
    """Milliseconds from ``earlier`` to ``later``, handling 32-bit wraparound."""
    return (later - earlier) % TIMESTAMP_MODULO


@dataclass(frozen=True, slots=True)
class Timer:
    address: int
    timestamp: int
    sector: int = 1


@dataclass(frozen=True, slots=True)
class Status:
    fuel: tuple[int, ...]
    start: int
    mode: int
    pit: tuple[bool, ...]
    display: int = 6


PollResult = Timer | Status


TrackErrorCode = Literal["busy", "not_found", "permission", "bluetooth_off", "timeout", "unknown"]


class TrackError(Exception):
    """Base error for track connections.

    ``code`` is a stable, language-neutral identifier the frontend translates;
    the message stays English for logs.
    """

    def __init__(self, message: str = "", code: TrackErrorCode = "unknown") -> None:
        super().__init__(message)
        self.code: TrackErrorCode = code


class TrackConnectionError(TrackError):
    """Connecting failed (device not found, busy, permission denied...)."""


class TrackDisconnected(TrackError):
    """The connection was lost while polling or sending a command."""


@runtime_checkable
class TrackInterface(Protocol):
    """Async facade over a Control Unit.

    Implementations doing blocking IO must run it off the event loop (e.g. a
    dedicated thread feeding an ``asyncio.Queue``); no method may block the loop.
    """

    @property
    def connected(self) -> bool: ...

    async def connect(self) -> None:
        """Open the connection. Raises :class:`TrackConnectionError`."""

    async def poll(self) -> PollResult:
        """Wait for and return the next message from the CU.

        Timer messages are returned as soon as they arrive; when none are
        pending a Status is returned at a steady rate (roughly 5-20 Hz).
        Raises :class:`TrackDisconnected` if the link drops.
        """

    async def start(self) -> None:
        """Trigger the CU start light sequence (START/ENTER button)."""

    async def toggle_pace_car(self) -> None:
        """Press PACE CAR/ESC: deploys or recalls the pace car (pauses the race)."""

    async def reset_timer(self) -> None:
        """Reset the CU timer and drop pending timer messages."""

    async def close(self) -> None:
        """Close the connection. Idempotent."""
