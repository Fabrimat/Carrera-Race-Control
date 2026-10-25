import { app } from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Bounds } from './shared'

/** Small non-secret preferences (userData/desktop-prefs.json). */
export interface Prefs {
  tvDisplayId?: number
  tvDisplayBounds?: Bounds
}

function file(): string {
  return path.join(app.getPath('userData'), 'desktop-prefs.json')
}

export function loadPrefs(): Prefs {
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8')) as Prefs
    return typeof raw === 'object' && raw ? raw : {}
  } catch {
    return {}
  }
}

export function savePrefs(prefs: Prefs): void {
  try {
    fs.writeFileSync(file(), JSON.stringify(prefs, null, 2))
  } catch {
    // Not fatal: the choice is just not remembered.
  }
}
