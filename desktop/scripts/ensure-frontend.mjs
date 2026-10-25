// Dev helper: build the frontend only when frontend/dist is missing.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { frontendDir, run } from './lib.mjs'

if (!existsSync(join(frontendDir, 'dist', 'index.html'))) {
  run('npx', ['-y', 'pnpm@9', 'install', '--frozen-lockfile'], frontendDir)
  run('npx', ['-y', 'pnpm@9', 'build'], frontendDir)
}
