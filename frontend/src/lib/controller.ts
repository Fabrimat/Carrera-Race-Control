// Controller settings helpers (docs/PROTOCOL.md "Roadmap wave 2" -> "Controller settings").
// Raw CU values 0..15 per controller; null = unset (the CU's own value is left alone).
import { useCallback, useEffect, useState } from 'react'
import type { TFunction } from '../i18n'
import { api, ApiError } from './api'
import { apiErrorMessage } from './errors'
import type { ControllerSettings, ControllerStatus } from './types'

export const CTL_MIN = 0
export const CTL_MAX = 15

export type CtlField = 'speed' | 'brake' | 'fuel'
export const CTL_FIELDS: CtlField[] = ['speed', 'brake', 'fuel']

export const EMPTY_CONTROLLER: ControllerSettings = { speed: null, brake: null, fuel: null }

/** Value a field gets when the user switches it from unset to set. */
export const CTL_DEFAULT_ON: Record<CtlField, number> = { speed: 15, brake: 8, fuel: 15 }

/**
 * UI-only presets (never stored as such). The direction of the scales on the real CU is still
 * to be verified, so these are suggestions that the user can adjust.
 */
export const CTL_PRESETS: { id: 'kid' | 'guest' | 'pro'; values: ControllerSettings }[] = [
  { id: 'kid', values: { speed: 6, brake: 12, fuel: 15 } },
  { id: 'guest', values: { speed: 10, brake: 10, fuel: 15 } },
  { id: 'pro', values: { speed: 15, brake: 8, fuel: 15 } },
]

export function clampCtl(n: number): number {
  return Math.min(CTL_MAX, Math.max(CTL_MIN, Math.round(n)))
}

export function isEmptyController(c: ControllerSettings | null | undefined): boolean {
  return !c || (c.speed === null && c.brake === null && c.fuel === null)
}

export function sameController(a: ControllerSettings | null, b: ControllerSettings | null): boolean {
  const x = a ?? EMPTY_CONTROLLER
  const y = b ?? EMPTY_CONTROLLER
  return x.speed === y.speed && x.brake === y.brake && x.fuel === y.fuel
}

/** Error text for pairing / apply calls: a busy race is not the "Control Unit busy" of connecting. */
export function controllerErrorMessage(err: unknown, t: TFunction): string {
  if (err instanceof ApiError && err.code === 'busy') return t('ctl.err_busy')
  return apiErrorMessage(err, t)
}

export type ControllerBadge = 'pending' | 'applied' | 'unset'

export function controllerBadge(s: ControllerStatus | undefined): ControllerBadge {
  if (!s || isEmptyController(s.effective)) return 'unset'
  return s.pending ? 'pending' : 'applied'
}

/** Controller statuses, loaded on mount and every `intervalMs` while mounted. */
export function useControllerStatuses(enabled: boolean, intervalMs = 3000) {
  const [statuses, setStatuses] = useState<ControllerStatus[]>([])
  const reload = useCallback(async () => {
    try {
      setStatuses((await api.controllers()).controllers)
    } catch {
      // offline: keep what we have
    }
  }, [])
  useEffect(() => {
    if (!enabled) return
    const load = () =>
      api.controllers().then(
        (r) => setStatuses(r.controllers),
        () => undefined, // offline: keep what we have
      )
    void load()
    const id = setInterval(() => void load(), intervalMs)
    return () => clearInterval(id)
  }, [enabled, intervalMs])
  return { statuses, setStatuses, reload }
}
