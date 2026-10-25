import type { CarState, Lap } from './types'

export interface Series {
  address: number
  name: string
  color: string
  points: { lap: number; ms: number }[]
}

/** Live chart data from CarState.lap_times; laps longer than maxLapMs are excluded. */
export function seriesFromCars(cars: CarState[], maxLapMs: number): Series[] {
  return cars.map((c) => ({
    address: c.address,
    name: c.name,
    color: c.color,
    points: c.lap_times
      .map((ms, i) => ({ lap: i + 1, ms }))
      .filter((p) => p.ms <= maxLapMs),
  }))
}

/** History chart data from stored laps; invalid laps are excluded. */
export function seriesFromLaps(laps: Lap[], cars: CarState[]): Series[] {
  return cars.map((c) => ({
    address: c.address,
    name: c.name,
    color: c.color,
    points: laps
      .filter((l) => l.address === c.address && l.valid)
      .map((l) => ({ lap: l.lap_number, ms: l.lap_ms })),
  }))
}
