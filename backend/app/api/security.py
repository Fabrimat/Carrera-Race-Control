"""Browser-facing protections for an unauthenticated API bound to localhost.

* **CSRF**: state-changing requests (POST/PUT/PATCH/DELETE) are refused with 403 when the
  browser says they come from another site (``Origin`` not allowed, or
  ``Sec-Fetch-Site: cross-site``). Requests without ``Origin`` (curl, scripts, tests) pass.
* **Cross-site WebSocket hijacking**: ``/ws`` refuses handshakes whose ``Origin`` is not
  allowed (see :func:`origin_allowed`, used by the route).
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
from collections.abc import Mapping

from starlette.types import ASGIApp, Receive, Scope, Send

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


def normalise_origins(origins: list[str]) -> frozenset[str]:
    return frozenset(_norm(o) for o in origins if o.strip())
