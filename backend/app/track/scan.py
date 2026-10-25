"""Discover Control Units over BLE and serial ports.

CLI: ``python -m app.track.scan [--timeout SECONDS]``
"""

from __future__ import annotations

import argparse
import asyncio
import logging
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from typing import Literal

logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class DeviceInfo:
    address: str
    name: str
    kind: Literal["ble", "serial"]


def _ble_scan() -> Iterable[tuple[str, str]]:
    from carreralib.ble import BLEConnection

    return list(BLEConnection.scan())


def _serial_scan() -> Iterable[tuple[str, str]]:
    from carreralib.serial import SerialConnection

    return list(SerialConnection.scan())


async def _run_scan(
    fn: Callable[[], Iterable[tuple[str, str]]], kind: Literal["ble", "serial"]
) -> list[DeviceInfo]:
    try:
        found = await asyncio.to_thread(fn)
    except Exception as exc:  # missing adapter, bleak errors, permissions...
        logger.warning("%s scan failed: %r", kind, exc)
        return []
    return [DeviceInfo(address=str(a), name=str(n or ""), kind=kind) for a, n in found]


async def scan_devices(
    timeout: float = 5.0,  # noqa: ASYNC109 - signature fixed by the API contract
) -> list[DeviceInfo]:
    """Scan BLE and serial concurrently, off the event loop.

    carreralib's scans cannot be cancelled; if one outlives ``timeout`` its result
    is dropped (the helper thread ends on its own). Failures yield an empty list.
    """
    tasks = [
        asyncio.create_task(_run_scan(_ble_scan, "ble")),
        asyncio.create_task(_run_scan(_serial_scan, "serial")),
    ]
    done, pending = await asyncio.wait(tasks, timeout=timeout)
    for task in pending:
        task.cancel()
    devices: list[DeviceInfo] = []
    for task in tasks:
        if task in done:
            devices.extend(task.result())
    return devices


def main() -> None:
    parser = argparse.ArgumentParser(description="Scan for Carrera Control Units (BLE + serial)")
    parser.add_argument("--timeout", type=float, default=5.0, help="seconds to wait (default 5)")
    args = parser.parse_args()
    devices = asyncio.run(scan_devices(args.timeout))
    if not devices:
        print("No devices found. Is the CU on, Bluetooth enabled and the phone app closed?")
        return
    for d in devices:
        print(f"{d.kind:6} {d.address}  {d.name}")


if __name__ == "__main__":
    main()
