"""Live position estimate of every car along the drawn track layout.

Pure function over a `RaceState` snapshot: the engine only knows when a car crossed a
sensor and how long each stretch usually takes (`CarState.segment_estimates`); this module
turns that into a `TrackPosition` the browser animates with its own clock (see
docs/PROTOCOL.md "Live position estimate" and `TrackPosition` in models.py).
"""

from __future__ import annotations

from app.race.models import CarState, RaceState, TrackLayout, TrackPosition

MEASURED_WINDOW_MS = 300  # "measured" right after a crossing
STALE_FACTOR = 2.5  # stale once overdue by this multiple of the expected time


def sensor_positions(layout: TrackLayout) -> dict[int, float]:
    """Sensor number -> fraction of the lap; sensor 1 (start/finish) sits at 0."""
    positions = {1: 0.0}
    for sensor in layout.sensors:
        positions[sensor.sensor] = sensor.s
    return positions


def driving_order(layout: TrackLayout) -> list[int]:
    """Sensor numbers in driving order starting at the line (sorted by ``s``)."""
    positions = sensor_positions(layout)
    return sorted(positions, key=lambda n: (positions[n], n))


def estimate_positions(
    state: RaceState, layout: TrackLayout | None, now_race_ms: int
) -> dict[int, TrackPosition]:
    """Position of each car that has crossed a sensor, keyed by car address.

    Returns ``{}`` without a layout. Cars without a crossing get no entry. When the last
    sensor is not in the layout the car is anchored at its last start/finish crossing.
    """
    if layout is None:
        return {}
    positions = sensor_positions(layout)
    order = driving_order(layout)
    result: dict[int, TrackPosition] = {}
    for car in state.cars:
        crossing = car.last_crossing
        if crossing is None:
            continue
        if crossing.sensor in positions:
            a = crossing.sensor
            b = order[(order.index(a) + 1) % len(order)]
            anchor = crossing.race_time_ms
        else:
            # A Check Lane the layout does not know (unannotated map, photo draft): fall
            # back to the last start/finish crossing and aim for the first declared sensor
            # (or the line again, a full lap).
            if car.total_time_ms is None:
                continue
            a = 1
            b = order[1] if len(order) > 1 else 1
            anchor = car.total_time_ms
        s_from, s_to = positions[a], positions[b]
        expected = _expected_ms(car, state, f"{a}>{b}", (s_to - s_from) % 1.0 or 1.0)
        age = now_race_ms - anchor
        if age < MEASURED_WINDOW_MS:
            confidence = "measured"
        elif expected is not None and age > STALE_FACTOR * expected:
            confidence = "stale"
        else:
            confidence = "estimated"
        result[car.address] = TrackPosition(
            from_sensor=a,
            to_sensor=b,
            s_from=s_from,
            s_to=s_to,
            anchor_race_ms=anchor,
            expected_ms=expected,
            in_pit=car.in_pit,
            confidence=confidence,
        )
    return result


def _expected_ms(car: CarState, state: RaceState, key: str, stretch: float) -> int | None:
    own = car.segment_estimates.get(key)
    if own:
        return own
    # Lap 1: the car has no history yet. Use the fastest estimate any car has learned
    # for this stretch, so the dot moves before the first full lap is over.
    others = [c.segment_estimates[key] for c in state.cars if c.segment_estimates.get(key)]
    if others:
        return min(others)
    lap_ms = car.best_lap_ms or car.avg_lap_ms
    if lap_ms is None:
        lap_ms = next(
            (c.best_lap_ms or c.avg_lap_ms for c in state.cars if c.best_lap_ms or c.avg_lap_ms),
            None,
        )
    if lap_ms is None:
        return None
    return max(1, round(lap_ms * stretch))
