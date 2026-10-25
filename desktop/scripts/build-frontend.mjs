// Installs and builds the frontend (frontend/dist), which the backend serves.
import { frontendDir, run } from './lib.mjs'

run('npx', ['-y', 'pnpm@9', 'install', '--frozen-lockfile'], frontendDir)
run('npx', ['-y', 'pnpm@9', 'build'], frontendDir)
