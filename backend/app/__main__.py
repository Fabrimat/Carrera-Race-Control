"""``python -m app [--host H] [--port P] [--parent-pid PID]``: run the server.

Defaults to 127.0.0.1:8000.

With ``--parent-pid`` (used by the desktop app) the process exits as soon as that parent
process is gone, so a hard-killed desktop app never leaves an orphan backend.

Shutdown is bounded: carreralib's BLE thread is not a daemon and can keep the process alive
if the Control Unit hangs, so after uvicorn returns we wait briefly for leftover non-daemon
threads and then force the exit.
"""

from __future__ import annotations

import argparse
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


def _parent_alive(pid: int) -> bool:
    if os.name == "nt":
        import ctypes

        kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
        handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return False
        try:
            code = ctypes.c_ulong()
            if not kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
                return False
            return code.value == 259  # STILL_ACTIVE
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def _open_parent_handle(pid: int) -> int | None:
    """Windows: a handle that pins the parent process object (no PID reuse while held)."""
    if os.name != "nt":
        return None
    import ctypes

    kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
    kernel32.OpenProcess.restype = ctypes.c_void_p
    synchronize, query_limited = 0x00100000, 0x1000
    handle = kernel32.OpenProcess(synchronize | query_limited, False, pid)
    return int(handle) if handle else None


def _wait_handle(handle: int) -> None:
    import ctypes

    kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
    kernel32.WaitForSingleObject(ctypes.c_void_p(handle), 0xFFFFFFFF)  # INFINITE
    kernel32.CloseHandle(ctypes.c_void_p(handle))


def _watch_parent(pid: int, interval_s: float = 1.0) -> None:
    # Open the handle now, while the parent is alive: waiting on it cannot be fooled by a
    # recycled PID. Fall back to polling where that is not possible.
    handle = _open_parent_handle(pid)
    if handle is None and os.name == "nt":
        log.warning("cannot open parent process %d, polling it instead", pid)

    def run() -> None:
        if handle is not None:
            _wait_handle(handle)
        else:
            while _parent_alive(pid):
                time.sleep(interval_s)
        log.warning("parent process %d is gone, exiting", pid)
        logging.shutdown()
        os._exit(0)

    threading.Thread(target=run, name="parent-watch", daemon=True).start()


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="python -m app")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--parent-pid", type=int, default=None)
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    if args.parent_pid is not None:
        _watch_parent(args.parent_pid)
    # Import the app object directly (not by string) so a frozen build needs no dynamic import.
    from app.main import app

    uvicorn.run(app, host=args.host, port=args.port, log_config=None)
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
