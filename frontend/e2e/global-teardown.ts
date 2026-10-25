import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, resolve } from 'node:path'

// Remove the temporary data dir created in playwright.config.ts. Playwright shuts the web
// servers down only after this runs, so on Windows the backend still holds the SQLite file
// open: try now, and if that fails hand the removal to a short-lived detached helper that
// retries once the servers are gone.
export default function globalTeardown() {
  const dir = process.env.E2E_DATA_DIR
  if (!dir) return
  // Only ever delete the dir this setup created: a carrera-e2e-* folder directly in tmp.
  const abs = resolve(dir)
  if (dirname(abs) !== resolve(tmpdir()) || !basename(abs).startsWith('carrera-e2e-')) return
  const opts = { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }
  try {
    rmSync(dir, opts)
    return
  } catch {
    // fall through to the deferred removal
  }
  const script = `
    const { rmSync } = require('node:fs')
    const dir = process.argv[1]
    let tries = 0
    const attempt = () => {
      try { rmSync(dir, { recursive: true, force: true }); return } catch {}
      if (++tries < 20) setTimeout(attempt, 500)
    }
    setTimeout(attempt, 1000)
  `
  spawn(process.execPath, ['-e', script, dir], { detached: true, stdio: 'ignore' }).unref()
}
