import { app } from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  FIELDS,
  MANAGED_ENV,
  errorMessage,
  findField,
  isSecret,
  normaliseList,
  validateValue,
  type FieldSpec,
  type Lang,
  type PlainEnv,
  type SecretEnv,
} from './config-schema'
import { encryptionAvailable, getSecret, hasSecret, updateSecrets } from './secrets'
import type { ConfigSaveRequest, ConfigSaveResult, ConfigStatus } from './shared'

/**
 * Backend configuration. Non-secrets live in userData/config.json (validated with the rules of
 * config-schema.ts), secrets in the encrypted store (secrets.ts). Everything reaches the
 * backend only through its spawn environment (see backendEnv).
 */

function file(): string {
  return path.join(app.getPath('userData'), 'config.json')
}

export function dataDir(): string {
  return path.join(app.getPath('userData'), 'data')
}

function readPlain(): Record<string, string> {
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8')) as { values?: Record<string, unknown> }
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(raw.values ?? {})) {
      const f = findField(k)
      if (f && !isSecret(f) && typeof v === 'string' && v !== '') out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

function writePlain(values: Record<string, string>): void {
  const tmp = `${file()}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, values }, null, 2))
  fs.renameSync(tmp, file())
}

export function getConfigStatus(): ConfigStatus {
  const plain = readPlain()
  const values: Record<string, string> = {}
  const secrets: Record<string, boolean> = {}
  for (const f of FIELDS as readonly FieldSpec[]) {
    if (isSecret(f)) secrets[f.env] = hasSecret(f.env)
    else values[f.env] = plain[f.env] ?? ''
  }
  return {
    encryptionAvailable: encryptionAvailable(),
    values: values as Record<PlainEnv, string>,
    secrets: secrets as Record<SecretEnv, boolean>,
    dataDir: dataDir(),
  }
}

function checkField(f: FieldSpec, value: string, lang: Lang): string | null {
  const err = validateValue(f, value)
  if (err) return errorMessage(err, lang)
  if (f.mustExist && value && !fs.existsSync(value)) return errorMessage({ code: 'missing_file' }, lang)
  return null
}

export function saveConfig(req: ConfigSaveRequest, lang: Lang): ConfigSaveResult {
  const errors: Array<{ env: string; message: string }> = []
  const nextPlain: Record<string, string> = readPlain()
  const secretsSet: Record<string, string> = {}
  const secretsClear: string[] = []

  for (const [env, raw] of Object.entries(req.values ?? {})) {
    const f = findField(env)
    if (!f || isSecret(f) || typeof raw !== 'string') continue
    const value = raw.trim()
    const msg = checkField(f, value, lang)
    if (msg) errors.push({ env, message: msg })
    else if (value === '') delete nextPlain[env]
    else nextPlain[env] = value
  }
  for (const [env, raw] of Object.entries(req.secrets ?? {})) {
    const f = findField(env)
    if (!f || !isSecret(f) || typeof raw !== 'string') continue
    const value = raw.trim()
    if (value === '') continue
    const msg = checkField(f, value, lang)
    if (msg) errors.push({ env, message: msg })
    else secretsSet[env] = value
  }
  for (const env of req.clear ?? []) {
    const f = findField(env)
    if (f && isSecret(f)) secretsClear.push(env)
  }
  if (errors.length) return { ok: false, error: 'invalid', errors }
  if (Object.keys(secretsSet).length > 0 && !encryptionAvailable()) {
    return { ok: false, error: 'encryption_unavailable' }
  }
  try {
    updateSecrets(secretsSet, secretsClear)
    writePlain(nextPlain)
  } catch (err) {
    const unavailable = (err as Error).message === 'encryption_unavailable'
    return { ok: false, error: unavailable ? 'encryption_unavailable' : 'write_failed' }
  }
  return { ok: true }
}

/** Parses KEY=VALUE lines of a .env file (comments, `export`, quotes). Never keeps the file. */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (!m) continue
    let value = m[2]
    const q = value[0]
    if ((q === '"' || q === "'") && value.lastIndexOf(q) > 0) {
      value = value.slice(1, value.lastIndexOf(q))
    } else {
      value = value.replace(/\s+#.*$/, '')
    }
    out[m[1]] = value
  }
  return out
}

export interface ImportOutcome {
  imported: number
  skipped: string[]
  result: ConfigSaveResult
}

/** Imports known variables from .env text: secrets encrypted, invalid values skipped. */
export function importDotenv(text: string, lang: Lang): ImportOutcome {
  const parsed = parseDotenv(text)
  const values: Record<string, string> = {}
  const secrets: Record<string, string> = {}
  const skipped: string[] = []
  let imported = 0
  for (const [env, value] of Object.entries(parsed)) {
    if ((MANAGED_ENV as readonly string[]).includes(env)) {
      skipped.push(env)
      continue
    }
    const f = findField(env)
    if (!f || value === '') continue
    if (checkField(f, value, lang)) {
      skipped.push(env)
      continue
    }
    if (isSecret(f)) secrets[env] = value
    else values[env] = value
    imported++
  }
  // saveConfig overlays only what it is given, so existing settings are kept.
  const result = saveConfig({ values, secrets, clear: [] }, lang)
  return { imported: result.ok ? imported : 0, skipped, result }
}

/** Environment for the backend process. The only place where secrets are decrypted. */
export function backendEnv(port: number): Record<string, string> {
  const env: Record<string, string> = {}
  const plain = readPlain()
  for (const f of FIELDS as readonly FieldSpec[]) {
    const value = isSecret(f) ? getSecret(f.env) : plain[f.env]
    if (value) env[f.env] = value
  }
  // The app's own address must always pass the Host/Origin guards, whatever the user typed.
  const hosts = normaliseList(env.ALLOWED_HOSTS ?? findField('ALLOWED_HOSTS')?.default ?? '')
  for (const h of ['127.0.0.1', 'localhost']) if (!hosts.includes(h)) hosts.push(h)
  env.ALLOWED_HOSTS = hosts.join(',')
  const origins = normaliseList(env.CORS_ORIGINS ?? findField('CORS_ORIGINS')?.default ?? '')
  for (const o of [`http://127.0.0.1:${port}`, `http://localhost:${port}`]) {
    if (!origins.includes(o)) origins.push(o)
  }
  env.CORS_ORIGINS = origins.join(',')
  env.DATA_DIR = dataDir()
  return env
}

/** Names the backend reads from the environment: removed from the inherited env so only this app configures it. */
export function knownEnvNames(): string[] {
  return [...FIELDS.map((f) => f.env), ...MANAGED_ENV]
}
