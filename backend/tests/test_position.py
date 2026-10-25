"""Live position estimate: pure function over RaceState + layout."""

from __future__ import annotations

from app.race.models import (
    CarState,
    Crossing,
    LayoutSensor,
    RaceState,
    TrackLayout,
)
from app.race.position import estimate_positions

POINTS = [(0.1 + 0.1 * i, 0.5 + (0.3 if i % 2 else 0.0)) for i in range(8)]


def layout(*sensors: tuple[int, float], pit_s: float | None = None) -> TrackLayout:
    return TrackLayout(
        name="t",
        points=POINTS,
        sensors=[LayoutSensor(sensor=n, s=s) for n, s in sensors],
        pit_s=pit_s,
    )


def car(address: int = 0, **kwargs) -> CarState:
    return CarState(address=address, name=f"c{address}", color="#ffffff", **kwargs)


def state(*cars: CarState) -> RaceState:
    return RaceState(cars=list(cars))


def test_car_without_crossing_has_no_position() -> None:
    assert estimate_positions(state(car()), layout(), 1000) == {}


def test_no_layout_means_no_positions() -> None:
    c = car(last_crossing=Crossing(sensor=1, race_time_ms=0))
    assert estimate_positions(state(c), None, 1000) == {}


def test_full_lap_without_check_lanes() -> None:
    c = car(
        last_crossing=Crossing(sensor=1, race_time_ms=10_000),
        segment_estimates={"1>1": 6000},
    )
    pos = estimate_positions(state(c), layout(), 13_000)[0]
    assert (pos.from_sensor, pos.to_sensor) == (1, 1)
    assert pos.s_from == 0.0 and pos.s_to == 0.0
    assert pos.anchor_race_ms == 10_000
    assert pos.expected_ms == 6000
    assert pos.confidence == "estimated"
    assert not pos.in_pit


def test_next_sensor_follows_layout_order_not_numbers() -> None:
    # Sensor 3 sits before sensor 2 along the driving direction.
    lay = layout((3, 0.25), (2, 0.6))
    c = car(
        last_crossing=Crossing(sensor=3, race_time_ms=5000),
        segment_estimates={"3>2": 2100},
    )
    pos = estimate_positions(state(c), lay, 5500)[0]
    assert (pos.from_sensor, pos.to_sensor) == (3, 2)
    assert (pos.s_from, pos.s_to) == (0.25, 0.6)
    assert pos.expected_ms == 2100


def test_last_sensor_wraps_to_the_line() -> None:
    lay = layout((2, 0.33), (3, 0.66))
    c = car(
        last_crossing=Crossing(sensor=3, race_time_ms=5000),
        segment_estimates={"3>1": 2000},
    )
    pos = estimate_positions(state(c), lay, 5500)[0]
    assert (pos.from_sensor, pos.to_sensor) == (3, 1)
    assert pos.s_from == 0.66 and pos.s_to == 0.0


def test_confidence_measured_estimated_stale() -> None:
    c = car(
        last_crossing=Crossing(sensor=1, race_time_ms=10_000),
        segment_estimates={"1>1": 4000},
    )
    lay = layout()
    assert estimate_positions(state(c), lay, 10_100)[0].confidence == "measured"
    assert estimate_positions(state(c), lay, 12_000)[0].confidence == "estimated"
    assert estimate_positions(state(c), lay, 19_900)[0].confidence == "estimated"
    assert estimate_positions(state(c), lay, 20_100)[0].confidence == "stale"


def test_expected_falls_back_to_fraction_of_own_lap() -> None:
    lay = layout((2, 0.25), (3, 0.75))
    c = car(
        last_crossing=Crossing(sensor=2, race_time_ms=3000),
        best_lap_ms=8000,
        avg_lap_ms=9000,
    )
    pos = estimate_positions(state(c), lay, 3500)[0]
    assert pos.expected_ms == 4000  # 0.5 of the best lap


def test_expected_uses_average_when_no_best() -> None:
    c = car(last_crossing=Crossing(sensor=1, race_time_ms=0), avg_lap_ms=7000)
    assert estimate_positions(state(c), layout(), 100)[0].expected_ms == 7000


def test_lap_one_uses_other_cars_segment_estimate() -> None:
    lay = layout((2, 0.4))
    first = car(0, segment_estimates={"1>2": 3000, "2>1": 4000})
    slow = car(1, segment_estimates={"1>2": 3500})
    newcomer = car(2, last_crossing=Crossing(sensor=1, race_time_ms=100))
    pos = estimate_positions(state(first, slow, newcomer), lay, 200)[2]
    assert pos.expected_ms == 3000  # the race's best estimate for that segment


def test_no_history_at_all_gives_none() -> None:
    c = car(last_crossing=Crossing(sensor=1, race_time_ms=0))
    pos = estimate_positions(state(c), layout(), 100)[0]
    assert pos.expected_ms is None
    assert pos.confidence == "measured"
    assert estimate_positions(state(c), layout(), 5000)[0].confidence == "estimated"


def test_in_pit_flag_is_copied() -> None:
    c = car(
        in_pit=True,
        last_crossing=Crossing(sensor=1, race_time_ms=0),
        segment_estimates={"1>1": 5000},
    )
    assert estimate_positions(state(c), layout(pit_s=0.9), 100)[0].in_pit


def test_unknown_check_lane_falls_back_to_the_last_line_crossing() -> None:
    c = car(
        total_time_ms=4000,
        best_lap_ms=6000,
        last_crossing=Crossing(sensor=2, race_time_ms=6500),
    )
    pos = estimate_positions(state(c), layout(), 7000)[0]
    assert (pos.from_sensor, pos.to_sensor) == (1, 1)
    assert pos.s_from == 0.0 and pos.s_to == 0.0
    assert pos.anchor_race_ms == 4000
    assert pos.expected_ms == 6000
    assert pos.confidence == "estimated"


def test_unknown_check_lane_aims_for_the_first_declared_sensor() -> None:
    c = car(total_time_ms=4000, last_crossing=Crossing(sensor=3, race_time_ms=6500))
    c.segment_estimates = {"1>2": 2500}
    pos = estimate_positions(state(c), layout((2, 0.4)), 4100)[0]
    assert (pos.from_sensor, pos.to_sensor, pos.s_to) == (1, 2, 0.4)
    assert pos.expected_ms == 2500


def test_unknown_check_lane_without_a_line_crossing_is_skipped() -> None:
    c = car(last_crossing=Crossing(sensor=3, race_time_ms=0))
    assert estimate_positions(state(c), layout(), 100) == {}


def test_clock_before_anchor_is_measured_not_negative() -> None:
    c = car(last_crossing=Crossing(sensor=1, race_time_ms=1000), segment_estimates={"1>1": 5000})
    assert estimate_positions(state(c), layout(), 900)[0].confidence == "measured"
