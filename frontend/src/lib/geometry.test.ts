import { describe, expect, it } from 'vitest'
import {
  approach,
  shortestDelta,
  cumulative,
  estimateS,
  nearestS,
  normalise,
  pointAt,
  resample,
  reverse,
  rotateStart,
  type Pt,
} from './geometry'
import type { TrackPosition } from './types'

const square: Pt[] = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
]

const pos = (over: Partial<TrackPosition>): TrackPosition => ({
  from_sensor: 1,
  to_sensor: 2,
  s_from: 0,
  s_to: 0.5,
  anchor_race_ms: 1000,
  expected_ms: 2000,
  in_pit: false,
  confidence: 'estimated',
  ...over,
})

describe('geometry', () => {
  it('measures the closed path', () => {
    expect(cumulative(square).at(-1)).toBeCloseTo(4)
  })

  it('finds points by fraction, wrapping', () => {
    expect(pointAt(square, 0.25)).toEqual([1, 0])
    expect(pointAt(square, 0.625)).toEqual([0.5, 1])
    expect(pointAt(square, 1.25)).toEqual([1, 0])
  })

  it('projects a point to the nearest fraction', () => {
    expect(nearestS(square, [0.5, -0.1])).toBeCloseTo(0.125)
    expect(nearestS(square, [-0.2, 0.5])).toBeCloseTo(0.875)
  })

  it('resamples evenly from the start', () => {
    const r = resample(square, 8)
    expect(r).toHaveLength(8)
    expect(r[0]).toEqual([0, 0])
    expect(r[2]).toEqual([1, 0])
  })

  it('rotates the start and reverses keeping the start', () => {
    expect(rotateStart(square, 0.5)[0]).toEqual([1, 1])
    expect(reverse(square)).toEqual([[0, 0], [0, 1], [1, 1], [1, 0]])
  })

  it('normalises keeping the aspect', () => {
    const n = normalise([[10, 10], [30, 10], [30, 20], [10, 20]])
    expect(n.aspect).toBeCloseTo(2)
    expect(n.points[2]).toEqual([1, 1])
  })

  it('estimates progress between sensors and never passes the next one', () => {
    expect(estimateS(pos({}), 2000, null)).toBeCloseTo(0.25) // halfway through 0 → 0.5
    expect(estimateS(pos({}), 99_000, null)).toBeLessThan(0.5)
    expect(estimateS(pos({ expected_ms: null }), 5000, null)).toBe(0)
  })

  it('slows down asymptotically instead of stopping before the sensor', () => {
    expect(approach(0.5)).toBe(0.5)
    expect(approach(1.0)).toBeGreaterThan(0.95)
    expect(approach(1.0)).toBeLessThan(approach(1.3))
    expect(approach(50)).toBeLessThan(0.99)
  })

  it('eases across the start/finish line by the shortest way', () => {
    expect(shortestDelta(0.95, 0.05)).toBeCloseTo(0.1)
    expect(shortestDelta(0.05, 0.95)).toBeCloseTo(-0.1)
    expect(shortestDelta(0.2, 0.4)).toBeCloseTo(0.2)
  })

  it('wraps through the start/finish line', () => {
    const s = estimateS(pos({ s_from: 0.8, s_to: 0, anchor_race_ms: 0, expected_ms: 1000 }), 500, null)
    expect(s).toBeCloseTo(0.9)
  })

  it('puts pitted cars at the pit position', () => {
    expect(estimateS(pos({ in_pit: true }), 2000, 0.3)).toBe(0.3)
  })
})
