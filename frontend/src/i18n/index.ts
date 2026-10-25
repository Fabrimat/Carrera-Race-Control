import { en } from './en'
import { it } from './it'
import type { Language } from '../lib/types'

/** Message dictionary shape: every key of `en` maps to a string. `it` must match it. */
export type Messages = { [K in keyof typeof en]: string }

type PluralBase<K> = K extends `${infer B}_other` ? B : never
/** Plain keys plus plural bases ("laps" for "laps_one"/"laps_other"). */
export type TKey = Exclude<keyof Messages, `${string}_one` | `${string}_other`> | PluralBase<keyof Messages>

export type Params = Record<string, string | number>

export const dictionaries: Record<Language, Messages> = { en, it }

export function detectLanguage(nav: string | undefined = globalThis.navigator?.language): Language {
  return nav && nav.toLowerCase().startsWith('it') ? 'it' : 'en'
}

/**
 * Translate `key` with `{param}` interpolation. When `params.count` is given and
 * `${key}_one` / `${key}_other` exist, the plural form is picked (en/it share
 * the one/other rule: exactly 1 is singular).
 */
export function translate(lang: Language, key: TKey, params?: Params): string {
  const dict = dictionaries[lang] as Record<string, string>
  let template: string | undefined
  if (params && typeof params.count === 'number') {
    template = dict[`${key}_${params.count === 1 ? 'one' : 'other'}`]
  }
  template ??= dict[key] ?? (dictionaries.en as Record<string, string>)[key] ?? key
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (m, name: string) =>
    name in params ? String(params[name]) : m,
  )
}

export type TFunction = (key: TKey, params?: Params) => string
