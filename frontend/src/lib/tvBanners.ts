import type { TFunction } from '../i18n'
import { priorityOf, type Banner, type BannerKind } from './bannerQueue'
import { incidentPlace, incidentSector } from './incidents'
import type { CarState, RaceEvent, RaceState, SessionResult } from './types'

/** Visible time of each banner kind, ms. */
const DURATION: Record<BannerKind, number> = {
  fastest_lap: 5200,
  track_record: 6500,
  overtake: 3400,
  pit_in: 3000,
  pit_out: 3000,
  low_fuel: 3600,
  control: 4200,
  final_lap: 4800,
  chequered: Infinity,
  false_start: 5200,
  incident: 5000,
  incident_cleared: 3000,
  session_result: Infinity,
}

const CENTER: BannerKind[] = ['final_lap', 'chequered', 'track_record', 'session_result']

export interface BannerContext {
  cars: CarState[]
  codes: Map<number, string>
  t: TFunction
  /** Formats a lap time (ms) for the current language. */
  lap: (ms: number | null | undefined) => string
  /** URL of the assigned driver's photo, when the car's driver has one. */
  photoFor?: (car: CarState) => string | null
  /** RaceState.num_sectors, to name the sector of an incident. */
  numSectors?: number
}

function make(kind: BannerKind, id: string, title: string, extra: Partial<Banner> = {}): Banner {
  return {
    id,
    kind,
    priority: priorityOf(kind),
    durationMs: DURATION[kind],
    layout: CENTER.includes(kind) ? 'center' : 'lower',
    title,
    ...extra,
  }
}

const eventKey = (e: RaceEvent) => `${e.type}:${e.at}:${'address' in e ? e.address : ''}`

/** Broadcast banner for a domain event, or null when the event is not worth a graphic. */
export function bannerForEvent(e: RaceEvent, c: BannerContext): Banner | null {
  const car = (a: number | null) => c.cars.find((x) => x.address === a)
  const code = (a: number | null) => (a === null ? '' : (c.codes.get(a) ?? `#${a + 1}`))
  const name = (a: number | null) => {
    const x = car(a)
    return x ? x.driver_name || x.name : code(a)
  }
  const photo = (a: number | null) => {
    const x = car(a)
    return x ? (c.photoFor?.(x) ?? undefined) : undefined
  }
  const id = eventKey(e)
  switch (e.type) {
    case 'best_lap':
      if (!e.overall) return null
      return make('fastest_lap', id, c.t('tv.banner.fastest_lap'), {
        subtitle: `${code(e.address)}  ${c.lap(e.lap_ms)}`,
        color: car(e.address)?.color,
        photo: photo(e.address),
      })
    case 'track_record':
      return make('track_record', id, c.t('tv.banner.track_record'), {
        subtitle: `${name(e.address)}  ${c.lap(e.lap_ms)}`,
        color: car(e.address)?.color,
        photo: photo(e.address),
      })
    case 'position_change':
      // Only the car that gained the place gets the graphic.
      if (e.new_position >= e.old_position) return null
      return make('overtake', id, `${code(e.address)} ▲ P${e.new_position}`, {
        subtitle: e.passed_address !== null ? c.t('tv.banner.passes', { code: code(e.passed_address) }) : undefined,
        color: car(e.address)?.color,
      })
    case 'pit_entry':
      return make('pit_in', id, c.t('tv.banner.pit_in', { code: code(e.address) }), { color: car(e.address)?.color })
    case 'pit_exit':
      return make('pit_out', id, c.t('tv.banner.pit_out', { code: code(e.address) }), { color: car(e.address)?.color })
    case 'low_fuel':
      return make('low_fuel', id, c.t('tv.banner.low_fuel', { code: code(e.address) }), { color: car(e.address)?.color })
    case 'false_start': {
      if (e.action === 'ignore') return null
      const who = e.address === null ? null : name(e.address)
      const sub =
        e.action === 'penalty'
          ? c.t('tv.banner.false_start_penalty', { seconds: Math.round(e.penalty_ms / 1000) })
          : e.action === 'restart'
            ? c.t('tv.banner.false_start_restart')
            : undefined
      return make('false_start', id, c.t('tv.banner.false_start'), {
        subtitle: [who, sub].filter(Boolean).join('  ') || undefined,
        color: car(e.address)?.color,
      })
    }
    case 'incident_started': {
      const sectors = c.numSectors ?? 1
      const place = incidentSector(e, sectors) !== null ? incidentPlace(e, sectors, c.t) : null
      return make('incident', id, c.t('tv.banner.incident'), {
        subtitle: [name(e.address), place].filter(Boolean).join('  '),
        color: car(e.address)?.color,
        photo: photo(e.address),
      })
    }
    case 'incident_cleared':
      return make('incident_cleared', id, c.t('tv.banner.incident_cleared'), {
        subtitle: name(e.address),
        color: car(e.address)?.color,
      })
    default:
      return null
  }
}

/** Race-control banner for pace car / resume transitions between two consecutive states. */
export function controlBanner(prev: RaceState, next: RaceState, t: TFunction): Banner | null {
  if (prev.race_id !== next.race_id) return null
  const stamp = `${next.race_id}:${next.race_time_ms}`
  if (prev.phase === 'running' && next.phase === 'paused') {
    return make('control', `control:pace:${stamp}`, t('tv.banner.pace_car'), { subtitle: t('tv.banner.pace_car_sub') })
  }
  if (prev.phase === 'paused' && next.phase === 'running') {
    return make('control', `control:resume:${stamp}`, t('tv.banner.resumed'), { subtitle: t('tv.banner.resumed_sub') })
  }
  return null
}

/** The leader started the last lap of a laps race. */
export function isFinalLap(race: RaceState): boolean {
  if (race.phase !== 'running' || race.config.mode !== 'laps' || race.config.target_laps < 2) return false
  const leader = race.cars.find((c) => c.position === 1)
  return !!leader && !leader.finished && leader.laps === race.config.target_laps - 1
}

export function finalLapBanner(race: RaceState, t: TFunction): Banner {
  return make('final_lap', `final_lap:${race.race_id}`, t('tv.banner.final_lap'), { subtitle: t('tv.banner.final_lap_sub') })
}

/** Chequered flag + results card (top 3 with best laps). Stays until the race state moves on. */
export function chequeredBanner(race: RaceState, c: BannerContext): Banner {
  const ranked = [...race.cars]
    .filter((x) => x.position !== null)
    .sort((a, b) => (a.position ?? 99) - (b.position ?? 99))
    .slice(0, 3)
  return make('chequered', `chequered:${race.race_id}`, c.t('tv.banner.chequered'), {
    subtitle: c.t('tv.results.title'),
    rows: ranked.map((x) => ({
      pos: x.position ?? 0,
      code: c.codes.get(x.address) ?? '',
      name: x.driver_name || x.name,
      photo: c.photoFor?.(x) ?? undefined,
      color: x.color,
      best: c.lap(x.best_lap_ms),
      time: x.gap_to_leader_laps > 0 ? c.t('gap.laps', { count: x.gap_to_leader_laps }) : x.position === 1 ? `${x.laps} ${c.t('leaderboard.laps')}` : '',
    })),
  })
}

/** End-of-session classification card (positions, best lap, penalty); up to 6 rows. */
export function sessionResultBanner(result: SessionResult, title: string, c: BannerContext): Banner {
  const colorOf = (a: number) => c.cars.find((x) => x.address === a)?.color ?? '#888888'
  return make('session_result', `session:${result.session_id}:${result.finished_at}`, title, {
    subtitle: c.t(result.kind === 'qualifying' ? 'tv.results.qualifying' : 'tv.results.title'),
    rows: result.classification.slice(0, 6).map((r) => ({
      pos: r.position,
      code: c.codes.get(r.address) ?? '',
      name: r.name,
      color: colorOf(r.address),
      best: c.lap(r.best_lap_ms),
      time: '',
      note: r.penalty_ms > 0 ? `+${r.penalty_ms / 1000}s` : undefined,
    })),
  })
}
