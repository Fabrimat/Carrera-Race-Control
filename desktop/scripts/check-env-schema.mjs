// Fails when .env.example / backend AppConfig and the desktop field table diverge, either way
// (src/config-schema.ts, compiled to dist/config-schema.js). Run after `npm run build`'s tsc step.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { backendDir, desktopDir, repoRoot } from './lib.mjs'

const schema = await import(pathToFileURL(join(desktopDir, 'dist', 'config-schema.js')).href)
const known = new Set([...schema.FIELDS.map((f) => f.env), ...schema.MANAGED_ENV])

const fromExample = new Set()
for (const line of readFileSync(join(repoRoot, '.env.example'), 'utf8').split(/\r?\n/)) {
  const m = /^#?\s*([A-Z][A-Z0-9_]*)=/.exec(line)
  if (m) fromExample.add(m[1])
}

// AppConfig fields: 4-space indented `name: type` lines inside the class body.
const py = readFileSync(join(backendDir, 'app', 'config.py'), 'utf8')
const body = py.slice(py.indexOf('class AppConfig'))
const fromConfig = new Set()
for (const line of body.split(/\r?\n/)) {
  if (/^\S/.test(line) && !line.startsWith('class AppConfig')) break
  const m = /^    ([a-z][a-z0-9_]*):\s/.exec(line)
  if (m && m[1] !== 'model_config') fromConfig.add(m[1].toUpperCase())
}

const documented = new Set([...fromExample, ...fromConfig])
const missing = [...documented].filter((v) => !known.has(v)).sort()
const managed = new Set(schema.MANAGED_ENV)
const stale = schema.FIELDS.map((f) => f.env).filter((v) => !managed.has(v) && !documented.has(v)).sort()
if (missing.length || stale.length) {
  if (missing.length)
    console.error(`check:env FAILED. Missing from desktop/src/config-schema.ts FIELDS: ${missing.join(', ')}`)
  if (stale.length)
    console.error(`check:env FAILED. In FIELDS but in neither .env.example nor AppConfig: ${stale.join(', ')}`)
  process.exit(1)
}
console.log(`check:env ok (${fromExample.size} in .env.example, ${fromConfig.size} in AppConfig, ${known.size} in the table)`)
