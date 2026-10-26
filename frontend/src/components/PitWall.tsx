import { useState } from 'react'
import { useT } from '../i18n/useT'
import { useStore } from '../lib/store'
import { Leaderboard } from './Leaderboard'
import { Modal } from './Modal'
import { RaceClock } from './RaceClock'
import { RaceControls } from './RaceControls'
import { StartLights } from './StartLights'
import { TrackMap } from './TrackMap'

/** Number of commentary lines shown on the pit wall. */
export const PIT_COMMENTARY_LINES = 3

/**
 * Phone layout: race controls, leaderboard and the latest commentary in one column; the live
 * map opens on tap. `onFull` switches to the full dashboard for this visit.
 */
export function PitWall({ onFull }: { onFull: () => void }) {
  const t = useT()
  const race = useStore((s) => s.race)
  const lines = useStore((s) => s.commentary)
  const [map, setMap] = useState(false)
  const lights = race.phase === 'starting' || race.start_light !== 0
  const latest = lines.slice(-PIT_COMMENTARY_LINES).reverse()

  return (
    <div data-testid="pit-wall" className="flex flex-col gap-3 p-3">
      <section
        className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-panel px-3 py-2"
        aria-label={t('clock.elapsed')}
      >
        <RaceClock race={race} />
        {lights && <StartLights light={race.start_light} />}
        <button
          type="button"
          data-testid="pit-map"
          className="min-h-11 rounded-md border border-line bg-panel-2 px-4 text-sm font-bold uppercase tracking-wide hover:border-amber"
          onClick={() => setMap(true)}
        >
          {t('pit.show_map')}
        </button>
      </section>

      <RaceControls compact />

      <section
        className="min-w-0 rounded-lg border border-line bg-panel-2/40 p-2"
        aria-label={t('leaderboard.title')}
      >
        <Leaderboard
          cars={race.cars}
          bestLap={race.best_lap}
          trackRecord={race.track_record}
          fuelMode={race.fuel_mode}
          editable={false}
          reportable={false}
          compact
          dense
          numSectors={race.num_sectors}
          bestSectors={race.best_sectors}
        />
      </section>

      <section className="rounded-lg border border-line bg-panel p-3" aria-label={t('pit.latest')}>
        <h2 className="mb-2 text-xs font-bold uppercase tracking-widest text-dim">{t('pit.latest')}</h2>
        {latest.length === 0 ? (
          <p className="text-dim">{t('commentary.empty')}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {latest.map((l) => (
              <li
                key={l.id}
                data-testid="pit-commentary-line"
                className={`rounded border-l-4 bg-panel-2 px-3 py-2 ${l.priority === 'high' ? 'border-l-signal' : l.priority === 'normal' ? 'border-l-amber' : 'border-l-line'}`}
              >
                {l.text}
              </li>
            ))}
          </ul>
        )}
      </section>

      <button
        type="button"
        data-testid="pit-full"
        className="min-h-11 rounded-md border border-line bg-panel-2 px-4 text-sm font-bold uppercase tracking-wide text-dim hover:text-ink"
        onClick={onFull}
      >
        {t('pit.full_dashboard')}
      </button>

      {map && (
        <Modal label={t('map.title')} onClose={() => setMap(false)} width="max-w-xl">
          <TrackMap className="flex min-h-64 flex-col" />
          <button
            type="button"
            className="mt-3 min-h-11 self-end rounded-md border border-line px-5 font-bold uppercase"
            onClick={() => setMap(false)}
          >
            {t('pit.close_map')}
          </button>
        </Modal>
      )}
    </div>
  )
}
