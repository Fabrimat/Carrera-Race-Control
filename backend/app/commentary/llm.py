"""Line writers: turn a commentary candidate into the final spoken text.

`TemplateWriter` returns the template text. `AnthropicWriter` and `OpenAIWriter` ask an LLM
to write the line from the live race situation, in the configured language, and falls back to the
template text on any failure (timeout, error, empty or thinking-only answer). The
director uses it for every priority when `llm_enabled` is on.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from collections.abc import Callable
from typing import Any, Protocol

from app.commentary.context import verbalise_facts
from app.commentary.events import DEFAULT_LANGUAGE, Candidate

log = logging.getLogger(__name__)

DEFAULT_MODEL = "claude-haiku-5-5"
DEFAULT_OPENAI_MODEL = "gpt-5.4-mini"
RATE_LIMIT_BACKOFF_S = 45.0
ERROR_BACKOFF_S = 15.0
MAX_WORDS = 26  # hard cap on the LLM line; longer text falls back to the template


class LineWriter(Protocol):
    async def write_line(self, candidate: Candidate, context: dict[str, Any]) -> str:
        """Return the text to speak. Must not raise; return `candidate.text` on failure."""
        ...


class TemplateWriter:
    available = False  # nothing to generate: the director skips the background task

    async def write_line(self, candidate: Candidate, context: dict[str, Any]) -> str:
        return candidate.text


_PROMPTS = {
    "en": (
        "You are an energetic English TV race commentator at a slot car track. "
        "Write ONE commentary line for the event in the JSON, to be read aloud. "
        "Use ONLY the facts in the JSON: never invent names, numbers, times or events. "
        "Exactly one short spoken sentence, at most 18 words (count them, shorten if longer); "
        "two sentences only for race_finished or track_record. "
        "Mention a time only when it is the news (best lap, record, the leader's lap time); "
        "times are already spelled out, copy them as written. "
        "Prefer the nickname when there is one. "
        "Report only the event itself, no extra clauses, no predictions. Sound natural and punchy. "
        "No emoji, no markdown, no quotes. "
        "Do not repeat the wording of the lines in recent_lines. "
        "Examples: "
        "Fulmine takes the lead, what a move! | "
        "Blu is running on fumes, the pit lane is calling. | "
        "New fastest lap for Fulmine, seven point one two seconds! "
        "Reply with the line only."
    ),
    "it": (
        "Sei un telecronista italiano di corse in TV, energico, a una pista di automobiline "
        "slot. "
        "Scrivi UNA riga di commento per l'evento descritto nel JSON, da leggere ad alta voce. "
        "Usa SOLO i fatti presenti nel JSON: non inventare mai nomi, numeri, tempi o eventi. "
        "Esattamente una frase breve e parlata, al massimo 18 parole (contale, accorcia se serve); "
        "due frasi solo per race_finished o track_record. "
        "Cita un tempo solo quando è la notizia (giro veloce, record, tempo del leader); "
        "i tempi sono già scritti in lettere: copiali come sono. "
        "Preferisci il soprannome quando c'è. "
        "Racconta solo l'evento, senza frasi aggiuntive né previsioni. Tono naturale e incisivo. "
        "Niente emoji, niente markdown, niente virgolette. "
        "Non ripetere le parole delle frasi in recent_lines. "
        "Esempi: "
        "Fulmine passa al comando, che manovra! | "
        "Blu è a secco, i box lo aspettano. | "
        "Nuovo giro veloce per Fulmine, sette secondi e dodici! "
        "Rispondi solo con la frase, in italiano."
    ),
}


# Event mode: the program's tone selects the style; the "use ONLY the facts" rule stays.
_TONES = {
    "en": {
        "family": "Style: warm and family friendly, suitable for children; never mock anyone.",
        "enthusiastic": "Style: enthusiastic and lively, like a big race on TV.",
        "technical": "Style: precise and technical; favour times, gaps and sectors over hype.",
        "ironic": "Style: light, good-natured irony; never offensive.",
    },
    "it": {
        "family": "Stile: caldo e adatto alle famiglie e ai bambini; non prendere in giro nessuno.",
        "enthusiastic": "Stile: entusiasta e vivace, come una grande gara in TV.",
        "technical": "Stile: preciso e tecnico; privilegia tempi, distacchi e settori.",
        "ironic": "Stile: ironia leggera e bonaria; mai offensiva.",
    },
}
_EVENT_RULE = {
    "en": (
        "The JSON may contain an event block (event name, location, session, driver bios, "
        "starting grid, sponsors, notes): use at most one of those details, only when it fits; "
        "mention a sponsor only if sponsors are listed there."
    ),
    "it": (
        "Il JSON può contenere un blocco event (nome evento, luogo, sessione, biografie dei "
        "piloti, griglia di partenza, sponsor, note): usa al massimo uno di quei dettagli, solo "
        "se è pertinente; cita uno sponsor solo se è elencato lì."
    ),
}


def build_system_prompt(language: str, tone: str | None = None) -> str:
    """The commentator prompt; ``tone`` (event mode) adds the style and the event-block rule."""
    lang = language if language in _PROMPTS else DEFAULT_LANGUAGE
    prompt = _PROMPTS[lang]
    if tone is None:
        return prompt
    style = _TONES[lang].get(tone, "")
    return " ".join(part for part in (prompt, _EVENT_RULE[lang], style) if part)


def build_user_message(candidate: Candidate, context: dict[str, Any]) -> str:
    payload = {
        "event": verbalise_facts(candidate.facts, candidate.language),
        "race": context,
    }
    return json.dumps(payload, ensure_ascii=False)


class AnthropicWriter:
    def __init__(
        self,
        api_key: str,
        model: str = DEFAULT_MODEL,
        timeout_s: float = 2.5,
        client: Any | None = None,
        max_tokens: int = 120,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.model = model
        self.timeout_s = timeout_s
        self.max_tokens = max_tokens
        self._clock = clock
        self._backoff_until = 0.0
        self._disabled = False
        self._logged: set[str] = set()
        if client is not None:
            self._client = client
        else:
            from anthropic import AsyncAnthropic

            self._client = AsyncAnthropic(api_key=api_key, timeout=timeout_s, max_retries=0)

    @property
    def available(self) -> bool:
        """False while backing off after an API error or once the key was rejected."""
        return not self._disabled and self._clock() >= self._backoff_until

    def _log_once(self, key: str, message: str, *args: Any) -> None:
        if key not in self._logged:
            self._logged.add(key)
            log.warning(message, *args)

    def _handle_error(self, exc: Exception) -> None:
        status = getattr(exc, "status_code", None)
        if status in (401, 403):
            self._disabled = True
            self._log_once("auth", "Anthropic rejected the API key (HTTP %s), LLM off", status)
        elif status == 429:
            self._backoff_until = self._clock() + RATE_LIMIT_BACKOFF_S
            self._log_once("429", "Anthropic rate limit (429), using templates for a while")
        else:
            self._backoff_until = self._clock() + ERROR_BACKOFF_S
            self._log_once(
                f"err:{type(exc).__name__}",
                "Anthropic error (%s), using templates for a while",
                type(exc).__name__,
            )

    async def write_line(self, candidate: Candidate, context: dict[str, Any]) -> str:
        if not self.available:
            return candidate.text
        try:
            response = await asyncio.wait_for(
                self._client.messages.create(
                    model=self.model,
                    max_tokens=self.max_tokens,
                    # Newer Haiku models otherwise spend the whole budget on a thinking block.
                    thinking={"type": "disabled"},
                    system=build_system_prompt(candidate.language, candidate.tone),
                    messages=[{"role": "user", "content": build_user_message(candidate, context)}],
                ),
                timeout=self.timeout_s,
            )
            text = "".join(
                getattr(block, "text", "") or ""
                for block in getattr(response, "content", [])
                if getattr(block, "type", None) == "text"
            )
            text = text.strip().strip("\"'«»“”").strip()
            if not text:
                return candidate.text
            if len(text.split()) > MAX_WORDS:
                log.debug("LLM line too long (%d words), using template", len(text.split()))
                return candidate.text
            return text
        except asyncio.CancelledError:
            raise
        except TimeoutError:
            self._log_once("timeout", "Anthropic call timed out, using template text")
            return candidate.text
        except Exception as exc:  # noqa: BLE001 - never let the LLM break commentary
            self._handle_error(exc)
            return candidate.text


class OpenAIWriter:
    """Same behaviour as :class:`AnthropicWriter`, through the OpenAI Responses API."""

    def __init__(
        self,
        api_key: str,
        model: str = DEFAULT_OPENAI_MODEL,
        timeout_s: float = 2.5,
        client: Any | None = None,
        max_output_tokens: int = 300,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.model = model
        self.timeout_s = timeout_s
        # Reasoning models count their reasoning tokens in this budget too.
        self.max_output_tokens = max_output_tokens
        self._clock = clock
        self._backoff_until = 0.0
        self._disabled = False
        self._logged: set[str] = set()
        if client is not None:
            self._client = client
        else:
            from openai import AsyncOpenAI

            self._client = AsyncOpenAI(api_key=api_key, timeout=timeout_s, max_retries=0)

    @property
    def available(self) -> bool:
        """False while backing off after an API error or once the key was rejected."""
        return not self._disabled and self._clock() >= self._backoff_until

    def _log_once(self, key: str, message: str, *args: Any) -> None:
        if key not in self._logged:
            self._logged.add(key)
            log.warning(message, *args)

    def _handle_error(self, exc: Exception) -> None:
        status = getattr(exc, "status_code", None)
        if status in (401, 403):
            self._disabled = True
            self._log_once("auth", "OpenAI rejected the API key (HTTP %s), LLM off", status)
        elif status == 429:
            self._backoff_until = self._clock() + RATE_LIMIT_BACKOFF_S
            self._log_once("429", "OpenAI rate limit (429), using templates for a while")
        else:
            self._backoff_until = self._clock() + ERROR_BACKOFF_S
            self._log_once(
                f"err:{type(exc).__name__}",
                "OpenAI error (%s), using templates for a while",
                type(exc).__name__,
            )

    async def write_line(self, candidate: Candidate, context: dict[str, Any]) -> str:
        if not self.available:
            return candidate.text
        try:
            response = await asyncio.wait_for(
                self._client.responses.create(
                    model=self.model,
                    instructions=build_system_prompt(candidate.language, candidate.tone),
                    input=build_user_message(candidate, context),
                    max_output_tokens=self.max_output_tokens,
                    # No reasoning: it would eat the output budget and add latency.
                    reasoning={"effort": "none"},
                    store=False,
                ),
                timeout=self.timeout_s,
            )
            text = response_text(response)
            text = text.strip().strip("\"'«»“”").strip()
            if not text:
                if getattr(response, "status", None) == "incomplete":
                    details = getattr(response, "incomplete_details", None)
                    self._log_once(
                        "incomplete",
                        "OpenAI response incomplete (%s), using template text",
                        getattr(details, "reason", None) or "unknown reason",
                    )
                return candidate.text
            if len(text.split()) > MAX_WORDS:
                log.debug("LLM line too long (%d words), using template", len(text.split()))
                return candidate.text
            return text
        except asyncio.CancelledError:
            raise
        except TimeoutError:
            self._log_once("timeout", "OpenAI call timed out, using template text")
            return candidate.text
        except Exception as exc:  # noqa: BLE001 - never let the LLM break commentary
            self._handle_error(exc)
            return candidate.text


def response_text(response: Any) -> str:
    """The visible text of a Responses API reply (output_text blocks; reasoning is skipped)."""
    parts: list[str] = []
    for item in getattr(response, "output", None) or []:
        if getattr(item, "type", None) != "message":
            continue
        for block in getattr(item, "content", None) or []:
            if getattr(block, "type", None) == "output_text":
                parts.append(getattr(block, "text", "") or "")
    return "".join(parts)
