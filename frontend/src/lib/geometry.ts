// Geometry helpers for track layouts: closed polylines in normalised 0..1 coordinates,
// positions along them expressed as a fraction `s` of the lap (0 = start/finish line).
// Shared by the track editor and the live map.

import type { TrackPosition } from './types'

export type Pt = [number, number]

const dist = (a: Pt, b: Pt) => Math.hypot(b[0] - a[0], b[1] - a[1])

/** Cumulative length at each vertex of the CLOSED path; last entry is the total length. */
export function cumulative(points: Pt[]): number[] {
  const acc = [0]
  for (let i = 1; i <= points.length; i++) {
    acc.push(acc[i - 1] + dist(points[i - 1], points[i % points.length]))
  }
  return acc
}

/** Point at fraction s (wraps) along the closed path. */
export function pointAt(points: Pt[], s: number, cum = cumulative(points)): Pt {
  const total = cum[cum.length - 1]
  if (points.length === 0 || total === 0) return points[0] ?? [0, 0]
  const target = (((s % 1) + 1) % 1) * total
  let i = 1
  while (i < cum.length - 1 && cum[i] < target) i++
  const a = points[i - 1]
  const b = points[i % points.length]
  const seg = cum[i] - cum[i - 1]
  const t = seg > 0 ? (target - cum[i - 1]) / seg : 0
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
}

/** Unit tangent (driving direction) at fraction s. */
export function tangentAt(points: Pt[], s: number, cum = cumulative(points)): Pt {
  const total = cum[cum.length - 1] || 1
  const eps = 0.002
  const a = pointAt(points, s - eps, cum)
  const b = pointAt(points, s + eps, cum)
  const len = dist(a, b) || 1 / total
  return [(b[0] - a[0]) / len, (b[1] - a[1]) / len]
}

/** Fraction s of the path point closest to p (for placing sensors by click/tap). */
export function nearestS(points: Pt[], p: Pt, cum = cumulative(points)): number {
  const total = cum[cum.length - 1]
  if (total === 0) return 0
  let best = Infinity
  let bestS = 0
  for (let i = 0; i < points.length; i++) {
    const a = points[i]
    const b = points[(i + 1) % points.length]
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const l2 = dx * dx + dy * dy
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0
    const q: Pt = [a[0] + dx * t, a[1] + dy * t]
    const d = dist(p, q)
    if (d < best) {
      best = d
      bestS = (cum[i] + t * Math.sqrt(l2)) / total
    }
  }
  return bestS % 1
}

/** Resample the closed path to n points evenly spaced by length, starting at points[0]. */
export function resample(points: Pt[], n: number): Pt[] {
  const cum = cumulative(points)
  return Array.from({ length: n }, (_, k) => pointAt(points, k / n, cum))
}

/** Chaikin corner cutting on a closed path (smooths freehand strokes). */
export function smooth(points: Pt[], iterations = 2): Pt[] {
  let pts = points
  for (let it = 0; it < iterations; it++) {
    const out: Pt[] = []
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]
      const b = pts[(i + 1) % pts.length]
      out.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]])
      out.push([0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]])
    }
    pts = out
  }
  return pts
}

/** Rotate a closed path so that the vertex closest to fraction s becomes points[0]. */
export function rotateStart(points: Pt[], s: number): Pt[] {
  const cum = cumulative(points)
  const target = (((s % 1) + 1) % 1) * cum[cum.length - 1]
  let k = 0
  for (let i = 0; i < points.length; i++) {
    if (Math.abs(cum[i] - target) < Math.abs(cum[k] - target)) k = i
  }
  return [...points.slice(k), ...points.slice(0, k)]
}

/** Reverse the driving direction, keeping points[0] (the start/finish line) in place. */
export function reverse(points: Pt[]): Pt[] {
  return [points[0], ...points.slice(1).reverse()]
}

/** Scale arbitrary coordinates into 0..1 keeping proportions; returns points and aspect. */
export function normalise(points: Pt[]): { points: Pt[]; aspect: number } {
  const xs = points.map((p) => p[0])
  const ys = points.map((p) => p[1])
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  const w = Math.max(...xs) - minX || 1
  const h = Math.max(...ys) - minY || 1
  return {
    points: points.map(([x, y]) => [(x - minX) / w, (y - minY) / h]),
    aspect: w / h,
  }
}

/**
 * Estimated fraction s of a car right now (see TrackPosition in types.ts).
 * `raceNowMs` is the race clock extrapolated by the browser since the last state message.
 * The dot advances linearly in time between the two sensors and stops just before the
 * next one: a car can never pass a sensor before the Control Unit reports it.
 */
export function estimateS(pos: TrackPosition, raceNowMs: number, pitS: number | null): number {
  if (pos.in_pit && pitS !== null) return pitS
  const span = (pos.s_to - pos.s_from + 1) % 1 || 1 // stretch length, wrapping the line
  if (pos.expected_ms === null || pos.expected_ms <= 0) return pos.s_from
  const progress = approach(Math.max(0, (raceNowMs - pos.anchor_race_ms) / pos.expected_ms))
  return (pos.s_from + span * progress) % 1
}

/**
 * Linear up to 0.9 of the expected time, then an asymptotic approach toward 0.99: the dot
 * keeps creeping forward when the car is a little late instead of stopping dead before
 * the sensor, yet it never reaches the sensor before the Control Unit reports it.
 */
export function approach(p: number): number {
  const KNEE = 0.9
  const LIMIT = 0.99
  if (p <= KNEE) return p
  return KNEE + (LIMIT - KNEE) * (1 - Math.exp(-(p - KNEE) / (LIMIT - KNEE)))
}

/** Signed shortest step from a to b on the lap circle, in -0.5..0.5 (eases across the line). */
export function shortestDelta(a: number, b: number): number {
  return ((((b - a) % 1) + 1.5) % 1) - 0.5
}
