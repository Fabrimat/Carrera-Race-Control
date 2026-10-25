"""Commentary director: decides what is said, when, and streams the audio.

Rules: one line at a time; a line "occupies" the voice for its estimated duration
(chars / CHARS_PER_SECOND, min MIN_DURATION_S, or the real mp3 length once the TTS has
finished); cooldown between lines; bounded queue; stale lines are dropped; a HIGH line
interrupts a LOW/NORMAL one.

Limitation: overlap avoidance relies on that duration estimate (or the real mp3 length
when known). The director cannot observe actual playback in the browser, so a slow
network or a different speaking speed can still produce small gaps or overlaps.

With `llm_enabled`, an LLM writer rewrites EVERY line from the live race situation. The call
starts when the candidate is queued (a background task), so generation overlaps with the
line being spoken; at speaking time the director waits at most the per-priority deadline and
otherwise speaks the template text. Tasks of dropped lines are cancelled.

The scheduling logic lives in `step()` (driven by an injectable clock, deterministic in
tests); `run()` is just a loop around it. Nothing here raises on TTS/LLM failure.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import shutil
import time
import uuid
from collections import OrderedDict, deque
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from app.commentary.context import RECENT_LINES, build_context, summarise_event
from app.commentary.events import Candidate, candidates
from app.commentary.llm import LineWriter
from app.commentary.tts import MP3_BYTES_PER_SECOND, BudgetTracker, TTSClient
from app.race.models import (
    CarConfig,
    CommentaryLine,
    CommentaryPriority,
    CommentarySettings,
    RaceEvent,
    RaceState,
    TrackRecord,
)

log = logging.getLogger(__name__)

CHARS_PER_SECOND = 14.0
MIN_DURATION_S = 1.5
COOLDOWN_S = 1.5
COOLDOWN_HIGH_S = 0.4
MAX_QUEUE = 5
MAX_AGE_S = {
    CommentaryPriority.LOW: 4.0,
    CommentaryPriority.NORMAL: 6.0,
    CommentaryPriority.HIGH: 10.0,
}
_RANK = {CommentaryPriority.LOW: 0, CommentaryPriority.NORMAL: 1, CommentaryPriority.HIGH: 2}
AUDIO_HISTORY = 20
FIRST_CHUNK_TIMEOUT_S = 3.0
# How long a line may wait for its LLM text, measured from the moment the LLM call started.
LLM_DEADLINE_S = {
    CommentaryPriority.HIGH: 1.5,
    CommentaryPriority.NORMAL: 1.8,
    CommentaryPriority.LOW: 2.5,
}
IDLE_POLL_S = 0.1

LineCallback = Callable[[CommentaryLine], Awaitable[None]]
StopCallback = Callable[[str], Awaitable[None]]


_BEST_LAP_KEYS = frozenset({"best_lap_overall", "best_lap_personal"})


def _superseded_by(cand: Candidate, record: TrackRecord) -> bool:
    return (
        cand.template_key in _BEST_LAP_KEYS
        and cand.address == record.address
        and cand.facts.get("lap_ms") == record.lap_ms
    )


class _AudioBuffer:
    """All chunks of one line; readers that arrive late still get everything from the start."""

    def __init__(self) -> None:
        self.chunks: list[bytes] = []
        self.done = False
        self.failed = False
        self.cond = asyncio.Condition()

    @property
    def size(self) -> int:
        return sum(len(c) for c in self.chunks)

    async def append(self, chunk: bytes) -> None:
        async with self.cond:
            self.chunks.append(chunk)
            self.cond.notify_all()

    async def finish(self, failed: bool = False) -> None:
        async with self.cond:
            self.done = True
            self.failed = failed
            self.cond.notify_all()

    async def read(self) -> AsyncIterator[bytes]:
        index = 0
        while True:
            async with self.cond:
                await self.cond.wait_for(lambda i=index: i < len(self.chunks) or self.done)
                if index >= len(self.chunks):
                    return
                chunk = self.chunks[index]
            index += 1
            yield chunk


@dataclass
class _Queued:
    candidate: Candidate
    created: float
    seq: int
    context: dict[str, Any] = field(default_factory=dict)
    task: asyncio.Task[str | None] | None = None
    task_started: float = 0.0


@dataclass
class _Current:
    line: CommentaryLine
    priority: CommentaryPriority
    started: float
    busy_until: float
    tasks: list[asyncio.Task] = field(default_factory=list)
    process: Any = None


def _alive(cur: _Current) -> bool:
    return any(not t.done() for t in cur.tasks)


class CommentaryDirector:
    def __init__(
        self,
        settings: CommentarySettings,
        cars: Callable[[], dict[int, CarConfig]],
        writer: LineWriter,
        tts: TTSClient | None,
        budget: BudgetTracker | None,
        on_line: LineCallback,
        on_stop: StopCallback,
        clock: Callable[[], float] = time.monotonic,
        *,
        which: Callable[[str], str | None] = shutil.which,
        mp3_bytes_per_second: int | None = MP3_BYTES_PER_SECOND,
        first_chunk_timeout_s: float = FIRST_CHUNK_TIMEOUT_S,
    ) -> None:
        self._settings = settings
        self._cars = cars
        self._writer = writer
        self._tts = tts
        self._budget = budget
        self._on_line = on_line
        self._on_stop = on_stop
        self._clock = clock
        self._which = which
        self._bps = mp3_bytes_per_second
        self._first_chunk_timeout = first_chunk_timeout_s
        self._queue: list[_Queued] = []
        self._seq = 0
        self._current: _Current | None = None
        self._lingering: list[_Current] = []  # past their estimate but still playing
        self._last_end = float("-inf")
        self._audio: OrderedDict[str, _AudioBuffer] = OrderedDict()
        self._wake = asyncio.Event()
        self._warned_ffplay = False
        self._spoken: deque[str] = deque(maxlen=RECENT_LINES)
        self._recent_events: deque[dict[str, Any]] = deque(maxlen=5)

    # ------------------------------------------------------------------ public API

    def update_settings(self, settings: CommentarySettings) -> None:
        self._settings = settings
        if not settings.enabled:
            self._clear_queue()
        elif not settings.llm_enabled:
            for q in self._queue:
                self._cancel_task(q)
        if self._budget is not None:
            self._budget.update_limits(settings.session_char_budget, settings.monthly_char_budget)

    @property
    def queue_size(self) -> int:
        return len(self._queue)

    async def submit(self, event: RaceEvent, state: RaceState) -> None:
        """Turn an event into candidates and queue them. Never raises."""
        if not self._settings.enabled:
            return
        try:
            cars = self._cars()
            lang = self._settings.language
            cands = candidates(event, state, cars, self._settings.verbosity, lang)
            contexts = [
                build_context(
                    state, cars, lang, c.address, c.template_key, list(self._recent_events)
                )
                for c in cands
            ]
            summary = summarise_event(event, cars, lang)
        except Exception:
            log.exception("commentary candidates failed for %s", getattr(event, "type", event))
            return
        if isinstance(event, TrackRecord) and cands:
            # A lap that is a track record is announced once: drop the best-lap lines the same
            # crossing queued just before (the controller emits TrackRecord after BestLap).
            self._remove_where(lambda q: _superseded_by(q.candidate, event))
        now = self._clock()
        self._recent_events.append(summary)
        for cand, ctx in zip(cands, contexts, strict=True):
            self._seq += 1
            item = _Queued(cand, now, self._seq, ctx)
            if self._settings.llm_enabled and getattr(self._writer, "available", True):
                item.task = asyncio.create_task(self._generate(cand, ctx))
                item.task_started = now
            self._queue.append(item)
        self._trim_queue()
        if cands:
            self._wake.set()

    def audio_stream(self, line_id: str) -> AsyncIterator[bytes] | None:
        buf = self._audio.get(line_id)
        return buf.read() if buf is not None else None

    async def run(self) -> None:
        """Background loop; cancel it to stop. Interrupts the current line on cancel."""
        try:
            while True:
                try:
                    await self.step()
                except asyncio.CancelledError:
                    raise
                except Exception:
                    log.exception("commentary director step failed")
                self._wake.clear()
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(self._wake.wait(), IDLE_POLL_S)
        finally:
            self._clear_queue()
            await self._cancel_current()
            await self._kill_lingering()

    # ------------------------------------------------------------------ scheduling

    async def step(self) -> CommentaryLine | None:
        """One scheduling decision. Returns the line started now, if any."""
        if not self._settings.enabled:
            self._clear_queue()
            return None
        now = self._clock()
        self._drop_stale(now)
        cur = self._current
        if cur is not None and now >= cur.busy_until:
            self._last_end = cur.busy_until
            await self._cancel_current(stopped=False)
            cur = None
        if not self._queue:
            return None
        best = max(self._queue, key=lambda q: (_RANK[q.candidate.priority], -q.seq))
        high = best.candidate.priority == CommentaryPriority.HIGH
        if cur is not None:
            if not (high and cur.priority != CommentaryPriority.HIGH):
                return None
            # Compose FIRST so the current line keeps playing while the LLM answers; only
            # then cut it and speak, with no dead air in between.
            self._queue.remove(best)
            text, source = await self._compose_text(best)
            if self._current is cur:
                if self._clock() < cur.busy_until:
                    await self._interrupt()
                else:
                    self._last_end = cur.busy_until
                    await self._cancel_current(stopped=False)
            return await self._emit(best, text, source)
        else:
            cooldown = COOLDOWN_HIGH_S if high else COOLDOWN_S
            if now < self._last_end + cooldown:
                return None
        self._queue.remove(best)
        text, source = await self._compose_text(best)
        return await self._emit(best, text, source)

    # ------------------------------------------------------------------ queue + LLM tasks

    @staticmethod
    def _cancel_task(item: _Queued) -> None:
        task, item.task = item.task, None
        if task is not None and not task.done():
            task.cancel()

    def _remove_where(self, predicate: Callable[[_Queued], bool]) -> None:
        kept: list[_Queued] = []
        for q in self._queue:
            if predicate(q):
                self._cancel_task(q)
            else:
                kept.append(q)
        self._queue = kept

    def _clear_queue(self) -> None:
        self._remove_where(lambda _q: True)

    def _drop_stale(self, now: float) -> None:
        self._remove_where(lambda q: now - q.created > MAX_AGE_S[q.candidate.priority])

    def _trim_queue(self) -> None:
        while len(self._queue) > MAX_QUEUE:
            victim = min(self._queue, key=lambda q: (_RANK[q.candidate.priority], q.seq))
            self._queue.remove(victim)
            self._cancel_task(victim)

    async def _generate(self, cand: Candidate, context: dict[str, Any]) -> str | None:
        """Background LLM call for one queued candidate. Never raises (except cancellation)."""
        ctx = {**context, "recent_lines": list(self._spoken)}
        try:
            text = await self._writer.write_line(cand, ctx)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.warning("line writer failed, using template text")
            return None
        return (text or "").strip() or None

    async def _interrupt(self) -> None:
        cur = self._current
        if cur is None:
            return
        line_id = cur.line.id
        await self._cancel_current(stopped=True)
        try:
            await self._on_stop(line_id)
        except Exception:
            log.exception("on_stop callback failed")

    async def _cancel_current(self, stopped: bool = True) -> None:
        cur, self._current = self._current, None
        if cur is None:
            return
        if not stopped:
            # Natural end of the estimated duration: let audio/ffplay finish by themselves
            # (-autoexit); they are killed only on interrupt, shutdown or before the next
            # local playback starts.
            self._lingering = [c for c in self._lingering if _alive(c)]
            if _alive(cur):
                self._lingering.append(cur)
            return
        await self._stop(cur)
        await self._kill_lingering()

    async def _stop(self, cur: _Current) -> None:
        buf = self._audio.get(cur.line.id)
        for task in cur.tasks:
            if not task.done():
                task.cancel()
        for task in cur.tasks:
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
        if cur.process is not None and cur.process.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                cur.process.kill()
        if buf is not None and not buf.done:
            await buf.finish()

    async def _kill_lingering(self) -> None:
        lingering, self._lingering = self._lingering, []
        for cur in lingering:
            await self._stop(cur)

    # ------------------------------------------------------------------ speaking

    def _estimate_s(self, text: str) -> float:
        return max(MIN_DURATION_S, len(text) / CHARS_PER_SECOND)

    async def _compose_text(self, item: _Queued) -> tuple[str, str]:
        cand = item.candidate
        task, item.task = item.task, None
        if task is None:
            return cand.text, "template"
        if not self._settings.llm_enabled:
            task.cancel()
            return cand.text, "template"
        try:
            if not task.done():
                budget = LLM_DEADLINE_S[cand.priority] - (self._clock() - item.task_started)
                await asyncio.wait_for(asyncio.shield(task), timeout=max(0.0, budget))
            text = task.result()
        except asyncio.CancelledError:
            task.cancel()
            raise
        except TimeoutError:
            task.cancel()
            log.info("LLM line too slow, using template text")
            return cand.text, "template"
        except Exception:
            return cand.text, "template"
        if not text:
            return cand.text, "template"
        return text, ("template" if text == cand.text else "llm")

    async def _start_audio(
        self, cand: Candidate, text: str, line_id: str
    ) -> tuple[_AudioBuffer, asyncio.Task] | None:
        tts = self._tts
        settings = self._settings
        if tts is None or not settings.tts_enabled:
            return None
        try:
            if not tts.available:
                return None
            voice = settings.voice_id
            cacheable = cand.cacheable and text == cand.text
            free = cacheable and tts.is_cached(text, voice_id=voice)
            if not free and (self._budget is None or not self._budget.consume(len(text))):
                if self._budget is not None:
                    log.info("TTS budget exhausted, text only")
                return None
        except Exception:
            log.exception("TTS pre-check failed")
            return None
        buf = _AudioBuffer()
        task = asyncio.create_task(self._produce(buf, text, cacheable, voice))
        try:
            await asyncio.wait_for(self._wait_first_chunk(buf), self._first_chunk_timeout)
        except TimeoutError:
            pass
        except BaseException:
            # cancelled (shutdown) or unexpected: the producer is not tracked anywhere yet
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
            raise
        if not buf.chunks:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
            return None
        self._audio[line_id] = buf
        while len(self._audio) > AUDIO_HISTORY:
            self._audio.popitem(last=False)
        return buf, task

    async def _wait_first_chunk(self, buf: _AudioBuffer) -> None:
        async with buf.cond:
            await buf.cond.wait_for(lambda: bool(buf.chunks) or buf.done)

    async def _produce(
        self, buf: _AudioBuffer, text: str, cacheable: bool, voice: str | None
    ) -> None:
        failed = False
        try:
            assert self._tts is not None
            async for chunk in self._tts.stream(text, cacheable=cacheable, voice_id=voice):
                await buf.append(chunk)
        except asyncio.CancelledError:
            await buf.finish()
            raise
        except Exception:
            failed = True
            log.exception("TTS stream failed")
        await buf.finish(failed=failed)
        self._refine_duration(buf)

    def _refine_duration(self, buf: _AudioBuffer) -> None:
        """Once the whole mp3 is known, use its real length as the busy duration."""
        cur = self._current
        if not self._bps or cur is None or self._audio.get(cur.line.id) is not buf or buf.failed:
            return
        if buf.size:
            cur.busy_until = cur.started + buf.size / self._bps

    async def _emit(self, item: _Queued, text: str, source: str) -> CommentaryLine | None:
        cand = item.candidate
        line_id = uuid.uuid4().hex[:12]
        start = self._clock()
        audio = await self._start_audio(cand, text, line_id)
        buf = audio[0] if audio else None
        audio_url = None
        use_local = False
        if buf is not None:
            if self._settings.audio_output == "local":
                if self._which("ffplay"):
                    use_local = True
                else:
                    if not self._warned_ffplay:
                        self._warned_ffplay = True
                        log.warning("ffplay not found on PATH, falling back to browser audio")
                    audio_url = f"/api/commentary/{line_id}/audio"
            else:
                audio_url = f"/api/commentary/{line_id}/audio"
        line = CommentaryLine(
            id=line_id,
            text=text,
            priority=cand.priority,
            event_type=cand.event_type,
            source="llm" if source == "llm" else "template",
            audio_url=audio_url,
        )
        cur = _Current(
            line=line,
            priority=cand.priority,
            started=start,
            busy_until=start + self._estimate_s(text),
        )
        self._current = cur
        self._spoken.append(text)
        if audio is not None and buf is not None:
            cur.tasks.append(audio[1])
            if use_local:
                await self._kill_lingering()  # never two ffplay at once
                cur.tasks.append(asyncio.create_task(self._play_local(cur, buf)))
            if buf.done:
                self._refine_duration(buf)
        try:
            await self._on_line(line)
        except Exception:
            log.exception("on_line callback failed")
        return line

    async def _play_local(self, cur: _Current, buf: _AudioBuffer) -> None:
        try:
            proc = await asyncio.create_subprocess_exec(
                "ffplay",
                "-nodisp",
                "-autoexit",
                "-loglevel",
                "quiet",
                "-",
                stdin=asyncio.subprocess.PIPE,
            )
        except Exception:
            log.exception("could not start ffplay")
            return
        cur.process = proc
        try:
            async for chunk in buf.read():
                if proc.stdin is None:
                    break
                proc.stdin.write(chunk)
                await proc.stdin.drain()
            if proc.stdin is not None:
                proc.stdin.close()
            await proc.wait()
        except asyncio.CancelledError:
            raise
        except Exception:
            log.warning("ffplay playback failed")
        finally:
            if proc.returncode is None:
                with contextlib.suppress(ProcessLookupError):
                    proc.kill()
