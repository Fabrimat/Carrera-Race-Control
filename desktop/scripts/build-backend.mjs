// Builds the standalone backend with PyInstaller (onedir) into backend/build/pyi-dist/.
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { backendDir, run, targetArch } from './lib.mjs'

rmSync(join(backendDir, 'build', 'pyi-dist'), { recursive: true, force: true })
const arch = targetArch()
// windows-curses (a Windows-only dependency of carreralib, used by its terminal UI only) has no
// win_arm64 wheel and no sdist, so it cannot be installed on ARM64; the backend never imports curses.
// (uv.lock only requires it on win32, so other platforms need no exclusion.)
const syncArgs = ['sync', '--group', 'dev']
if (process.platform === 'win32' && arch === 'arm64') syncArgs.push('--no-install-package', 'windows-curses')
run('uv', syncArgs, backendDir)
run(
  'uv',
  [
    'run',
    '--no-sync', // keep the environment exactly as synced above
    'pyinstaller',
    'packaging/carrera-backend.spec',
    '--noconfirm',
    '--distpath',
    'build/pyi-dist',
    '--workpath',
    'build/pyi-work',
  ],
  backendDir,
)
