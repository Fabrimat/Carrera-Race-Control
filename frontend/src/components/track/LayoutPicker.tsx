import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { useT } from '../../i18n/useT'
import { api } from '../../lib/api'
import { guarded } from '../../lib/errors'
import { saveSettings } from '../../lib/settingsSave'
import { useStore } from '../../lib/store'
import { MAX_NAME } from '../../lib/trackEditor'
import type { TrackLayout } from '../../lib/types'

export const editHref = (name: string) => `#/track/${encodeURIComponent(name)}`

function uniqueCopyName(base: string, suffix: string, taken: Set<string>): string {
  const stem = base.slice(0, MAX_NAME - suffix.length - 3)
  let name = `${stem}${suffix}`
  for (let n = 2; taken.has(name); n++) name = `${stem}${suffix} ${n}`
  return name
}

const btn = 'min-h-11 rounded-md border border-line bg-panel-2 px-3 py-2 text-sm font-semibold hover:border-dim'

export function LayoutPicker() {
  const t = useT()
  const current = useStore((s) => s.settings?.track.layout ?? null)
  const defaultName = current ?? ''
  const [layouts, setLayouts] = useState<TrackLayout[] | null>(null)
  const [name, setName] = useState<string | null>(null)
  const [nameError, setNameError] = useState(false)

  const refresh = useCallback(async () => {
    const res = await guarded(() => api.layouts())
    if (res) setLayouts(res.layouts)
    else setLayouts((prev) => prev ?? [])
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh()
  }, [refresh])

  const create = (e: FormEvent) => {
    e.preventDefault()
    const n = (name ?? defaultName).trim()
    if (n.length < 1 || n.length > MAX_NAME) {
      setNameError(true)
      return
    }
    window.location.hash = editHref(n)
  }

  const duplicate = async (l: TrackLayout) => {
    const taken = new Set((layouts ?? []).map((x) => x.name))
    const copy = { ...l, name: uniqueCopyName(l.name, t('track.copy_suffix'), taken) }
    if (await guarded(() => api.saveLayout(copy))) await refresh()
  }

  const remove = async (l: TrackLayout) => {
    if (!window.confirm(t('track.delete_confirm', { name: l.name }))) return
    const res = await guarded(() => api.deleteLayout(l.name))
    if (res) setLayouts(res.layouts)
  }

  const use = async (l: TrackLayout) => {
    const res = await guarded(() => saveSettings((s) => ({ ...s, track: { ...s.track, layout: l.name } })))
    if (res) useStore.getState().pushToast(t('track.use_done', { name: l.name }), 'info')
  }

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 p-5">
      <header>
        <h2 className="text-2xl font-black uppercase tracking-wide">{t('track.title')}</h2>
        <p className="mt-1 text-sm text-dim">{t('track.intro')}</p>
      </header>

      <form onSubmit={create} className="flex flex-wrap items-end gap-3 rounded-lg border border-line bg-panel p-4">
        <label className="flex min-w-60 flex-1 flex-col gap-1 text-xs uppercase tracking-widest text-dim">
          {t('track.new_name')}
          <input
            className="min-h-11 rounded-md border border-line bg-panel-2 px-3 py-2 text-base normal-case tracking-normal text-ink"
            value={name ?? defaultName}
            maxLength={MAX_NAME}
            onChange={(e) => {
              setName(e.target.value)
              setNameError(false)
            }}
          />
        </label>
        <button type="submit" className="min-h-11 rounded-md bg-signal px-4 py-2 font-bold uppercase tracking-wide text-white">
          {t('track.create')}
        </button>
        {nameError && (
          <p role="alert" className="basis-full text-sm text-signal">
            {t('track.name_invalid')}
          </p>
        )}
      </form>

      {layouts === null && <p className="text-dim">{t('common.loading')}</p>}
      {layouts?.length === 0 && <p className="text-dim">{t('track.empty')}</p>}

      <ul className="flex flex-col gap-3">
        {layouts?.map((l) => (
          <li
            key={l.name}
            data-testid={`layout-${l.name}`}
            className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-panel p-3"
          >
            <svg
              viewBox={`0 0 ${(100 * l.aspect).toFixed(1)} 100`}
              className="h-16 shrink-0 rounded bg-panel-2"
              style={{ aspectRatio: String(l.aspect), maxWidth: '8rem' }}
              aria-hidden="true"
            >
              <polygon
                points={l.points
                  .map(([x, y]) => `${(8 + x * (100 * l.aspect - 16)).toFixed(1)},${(8 + y * 84).toFixed(1)}`)
                  .join(' ')}
                fill="none"
                stroke="#8a96a3"
                strokeWidth={3}
                strokeLinejoin="round"
              />
            </svg>
            <div className="min-w-40 flex-1">
              <p className="flex items-center gap-2 text-lg font-bold">
                {l.name}
                {l.name === current && (
                  <span className="rounded-full bg-go px-2 py-0.5 text-xs font-bold uppercase text-black">
                    {t('track.current')}
                  </span>
                )}
              </p>
              <p className="text-xs text-dim">
                {l.source === 'photo' ? t('track.source_photo') : t('track.source_drawn')} ·{' '}
                {t('track.check_lanes', { count: l.sensors.length })}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <a className={`${btn} inline-flex items-center`} href={editHref(l.name)}>
                {t('track.edit')}
              </a>
              {l.name !== current && (
                <button type="button" className={btn} onClick={() => void use(l)}>
                  {t('track.use')}
                </button>
              )}
              <button type="button" className={btn} onClick={() => void duplicate(l)}>
                {t('track.duplicate')}
              </button>
              <button type="button" className={`${btn} text-signal`} onClick={() => void remove(l)}>
                {t('track.delete')}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
