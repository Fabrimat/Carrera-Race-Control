"""PyInstaller entry point: same as ``python -m app``."""

import multiprocessing

from app.__main__ import main

if __name__ == "__main__":
    multiprocessing.freeze_support()
    main()
