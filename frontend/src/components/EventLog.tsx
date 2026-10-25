import { useFormat, useT } from '../i18n/useT'
import type { TFunction } from '../i18n'
import { useStore } from '../lib/store'
import type { CarState, RaceEvent } from '../lib/types'

/** Translated one-line description of a domain event. */
export function describeEvent(
  e: RaceEvent,
  cars: CarState[],
  t: TFunction,
  lap: (ms: number) => string,
): string {
  const name = (addr: number | null) =>
    cars.find((c) => c.address === addr)?.name ?? `#${(addr ?? 0) + 1}`
  switch (e.type) {
    case 'race_started':
      return t('event.race_started', { mode: t(`mode.${e.mode}`) })
    case 'lap_completed':
      return t(e.valid ? 'event.lap_completed' : 'event.lap_invalid', {
        name: name(e.address),
        lap: e.lap_number,
        time: lap(e.lap_ms),
      })
    case 'best_lap':
      return t(e.overall ? 'event.best_lap_overall' : 'event.best_lap_personal', {
        name: name(e.address),
        time: lap(e.lap_ms),
      })
    case 'position_change':
      return t('event.position_change', {
        name: name(e.address),
        old: e.old_position,
        new: e.new_position,
      })
    case 'pit_entry':
      return t('event.pit_entry', { name: name(e.address) })
    case 'pit_exit':
      return t('event.pit_exit', { name: name(e.address) })
    case 'low_fuel':
      return t('event.low_fuel', { name: name(e.address), fuel: e.fuel })
    case 'race_finished':
      return e.winner === null
        ? t('event.race_finished_no_winner')
        : t('event.race_finished', { name: name(e.winner) })
    case 'track_record':
      return t('event.track_record', { name: name(e.address), layout: e.layout, time: lap(e.lap_ms) })
    case 'idle':
      return t('event.idle', { seconds: e.seconds })
    case 'false_start':
      return e.address === null
        ? t('event.false_start')
        : t('event.false_start_car', { name: name(e.address) })
    case 'driver_assigned':
      return t('event.driver_assigned', { driver: e.driver_name, name: name(e.address) })
    case 'session_finished':
      return t('event.session_finished')
    case 'sector_completed':
      return t('event.sector_completed', {
        name: name(e.address),
        sector: e.sector,
        time: lap(e.split_ms),
      })
  }
}

/** `fill`: stretch to the parent's height and scroll inside, showing a longer history. */
export function EventLog({ fill = false }: { fill?: boolean }) {
  const t = useT()
  const f = useFormat()
  const events = useStore((s) => s.events)
  const cars = useStore((s) => s.race.cars)
  const recent = events.slice(fill ? -40 : -8).reverse()
  return (
    <section
      className={`rounded-lg border border-line bg-panel ${fill ? 'flex h-full min-h-0 flex-col p-3' : 'p-4'}`}
      aria-label={t('events.title')}
    >
      <h2 className="mb-2 shrink-0 text-sm font-bold uppercase tracking-widest text-dim">{t('events.title')}</h2>
      {recent.length === 0 ? (
        <p className="text-dim">{t('events.empty')}</p>
      ) : (
        <ul className={`flex flex-col gap-1 text-sm ${fill ? 'min-h-0 flex-1 overflow-y-auto' : ''}`}>
          {recent.map((e, i) => (
            <li key={`${e.at}-${i}`} data-testid="event-line">
              {describeEvent(e, cars, t, f.lap)}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
