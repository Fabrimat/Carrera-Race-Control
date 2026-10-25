import json
import time
from pathlib import Path

import pytest

from app.track.base import Status, Timer, TrackConnectionError, TrackDisconnected, TrackInterface
from app.track.replay import RecordingTrack, ReplayTrack

FIXTURE = Path(__file__).parent / "fixtures" / "session_small.jsonl"


class ScriptedTrack:
    def __init__(self, msgs):
        self._msgs = list(msgs)
        self._connected = False
        self.calls: list[str] = []

    @property
    def connected(self):
        return self._connected

    async def connect(self):
        self._connected = True
        self.calls.append("connect")

    async def poll(self):
        if not self._msgs:
            raise TrackDisconnected("done")
        return self._msgs.pop(0)

    async def start(self):
        self.calls.append("start")

    async def toggle_pace_car(self):
        self.calls.append("pace")

    async def reset_timer(self):
        self.calls.append("reset")

    async def close(self):
        self.calls.append("close")


MSGS = [
    Status(fuel=(15,) * 8, start=1, mode=5, pit=(False,) * 8),
    Timer(0, 4294967000, 1),
    Timer(0, 5000, 1),
    Status(fuel=(14,) * 8, start=0, mode=5, pit=(True,) + (False,) * 7, display=8),
]


async def collect(track):
    out = []
    try:
        while True:
            out.append(await track.poll())
    except TrackDisconnected:
        return out


async def test_roundtrip(tmp_path):
    path = tmp_path / "sub" / "rec.jsonl"
    inner = ScriptedTrack(MSGS)
    rec = RecordingTrack(inner, path)
    assert isinstance(rec, TrackInterface)
    await rec.connect()
    assert rec.connected
    await rec.start()
    await rec.toggle_pace_car()
    await rec.reset_timer()
    assert await collect(rec) == MSGS
    await rec.close()
    assert inner.calls == ["connect", "start", "pace", "reset", "close"]

    lines = [json.loads(x) for x in path.read_text().splitlines()]
    assert [x["kind"] for x in lines] == ["status", "timer", "timer", "status"]
    assert all("t" in x for x in lines)

    replay = ReplayTrack(path, speed=0)
    assert isinstance(replay, TrackInterface)
    await replay.connect()
    assert await collect(replay) == MSGS
    assert not replay.connected


async def test_replay_timing_scaled(tmp_path):
    path = tmp_path / "r.jsonl"
    rows = [
        {"t": 0.0, "kind": "timer", "address": 1, "timestamp": 10, "sector": 1},
        {"t": 1.0, "kind": "timer", "address": 1, "timestamp": 1010, "sector": 1},
    ]
    path.write_text("\n".join(json.dumps(r) for r in rows) + "\n")
    replay = ReplayTrack(path, speed=10.0)
    await replay.connect()
    t0 = time.monotonic()
    got = await collect(replay)
    elapsed = time.monotonic() - t0
    assert len(got) == 2
    assert 0.08 <= elapsed < 0.6


async def test_replay_loop(tmp_path):
    path = tmp_path / "r.jsonl"
    path.write_text(json.dumps({"t": 0.0, "kind": "timer", "address": 0, "timestamp": 1}) + "\n")
    replay = ReplayTrack(path, speed=0, loop=True)
    await replay.connect()
    for _ in range(5):
        assert (await replay.poll()).timestamp == 1


async def test_replay_missing_file(tmp_path):
    with pytest.raises(TrackConnectionError) as ei:
        await ReplayTrack(tmp_path / "nope.jsonl").connect()
    assert ei.value.code == "not_found"


async def test_poll_before_connect(tmp_path):
    with pytest.raises(TrackDisconnected):
        await ReplayTrack(tmp_path / "x").poll()


async def test_fixture_is_valid():
    replay = ReplayTrack(FIXTURE, speed=0)
    await replay.connect()
    msgs = await collect(replay)
    timers = [m for m in msgs if isinstance(m, Timer)]
    assert {m.address for m in timers} == {0, 1, 2, 3}
    for addr in range(4):
        assert sum(1 for m in timers if m.address == addr) == 6  # start pass + 5 laps
    starts = [m.start for m in msgs if isinstance(m, Status)]
    assert starts[:8] == [1, 2, 3, 4, 5, 6, 7, 0]
