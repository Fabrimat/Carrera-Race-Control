import type { Language } from './types'

function sep(lang: Language): string {
  return lang === 'it' ? ',' : '.'
}

/** ms -> "7.342" under a minute, "1:12.340" above. Italian uses a decimal comma. */
export function formatLapTime(ms: number | null | undefined, lang: Language = 'en'): string {
  if (ms == null) return '–'
  const total = Math.max(0, Math.round(ms))
  const minutes = Math.floor(total / 60000)
  const seconds = Math.floor((total % 60000) / 1000)
  const millis = total % 1000
  const frac = String(millis).padStart(3, '0')
  if (minutes === 0) return `${seconds}${sep(lang)}${frac}`
  return `${minutes}:${String(seconds).padStart(2, '0')}${sep(lang)}${frac}`
}

/** Race clock "m:ss" or "h:mm:ss" (whole seconds). */
export function formatClock(ms: number | null | undefined): string {
  if (ms == null) return '–'
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const ss = String(sec).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/** "+1.234" for a time gap. */
export function formatGap(ms: number, lang: Language = 'en'): string {
  return `+${formatLapTime(ms, lang)}`
}

export function formatDateTime(iso: string | null | undefined, lang: Language): string {
  if (!iso) return '–'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(lang === 'it' ? 'it-IT' : 'en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

export function formatInt(n: number, lang: Language): string {
  return n.toLocaleString(lang === 'it' ? 'it-IT' : 'en-GB')
}
