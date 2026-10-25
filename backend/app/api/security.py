"""Browser-facing protections for an unauthenticated API bound to localhost.

* **CSRF**: state-changing requests (POST/PUT/PATCH/DELETE) are refused with 403 when the
  browser says they come from another site (``Origin`` not allowed, or
  ``Sec-Fetch-Site: cross-site``). Requests without ``Origin`` (curl, scripts, tests) pass.
* **Cross-site WebSocket hijacking**: ``/ws`` refuses handshakes whose ``Origin`` is not
  allowed (see :func:`origin_allowed`, used by the route).
* **Body size**: :class:`BodyLimitMiddleware` answers 413 to bodies above 1 MB (12 MB for
  the photo upload, 5 MB for a configuration import), by ``Content-Length`` and while
  streaming chunked bodies.
* **DNS rebinding**: ``TrustedHostMiddleware`` (wired in ``main.py``) only accepts the
  configured ``Host`` names.

An origin is allowed when it is in the configured list (``CORS_ORIGINS``: the Vite dev
server) or when it is the server's own origin (``Origin`` equals ``http(s)://<Host>``; the
Host header is already validated by TrustedHostMiddleware). The Vite proxy rewrites
``Host`` (changeOrigin) but forwards the browser's ``Origin`` (``http://127.0.0.1:5173``),
which is in the default list.
"""

from __future__ import annotations

import json
import re
from collections.abc import Mapping

from starlette.types import ASGIApp, Message, Receive, Scope, Send

UNSAFE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})


def _norm(origin: str) -> str:
    return origin.strip().rstrip("/").lower()


def origin_allowed(headers: Mapping[str, str], allowed: frozenset[str]) -> bool:
    """True when the request has no ``Origin`` or a trusted one."""
    origin = headers.get("origin")
    if origin is None:
        return True
    origin = _norm(origin)
    if origin in allowed:
        return True
    host = headers.get("host", "").lower()
    return bool(host) and origin in (f"http://{host}", f"https://{host}")


class CSRFMiddleware:
    """Pure ASGI middleware (does not buffer streaming responses)."""

    def __init__(self, app: ASGIApp, allowed_origins: frozenset[str]) -> None:
        self.app = app
        self.allowed = allowed_origins

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http" and scope["method"] in UNSAFE_METHODS:
            headers = {k.decode("latin-1"): v.decode("latin-1") for k, v in scope["headers"]}
            cross_site = headers.get("sec-fetch-site", "").lower() == "cross-site"
            if cross_site or not origin_allowed(headers, self.allowed):
                await _forbidden(send)
                return
        await self.app(scope, receive, send)


async def _forbidden(send: Send) -> None:
    body = json.dumps(
        {"detail": "Cross-origin request refused", "code": "forbidden_origin"}
    ).encode()
    await send(
        {
            "type": "http.response.start",
            "status": 403,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode()),
            ],
        }
    )
    await send({"type": "http.response.body", "body": body})


DEFAULT_BODY_LIMIT = 1024 * 1024
PHOTO_PATH = "/api/layouts/from-photo"
PHOTO_BODY_LIMIT = 12 * 1024 * 1024  # base64 of 8 MB is ~10.7 MB, plus the JSON wrapper
# Driver photos and spoken names are at most 2 MB decoded (~2.8 MB of base64 in JSON).
DRIVER_MEDIA_LIMIT = 3 * 1024 * 1024
TRANSCRIBE_PATH = "/api/event/transcribe"
IMPORT_PATH = "/api/import"
IMPORT_BODY_LIMIT = 5 * 1024 * 1024  # the UI caps bundle files at 5 MB
_DRIVER_PHOTO_RE = re.compile(r"^/api/drivers/[^/]+/photo$")


def _body_rule(path: str) -> tuple[int, bool]:
    """(byte cap, whether an oversized body is an image) for a request path."""
    if path == PHOTO_PATH:
        return PHOTO_BODY_LIMIT, True
    if _DRIVER_PHOTO_RE.match(path):
        return DRIVER_MEDIA_LIMIT, True
    if path == TRANSCRIBE_PATH:
        return DRIVER_MEDIA_LIMIT, False
    if path == IMPORT_PATH:
        return IMPORT_BODY_LIMIT, False
    return DEFAULT_BODY_LIMIT, False


class _BodyTooLarge(Exception):
    pass


class BodyLimitMiddleware:
    """Pure ASGI request-body cap. Chunked bodies are counted while they stream."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        limit, is_photo = _body_rule(scope["path"])
        for key, value in scope["headers"]:
            if key == b"content-length":
                try:
                    declared = int(value)
                except ValueError:
                    declared = 0
                if declared > limit:
                    await _too_large(send, is_photo)
                    return
        received = 0
        exceeded = False

        async def counting_receive() -> Message:
            nonlocal received, exceeded
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > limit:
                    exceeded = True
                    raise _BodyTooLarge
            return message

        async def guarded_send(message: Message) -> None:
            # Once the cap is hit, whatever the app answers (FastAPI turns the aborted body
            # read into a 400) is dropped: the client gets the 413 below.
            if not exceeded:
                await send(message)

        try:
            await self.app(scope, counting_receive, guarded_send)
        except _BodyTooLarge:
            pass
        if exceeded:
            await _too_large(send, is_photo)


async def _too_large(send: Send, is_photo: bool) -> None:
    body = json.dumps(
        {
            "detail": "Request body too large",
            "code": "image_too_large" if is_photo else "invalid_request",
        }
    ).encode()
    await send(
        {
            "type": "http.response.start",
            "status": 413,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode()),
            ],
        }
    )
    await send({"type": "http.response.body", "body": body})


def normalise_origins(origins: list[str]) -> frozenset[str]:
    return frozenset(_norm(o) for o in origins if o.strip())
