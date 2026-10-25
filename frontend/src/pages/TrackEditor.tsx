import { useCallback, useEffect, useMemo, useState } from 'react'
import { LayoutPicker } from '../components/track/LayoutPicker'
import { PhotoImport } from '../components/track/PhotoImport'
import { TrackCanvas, type CanvasMode } from '../components/track/TrackCanvas'
import { useT } from '../i18n/useT'
import { api, ApiError } from '../lib/api'
import { guarded } from '../lib/errors'
import type { Pt } from '../lib/geometry'
import type { PreparedPhoto } from '../lib/photo'
import { saveSettings } from '../lib/settingsSave'
import { useStore } from '../lib/store'
import {
  addSensor,
  checkpoint,
  commit,
  docFromLayout,
  docFromStroke,
  emptyDoc,
  insertAfter,
  insertHandle,
  moveHandle,
  movePit,
  moveSensor,
  moveStart,
  newHistory,
  redo,
  removeHandle,
  removeSensor,
  replace,
  reverseDoc,
  setAspect,
  setPit,
  toLayout,
  undo,
  validateDoc,
  type EditorDoc,
  type History,
} from '../lib/trackEditor'
import type { LayoutDraft, TrackLayout } from '../lib/types'

const ASPECTS: { label: string; value: number }[] = [
  { label: '4:3', value: 4 / 3 },
  { label: '16:9', value: 16 / 9 },
  { label: '3:2', value: 3 / 2 },
  { label: '1:1', value: 1 },
  { label: '3:4', value: 3 / 4 },
]

const btn =
  'min-h-11 rounded-md border border-line bg-panel-2 px-3 py-2 text-sm font-semibold hover:border-dim disabled:cursor-not-allowed disabled:opacity-40'
const tab = (on: boolean) =>
  `min-h-11 flex-1 rounded-md px-3 py-2 text-sm font-bold uppercase tracking-wide ${
    on ? 'bg-signal text-white' : 'border border-line bg-panel-2 text-dim hover:text-ink'
  }`

export function TrackEditor({ layout }: { layout: string | null }) {
  if (layout === null) return <LayoutPicker />
  return <LayoutEditor key={layout} name={layout} />
}

function LayoutEditor({ name }: { name: string }) {
  const t = useT()
  const language = useStore((s) => s.language)
  const current = useStore((s) => s.settings?.track.layout ?? null)
  const [hist, setHist] = useState<History | null>(null)
  const [saved, setSaved] = useState<EditorDoc | null>(null)
  const [source, setSource] = useState<TrackLayout['source']>('drawn')
  const [method, setMethod] = useState<'draw' | 'edit' | 'photo'>('draw')
  const [selected, setSelected] = useState<number | null>(null)
  const [bg, setBg] = useState<string | null>(null)
  // A photo draft is in image-fraction coordinates until saved, whether or not the photo is shown.
  const [pendingPhotoFit, setPendingPhotoFit] = useState(false)
  const [notes, setNotes] = useState<string | null>(null)
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const [isSaved, setIsSaved] = useState(false)

  // Load the layout; an unknown name starts a new one.
  useEffect(() => {
    let alive = true
    const start = (doc: EditorDoc, l?: TrackLayout) => {
      if (!alive) return
      setHist(newHistory(doc))
      setSaved(doc)
      if (l) setSource(l.source)
      setIsSaved(!!l)
      setMethod(doc.path.length > 0 ? 'edit' : 'draw')
    }
    api.layout(name).then(
      (l) => start(docFromLayout(l), l),
      (e: unknown) => {
        if (!(e instanceof ApiError && e.status === 404)) guarded(() => Promise.reject(e))
        start(emptyDoc())
      },
    )
    return () => {
      alive = false
    }
  }, [name])

  const doc = hist?.present ?? null
  const dirty = hist !== null && saved !== null && hist.present !== saved

  // Warn before leaving with unsaved work: tab close, reload and in-app links.
  useEffect(() => {
    if (!dirty) return
    const onUnload = (e: BeforeUnloadEvent) => e.preventDefault()
    const onClick = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.('a[href^="#/"]')
      if (a && !window.confirm(t('editor.leave_confirm'))) {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    window.addEventListener('beforeunload', onUnload)
    document.addEventListener('click', onClick, true)
    return () => {
      window.removeEventListener('beforeunload', onUnload)
      document.removeEventListener('click', onClick, true)
    }
  }, [dirty, t])

  const edit = useCallback((fn: (d: EditorDoc) => EditorDoc, opts: { push: boolean } = { push: true }) => {
    setHist((h) => (h ? (opts.push ? commit(h, fn(h.present)) : replace(h, fn(h.present))) : h))
    setStatus(null)
  }, [])
  const live = useCallback((fn: (d: EditorDoc) => EditorDoc) => edit(fn, { push: false }), [edit])
  const begin = useCallback(() => setHist((h) => (h ? checkpoint(h) : h)), [])
  const doUndo = useCallback(() => setHist((h) => (h ? undo(h) : h)), [])
  const doRedo = useCallback(() => setHist((h) => (h ? redo(h) : h)), [])

  // Ctrl+Z / Ctrl+Y (Ctrl+Shift+Z) outside text fields.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      const k = e.key.toLowerCase()
      if (k === 'z' && !e.shiftKey) doUndo()
      else if (k === 'y' || (k === 'z' && e.shiftKey)) doRedo()
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [doUndo, doRedo])

  const sensorSet = useMemo(() => new Set(doc?.sensors.map((s) => s.sensor)), [doc])

  if (!hist || !doc) return <p className="p-6 text-dim">{t('editor.loading')}</p>

  const canvasMode: CanvasMode = method === 'draw' ? 'draw' : 'edit'
  const hasPath = doc.path.length > 2

  const onStroke = (pts: Pt[]) => {
    const next = docFromStroke(pts, doc.aspect, doc)
    if (!next) {
      setStatus({ kind: 'error', text: t('editor.stroke_too_short') })
      return
    }
    edit(() => next)
    setPendingPhotoFit(false)
    setSelected(null)
    setMethod('edit')
  }

  const onDraft = (draft: LayoutDraft, photo: PreparedPhoto) => {
    const next = docFromLayout(draft.layout)
    edit(() => next)
    setBg(photo.dataUrl)
    setPendingPhotoFit(true)
    setNotes(draft.notes)
    setSource('photo')
    setSelected(null)
    setMethod('edit')
  }

  const save = async () => {
    const problem = validateDoc(doc, name)
    if (problem) {
      setStatus({ kind: 'error', text: t(problem === 'name' ? 'editor.invalid_name' : 'editor.invalid_path') })
      return
    }
    setSaving(true)
    const fit = pendingPhotoFit
    const res = await guarded(() => api.saveLayout(toLayout(doc, name, source, fit)))
    setSaving(false)
    if (!res) return
    // A photo draft is re-fitted to the frame on save: reload from the stored result.
    const next = fit ? docFromLayout(res) : doc
    setHist(fit ? newHistory(next) : (h) => h)
    setSaved(next)
    if (fit) {
      setBg(null)
      setNotes(null)
    }
    setPendingPhotoFit(false)
    setIsSaved(true)
    setStatus({ kind: 'ok', text: t('editor.saved') })
  }

  const useLayout = () =>
    void guarded(() => saveSettings((s) => ({ ...s, track: { ...s.track, layout: name } }))).then((r) => {
      if (r) useStore.getState().pushToast(t('track.use_done', { name }), 'info')
    })

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-4 p-4">
      <header className="flex flex-wrap items-center gap-3">
        <a href="#/track" className="text-sm font-semibold text-dim hover:text-ink">
          ← {t('editor.back')}
        </a>
        <h2 className="text-xl font-black uppercase tracking-wide">{t('editor.title', { name })}</h2>
        {dirty && (
          <span data-testid="dirty-badge" className="rounded-full bg-amber px-3 py-0.5 text-xs font-bold uppercase text-black">
            {t('editor.dirty')}
          </span>
        )}
        <div className="ml-auto flex flex-wrap gap-2">
          <button type="button" className={btn} onClick={doUndo} disabled={hist.past.length === 0}>
            {t('editor.undo')}
          </button>
          <button type="button" className={btn} onClick={doRedo} disabled={hist.future.length === 0}>
            {t('editor.redo')}
          </button>
          {isSaved && !dirty && name !== current && (
            <button type="button" className={btn} onClick={useLayout}>
              {t('track.use')}
            </button>
          )}
          <button
            type="button"
            className="min-h-11 rounded-md bg-signal px-4 py-2 font-bold uppercase tracking-wide text-white disabled:opacity-50"
            onClick={() => void save()}
            disabled={saving}
          >
            {saving ? t('editor.saving') : t('editor.save')}
          </button>
        </div>
      </header>

      {status && (
        <p
          role={status.kind === 'error' ? 'alert' : 'status'}
          className={`rounded-md p-3 text-sm ${status.kind === 'error' ? 'bg-signal/15 text-signal' : 'bg-go/15 text-go'}`}
        >
          {status.text}
        </p>
      )}

      <div role="group" aria-label={t('editor.method')} className="flex gap-2">
        <button type="button" aria-pressed={method === 'draw'} className={tab(method === 'draw')} onClick={() => setMethod('draw')}>
          {t('editor.method_draw')}
        </button>
        <button
          type="button"
          aria-pressed={method === 'edit'}
          className={tab(method === 'edit')}
          onClick={() => setMethod('edit')}
          disabled={!hasPath}
        >
          {t('editor.method_edit')}
        </button>
        <button type="button" aria-pressed={method === 'photo'} className={tab(method === 'photo')} onClick={() => setMethod('photo')}>
          {t('editor.method_photo')}
        </button>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_21rem]">
        <div className="flex flex-col gap-2">
          <p className="text-sm text-dim">{method === 'draw' ? t('editor.draw_hint') : t('editor.edit_hint')}</p>
          <TrackCanvas
            doc={doc}
            mode={canvasMode}
            bg={bg}
            selected={selected}
            onSelect={setSelected}
            onStroke={onStroke}
            onBeginDrag={begin}
            onMoveHandle={(i, p) => live((d) => moveHandle(d, i, p))}
            onMoveStart={(p) => live((d) => moveStart(d, p))}
            onMoveSensor={(n, p) => live((d) => moveSensor(d, n, p))}
            onMovePit={(p) => live((d) => movePit(d, p))}
            onInsert={(p) => {
              const r = insertHandle(doc, p)
              live(() => r.doc)
              setSelected(r.index >= 0 ? r.index : null)
            }}
            onRemove={(i) => {
              live((d) => removeHandle(d, i))
              setSelected(null)
            }}
          />
        </div>

        <aside className="flex flex-col gap-4">
          {method === 'photo' && <PhotoImport name={name} language={language} onDraft={onDraft} />}

          {notes && (
            <p data-testid="photo-notes" className="rounded-md border border-line bg-panel p-3 text-sm">
              {t('editor.photo_notes', { notes })}
            </p>
          )}
          {bg && (
            <div className="flex flex-col gap-2 rounded-md border border-line bg-panel p-3 text-sm">
              <p>{t('editor.photo_loaded')}</p>
              <p className="text-dim">{t('editor.photo_bg_note')}</p>
              <button type="button" className={btn} onClick={() => setBg(null)}>
                {t('editor.photo_bg_remove')}
              </button>
            </div>
          )}

          {method === 'edit' && hasPath && (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={btn}
                disabled={selected === null}
                onClick={() => {
                  if (selected === null) return
                  const r = insertAfter(doc, selected)
                  edit(() => r.doc)
                  setSelected(r.index >= 0 ? r.index : null)
                }}
              >
                {t('editor.point_add')}
              </button>
              <button
                type="button"
                className={btn}
                disabled={selected === null}
                onClick={() => {
                  if (selected === null) return
                  edit((d) => removeHandle(d, selected))
                  setSelected(null)
                }}
              >
                {t('editor.point_remove')}
              </button>
            </div>
          )}

          <section className="flex flex-col gap-3 rounded-lg border border-line bg-panel p-4">
            <h3 className="text-sm font-bold uppercase tracking-widest text-dim">{t('editor.annotations')}</h3>

            <label className="flex flex-col gap-1 text-xs uppercase tracking-widest text-dim">
              {t('editor.aspect')}
              <select
                className="min-h-11 rounded-md border border-line bg-panel-2 px-2 text-base normal-case tracking-normal text-ink"
                value={ASPECTS.find((a) => Math.abs(a.value - doc.aspect) < 0.01)?.label ?? 'custom'}
                disabled={bg !== null || pendingPhotoFit}
                onChange={(e) => {
                  const a = ASPECTS.find((x) => x.label === e.target.value)
                  if (a) edit((d) => setAspect(d, a.value))
                }}
              >
                {!ASPECTS.some((a) => Math.abs(a.value - doc.aspect) < 0.01) && (
                  <option value="custom">{doc.aspect.toFixed(2)}</option>
                )}
                {ASPECTS.map((a) => (
                  <option key={a.label} value={a.label}>
                    {a.label}
                  </option>
                ))}
              </select>
            </label>

            <div>
              <button type="button" className={btn} disabled={!hasPath} onClick={() => edit(reverseDoc)}>
                ⇄ {t('editor.reverse')}
              </button>
              <p className="mt-1 text-xs text-dim">{t('editor.direction_hint')}</p>
            </div>

            <p className="text-xs text-dim">
              <strong className="text-ink">{t('editor.start')}.</strong> {t('editor.start_hint')}
            </p>

            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap gap-2">
                {[2, 3].map((n) =>
                  sensorSet.has(n) ? (
                    <button key={n} type="button" className={btn} onClick={() => edit((d) => removeSensor(d, n))}>
                      − {t('editor.sensor_remove', { n })}
                    </button>
                  ) : (
                    <button key={n} type="button" className={btn} disabled={!hasPath} onClick={() => edit((d) => addSensor(d, n))}>
                      + {t('editor.sensor_add', { n })}
                    </button>
                  ),
                )}
              </div>
              <p className="text-xs text-dim">{t('editor.sensor_hint')}</p>
            </div>

            <button type="button" className={btn} disabled={!hasPath} onClick={() => edit((d) => setPit(d, d.pitS === null))}>
              {doc.pitS === null ? `+ ${t('editor.pit_add')}` : `− ${t('editor.pit_remove')}`}
            </button>

            <button type="button" className={`${btn} text-signal`} onClick={() => {
              edit((d) => ({ ...emptyDoc(d.aspect) }))
              setPendingPhotoFit(false)
              setSelected(null)
              setMethod('draw')
            }}>
              {t('editor.redraw')}
            </button>
          </section>
        </aside>
      </div>
    </div>
  )
}
