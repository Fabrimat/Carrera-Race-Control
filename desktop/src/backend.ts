import { app } from 'electron'
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as path from 'node:path'
import { backendEnv, dataDir, knownEnvNames } from './config'

const HEALTH_TIMEOUT_MS = 90_000
const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000]
const STABLE_AFTER_MS = 30_000

export type BackendState = 'stopped' | 'starting' | 'ready' | 'restarting' | 'failed'

/**
 * Owns the Python backend process: free port, health check, restart with backoff and a
 * kill that cannot leave an orphan (taskkill /T on Windows, a process-group signal elsewhere).
 *
 * Events: 'ready' (port), 'down' (reason; a retry is scheduled).
 */
export class BackendSidecar extends EventEmitter {
  state: BackendState = 'stopped'
  port = 0
  private child: ChildProcess | null = null
  private wanted = false
  private attempt = 0
  private retryTimer: NodeJS.Timeout | null = null
  private startedAt = 0
  private generation = 0
  private stopping = false
  private logStream: fs.WriteStream | null = null

  get origin(): string {
    return `http://127.0.0.1:${this.port}`
  }

  logsDir(): string {
    return path.join(app.getPath('userData'), 'logs')
  }

  dataDir(): string {
    return dataDir()
  }

  start(): void {
    this.wanted = true
    this.attempt = 0
    void this.launch()
  }

  /** Stop, then start again (same port when still free). Used after the keys change. */
  async restart(): Promise<void> {
    if (this.stopping) return
    this.generation++
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    await this.killChild()
    if (this.stopping) return // the app is quitting: do not bring the backend back
    this.attempt = 0
    this.wanted = true
    void this.launch()
  }

  async stop(): Promise<void> {
    this.stopping = true
    this.wanted = false
    this.generation++
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    await this.killChild()
    this.state = 'stopped'
    this.logStream?.end()
    this.logStream = null
  }

  private command(port: number): { cmd: string; args: string[]; cwd: string } {
    // --parent-pid: the backend exits by itself if Electron dies without a clean quit.
    const portArgs = ['--host', '127.0.0.1', '--port', String(port), '--parent-pid', String(process.pid)]
    if (app.isPackaged) {
      const dir = path.join(process.resourcesPath, 'backend')
      return { cmd: path.join(dir, process.platform === 'win32' ? 'carrera-backend.exe' : 'carrera-backend'), args: portArgs, cwd: dir }
    }
    const backendDir = path.resolve(__dirname, '..', '..', 'backend')
    return { cmd: 'uv', args: ['run', 'python', '-m', 'app', ...portArgs], cwd: backendDir }
  }

  private async pickPort(preferred: number): Promise<number> {
    const tryListen = (p: number) =>
      new Promise<number>((resolve, reject) => {
        const srv = net.createServer()
        srv.once('error', reject)
        srv.listen(p, '127.0.0.1', () => {
          const addr = srv.address() as net.AddressInfo
          srv.close(() => resolve(addr.port))
        })
      })
    if (preferred) {
      try {
        return await tryListen(preferred)
      } catch {
        // fall through to a fresh port
      }
    }
    return tryListen(0)
  }

  private async launch(): Promise<void> {
    if (!this.wanted || this.child) return
    const gen = ++this.generation
    this.state = this.attempt === 0 ? 'starting' : 'restarting'
    let port: number
    try {
      port = await this.pickPort(this.port)
    } catch (err) {
      this.scheduleRetry(`no free port: ${(err as Error).message}`)
      return
    }
    if (gen !== this.generation || !this.wanted) return
    this.port = port

    fs.mkdirSync(this.dataDir(), { recursive: true })
    fs.mkdirSync(this.logsDir(), { recursive: true })
    this.logStream?.end()
    const log = fs.createWriteStream(path.join(this.logsDir(), 'backend.log'), { flags: 'a' })
    this.logStream = log

    const { cmd, args, cwd } = this.command(port)
    const inherited = { ...process.env }
    for (const name of knownEnvNames()) delete inherited[name] // the app is the only configurator
    const env: NodeJS.ProcessEnv = {
      ...inherited,
      ...backendEnv(port), // decrypted secrets live only in the child's environment
      PYTHONUNBUFFERED: '1',
      PYTHONIOENCODING: 'utf-8',
    }
    this.startedAt = Date.now()
    log.write(`\n--- ${new Date().toISOString()} start ${path.basename(cmd)} port ${port}\n`)
    // Off Windows the child leads its own process group so the whole tree (uv -> python in dev) can be signalled.
    const child = spawn(cmd, args, {
      cwd,
      env,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child = child
    child.stdout?.on('data', (b: Buffer) => log.write(b))
    child.stderr?.on('data', (b: Buffer) => log.write(b))
    child.once('error', (err) => {
      log.write(`spawn error: ${err.message}\n`)
      if (this.child === child) this.child = null
      if (this.wanted && gen === this.generation) this.scheduleRetry(`spawn error: ${err.message}`)
    })
    child.once('exit', (code, signal) => {
      if (this.child === child) this.child = null
      log.write(`--- exited code=${code} signal=${signal}\n`)
      if (!this.wanted || gen !== this.generation) return
      this.scheduleRetry(`backend exited (${code ?? signal})`)
    })

    const healthy = await this.waitHealthy(port, gen, child)
    if (gen !== this.generation || !this.wanted || this.child !== child) return
    if (healthy) {
      this.state = 'ready'
      this.emit('ready', port)
    }
    // Otherwise the exit handler schedules the retry (the timeout path kills the child).
  }

  private async waitHealthy(port: number, gen: number, child: ChildProcess): Promise<boolean> {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (gen !== this.generation || this.child !== child) return false
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/state`, {
          signal: AbortSignal.timeout(2000),
        })
        if (res.ok) return true
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 300))
    }
    this.logStream?.write('health check timed out, killing backend\n')
    await this.killChild()
    return false
  }

  private scheduleRetry(reason: string): void {
    if (this.retryTimer) return
    if (Date.now() - this.startedAt > STABLE_AFTER_MS) this.attempt = 0
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]
    this.attempt++
    this.state = 'restarting'
    this.emit('down', reason)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.launch()
    }, delay)
  }

  private killChild(): Promise<void> {
    const child = this.child
    if (!child || child.exitCode !== null || child.pid === undefined) {
      this.child = null
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      let exited = false
      let killed = process.platform !== 'win32'
      const finish = () => {
        if (!exited || !killed) return
        clearTimeout(timer)
        if (this.child === child) this.child = null
        resolve()
      }
      const timer = setTimeout(() => {
        exited = killed = true
        finish()
      }, 10_000)
      child.once('exit', () => {
        exited = true
        finish()
      })
      if (process.platform === 'win32') {
        // /T also kills the whole tree (uv -> python in dev). Wait for taskkill itself: if the
        // app exits first, the tree kill is cut short and python is left behind.
        execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, (err, out, errOut) => {
          this.logStream?.write(`taskkill pid ${child.pid}: ${err ? err.message : 'ok'} ${out}${errOut}
`)
          killed = true
          finish()
        })
      } else {
        const signal = (sig: NodeJS.Signals) => {
          try {
            process.kill(-child.pid!, sig) // negative pid: the whole process group
          } catch {
            child.kill(sig)
          }
        }
        signal('SIGTERM')
        setTimeout(() => signal('SIGKILL'), 5000).unref()
      }
    })
  }
}
