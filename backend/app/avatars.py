"""Driver photos on disk: ``<dir>/<driver id>.<ext>`` (jpeg, png or webp).

The type is decided by the magic bytes of the content, never by the declared media type or a
file name. Files are written atomically (temp file + replace). Driver ids are validated against
:data:`ID_RE` before they touch a path, so an id can never escape the directory.
"""

from __future__ import annotations

import contextlib
import hashlib
import os
import re
from dataclasses import dataclass
from pathlib import Path

ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,39}$")
MAX_PHOTO_BYTES = 2 * 1024 * 1024

_EXT_MEDIA = {"jpg": "image/jpeg", "png": "image/png", "webp": "image/webp"}


def detect_image(data: bytes) -> str | None:
    """File extension (``jpg``/``png``/``webp``) from the magic bytes, else None."""
    if data.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    return None


@dataclass(frozen=True)
class StoredPhoto:
    path: Path
    media_type: str
    etag: str


class AvatarStore:
    def __init__(self, directory: Path) -> None:
        self.directory = directory

    def _check(self, driver_id: str) -> None:
        if not ID_RE.match(driver_id):
            raise ValueError(f"invalid driver id {driver_id!r}")

    def save(self, driver_id: str, data: bytes, ext: str) -> None:
        """Store the photo (replacing any previous one, whatever its type)."""
        self._check(driver_id)
        self.directory.mkdir(parents=True, exist_ok=True)
        target = self.directory / f"{driver_id}.{ext}"
        tmp = self.directory / f"{driver_id}.{os.getpid()}.tmp"
        try:
            tmp.write_bytes(data)
            tmp.replace(target)
        finally:
            with contextlib.suppress(OSError):
                tmp.unlink()
        for other in _EXT_MEDIA:
            if other != ext:
                with contextlib.suppress(OSError):
                    (self.directory / f"{driver_id}.{other}").unlink()

    def get(self, driver_id: str) -> StoredPhoto | None:
        if not ID_RE.match(driver_id):
            return None
        for ext, media in _EXT_MEDIA.items():
            path = self.directory / f"{driver_id}.{ext}"
            try:
                stat = path.stat()
            except OSError:
                continue
            etag = hashlib.sha1(f"{stat.st_mtime_ns}-{stat.st_size}".encode()).hexdigest()[:20]
            return StoredPhoto(path, media, f'"{etag}"')
        return None

    def delete(self, driver_id: str) -> bool:
        """Remove the photo; True if there was one."""
        if not ID_RE.match(driver_id):
            return False
        removed = False
        for ext in _EXT_MEDIA:
            try:
                (self.directory / f"{driver_id}.{ext}").unlink()
                removed = True
            except OSError:
                pass
        return removed
