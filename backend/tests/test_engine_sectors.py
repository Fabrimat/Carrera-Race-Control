"""Sector (Check Lane) timing and segment learning, with scripted Timer sequences."""

from __future__ import annotations

from app.race.models import LapCompleted, RaceConfig, SectorCompleted
from app.track.base import TIMESTAMP_MODULO
from tests.test_engine import cross, go, make, of_type, status


def lap(engine, address, ts, sector_ts):
    """One lap: ``sector_ts`` = [(sensor, ts), ...] then the line at ``ts``. Returns events."""
    events = []
    for sensor, t in sector_ts:
        events += cross(engine, address, t, sensor)
    events += cross(engine, address, ts)
    return events


def car(engine, address=0):
    return next(c for c in engine.state.cars if c.address == address)


def started(sensors=None):
    engine, clock = make()
    if sensors is not None:
        engine.set_declared_sensors(sensors)
    go(engine)
    cross(engine, 0, 1000)  # start pass
    return engine, clock


def test_no_check_lanes_is_a_noop():
    engine, _ = started()
    events = lap(engine, 0, 7500, [])
    assert of_type(events, SectorCompleted) == []
    assert engine.state.num_sectors == 1
    c = car(engine)
    assert c.current_sectors == [None]
    assert c.last_sectors == [6500] and c.best_sectors == [6500]
    assert engine.state.best_sectors == [6500]
    assert c.segment_estimates == {"1>1": 6500}
    assert c.last_crossing.sensor == 1


def test_three_sectors_splits_and_events():
    engine, _ = started()
    events = cross(engine, 0, 3000, 2)
    assert [(e.sector, e.split_ms, e.lap_number) for e in of_type(events, SectorCompleted)] == [
        (1, 2000, 1)
    ]
    assert engine.state.num_sectors == 2  # only sensor 2 seen so far
    events = cross(engine, 0, 5000, 3)
    assert engine.state.num_sectors == 3
    assert [(e.sector, e.split_ms) for e in of_type(events, SectorCompleted)] == [(2, 2000)]
    c = car(engine)
    assert c.current_sectors == [2000, 2000, None]
    assert c.last_crossing.sensor == 3
    events = cross(engine, 0, 7500)
    sectors = of_type(events, SectorCompleted)
    assert [(e.sector, e.split_ms, e.lap_number) for e in sectors] == [(3, 2500, 1)]
    # sector event comes before the LapCompleted of the same crossing
    assert isinstance(events[0], SectorCompleted) and isinstance(events[1], LapCompleted)
    c = car(engine)
    assert c.last_sectors == [2000, 2000, 2500]
    assert c.current_sectors == [None, None, None]
    assert c.last_crossing.sensor == 1
    assert c.last_lap_ms == 6500
    assert c.segment_estimates == {"1>2": 2000, "2>3": 2000, "3>1": 2500}


def test_two_sectors_with_one_check_lane():
    engine, _ = started()
    lap(engine, 0, 7500, [(2, 4000)])
    assert engine.state.num_sectors == 2
    assert car(engine).last_sectors == [3000, 3500]


def test_sector_crossings_do_not_move_lap_reference():
    engine, _ = started([2, 3])
    cross(engine, 0, 3000, 2)
    cross(engine, 0, 5000, 3)
    events = cross(engine, 0, 7500)
    assert [e.lap_ms for e in of_type(events, LapCompleted)] == [6500]


def test_declared_order_and_num_sectors():
    engine, _ = started([2, 3])
    assert engine.state.num_sectors == 3
    assert car(engine).current_sectors == [None, None, None]
    assert engine.state.best_sectors == [None, None, None]


def test_declared_order_can_be_reversed():
    engine, _ = started([3, 2])
    events = cross(engine, 0, 3000, 3)  # first sensor in driving order
    assert [(e.sector, e.split_ms) for e in of_type(events, SectorCompleted)] == [(1, 2000)]
    cross(engine, 0, 5000, 2)
    cross(engine, 0, 7500)
    assert car(engine).last_sectors == [2000, 2000, 2500]
    assert car(engine).segment_estimates == {"1>3": 2000, "3>2": 2000, "2>1": 2500}


def test_undeclared_sensor_three_first_keeps_fixed_slots():
    engine, _ = started()
    events = cross(engine, 0, 5000, 3)
    assert engine.state.num_sectors == 3
    # slot 2 (sensor 2 -> 3) has no start mark: never fabricated
    assert of_type(events, SectorCompleted) == []
    assert car(engine).current_sectors == [None, None, None]
    # the sensor 3 -> line sector is real
    events = cross(engine, 0, 7500)
    assert car(engine).last_sectors == [None, None, 2500]
    assert [e.sector for e in of_type(events, SectorCompleted)] == [3]
    # a later lap sees sensor 2 as well: numbering does not shift
    cross(engine, 0, 9500, 2)
    assert engine.state.num_sectors == 3
    assert car(engine).current_sectors == [2000, None, None]


def test_missed_sensor_leaves_none_and_never_fabricates():
    engine, _ = started([2, 3])
    lap(engine, 0, 7500, [(2, 3000), (3, 5000)])
    events = lap(engine, 0, 14_000, [(3, 11_500)])  # sensor 2 missed on lap 2
    sectors = of_type(events, SectorCompleted)
    assert [e.sector for e in sectors] == [3]  # sector 2 (needs sensor 2) cannot be computed
    assert car(engine).last_sectors == [None, None, 2500]
    # sector 1 in lap 3 is fine again
    cross(engine, 0, 16_000, 2)
    assert car(engine).current_sectors == [2000, None, None]


def test_missed_line_crossing_does_not_chain_sectors():
    engine, _ = started([2, 3])
    cross(engine, 0, 3000, 2)
    cross(engine, 0, 5000, 3)
    # the line crossing is lost; the next lap's sensor 2 arrives with sensor 2 already marked
    events = cross(engine, 0, 9500, 2)
    assert of_type(events, SectorCompleted) == []  # no valid line reference for sector 1
    assert car(engine).current_sectors == [None, None, None]
    events = cross(engine, 0, 11_500, 3)
    assert [(e.sector, e.split_ms) for e in of_type(events, SectorCompleted)] == [(2, 2000)]


def test_double_trigger_on_sensor_ignored():
    engine, _ = started([2, 3])
    assert len(of_type(cross(engine, 0, 3000, 2), SectorCompleted)) == 1
    assert cross(engine, 0, 3100, 2) == []
    c = car(engine)
    assert c.current_sectors[0] == 2000
    events = cross(engine, 0, 5000, 3)
    assert [e.split_ms for e in of_type(events, SectorCompleted)] == [2000]


def test_impossible_split_ignored():
    engine, _ = started([2, 3])
    far = 1000 + RaceConfig().max_lap_ms + 5000
    assert cross(engine, 0, far, 2) == []
    assert car(engine).current_sectors == [None, None, None]
    assert car(engine).last_crossing.sensor == 1


def test_sensor_before_start_pass_and_finished_ignored():
    engine, _ = make()
    go(engine)
    assert cross(engine, 1, 2000, 2) == []
    assert car(engine, 1).last_crossing is None


def test_wraparound_mid_lap():
    engine, clock = make()
    go(engine)
    base = TIMESTAMP_MODULO - 2500
    cross(engine, 0, base)
    clock.advance(2)
    events = cross(engine, 0, (base + 2000) % TIMESTAMP_MODULO, 2)  # still below 2**32
    clock.advance(2)
    events += cross(engine, 0, (base + 4100) % TIMESTAMP_MODULO, 3)  # wrapped
    clock.advance(3)
    events += cross(engine, 0, (base + 6500) % TIMESTAMP_MODULO)
    assert [e.split_ms for e in of_type(events, SectorCompleted)] == [2000, 2100, 2400]
    assert [e.lap_ms for e in of_type(events, LapCompleted)] == [6500]


def test_bests_personal_and_overall():
    engine, _ = started([2])
    cross(engine, 1, 1200)  # car 1 start pass
    # lap 1 of car 0: sectors 2000 / 4500; car 1: 2200 / 4300 (sets overall best sector 2)
    e0 = lap(engine, 0, 7500, [(2, 3000)])
    assert [(e.personal_best, e.overall_best) for e in of_type(e0, SectorCompleted)] == [
        (False, False),
        (False, False),
    ]
    e1 = lap(engine, 1, 7700, [(2, 3400)])
    flags = [(e.sector, e.personal_best, e.overall_best) for e in of_type(e1, SectorCompleted)]
    assert flags == [(1, False, False), (2, False, True)]
    # car 0 lap 2: improves personal sector 1 (2000 -> 1900, overall 1900 vs 2200)
    e0 = lap(engine, 0, 13_700, [(2, 9400)])  # s1 1900, s2 4300
    flags = [(e.sector, e.personal_best, e.overall_best) for e in of_type(e0, SectorCompleted)]
    assert flags == [(1, False, True), (2, True, False)]
    assert car(engine, 0).best_sectors == [1900, 4300]
    assert engine.state.best_sectors == [1900, 4300]
    # car 1 improves only its own sector 1 (not below the overall 1900)
    e1 = lap(engine, 1, 14_200, [(2, 9800)])  # s1 2100 (was 2200), s2 4400
    flags = [(e.sector, e.personal_best, e.overall_best) for e in of_type(e1, SectorCompleted)]
    assert flags == [(1, True, False), (2, False, False)]


def test_invalid_lap_does_not_set_last_sector_best():
    engine, _ = started([2])
    lap(engine, 0, 7500, [(2, 3000)])
    slow = 7500 + RaceConfig().max_lap_ms + 1000
    events = lap(engine, 0, slow, [(2, 8500)])
    assert car(engine).best_sectors[1] == 4500  # unchanged by the invalid lap
    last = of_type(events, SectorCompleted)[-1]
    assert last.sector == 2 and not last.personal_best and not last.overall_best


def test_sectors_while_paused():
    engine, _ = started([2])
    engine.set_paused(True)
    events = cross(engine, 0, 3000, 2)
    assert len(of_type(events, SectorCompleted)) == 1


def test_cars_awaiting_resync_ignore_sensors():
    engine, clock = started([2])
    lap(engine, 0, 7500, [(2, 3000)])
    engine.resync_clock()
    clock.advance(1)
    # CU power-cycled: timestamps restart near zero
    assert of_type(cross(engine, 0, 500, 2), SectorCompleted) == []
    # the line crossing re-anchors without a lap and without touching sector history
    assert cross(engine, 0, 900) == []
    assert car(engine).last_sectors == [2000, 4500]
    events = cross(engine, 0, 3100, 2)
    assert [e.split_ms for e in of_type(events, SectorCompleted)] == [2200]


def test_declared_change_clears_sector_data_only():
    engine, _ = started([2])
    lap(engine, 0, 7500, [(2, 3000)])
    assert car(engine).last_sectors == [2000, 4500]
    engine.set_declared_sensors([2, 3])
    assert engine.state.num_sectors == 3
    # line -> 2 is unchanged and kept; "2 -> line" became "2 -> 3" + "3 -> line": dropped
    assert car(engine).last_sectors == [2000, None, None]
    assert car(engine).segment_estimates == {"1>2": 2000}
    assert car(engine).laps == 1 and car(engine).last_lap_ms == 6500
    engine.set_declared_sensors([2, 3, 2, 9])  # duplicates / unknown numbers dropped
    assert engine.state.num_sectors == 3


def test_declared_sensors_survive_race_reset():
    engine, _ = started([2, 3])
    engine.prepare(RaceConfig())
    assert engine.state.num_sectors == 3


# ---------------------------------------------------------------- segment learning


def test_segment_ewma_seed_and_update():
    engine, _ = started()
    lap(engine, 0, 7500, [])  # 6500 seeds
    assert car(engine).segment_estimates == {"1>1": 6500}
    lap(engine, 0, 7500 + 5500, [])  # 5500: 0.3*5500 + 0.7*6500 = 6200
    assert car(engine).segment_estimates == {"1>1": 6200}


def test_segment_outlier_rejected():
    engine, _ = started()
    lap(engine, 0, 7500, [])
    lap(engine, 0, 7500 + 20_000, [])  # crash lap > 1.8x
    assert car(engine).segment_estimates == {"1>1": 6500}


def test_segment_sector_keys_and_outlier():
    engine, _ = started([2])
    lap(engine, 0, 7500, [(2, 3000)])
    assert car(engine).segment_estimates == {"1>2": 2000, "2>1": 4500}
    lap(engine, 0, 14_000, [(2, 12_000)])  # s1 = 4500 (> 1.8 * 2000): rejected; s2 2000 learned
    est = car(engine).segment_estimates
    assert est["1>2"] == 2000
    assert est["2>1"] == round(0.3 * 2000 + 0.7 * 4500)


def test_segment_with_pit_stop_excluded():
    engine, _ = started()
    lap(engine, 0, 7500, [])
    engine.handle(status(pit=[True] + [False] * 7))
    engine.handle(status(pit=[True] + [False] * 7))
    assert car(engine).in_pit
    engine.handle(status())
    engine.handle(status())
    assert not car(engine).in_pit
    lap(engine, 0, 7500 + 9000, [])  # includes the pit stop: ignored (also within 1.8x)
    assert car(engine).segment_estimates == {"1>1": 6500}
    lap(engine, 0, 7500 + 9000 + 5000, [])  # clean lap again
    assert car(engine).segment_estimates == {"1>1": round(0.3 * 5000 + 0.7 * 6500)}
