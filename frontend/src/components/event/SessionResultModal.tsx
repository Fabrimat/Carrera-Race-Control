import { useEffect, useState } from 'react'
import { useT } from '../../i18n/useT'
import { api } from '../../lib/api'
import { guarded } from '../../lib/errors'
import { activeProgram, useEventUi } from '../../lib/eventStore'
import { Classification } from './Classification'
import { sessionTitle } from './ProgramEditor'

/** End-of-session classification with "Next session". Esc / Close dismisses. */
export function SessionResultModal() {
  const t = useT()
  const finished = useEventUi((s) => s.finished)
  const event = useEventUi((s) => s.event)
  const programs = useEventUi((s) => s.programs)
  const [busy, setBusy] = useState(false)
  const close = () => useEventUi.getState().showFinished(null)

  useEffect(() => {
    if (!finished) return
    const on = (e: KeyboardEvent) => {
      if (e.key === 'Escape') useEventUi.getState().showFinished(null)
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [finished])

  if (!finished) return null
  const program = activeProgram(event, programs)
  const spec = program?.sessions.find((s) => s.id === finished.session_id)
  const index = program ? program.sessions.findIndex((s) => s.id === finished.session_id) : -1
  const hasNext = !!program && index >= 0 && index + 1 < program.sessions.length
  const title = spec ? sessionTitle(t, spec) : t(`ev.kind.${finished.kind}`)

  const next = async () => {
    setBusy(true)
    const e = await guarded(() => (hasNext ? api.nextSession() : api.stopEvent()))
    setBusy(false)
    if (e) {
      useEventUi.getState().setEvent(e)
      close()
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-4" data-testid="session-result">
      <div role="dialog" aria-modal="true" aria-label={t('ev.result_title', { name: title })} className="w-full max-w-2xl rounded-xl border border-amber bg-panel p-5 shadow-2xl">
        <h2 className="mb-1 text-2xl font-black uppercase tracking-widest">{t('ev.result_title', { name: title })}</h2>
        <p className="mb-3 text-sm text-dim">
          {finished.kind === 'qualifying' ? t('ev.result_qualifying') : t('ev.result_final')}
        </p>
        <Classification rows={finished.classification} kind={finished.kind} />
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="rounded-md border border-line px-4 py-2 font-bold uppercase hover:border-amber" onClick={close}>
            {t('ev.close')}
          </button>
          <button
            type="button"
            autoFocus
            disabled={busy}
            data-testid="result-next"
            className="rounded-md bg-go px-5 py-2 font-bold uppercase text-black disabled:opacity-35"
            onClick={() => void next()}
          >
            {hasNext ? t('ev.next_session') : t('ev.finish_event')}
          </button>
        </div>
      </div>
    </div>
  )
}
