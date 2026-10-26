// From an image point to a position on the lap: homography → layout display space →
// nearest point of the path (`s`), plus the rules that reject implausible measurements.
// Distances are in display units (the layout is 1 high, `aspect` wide), like TrackMap.

import { cumulative, nearestS, pointAt, shortestDelta, toDisplay, type Pt } from '../geometry'
import { applyHomography, type Mat3 } from './homography'

export interface PathModel {
  /** Path vertices in display space (x * aspect, y). */
  points: Pt[]
  cum: number[]
}

export function pathModel(layout: { points: readonly (readonly [number, number])[]; aspect: number }): PathModel {
  const points = toDisplay(layout.points as Pt[], layout.aspect)
  return { points, cum: cumulative(points) }
}

export interface Projection {
  s: number
  /** Distance from the path, display units. */
  dist: number
  /** The image point in display space. */
  layout: Pt
}

/** `h` maps image points (frame fractions 0..1) to display space. */
export function projectToPath(h: Mat3, img: Pt, path: PathModel): Projection | null {
  const p = applyHomography(h, img)
  if (!p) return null
  const s = nearestS(path.points, p, path.cum)
  const q = pointAt(path.points, s, path.cum)
  return { s, dist: Math.hypot(p[0] - q[0], p[1] - q[1]), layout: p }
}

export interface FilterOptions {
  /** Farther than this from the path: still tracked but flagged `off_path`. */
  offPathDist: number
  /** Farther than this: not this car (a reflection, a hand, the wrong blob). */
  rejectDist: number
  /** Backward steps up to this fraction of a lap are jitter; beyond, rejected. */
  backTolerance: number
  /** Fastest plausible car, laps per second (forward jumps beyond that are rejected). */
  maxLapsPerSecond: number
  /** After this long without an accepted measurement the car is re-acquired anywhere. */
  reacquireMs: number
  /** After this many consecutive rejections the car is re-acquired anywhere. */
  maxRejections: number
}

export const DEFAULT_FILTER: FilterOptions = {
  offPathDist: 0.06,
  rejectDist: 0.2,
  backTolerance: 0.03,
  maxLapsPerSecond: 1,
  reacquireMs: 1000,
  maxRejections: 8,
}

export interface TrackPoint {
  s: number
  /** Time of the last accepted measurement (ms). */
  at: number
  /** Consecutive rejections since then. */
  rejected: number
}

export type Verdict = { accept: true; offPath: boolean } | { accept: false; reason: 'far' | 'backwards' | 'jump' }

export function judgeMeasurement(
  prev: TrackPoint | null,
  m: { s: number; dist: number; at: number },
  o: FilterOptions = DEFAULT_FILTER,
): Verdict {
  if (m.dist > o.rejectDist) return { accept: false, reason: 'far' }
  const offPath = m.dist > o.offPathDist
  if (!prev || m.at - prev.at > o.reacquireMs || prev.rejected >= o.maxRejections) return { accept: true, offPath }
  const delta = shortestDelta(prev.s, m.s)
  if (delta < -o.backTolerance) return { accept: false, reason: 'backwards' }
  const dt = Math.max(0, m.at - prev.at) / 1000
  if (delta > o.maxLapsPerSecond * dt + o.backTolerance) return { accept: false, reason: 'jump' }
  return { accept: true, offPath }
}
