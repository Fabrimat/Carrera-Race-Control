import { Leaderboard } from '../components/Leaderboard'
import { RaceClock } from '../components/RaceClock'
import { StartLights } from '../components/StartLights'
import { useT } from '../i18n/useT'
import { useStore } from '../lib/store'

export function TvMode() {
  const t = useT()
  const race = useStore((s) => s.race)
  const lines = useStore((s) => s.commentary)
  const latest = lines.length ? lines[lines.length - 1] : null

  const fullscreen = () => {
    void document.documentElement.requestFullscreen?.().catch(() => undefined)
  }

  return (
    <div className="flex min-h-full flex-col gap-6 p-6" data-testid="tv-mode">
      <div className="flex items-center justify-between">
        <RaceClock race={race} />
        <div className="flex items-center gap-4">
          {race.phase === 'starting' && <StartLights light={race.start_light} big />}
          <button
            className="rounded-md border border-line bg-panel-2 px-4 py-2 text-sm font-bold uppercase"
            onClick={fullscreen}
          >
            {t('tv.fullscreen')}
          </button>
        </div>
      </div>
      <Leaderboard cars={race.cars} bestLap={race.best_lap} fuelMode={race.fuel_mode} large />
      <div className="mt-auto rounded-lg border border-line bg-panel p-6 text-4xl" data-testid="tv-commentary">
        {latest ? latest.text : <span className="text-dim">{t('commentary.empty')}</span>}
      </div>
    </div>
  )
}
