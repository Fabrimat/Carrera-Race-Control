"""Line writers: turn a commentary candidate into the final spoken text.

`TemplateWriter` returns the template text. `AnthropicWriter` asks an LLM for a more
varied line in the configured language and falls back to the template text on any
failure. The director only uses a writer for LOW priority lines.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Protocol

from app.commentary.events import LANGUAGES, Candidate

log = logging.getLogger(__name__)

DEFAULT_MODEL = "claude-haiku-5-5"


class LineWriter(Protocol):
    async def write_line(self, candidate: Candidate, context: dict[str, Any]) -> str:
        """Return the text to speak. Must not raise; return `candidate.text` on failure."""
        ...


class TemplateWriter:
    async def write_line(self, candidate: Candidate, context: dict[str, Any]) -> str:
        return candidate.text


def build_system_prompt(language: str) -> str:
    lang_name = getattr(LANGUAGES.get(language), "LANGUAGE_NAME", "Italian")
    return (
        f"You are an enthusiastic {lang_name} race commentator for a slot car track. "
        f"Write the commentary line in {lang_name}, 1 or 2 short sentences, "
        "suitable to be read aloud. Use ONLY the facts provided in the JSON, never invent "
        "names, numbers, times or events. Times in the facts are milliseconds: if you "
        "mention them, spell them as seconds. Reply with the line only, no quotes."
    )


class AnthropicWriter:
    def __init__(
        self,
        api_key: str,
        model: str = DEFAULT_MODEL,
        timeout_s: float = 1.5,
        client: Any | None = None,
    ) -> None:
        self.model = model
        self.timeout_s = timeout_s
        self._warned = False
        if client is not None:
            self._client = client
        else:
            from anthropic import AsyncAnthropic

            self._client = AsyncAnthropic(api_key=api_key, timeout=timeout_s, max_retries=0)

    async def write_line(self, candidate: Candidate, context: dict[str, Any]) -> str:
        facts = {
            **candidate.facts,
            **{k: v for k, v in context.items() if k not in candidate.facts},
        }
        try:
            response = await asyncio.wait_for(
                self._client.messages.create(
                    model=self.model,
                    max_tokens=120,
                    system=build_system_prompt(candidate.language),
                    messages=[{"role": "user", "content": json.dumps(facts, ensure_ascii=False)}],
                ),
                timeout=self.timeout_s,
            )
            text = "".join(
                getattr(block, "text", "") for block in getattr(response, "content", [])
            ).strip()
            return text or candidate.text
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - never let the LLM break commentary
            if not self._warned:
                self._warned = True
                log.warning("LLM writer failed (%s), using templates", type(exc).__name__)
            return candidate.text
