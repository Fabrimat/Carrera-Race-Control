import asyncio
import json
from types import SimpleNamespace

from app.commentary.events import Candidate
from app.commentary.llm import AnthropicWriter, LineWriter, TemplateWriter, build_system_prompt
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
        return SimpleNamespace(content=[SimpleNamespace(text="  Great lap, Rosso!  ")])

    writer, messages = writer_with(ok)
    assert await writer.write_line(cand("en"), {"lap": 4}) == "Great lap, Rosso!"
    assert "English" in messages.kwargs["system"]
    payload = json.loads(messages.kwargs["messages"][0]["content"])
    assert payload["driver"] == "Rosso" and payload["lap"] == 4
    assert messages.kwargs["model"] == "claude-haiku-5-5"
    assert "Italian" in build_system_prompt("it")


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
        return SimpleNamespace(content=[SimpleNamespace(text="x")])

    writer, messages = writer_with(ok, model="other-model")
    await writer.write_line(cand(), {})
    assert messages.kwargs["model"] == "other-model"
