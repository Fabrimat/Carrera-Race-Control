/**
 * Pure queue for the TV broadcast banners: one banner on screen at a time (never overlapping),
 * higher priority first, FIFO inside a priority, stale entries dropped. The React layer only
 * feeds it events and a clock; all timing rules live here so they can be tested without a DOM.
 */

export type BannerKind =
  | 'fastest_lap'
  | 'track_record'
  | 'overtake'
  | 'pit_in'
  | 'pit_out'
  | 'low_fuel'
  | 'control'
  | 'final_lap'
  | 'chequered'

export interface Banner {
  /** Unique key: a banner with the id of one already queued or on screen is ignored. */
  id: string
  kind: BannerKind
  /** Higher shows first. */
  priority: number
  /** Time fully visible, ms. `Infinity` = stays until dismissed (results card). */
  durationMs: number
  /** Lower-third strip or centred card. */
  layout: 'lower' | 'center'
  title: string
  subtitle?: string
  /** Accent colour (a car colour); kind-specific colours come from CSS. */
  color?: string
  /** Driver photo (display only) of the featured car. */
  photo?: string
  /** Free-form payload for card banners (podium rows). */
  rows?: { pos: number; code: string; name: string; color: string; best: string; time: string; photo?: string }[]
}

export interface ActiveBanner {
  banner: Banner
  startedAt: number
  /** The exit animation starts here. */
  exitAt: number
}

export interface QueueState {
  active: ActiveBanner | null
  queue: { banner: Banner; at: number }[]
}

export const EXIT_MS = 500
export const MAX_QUEUE = 8
/** A banner that waited longer than this is no longer news. */
export const MAX_WAIT_MS = 15000
/** Banners at or above this priority wipe lower ones still waiting (e.g. the chequered flag). */
export const CLEARING_PRIORITY = 9

export const emptyQueue: QueueState = { active: null, queue: [] }

const PRIORITY: Record<BannerKind, number> = {
  low_fuel: 1,
  pit_in: 1,
  pit_out: 1,
  overtake: 2,
  fastest_lap: 3,
  control: 3,
  final_lap: 4,
  track_record: 5,
  chequered: CLEARING_PRIORITY,
}
export const priorityOf = (kind: BannerKind) => PRIORITY[kind]

export function endOf(a: ActiveBanner): number {
  return a.exitAt + EXIT_MS
}

/** Move the queue forward to `now`: retire the active banner, drop stale entries, start the next. */
export function advance(state: QueueState, now: number): QueueState {
  let { active, queue } = state
  let changed = false
  if (active && now >= endOf(active)) {
    active = null
    changed = true
  }
  const fresh = queue.filter((q) => now - q.at <= MAX_WAIT_MS || q.banner.durationMs === Infinity)
  if (fresh.length !== queue.length) {
    queue = fresh
    changed = true
  }
  if (!active && queue.length > 0) {
    // Stable pick: highest priority, then the oldest.
    let best = 0
    for (let i = 1; i < queue.length; i++) {
      if (queue[i].banner.priority > queue[best].banner.priority) best = i
    }
    const next = queue[best].banner
    queue = queue.filter((_, i) => i !== best)
    active = { banner: next, startedAt: now, exitAt: now + next.durationMs }
    changed = true
  }
  return changed ? { active, queue } : state
}

export function enqueue(state: QueueState, banner: Banner, now: number): QueueState {
  if (state.active?.banner.id === banner.id || state.queue.some((q) => q.banner.id === banner.id)) {
    return advance(state, now)
  }
  let queue = state.queue
  if (banner.priority >= CLEARING_PRIORITY) queue = queue.filter((q) => q.banner.priority >= banner.priority)
  queue = [...queue, { banner, at: now }]
  if (queue.length > MAX_QUEUE) {
    // Drop the least important, oldest entry.
    let worst = 0
    for (let i = 1; i < queue.length; i++) {
      if (queue[i].banner.priority < queue[worst].banner.priority) worst = i
    }
    queue = queue.filter((_, i) => i !== worst)
  }
  return advance({ ...state, queue }, now)
}

/** Start the exit animation of the banner with `id` now (used by sticky cards). */
export function dismiss(state: QueueState, id: string, now: number): QueueState {
  if (state.active?.banner.id === id && state.active.exitAt > now) {
    return advance({ ...state, active: { ...state.active, exitAt: now } }, now)
  }
  if (state.queue.some((q) => q.banner.id === id)) {
    return { ...state, queue: state.queue.filter((q) => q.banner.id !== id) }
  }
  return state
}

export function isExiting(a: ActiveBanner, now: number): boolean {
  return now >= a.exitAt
}

/** ms until the queue needs another `advance` call, or null when it is idle / waiting for dismissal. */
export function nextWake(state: QueueState, now: number): number | null {
  const a = state.active
  if (!a) return state.queue.length > 0 ? 0 : null
  const exit = a.exitAt === Infinity ? Infinity : a.exitAt
  const target = now < exit ? exit : endOf(a)
  return target === Infinity ? null : Math.max(0, target - now)
}
