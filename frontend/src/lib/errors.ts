import { ApiError } from './api'
import { tNow, useStore } from './store'
import type { TFunction } from '../i18n'
import type { ConnectionInfo } from './types'

const KNOWN_STATUS = new Set([404, 422, 500, 502, 503])

/** Translated message for a failed REST call; falls back to the backend `detail`. */
export function apiErrorMessage(err: unknown, t: TFunction): string {
  if (err instanceof ApiError) {
    if (err.status === 0) return t('error.offline')
    if (KNOWN_STATUS.has(err.status) && !err.detail) {
      return t(`error.http_${err.status}` as 'error.http_404')
    }
    return err.detail ?? t('error.unknown')
  }
  return err instanceof Error ? err.message : t('error.unknown')
}

/** Translated, actionable text for a connection error code, falling back to `error`. */
export function connectionErrorMessage(c: ConnectionInfo, t: TFunction): string | null {
  if (c.error_code) return t(`connError.${c.error_code}`)
  return c.error
}

export function notifyError(err: unknown): void {
  useStore.getState().pushToast(apiErrorMessage(err, tNow))
}

/** Run an async action, surfacing failures as toasts. */
export async function guarded<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn()
  } catch (e) {
    notifyError(e)
    return undefined
  }
}
