"""Simulator deslot model (docs/PROTOCOL.md "Incidents" -> "Simulator")."""

from __future__ import annotations

import pytest

from app.track.base import Timer
from app.track.simulator import SimulatorTrack


def crossings(msgs, address, sector=1):
    return [
        t for t, m in msgs if isinstance(m, Timer) and m.address == address and m.sector == sector
    ]


def run(track: SimulatorTrack, until_ms: float, deslot: tuple[int, float, float] | None = None):
    """Virtual-time stream up to ``until_ms``; ``deslot`` = (car, seconds, at virtual ms)."""
    out = []
    pending = deslot
    for t, msg in track.generate():
        if t > until_ms:
            return out
        if pending is not None and t >= pending[2]:
            track.deslot(pending[0], pending[1], at_ms=t)
            pending = None
        out.append((t, msg))
    return out


def test_deslot_holds_one_car_and_then_it_goes_on():
    plain = SimulatorTrack(num_cars=3, seed=5, double_trigger_rate=0, deslot_rate=0)
    held = SimulatorTrack(num_cars=3, seed=5, double_trigger_rate=0, deslot_rate=0)
    base = run(plain, 80_000)
    out = run(held, 80_000, deslot=(0, 20, 10_000))
    plain_cross = [x for x in crossings(base, 0) if x >= 10_000]
    held_cross = [x for x in crossings(out, 0) if x >= 10_000]
    assert [x for x in crossings(out, 0) if x < 10_000] == [
        x for x in crossings(base, 0) if x < 10_000
    ]
    assert held_cross[0] == pytest.approx(plain_cross[0] + 20_000, abs=1)
    assert len(held_cross) >= 2  # it goes on after the stop
    # the other cars keep running (the shared random stream is drawn in another order later)
    assert crossings(out, 1)[:2] == crossings(base, 1)[:2]
    assert crossings(out, 2)[:2] == crossings(base, 2)[:2]
    assert len(crossings(out, 1)) >= len(crossings(base, 1)) - 1


def test_deslot_shifts_the_check_lanes_too():
    plain = SimulatorTrack(
        num_cars=2, seed=2, double_trigger_rate=0, deslot_rate=0, check_lanes=[0.4]
    )
    held = SimulatorTrack(
        num_cars=2, seed=2, double_trigger_rate=0, deslot_rate=0, check_lanes=[0.4]
    )
    base = run(plain, 60_000)
    out = run(held, 60_000, deslot=(1, 15, 9_000))
    a = [x for x in crossings(base, 1, 2) if x >= 9_000]
    b = [x for x in crossings(out, 1, 2) if x >= 9_000]
    assert b[0] == pytest.approx(a[0] + 15_000, abs=1)


def test_deslot_unknown_car():
    with pytest.raises(ValueError):
        SimulatorTrack(num_cars=2, seed=1).deslot(5, 10, at_ms=0)


def test_random_deslot_adds_10_to_25_s_to_a_lap():
    plain = SimulatorTrack(
        num_cars=1, seed=3, double_trigger_rate=0, deslot_rate=0, check_lanes=[0.3, 0.7]
    )
    slow = SimulatorTrack(
        num_cars=1, seed=3, double_trigger_rate=0, deslot_rate=1.0, check_lanes=[0.3, 0.7]
    )
    a = crossings(run(plain, 150_000), 0)
    b = crossings(run(slow, 150_000), 0)
    extra = (b[1] - b[0]) - (a[1] - a[0])
    assert 9_000 < extra < 26_000


def test_default_deslot_rate_is_small():
    from app.track.simulator import DESLOT_RATE

    assert 0 < DESLOT_RATE <= 0.01
