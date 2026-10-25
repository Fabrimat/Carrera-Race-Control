import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, api } from './api'
import { apiErrorMessage, errorCodeKey } from './errors'
import { translate, type TKey, type Params } from '../i18n'
import { en } from '../i18n/en'
import { it as itDict } from '../i18n/it'

const tEn = (key: TKey, params?: Params) => translate('en', key, params)
const tIt = (key: TKey, params?: Params) => translate('it', key, params)

// Every code the backend can send (docs/PROTOCOL.md "Error codes").
const BACKEND_CODES = [
  'not_connected',
  'address_required',
  'start_failed',
  'pace_car_failed',
  'connect_failed',
  'connect_cancelled',
  'settings_invalid',
  'race_not_found',
  'audio_not_found',
  'forbidden_origin',
  'invalid_request',
  'busy',
  'not_found',
  'permission',
  'bluetooth_off',
  'timeout',
  'unknown',
]

describe('apiErrorMessage', () => {
  it('translates every backend error code in both languages', () => {
    for (const code of BACKEND_CODES) {
      const key = errorCodeKey(code)
      expect(key, code).not.toBeNull()
      expect((en as Record<string, string>)[key as string], code).toBeTruthy()
      expect((itDict as Record<string, string>)[key as string], code).toBeTruthy()
    }
  })

  it('prefers the code over the English detail', () => {
    const err = new ApiError(409, 'Not connected to a track', 'not_connected')
    expect(apiErrorMessage(err, tEn)).toBe(en['error.not_connected'])
    expect(apiErrorMessage(err, tIt)).toBe(itDict['error.not_connected'])
  })

  it('maps track error codes to the connection messages', () => {
    const err = new ApiError(409, 'Control Unit busy', 'busy')
    expect(apiErrorMessage(err, tIt)).toBe(itDict['connError.busy'])
  })

  it('falls back to detail for unknown codes, then to the HTTP status', () => {
    expect(apiErrorMessage(new ApiError(500, 'boom', 'brand_new_code'), tEn)).toBe('boom')
    expect(apiErrorMessage(new ApiError(404, null, null), tEn)).toBe(en['error.http_404'])
    expect(apiErrorMessage(new ApiError(0, null), tEn)).toBe(en['error.offline'])
  })
})

describe('api client', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('reads detail and code from error responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ detail: 'Race 9 not found', code: 'race_not_found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    )
    const err = await api.race(9).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).code).toBe('race_not_found')
    expect((err as ApiError).detail).toBe('Race 9 not found')
    expect(apiErrorMessage(err, tEn)).toBe(en['error.race_not_found'])
  })
})
