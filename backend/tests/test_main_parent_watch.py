import os
import subprocess
import sys
import threading

import pytest

from app.__main__ import _open_parent_handle, _parent_alive, _wait_handle


def test_parent_alive_for_self() -> None:
    assert _parent_alive(os.getpid())


def test_parent_alive_false_for_exited_process() -> None:
    proc = subprocess.Popen([sys.executable, "-c", "pass"])
    proc.wait()
    assert not _parent_alive(proc.pid)


@pytest.mark.skipif(os.name != "nt", reason="Windows process handles")
def test_wait_on_parent_handle_returns_after_exit() -> None:
    proc = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(0.5)"])
    handle = _open_parent_handle(proc.pid)
    assert handle is not None
    done = threading.Event()
    threading.Thread(target=lambda: (_wait_handle(handle), done.set()), daemon=True).start()
    assert not done.wait(0.1)
    proc.wait()
    assert done.wait(5)
