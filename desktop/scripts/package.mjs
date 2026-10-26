// Runs electron-builder for the host OS (Windows: nsis; macOS: dmg + zip; Linux: AppImage + deb) and the target architecture (`--arch`, CARRERA_ARCH, else the backend Python's;
// see targetArch in lib.mjs). `--print` only prints the command (dry run).
// The installed Electron (node_modules/electron/dist) is reused only when its binary matches the target
// arch (it follows the arch of the Node that ran `npm install`); otherwise electron-builder downloads the
// right one for the target, so an emulated x64 build on ARM64 (or the reverse) never ships the wrong runtime.
import { join } from 'node:path'
import { desktopDir, hostOs, peArch, run, targetArch } from './lib.mjs'

const arch = targetArch()
const dist = join(desktopDir, 'node_modules', 'electron', 'dist')
const TARGETS = { win: ['--win', 'nsis'], mac: ['--mac', 'dmg', 'zip'], linux: ['--linux', 'AppImage', 'deb'] }
if (!hostOs) {
  console.error(`unsupported platform ${process.platform}`)
  process.exit(1)
}
// electron-builder.yml names the macOS and Linux artifacts with ${env.CARRERA_ARCH} (x64/arm64 on every OS)
process.env.CARRERA_ARCH = arch
const args = ['electron-builder', ...TARGETS[hostOs], `--${arch}`, '--config', 'electron-builder.yml']
if (hostOs === 'win') {
  if (peArch(join(dist, 'electron.exe')) === arch) args.push(`-c.electronDist=${dist}`)
  else console.log(`installed electron is not ${arch}: electron-builder will download it`)
}
// macOS and Linux build natively (npm installs the Electron of the host arch), electron-builder fetches its own.
if (process.argv.includes('--print')) {
  console.log(`npx ${args.join(' ')}`)
} else {
  run('npx', args, desktopDir)
}
