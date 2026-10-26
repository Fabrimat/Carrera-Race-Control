import { useState } from 'react'
import { useT } from '../i18n/useT'
import { seriesFromCars } from '../lib/series'
import type { RaceState } from '../lib/types'
import { FuelStrategyPanel } from './FuelStrategyPanel'
import { LazyFuelChart } from './LazyFuelChart'
import { LazyLapChart } from './LazyLapChart'

type View = 'times' | 'strategy' | 'chart'
const VIEWS: View[] = ['times', 'strategy', 'chart']

/**
 * Bottom-left dashboard panel. Without CU fuel mode it is the lap time chart alone; in fuel
 * mode its title becomes a small tab strip: lap times / fuel strategy / fuel chart, so the
 * strategy fits the 16:9 layout without taking space from the other panels.
 */
export function ChartPanel({ race, className = '' }: { race: RaceState; className?: string }) {
  const t = useT()
  const [tab, setTab] = useState<View>('times')
  const fuel = race.fuel_mode
  const view: View = fuel ? tab : 'times'
  return (
    <section
      aria-label={t('chart.title')}
      className={`flex min-h-0 min-w-0 flex-col rounded-lg border border-line bg-panel p-3 ${className}`}
    >
      {fuel ? (
        <div role="tablist" aria-label={t('fuel.tabs')} className="mb-1 flex shrink-0 gap-1">
          {VIEWS.map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              id={`chart-tab-${v}`}
              aria-selected={view === v}
              aria-controls="chart-tabpanel"
              data-testid={`chart-tab-${v}`}
              className={`rounded-md border px-2 py-0.5 text-xs font-bold uppercase tracking-widest ${
                view === v ? 'border-amber text-ink' : 'border-transparent text-dim hover:border-line'
              }`}
              onClick={() => setTab(v)}
            >
              {t(`fuel.tab.${v}`)}
            </button>
          ))}
        </div>
      ) : (
        <h2 className="mb-1 shrink-0 text-xs font-bold uppercase tracking-widest text-dim">{t('chart.title')}</h2>
      )}
      <div
        className="min-h-0 flex-1"
        id="chart-tabpanel"
        role={fuel ? 'tabpanel' : undefined}
        aria-labelledby={fuel ? `chart-tab-${view}` : undefined}
      >
        {view === 'times' && <LazyLapChart series={seriesFromCars(race.cars, race.config.max_lap_ms)} height="100%" />}
        {view === 'strategy' && <FuelStrategyPanel cars={race.cars} minStops={race.config.pits.min_stops} />}
        {view === 'chart' && <LazyFuelChart cars={race.cars} height="100%" />}
      </div>
    </section>
  )
}
