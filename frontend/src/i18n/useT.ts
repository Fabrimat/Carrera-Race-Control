import { useCallback } from 'react'
import { translate, type Params, type TFunction, type TKey } from './index'
import { useStore } from '../lib/store'
import { formatGap, formatLapTime } from '../lib/format'
import type { Language } from '../lib/types'

export function useLanguage(): Language {
  return useStore((s) => s.language)
}

export function useT(): TFunction {
  const lang = useLanguage()
  return useCallback((key: TKey, params?: Params) => translate(lang, key, params), [lang])
}

/** Locale-aware time helpers bound to the current UI language. */
export function useFormat() {
  const lang = useLanguage()
  return {
    lang,
    lap: (ms: number | null | undefined) => formatLapTime(ms, lang),
    gap: (ms: number) => formatGap(ms, lang),
  }
}
