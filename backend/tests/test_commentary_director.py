import asyncio
import contextlib
import time
from types import SimpleNamespace

from app.commentary.director import MAX_QUEUE
from app.commentary.llm import AnthropicWriter
from app.race.models import (
    BestLap,
    CommentaryPriority,
    CommentarySettings,
    Idle,
    PitEntry,
    TrackRecord,
    Verbosity,
)
from tests.test_commentary_fakes import (
    FakeTTS,
    ev_finished,
    ev_started,
    make_budget,
    make_director,
    state,
)

P = CommentaryPriority


async def test_priority_ordering_high_before_low():
    director, sink, _ = make_director()
    await director.submit(Idle(seconds=30), state())
    await director.submit(PitEntry(address=1), state())
    await director.submit(ev_started(), state())
    first = await director.step()
    assert first is not None and first.priority == P.HIGH
    assert first.event_type == "race_started"


def speech_s(line) -> float:
    return max(1.5, len(line.text) / 14)


async def test_cooldown_and_no_overlap():
    director, sink, clock = make_director()
    await director.submit(ev_started(), state())
    await director.submit(ev_finished(), state())
    first = await director.step()
    assert first is not None
    d = speech_s(first)
    assert await director.step() is None  # still speaking
    clock.advance(d - 0.1)
    assert await director.step() is None  # still speaking
    clock.advance(0.2)  # speech over, but inside the 0.4 s HIGH cooldown
    assert await director.step() is None
    clock.advance(0.4)
    second = await director.step()
    assert second is not None and second.id != first.id
    assert [x.event_type for x in sink.lines] == ["race_started", "race_finished"]


async def test_cooldown_is_longer_for_non_high_lines():
    director, _, clock = make_director()
    await director.submit(PitEntry(address=1), state())
    await director.submit(PitEntry(address=2), state())
    first = await director.step()
    assert first is not None
    clock.advance(speech_s(first) + 1.0)  # speech over, 1.0 s into the 1.5 s cooldown
    assert await director.step() is None
    clock.advance(0.6)
    assert await director.step() is not None


async def test_duration_scales_with_text_length():
    director, sink, clock = make_director()
    await director.submit(ev_finished(), state())
    line = await director.step()
    assert line is not None
    expected = max(1.5, len(line.text) / 14)
    await director.submit(ev_started(), state())
    clock.advance(expected - 0.05)
    assert await director.step() is None  # busy, and HIGH does not interrupt HIGH
    assert sink.stops == []


async def test_high_interrupts_low_and_speaks_now():
    director, sink, clock = make_director()
    await director.submit(Idle(seconds=30), state())
    low = await director.step()
    assert low is not None
    clock.advance(0.2)
    await director.submit(ev_started(), state())
    high = await director.step()
    assert high is not None and high.priority == P.HIGH
    assert sink.stops == [low.id]
    assert [x.id for x in sink.lines] == [low.id, high.id]


async def test_high_does_not_interrupt_high():
    director, sink, clock = make_director()
    await director.submit(ev_started(), state())
    await director.step()
    await director.submit(ev_finished(), state())
    clock.advance(0.1)
    assert await director.step() is None
    assert sink.stops == []


async def test_normal_does_not_interrupt_low():
    director, sink, clock = make_director()
    await director.submit(Idle(seconds=30), state())
    await director.step()
    await director.submit(PitEntry(address=1), state())
    assert await director.step() is None
    assert sink.stops == []


async def test_stale_lines_are_dropped():
    director, sink, clock = make_director()
    await director.submit(Idle(seconds=30), state())  # LOW: stale after 4 s
    await director.submit(PitEntry(address=1), state())  # NORMAL: 6 s
    await director.submit(ev_started(), state())  # HIGH: 10 s
    clock.advance(4.5)
    assert director.queue_size == 3
    line = await director.step()  # HIGH goes first, LOW dropped
    assert line is not None and line.priority == P.HIGH
    assert director.queue_size == 1  # NORMAL survived, LOW dropped
    clock.advance(7)
    assert await director.step() is None  # NORMAL now stale too
    assert director.queue_size == 0


async def test_queue_cap_drops_lowest_priority_first():
    director, sink, clock = make_director()
    await director.submit(ev_started(), state())
    for _ in range(MAX_QUEUE + 3):
        await director.submit(Idle(seconds=30), state())
    assert director.queue_size == MAX_QUEUE
    first = await director.step()
    assert first is not None and first.priority == P.HIGH  # the HIGH line survived


async def test_disabled_commentary_does_nothing():
    director, sink, _ = make_director(CommentarySettings(enabled=False))
    await director.submit(ev_started(), state())
    assert director.queue_size == 0
    assert await director.step() is None
    director.update_settings(CommentarySettings(enabled=True))
    await director.submit(ev_started(), state())
    director.update_settings(CommentarySettings(enabled=False))
    assert director.queue_size == 0


async def test_language_follows_settings():
    director, _, _ = make_director(CommentarySettings(language="en"))
    await director.submit(PitEntry(address=1), state())
    line = await director.step()
    assert line is not None
    assert any(w in line.text for w in ("pit", "Pit"))


async def test_audio_url_only_with_tts_budget_and_browser_output():
    tts = FakeTTS()
    director, sink, _ = make_director(tts=tts, budget=make_budget())
    await director.submit(ev_started(), state())
    line = await director.step()
    assert line is not None and line.audio_url == f"/api/commentary/{line.id}/audio"
    assert tts.calls == [line.text]


async def test_no_audio_when_tts_missing_disabled_or_unavailable():
    for tts, settings in [
        (None, CommentarySettings()),
        (FakeTTS(), CommentarySettings(tts_enabled=False)),
        (FakeTTS(available=False), CommentarySettings()),
    ]:
        director, _, _ = make_director(settings, tts=tts, budget=make_budget())
        await director.submit(ev_started(), state())
        line = await director.step()
        assert line is not None and line.audio_url is None
        assert director.audio_stream(line.id) is None


async def test_budget_exhaustion_gives_text_only():
    tts = FakeTTS()
    director, _, _ = make_director(tts=tts, budget=make_budget(session=5))
    await director.submit(ev_started(), state())
    line = await director.step()
    assert line is not None and line.audio_url is None and line.text
    assert tts.calls == []


async def test_monthly_budget_exhaustion_gives_text_only():
    tts = FakeTTS()
    director, _, _ = make_director(tts=tts, budget=make_budget(monthly=5))
    await director.submit(ev_started(), state())
    line = await director.step()
    assert line is not None and line.audio_url is None
    assert tts.calls == []


async def test_budget_is_charged_with_text_length():
    budget = make_budget()
    director, _, _ = make_director(tts=FakeTTS(), budget=budget)
    await director.submit(ev_started(), state())
    line = await director.step()
    assert line is not None
    assert budget.session_used == len(line.text)


async def test_cached_phrase_is_free():
    tts = FakeTTS()
    budget = make_budget(session=0)  # nothing affordable
    director, _, _ = make_director(tts=tts, budget=budget)
    # race_started templates are static -> cacheable; mark every possible text as cached
    from app.commentary import templates_it

    tts.cached = set(templates_it.TEMPLATES["race_started"])
    await director.submit(ev_started(), state())
    line = await director.step()
    assert line is not None and line.audio_url is not None
    assert budget.session_used == 0


async def test_tts_error_gives_text_only_and_never_raises():
    tts = FakeTTS()
    tts.fail = True
    director, sink, _ = make_director(tts=tts, budget=make_budget())
    await director.submit(ev_started(), state())
    line = await director.step()
    assert line is not None and line.audio_url is None
    assert sink.lines == [line]


async def test_tts_exception_in_stream_gives_text_only():
    class Exploding(FakeTTS):
        async def stream(self, text, *, cacheable=False, voice_id=None):
            raise RuntimeError("boom")
            yield b""

    director, _, _ = make_director(tts=Exploding(), budget=make_budget())
    await director.submit(ev_started(), state())
    line = await director.step()
    assert line is not None and line.audio_url is None


async def test_slow_tts_first_chunk_times_out_to_text_only():
    tts = FakeTTS()
    tts.gate = asyncio.Event()  # never set: no chunk ever arrives
    director, _, _ = make_director(tts=tts, budget=make_budget(), first_chunk_timeout_s=0.05)
    await director.submit(ev_started(), state())
    line = await director.step()
    assert line is not None and line.audio_url is None


async def test_audio_stream_late_reader_gets_everything():
    tts = FakeTTS(chunks=[b"aa", b"bb", b"cc"])
    director, _, _ = make_director(tts=tts, budget=make_budget())
    await director.submit(ev_started(), state())
    line = await director.step()
    assert line is not None
    early = director.audio_stream(line.id)
    assert early is not None
    early_task = asyncio.create_task(_collect(early))
    await asyncio.sleep(0.05)
    late = director.audio_stream(line.id)
    assert late is not None
    assert b"".join(await _collect(late)) == b"aabbcc"
    assert b"".join(await early_task) == b"aabbcc"
    again = director.audio_stream(line.id)
    assert again is not None and b"".join(await _collect(again)) == b"aabbcc"
    assert director.audio_stream("unknown") is None


async def _collect(stream):
    return [c async for c in stream]


async def test_reader_receives_chunks_while_tts_is_still_producing():
    class Slow(FakeTTS):
        async def stream(self, text, *, cacheable=False, voice_id=None):
            yield b"first"
            await self.gate.wait()
            yield b"second"

    tts = Slow()
    tts.gate = asyncio.Event()
    director, _, _ = make_director(tts=tts, budget=make_budget())
    await director.submit(ev_started(), state())
    line = await director.step()
    assert line is not None
    reader = director.audio_stream(line.id)
    assert reader is not None
    assert await reader.__anext__() == b"first"
    tts.gate.set()
    assert await reader.__anext__() == b"second"
    with contextlib.suppress(StopAsyncIteration):
        await reader.__anext__()


async def test_audio_history_is_bounded():
    director, _, clock = make_director(tts=FakeTTS(), budget=make_budget())
    ids = []
    for _ in range(25):
        await director.submit(ev_started(), state())
        line = await director.step()
        assert line is not None
        ids.append(line.id)
        clock.advance(10)
    assert director.audio_stream(ids[0]) is None
    assert director.audio_stream(ids[-1]) is not None


async def test_real_mp3_length_defines_busy_time():
    tts = FakeTTS(chunks=[b"x" * 8, b"y" * 8, b"z" * 8])  # 24 bytes
    director, _, clock = make_director(
        tts=tts, budget=make_budget(), mp3_bytes_per_second=4
    )  # -> 6 s of audio
    await director.submit(ev_started(), state())
    await director.step()
    await asyncio.sleep(0.05)  # let the producer finish
    await director.submit(ev_finished(), state())
    clock.advance(5.0)
    assert await director.step() is None  # estimate would have ended, real audio has not
    clock.advance(1.5)
    assert await director.step() is not None


async def test_local_output_without_ffplay_falls_back_to_browser():
    settings = CommentarySettings(audio_output="local")
    director, _, _ = make_director(
        settings, tts=FakeTTS(), budget=make_budget(), which=lambda _: None
    )
    await director.submit(ev_started(), state())
    line = await director.step()
    assert line is not None and line.audio_url is not None


async def test_local_output_with_ffplay_has_no_browser_url(monkeypatch):
    settings = CommentarySettings(audio_output="local")
    director, _, _ = make_director(
        settings, tts=FakeTTS(), budget=make_budget(), which=lambda _: "/usr/bin/ffplay"
    )
    played = []

    async def fake_play(cur, buf):
        played.append(b"".join([c async for c in buf.read()]))

    monkeypatch.setattr(director, "_play_local", fake_play)
    await director.submit(ev_started(), state())
    line = await director.step()
    assert line is not None and line.audio_url is None
    await asyncio.sleep(0.05)
    assert played == [b"aaaabbbbcccc"]


async def test_llm_timeout_falls_back_to_template_line():
    async def slow(**_):
        await asyncio.sleep(5)

    client = SimpleNamespace(messages=SimpleNamespace(create=slow))
    writer = AnthropicWriter("unused", timeout_s=0.05, client=client)
    director, _, _ = make_director(CommentarySettings(llm_enabled=True), writer=writer)
    await director.submit(Idle(seconds=30), state())
    line = await director.step()
    assert line is not None and line.source == "template" and line.text


async def test_llm_used_for_every_priority():
    calls = []

    class Writer:
        async def write_line(self, candidate, context):
            calls.append(candidate.priority)
            return "linea LLM"

    director, _, clock = make_director(CommentarySettings(llm_enabled=True), writer=Writer())
    await director.submit(ev_started(), state())
    high = await director.step()
    clock.advance(5)
    await director.submit(PitEntry(address=1), state())
    normal = await director.step()
    clock.advance(5)
    await director.submit(Idle(seconds=30), state())
    low = await director.step()
    for line in (high, normal, low):
        assert line is not None and line.source == "llm" and line.text == "linea LLM"
    assert calls == [P.HIGH, P.NORMAL, P.LOW]


async def test_per_priority_deadline_falls_back_to_template():
    class Slow:
        async def write_line(self, candidate, context):
            await asyncio.sleep(5)
            return "mai"

    cases = [(ev_started(), 1.5), (PitEntry(address=1), 1.8), (Idle(seconds=30), 2.5)]
    for event, deadline in cases:
        director, _, _ = make_director(CommentarySettings(llm_enabled=True), writer=Slow())
        await director.submit(event, state())
        t0 = time.monotonic()
        line = await director.step()
        elapsed = time.monotonic() - t0
        assert line is not None and line.source == "template"
        assert deadline - 0.1 <= elapsed <= deadline + 0.5


async def test_generation_overlaps_with_the_line_being_spoken():
    started = []
    release = asyncio.Event()

    class Writer:
        async def write_line(self, candidate, context):
            started.append(candidate.template_key)
            if candidate.template_key == "idle":
                await release.wait()
            return f"LLM {candidate.template_key}"

    director, _, clock = make_director(CommentarySettings(llm_enabled=True), writer=Writer())
    await director.submit(ev_finished(), state())
    first = await director.step()
    assert first is not None and first.text == "LLM race_finished"
    await director.submit(Idle(seconds=30), state())
    await asyncio.sleep(0)
    assert started == ["race_finished", "idle"]  # started while the first line is speaking
    release.set()
    await asyncio.sleep(0)
    clock.advance(speech_s(first) + 2.0)  # speech over and cooldown passed
    t0 = time.monotonic()
    second = await director.step()
    assert time.monotonic() - t0 < 0.2  # the text was already waiting: no extra latency
    assert second is not None and second.text == "LLM idle" and second.source == "llm"


async def test_stale_or_trimmed_line_cancels_its_llm_task():
    cancelled = []

    class Writer:
        async def write_line(self, candidate, context):
            try:
                await asyncio.sleep(60)
            except asyncio.CancelledError:
                cancelled.append(candidate.template_key)
                raise
            return "x"

    director, _, clock = make_director(CommentarySettings(llm_enabled=True), writer=Writer())
    await director.submit(Idle(seconds=30), state())
    await asyncio.sleep(0)
    clock.advance(5)  # past the LOW stale limit
    assert await director.step() is None
    await asyncio.sleep(0)
    assert cancelled == ["idle"]
    for _ in range(MAX_QUEUE + 1):
        await director.submit(Idle(seconds=30), state())
        await asyncio.sleep(0)  # let the task start so the cancel is observable
    await asyncio.sleep(0)
    assert len(cancelled) == 2  # the trimmed line's task was cancelled as well


async def test_run_cancellation_leaves_no_llm_tasks():
    class Writer:
        async def write_line(self, candidate, context):
            await asyncio.sleep(60)
            return "x"

    director, _, _ = make_director(
        CommentarySettings(llm_enabled=True), writer=Writer(), clock=time.monotonic
    )
    run = asyncio.create_task(director.run())
    await director.submit(Idle(seconds=30), state())
    await director.submit(PitEntry(address=1), state())
    tasks = [q.task for q in director._queue]
    assert tasks and all(t is not None for t in tasks)
    await asyncio.sleep(0.05)  # the loop is now waiting on the first line's LLM text
    run.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await run
    await asyncio.sleep(0)
    assert all(t.cancelled() for t in tasks if t is not None)


async def test_context_has_standings_and_recent_lines():
    seen = []

    class Writer:
        async def write_line(self, candidate, context):
            seen.append(context)
            return f"line {len(seen)}"

    director, _, clock = make_director(CommentarySettings(llm_enabled=True), writer=Writer())
    await director.submit(ev_started(), state())
    await director.step()
    clock.advance(5)
    await director.submit(PitEntry(address=1), state())
    await asyncio.sleep(0)
    ctx = seen[-1]
    assert [r["driver"] for r in ctx["standings"]] == ["Fulmine", "Blu"]
    assert ctx["recent_lines"] == ["line 1"]
    assert ctx["recent_events"][0]["event"] == "race_started"
    assert ctx["total_laps"] == 10


async def test_llm_disabled_never_calls_writer():
    class Writer:
        async def write_line(self, candidate, context):
            raise AssertionError("must not be called")

    director, _, _ = make_director(CommentarySettings(llm_enabled=False), writer=Writer())
    await director.submit(Idle(seconds=30), state())
    assert await director.step() is not None


async def test_writer_exception_never_propagates():
    class Writer:
        async def write_line(self, candidate, context):
            raise RuntimeError("bad")

    director, _, _ = make_director(CommentarySettings(llm_enabled=True), writer=Writer())
    await director.submit(Idle(seconds=30), state())
    line = await director.step()
    assert line is not None and line.source == "template"


async def test_callback_errors_do_not_break_the_director():
    director, sink, clock = make_director()

    async def bad(_line):
        raise RuntimeError("ws closed")

    director._on_line = bad
    await director.submit(ev_started(), state())
    assert await director.step() is not None


async def test_run_loop_speaks_and_is_cancellable():
    director, sink, _ = make_director(clock=time.monotonic)
    task = asyncio.create_task(director.run())
    await director.submit(ev_started(), state())
    for _ in range(50):
        if sink.lines:
            break
        await asyncio.sleep(0.02)
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task
    assert len(sink.lines) == 1


async def test_cancel_while_waiting_for_first_chunk_stops_the_tts_stream():
    state_log = {"started": False, "closed": False}

    class Stalled(FakeTTS):
        async def stream(self, text, *, cacheable=False, voice_id=None):
            state_log["started"] = True
            try:
                await asyncio.Event().wait()  # never produces a chunk
                yield b""
            finally:
                state_log["closed"] = True

    director, _, _ = make_director(tts=Stalled(), budget=make_budget(), first_chunk_timeout_s=30)
    await director.submit(ev_started(), state())
    step = asyncio.create_task(director.step())
    for _ in range(50):
        if state_log["started"]:
            break
        await asyncio.sleep(0.01)
    assert state_log["started"] and not state_log["closed"]
    step.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await step
    assert state_log["closed"]


def _local_director(monkeypatch):
    settings = CommentarySettings(audio_output="local")
    director, sink, clock = make_director(
        settings, tts=FakeTTS(), budget=make_budget(), which=lambda _: "/usr/bin/ffplay"
    )
    players = []

    async def fake_play(cur, buf):
        done = asyncio.Event()
        players.append({"cancelled": False, "done": done})
        try:
            await done.wait()
        except asyncio.CancelledError:
            players[-1]["cancelled"] = True
            raise

    monkeypatch.setattr(director, "_play_local", fake_play)
    return director, clock, players


async def test_local_playback_survives_natural_end_of_estimate(monkeypatch):
    director, clock, players = _local_director(monkeypatch)
    await director.submit(ev_started(), state())
    line = await director.step()
    assert line is not None
    await asyncio.sleep(0.01)
    clock.advance(speech_s(line) + 0.1)
    await director.step()  # natural end: nothing must be killed
    await asyncio.sleep(0.01)
    assert players and not players[0]["cancelled"]
    # the next local line kills the leftover playback before starting
    clock.advance(1.0)
    await director.submit(ev_finished(), state())
    assert await director.step() is not None
    await asyncio.sleep(0.01)
    assert players[0]["cancelled"] and len(players) == 2
    # shutdown kills the last one
    task = asyncio.create_task(director.run())
    await asyncio.sleep(0.02)
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task
    assert players[1]["cancelled"]


async def test_track_record_replaces_best_lap_of_same_lap():
    director, sink, _ = make_director()
    await director.submit(BestLap(address=0, lap_ms=5230, lap_number=2, overall=True), state())
    await director.submit(BestLap(address=1, lap_ms=5900, lap_number=2, overall=False), state())
    record = TrackRecord(
        race_time_ms=9, address=0, lap_ms=5230, layout="x", previous_ms=6000, previous_holder="Blu"
    )
    await director.submit(record, state())
    assert sorted(q.candidate.template_key for q in director._queue) == [
        "best_lap_personal",
        "track_record",
    ]
    line = await director.step()
    assert line is not None and line.event_type == "track_record"


async def test_filtered_track_record_keeps_best_lap():
    director, _, _ = make_director(CommentarySettings(verbosity=Verbosity.LOW))
    await director.submit(BestLap(address=0, lap_ms=5230, lap_number=2, overall=True), state())
    first = TrackRecord(
        race_time_ms=9, address=0, lap_ms=5230, layout="x"
    )  # NORMAL: dropped at LOW
    await director.submit(first, state())
    assert [q.candidate.template_key for q in director._queue] == ["best_lap_overall"]


async def test_high_interrupt_waits_for_the_writer_before_cutting_the_current_line():
    gate = asyncio.Event()

    class Writer:
        async def write_line(self, candidate, context):
            if candidate.template_key == "race_started":
                await gate.wait()
            return f"LLM {candidate.template_key}"

    director, sink, clock = make_director(CommentarySettings(llm_enabled=True), writer=Writer())
    await director.submit(Idle(seconds=30), state())
    low = await director.step()
    assert low is not None
    clock.advance(0.2)
    await director.submit(ev_started(), state())
    step = asyncio.create_task(director.step())
    await asyncio.sleep(0.05)
    assert not step.done() and sink.stops == []  # the low line is still playing
    gate.set()
    high = await step
    assert high is not None and high.text == "LLM race_started"
    assert sink.stops == [low.id]
    assert [x.id for x in sink.lines] == [low.id, high.id]


async def test_high_interrupt_speaks_the_template_when_the_deadline_passes():
    class Writer:
        async def write_line(self, candidate, context):
            if candidate.template_key == "race_started":
                await asyncio.sleep(60)
            return "LLM"

    director, sink, clock = make_director(CommentarySettings(llm_enabled=True), writer=Writer())
    await director.submit(Idle(seconds=30), state())
    low = await director.step()
    assert low is not None
    clock.advance(0.2)
    await director.submit(ev_started(), state())
    high = await director.step()
    assert high is not None and high.source == "template"
    assert sink.stops == [low.id]
