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
