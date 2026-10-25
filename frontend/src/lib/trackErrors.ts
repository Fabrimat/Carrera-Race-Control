import type { TFunction, TKey } from '../i18n'
import { ApiError } from './api'
import { apiErrorMessage } from './errors'
import { PhotoError } from './photo'

const PHOTO_CODES = ['llm_unavailable', 'photo_unrecognised', 'image_too_large', 'invalid_image'] as const

/** Translated message for a failed photo import (client-side or backend error). */
export function photoErrorMessage(err: unknown, t: TFunction): string {
  const code = err instanceof PhotoError ? err.code : err instanceof ApiError ? err.code : null
  if (code && (PHOTO_CODES as readonly string[]).includes(code)) return t(`editor.error_${code}` as TKey)
  return apiErrorMessage(err, t)
}
