import { CommentaryFeed } from '../components/CommentaryFeed'
import { ConnectionBar } from '../components/ConnectionBar'
import { EventLog } from '../components/EventLog'
import { LapChart, seriesFromCars } from '../components/LapChart'
import { Leaderboard } from '../components/Leaderboard'
import { RaceClock } from '../components/RaceClock'
import { RaceControls } from '../components/RaceControls'
import { StartLights } from '../components/StartLights'
import { useT } from '../i18n/useT'
import { useStore } from '../lib/store'

export function Dashboard() {
  const t = useT()
  const race = useStore((s) => s.race)
  const starting = race.phase === 'starting'

  return (
    <div className="mx-auto flex max-w-[1500px] flex-col gap-4 p-4">
      <ConnectionBar />
      <div className="grid gap-4 lg:grid-cols-[1fr_auto]">
        <section className="flex flex-wrap items-center justify-between gap-6 rounded-lg border border-line bg-panel p-4">
          <RaceClock race={race} />
          {!starting && race.start_light !== 0 && <StartLights light={race.start_light} />}
        </section>
        <RaceControls />
      </div>
      {starting && (
        <section className="flex justify-center rounded-lg border border-signal bg-black p-8" data-testid="starting-panel">
          <StartLights light={race.start_light} big />
        </section>
      )}
      <section className="rounded-lg border border-line bg-panel-2/40 p-3" aria-label={t('leaderboard.title')}>
        <Leaderboard cars={race.cars} bestLap={race.best_lap} fuelMode={race.fuel_mode} />
      </section>
      <div className="grid gap-4 xl:grid-cols-[2fr_1fr]">
        <section className="rounded-lg border border-line bg-panel p-4">
          <h2 className="mb-2 text-sm font-bold uppercase tracking-widest text-dim">{t('chart.title')}</h2>
          <LapChart series={seriesFromCars(race.cars, race.config.max_lap_ms)} />
        </section>
        <div className="flex flex-col gap-4">
          <CommentaryFeed />
          <EventLog />
        </div>
      </div>
    </div>
  )
}
