import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const desktopDir = join(dirname(fileURLToPath(import.meta.url)), '..')
export const repoRoot = join(desktopDir, '..')
export const frontendDir = join(repoRoot, 'frontend')
export const backendDir = join(repoRoot, 'backend')

/** Runs a command in `cwd` (cwd is passed as an option, so paths with spaces are safe). */
export function run(cmd, args, cwd) {
  console.log(`> ${cmd} ${args.join(' ')}   (in ${cwd})`)
  const res = spawnSync(cmd, args, {
    cwd,
    stdio: 'inherit',
    // npx/npm are .cmd shims on Windows; every argument used here is a plain token.
    shell: process.platform === 'win32',
  })
  if (res.status !== 0) {
    console.error(`command failed: ${cmd} ${args.join(' ')}`)
    process.exit(res.status ?? 1)
  }
}

// sysconfig.get_platform() reflects the interpreter build (platform.machine() reports the host under emulation):
// win-amd64, win-arm64, linux-x86_64, linux-aarch64, macosx-13.0-x86_64, macosx-14.0-arm64, macosx-11.0-universal2
function archFromPlatform(machine) {
  if (/(^|[-_])(amd64|x86_64)$/.test(machine)) return 'x64'
  if (/(^|[-_])(arm64|aarch64)$/.test(machine)) return 'arm64'
  return undefined // includes universal2: the PyInstaller output would not match one electron-builder arch
}

/** Operating system key used by electron-builder: win, mac or linux. */
export const hostOs = { win32: 'win', darwin: 'mac', linux: 'linux' }[process.platform]

/** uv python id (for `uv python install` / UV_PYTHON) of a 3.12 build for the host OS and `arch`. */
export function pythonId(arch) {
  const cpu = arch === 'arm64' ? 'aarch64' : 'x86_64'
  const os = { win: 'windows', mac: 'macos', linux: 'linux' }[hostOs]
  return `cpython-3.12-${os}-${cpu}`
}

/** Architecture of the Python uv uses for the backend (it decides the PyInstaller output arch). */
export function pythonArch() {
  // `uv python find` resolves the interpreter uv would use (backend/.venv, else UV_PYTHON/discovery)
  // without syncing (a sync would fail on ARM64 before windows-curses is excluded).
  const found = spawnSync('uv', ['python', 'find'], { cwd: backendDir, encoding: 'utf8' })
  const exe = (found.stdout || '').trim().split(/\r?\n/).pop()
  const res =
    found.status === 0 && exe
      ? spawnSync(exe, ['-c', 'import sysconfig;print(sysconfig.get_platform())'], { encoding: 'utf8' })
      : found
  const machine = (res.stdout || '').trim().split(/\r?\n/).pop()
  const arch = archFromPlatform(machine)
  if (res.status !== 0 || !arch) {
    console.error(`could not detect the backend Python architecture (got "${machine}")
${res.stderr || ''}`)
    process.exit(1)
  }
  return arch
}

/**
 * Target CPU architecture: `--arch <x64|arm64>` argument, else CARRERA_ARCH, else the architecture of the
 * Python uv uses for the backend. PyInstaller cannot cross-compile, so the target must equal that Python's
 * architecture; point uv at the right interpreter otherwise.
 */
export function targetArch(argv = process.argv.slice(2)) {
  const i = argv.indexOf('--arch')
  const wanted = (i >= 0 ? argv[i + 1] : process.env.CARRERA_ARCH) || undefined
  if (wanted !== undefined && wanted !== 'x64' && wanted !== 'arm64') {
    console.error(`unsupported arch "${wanted}" (use x64 or arm64)`)
    process.exit(1)
  }
  const py = pythonArch()
  const arch = wanted ?? py
  if (arch !== py) {
    const id = pythonId(arch)
    console.error(
      `cannot build ${arch}: the backend Python is ${py} and PyInstaller cannot cross-compile.
` +
        `Install a ${arch} Python and select it, e.g.
  uv python install ${id}
  set UV_PYTHON=${id}   (then remove backend\\.venv)`,
    )
    process.exit(1)
  }
  return arch
}

/** Machine type of a Windows PE executable as x64/arm64 (undefined if unknown). */
export function peArch(file) {
  try {
    const b = readFileSync(file)
    const m = b.readUInt16LE(b.readUInt32LE(0x3c) + 4)
    return m === 0x8664 ? 'x64' : m === 0xaa64 ? 'arm64' : undefined
  } catch {
    return undefined
  }
}
