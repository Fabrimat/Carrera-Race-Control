import type { ExportBundle, ExportSection } from './types'

export const EXPORT_SECTIONS: ExportSection[] = ['settings', 'drivers', 'programs', 'layouts', 'records']

export function exportFilename(date = new Date()): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `carrera-rms-${y}-${m}-${d}.json`
}

export type ParseResult = { ok: true; bundle: ExportBundle } | { ok: false; code: 'import_invalid' | 'import_unsupported' }

/** Parse the text of a chosen file; the backend validates the content in depth. */
export function parseBundle(text: string): ParseResult {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return { ok: false, code: 'import_invalid' }
  }
  if (!data || typeof data !== 'object' || (data as { format?: unknown }).format !== 'carrera-rms') {
    return { ok: false, code: 'import_invalid' }
  }
  if (typeof (data as { version?: unknown }).version !== 'number') return { ok: false, code: 'import_invalid' }
  return { ok: true, bundle: data as ExportBundle }
}

/** Browser download of a JSON document (also used inside the desktop app's renderer). */
export function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
