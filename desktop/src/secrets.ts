import { app, safeStorage } from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * Encrypted store for secrets (Electron safeStorage, DPAPI on Windows), keyed by environment
 * variable name. File: userData/keys.enc.json = { version: 1, fields: { <ENV>: <base64> } }.
 * Nothing is written in plain text. Never log values.
 */

type Stored = Record<string, string>

function file(): string {
  return path.join(app.getPath('userData'), 'keys.enc.json')
}

export function encryptionAvailable(): boolean {
  return safeStorage.isEncryptionAvailable()
}

function read(): Stored {
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8')) as { fields?: Stored }
    return raw.fields && typeof raw.fields === 'object' ? raw.fields : {}
  } catch {
    return {}
  }
}

function write(fields: Stored): void {
  const tmp = `${file()}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, fields }), { mode: 0o600 })
  fs.renameSync(tmp, file())
}

export function hasSecret(env: string): boolean {
  return Boolean(read()[env])
}

/** Decrypted value, only for building the backend spawn environment. */
export function getSecret(env: string): string | null {
  const b64 = read()[env]
  if (!b64 || !encryptionAvailable()) return null
  try {
    return safeStorage.decryptString(Buffer.from(b64, 'base64'))
  } catch {
    return null
  }
}

/** Applies changes atomically. Throws when encryption is unavailable or the write fails. */
export function updateSecrets(set: Record<string, string>, clear: string[]): void {
  const fields = read()
  for (const env of clear) delete fields[env]
  if (Object.keys(set).length > 0) {
    if (!encryptionAvailable()) throw new Error('encryption_unavailable')
    for (const [env, value] of Object.entries(set)) {
      fields[env] = safeStorage.encryptString(value).toString('base64')
    }
  }
  write(fields)
}
