import pytest

from app.commentary.speech import say_gap, say_lap_time, say_number, say_position


@pytest.mark.parametrize(
    ("ms", "expected"),
    [
        (72_340, "un minuto e dodici e trentaquattro"),
        (5_870, "cinque secondi e ottantasette"),
        (7_300, "sette secondi e trenta"),
        (5_010, "cinque secondi e zero uno"),
        (1_000, "un secondo"),
        (60_000, "un minuto"),
        (125_500, "due minuti e cinque e cinquanta"),
        (873, "ottantasette centesimi"),
    ],
)
def test_lap_time_it(ms, expected):
    assert say_lap_time(ms, "it") == expected
    assert say_lap_time(ms) == expected  # Italian is the default


@pytest.mark.parametrize(
    ("ms", "expected"),
    [
        (72_340, "one minute twelve point three four seconds"),
        (7_342, "seven point three four seconds"),
        (5_870, "five point eight seven seconds"),
        (7_300, "seven point three seconds"),
        (1_000, "one second"),
        (120_000, "two minutes"),
    ],
)
def test_lap_time_en(ms, expected):
    assert say_lap_time(ms, "en") == expected


def test_rounding_carries_into_seconds():
    assert say_lap_time(5_999, "it") == "sei secondi"
    assert say_lap_time(59_999, "en") == "one minute"


def test_gap():
    assert say_gap(870, "it") == "ottantasette centesimi"
    assert say_gap(1_500, "it") == "un secondo e cinquanta"
    assert say_gap(1_500, "en") == "one point five seconds"


def test_numbers():
    assert [say_number(n) for n in (0, 1, 8, 15, 21, 28, 100, 180, 1234)] == [
        "zero", "uno", "otto", "quindici", "ventuno", "ventotto", "cento", "centottanta",
        "mille duecentotrentaquattro",
    ]  # fmt: skip
    assert say_number(21, "en") == "twenty one"
    assert say_number(180, "en") == "one hundred eighty"


def test_positions():
    assert [say_position(n) for n in (1, 2, 3, 6)] == ["primo", "secondo", "terzo", "sesto"]
    assert [say_position(n, "en") for n in (1, 2, 3)] == ["first", "second", "third"]
    assert say_position(11) == "undiciesimo"
    assert say_position(11, "en") == "number eleven"


def test_unknown_language_falls_back_to_italian():
    assert say_number(3, "xx") == "tre"
