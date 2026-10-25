import { spawnSync } from 'node:child_process'
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
