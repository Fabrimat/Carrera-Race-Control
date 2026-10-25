"""Verbalisation helpers (Italian and English): numbers, lap times, gaps, ordinals.

The output is meant to be read by a TTS voice, so everything is spelled out.
Every public helper takes a `lang` ("it" default, or "en"). Adding a language means
adding its private implementation functions and an entry in `_IMPL`.
"""

from __future__ import annotations

from collections.abc import Callable

_UNITS = [
    "zero", "uno", "due", "tre", "quattro", "cinque", "sei", "sette", "otto", "nove",
    "dieci", "undici", "dodici", "tredici", "quattordici", "quindici", "sedici",
    "diciassette", "diciotto", "diciannove",
]  # fmt: skip
_TENS = {
    2: "venti", 3: "trenta", 4: "quaranta", 5: "cinquanta",
    6: "sessanta", 7: "settanta", 8: "ottanta", 9: "novanta",
}  # fmt: skip
_ORDINALS = [
    "", "primo", "secondo", "terzo", "quarto", "quinto", "sesto",
    "settimo", "ottavo", "nono", "decimo",
]  # fmt: skip


def _below_hundred(n: int) -> str:
    if n < 20:
        return _UNITS[n]
    tens, unit = divmod(n, 10)
    word = _TENS[tens]
    if unit == 0:
        return word
    if unit in (1, 8):  # elision: ventuno, ventotto
        word = word[:-1]
    return word + _UNITS[unit]


def _below_thousand(n: int) -> str:
    hundreds, rest = divmod(n, 100)
    if hundreds == 0:
        return _below_hundred(rest)
    head = "cento" if hundreds == 1 else _UNITS[hundreds] + "cento"
    if rest == 0:
        return head
    tail = _below_hundred(rest)
    if tail.startswith("o"):  # centotto, centottanta
        head = head[:-1]
    return head + tail


def _it_say_number(n: int) -> str:
    """Spell out a non-negative integer below one million ("ventuno", "centottanta")."""
    if n < 0:
        return "meno " + _it_say_number(-n)
    if n >= 1_000_000:
        return str(n)
    if n < 1000:
        return _below_thousand(n)
    thousands, rest = divmod(n, 1000)
    head = "mille" if thousands == 1 else _below_thousand(thousands) + "mila"
    return head if rest == 0 else head + " " + _below_thousand(rest)


def _it_say_position(n: int) -> str:
    """Ordinal for a race position: 1 -> "primo". Falls back to "{n}esimo" spelled out."""
    if 1 <= n < len(_ORDINALS):
        return _ORDINALS[n]
    return _it_say_number(n) + "esimo"


def _hundredths(cs: int) -> str:
    return f"zero {_UNITS[cs]}" if cs < 10 else _it_say_number(cs)


def _it_say_lap_time(ms: int) -> str:
    """Natural spoken lap time, rounded to hundredths.

    72_340 -> "un minuto e dodici e trentaquattro"
    5_870  -> "cinque secondi e ottantasette"
    """
    total_cs = max(0, round(ms / 10))
    minutes, rem = divmod(total_cs, 6000)
    seconds, cs = divmod(rem, 100)
    if not minutes and not seconds:
        return _it_say_gap(ms)
    parts: list[str] = []
    if minutes:
        parts.append("un minuto" if minutes == 1 else f"{_it_say_number(minutes)} minuti")
        parts.append(_it_say_number(seconds) if (seconds or cs) else "")
    else:
        parts.append("un secondo" if seconds == 1 else f"{_it_say_number(seconds)} secondi")
    if cs:
        parts.append(_hundredths(cs))
    return " e ".join(p for p in parts if p)


def _it_say_gap(ms: int) -> str:
    """Spoken gap between cars: under a second in hundredths, otherwise like a lap time."""
    cs = max(0, round(ms / 10))
    if cs < 100:
        if cs <= 1:
            return "un centesimo"
        return f"{_it_say_number(cs)} centesimi"
    return _it_say_lap_time(ms)


# --------------------------------------------------------------------------- English

_EN_UNITS = [
    "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
    "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen",
    "eighteen", "nineteen",
]  # fmt: skip
_EN_TENS = {
    2: "twenty", 3: "thirty", 4: "forty", 5: "fifty",
    6: "sixty", 7: "seventy", 8: "eighty", 9: "ninety",
}  # fmt: skip
_EN_ORDINALS = [
    "", "first", "second", "third", "fourth", "fifth", "sixth",
    "seventh", "eighth", "ninth", "tenth",
]  # fmt: skip


def _en_below_thousand(n: int) -> str:
    hundreds, rest = divmod(n, 100)
    words: list[str] = []
    if hundreds:
        words.append(f"{_EN_UNITS[hundreds]} hundred")
    if rest or not hundreds:
        if rest < 20:
            words.append(_EN_UNITS[rest])
        else:
            tens, unit = divmod(rest, 10)
            words.append(_EN_TENS[tens] + (f" {_EN_UNITS[unit]}" if unit else ""))
    return " ".join(words)


def _en_say_number(n: int) -> str:
    if n < 0:
        return "minus " + _en_say_number(-n)
    if n >= 1_000_000:
        return str(n)
    if n < 1000:
        return _en_below_thousand(n)
    thousands, rest = divmod(n, 1000)
    head = _en_below_thousand(thousands) + " thousand"
    return head if rest == 0 else head + " " + _en_below_thousand(rest)


def _en_say_position(n: int) -> str:
    if 1 <= n < len(_EN_ORDINALS):
        return _EN_ORDINALS[n]
    return "number " + _en_say_number(n)


def _en_decimals(cs: int) -> str:
    """Hundredths as spoken digits after "point", dropping a trailing zero (30 -> "three")."""
    digits = f"{cs:02d}".rstrip("0")
    return " ".join(_EN_UNITS[int(d)] for d in digits)


def _en_say_lap_time(ms: int) -> str:
    total_cs = max(0, round(ms / 10))
    minutes, rem = divmod(total_cs, 6000)
    seconds, cs = divmod(rem, 100)
    text = _en_say_number(seconds)
    if cs:
        text += " point " + _en_decimals(cs)
    if minutes:
        head = "one minute" if minutes == 1 else f"{_en_say_number(minutes)} minutes"
        if not seconds and not cs:
            return head
        unit = "second" if (seconds == 1 and not cs) else "seconds"
        return f"{head} {text} {unit}"
    unit = "second" if (seconds == 1 and not cs) else "seconds"
    return f"{text} {unit}"


def _en_say_gap(ms: int) -> str:
    return _en_say_lap_time(ms)


_IMPL: dict[str, dict[str, Callable]] = {
    "it": {
        "number": _it_say_number,
        "position": _it_say_position,
        "lap_time": _it_say_lap_time,
        "gap": _it_say_gap,
    },
    "en": {
        "number": _en_say_number,
        "position": _en_say_position,
        "lap_time": _en_say_lap_time,
        "gap": _en_say_gap,
    },
}


def _impl(lang: str, name: str) -> Callable:
    return _IMPL.get(lang, _IMPL["it"])[name]


def say_number(n: int, lang: str = "it") -> str:
    """Spell out an integer below one million ("ventuno" / "twenty one")."""
    return _impl(lang, "number")(n)


def say_position(n: int, lang: str = "it") -> str:
    """Ordinal for a race position: 1 -> "primo" / "first"."""
    return _impl(lang, "position")(n)


def say_lap_time(ms: int, lang: str = "it") -> str:
    """Natural spoken lap time, rounded to hundredths.

    it: 72_340 -> "un minuto e dodici e trentaquattro"; 5_870 -> "cinque secondi e ottantasette"
    en: 72_340 -> "one minute twelve point three four seconds"; 7_300 -> "seven point three seconds"
    """
    return _impl(lang, "lap_time")(ms)


def say_gap(ms: int, lang: str = "it") -> str:
    """Spoken gap between cars (Italian: under a second in hundredths)."""
    return _impl(lang, "gap")(ms)
