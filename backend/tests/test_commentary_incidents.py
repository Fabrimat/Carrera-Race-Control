"""Commentary for incidents (docs/PROTOCOL.md "Incidents": priorities, place, LLM facts)."""

from __future__ import annotations

import pytest

from app.commentary.context import build_context, summarise_event
from app.commentary.events import TemplateBook, candidates
from app.race.models import (
    CarState,
    CommentaryPriority,
    Incident,
    IncidentCleared,
    IncidentStarted,
    Verbosity,
)
from tests.test_commentary_fakes import CARS, state

P = CommentaryPriority


def started(count: int = 1, from_sensor: int | None = 1, to_sensor: int | None = 1, **kw):
    return IncidentStarted(
        address=0,
        source=kw.get("source", "overdue"),
        from_sensor=from_sensor,
        to_sensor=to_sensor,
        count=count,
    )


def cands(event, lang="en", verbosity=Verbosity.NORMAL, st=None):
    return candidates(event, st or state(), CARS, verbosity, lang, TemplateBook())


@pytest.mark.parametrize("lang", ["en", "it"])
def test_incident_started_is_high_priority_and_names_the_driver(lang):
    [c] = cands(started(), lang)
    assert c.priority == P.HIGH and c.template_key == "incident_started"
    assert "Fulmine" in c.text  # the nickname of car 0
    assert c.address == 0
    assert c.facts["driver"] == "Fulmine" and c.facts["count"] == 1
    assert c.facts["source"] == "overdue"
    assert "{" not in c.text


@pytest.mark.parametrize("lang", ["en", "it"])
def test_incident_started_survives_low_verbosity(lang):
    assert cands(started(), lang, Verbosity.LOW)


@pytest.mark.parametrize("lang", ["en", "it"])
def test_a_repeat_incident_says_the_count(lang):
    st = state()
    for _ in range(10):  # every variant of the key mentions the count
        [c] = cands(started(count=3), lang, st=st)
        assert c.template_key == "incident_again"
        assert c.priority == P.HIGH
        assert c.facts["count"] == 3
        assert ("three" if lang == "en" else "tre") in c.text


@pytest.mark.parametrize(
    ("stretch", "sector"),
    [((1, 2), 1), ((2, 3), 2), ((3, 1), 3), ((1, 3), 1), ((2, 1), 3)],
)
def test_the_place_comes_from_the_sensors(stretch, sector):
    st = state()
    st.num_sectors = 3
    [c] = cands(started(from_sensor=stretch[0], to_sensor=stretch[1]), "en", st=st)
    assert c.facts["sector"] == sector


def test_no_place_without_check_lanes_and_sector_variants_use_it():
    [c] = cands(started(from_sensor=1, to_sensor=1))
    assert "sector" not in c.facts
    assert "sector" not in c.text.lower()
    st = state()
    st.num_sectors = 3
    texts = set()
    for _ in range(30):
        [c] = candidates(
            started(from_sensor=2, to_sensor=3), st, CARS, Verbosity.NORMAL, "en", TemplateBook()
        )
        texts.add(c.text)
    assert any("sector two" in t for t in texts)


@pytest.mark.parametrize("lang", ["en", "it"])
def test_incident_cleared_is_normal_priority(lang):
    event = IncidentCleared(address=1, by="crossing", lost_ms=21000)
    [c] = cands(event, lang)
    assert c.priority == P.NORMAL and c.template_key == "incident_cleared"
    assert "Blu" in c.text
    assert c.facts["lost_ms"] == 21000 and c.facts["by"] == "crossing"
    assert cands(IncidentCleared(address=1, by="marshal", lost_ms=5000), lang)


def test_nothing_is_said_when_the_race_ends_with_an_incident():
    assert cands(IncidentCleared(address=1, by="race_end", lost_ms=5000)) == []


def test_cleared_is_dropped_in_low_verbosity():
    event = IncidentCleared(address=1, by="crossing", lost_ms=21000)
    assert cands(event, verbosity=Verbosity.LOW) == []


def test_llm_facts_carry_incidents_per_car():
    st = state()
    st.cars = [
        CarState(
            address=0,
            name="Rosso",
            color="#f00",
            position=1,
            laps=3,
            incidents=2,
            incident_lost_ms=21000,
            incident=Incident(started_race_ms=40000, source="overdue"),
        ),
        CarState(address=1, name="Blu", color="#00f", position=2, laps=3),
    ]
    ctx = build_context(st, CARS, "en", 0, "incident_started", [])
    car = ctx["involved_car"]
    assert car["incidents"] == 2 and car["off_track"] is True
    assert "incident_lost_time" in car and "21000" not in str(ctx)
    assert "incidents" not in ctx["standings"][1]
    assert ctx["standings"][0]["incidents"] == 2


def test_event_summaries():
    s = summarise_event(started(count=2, source="marshal"), CARS, "en")
    assert s["event"] == "incident_started" and s["count"] == 2 and s["source"] == "marshal"
    assert s["driver"] == "Fulmine"
    c = summarise_event(IncidentCleared(address=1, by="crossing", lost_ms=9000), CARS, "en")
    assert c["by"] == "crossing" and "lost_time" in c and c["driver"] == "Blu"
