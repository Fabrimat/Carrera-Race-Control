import asyncio
import json
from types import SimpleNamespace

import pytest

from app.commentary.events import Candidate
from app.commentary.llm import (
    AnthropicWriter,
    LineWriter,
    OpenAIWriter,
    TemplateWriter,
    build_system_prompt,
)
from app.race.models import CommentaryPriority


def cand(lang="it") -> Candidate:
    return Candidate(
        text="template text",
        priority=CommentaryPriority.LOW,
        event_type="lap_completed",
        template_key="lap_completed",
        facts={"driver": "Rosso", "lap_ms": 7342},
        language=lang,
    )


def text_block(text):
    return SimpleNamespace(type="text", text=text)


class FakeMessages:
    def __init__(self, behaviour):
        self.behaviour = behaviour
        self.kwargs = None

    async def create(self, **kwargs):
        self.kwargs = kwargs
        return await self.behaviour()


def writer_with(behaviour, **kw):
    messages = FakeMessages(behaviour)
    client = SimpleNamespace(messages=messages)
    return AnthropicWriter("key-not-used", client=client, **kw), messages


async def test_template_writer_returns_template_text():
    writer: LineWriter = TemplateWriter()
    assert await writer.write_line(cand(), {}) == "template text"


async def test_llm_text_used_and_prompt_has_language_and_facts():
    async def ok():
        return SimpleNamespace(content=[text_block("  Great lap, Rosso!  ")])

    writer, messages = writer_with(ok)
    assert await writer.write_line(cand("en"), {"leader_lap": 4}) == "Great lap, Rosso!"
    assert "English" in messages.kwargs["system"]
    payload = json.loads(messages.kwargs["messages"][0]["content"])
    assert payload["event"]["driver"] == "Rosso"
    assert payload["event"]["lap_time"] == "seven point three four seconds"
    assert "lap_ms" not in payload["event"]
    assert payload["race"]["leader_lap"] == 4
    assert messages.kwargs["model"] == "claude-haiku-5-5"
    assert messages.kwargs["max_tokens"] == 120


async def test_thinking_is_disabled():
    async def ok():
        return SimpleNamespace(content=[text_block("x")])

    writer, messages = writer_with(ok)
    await writer.write_line(cand(), {})
    assert messages.kwargs["thinking"] == {"type": "disabled"}


async def test_thinking_only_response_falls_back_to_template():
    async def thinking_only():
        return SimpleNamespace(
            content=[SimpleNamespace(type="thinking", thinking="hmm", text="ignored")]
        )

    writer, _ = writer_with(thinking_only)
    assert await writer.write_line(cand(), {}) == "template text"


async def test_text_extracted_only_from_text_blocks():
    async def mixed():
        return SimpleNamespace(
            content=[
                SimpleNamespace(type="thinking", thinking="hmm"),
                text_block("Che giro, "),
                text_block("Rosso!"),
            ]
        )

    writer, _ = writer_with(mixed)
    assert await writer.write_line(cand(), {}) == "Che giro, Rosso!"


async def test_prompt_is_in_the_right_language_with_standings_and_recent_lines():
    async def ok():
        return SimpleNamespace(content=[text_block("ok")])

    context = {
        "standings": [{"driver": "Rosso", "position": 1, "laps": 3}],
        "recent_lines": ["Rosso vola in pista."],
    }
    writer, messages = writer_with(ok)
    await writer.write_line(cand("it"), context)
    system = messages.kwargs["system"]
    assert "italiano" in system and "recent_lines" in system and "18" in system
    content = messages.kwargs["messages"][0]["content"]
    assert "Rosso vola in pista." in content and '"standings"' in content
    assert "sette" in content  # 7342 ms is passed already spoken in Italian
    assert "English" in build_system_prompt("en")
    assert "italiano" not in build_system_prompt("en")


async def test_llm_timeout_falls_back_to_template():
    async def slow():
        await asyncio.sleep(5)

    writer, _ = writer_with(slow, timeout_s=0.05)
    assert await writer.write_line(cand(), {}) == "template text"


async def test_llm_error_or_empty_falls_back_to_template():
    async def boom():
        raise RuntimeError("api down")

    async def empty():
        return SimpleNamespace(content=[])

    for behaviour in (boom, empty):
        writer, _ = writer_with(behaviour)
        assert await writer.write_line(cand(), {}) == "template text"


async def test_model_overridable():
    async def ok():
        return SimpleNamespace(content=[text_block("x")])

    writer, messages = writer_with(ok, model="other-model")
    await writer.write_line(cand(), {})
    assert messages.kwargs["model"] == "other-model"


async def test_overlong_line_falls_back_to_template():
    async def long_line():
        return SimpleNamespace(content=[text_block(" ".join(["parola"] * 27))])

    async def ok_line():
        return SimpleNamespace(content=[text_block(" ".join(["parola"] * 26))])

    writer, _ = writer_with(long_line)
    assert await writer.write_line(cand(), {}) == "template text"
    writer, _ = writer_with(ok_line)
    assert await writer.write_line(cand(), {}) != "template text"


def test_fuel_state_is_qualitative_and_the_raw_number_is_dropped():
    from app.commentary.context import fuel_state, verbalise_facts

    assert [fuel_state(f, 3, "it") for f in (0, 1, 2, 3, 8, 12, 15)] == [
        "quasi a secco", "quasi a secco", "riserva", "riserva", "metà", "pieno", "pieno",
    ]  # fmt: skip
    assert fuel_state(2, 3, "en") == "low" and fuel_state(None, 3, "en") is None
    assert fuel_state(9, 3, "en") == "half" and fuel_state(14, 3, "en") == "full"
    assert fuel_state(0, 3, "en") == "almost empty"
    assert "fuel" not in verbalise_facts({"fuel": 2, "driver": "Blu"}, "it")


def test_context_carries_fuel_state_for_fuel_events():
    from app.commentary.context import build_context
    from app.race.models import CarConfig, CarState, RaceState

    st = RaceState()
    st.cars = [CarState(address=1, name="Blu", color="#00f", position=1, fuel=2)]
    cars = {1: CarConfig(address=1, name="Blu")}
    ctx = build_context(st, cars, "it", 1, "low_fuel", [])
    assert ctx["involved_car"]["fuel_state"] == "riserva"
    ctx = build_context(st, cars, "en", 1, "lap_completed", [])
    assert "fuel_state" not in ctx["involved_car"]


class ApiError(Exception):
    def __init__(self, status_code):
        super().__init__(f"HTTP {status_code}")
        self.status_code = status_code


def failing_writer(status):
    from tests.test_commentary_fakes import FakeClock

    calls = []
    clock = FakeClock(1000.0)

    async def create(**kwargs):
        calls.append(kwargs)
        if state["fail"]:
            raise ApiError(status)
        return SimpleNamespace(content=[text_block("ok")])

    state = {"fail": True}
    client = SimpleNamespace(messages=SimpleNamespace(create=create))
    return AnthropicWriter("k", client=client, clock=clock), calls, clock, state


async def test_rate_limit_backs_off_45s_then_recovers():
    writer, calls, clock, state = failing_writer(429)
    assert writer.available
    assert await writer.write_line(cand(), {}) == "template text"
    assert not writer.available and len(calls) == 1
    clock.advance(44)
    assert await writer.write_line(cand(), {}) == "template text"
    assert len(calls) == 1  # no API call while backing off
    clock.advance(1.5)
    state["fail"] = False
    assert writer.available
    assert await writer.write_line(cand(), {}) == "ok" and len(calls) == 2


async def test_generic_error_backs_off_15s():
    writer, calls, clock, _ = failing_writer(500)
    await writer.write_line(cand(), {})
    assert not writer.available
    clock.advance(14)
    assert not writer.available
    clock.advance(1.5)
    assert writer.available and len(calls) == 1


async def test_auth_error_disables_the_writer_for_the_session():
    writer, calls, clock, _ = failing_writer(401)
    await writer.write_line(cand(), {})
    clock.advance(10_000)
    assert not writer.available
    assert await writer.write_line(cand(), {}) == "template text" and len(calls) == 1


# --------------------------------------------------------------------------- OpenAIWriter


def out_text(text):
    block = SimpleNamespace(type="output_text", text=text)
    message = SimpleNamespace(type="message", content=[block])
    return SimpleNamespace(output=[SimpleNamespace(type="reasoning"), message])


class FakeResponses:
    def __init__(self, behaviour):
        self.behaviour = behaviour
        self.kwargs = None

    async def create(self, **kwargs):
        self.kwargs = kwargs
        return await self.behaviour()


def openai_writer(behaviour, **kw):
    responses = FakeResponses(behaviour)
    client = SimpleNamespace(responses=responses)
    return OpenAIWriter("key-not-used", client=client, **kw), responses


async def test_openai_text_used_with_the_same_prompt_and_context():
    async def ok():
        return out_text("  Great lap, Rosso!  ")

    writer, responses = openai_writer(ok)
    assert await writer.write_line(cand("en"), {"leader_lap": 4}) == "Great lap, Rosso!"
    kwargs = responses.kwargs
    assert kwargs["instructions"] == build_system_prompt("en")
    payload = json.loads(kwargs["input"])
    assert payload["event"]["lap_time"] == "seven point three four seconds"
    assert payload["race"]["leader_lap"] == 4
    assert kwargs["model"] == "gpt-5.4-mini"
    assert kwargs["reasoning"] == {"effort": "none"}
    assert kwargs["max_output_tokens"] == 300
    assert kwargs["store"] is False


async def test_openai_text_only_from_output_text_blocks():
    async def mixed():
        return SimpleNamespace(
            output=[
                SimpleNamespace(
                    type="reasoning", content=[SimpleNamespace(type="output_text", text="no")]
                ),
                SimpleNamespace(
                    type="message",
                    content=[
                        SimpleNamespace(type="output_text", text="Che giro, "),
                        SimpleNamespace(type="refusal", refusal="x"),
                        SimpleNamespace(type="output_text", text="Rosso!"),
                    ],
                ),
            ]
        )

    writer, _ = openai_writer(mixed)
    assert await writer.write_line(cand(), {}) == "Che giro, Rosso!"


async def test_openai_empty_overlong_error_and_timeout_fall_back():
    async def empty():
        return SimpleNamespace(output=[])

    async def long():
        return out_text("word " * 30)

    async def slow():
        await asyncio.sleep(1)

    async def boom():
        raise RuntimeError("down")

    for behaviour in (empty, long):
        writer, _ = openai_writer(behaviour)
        assert await writer.write_line(cand(), {}) == "template text"
    writer, _ = openai_writer(slow, timeout_s=0.05)
    assert await writer.write_line(cand(), {}) == "template text"
    assert writer.available  # a timeout is not an API error
    writer, _ = openai_writer(boom)
    assert await writer.write_line(cand(), {}) == "template text"
    assert not writer.available


def failing_openai_writer(status):
    from tests.test_commentary_fakes import FakeClock

    calls = []
    clock = FakeClock(1000.0)
    state = {"fail": True}

    async def create(**kwargs):
        calls.append(kwargs)
        if state["fail"]:
            raise ApiError(status)
        return out_text("ok")

    client = SimpleNamespace(responses=SimpleNamespace(create=create))
    return OpenAIWriter("k", client=client, clock=clock), calls, clock, state


async def test_openai_rate_limit_backs_off_45s_then_recovers():
    writer, calls, clock, state = failing_openai_writer(429)
    assert await writer.write_line(cand(), {}) == "template text"
    assert not writer.available and len(calls) == 1
    clock.advance(44)
    assert await writer.write_line(cand(), {}) == "template text"
    assert len(calls) == 1
    clock.advance(1.5)
    state["fail"] = False
    assert await writer.write_line(cand(), {}) == "ok" and len(calls) == 2


async def test_openai_generic_error_backs_off_15s():
    writer, calls, clock, _ = failing_openai_writer(500)
    await writer.write_line(cand(), {})
    clock.advance(14)
    assert not writer.available
    clock.advance(1.5)
    assert writer.available and len(calls) == 1


async def test_openai_connection_error_backs_off_15s():
    writer, _, clock, _ = failing_openai_writer(None)  # no status_code: a connection error
    await writer.write_line(cand(), {})
    assert not writer.available
    clock.advance(15.5)
    assert writer.available


@pytest.mark.parametrize("status", [401, 403])
async def test_openai_auth_error_disables_the_writer_for_the_session(status):
    writer, calls, clock, _ = failing_openai_writer(status)
    await writer.write_line(cand(), {})
    clock.advance(10_000)
    assert not writer.available
    assert await writer.write_line(cand(), {}) == "template text" and len(calls) == 1


async def test_openai_incomplete_response_falls_back_and_warns_once(caplog):
    async def incomplete():
        return SimpleNamespace(
            status="incomplete",
            incomplete_details=SimpleNamespace(reason="max_output_tokens"),
            output=[SimpleNamespace(type="reasoning")],
        )

    writer, _ = openai_writer(incomplete)
    with caplog.at_level("WARNING"):
        assert await writer.write_line(cand(), {}) == "template text"
        assert await writer.write_line(cand(), {}) == "template text"
    warnings = [r for r in caplog.records if "incomplete" in r.getMessage()]
    assert len(warnings) == 1 and "max_output_tokens" in warnings[0].getMessage()
    assert writer.available  # not an API error: no backoff
