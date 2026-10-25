import type { CarState, RaceState } from '../lib/types'
import { emptyRace } from '../lib/store'

export function car(over: Partial<CarState> & { address: number }): CarState {
  return {
    name: `Auto ${over.address + 1}`,
    color: '#e53935',
    laps: 0,
    last_lap_ms: null,
    best_lap_ms: null,
    avg_lap_ms: null,
    total_time_ms: null,
    position: null,
    gap_to_leader_ms: null,
    gap_to_leader_laps: 0,
    gap_to_ahead_ms: null,
    fuel: null,
    in_pit: false,
    pit_stops: 0,
    finished: false,
    lap_times: [],
    ...over,
  }
}

export function raceState(over: Partial<RaceState> = {}): RaceState {
  return { ...emptyRace, ...over }
}
