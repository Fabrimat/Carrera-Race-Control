"""Console tool: print raw CU messages and computed lap times.

Usage::

    python -m app.track.console --address AA:BB:CC:DD:EE:FF [--record session.jsonl]
    python -m app.track.console --simulator
    python -m app.track.console --replay session.jsonl --speed 5
"""

from __future__ import annotations

import argparse
import asyncio

from app.track.base import (
    Status,
    Timer,
    TrackConnectionError,
    TrackDisconnected,
    TrackInterface,
    ts_diff,
)


def format_ms(ms: int) -> str:
    minutes, rest = divmod(ms, 60_000)
    return f"{minutes}:{rest / 1000:06.3f}" if minutes else f"{rest / 1000:.3f}"


async def run(track: TrackInterface, start: bool = False) -> None:
    last_ts: dict[int, int] = {}
    last_status: Status | None = None
    await track.connect()
    print("Connected. Ctrl-C to stop.")
    try:
        if start:
            await track.start()
        while True:
            msg = await track.poll()
            if isinstance(msg, Timer):
                line = f"TIMER addr={msg.address} ts={msg.timestamp} sector={msg.sector}"
                if msg.sector == 1:
                    prev = last_ts.get(msg.address)
                    last_ts[msg.address] = msg.timestamp
                    if prev is not None:
                        line += f"  lap={format_ms(ts_diff(msg.timestamp, prev))}"
                    else:
                        line += "  (first crossing)"
                print(line)
            elif isinstance(msg, Status):
                # Status arrives at 10-20 Hz: only print when something changed.
                if msg != last_status:
                    print(
                        f"STATUS start={msg.start} mode={msg.mode:#x} fuel={list(msg.fuel)} "
                        f"pit={[int(p) for p in msg.pit]}"
                    )
                last_status = msg
    finally:
        await track.close()


def build_track(args: argparse.Namespace) -> TrackInterface:
    track: TrackInterface
    if args.simulator:
        from app.track.simulator import SimulatorTrack  # lazy: written by another module

        track = SimulatorTrack(num_cars=4)
    elif args.replay:
        from app.track.replay import ReplayTrack

        track = ReplayTrack(args.replay, speed=args.speed)
    else:
        from app.track.carrera import CarreraTrack

        track = CarreraTrack(args.address, mode=args.mode)
    if args.record:
        from app.track.replay import RecordingTrack

        track = RecordingTrack(track, args.record)
    return track


def main() -> None:
    parser = argparse.ArgumentParser(description="Print Carrera CU timer/status messages")
    src = parser.add_mutually_exclusive_group(required=True)
    src.add_argument("--simulator", action="store_true", help="use the built-in simulator")
    src.add_argument("--address", help="BLE address (AA:BB:..) or serial port (COM3, /dev/ttyUSB0)")
    src.add_argument("--replay", metavar="FILE", help="replay a recorded JSONL session")
    parser.add_argument("--mode", choices=["ble", "serial"], help="force connection type")
    parser.add_argument("--record", metavar="FILE", help="append raw polls to this JSONL file")
    parser.add_argument("--speed", type=float, default=1.0, help="replay speed (0 = max)")
    parser.add_argument("--start", action="store_true", help="press START after connecting")
    args = parser.parse_args()
    try:
        asyncio.run(run(build_track(args), start=args.start or args.simulator))
    except TrackConnectionError as exc:
        raise SystemExit(f"Connection failed [{exc.code}]: {exc}") from exc
    except TrackDisconnected as exc:
        print(f"Disconnected [{exc.code}]: {exc}")
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
