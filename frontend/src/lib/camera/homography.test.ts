import { describe, expect, it } from 'vitest'
import type { Pt } from '../geometry'
import {
  HomographyError,
  applyHomography,
  computeHomography,
  invertHomography,
  reprojectionError,
  type Mat3,
} from './homography'

// A genuine perspective transform (non-zero last row), scaled arbitrarily.
const TRUE: Mat3 = [1.2, 0.15, 0.1, -0.05, 0.9, 0.2, 0.3, -0.2, 1]

const src: Pt[] = [
  [0.1, 0.1],
  [0.9, 0.12],
  [0.85, 0.8],
  [0.15, 0.9],
  [0.5, 0.5],
  [0.3, 0.65],
]
const dst = src.map((p) => applyHomography(TRUE, p) as Pt)

describe('homography', () => {
  it('recovers a known transform from exactly 4 points', () => {
    const h = computeHomography(src.slice(0, 4), dst.slice(0, 4))
    for (const p of [[0.4, 0.3], [0.7, 0.7], [0.2, 0.5]] as Pt[]) {
      const a = applyHomography(h, p)!
      const b = applyHomography(TRUE, p)!
      expect(a[0]).toBeCloseTo(b[0], 9)
      expect(a[1]).toBeCloseTo(b[1], 9)
    }
  })

  it('fits more than 4 points by least squares with ~0 reprojection error', () => {
    const h = computeHomography(src, dst)
    const err = reprojectionError(h, src, dst)
    expect(err.rms).toBeLessThan(1e-9)
    expect(err.max).toBeLessThan(1e-9)
    expect(err.perPoint).toHaveLength(src.length)
  })

  it('reports the error of noisy correspondences', () => {
    const noisy = dst.map(([x, y], i) => [x + (i % 2 ? 0.01 : -0.01), y] as Pt)
    const h = computeHomography(src, noisy)
    const err = reprojectionError(h, src, noisy)
    expect(err.rms).toBeGreaterThan(0.001)
    expect(err.rms).toBeLessThan(0.02)
  })

  it('round-trips through the inverse', () => {
    const h = computeHomography(src, dst)
    const inv = invertHomography(h)
    for (const p of src) {
      const back = applyHomography(inv, applyHomography(h, p)!)!
      expect(back[0]).toBeCloseTo(p[0], 9)
      expect(back[1]).toBeCloseTo(p[1], 9)
    }
  })

  it('works with coordinates of very different scales (normalisation)', () => {
    const pix = src.map(([x, y]) => [x * 1920, y * 1080] as Pt)
    const h = computeHomography(pix, dst)
    expect(reprojectionError(h, pix, dst).max).toBeLessThan(1e-8)
  })

  it('rejects fewer than 4 points or mismatched lists', () => {
    expect(() => computeHomography(src.slice(0, 3), dst.slice(0, 3))).toThrow(HomographyError)
    expect(() => computeHomography(src, dst.slice(0, 5))).toThrow(HomographyError)
    try {
      computeHomography(src.slice(0, 3), dst.slice(0, 3))
    } catch (e) {
      expect((e as HomographyError).code).toBe('too_few')
    }
  })

  it('rejects degenerate input (collinear, duplicated, non-finite)', () => {
    const line: Pt[] = [
      [0, 0],
      [1, 1],
      [2, 2],
      [3, 3],
    ]
    expect(() => computeHomography(line, dst.slice(0, 4))).toThrow(/degenerate/)
    const three: Pt[] = [
      [0, 0],
      [1, 0],
      [2, 0],
      [0, 1],
    ]
    expect(() => computeHomography(three, dst.slice(0, 4))).toThrow(HomographyError)
    const dup: Pt[] = [src[0], src[0], src[1], src[2]]
    expect(() => computeHomography(dup, dst.slice(0, 4))).toThrow(HomographyError)
    const bad: Pt[] = [[NaN, 0], src[1], src[2], src[3]]
    expect(() => computeHomography(bad, dst.slice(0, 4))).toThrow(HomographyError)
  })

  it('returns null when a point maps to infinity', () => {
    // Last row (1, 0, -1): points with x = 1 go to the line at infinity.
    const h: Mat3 = [1, 0, 0, 0, 1, 0, 1, 0, -1]
    expect(applyHomography(h, [1, 0.5])).toBeNull()
  })

  it('refuses to invert a singular matrix', () => {
    expect(() => invertHomography([1, 2, 3, 2, 4, 6, 0, 0, 1])).toThrow(HomographyError)
  })
})
