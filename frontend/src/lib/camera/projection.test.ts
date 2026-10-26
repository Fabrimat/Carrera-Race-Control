import { describe, expect, it } from 'vitest'
import { pointAt, type Pt } from '../geometry'
import type { Mat3 } from './homography'
import { DEFAULT_FILTER, judgeMeasurement, pathModel, projectToPath } from './projection'

const square: Pt[] = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
]
const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1]

describe('projectToPath', () => {
  const path = pathModel({ points: square, aspect: 2 }) // display space: x spans 0..2

  it('maps an image point to the nearest s of the path in display space', () => {
    const p = projectToPath(IDENTITY, [1, 0.01], path)!
    expect(p.s).toBeCloseTo(1 / 6, 3) // (1, 0) is a third of the top edge of length 2
    expect(p.dist).toBeCloseTo(0.01, 6)
    expect(p.layout).toEqual([1, 0.01])
    const q = pointAt(path.points, p.s, path.cum)
    expect(q[0]).toBeCloseTo(1, 6)
  })

  it('applies the homography first', () => {
    const scale: Mat3 = [2, 0, 0, 0, 1, 0, 0, 0, 1] // image x 0..1 → display x 0..2
    const p = projectToPath(scale, [1, 0.5], path)!
    expect(p.layout).toEqual([2, 0.5])
    expect(p.dist).toBeCloseTo(0, 6)
    expect(p.s).toBeCloseTo((2 + 0.5) / 6, 6)
  })

  it('returns null for a point at infinity', () => {
    expect(projectToPath([1, 0, 0, 0, 1, 0, 1, 0, -1], [1, 0], path)).toBeNull()
  })
})

describe('judgeMeasurement (outlier rejection)', () => {
  const m = (s: number, dist = 0, at = 1000) => ({ s, dist, at })

  it('accepts the first measurement on the path', () => {
    expect(judgeMeasurement(null, m(0.3))).toEqual({ accept: true, offPath: false })
  })

  it('flags a car slightly off the path and rejects one far away', () => {
    expect(judgeMeasurement(null, m(0.3, DEFAULT_FILTER.offPathDist * 1.5))).toEqual({ accept: true, offPath: true })
    expect(judgeMeasurement(null, m(0.3, DEFAULT_FILTER.rejectDist * 1.1))).toEqual({ accept: false, reason: 'far' })
  })

  it('rejects jumps backwards beyond the tolerance, tolerates jitter', () => {
    const prev = { s: 0.5, at: 900, rejected: 0 }
    expect(judgeMeasurement(prev, m(0.49)).accept).toBe(true)
    expect(judgeMeasurement(prev, m(0.4))).toEqual({ accept: false, reason: 'backwards' })
  })

  it('handles the wrap across the start line', () => {
    const prev = { s: 0.98, at: 900, rejected: 0 }
    expect(judgeMeasurement(prev, m(0.02)).accept).toBe(true)
    expect(judgeMeasurement({ s: 0.02, at: 900, rejected: 0 }, m(0.9))).toEqual({ accept: false, reason: 'backwards' })
  })

  it('rejects impossible forward jumps for the elapsed time', () => {
    const prev = { s: 0.1, at: 930, rejected: 0 }
    expect(judgeMeasurement(prev, m(0.12)).accept).toBe(true)
    expect(judgeMeasurement(prev, m(0.45))).toEqual({ accept: false, reason: 'jump' })
  })

  it('re-acquires after a stale track or too many rejections', () => {
    expect(judgeMeasurement({ s: 0.5, at: 0, rejected: 0 }, m(0.1, 0, 5000)).accept).toBe(true)
    const stuck = { s: 0.5, at: 900, rejected: DEFAULT_FILTER.maxRejections }
    expect(judgeMeasurement(stuck, m(0.1)).accept).toBe(true)
  })
})
