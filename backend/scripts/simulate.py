"""Run the simulated Control Unit through the race engine and print laps and events.

Usage (from ``backend/``)::

    uv run python scripts/simulate.py --laps 10 --cars 4 --time-scale 20
"""

from __future__ import annotations

import argparse
import asyncio
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.race.engine import RaceEngine  # noqa: E402
from app.race.models import (  # noqa: E402
    BestLap,
    LapCompleted,
    LowFuel,
    PitEntry,
    PitExit,
    PositionChange,
    RaceConfig,
    RaceEvent,
    RaceFinished,
    RaceMode,
    RacePhase,
    RaceStarted,
    default_cars,
)
from app.track.simulator import SimulatorTrack  # noqa: E402


def fmt(ms: int | None) -> str:
    if ms is None:
        return "-"
    minutes, rest = divmod(ms, 60_000)
    return f"{minutes}:{rest / 1000:06.3f}" if minutes else f"{rest / 1000:.3f}"


def describe(event: RaceEvent) -> str | None:
    clock = f"[{fmt(event.race_time_ms):>8}]"
    match event:
        case RaceStarted():
            return f"{clock} race started ({event.mode.value})"
        case LapCompleted():
            flag = "" if event.valid else " (invalid)"
            return (
                f"{clock} car {event.address + 1} lap {event.lap_number}: "
                f"{fmt(event.lap_ms)} P{event.position}{flag}"
            )
        case BestLap():
            kind = "OVERALL best" if event.overall else "personal best"
            return f"{clock} car {event.address + 1} {kind} {fmt(event.lap_ms)}"
        case PositionChange():
            passed = (
                f" passing car {event.passed_address + 1}"
                if event.passed_address is not None
                else ""
            )
            moves = f"P{event.old_position} -> P{event.new_position}"
            return f"{clock} car {event.address + 1} {moves}{passed}"
        case PitEntry():
            return f"{clock} car {event.address + 1} enters the pit"
        case PitExit():
            return f"{clock} car {event.address + 1} leaves the pit after {fmt(event.duration_ms)}"
        case LowFuel():
            return f"{clock} car {event.address + 1} low fuel ({event.fuel})"
        case RaceFinished():
            return f"{clock} race finished, order: {[a + 1 for a in event.order]}"
        case _:
            return f"{clock} {event.type}"


async def run(args: argparse.Namespace) -> int:
    scale = args.time_scale
    start = time.monotonic()
    config = RaceConfig(mode=RaceMode.LAPS, target_laps=args.laps)
    cars = default_cars()[: args.cars]
    engine = RaceEngine(cars, config, clock=lambda: (time.monotonic() - start) * scale)
    track = SimulatorTrack(num_cars=args.cars, seed=args.seed, time_scale=scale)
    await track.connect()
    engine.prepare(config)
    await track.start()
    deadline = start + args.timeout
    try:
        while engine.state.phase is not RacePhase.FINISHED:
            if time.monotonic() > deadline:
                print("timeout: race did not finish", file=sys.stderr)
                return 1
            events = engine.handle(await track.poll()) + engine.tick()
            for event in events:
                line = describe(event)
                if line:
                    print(line)
    finally:
        await track.close()

    print("\nFinal standings")
    for car in engine.state.cars:
        print(
            f"  P{car.position} {car.name:<8} laps={car.laps} best={fmt(car.best_lap_ms)} "
            f"avg={fmt(car.avg_lap_ms)} total={fmt(car.total_time_ms)} pits={car.pit_stops}"
        )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--laps", type=int, default=10)
    parser.add_argument("--cars", type=int, default=4, choices=range(1, 7))
    parser.add_argument("--time-scale", type=float, default=20.0)
    parser.add_argument("--seed", type=int, default=None)
    parser.add_argument("--timeout", type=float, default=300.0, help="wall-clock seconds")
    return asyncio.run(run(parser.parse_args()))


if __name__ == "__main__":
    raise SystemExit(main())
