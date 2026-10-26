import { useT } from '../i18n/useT'
import type { CarState } from '../lib/types'
import { FuelBar } from './Leaderboard'

const COLS =
  'grid grid-cols-[minmax(0,1.2fr)_minmax(5rem,1fr)_4.5rem_4rem_minmax(0,1.3fr)] items-center gap-2'

/**
 * Compact per-car fuel strategy (CU fuel mode only): fuel bar, laps the fuel lasts, laps still
 * to drive and a "pit by lap N" warning when the car cannot reach the finish. It scrolls inside
 * its panel, so it never grows the 16:9 dashboard.
 */
export function FuelStrategyPanel({ cars, minStops }: { cars: CarState[]; minStops: number }) {
  const t = useT()
  const rows = cars.filter((c) => c.fuel !== null || c.fuel_strategy !== null)
  if (rows.length === 0) return <p className="p-3 text-sm text-dim">{t('fuel.empty')}</p>
  return (
    <div role="table" aria-label={t('fuel.tab.strategy')} className="h-full overflow-auto text-sm" data-testid="fuel-strategy">
      <div role="row" className={`${COLS} px-1 pb-1 text-[0.7rem] uppercase tracking-wider text-dim`}>
        <span role="columnheader">{t('fuel.col.car')}</span>
        <span role="columnheader">{t('fuel.col.level')}</span>
        <span role="columnheader">{t('fuel.col.laps_left')}</span>
        <span role="columnheader">{t('fuel.col.to_go')}</span>
        <span role="columnheader">{t('fuel.col.status')}</span>
      </div>
      {rows.map((c) => {
        const s = c.fuel_strategy
        const warn = s?.must_pit === true && s.pit_by_lap !== null
        return (
          <div
            key={c.address}
            role="row"
            data-testid="fuel-row"
            data-must-pit={warn}
            className={`${COLS} border-t border-line px-1 py-1 ${warn ? 'bg-signal/10' : ''}`}
          >
            <span role="cell" className="flex min-w-0 items-center gap-2">
              <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: c.color }} aria-hidden />
              <span className="truncate font-bold">{c.driver_name || c.name}</span>
            </span>
            <span role="cell">{c.fuel !== null ? <FuelBar fuel={c.fuel} /> : null}</span>
            <span role="cell" className="num" data-testid="fuel-laps-left">
              {s?.laps_left != null ? s.laps_left.toFixed(1) : <span className="text-dim">{t('fuel.laps_left_unknown')}</span>}
            </span>
            <span role="cell" className="num text-dim">{s?.laps_to_go ?? ''}</span>
            <span role="cell" className="flex min-w-0 flex-wrap items-center gap-x-2 text-xs">
              {c.in_pit ? (
                <span className="font-bold text-amber">{t('fuel.in_pit')}</span>
              ) : warn ? (
                <span className="font-bold text-signal" data-testid="must-pit">
                  {t('fuel.must_pit', { lap: s.pit_by_lap ?? 0 })}
                </span>
              ) : s?.laps_left != null ? (
                <span className="text-go">{t('fuel.ok')}</span>
              ) : null}
              {minStops > 0 && (
                <span className={c.pit_stops >= minStops ? 'text-go' : 'text-dim'}>
                  {t('fuel.stops', { done: c.pit_stops, required: minStops })}
                </span>
              )}
            </span>
          </div>
        )
      })}
    </div>
  )
}
