import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig } from '@playwright/test'

// A fresh data dir per e2e run (inherited by workers through the environment) so the
// test never touches backend/data and always starts from default settings.
process.env.E2E_DATA_DIR ??= mkdtempSync(join(tmpdir(), 'carrera-e2e-'))

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  workers: 1,
  globalTeardown: './e2e/global-teardown.ts',
  use: { baseURL: 'http://127.0.0.1:5173' },
  webServer: [
    {
      command: 'uv run uvicorn app.main:app --host 127.0.0.1 --port 8000',
      cwd: '../backend',
      url: 'http://127.0.0.1:8000/api/state',
      env: {
        TRACK_MODE: 'simulator',
        SIM_TIME_SCALE: '20',
        SIM_CARS: '3',
        DATA_DIR: process.env.E2E_DATA_DIR,
      },
      // Never reuse a stray server: it would run with a different data dir / time scale.
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: 'npx -y pnpm@9 dev',
      url: 'http://127.0.0.1:5173',
      reuseExistingServer: true,
      timeout: 60_000,
    },
  ],
})
