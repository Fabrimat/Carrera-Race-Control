import random
import re
from string import Formatter

import pytest

from app.commentary import templates_en, templates_it
from app.commentary.events import LANGUAGES, TemplateBook, candidates
from app.race.models import (
    BestLap,
    CommentaryPriority,
    Idle,
    LowFuel,
    PitEntry,
    PitExit,
    RaceFinished,
    TrackRecord,
    Verbosity,
)
from tests.test_commentary_fakes import (
    CARS,
    ev_finished,
    ev_lap,
    ev_overtake,
    ev_started,
    state,
)

P = CommentaryPriority


def cands(event, verbosity=Verbosity.NORMAL, lang="it", st=None, book=None):
    return candidates(event, st or state(), CARS, verbosity, lang, book or TemplateBook())


def test_both_languages_cover_same_keys_with_3_to_5_variants():
    assert set(templates_it.TEMPLATES) == set(templates_en.TEMPLATES)
    for module in (templates_it, templates_en):
        for key, variants in module.TEMPLATES.items():
            assert 3 <= len(variants) <= 5, (module.__name__, key)


def test_placeholders_are_known_fields():
    known = {"name", "lap_time", "lap", "position", "passed", "fuel", "winner", "second"}
    known |= {"previous_time", "holder", "sector", "car", "penalty", "session", "count"}
    for module in LANGUAGES.values():
        for variants in module.TEMPLATES.values():
            for v in variants:
                used = {n for _, n, _, _ in Formatter().parse(v) if n}
                assert used <= known


@pytest.mark.parametrize("lang", ["it", "en"])
def test_priorities(lang):
    assert cands(ev_started(), lang=lang)[0].priority == P.HIGH
    assert cands(ev_finished(), lang=lang)[0].priority == P.HIGH
    assert cands(ev_overtake(), lang=lang)[0].priority == P.HIGH
    overall = BestLap(address=0, lap_ms=7000, overall=True)
    assert cands(overall, lang=lang)[0].priority == P.HIGH
    # personal best: NORMAL for the leader (address 0), LOW otherwise
    leader_pb = BestLap(address=0, lap_ms=7000, overall=False)
    assert cands(leader_pb, lang=lang)[0].priority == P.NORMAL
    other_pb = BestLap(address=1, lap_ms=7000, overall=False)
    assert cands(other_pb, lang=lang)[0].priority == P.LOW
    assert cands(PitEntry(address=1), lang=lang)[0].priority == P.NORMAL
    assert cands(PitExit(address=1, fuel=15), lang=lang)[0].priority == P.NORMAL
    assert cands(LowFuel(address=1, fuel=2), lang=lang)[0].priority == P.NORMAL
    assert cands(Idle(seconds=30), lang=lang)[0].priority == P.LOW


def test_text_uses_nickname_and_language():
    event = BestLap(address=0, lap_ms=7342, overall=True)
    it = cands(event, lang="it")[0].text
    en = cands(event, lang="en")[0].text
    assert "Fulmine" in it and "sette secondi e trentaquattro" in it
    assert "Fulmine" in en and "seven point three four seconds" in en


@pytest.mark.parametrize("lang", ["it", "en"])
def test_overtake_names_cars_and_leaves_no_placeholders(lang):
    for seed in range(30):
        text = cands(ev_overtake(), lang=lang, book=TemplateBook(random.Random(seed)))[0].text
        assert "Blu" in text
        assert not re.search(r"[{}]", text)


def test_position_loss_is_not_commented():
    lost = ev_overtake().model_copy(update={"old_position": 1, "new_position": 2})
    assert cands(lost) == []


def test_race_finished_without_second_has_clean_text():
    for seed in range(20):
        book = TemplateBook(random.Random(seed))
        text = cands(RaceFinished(winner=0, order=[0]), book=book)[0].text
        assert "Fulmine" in text and "{" not in text and "  " not in text


def test_no_immediate_repeat_per_event_type():
    book = TemplateBook(random.Random(0))
    for lang in ("it", "en"):
        texts = [cands(ev_started(), lang=lang, book=book)[0].text for _ in range(60)]
        assert all(a != b for a, b in zip(texts, texts[1:], strict=False))
        assert len(set(texts)) >= 3


def test_cacheable_flag():
    book = TemplateBook(random.Random(0))
    assert cands(ev_started(), book=book)[0].cacheable  # static phrase
    best = cands(BestLap(address=0, lap_ms=7000, overall=True), book=book)[0]
    assert not best.cacheable  # contains a spoken time


def test_verbosity_low_drops_low_and_thins_normal():
    assert cands(Idle(seconds=30), Verbosity.LOW) == []
    assert cands(ev_lap(lap=3), Verbosity.LOW) == []
    assert cands(PitExit(address=1, fuel=15), Verbosity.LOW) == []
    assert cands(LowFuel(address=1, fuel=2), Verbosity.LOW)
    assert cands(ev_started(), Verbosity.LOW)  # HIGH is kept


def test_leader_lap_frequency_by_verbosity():
    def count(verbosity):
        return sum(bool(cands(ev_lap(lap=n), verbosity)) for n in range(1, 9))

    assert count(Verbosity.NORMAL) == 2  # laps 3 and 6
    assert count(Verbosity.HIGH) == 8


def test_high_verbosity_comments_other_cars_every_second_lap():
    n = sum(bool(cands(ev_lap(address=1, lap=k, position=2), Verbosity.HIGH)) for k in range(1, 9))
    assert n == 4
    assert cands(ev_lap(address=1, lap=2, position=2), Verbosity.NORMAL) == []


def test_final_lap_line_for_leader_in_laps_mode():
    c = cands(ev_lap(lap=9), st=state(laps_target=10))
    assert c and c[0].template_key == "final_lap" and c[0].priority == P.NORMAL


def test_invalid_lap_is_silent():
    assert cands(ev_lap().model_copy(update={"valid": False}), Verbosity.HIGH) == []


@pytest.mark.parametrize("lang", ["it", "en"])
def test_track_record_beaten_names_car_time_and_previous(lang):
    ev = TrackRecord(
        race_time_ms=1, address=0, lap_ms=5230, layout="x", previous_ms=6100, previous_holder="Blu"
    )
    (c,) = cands(ev, lang=lang)
    assert c.priority == P.HIGH and c.template_key == "track_record"
    assert "Fulmine" in c.text
    assert "{" not in c.text
    assert c.facts["previous_ms"] == 6100 and c.facts["layout"] == "x"


@pytest.mark.parametrize("lang", ["it", "en"])
def test_track_record_without_previous_is_normal_and_clean(lang):
    ev = TrackRecord(race_time_ms=1, address=1, lap_ms=5230, layout="x")
    for _ in range(10):
        (c,) = cands(ev, lang=lang)
        assert c.priority == P.NORMAL
        assert "Blu" in c.text and "{" not in c.text and "  " not in c.text
        assert "previous_ms" not in c.facts


def test_track_record_low_verbosity_keeps_beaten_but_not_first():
    beaten = TrackRecord(
        race_time_ms=1, address=0, lap_ms=5000, layout="x", previous_ms=6000, previous_holder="Blu"
    )
    first = TrackRecord(race_time_ms=1, address=0, lap_ms=5000, layout="x")
    assert cands(beaten, verbosity=Verbosity.LOW)
    assert cands(first, verbosity=Verbosity.LOW) == []


# ---------------------------------------------------------------- sectors


def _sector_state():
    st = state()
    st.num_sectors = 3
    return st


def _sector(address=0, overall=False, personal=False, sector=2):
    from app.race.models import SectorCompleted

    return SectorCompleted(
        address=address,
        lap_number=3,
        sector=sector,
        split_ms=2345,
        overall_best=overall,
        personal_best=personal,
    )


@pytest.mark.parametrize("lang", ["it", "en"])
def test_overall_best_sector_is_normal_priority_and_names_driver_and_sector(lang):
    result = cands(_sector(overall=True), lang=lang, st=_sector_state())
    assert len(result) == 1
    c = result[0]
    assert c.priority == P.NORMAL and c.template_key == "sector_best"
    assert "Fulmine" in c.text and ("due" if lang == "it" else "two") in c.text
    assert c.facts["overall"] is True and c.facts["sector"] == 2
    assert "{" not in c.text


def test_sector_without_best_is_silent_and_needs_sectors():
    assert cands(_sector(), st=_sector_state()) == []
    assert cands(_sector(overall=True), st=state()) == []  # num_sectors == 1


@pytest.mark.parametrize("lang", ["it", "en"])
def test_low_verbosity_drops_sectors(lang):
    assert cands(_sector(overall=True), Verbosity.LOW, lang, _sector_state()) == []


def test_personal_sector_only_for_leader_at_high_verbosity():
    pb = _sector(address=0, personal=True)
    assert cands(pb, Verbosity.NORMAL, st=_sector_state()) == []
    high = cands(pb, Verbosity.HIGH, st=_sector_state())
    assert len(high) == 1 and high[0].priority == P.LOW
    assert cands(_sector(address=1, personal=True), Verbosity.HIGH, st=_sector_state()) == []


def test_context_has_sector_facts():
    from app.commentary.context import build_context, summarise_event
    from app.race.models import CarConfig, CarState, RaceState

    st = RaceState(num_sectors=3, best_sectors=[2000, None, 2500])
    st.cars = [
        CarState(
            address=1,
            name="Blu",
            color="#00f",
            position=1,
            current_sectors=[2100, None, None],
            last_sectors=[2000, 2200, 2500],
        )
    ]
    cars = {1: CarConfig(address=1, name="Blu")}
    ctx = build_context(st, cars, "en", 1, "sector_best", [])
    assert set(ctx["involved_car"]["current_lap_sectors"]) == {"1"}
    assert set(ctx["involved_car"]["last_lap_sectors"]) == {"1", "2", "3"}
    assert set(ctx["best_sectors_overall"]) == {"1", "3"} and ctx["num_sectors"] == 3
    assert "2345" not in str(ctx)
    summary = summarise_event(_sector(address=1, overall=True), cars, "en")
    assert summary["sector"] == 2 and summary["overall_best"] is True and "split_time" in summary
    # no Check Lanes: nothing sector-related in the prompt
    plain = build_context(RaceState(cars=st.cars), cars, "en", 1, "lap_completed", [])
    assert "best_sectors_overall" not in plain
    assert "current_lap_sectors" not in plain["involved_car"]


# ---------------------------------------------------------------- fuel strategy / pit missed


def _strategy_state(must_pit=True):
    from app.race.models import FuelStrategy

    st = state()
    st.cars[0].fuel_strategy = FuelStrategy(
        per_lap=2.0, laps_left=3.4, laps_to_go=8, must_pit=must_pit, pit_by_lap=6
    )
    return st


@pytest.mark.parametrize("lang", ["it", "en"])
def test_pit_missed_line_is_normal_priority_with_facts(lang):
    from app.race.models import PitMissed

    event = PitMissed(address=1, stops=0, required=1, penalty_ms=30_000)
    [cand] = cands(event, lang=lang)
    assert cand.priority == P.NORMAL and cand.template_key == "pit_missed"
    assert "Blu" in cand.text
    assert cand.facts["stops"] == 0 and cand.facts["penalty_ms"] == 30_000


@pytest.mark.parametrize("lang", ["it", "en"])
def test_strategy_line_once_per_car_per_race(lang):
    told: set[int] = set()
    st = _strategy_state()
    event = ev_lap(address=0)

    def run():
        return candidates(event, st, CARS, Verbosity.NORMAL, lang, TemplateBook(), told)

    first = [c for c in run() if c.template_key == "fuel_strategy"]
    assert len(first) == 1 and first[0].priority == P.NORMAL
    assert "Fulmine" in first[0].text
    assert first[0].facts["must_pit"] and first[0].facts["pit_by_lap"] == 6
    assert [c for c in run() if c.template_key == "fuel_strategy"] == []  # rate limited
    told.clear()  # a new race
    assert [c for c in run() if c.template_key == "fuel_strategy"]


def test_no_strategy_line_without_must_pit_or_without_the_tracker():
    told: set[int] = set()
    event = ev_lap(address=0)
    ok = candidates(event, _strategy_state(False), CARS, Verbosity.NORMAL, "en", None, told)
    assert not [c for c in ok if c.template_key == "fuel_strategy"] and not told
    no_tracker = candidates(event, _strategy_state(), CARS, Verbosity.NORMAL, "en")
    assert not [c for c in no_tracker if c.template_key == "fuel_strategy"]
    low = candidates(event, _strategy_state(), CARS, Verbosity.LOW, "en", None, told)
    assert not [c for c in low if c.template_key == "fuel_strategy"] and not told


def test_context_carries_laps_left_and_must_pit():
    from app.commentary.context import build_context

    st = _strategy_state()
    st.cars[0].fuel = 6
    ctx = build_context(st, CARS, "en", 0, "fuel_strategy", [])
    car = ctx["involved_car"]
    assert car["laps_left"] == 3.4 and car["must_pit"] is True and car["pit_by_lap"] == 6
