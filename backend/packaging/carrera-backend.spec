# PyInstaller spec for the standalone backend (onedir, console exe run hidden by Electron).
# Build:  cd backend && uv run pyinstaller packaging/carrera-backend.spec --noconfirm \
#             --distpath build/pyi-dist --workpath build/pyi-work
# Output: backend/build/pyi-dist/carrera-backend/carrera-backend.exe
# The frontend is NOT bundled here: the Electron packaging places frontend/dist next to the
# exe (<exe dir>/frontend/dist), which is where app.main looks for it in a frozen build.
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_submodules

SPEC_DIR = Path(SPECPATH)  # noqa: F821 (provided by PyInstaller)
BACKEND = SPEC_DIR.parent

hiddenimports = []
datas = []
for pkg in ("app", "uvicorn", "carreralib", "bleak", "elevenlabs", "anthropic", "openai", "winrt"):
    try:
        hiddenimports += collect_submodules(pkg)
        datas += collect_data_files(pkg)
    except Exception as exc:  # optional on other platforms (winrt is Windows only)
        print(f"spec: skipping {pkg}: {exc}")
hiddenimports += ["multipart", "websockets", "httptools", "h11", "anyio._backends._asyncio"]

a = Analysis(
    [str(SPEC_DIR / "entry.py")],
    pathex=[str(BACKEND)],
    datas=datas,
    hiddenimports=hiddenimports,
    excludes=["tkinter", "pytest", "hypothesis"],
)
pyz = PYZ(a.pure)  # noqa: F821
exe = EXE(  # noqa: F821
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="carrera-backend",
    console=True,
    upx=False,
)
coll = COLLECT(exe, a.binaries, a.datas, name="carrera-backend", upx=False)  # noqa: F821
