import { useT } from '../i18n/useT'
import { formatClock } from '../lib/format'
import type { RaceState } from '../lib/types'

const PHASE_COLOR: Record<RaceState['phase'], string> = {
  idle: 'bg-line text-dim',
  starting: 'bg-signal text-white',
  running: 'bg-go text-black',
  paused: 'bg-amber text-black',
  finished: 'bg-ink text-black',
}

export function RaceClock({ race }: { race: RaceState }) {
  const t = useT()
  const timed = race.config.mode === 'timed' && race.remaining_ms !== null
  return (
    <div className="flex items-end gap-6">
      <div>
        <div className="text-xs uppercase tracking-widest text-dim">
          {timed ? t('clock.remaining') : t('clock.elapsed')}
        </div>
        <div className="num text-6xl font-bold leading-none" data-testid="race-clock">
          {formatClock(timed ? race.remaining_ms : race.race_time_ms)}
        </div>
      </div>
      {race.config.mode === 'laps' && race.remaining_laps !== null && (
        <div>
          <div className="text-xs uppercase tracking-widest text-dim">{t('clock.laps_to_go')}</div>
          <div className="num text-6xl font-bold leading-none">{race.remaining_laps}</div>
        </div>
      )}
      <span
        className={`mb-1 rounded px-3 py-1 text-sm font-bold uppercase tracking-widest ${PHASE_COLOR[race.phase]}`}
        data-testid="phase-badge"
      >
        {t(`phase.${race.phase}`)}
      </span>
    </div>
  )
}
