import { useMemo, useState } from 'react'
import { useT } from '../i18n/useT'
import { api } from '../lib/api'
import { filterDrivers, loadRecent, resolveTranscript, type Resolved } from '../lib/drivers'
import { guarded } from '../lib/errors'
import { useStore } from '../lib/store'
import type { Driver } from '../lib/types'
import { DriverAvatar } from './DriverAvatar'
import { Modal } from './Modal'
import { VoiceInput } from './VoiceInput'

interface Props {
  title: string
  /** Offer a "no driver" entry (clearing a car). */
  allowNone?: boolean
  onPick: (driver: Driver | null) => void
  onClose: () => void
}

const BIG = 'min-h-12 rounded-md border px-4 py-2 text-base font-bold'

/** Search the roster, pick by touch, add a new driver by name, or say the name. */
export function DriverPicker({ title, allowNone = false, onPick, onClose }: Props) {
  const t = useT()
  const drivers = useStore((s) => s.drivers)
  const [query, setQuery] = useState('')
  const [recent] = useState(loadRecent)
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')
  const [heard, setHeard] = useState<{ text: string; resolved: Resolved } | null>(null)
  const [busy, setBusy] = useState(false)

  const list = useMemo(() => filterDrivers(drivers, query, recent), [drivers, query, recent])
  const guessId = heard?.resolved.kind === 'match' ? heard.resolved.driver.id : null

  const create = async (name: string) => {
    const n = name.trim()
    if (!n || busy) return
    setBusy(true)
    const d = await guarded(() => api.createDriver({ name: n }))
    setBusy(false)
    if (!d) return
    useStore.getState().setDrivers([...useStore.getState().drivers, d])
    onPick(d)
  }

  const onTranscript = (text: string, guess: string | null) =>
    setHeard({ text, resolved: resolveTranscript(text, guess, useStore.getState().drivers) })

  return (
    <Modal label={title} onClose={onClose} width="max-w-xl">
      <div className="mb-3 flex items-center gap-3">
        <h3 className="flex-1 text-lg font-black uppercase tracking-wide">{title}</h3>
        <button type="button" className="rounded-md border border-line px-3 py-1 text-sm" onClick={onClose}>
          {t('common.cancel')}
        </button>
      </div>

      <input
        autoFocus
        type="search"
        value={query}
        placeholder={t('who.search')}
        aria-label={t('who.search')}
        className="mb-3 min-h-12 rounded-md border border-line bg-panel-2 px-3 text-lg"
        onChange={(e) => setQuery(e.target.value)}
      />

      <div className="mb-3 flex flex-wrap items-start gap-3">
        <VoiceInput onTranscript={onTranscript} />
        {heard && (
          <div className="flex min-w-0 flex-1 flex-col gap-2" data-testid="voice-result" role="status">
            <p className="text-sm text-dim">{t('voice.heard', { text: heard.text })}</p>
            {heard.resolved.kind === 'match' && (
              <button
                type="button"
                data-testid="voice-use"
                className={`${BIG} border-go bg-go/20`}
                onClick={() => heard.resolved.kind === 'match' && onPick(heard.resolved.driver)}
              >
                {t('voice.use', { name: heard.resolved.driver.name })}
              </button>
            )}
            {heard.resolved.kind === 'create' && (
              <button
                type="button"
                data-testid="voice-create"
                disabled={busy}
                className={`${BIG} border-amber bg-amber/10`}
                onClick={() => heard.resolved.kind === 'create' && void create(heard.resolved.name)}
              >
                {t('voice.create', { name: heard.resolved.name })}
              </button>
            )}
          </div>
        )}
      </div>

      <ul className="mb-3 flex max-h-80 flex-col gap-2 overflow-y-auto" aria-label={t('who.all')}>
        {allowNone && (
          <li>
            <button
              type="button"
              data-testid="pick-none"
              className={`${BIG} w-full border-line bg-panel-2 text-left text-dim`}
              onClick={() => onPick(null)}
            >
              {t('who.clear_driver')}
            </button>
          </li>
        )}
        {list.map((d) => (
          <li key={d.id}>
            <button
              type="button"
              data-testid="pick-driver"
              data-selected={d.id === guessId}
              className={`${BIG} flex w-full items-center gap-3 text-left ${
                d.id === guessId ? 'border-go bg-go/20' : 'border-line bg-panel-2 hover:border-amber'
              }`}
              onClick={() => onPick(d)}
            >
              <DriverAvatar driver={d} size={36} />
              <span className="truncate">{d.name}</span>
              {d.nickname && <span className="truncate text-sm font-normal text-dim">{d.nickname}</span>}
              {recent.includes(d.id) && !query && (
                <span className="ml-auto text-xs font-normal uppercase tracking-widest text-dim">{t('who.recent')}</span>
              )}
            </button>
          </li>
        ))}
        {list.length === 0 && <li className="px-1 text-dim">{t('who.no_match')}</li>}
      </ul>

      {adding ? (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            void create(newName)
          }}
        >
          <input
            autoFocus
            value={newName}
            maxLength={60}
            aria-label={t('who.new_name')}
            placeholder={t('who.new_name')}
            className="min-h-12 min-w-0 flex-1 rounded-md border border-line bg-panel-2 px-3 text-lg"
            onChange={(e) => setNewName(e.target.value)}
          />
          <button type="submit" disabled={!newName.trim() || busy} className={`${BIG} border-go bg-go/20 disabled:opacity-40`}>
            {t('who.new_add')}
          </button>
        </form>
      ) : (
        <button
          type="button"
          data-testid="new-driver"
          className={`${BIG} border-line bg-panel-2 hover:border-amber`}
          onClick={() => {
            setAdding(true)
            setNewName(query.trim())
          }}
        >
          {t('who.new_driver')}
        </button>
      )}
    </Modal>
  )
}
