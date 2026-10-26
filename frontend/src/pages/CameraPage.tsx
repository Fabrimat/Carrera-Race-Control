import { useEffect, useMemo, useState, useSyncExternalStore, type ChangeEvent } from 'react'
import { CameraView, type ViewCar } from '../components/camera/CameraView'
import { LayoutPointMap } from '../components/camera/LayoutPointMap'
import { useT } from '../i18n/useT'
import { api } from '../lib/api'
import {
  deleteCalibration,
  exportCalibration,
  loadCalibration,
  parseCalibration,
  saveCalibration,
  solveCalibration,
  type CalibrationPair,
} from '../lib/camera/calibration'
import { cameraEngine, type SourceKind } from '../lib/camera/engine'
import { pathModel } from '../lib/camera/projection'
import { dominantColor, similarity } from '../lib/camera/signature'
import { pointAt, type Pt } from '../lib/geometry'
import { useStore } from '../lib/store'
import type { TrackLayout } from '../lib/types'

const btn =
  'min-h-11 rounded-md border border-line bg-panel-2 px-3 py-2 text-sm font-semibold hover:border-dim disabled:cursor-not-allowed disabled:opacity-40'
const tab = (on: boolean) =>
  `min-h-11 flex-1 rounded-md px-3 py-2 text-sm font-bold uppercase tracking-wide ${
    on ? 'bg-signal text-white' : 'border border-line bg-panel-2 text-dim hover:text-ink'
  }`
const panel = 'flex flex-col gap-3 rounded-lg border border-line bg-panel p-4'
const heading = 'text-sm font-bold uppercase tracking-widest text-dim'

type LayoutState = { kind: 'loading' } | { kind: 'ready'; layout: TrackLayout } | { kind: 'missing' } | { kind: 'error' }

/** Similar signatures above this may be confused by the tracker. */
const SIMILAR = 0.5

export function CameraPage() {
  const t = useT()
  const snap = useSyncExternalStore(cameraEngine.subscribe, cameraEngine.getSnapshot)
  const race = useStore((s) => s.race)
  const layoutName = race.layout
  const [result, setResult] = useState<{ name: string; state: LayoutState; pairs: CalibrationPair[] } | null>(null)
  const loaded = result && result.name === layoutName ? result : null
  const state: LayoutState = loaded ? loaded.state : { kind: 'loading' }
  const layout = state.kind === 'ready' ? state.layout : null
  const [edit, setEdit] = useState<{ name: string; pairs: CalibrationPair[]; dirty: boolean } | null>(null)
  const pairs = useMemo(
    () => (edit && edit.name === layoutName ? edit.pairs : (loaded?.pairs ?? [])),
    [edit, layoutName, loaded],
  )
  const dirty = !!edit && edit.name === layoutName && edit.dirty
  const [pendingImage, setPendingImage] = useState<Pt | null>(null)
  const [mode, setMode] = useState<'calibrate' | 'cars'>('calibrate')
  const [kind, setKind] = useState<SourceKind>(snap.source ?? 'sim')
  const [deviceId, setDeviceId] = useState('')
  const [devices, setDevices] = useState<{ id: string; label: string }[]>([])
  const [frozen, setFrozen] = useState(false)
  const [sampling, setSampling] = useState<number | null>(null)
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  // The layout in use and its stored calibration.
  useEffect(() => {
    let live = true
    const done = (s: LayoutState) =>
      live &&
      setResult({ name: layoutName, state: s, pairs: s.kind === 'ready' ? (loadCalibration(layoutName)?.pairs ?? []) : [] })
    api
      .findLayout(layoutName)
      .then((l) => done(l ? { kind: 'ready', layout: l } : { kind: 'missing' }))
      .catch(() => done({ kind: 'error' }))
    return () => {
      live = false
    }
  }, [layoutName])

  const path = useMemo(() => (layout ? pathModel(layout) : null), [layout])
  const solved = useMemo(() => (layout ? solveCalibration(pairs, layout.aspect) : null), [pairs, layout])
  const h = solved?.ok ? solved.h : null

  useEffect(() => {
    if (layout) cameraEngine.setLayout(layout)
  }, [layout])
  useEffect(() => {
    if (layout) cameraEngine.setCalibration(h)
  }, [layout, h])

  // Leaving the page stops tracking unless it should keep running in the background.
  useEffect(
    () => () => {
      if (!cameraEngine.getSnapshot().background) cameraEngine.stop()
    },
    [],
  )

  // Camera list (labels appear once the permission is granted).
  useEffect(() => {
    const md = globalThis.navigator?.mediaDevices
    if (!md?.enumerateDevices) return
    let live = true
    md.enumerateDevices().then(
      (list) =>
        live &&
        setDevices(
          list
            .filter((d) => d.kind === 'videoinput')
            .map((d, i) => ({ id: d.deviceId, label: d.label || t('camera.device_n', { n: i + 1 }) })),
        ),
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [snap.running, t])

  const cars: ViewCar[] = useMemo(
    () => race.cars.map((c) => ({ address: c.address, name: c.driver_name || c.name, color: c.color })),
    [race.cars],
  )
  const carName = (address: number) => cars.find((c) => c.address === address)?.name ?? t('camera.car_n', { n: address + 1 })

  const setPairs = (next: CalibrationPair[]) => {
    setEdit({ name: layoutName, pairs: next, dirty: true })
    setMessage(null)
  }

  const onImagePick = (p: Pt) => {
    if (mode === 'cars') {
      if (sampling === null) return
      const ok = cameraEngine.captureSignature(sampling, p[0], p[1])
      setMessage(
        ok
          ? { kind: 'ok', text: t('camera.sampled', { name: carName(sampling) }) }
          : { kind: 'error', text: t('camera.sample_failed') },
      )
      if (ok) setSampling(null)
      return
    }
    if (!layout || !path) return
    if (pairs.length === 0) {
      // The first point is always the start/finish line.
      const q = pointAt(path.points, 0, path.cum)
      setPairs([{ image: p, layout: [q[0] / layout.aspect, q[1]] }])
      return
    }
    setPendingImage(p)
  }

  const onLayoutPick = (q: Pt) => {
    if (!pendingImage) return
    setPairs([...pairs, { image: pendingImage, layout: q }])
    setPendingImage(null)
  }

  const save = () => {
    saveCalibration({ version: 1, layout: layoutName, pairs, saved_at: new Date().toISOString() })
    setEdit({ name: layoutName, pairs, dirty: false })
    setMessage({ kind: 'ok', text: t('camera.saved') })
  }

  const clear = () => {
    if (pairs.length && !window.confirm(t('camera.clear_confirm'))) return
    deleteCalibration(layoutName)
    setEdit({ name: layoutName, pairs: [], dirty: false })
    setPendingImage(null)
  }

  const exportJson = () => {
    const json = exportCalibration({ version: 1, layout: layoutName, pairs, saved_at: new Date().toISOString() })
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `camera-${layoutName}.json`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }

  const importJson = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    let data: unknown = null
    try {
      data = JSON.parse(await file.text())
    } catch {
      /* reported below */
    }
    const c = parseCalibration(data)
    if (!c) {
      setMessage({ kind: 'error', text: t('camera.import_invalid') })
      return
    }
    if (c.layout !== layoutName) {
      setMessage({ kind: 'error', text: t('camera.import_other_layout', { name: c.layout }) })
      return
    }
    setPairs(c.pairs)
    setPendingImage(null)
    setMessage({ kind: 'ok', text: t('camera.imported') })
  }

  const start = () => void cameraEngine.start(kind, kind === 'webcam' && deviceId ? deviceId : null)

  const instruction =
    mode === 'cars'
      ? sampling === null
        ? t('camera.cars_hint')
        : t('camera.sample_click', { name: carName(sampling) })
      : pairs.length === 0
        ? t('camera.step_start')
        : pendingImage
          ? t('camera.step_layout', { n: pairs.length + 1 })
          : t('camera.step_image', { n: pairs.length + 1 })

  const errorText = snap.error ? t(`camera.error_${snap.error}`) : null
  const pickable = snap.running && (mode === 'calibrate' ? !pendingImage && !!layout : sampling !== null)

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-4 p-4">
      <header className="flex flex-wrap items-center gap-3">
        <h2 className="text-xl font-black uppercase tracking-wide">{t('camera.title')}</h2>
        <span className="rounded-full bg-amber px-3 py-0.5 text-xs font-bold uppercase text-black">{t('camera.prototype')}</span>
        {snap.running && (
          <span className="num ml-auto text-sm text-dim" data-testid="camera-fps">
            {t('camera.fps', { fps: snap.fps.toFixed(1) })}
          </span>
        )}
      </header>

      <p data-testid="camera-privacy" className="flex items-start gap-2 rounded-md border border-go/40 bg-go/10 p-3 text-sm">
        <svg viewBox="0 0 16 16" className="mt-0.5 h-4 w-4 shrink-0 fill-go" aria-hidden="true">
          <path d="M8 1a3.5 3.5 0 0 0-3.5 3.5V7H4a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1h-.5V4.5A3.5 3.5 0 0 0 8 1Zm-2 6V4.5a2 2 0 1 1 4 0V7H6Z" />
        </svg>
        {t('camera.privacy')}
      </p>

      <section className={panel} aria-label={t('camera.source')}>
        <h3 className={heading}>{t('camera.source')}</h3>
        <div className="flex flex-wrap items-center gap-2">
          <div role="group" aria-label={t('camera.source')} className="flex min-w-72 flex-1 gap-2">
            <button type="button" aria-pressed={kind === 'sim'} className={tab(kind === 'sim')} onClick={() => setKind('sim')} disabled={snap.running}>
              {t('camera.source_sim')}
            </button>
            <button
              type="button"
              aria-pressed={kind === 'webcam'}
              className={tab(kind === 'webcam')}
              onClick={() => setKind('webcam')}
              disabled={snap.running}
            >
              {t('camera.source_webcam')}
            </button>
          </div>
          {kind === 'webcam' && (
            <select
              aria-label={t('camera.device')}
              className="min-h-11 rounded-md border border-line bg-panel-2 px-2 text-sm"
              value={deviceId}
              onChange={(e) => setDeviceId(e.target.value)}
              disabled={snap.running}
            >
              <option value="">{t('camera.device_default')}</option>
              {devices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </select>
          )}
          {snap.running || snap.starting ? (
            <button type="button" className={btn} onClick={() => cameraEngine.stop()}>
              {t('camera.stop')}
            </button>
          ) : (
            <button
              type="button"
              className="min-h-11 rounded-md bg-signal px-4 py-2 font-bold uppercase tracking-wide text-white disabled:opacity-50"
              onClick={start}
              disabled={!layout}
            >
              {t('camera.start')}
            </button>
          )}
        </div>
        <p className="text-sm text-dim">{kind === 'sim' ? t('camera.sim_hint') : t('camera.webcam_hint')}</p>
        {errorText && (
          <p role="alert" className="rounded-md bg-signal/15 p-3 text-sm text-signal">
            {errorText}
          </p>
        )}
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="h-5 w-5 accent-signal"
            checked={snap.background}
            onChange={(e) => cameraEngine.setBackground(e.target.checked)}
          />
          {t('camera.background')}
        </label>
      </section>

      {state.kind === 'loading' && <p className="text-dim">{t('map.loading')}</p>}
      {state.kind === 'error' && <p className="text-signal">{t('map.error')}</p>}
      {state.kind === 'missing' && (
        <div className="flex flex-col items-start gap-3 rounded-lg border border-line bg-panel p-4" data-testid="camera-no-layout">
          <p className="text-dim">{t('camera.no_layout', { name: layoutName })}</p>
          <a href="#/track" className={btn}>
            {t('map.draw')}
          </a>
        </div>
      )}

      {layout && path && (
        <>
          <div role="group" aria-label={t('camera.mode')} className="flex gap-2">
            <button type="button" aria-pressed={mode === 'calibrate'} className={tab(mode === 'calibrate')} onClick={() => setMode('calibrate')}>
              {t('camera.mode_calibrate')}
            </button>
            <button
              type="button"
              aria-pressed={mode === 'cars'}
              className={tab(mode === 'cars')}
              onClick={() => {
                setMode('cars')
                setPendingImage(null)
              }}
            >
              {t('camera.mode_cars')}
            </button>
          </div>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_24rem]">
            <div className="flex flex-col gap-2">
              <p className="text-sm" data-testid="camera-instruction" aria-live="polite">
                {snap.running ? instruction : t('camera.start_first')}
              </p>
              <CameraView
                path={path}
                h={h}
                pairs={mode === 'calibrate' ? pairs : []}
                pendingImage={mode === 'calibrate' ? pendingImage : null}
                frozen={frozen}
                cars={cars}
                onPick={pickable ? onImagePick : null}
                label={t('camera.view')}
              />
              <div className="flex flex-wrap gap-2">
                <button type="button" className={btn} aria-pressed={frozen} onClick={() => setFrozen(!frozen)} disabled={!snap.running}>
                  {frozen ? t('camera.resume') : t('camera.freeze')}
                </button>
              </div>
            </div>

            <aside className="flex flex-col gap-4">
              {mode === 'calibrate' ? (
                <section className={panel} aria-label={t('camera.calibration')}>
                  <h3 className={heading}>{t('camera.calibration')}</h3>
                  <LayoutPointMap path={path} aspect={layout.aspect} pairs={pairs} active={!!pendingImage} onPick={onLayoutPick} />
                  <CalibrationQuality count={pairs.length} solved={solved} />
                  <div className="flex flex-wrap gap-2">
                    {pendingImage && (
                      <button type="button" className={btn} onClick={() => setPendingImage(null)}>
                        {t('camera.cancel_point')}
                      </button>
                    )}
                    <button
                      type="button"
                      className={btn}
                      onClick={() => {
                        setPairs(pairs.slice(0, -1))
                        setPendingImage(null)
                      }}
                      disabled={pairs.length === 0}
                    >
                      {t('camera.undo_point')}
                    </button>
                    <button type="button" className={btn} onClick={clear} disabled={pairs.length === 0 && !dirty}>
                      {t('camera.clear')}
                    </button>
                    <button
                      type="button"
                      className="min-h-11 rounded-md bg-signal px-4 py-2 font-bold uppercase tracking-wide text-white disabled:opacity-50"
                      onClick={save}
                      disabled={!dirty || !solved?.ok}
                    >
                      {t('camera.save')}
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button type="button" className={btn} onClick={exportJson} disabled={pairs.length === 0}>
                      {t('camera.export')}
                    </button>
                    <label className={`${btn} cursor-pointer focus-within:border-amber`}>
                      {t('camera.import')}
                      <input type="file" accept="application/json,.json" className="sr-only" onChange={(e) => void importJson(e)} />
                    </label>
                  </div>
                  {dirty && <p className="text-xs text-amber">{t('camera.unsaved')}</p>}
                </section>
              ) : (
                <section className={panel} aria-label={t('camera.mode_cars')}>
                  <h3 className={heading}>{t('camera.mode_cars')}</h3>
                  {cars.length === 0 && <p className="text-sm text-dim">{t('camera.no_cars')}</p>}
                  <ul className="flex flex-col gap-2">
                    {cars.map((c) => {
                      const sig = snap.signatures[c.address]
                      const twin = sig
                        ? cars.find(
                            (o) => o.address !== c.address && snap.signatures[o.address] && similarity(sig, snap.signatures[o.address]) > SIMILAR,
                          )
                        : undefined
                      return (
                        <li key={c.address} className="flex flex-col gap-2 rounded-md border border-line bg-panel-2 p-2" data-testid="camera-car">
                          <div className="flex items-center gap-2">
                            <span className="h-4 w-4 rounded-full border border-black" style={{ background: c.color }} aria-hidden="true" />
                            <span className="flex-1 truncate font-semibold">{c.name}</span>
                            {sig ? (
                              <span
                                className="h-5 w-8 rounded border border-line"
                                style={{ background: `rgb(${dominantColor(sig).join(',')})` }}
                                title={t('camera.signature')}
                                data-testid="camera-signature"
                              />
                            ) : (
                              <span className="text-xs text-dim">{t('camera.no_signature')}</span>
                            )}
                          </div>
                          <div className="flex flex-wrap gap-2">
                            <button
                              type="button"
                              className={btn}
                              aria-pressed={sampling === c.address}
                              onClick={() => setSampling(sampling === c.address ? null : c.address)}
                              disabled={!snap.running}
                            >
                              {sampling === c.address ? t('camera.sampling') : t('camera.sample')}
                            </button>
                            {sig && (
                              <button type="button" className={btn} onClick={() => cameraEngine.removeSignature(c.address)}>
                                {t('camera.remove_signature')}
                              </button>
                            )}
                          </div>
                          {twin && <p className="text-xs text-amber">{t('camera.similar', { name: twin.name })}</p>}
                        </li>
                      )
                    })}
                  </ul>
                </section>
              )}
              {message && (
                <p
                  role={message.kind === 'error' ? 'alert' : 'status'}
                  className={`rounded-md p-3 text-sm ${message.kind === 'error' ? 'bg-signal/15 text-signal' : 'bg-go/15 text-go'}`}
                >
                  {message.text}
                </p>
              )}
            </aside>
          </div>

          <TrackingTable cars={cars} />
        </>
      )}
    </div>
  )
}

function CalibrationQuality({ count, solved }: { count: number; solved: ReturnType<typeof solveCalibration> | null }) {
  const t = useT()
  if (count < 4) return <p className="text-sm text-dim">{t('camera.need_points', { count: 4 - count })}</p>
  if (!solved?.ok) return <p className="text-sm text-signal">{t('camera.degenerate')}</p>
  // Display units: the layout is 1 high, so the error reads as a percentage of its size.
  const pct = solved.error.rms * 100
  const grade = pct < 1 ? 'good' : pct < 3 ? 'fair' : 'poor'
  return (
    <p className="text-sm" data-testid="camera-error" data-grade={grade}>
      {t('camera.reprojection', { error: pct.toFixed(1) })}{' '}
      <span className={grade === 'good' ? 'text-go' : grade === 'fair' ? 'text-amber' : 'text-signal'}>{t(`camera.grade_${grade}`)}</span>
    </p>
  )
}

function TrackingTable({ cars }: { cars: ViewCar[] }) {
  const t = useT()
  const snap = useSyncExternalStore(cameraEngine.subscribe, cameraEngine.getSnapshot)
  const tracked = cars.filter((c) => snap.signatures[c.address])
  return (
    <section className={panel} aria-label={t('camera.tracking')}>
      <h3 className={heading}>{t('camera.tracking')}</h3>
      {!snap.calibrated && <p className="text-sm text-dim">{t('camera.tracking_needs')}</p>}
      {tracked.length === 0 ? (
        <p className="text-sm text-dim">{t('camera.tracking_none')}</p>
      ) : (
        <table className="w-full text-left text-sm" data-testid="camera-stats">
          <thead className="text-xs uppercase tracking-wide text-dim">
            <tr>
              <th className="py-1 font-semibold">{t('camera.col_car')}</th>
              <th className="py-1 font-semibold">{t('camera.col_rate')}</th>
              <th className="py-1 font-semibold">{t('camera.col_seen')}</th>
              <th className="py-1 font-semibold">{t('camera.col_lap')}</th>
            </tr>
          </thead>
          <tbody>
            {tracked.map((c) => {
              const s = snap.stats[c.address]
              const age = s?.lastSeen != null ? Math.max(0, snap.statsAt - s.lastSeen) / 1000 : null
              return (
                <tr key={c.address} className="border-t border-line">
                  <td className="py-1.5">
                    <span className="mr-2 inline-block h-3 w-3 rounded-full align-middle" style={{ background: c.color }} aria-hidden="true" />
                    {c.name}
                  </td>
                  <td className="num py-1.5">{s ? `${Math.round(s.rate * 100)} %` : '–'}</td>
                  <td className="num py-1.5">{age === null ? t('camera.never') : t('camera.seen_ago', { s: age.toFixed(1) })}</td>
                  <td className="num py-1.5">
                    {s?.s != null ? `${Math.round(s.s * 100)} %` : '–'}
                    {s?.offPath && <span className="ml-2 rounded bg-amber px-1.5 text-xs font-bold uppercase text-black">{t('camera.off_path')}</span>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </section>
  )
}
