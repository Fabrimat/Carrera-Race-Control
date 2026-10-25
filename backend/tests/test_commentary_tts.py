from types import SimpleNamespace

from app.commentary.tts import DEFAULT_MODEL_ID, ElevenLabsTTS, TTSClient, cache_key
from tests.test_commentary_fakes import FakeClock, make_budget


class ApiError(Exception):
    def __init__(self, status_code):
        super().__init__(f"http {status_code}")
        self.status_code = status_code


class FakeEleven:
    def __init__(self, chunks=(b"one", b"two"), error=None, fail_after=None):
        self.calls = []
        self._chunks = chunks
        self._error = error
        self._fail_after = fail_after
        self.text_to_speech = SimpleNamespace(stream=self._stream)

    async def _stream(self, voice_id, **kwargs):
        self.calls.append((voice_id, kwargs))
        if self._error:
            raise self._error
        for c in self._chunks:
            yield c
        if self._fail_after:
            raise self._fail_after


async def collect(tts, text, **kw):
    return [c async for c in tts.stream(text, **kw)]


def test_default_model_is_flash_v2_5():
    assert DEFAULT_MODEL_ID == "eleven_flash_v2_5"


async def test_streams_with_expected_params(tmp_path):
    fake = FakeEleven()
    tts = ElevenLabsTTS("k", "voice1", cache_dir=tmp_path, client=fake, language_code="it")
    assert isinstance(tts, TTSClient)
    assert await collect(tts, "ciao") == [b"one", b"two"]
    voice, kwargs = fake.calls[0]
    assert voice == "voice1"
    assert kwargs["model_id"] == "eleven_flash_v2_5"
    assert kwargs["output_format"].startswith("mp3_")
    assert kwargs["text"] == "ciao" and kwargs["language_code"] == "it"


async def test_cache_roundtrip_for_cacheable_only(tmp_path):
    fake = FakeEleven()
    tts = ElevenLabsTTS("k", "v", cache_dir=tmp_path, client=fake)
    await collect(tts, "frase", cacheable=False)
    assert not tts.is_cached("frase")
    await collect(tts, "frase", cacheable=True)
    assert tts.is_cached("frase")
    assert (tmp_path / f"{cache_key(tts.model_id, 'v', 'frase')}.mp3").read_bytes() == b"onetwo"
    fake.calls.clear()
    assert b"".join(await collect(tts, "frase", cacheable=True)) == b"onetwo"
    assert fake.calls == []  # served from disk


async def test_voice_override_changes_cache_key(tmp_path):
    tts = ElevenLabsTTS("k", "v", cache_dir=tmp_path, client=FakeEleven())
    await collect(tts, "x", cacheable=True, voice_id="other")
    assert tts.is_cached("x", voice_id="other") and not tts.is_cached("x")


async def test_missing_key_is_unavailable_and_silent():
    tts = ElevenLabsTTS(None, "v")
    assert not tts.available
    assert await collect(tts, "ciao") == []


async def test_401_disables_permanently_without_raising():
    clock = FakeClock()
    tts = ElevenLabsTTS("k", "v", client=FakeEleven(error=ApiError(401)), clock=clock)
    assert await collect(tts, "a") == []
    assert not tts.available
    clock.advance(10_000)
    assert not tts.available


async def test_429_backs_off_then_recovers():
    clock = FakeClock()
    tts = ElevenLabsTTS("k", "v", client=FakeEleven(error=ApiError(429)), clock=clock)
    assert await collect(tts, "a") == []
    assert not tts.available
    clock.advance(61)
    assert tts.available


async def test_network_error_does_not_raise():
    tts = ElevenLabsTTS("k", "v", client=FakeEleven(error=ConnectionError("down")))
    assert await collect(tts, "a") == []
    assert not tts.available


async def test_midstream_failure_is_not_cached(tmp_path):
    fake = FakeEleven(chunks=(b"partial",), fail_after=ConnectionError("cut"))
    tts = ElevenLabsTTS("k", "v", cache_dir=tmp_path, client=fake)
    assert await collect(tts, "x", cacheable=True) == [b"partial"]
    assert not tts.is_cached("x")


def test_budget_session_and_monthly():
    b = make_budget(session=100, monthly=150)
    assert b.consume(60)
    assert not b.consume(60)  # session 120 > 100
    assert b.session_used == 60
    b.reset_session()
    assert b.consume(60)  # monthly now 120
    b.reset_session()
    assert not b.consume(60)  # monthly 180 > 150
    assert b.monthly_used == 120


def test_budget_zero_means_no_tts():
    assert not make_budget(session=0).consume(1)
