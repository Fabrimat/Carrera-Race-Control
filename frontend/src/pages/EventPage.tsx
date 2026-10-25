import { useEffect, useState } from 'react'
import { ImportExport } from '../components/event/ImportExport'
import { ProgramEditor } from '../components/event/ProgramEditor'
import { useT } from '../i18n/useT'
import { api } from '../lib/api'
import { guarded } from '../lib/errors'
import { useEventUi } from '../lib/eventStore'
import { duplicateProgram, newProgram } from '../lib/program'
import type { EventProgram } from '../lib/types'

const btn = 'rounded-md border border-line bg-panel-2 px-3 py-2 text-sm font-bold uppercase hover:border-amber'

export function EventPage() {
  const t = useT()
  const programs = useEventUi((s) => s.programs)
  const event = useEventUi((s) => s.event)
  const [editing, setEditing] = useState<EventProgram | null>(null)
  const [name, setName] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    useEventUi
      .getState()
      .refresh()
      .catch(() => undefined)
      .finally(() => setLoaded(true))
  }, [])

  const taken = programs.map((p) => p.id)
  const create = () => {
    const n = name.trim()
    if (!n) return
    setEditing(newProgram(n, taken))
    setName('')
  }
  const reload = async () => {
    const res = await guarded(() => api.programs())
    if (res) useEventUi.getState().setPrograms(res.programs)
  }
  const duplicate = async (p: EventProgram) => {
    const copy = duplicateProgram(p, t('ev.copy_name', { name: p.name }), taken)
    if (await guarded(() => api.saveProgram(copy))) await reload()
  }
  const remove = async (id: string) => {
    setConfirmDelete(null)
    const res = await guarded(() => api.deleteProgram(id))
    if (res) useEventUi.getState().setPrograms(res.programs)
  }

  return (
    <div className="mx-auto flex max-w-[1000px] flex-col gap-6 p-4" data-testid="event-page">
      <h2 className="text-2xl font-black uppercase tracking-widest">{t('ev.title')}</h2>

      {editing ? (
        <ProgramEditor
          key={editing.id}
          program={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            void reload()
          }}
        />
      ) : (
        <section className="rounded-lg border border-line bg-panel p-4" aria-label={t('ev.programs')}>
          <h3 className="mb-3 text-sm font-bold uppercase tracking-widest text-dim">{t('ev.programs')}</h3>
          <div className="mb-4 flex flex-wrap items-end gap-2">
            <label className="flex min-w-64 flex-1 flex-col gap-1 text-xs uppercase tracking-widest text-dim">
              {t('ev.new_program')}
              <input
                className="rounded-md border border-line bg-panel-2 px-2 py-2 text-base text-ink"
                value={name}
                maxLength={80}
                data-testid="new-program-name"
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && create()}
              />
            </label>
            <button type="button" className={`${btn} bg-go text-black`} disabled={!name.trim()} data-testid="create-program" onClick={create}>
              {t('ev.create')}
            </button>
          </div>
          {loaded && programs.length === 0 && <p className="text-dim">{t('ev.no_programs')}</p>}
          <ul className="flex flex-col gap-2">
            {programs.map((p) => (
              <li key={p.id} data-testid="program-row" className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-panel-2 p-3">
                <div className="min-w-48 flex-1">
                  <strong>{p.name}</strong>
                  {event?.program_id === p.id && (
                    <span className="ml-2 rounded-full bg-go px-2 py-0.5 text-xs font-bold uppercase text-black">{t('ev.active')}</span>
                  )}
                  <div className="text-sm text-dim">{t('ev.session_count', { count: p.sessions.length })}</div>
                </div>
                <button type="button" className={btn} onClick={() => setEditing(p)}>
                  {t('ev.edit')}
                </button>
                <button type="button" className={btn} onClick={() => void duplicate(p)}>
                  {t('ev.duplicate')}
                </button>
                {confirmDelete === p.id ? (
                  <>
                    <button type="button" className={`${btn} bg-signal text-white`} data-testid="confirm-delete" onClick={() => void remove(p.id)}>
                      {t('ev.confirm_delete')}
                    </button>
                    <button type="button" className={btn} onClick={() => setConfirmDelete(null)}>
                      {t('common.cancel')}
                    </button>
                  </>
                ) : (
                  <button type="button" className={`${btn} text-signal`} onClick={() => setConfirmDelete(p.id)}>
                    {t('ev.delete')}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <ImportExport />
    </div>
  )
}
