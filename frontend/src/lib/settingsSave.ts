import { api } from './api'
import { useStore } from './store'
import type { CarConfig, Settings } from './types'

export const MAX_CAR_NAME = 40
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/

/** Client-side mirror of the backend CarConfig rules; a message key means "invalid". */
export function validateCarPatch(patch: Partial<CarConfig>): Partial<Record<'name' | 'color', true>> {
  const bad: Partial<Record<'name' | 'color', true>> = {}
  if (patch.name !== undefined && (patch.name.trim().length < 1 || patch.name.length > MAX_CAR_NAME)) {
    bad.name = true
  }
  if (patch.color !== undefined && !HEX_COLOR.test(patch.color)) bad.color = true
  return bad
}

let queue: Promise<unknown> = Promise.resolve()

/**
 * Apply `mutate` to the freshest settings in the store and PUT the result, updating the
 * store from the response. Calls are serialised: each one reads the store only after the
 * previous PUT has landed, so concurrent edits (autosave, rename, language switch) never
 * overwrite each other. Rejects with the ApiError on failure.
 */
export function saveSettings(mutate: (s: Settings) => Settings): Promise<Settings | null> {
  const run = async (): Promise<Settings | null> => {
    const current = useStore.getState().settings
    if (!current) return null
    const { keys: _keys, ...settings } = current
    void _keys
    const res = await api.putSettings(mutate(settings))
    useStore.getState().setSettings(res)
    return res
  }
  const next = queue.then(run, run)
  queue = next.catch(() => undefined)
  return next
}

/** Merge per-car patches (keyed by address) into a settings object. */
export function applyCarPatches(s: Settings, patches: Record<number, Partial<CarConfig>>): Settings {
  return { ...s, cars: s.cars.map((c) => (patches[c.address] ? { ...c, ...patches[c.address] } : c)) }
}

/** Best-effort synchronous save for page unload: a keepalive fetch of the merged state. */
export function saveSettingsKeepalive(patches: Record<number, Partial<CarConfig>>): void {
  const current = useStore.getState().settings
  if (!current || Object.keys(patches).length === 0) return
  const { keys: _keys, ...settings } = current
  void _keys
  void fetch('/api/settings', {
    method: 'PUT',
    keepalive: true,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(applyCarPatches(settings, patches)),
  }).catch(() => undefined)
}

/** Rename one car through the safe merge-and-PUT path. */
export function renameCar(address: number, name: string): Promise<Settings | null> {
  return saveSettings((s) => applyCarPatches(s, { [address]: { name } }))
}
