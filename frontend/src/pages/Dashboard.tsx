import type { ReactNode } from 'react'
import { CommentaryFeed } from '../components/CommentaryFeed'
import { ConnectionBar } from '../components/ConnectionBar'
import { EventLog } from '../components/EventLog'
import { LazyLapChart } from '../components/LazyLapChart'
import { Leaderboard } from '../components/Leaderboard'
import { TrackMap } from '../components/TrackMap'
import { RaceClock } from '../components/RaceClock'
import { TrackRecordPanel } from '../components/TrackRecordPanel'
import { RaceControls } from '../components/RaceControls'
import { StartLights } from '../components/StartLights'
import { useT } from '../i18n/useT'
import { openTvWindow } from '../lib/desktop'
import { seriesFromCars } from '../lib/series'
import { useStore } from '../lib/store'

/** A grid cell that may scroll inside itself at the full-viewport size, never the page. */
const CELL = 'min-h-0 min-w-0'

function Panel({ title, children, className = '' }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section
      aria-label={title}
      className={`flex min-h-0 min-w-0 flex-col rounded-lg border border-line bg-panel p-3 ${className}`}
    >
      <h2 className="mb-1 shrink-0 text-xs font-bold uppercase tracking-widest text-dim">{title}</h2>
      <div className="min-h-0 flex-1">{children}</div>
    </section>
  )
}

/**
 * Control panel. From 1200 px wide the whole dashboard is one full-viewport CSS grid (three
 * bands: status and controls / leaderboard and map / chart, commentary and logs) and the page
 * never scrolls; individual panels scroll inside themselves. Below that it falls back to a
 * stacked layout.
 */
export function Dashboard() {
  const t = useT()
  const race = useStore((s) => s.race)
  const starting = race.phase === 'starting'
  const lights = race.phase === 'starting' || race.start_light !== 0

  return (
    <div
      data-testid="dashboard"
      className="flex flex-col gap-3 p-3 min-[1200px]:grid min-[1200px]:h-full min-[1200px]:grid-rows-[auto_minmax(0,1.45fr)_minmax(0,1fr)] min-[1200px]:overflow-hidden min-[1200px]:gap-2"
    >
      {/* band 1: connection, clock and lights, race controls */}
      <div
        data-testid="dashboard-top"
        className="grid gap-2 min-[1200px]:grid-cols-[minmax(0,1fr)_auto_auto] min-[1200px]:items-stretch"
      >
        <ConnectionBar compact />
        <section
          className={`flex flex-wrap items-center justify-between gap-4 rounded-lg border bg-panel px-3 py-1 ${starting ? 'border-signal' : 'border-line'}`}
          aria-label={t('clock.elapsed')}
        >
          <RaceClock race={race} />
          {lights && <StartLights light={race.start_light} />}
          <button
            type="button"
            data-testid="open-tv"
            title={t('dashboard.open_tv_title')}
            className="rounded-md border border-line bg-panel-2 px-3 py-1 text-sm font-bold uppercase tracking-wide hover:border-amber"
            onClick={openTvWindow}
          >
            {t('dashboard.open_tv')}
          </button>
        </section>
        <RaceControls compact />
      </div>

      {/* band 2: leaderboard (with sectors) and the live map */}
      <div className="grid gap-2 min-[1200px]:min-h-0 min-[1200px]:grid-cols-[minmax(0,1.9fr)_minmax(0,1fr)]">
        <section
          className={`${CELL} overflow-auto rounded-lg border border-line bg-panel-2/40 p-2`}
          aria-label={t('leaderboard.title')}
        >
          <Leaderboard
            cars={race.cars}
            bestLap={race.best_lap}
            trackRecord={race.track_record}
            fuelMode={race.fuel_mode}
            editable
            dense
            numSectors={race.num_sectors}
            bestSectors={race.best_sectors}
          />
        </section>
        <TrackMap className="flex min-h-72 min-[1200px]:h-full min-[1200px]:min-h-0 flex-col overflow-hidden !p-3 [&>svg]:min-h-0 [&>svg]:flex-1" />
      </div>

      {/* band 3: lap chart, commentary, record and event log */}
      <div className="grid gap-2 min-[1200px]:min-h-0 min-[1200px]:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,0.9fr)]">
        <Panel title={t('chart.title')} className="h-72 min-[1200px]:h-auto">
          <LazyLapChart series={seriesFromCars(race.cars, race.config.max_lap_ms)} height="100%" />
        </Panel>
        <div className={`${CELL} min-h-72 min-[1200px]:min-h-0`}>
          <CommentaryFeed fill />
        </div>
        <div className={`${CELL} flex flex-col gap-2`}>
          <TrackRecordPanel />
          <div className="min-h-60 flex-1 min-[1200px]:min-h-0">
            <EventLog fill />
          </div>
        </div>
      </div>
    </div>
  )
}
