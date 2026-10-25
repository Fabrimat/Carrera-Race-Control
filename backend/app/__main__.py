"""``python -m app``: run the server on 127.0.0.1:8000.

Shutdown is bounded: carreralib's BLE thread is not a daemon and can keep the process alive
if the Control Unit hangs, so after uvicorn returns we wait briefly for leftover non-daemon
threads and then force the exit.
"""

from __future__ import annotations

import logging
import os
import threading
import time

import uvicorn

EXIT_GRACE_S = 5.0

log = logging.getLogger("app")


def _leftover_threads() -> list[threading.Thread]:
    main = threading.main_thread()
    return [t for t in threading.enumerate() if t is not main and not t.daemon and t.is_alive()]


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    uvicorn.run("app.main:app", host="127.0.0.1", port=8000)
    deadline = time.monotonic() + EXIT_GRACE_S
    for thread in _leftover_threads():
        thread.join(max(0.0, deadline - time.monotonic()))
    stuck = _leftover_threads()
    if stuck:
        log.warning("forcing exit, threads still running: %s", ", ".join(t.name for t in stuck))
        logging.shutdown()
        os._exit(0)


if __name__ == "__main__":
    main()
