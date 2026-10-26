import type { TFunction } from '../i18n'
import type { CarState, Incident } from './types'

/** Cars with an open incident, in address order. */
export function openIncidents(cars: CarState[]): CarState[] {
  return cars.filter((c) => c.incident).sort((a, b) => a.address - b.address)
}

/**
 * Place of an incident: the sector the stretch belongs to. Sector i is the stretch ending at
 * the i-th installed sensor, so line -> first sensor is sector 1, the stretch back to the
 * line is the last sector and anything in between (2 -> 3) is sector 2. Without Check Lanes
 * (one sector) or an unknown stretch: null ("near the line").
 */
export function incidentSector(
  where: Pick<Incident, 'from_sensor' | 'to_sensor'>,
  numSectors: number,
): number | null {
  const { from_sensor: a, to_sensor: b } = where
  if (a === null || b === null || numSectors <= 1) return null
  if (a === 1) return 1
  if (b === 1) return numSectors
  return 2
}

export function incidentPlace(
  where: Pick<Incident, 'from_sensor' | 'to_sensor'>,
  numSectors: number,
  t: TFunction,
): string {
  const n = incidentSector(where, numSectors)
  return n === null ? t('incident.near_line') : t('incident.sector', { n })
}

/** Elapsed race time as m:ss. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}
