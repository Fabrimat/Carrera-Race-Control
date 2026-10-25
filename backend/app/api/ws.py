"""WebSocket fan-out hub.

Every client gets its own bounded send queue drained by its own sender task, so a slow
client never blocks the broadcaster or the other clients. When a client's queue is full it
is dropped (the socket is closed; the browser reconnects and resyncs from the snapshot).
Messages are serialised once per broadcast.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from collections.abc import Callable
from typing import Any

from fastapi import WebSocket
from pydantic import BaseModel

log = logging.getLogger(__name__)

DEFAULT_QUEUE_SIZE = 256


def encode(msg_type: str, data: Any) -> str:
    """``{"type": ..., "data": ...}`` as JSON text; pydantic models are dumped in JSON mode."""
    if isinstance(data, BaseModel):
        data = data.model_dump(mode="json")
    return json.dumps({"type": msg_type, "data": data}, separators=(",", ":"))


class _Client:
    def __init__(self, ws: WebSocket, queue_size: int) -> None:
        self.ws = ws
        self.queue: asyncio.Queue[str] = asyncio.Queue(queue_size)
        self.dead = asyncio.Event()


class WsHub:
    def __init__(self, queue_size: int = DEFAULT_QUEUE_SIZE) -> None:
        self._queue_size = queue_size
        self._clients: set[_Client] = set()

    @property
    def client_count(self) -> int:
        return len(self._clients)

    def broadcast(self, msg_type: str, data: Any) -> None:
        """Queue a message for every client. Never blocks, never raises."""
        if not self._clients:
            return
        try:
            text = encode(msg_type, data)
        except Exception:
            log.exception("could not encode %s message", msg_type)
            return
        for client in list(self._clients):
            if client.dead.is_set():
                continue
            try:
                client.queue.put_nowait(text)
            except asyncio.QueueFull:
                log.warning("WebSocket client too slow, dropping it")
                client.dead.set()
                self._clients.discard(client)

    async def serve(self, ws: WebSocket, snapshot: Callable[[], str]) -> None:
        """Run one client connection until it disconnects or is dropped.

        ``snapshot`` returns the encoded snapshot message; it is queued before the client
        is registered (no await in between), so it is always the first message.
        """
        await ws.accept()
        client = _Client(ws, self._queue_size)
        client.queue.put_nowait(snapshot())
        self._clients.add(client)
        tasks = [
            asyncio.create_task(self._sender(client)),
            asyncio.create_task(self._receiver(client)),
            asyncio.create_task(client.dead.wait()),
        ]
        try:
            await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        finally:
            self._clients.discard(client)
            for task in tasks:
                task.cancel()
            for task in tasks:
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await task
            with contextlib.suppress(Exception):
                await ws.close()

    async def _sender(self, client: _Client) -> None:
        try:
            while True:
                text = await client.queue.get()
                await client.ws.send_text(text)
        except asyncio.CancelledError:
            raise
        except Exception:
            client.dead.set()

    async def _receiver(self, client: _Client) -> None:
        """Server -> client only: just wait for the disconnect (ignore anything sent)."""
        try:
            while True:
                message = await client.ws.receive()
                if message.get("type") == "websocket.disconnect":
                    break
        except asyncio.CancelledError:
            raise
        except Exception:
            pass
        client.dead.set()

    def close_all(self) -> None:
        """Ask every client connection to end (used on shutdown)."""
        for client in list(self._clients):
            client.dead.set()
        self._clients.clear()
