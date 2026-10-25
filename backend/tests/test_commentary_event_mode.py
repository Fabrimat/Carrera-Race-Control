"""Event-mode commentary: templates, event facts block, tone, avoid_words, sponsor rate limit."""

from __future__ import annotations

from typing import Any

import pytest

from app.commentary.context import build_event_commentary, mentions_any
from app.commentary.events import TemplateBook, candidates
from app.commentary.llm import _PROMPTS, build_system_prompt
from app.race.models import (
    CommentaryContext,
    CommentaryPriority,
    CommentarySettings,
    Driver,
    EventProgram,
    FalseStart,
    RaceFinished,
    SessionFinished,
    SessionInfo,
    SessionKind,
    SessionSpec,
    Verbosity,
)
from tests.test_commentary_fakes import CARS, ev_lap, make_director, state

P = CommentaryPriority


def cands(event, lang="en", st=None):
    return candidates(event, st or state(), CARS, Verbosity.NORMAL, lang, TemplateBook())


def session_state(kind: SessionKind = SessionKind.RACE, name: str = "Final"):
    st = state()
    st.session = SessionInfo(
        program_id="p",
        program_name="Cup",
        session_id="s1",
        kind=kind,
        name=name,
        index=0,
        total=2,
    )
    return st


# --------------------------------------------------------------------------- templates


@pytest.mark.parametrize("lang", ["en", "it"])
@pytest.mark.parametrize(
    ("event", "key"),
    [
        (FalseStart(address=0, action="warn"), "false_start_warn"),
        (FalseStart(address=None, action="warn"), "false_start_anon"),
        (FalseStart(address=1, action="penalty", penalty_ms=5000), "false_start_penalty"),
        (FalseStart(address=1, action="restart"), "false_start_restart"),
        (FalseStart(address=None, action="restart"), "false_start_restart_anon"),
    ],
)
def test_false_start_lines_by_action(lang, event, key):
    (cand,) = cands(event, lang)
    assert cand.template_key == key and cand.priority == P.HIGH
    assert "{" not in cand.text
    if event.address is not None:
        car = CARS[event.address]
        assert (car.nickname or car.name) in cand.text
    if event.action == "penalty":
        assert cand.facts["penalty_ms"] == 5000


def test_false_start_ignore_is_silent():
    assert cands(FalseStart(address=0, action="ignore")) == []


@pytest.mark.parametrize("lang", ["en", "it"])
@pytest.mark.parametrize(
    ("kind", "key"),
    [
        (SessionKind.RACE, "session_finished"),
        (SessionKind.QUALIFYING, "qualifying_finished"),
        (SessionKind.PRACTICE, "practice_finished"),
    ],
)
def test_session_finished_lines(lang, kind, key):
    event = SessionFinished(session_id="s1", kind=kind, order=[1, 0])
    (cand,) = cands(event, lang, session_state(kind))
    assert cand.template_key == key and cand.priority == P.HIGH
    assert "Blu" in cand.text and "{" not in cand.text
    if kind is SessionKind.QUALIFYING:
        assert cand.facts["pole_position"] == "Blu"


def test_race_finished_line_is_left_to_session_finished_during_an_event():
    assert cands(RaceFinished(winner=0, order=[0, 1]), st=session_state()) == []
    assert cands(RaceFinished(winner=0, order=[0, 1]))  # no event: as before


# --------------------------------------------------------------------------- facts block


def program() -> EventProgram:
    return EventProgram(
        id="cup",
        name="Cup",
        sessions=[
            SessionSpec(id="q", kind=SessionKind.QUALIFYING),
            SessionSpec(id="r", kind=SessionKind.RACE, name="Final", grid_from="q"),
        ],
        commentary=CommentaryContext(
            event_name="Anna's birthday",
            location="Milano",
            sponsors=["Pizzeria Da Gino"],
            tone="family",
            notes="Anna turns ten today.",
            avoid_words=["crash"],
        ),
    )


def test_event_block_has_event_session_bios_and_grid():
    prog = program()
    drivers = {0: Driver(id="anna", name="Anna Rossi", nickname="Anna", bio="Loves red cars.")}
    grid = {1: (1, "Marco"), 0: (2, "Anna")}
    info = build_event_commentary(prog, prog.sessions[1], 1, drivers, grid, CARS)
    facts = info.facts
    assert facts["event_name"] == "Anna's birthday"
    assert facts["location"] == "Milano"
    assert facts["notes"] == "Anna turns ten today."
    assert facts["session"] == {"kind": "race", "number": 2, "of": 2, "name": "Final"}
    assert facts["drivers"] == [
        {
            "driver": "Anna",
            "full_name": "Anna Rossi",
            "bio": "Loves red cars.",
            "car": "Fulmine",
            "starts_from": "P2",
        },
        {"driver": "Marco", "starts_from": "P1"},
    ]
    assert "sponsors" not in facts  # added by the director, rate limited
    assert info.tone == "family" and info.sponsors == ["Pizzeria Da Gino"]
    assert info.avoid_words == ["crash"]


def test_mentions_any_is_case_insensitive_whole_word():
    assert mentions_any("What a CRASH there!", ["crash"])
    assert not mentions_any("He crashed", ["crash"])
    assert mentions_any("Thanks to pizzeria da gino!", ["Pizzeria Da Gino"])
    assert not mentions_any("anything", ["", "  "])


def test_tone_selects_style_and_keeps_the_facts_rule():
    for lang in ("en", "it"):
        assert build_system_prompt(lang) == _PROMPTS[lang]  # no event: unchanged
        prompt = build_system_prompt(lang, "technical")
        assert prompt.startswith(_PROMPTS[lang])  # "use ONLY the facts" kept
        assert prompt != build_system_prompt(lang, "family")
    assert "ONLY" in build_system_prompt("en", "ironic")
    assert "irony" in build_system_prompt("en", "ironic")


# --------------------------------------------------------------------------- director


class RecordingWriter:
    def __init__(self, text: str) -> None:
        self.text = text
        self.calls: list[tuple[Any, dict[str, Any]]] = []

    async def write_line(self, candidate, context):
        self.calls.append((candidate, context))
        return self.text


def event_director(writer, info, **kwargs):
    return make_director(
        CommentarySettings(llm_enabled=True), writer=writer, event_info=lambda: info, **kwargs
    )


def info_for_tests():
    prog = program()
    return build_event_commentary(prog, prog.sessions[0], 0, {}, {}, CARS)


async def test_director_passes_event_block_and_tone_to_the_writer():
    writer = RecordingWriter("Fulmine flies at Anna's birthday!")
    director, sink, _ = event_director(writer, info_for_tests())
    await director.submit(ev_lap(lap=3), state())
    line = await director.step()
    assert line is not None and line.source == "llm"
    cand, ctx = writer.calls[0]
    assert cand.tone == "family"
    assert ctx["event"]["event_name"] == "Anna's birthday"
    assert ctx["event"]["sponsors"] == ["Pizzeria Da Gino"]


async def test_avoid_words_fall_back_to_the_template():
    writer = RecordingWriter("What a crash for Fulmine!")
    director, _, _ = event_director(writer, info_for_tests())
    await director.submit(ev_lap(lap=3), state())
    line = await director.step()
    assert line is not None and line.source == "template"
    assert "crash" not in line.text.lower()


async def test_sponsors_are_rate_limited_by_the_director():
    writer = RecordingWriter("Fulmine, powered by Pizzeria Da Gino!")
    director, sink, clock = event_director(writer, info_for_tests(), sponsor_interval_s=200)
    await director.submit(ev_lap(lap=3), state())
    first = await director.step()
    assert first is not None and first.source == "llm"
    clock.advance(30)
    await director.submit(ev_lap(lap=6), state())
    second = await director.step()
    # Not offered to the model, and a line naming a sponsor anyway is replaced.
    assert "sponsors" not in writer.calls[1][1]["event"]
    assert second is not None and second.source == "template"
    clock.advance(200)
    await director.submit(ev_lap(lap=9), state())
    third = await director.step()
    assert writer.calls[2][1]["event"]["sponsors"] == ["Pizzeria Da Gino"]
    assert third is not None and third.source == "llm"


async def test_without_event_nothing_changes():
    writer = RecordingWriter("What a crash!")
    director, _, _ = event_director(writer, None)
    await director.submit(ev_lap(lap=3), state())
    line = await director.step()
    assert line is not None and line.source == "llm"
    cand, ctx = writer.calls[0]
    assert cand.tone is None and "event" not in ctx
