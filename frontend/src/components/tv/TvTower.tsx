import { useLayoutEffect, useRef } from 'react'
import { useFormat, useT } from '../../i18n/useT'
import { CarLogo } from '../CarLogo'
import { sortCars } from '../Leaderboard'
import { towerCell, type GapMode } from '../../lib/tvTiming'
import type { CarState, RaceState } from '../../lib/types'

/** Re-keyed on every change so the new value rolls in (number-flip effect). */
export function Roll({ text }: { text: string }) {
  return (
    <span key={text} className="tv-roll">
      {text}
    </span>
  )
}

/** FLIP: rows that change place slide from their old position; those that gained a place flash. */
function useFlip(order: string, reduced: boolean) {
  const ref = useRef<HTMLDivElement>(null)
  const prev = useRef(new Map<string, number>())
  useLayoutEffect(() => {
    const root = ref.current
    if (!root) return
    const next = new Map<string, number>()
    root.querySelectorAll<HTMLElement>('[data-addr]').forEach((el) => {
      const key = el.dataset.addr as string
      const top = el.getBoundingClientRect().top
      next.set(key, top)
      const old = prev.current.get(key)
      if (old === undefined || Math.abs(old - top) < 1) return
      if (!reduced && typeof el.animate === 'function') {
        el.animate(
          [
            { transform: `translate3d(0, ${old - top}px, 0)`, filter: 'blur(0.2em)' },
            { transform: 'translate3d(0, 0, 0)', filter: 'blur(0)' },
          ],
          { duration: 600, easing: 'cubic-bezier(.2,.8,.2,1)' },
        )
      }
      if (top < old) {
        el.dataset.hl = 'true'
        window.setTimeout(() => {
          el.dataset.hl = 'false'
        }, 1000)
      }
    })
    prev.current = next
  }, [order, reduced])
  return ref
}

function SectorPips({ car, race }: { car: CarState; race: RaceState }) {
  if (race.num_sectors <= 1) return null
  return (
    <span className="tv-pips" aria-hidden>
      {Array.from({ length: race.num_sectors }, (_, i) => {
        const value = car.current_sectors[i] ?? car.last_sectors[i] ?? null
        let tone = 'none'
        if (value !== null) {
          if (value === (race.best_sectors[i] ?? null)) tone = 'purple'
          else if (value === (car.best_sectors[i] ?? null)) tone = 'green'
          else tone = 'plain'
        }
        return <i key={`${i}-${value}`} data-s={tone} />
      })}
    </span>
  )
}

interface Props {
  race: RaceState
  codes: Map<number, string>
  mode: GapMode
  reduced: boolean
}

export function TvTower({ race, codes, mode, reduced }: Props) {
  const t = useT()
  const f = useFormat()
  const rows = sortCars(race.cars)
  const ref = useFlip(rows.map((c) => c.address).join(','), reduced)
  return (
    <div className="tv-tower" data-testid="tv-tower">
      <div className="tv-tower-head">
        <span>{t('leaderboard.title')}</span>
        <span data-testid="tv-gap-mode">
          <Roll text={mode === 'gap' ? t('tv.tower.gap') : t('tv.tower.interval')} />
        </span>
      </div>
      {/* Re-keying on the race restarts the staggered entrance for a new race. */}
      <div ref={ref} key={race.race_id ?? 'none'} className="flex flex-col gap-[0.35em]" role="table" aria-label={t('leaderboard.title')}>
        {rows.map((c, i) => {
          const cell = towerCell(c, mode, t, f.gap)
          const isFastest = race.best_lap !== null && c.best_lap_ms === race.best_lap.lap_ms
          const isRecord =
            race.track_record !== null && c.address === race.track_record.address && c.best_lap_ms === race.track_record.lap_ms
          return (
            <div
              key={c.address}
              role="row"
              data-addr={c.address}
              data-testid="tv-row"
              className="tv-row"
              style={{ ['--car' as string]: c.color, ['--i' as string]: i }}
            >
              <span role="cell" className="tv-pos">{c.position ?? '–'}</span>
              <span className="tv-bar" aria-hidden />
              <span role="cell" className="tv-code" data-testid="tv-code" title={c.driver_name || c.name}>
                {codes.get(c.address) ?? ''}
              </span>
              <span className="tv-mid">
                <CarLogo logoId={c.logo_id} size="1.9em" className="tv-logo" />
                <SectorPips car={c} race={race} />
                {c.incident && <span className="tv-tag" data-tag="off" data-testid="tv-off">{t('tv.tower.off')}</span>}
                {c.in_pit && <span className="tv-tag" data-tag="pit" data-testid="tv-pit">{t('tv.tower.pit')}</span>}
                {isFastest && !isRecord && (
                  <span className="tv-tag" data-tag="fastest" data-testid="tv-fastest" title={t('tv.tower.fastest')}>FL</span>
                )}
                {isRecord && (
                  <span className="tv-tag" data-tag="record" data-testid="tv-record" title={t('tv.tower.record')}>REC</span>
                )}
                {c.finished && <span className="tv-tag" data-tag="fin">FIN</span>}
              </span>
              <span role="cell" className="tv-gap" data-kind={cell.kind} data-testid="tv-gap">
                <Roll text={cell.text} />
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
