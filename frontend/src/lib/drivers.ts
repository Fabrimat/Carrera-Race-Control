// Pure helpers for the roster and the "Who's driving?" assignment (docs/PROTOCOL.md "Event mode").
import { ApiError } from './api'
import { notifyError } from './errors'
import { tNow, useStore } from './store'
import type { CarConfig, CarState, Driver } from './types'

/** Name shown for a car: the assigned driver, else the car's own name. */
export function displayName(car: Pick<CarState, 'name' | 'driver_name'>): string {
  return car.driver_name?.trim() || car.name
}

/** Roster label of a driver: the nickname when set, else the name. */
export function driverLabel(d: Pick<Driver, 'name' | 'nickname'>): string {
  return d.nickname?.trim() || d.name
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return Array.from(parts[0]).slice(0, 2).join('').toUpperCase()
  return (Array.from(parts[0])[0] + Array.from(parts[parts.length - 1])[0]).toUpperCase()
}

// Backend limits (models.py Driver).
export const MAX_DRIVER_NAME = 40
export const MAX_DRIVER_NICKNAME = 24
export const MAX_DRIVER_BIO = 300

/** Like `guarded`, but a 422 `invalid_request` explains the field limits. */
export async function guardedDriver<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof ApiError && e.code === 'invalid_request') {
      useStore.getState().pushToast(
        tNow('drivers.limits', { name: MAX_DRIVER_NAME, nickname: MAX_DRIVER_NICKNAME, bio: MAX_DRIVER_BIO }),
      )
    } else notifyError(e)
    return undefined
  }
}

/** Lower-case, accent-free text for searching. */
export function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
}

/**
 * Roster entries matching `query` (name or nickname, accent/case-insensitive), most recently
 * used first, then alphabetical. An empty query returns everyone in that order.
 */
export function filterDrivers(drivers: Driver[], query: string, recent: string[] = []): Driver[] {
  const q = normalize(query)
  const rank = (id: string) => {
    const i = recent.indexOf(id)
    return i === -1 ? Number.MAX_SAFE_INTEGER : i
  }
  return drivers
    .filter((d) => !q || normalize(d.name).includes(q) || normalize(d.nickname ?? '').includes(q))
    .sort((a, b) => rank(a.id) - rank(b.id) || a.name.localeCompare(b.name))
}

const RECENT_KEY = 'carrera.recentDrivers'
const MAX_RECENT = 12

export function loadRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** Move `id` to the front of the recent list (pure). */
export function pushRecent(recent: string[], id: string): string[] {
  return [id, ...recent.filter((x) => x !== id)].slice(0, MAX_RECENT)
}

export function rememberDriver(id: string): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(pushRecent(loadRecent(), id)))
  } catch {
    // storage unavailable: recents are a convenience only
  }
}

/** What to do with a transcribed name. */
export type Resolved =
  | { kind: 'match'; driver: Driver }
  | { kind: 'create'; name: string }
  | { kind: 'empty' }

export function resolveTranscript(text: string, nameGuess: string | null | undefined, drivers: Driver[]): Resolved {
  const guess = nameGuess ? drivers.find((d) => d.id === nameGuess) : undefined
  if (guess) return { kind: 'match', driver: guess }
  const name = text.trim().replace(/[.!?,;:]+$/, '').trim().slice(0, MAX_DRIVER_NAME).trim()
  return name ? { kind: 'create', name } : { kind: 'empty' }
}

export type CrossingState =
  | { status: 'idle' }
  | { status: 'armed'; seconds: number }
  | { status: 'expired' }

/** Countdown for "assign by crossing" from the server's `armed_until` (ISO timestamp). */
export function crossingState(armedUntil: string | null, now: number): CrossingState {
  if (!armedUntil) return { status: 'idle' }
  // The backend sends UTC; a timestamp without a zone is treated as UTC too.
  const iso = /(Z|[+-]\d\d:?\d\d)$/.test(armedUntil) ? armedUntil : `${armedUntil}Z`
  const until = Date.parse(iso)
  if (Number.isNaN(until)) return { status: 'idle' }
  const ms = until - now
  return ms > 0 ? { status: 'armed', seconds: Math.ceil(ms / 1000) } : { status: 'expired' }
}

export const ADDRESSES = [0, 1, 2, 3, 4, 5]

type Slot = Pick<CarConfig, 'address' | 'name' | 'color'>

/** The six controller slots: configured cars first, missing addresses filled with defaults. */
export function carSlots(cars: Slot[]): Slot[] {
  const fallback = ['#e53935', '#1e88e5', '#43a047', '#fdd835', '#8e24aa', '#fb8c00']
  return ADDRESSES.map(
    (a) => cars.find((c) => c.address === a) ?? { address: a, name: `Car ${a + 1}`, color: fallback[a] },
  )
}

/** Photo cache-buster per driver, bumped after an upload or removal. */
const photoBust = new Map<string, string>()
export function bumpPhoto(id: string): void {
  photoBust.set(id, String(Date.now()))
}
export function photoVersion(id: string): string {
  return photoBust.get(id) ?? ''
}
