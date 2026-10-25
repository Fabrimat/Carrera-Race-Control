// Builds the standalone backend with PyInstaller (onedir) into backend/build/pyi-dist/.
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { backendDir, run } from './lib.mjs'

rmSync(join(backendDir, 'build', 'pyi-dist'), { recursive: true, force: true })
run('uv', ['sync', '--group', 'dev'], backendDir)
run(
  'uv',
  [
    'run',
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
