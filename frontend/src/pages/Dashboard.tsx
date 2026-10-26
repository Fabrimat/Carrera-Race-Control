import { useEffect, useState } from 'react'
import { Collapsible } from '../components/Collapsible'
import { PitWall } from '../components/PitWall'
import { CommentaryFeed } from '../components/CommentaryFeed'
import { ConnectionBar } from '../components/ConnectionBar'
import { EventLog } from '../components/EventLog'
import { Modal } from '../components/Modal'
import { WhoDriving } from '../components/WhoDriving'
import { ChartPanel } from '../components/ChartPanel'
import { Leaderboard } from '../components/Leaderboard'
import { MarshalPanel } from '../components/MarshalPanel'
import { TrackMap } from '../components/TrackMap'
import { RaceClock } from '../components/RaceClock'
import { TrackRecordPanel } from '../components/TrackRecordPanel'
import { RaceControls } from '../components/RaceControls'
import { SessionBar } from '../components/event/SessionBar'
import { StartLights } from '../components/StartLights'
import { useT } from '../i18n/useT'
import { incidentPlace, incidentSector } from '../lib/incidents'
import { openTvWindow } from '../lib/desktop'
import { useLayout } from '../lib/layout'
import { useStore } from '../lib/store'
import { useFuelToasts } from '../lib/useFuelToasts'

/** A grid cell that may scroll inside itself at the full-viewport size, never the page. */
const CELL = 'min-h-0 min-w-0'

/**
 * Control panel. From 1200 px wide the whole dashboard is one full-viewport CSS grid (three
 * bands: status and controls / leaderboard and map / chart, commentary and logs) and the page
 * never scrolls; individual panels scroll inside themselves. Ultrawide screens spread the same
 * panels over four columns (see index.css), tablets get a stacked layout with collapsible
 * panels and phones the pit wall (lib/layout.ts).
 */
export function Dashboard() {
  const t = useT()
  const race = useStore((s) => s.race)
  const [who, setWho] = useState(false)
  const layout = useLayout()
  const [fullOnPhone, setFullOnPhone] = useState(false)
  useFuelToasts()
  const starting = race.phase === 'starting'
  const lights = race.phase === 'starting' || race.start_light !== 0
  const reportable = race.phase === 'running' || race.phase === 'paused'

  // Toast on a new incident (events already in the store at mount are not replayed).
  useEffect(() => {
    const seen = new WeakSet<object>(useStore.getState().events)
    return useStore.subscribe((s) => {
      for (const e of s.events) {
        if (seen.has(e)) continue
        seen.add(e)
        if (e.type !== 'incident_started') continue
        const car = s.race.cars.find((c) => c.address === e.address)
        const name = car ? car.driver_name || car.name : `#${e.address + 1}`
        const text = t('event.incident_started', { name })
        const place = incidentSector(e, s.race.num_sectors) !== null ? incidentPlace(e, s.race.num_sectors, t) : null
        s.pushToast(place ? t('incident.toast_at', { text, place }) : text, 'info')
      }
    })
  }, [t])

  if (layout === 'phone' && !fullOnPhone) return <PitWall onFull={() => setFullOnPhone(true)} />

  return (
    <div
      data-testid="dashboard"
      className="dash relative flex flex-col gap-3 p-3 min-[1200px]:grid min-[1200px]:h-full min-[1200px]:grid-rows-[auto_minmax(0,1.45fr)_minmax(0,1fr)] min-[1200px]:overflow-hidden min-[1200px]:gap-2"
    >
      {/* band 1: event session bar (only when relevant), then connection, clock and lights, race controls */}
      <div className="dash-band-top flex min-w-0 flex-col gap-2">
      <SessionBar />
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
            data-testid="open-who"
            className="rounded-md border border-line bg-panel-2 px-3 py-1 text-sm font-bold uppercase tracking-wide hover:border-amber"
            onClick={() => setWho(true)}
          >
            {t('who.open')}
          </button>
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
      </div>

      {/* band 2: leaderboard (with sectors) and the live map */}
      <div className="dash-band grid gap-2 min-[900px]:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] min-[1200px]:min-h-0 min-[1200px]:grid-cols-[minmax(0,1.9fr)_minmax(0,1fr)]">
        <section
          className={`dash-leader ${CELL} overflow-auto rounded-lg border border-line bg-panel-2/40 p-2`}
          aria-label={t('leaderboard.title')}
        >
          <Leaderboard
            cars={race.cars}
            bestLap={race.best_lap}
            trackRecord={race.track_record}
            fuelMode={race.fuel_mode}
            editable
            reportable={reportable}
            dense
            numSectors={race.num_sectors}
            bestSectors={race.best_sectors}
          />
        </section>
        <TrackMap className="dash-map flex min-h-72 min-[1200px]:h-full min-[1200px]:min-h-0 flex-col overflow-hidden !p-3 [&>svg]:min-h-0 [&>svg]:flex-1" />
      </div>

      {/* band 3: lap chart, commentary, record and event log */}
      <div className="dash-band grid gap-2 min-[900px]:grid-cols-2 min-[1200px]:min-h-0 min-[1200px]:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,0.9fr)]">
        <Collapsible title={t('chart.title')} testId="collapse-chart">
          <ChartPanel race={race} className="dash-chart h-72 min-[1200px]:h-auto" />
        </Collapsible>
        <Collapsible title={t('commentary.title')} testId="collapse-commentary">
          <div className={`dash-comm ${CELL} min-h-72 min-[1200px]:min-h-0`}>
            <CommentaryFeed fill />
          </div>
        </Collapsible>
        <Collapsible title={t('events.title')} testId="collapse-events">
          <div className={`dash-log ${CELL} flex flex-col gap-2`}>
            <TrackRecordPanel />
            <div className="min-h-60 flex-1 min-[1200px]:min-h-0">
              <EventLog fill />
            </div>
          </div>
        </Collapsible>
      </div>

      <MarshalPanel />

      {who && (
        <Modal label={t('who.title')} onClose={() => setWho(false)}>
          <WhoDriving />
          <button
            type="button"
            className="mt-3 min-h-11 self-end rounded-md border border-line px-5 font-bold uppercase"
            onClick={() => setWho(false)}
          >
            {t('who.close')}
          </button>
        </Modal>
      )}
    </div>
  )
}
