// Runs electron-builder for the target architecture (`--arch`, CARRERA_ARCH, else the backend Python's;
// see targetArch in lib.mjs). `--print` only prints the command (dry run).
// The installed Electron (node_modules/electron/dist) is reused only when its binary matches the target
// arch (it follows the arch of the Node that ran `npm install`); otherwise electron-builder downloads the
// right one for the target, so an emulated x64 build on ARM64 (or the reverse) never ships the wrong runtime.
import { join } from 'node:path'
import { desktopDir, peArch, run, targetArch } from './lib.mjs'

const arch = targetArch()
const dist = join(desktopDir, 'node_modules', 'electron', 'dist')
const args = ['electron-builder', '--win', 'nsis', `--${arch}`, '--config', 'electron-builder.yml']
if (peArch(join(dist, 'electron.exe')) === arch) args.push(`-c.electronDist=${dist}`)
else console.log(`installed electron is not ${arch}: electron-builder will download it`)
if (process.argv.includes('--print')) {
  console.log(`npx ${args.join(' ')}`)
} else {
  run('npx', args, desktopDir)
}
