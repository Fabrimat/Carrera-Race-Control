"""Brand logos on disk: ``<dir>/<logo id>.<ext>`` (png, jpg, webp or svg).

Same rules as driver photos (:mod:`app.avatars`): the type comes from the content, files are
written atomically and ids are validated against :data:`app.avatars.ID_RE` before they touch a
path. SVG is the risky format, so it is checked on the parsed tree (stdlib only, see
:func:`validate_logo`); the served CSP and ``<img>``-only rendering are the real defence.
See docs/PROTOCOL.md "Roadmap wave 1" -> "Logos".
"""

from __future__ import annotations

import contextlib
import hashlib
import os
import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path

from app.avatars import ID_RE, detect_image

MAX_LOGO_BYTES = 512 * 1024

MEDIA_TYPES = {
    "png": "image/png",
    "jpg": "image/jpeg",
    "webp": "image/webp",
    "svg": "image/svg+xml",
}

_FORBIDDEN_ELEMENTS = {"script", "foreignobject"}
_CSS_URL_RE = re.compile(r"url\(\s*['\"]?\s*([^)'\"]*)", re.IGNORECASE)
_DECLARATION_RE = re.compile(r"<!\s*(doctype|entity)", re.IGNORECASE)
_PROLOG_ENCODING_RE = re.compile(r"^\s*<\?xml[^>]*?encoding\s*=\s*[\"']([^\"']+)", re.IGNORECASE)


def _local(name: str) -> str:
    """Local part of an ElementTree name (``{namespace}local`` or ``local``)."""
    return name.rsplit("}", 1)[-1]


def _css_is_safe(css: str) -> bool:
    if "@import" in css.lower() or "\\" in css:  # CSS escapes could hide either
        return False
    for target in _CSS_URL_RE.findall(css):
        target = target.strip().lower()
        if not (target.startswith("#") or target.startswith("data:")):
            return False
    return True


class _NoDoctypeBuilder(ET.TreeBuilder):
    def doctype(self, name: str, pubid: str | None, system: str | None) -> None:
        raise ET.ParseError("DOCTYPE is not allowed")


def _svg_is_safe(data: bytes) -> bool:
    # Strict UTF-8 only: Expat would auto-detect UTF-16 and slip past the text checks below.
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        return False
    if "\x00" in text or _DECLARATION_RE.search(text):  # entity expansion: never parse
        return False
    prolog = _PROLOG_ENCODING_RE.match(text)
    if prolog and prolog.group(1).lower().replace("_", "-") not in ("utf-8", "utf8"):
        return False
    try:
        parser = ET.XMLParser(target=_NoDoctypeBuilder())
        parser.feed(data)
        root = parser.close()
    except (ET.ParseError, ValueError):
        return False
    if _local(root.tag).lower() != "svg":
        return False
    for element in root.iter():
        if not isinstance(element.tag, str):  # comments / processing instructions
            continue
        local = _local(element.tag).lower()
        if local in _FORBIDDEN_ELEMENTS:
            return False
        if local == "style" and not _css_is_safe("".join(element.itertext())):
            return False
        for key, value in element.attrib.items():
            name = _local(key).lower()
            text = value.strip().lower()
            if name.startswith("on") or text.startswith("javascript:"):
                return False
            if name == "href" and not (text.startswith("#") or text.startswith("data:image/")):
                return False
            if name == "style" and not _css_is_safe(value):
                return False
    return True


def validate_logo(data: bytes) -> str | None:
    """File extension (``png``/``jpg``/``webp``/``svg``) of an acceptable logo, else None."""
    ext = detect_image(data)
    if ext is not None:
        return ext
    body = data.removeprefix(b"\xef\xbb\xbf")
    if body.lstrip()[:1] == b"<" and _svg_is_safe(body):
        return "svg"
    return None


@dataclass(frozen=True)
class StoredLogo:
    path: Path
    media_type: str
    etag: str


class LogoStore:
    def __init__(self, directory: Path) -> None:
        self.directory = directory

    def save(self, logo_id: str, data: bytes, ext: str) -> None:
        """Store the image (replacing any previous one, whatever its type)."""
        if not ID_RE.match(logo_id) or ext not in MEDIA_TYPES:
            raise ValueError(f"invalid logo id or type {logo_id!r}/{ext!r}")
        self.directory.mkdir(parents=True, exist_ok=True)
        target = self.directory / f"{logo_id}.{ext}"
        tmp = self.directory / f"{logo_id}.{os.getpid()}.tmp"
        try:
            tmp.write_bytes(data)
            tmp.replace(target)
        finally:
            with contextlib.suppress(OSError):
                tmp.unlink()
        for other in MEDIA_TYPES:
            if other != ext:
                with contextlib.suppress(OSError):
                    (self.directory / f"{logo_id}.{other}").unlink()

    def get(self, logo_id: str) -> StoredLogo | None:
        if not ID_RE.match(logo_id):
            return None
        for ext, media in MEDIA_TYPES.items():
            path = self.directory / f"{logo_id}.{ext}"
            try:
                stat = path.stat()
            except OSError:
                continue
            etag = hashlib.sha1(f"{stat.st_mtime_ns}-{stat.st_size}".encode()).hexdigest()[:20]
            return StoredLogo(path, media, f'"{etag}"')
        return None

    def delete(self, logo_id: str) -> bool:
        """Remove the image; True if there was one."""
        if not ID_RE.match(logo_id):
            return False
        removed = False
        for ext in MEDIA_TYPES:
            try:
                (self.directory / f"{logo_id}.{ext}").unlink()
                removed = True
            except OSError:
                pass
        return removed
