import { ApiError } from './api'
import { tNow, useStore } from './store'
import { dictionaries, type TFunction, type TKey } from '../i18n'
import type { ConnectionInfo } from './types'

const KNOWN_STATUS = new Set([404, 422, 500, 502, 503])

/** Dictionary key for a backend error code: `error.<code>`, else `connError.<code>`. */
export function errorCodeKey(code: string | null | undefined): TKey | null {
  if (!code) return null
  for (const key of [`error.${code}`, `connError.${code}`]) {
    if (key in dictionaries.en) return key as TKey
  }
  return null
}

/**
 * Translated message for a failed REST call: the backend `code` when known, then a
 * generic message per HTTP status, falling back to the backend `detail`.
 */
export function apiErrorMessage(err: unknown, t: TFunction): string {
  if (err instanceof ApiError) {
    if (err.status === 0) return t('error.offline')
    const key = errorCodeKey(err.code)
    if (key) return t(key)
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
