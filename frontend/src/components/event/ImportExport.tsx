import { useState } from 'react'
import { useT } from '../../i18n/useT'
import { api, ApiError } from '../../lib/api'
import { downloadJson, EXPORT_SECTIONS, MAX_IMPORT_BYTES, exportFilename, parseBundle } from '../../lib/bundle'
import { apiErrorMessage } from '../../lib/errors'
import type { ExportBundle, ExportSection, ImportReport } from '../../lib/types'

type Mode = 'merge' | 'replace'

const box = 'rounded-lg border border-line bg-panel p-4'

/** Export chosen sections to a .json file; import with a mandatory dry-run report first. */
export function ImportExport() {
  const t = useT()
  const [sections, setSections] = useState<ExportSection[]>(EXPORT_SECTIONS)
  const [bundle, setBundle] = useState<ExportBundle | null>(null)
  const [fileName, setFileName] = useState('')
  const [mode, setMode] = useState<Mode>('merge')
  const [dry, setDry] = useState<ImportReport | null>(null)
  const [done, setDone] = useState<ImportReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const toggle = (s: ExportSection) =>
    setSections((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]))

  const fail = (e: unknown) => {
    if (e instanceof ApiError && (e.code === 'import_invalid' || e.code === 'import_unsupported')) {
      setError(t(`error.${e.code}`) + (e.detail ? ` (${e.detail})` : ''))
    } else setError(apiErrorMessage(e, t))
  }

  const doExport = async () => {
    setBusy(true)
    setError(null)
    try {
      downloadJson(exportFilename(), await api.exportBundle(sections))
    } catch (e) {
      fail(e)
    }
    setBusy(false)
  }

  const resetImport = () => {
    setDry(null)
    setDone(null)
  }

  const choose = async (file: File | undefined) => {
    resetImport()
    setError(null)
    setBundle(null)
    if (!file) return
    setFileName(file.name)
    if (file.size > MAX_IMPORT_BYTES) {
      setError(t('ev.io.too_large'))
      return
    }
    let text: string
    try {
      text = await file.text()
    } catch {
      setError(t('error.import_invalid'))
      return
    }
    const parsed = parseBundle(text)
    if (!parsed.ok) {
      setError(t(`error.${parsed.code}`))
      return
    }
    setBundle(parsed.bundle)
    setBusy(true)
    try {
      setDry(await api.importBundle(parsed.bundle, mode, true))
    } catch (e) {
      fail(e)
    }
    setBusy(false)
  }

  const changeMode = async (m: Mode) => {
    setMode(m)
    setDone(null)
    if (!bundle) return
    setBusy(true)
    setError(null)
    try {
      setDry(await api.importBundle(bundle, m, true))
    } catch (e) {
      setDry(null)
      fail(e)
    }
    setBusy(false)
  }

  const apply = async () => {
    if (!bundle) return
    setBusy(true)
    setError(null)
    try {
      setDone(await api.importBundle(bundle, mode, false))
      setDry(null)
    } catch (e) {
      fail(e)
    }
    setBusy(false)
  }

  const report = done ?? dry
  return (
    <section className={box} aria-label={t('ev.io_title')} data-testid="import-export">
      <h3 className="mb-1 text-sm font-bold uppercase tracking-widest text-dim">{t('ev.io_title')}</h3>
      <p className="mb-3 text-sm text-dim">{t('ev.io_hint')}</p>

      <fieldset className="mb-3">
        <legend className="mb-1 text-xs uppercase tracking-widest text-dim">{t('ev.export_sections')}</legend>
        <div className="flex flex-wrap gap-3">
          {EXPORT_SECTIONS.map((s) => (
            <label key={s} className="flex items-center gap-2">
              <input type="checkbox" checked={sections.includes(s)} onChange={() => toggle(s)} />
              {t(`ev.section.${s}`)}
            </label>
          ))}
        </div>
      </fieldset>
      <button
        type="button"
        data-testid="export-btn"
        className="rounded-md bg-amber px-4 py-2 font-bold uppercase text-black disabled:opacity-35"
        disabled={busy || sections.length === 0}
        onClick={() => void doExport()}
      >
        {t('ev.export')}
      </button>
      <p className="mt-1 text-xs text-dim">{t('ev.export_privacy')}</p>

      <hr className="my-4 border-line" />

      <label className="flex flex-col gap-1 text-xs uppercase tracking-widest text-dim">
        {t('ev.import_file')}
        <input
          type="file"
          accept=".json,application/json"
          data-testid="import-file"
          className="text-sm normal-case tracking-normal text-ink"
          onChange={(e) => void choose(e.target.files?.[0])}
        />
      </label>

      {bundle && (
        <div className="mt-3 flex flex-col gap-3">
          <fieldset className="flex flex-wrap items-center gap-4">
            <legend className="sr-only">{t('ev.import_mode')}</legend>
            {(['merge', 'replace'] as const).map((m) => (
              <label key={m} className="flex items-center gap-2">
                <input type="radio" name="import-mode" checked={mode === m} disabled={busy} onChange={() => void changeMode(m)} />
                {t(`ev.mode.${m}`)}
              </label>
            ))}
          </fieldset>
          {mode === 'replace' && (
            <p role="alert" data-testid="replace-warning" className="rounded-md border border-amber bg-[#2a2210] p-2 text-sm">
              {t('ev.replace_warning')}
            </p>
          )}
        </div>
      )}

      {report && (
        <div className="mt-3" data-testid="import-report">
          <h4 className="mb-1 text-sm font-bold uppercase tracking-widest">
            {done ? t('ev.report_applied', { file: fileName }) : t('ev.report_preview', { file: fileName })}
          </h4>
          <table className="w-full text-left">
            <thead className="text-xs uppercase tracking-widest text-dim">
              <tr>
                <th className="py-1">{t('ev.report_section')}</th>
                <th className="py-1 text-right">{t('ev.report_added')}</th>
                <th className="py-1 text-right">{t('ev.report_updated')}</th>
                <th className="py-1 text-right">{t('ev.report_removed')}</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(report.report).map(([name, r]) => (
                <tr key={name} className="border-t border-line">
                  <td className="py-1">{t(`ev.section.${name}` as 'ev.section.settings')}</td>
                  <td className="py-1 text-right num">{r.added}</td>
                  <td className="py-1 text-right num">{r.updated}</td>
                  <td className={`py-1 text-right num ${r.removed > 0 ? 'text-signal' : ''}`}>{r.removed}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {dry && !done && (
            <button
              type="button"
              data-testid="import-apply"
              className="mt-3 rounded-md bg-go px-4 py-2 font-bold uppercase text-black disabled:opacity-35"
              disabled={busy}
              onClick={() => void apply()}
            >
              {t('ev.import_apply')}
            </button>
          )}
        </div>
      )}

      {error && (
        <p role="alert" data-testid="import-error" className="mt-3 rounded-md border border-signal bg-[#2a1210] p-2 text-sm">
          {error}
        </p>
      )}
    </section>
  )
}
