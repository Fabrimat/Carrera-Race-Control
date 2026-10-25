// Smoke test: launches the app (dev build, or a packaged exe given as argv[2]) with Playwright's
// Electron driver (taken from frontend's @playwright/test), checks that the backend starts, the
// main window loads, the TV window opens fullscreen through the page's IPC bridge, the keys
// window works, and that no backend process remains after quitting.
//
//   npm run build && node scripts/smoke.mjs [path\to\Carrera Race Control.exe]
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { desktopDir, frontendDir } from './lib.mjs'

const require = createRequire(join(frontendDir, 'package.json'))
const { _electron } = require('@playwright/test')

const exe = process.argv[2]
const userData = mkdtempSync(join(tmpdir(), 'carrera-smoke-'))
const results = []
const check = (name, ok, extra = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ` (${extra})` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(fn, what, timeoutMs = 90_000) {
  const end = Date.now() + timeoutMs
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`)
    await sleep(300)
  }
}

function backendProcesses(port) {
  const ps = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*--port ${port}*' -and $_.ProcessId -ne $PID -and $_.Name -notlike 'powershell*' } | ForEach-Object { "$($_.ProcessId) $($_.Name)" }`
  return execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim()
}

const app = await _electron.launch({
  ...(exe
    ? { executablePath: exe }
    : { executablePath: createRequire(join(desktopDir, 'package.json'))('electron'), args: [desktopDir] }),
  env: {
    ...process.env,
    CARRERA_USER_DATA: userData,
    TRACK_MODE: 'simulator',
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
  },
})
let port = 0
try {
  const main = await waitFor(
    () => app.windows().find((w) => /^http:\/\/127\.0\.0\.1:\d+\//.test(w.url())),
    'main window on the backend',
  )
  port = Number(new URL(main.url()).port)
  check('main window loaded from the backend', true, main.url())
  await main.waitForLoadState('domcontentloaded')
  check(
    'carreraDesktop exposed',
    (await main.evaluate(() => window.carreraDesktop?.isDesktop === true)) === true,
  )
  const state = await main.evaluate(() => fetch('/api/state').then((r) => r.status))
  check('/api/state same-origin', state === 200, String(state))
  const post = await main.evaluate(() =>
    fetch('/api/commentary/mute', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"muted":false}',
    }).then((r) => r.status),
  )
  check('same-origin POST accepted (CSRF rule)', post === 200, String(post))
  check('backend process runs', backendProcesses(port) !== '', backendProcesses(port).replace(/\n/g, '; '))

  const displays = await main.evaluate(() => window.carreraDesktop.listDisplays())
  check('listDisplays', displays.length >= 1 && typeof displays[0].label === 'string', JSON.stringify(displays.map((d) => d.label)))
  const status0 = await main.evaluate(() => window.carreraDesktop.getConfigStatus())
  check('getConfigStatus: OPENAI_API_KEY boolean, no secret values', typeof status0.secrets.OPENAI_API_KEY === 'boolean', JSON.stringify(status0))

  const res = await main.evaluate(() => window.carreraDesktop.openTvWindow())
  check('openTvWindow ok', res.ok === true, JSON.stringify(res))
  const tvPage = await waitFor(() => app.windows().find((w) => w.url().endsWith('#/tv')), 'TV window')
  check('TV window url', tvPage.url().endsWith('/#/tv'), tvPage.url())
  const tvInfo = await waitFor(async () => {
    const info = await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('#/tv'))
      return w ? { fullscreen: w.isFullScreen(), frame: w.getBounds() } : null
    })
    return info?.fullscreen ? info : null
  }, 'TV fullscreen', 15_000)
  check('TV window fullscreen', tvInfo.fullscreen, JSON.stringify(tvInfo.frame))
  await main.evaluate(() => window.carreraDesktop.openTvWindow())
  const tvCount = await app.evaluate(
    ({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((x) => x.webContents.getURL().endsWith('#/tv')).length,
  )
  check('only one TV window', tvCount === 1, String(tvCount))
  await main.evaluate(() => window.carreraDesktop.closeTvWindow())
  await waitFor(
    async () =>
      (await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((x) => x.webContents.getURL().endsWith('#/tv')).length)) === 0,
    'TV window closed',
    10_000,
  )
  check('closeTvWindow', true)

  // keys window: save a fake OpenAI key, then check it is stored encrypted and only a boolean is exposed
  await main.evaluate(() => window.carreraDesktop.setKeys())
  const keysPage = await waitFor(() => app.windows().find((w) => w.url().endsWith('config.html')), 'config window')
  await keysPage.waitForSelector('#f-OPENAI_API_KEY')
  await keysPage.fill('#f-SIM_CARS', '99')
  await keysPage.click('#save')
  await keysPage.waitForSelector('.field-error:not(:empty)')
  check('invalid SIM_CARS rejected with a message', true)
  const pidsBefore = backendProcesses(port)
  await keysPage.fill('#f-SIM_CARS', '3')
  await keysPage.fill('#f-OPENAI_API_KEY', 'sk-smoke-test-not-a-real-key')
  await keysPage.click('#save')
  await waitFor(async () => (await main.evaluate(() => window.carreraDesktop.getConfigStatus()).catch(() => null))?.secrets?.OPENAI_API_KEY === true, 'openai key stored', 15_000)
  check('secret saved, status is a boolean', true)
  const st = await main.evaluate(() => window.carreraDesktop.getConfigStatus())
  check('non-secret value stored (SIM_CARS=3)', st.values.SIM_CARS === '3')
  check('status JSON has no secret value', !JSON.stringify(st).includes('sk-smoke-test'))
  const raw = readFileSync(join(userData, 'keys.enc.json'), 'utf8') + readFileSync(join(userData, 'config.json'), 'utf8')
  check('config files have no plain-text secret', !raw.includes('sk-smoke-test'))
  // the backend restarts and the main window reloads on the same origin
  await waitFor(async () => {
    try {
      return (await fetch(`http://127.0.0.1:${port}/api/state`)).ok
    } catch {
      return false
    }
  }, 'backend back after restart', 60_000)
  await waitFor(() => {
    const now = backendProcesses(port)
    return now !== '' && now !== pidsBefore
  }, 'new backend process', 60_000)
  await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/api/state`).then((r) => r.ok, () => false)), 'new backend serving', 60_000)
  check('backend restarted with a new process after the config change', true)
} catch (err) {
  check('smoke run', false, String(err))
} finally {
  app.process().stdout?.on('data', (d) => process.stdout.write(`[electron] ${d}`))
  const pid = app.process().pid
  const closed = await Promise.race([app.close().then(() => true, () => true), sleep(30_000).then(() => false)])
  if (!closed) {
    console.log(`app.close() did not finish in 30 s; electron pid ${pid}`)
    try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F']) } catch {}
  }
  check('app.close() completes', closed)
}

await sleep(2500)
if (port) {
  const left = backendProcesses(port)
  check('no backend process left after quit', left === '', left.replace(/\n/g, '; '))
  let up = true
  try {
    await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(1500) })
  } catch {
    up = false
  }
  check('backend port closed', !up)
}
try { rmSync(userData, { recursive: true, force: true }) } catch { console.log('could not remove temp profile', userData) }
const failed = results.filter((r) => !r).length
console.log(failed ? `${failed} check(s) FAILED` : 'all checks passed')
process.exit(failed ? 1 : 0)
