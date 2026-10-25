import { useState } from 'react'
import { useT } from '../i18n/useT'
import { api } from '../lib/api'
import { guarded } from '../lib/errors'
import { audioPlayer } from '../lib/audio'
import { useStore } from '../lib/store'
import type { RaceConfig, RaceMode } from '../lib/types'

const MODES: RaceMode[] = ['practice', 'laps', 'timed']

const btn =
  'rounded-md px-5 py-3 text-lg font-bold uppercase tracking-wide transition disabled:cursor-not-allowed disabled:opacity-35'
const field = 'rounded-md border border-line bg-panel-2 px-3 py-2 text-lg num'

export function RaceControls() {
  const t = useT()
  const race = useStore((s) => s.race)
  const defaults = useStore((s) => s.settings?.race)
  const [override, setOverride] = useState<Partial<RaceConfig>>({})
  const [busy, setBusy] = useState(false)
  const cfg: RaceConfig = { ...race.config, ...defaults, ...override }

  const active = race.phase === 'starting' || race.phase === 'running' || race.phase === 'paused'
  const racing = race.phase === 'running' || race.phase === 'paused'

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    void audioPlayer.unlock()
    await guarded(fn)
    setBusy(false)
  }
  const numInput = (key: 'target_laps' | 'duration_s', v: string) => {
    const n = Math.max(1, Math.floor(Number(v) || 1))
    setOverride((o) => ({ ...o, [key]: n }))
  }

  return (
    <section className="rounded-lg border border-line bg-panel p-4" aria-label={t('controls.title')}>
      <div className="mb-3 flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1 text-xs uppercase tracking-widest text-dim">
          {t('controls.mode')}
          <select
            className={field}
            value={cfg.mode}
            disabled={active}
            onChange={(e) => setOverride((o) => ({ ...o, mode: e.target.value as RaceMode }))}
          >
            {MODES.map((m) => (
              <option key={m} value={m}>
                {t(`mode.${m}`)}
              </option>
            ))}
          </select>
        </label>
        {cfg.mode === 'laps' && (
          <label className="flex flex-col gap-1 text-xs uppercase tracking-widest text-dim">
            {t('controls.laps')}
            <input
              className={`${field} w-24`}
              type="number"
              min={1}
              max={999}
              value={cfg.target_laps}
              disabled={active}
              onChange={(e) => numInput('target_laps', e.target.value)}
            />
          </label>
        )}
        {cfg.mode === 'timed' && (
          <label className="flex flex-col gap-1 text-xs uppercase tracking-widest text-dim">
            {t('controls.duration')}
            <input
              className={`${field} w-28`}
              type="number"
              min={10}
              value={cfg.duration_s}
              disabled={active}
              onChange={(e) => numInput('duration_s', e.target.value)}
            />
          </label>
        )}
      </div>
      <div className="flex flex-wrap gap-3">
        <button
          className={`${btn} bg-go text-black`}
          disabled={active || busy}
          onClick={() => void run(() => api.startRace(cfg))}
        >
          {t('controls.start')}
        </button>
        <button
          className={`${btn} bg-signal text-white`}
          disabled={!active || busy}
          onClick={() => void run(() => api.stopRace())}
        >
          {t('controls.stop')}
        </button>
        <button
          className={`${btn} bg-amber text-black`}
          disabled={!racing || busy}
          onClick={() => void run(() => api.paceCar())}
        >
          {race.phase === 'paused' ? t('controls.pace_car_off') : t('controls.pace_car')}
        </button>
        <button
          className={`${btn} border border-line bg-panel-2 text-ink`}
          disabled={busy}
          onClick={() => void run(() => api.resetRace())}
        >
          {t('controls.reset')}
        </button>
      </div>
    </section>
  )
}
