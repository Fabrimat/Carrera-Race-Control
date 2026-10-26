import { useLayoutEffect, useRef, useState } from 'react'
import { useFormat, useT } from '../i18n/useT'
import { guarded } from '../lib/errors'
import { MAX_CAR_NAME, renameCar } from '../lib/settingsSave'
import { useStore } from '../lib/store'
import type { BestLapRecord, CarState, TrackRecordInfo } from '../lib/types'

interface Props {
  cars: CarState[]
  bestLap: BestLapRecord | null
  trackRecord?: TrackRecordInfo | null
  fuelMode: boolean
  large?: boolean
  /** Tighter rows on small screens (16:9 control panel); full size from 1700 px wide. */
  dense?: boolean
  /** Number of sectors (1 = no Check Lanes: no sector columns). */
  numSectors?: number
  /** Overall best time of each sector (purple). */
  bestSectors?: (number | null)[]
  /** Allow renaming cars inline (click, Enter or F2). Off in TV mode. */
  editable?: boolean
}

export function sortCars(cars: CarState[]): CarState[] {
  return [...cars].sort((a, b) => {
    const pa = a.position ?? Number.MAX_SAFE_INTEGER
    const pb = b.position ?? Number.MAX_SAFE_INTEGER
    return pa - pb || a.address - b.address
  })
}

/** FLIP animation: when rows change order, slide them from their old position. */
function useFlip(deps: string) {
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
      if (old !== undefined && Math.abs(old - top) > 1 && typeof el.animate === 'function') {
        el.animate(
          [{ transform: `translateY(${old - top}px)` }, { transform: 'translateY(0)' }],
          { duration: 450, easing: 'cubic-bezier(.2,.8,.2,1)' },
        )
      }
    })
    prev.current = next
  }, [deps])
  return ref
}

function CarName({ address, name, editable }: { address: number; name: string; editable: boolean }) {
  const t = useT()
  const nickname = useStore((s) => s.settings?.cars.find((c) => c.address === address)?.nickname ?? null)
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(name)
  const settled = useRef(false)
  const valid = value.trim().length >= 1 && value.length <= MAX_CAR_NAME

  const begin = () => {
    settled.current = false
    setValue(name)
    setEditing(true)
  }
  const finish = (save: boolean) => {
    if (settled.current) return
    if (save && !valid) return
    settled.current = true
    setEditing(false)
    if (save && value.trim() !== name) void guarded(() => renameCar(address, value.trim()))
  }

  const label = (
    <>
      <span className="truncate">{name}</span>
      {nickname && <span className="truncate text-sm font-normal text-dim">{nickname}</span>}
    </>
  )
  if (!editable) return label
  if (editing) {
    return (
      <input
        autoFocus
        value={value}
        maxLength={MAX_CAR_NAME}
        aria-label={t('leaderboard.rename_input', { name })}
        aria-invalid={!valid}
        data-testid="rename-input"
        className={`min-w-0 rounded border bg-panel-2 px-2 ${valid ? 'border-line' : 'border-signal'}`}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') finish(true)
          else if (e.key === 'Escape') finish(false)
        }}
        onBlur={() => finish(valid)}
      />
    )
  }
  return (
    <button
      type="button"
      data-testid="rename-button"
      aria-label={t('leaderboard.rename', { name })}
      className="flex min-w-0 items-baseline gap-2 text-left hover:underline"
      onClick={begin}
      onKeyDown={(e) => {
        if (e.key === 'F2') begin()
      }}
    >
      {label}
    </button>
  )
}

export function FuelBar({ fuel }: { fuel: number }) {
  const pct = Math.max(0, Math.min(15, fuel)) / 15
  const color = fuel <= 3 ? 'bg-signal' : fuel <= 7 ? 'bg-amber' : 'bg-go'
  return (
    <div
      className="h-3 w-full rounded-sm bg-line"
      role="meter"
      aria-valuemin={0}
      aria-valuemax={15}
      aria-valuenow={fuel}
      data-testid="fuel-bar"
    >
      <div className={`h-full rounded-sm ${color}`} style={{ width: `${pct * 100}%` }} />
    </div>
  )
}

/** Sector cell: the live sector of the current lap, else the one of the last lap (dimmed). */
function SectorCell({
  index,
  car,
  overall,
}: {
  index: number
  car: CarState
  overall: number | null
}) {
  const f = useFormat()
  const live = car.current_sectors[index] ?? null
  const value = live ?? car.last_sectors[index] ?? null
  const isOverall = value !== null && overall !== null && value === overall
  const isPersonal = !isOverall && value !== null && value === (car.best_sectors[index] ?? null)
  const tone = isOverall ? 'font-bold text-purple' : isPersonal ? 'font-bold text-go' : live === null ? 'text-dim' : ''
  return (
    <span
      role="cell"
      data-testid={`sector-${index + 1}`}
      data-overall={isOverall ? 'true' : 'false'}
      data-personal={isPersonal ? 'true' : 'false'}
      data-live={live !== null ? 'true' : 'false'}
      className={`num text-right text-[0.7em] ${tone}`}
    >
      {value !== null ? f.lap(value) : '–'}
    </span>
  )
}

export function Leaderboard({
  cars,
  bestLap,
  trackRecord = null,
  fuelMode,
  large = false,
  dense = false,
  editable = false,
  numSectors = 1,
  bestSectors = [],
}: Props) {
  const t = useT()
  const f = useFormat()
  const rows = sortCars(cars)
  const ref = useFlip(rows.map((c) => c.address).join(','))
  const sectors = numSectors > 1 ? numSectors : 0
  const cols = sectors
    ? ''
    : fuelMode
      ? 'grid-cols-[3.5rem_minmax(0,1.6fr)_4rem_1fr_1fr_1fr_8rem]'
      : 'grid-cols-[3.5rem_minmax(0,1.6fr)_4rem_1fr_1fr_1fr]'
  const gridStyle = sectors
    ? {
        gridTemplateColumns: `3.5rem minmax(0,1.6fr) 4rem 1fr 1fr ${'minmax(0,0.7fr) '.repeat(sectors)}1fr${fuelMode ? ' 8rem' : ''}`,
      }
    : undefined
  const text = large ? 'text-4xl' : dense ? 'text-xl min-[1700px]:text-2xl' : 'text-2xl'
  const rowPad = dense ? 'py-1 min-[1700px]:py-2' : 'py-2'
  const head = 'text-xs uppercase tracking-widest text-dim'

  if (rows.length === 0) {
    return <p className="p-6 text-dim">{t('leaderboard.empty')}</p>
  }

  return (
    <div ref={ref} role="table" aria-label={t('leaderboard.title')} className="w-full">
      <div role="row" style={gridStyle} className={`grid ${cols} items-end gap-3 px-3 pb-2 ${head}`}>
        <span role="columnheader">{t('leaderboard.pos')}</span>
        <span role="columnheader">{t('leaderboard.driver')}</span>
        <span role="columnheader" className="text-right">{t('leaderboard.laps')}</span>
        <span role="columnheader" className="text-right">{t('leaderboard.last')}</span>
        <span role="columnheader" className="text-right">{t('leaderboard.best')}</span>
        {Array.from({ length: sectors }, (_, i) => (
          <span key={i} role="columnheader" className="text-right" title={t('sectors.title')}>
            {t('sectors.s', { n: i + 1 })}
          </span>
        ))}
        <span role="columnheader" className="text-right">{t('leaderboard.gap')}</span>
        {fuelMode && <span role="columnheader">{t('leaderboard.fuel')}</span>}
      </div>
      <div className="flex flex-col gap-2">
        {rows.map((c) => {
          const isBest = bestLap !== null && c.best_lap_ms !== null && c.best_lap_ms === bestLap.lap_ms
          // The holder's best lap equals the all-time record: gold wins over the purple overall best.
          const isRecord =
            trackRecord !== null && c.address === trackRecord.address && c.best_lap_ms === trackRecord.lap_ms
          let gap = '–'
          if (c.position === 1) gap = t('leaderboard.leader')
          else if (c.gap_to_leader_laps > 0) gap = t('gap.laps', { count: c.gap_to_leader_laps })
          else if (c.gap_to_leader_ms !== null) gap = f.gap(c.gap_to_leader_ms)
          return (
            <div
              key={c.address}
              role="row"
              style={{ ...gridStyle, borderLeft: `8px solid ${c.color}` }}
              data-addr={c.address}
              data-testid="leaderboard-row"
              className={`grid ${cols} items-center gap-3 rounded-md border border-line bg-panel px-3 ${rowPad} ${text}`}
            >
              <span role="cell" className="num font-bold">{c.position ?? '–'}</span>
              <span role="cell" className="flex min-w-0 items-center gap-3 font-semibold">
                <span
                  className="inline-block h-4 w-4 shrink-0 rounded-full"
                  style={{ background: c.color }}
                  aria-hidden
                />
                <CarName address={c.address} name={c.driver_name || c.name} editable={editable && !c.driver_name} />
                {c.in_pit && (
                  <span
                    data-testid="pit-badge"
                    className="rounded bg-amber px-2 py-0.5 text-sm font-bold text-black"
                  >
                    {t('leaderboard.pit')}
                  </span>
                )}
                {isRecord && (
                  <span
                    data-testid="record-badge"
                    className="rounded bg-gold px-2 py-0.5 text-sm font-bold text-black"
                    title={t('record.title')}
                  >
                    {t('leaderboard.record')}
                  </span>
                )}
                {c.finished && (
                  <span className="rounded bg-go px-2 py-0.5 text-sm font-bold text-black">
                    {t('leaderboard.finished')}
                  </span>
                )}
              </span>
              <span role="cell" className="num text-right">{c.laps}</span>
              <span role="cell" className="num text-right" data-testid="last-lap">
                {f.lap(c.last_lap_ms)}
              </span>
              <span
                role="cell"
                data-testid="best-lap"
                data-best={isBest ? 'true' : 'false'}
                data-record={isRecord ? 'true' : 'false'}
                className={`num text-right ${isRecord ? 'font-bold text-gold' : isBest ? 'font-bold text-purple' : ''}`}
              >
                {f.lap(c.best_lap_ms)}
              </span>
              {Array.from({ length: sectors }, (_, i) => (
                <SectorCell key={i} index={i} car={c} overall={bestSectors[i] ?? null} />
              ))}
              <span role="cell" className="num whitespace-nowrap text-right" data-testid="gap">{gap}</span>
              {fuelMode && (
                <span role="cell">{c.fuel !== null ? <FuelBar fuel={c.fuel} /> : null}</span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
