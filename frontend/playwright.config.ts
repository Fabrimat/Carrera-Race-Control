import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  use: { baseURL: 'http://127.0.0.1:5173' },
  webServer: [
    {
      command: 'uv run uvicorn app.main:app --port 8000',
      cwd: '../backend',
      url: 'http://127.0.0.1:8000/api/state',
      env: { TRACK_MODE: 'simulator' },
      reuseExistingServer: true,
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
