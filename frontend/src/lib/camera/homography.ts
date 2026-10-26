// Planar homography (3x3, row-major) estimated with the normalised Direct Linear Transform
// (Hartley & Zisserman, alg. 4.2). Used to map camera image points to layout coordinates.
// No dependencies: the null vector of the 2n x 9 system is the eigenvector of AᵀA with the
// smallest eigenvalue, found with a cyclic Jacobi sweep on the 9x9 symmetric matrix.

import type { Pt } from '../geometry'

/** Row-major 3x3 matrix: [h0 h1 h2; h3 h4 h5; h6 h7 h8]. */
export type Mat3 = number[]

export type HomographyErrorCode = 'too_few' | 'mismatch' | 'degenerate' | 'singular'

export class HomographyError extends Error {
  code: HomographyErrorCode
  constructor(code: HomographyErrorCode, message: string) {
    super(message)
    this.name = 'HomographyError'
    this.code = code
  }
}

export interface ReprojectionError {
  /** Root mean square distance between mapped source points and their targets. */
  rms: number
  max: number
  perPoint: number[]
}

/** Similarity transform moving the centroid to 0 and the mean distance to √2. */
function normaliser(points: Pt[]): Mat3 {
  let cx = 0
  let cy = 0
  for (const [x, y] of points) {
    cx += x
    cy += y
  }
  cx /= points.length
  cy /= points.length
  let mean = 0
  for (const [x, y] of points) mean += Math.hypot(x - cx, y - cy)
  mean /= points.length
  if (!(mean > 1e-12)) throw new HomographyError('degenerate', 'degenerate input: all points coincide')
  const k = Math.SQRT2 / mean
  return [k, 0, -k * cx, 0, k, -k * cy, 0, 0, 1]
}

function mul(a: Mat3, b: Mat3): Mat3 {
  const r = new Array<number>(9)
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j]
  return r
}

function det(h: Mat3): number {
  return (
    h[0] * (h[4] * h[8] - h[5] * h[7]) - h[1] * (h[3] * h[8] - h[5] * h[6]) + h[2] * (h[3] * h[7] - h[4] * h[6])
  )
}

/**
 * Eigen-decomposition of a symmetric n x n matrix (cyclic Jacobi). Returns eigenvalues and
 * the matching eigenvectors as columns of `v` (row-major, v[i * n + k] = component i of k).
 */
function jacobiEigen(input: number[], n: number): { values: number[]; v: number[] } {
  const a = input.slice()
  const v = new Array<number>(n * n).fill(0)
  for (let i = 0; i < n; i++) v[i * n + i] = 1
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p * n + q] * a[p * n + q]
    if (off < 1e-30) break
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = a[p * n + q]
        if (Math.abs(apq) < 1e-300) continue
        const theta = (a[q * n + q] - a[p * n + p]) / (2 * apq)
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
        const c = 1 / Math.sqrt(t * t + 1)
        const s = t * c
        for (let k = 0; k < n; k++) {
          const akp = a[k * n + p]
          const akq = a[k * n + q]
          a[k * n + p] = c * akp - s * akq
          a[k * n + q] = s * akp + c * akq
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p * n + k]
          const aqk = a[q * n + k]
          a[p * n + k] = c * apk - s * aqk
          a[q * n + k] = s * apk + c * aqk
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k * n + p]
          const vkq = v[k * n + q]
          v[k * n + p] = c * vkp - s * vkq
          v[k * n + q] = s * vkp + c * vkq
        }
      }
    }
  }
  return { values: Array.from({ length: n }, (_, i) => a[i * n + i]), v }
}

/**
 * Homography H with dst ≈ H·src, from n ≥ 4 correspondences (least squares when n > 4).
 * Throws HomographyError: `too_few`, `mismatch`, or `degenerate` (collinear / repeated /
 * non-finite points, or a solution that is not unique or not invertible).
 */
export function computeHomography(src: Pt[], dst: Pt[]): Mat3 {
  if (src.length !== dst.length) throw new HomographyError('mismatch', 'point lists differ in length')
  if (src.length < 4) throw new HomographyError('too_few', 'at least 4 point pairs are needed')
  for (const p of [...src, ...dst]) {
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1]))
      throw new HomographyError('degenerate', 'degenerate input: non-finite coordinate')
  }
  const ts = normaliser(src)
  const td = normaliser(dst)
  // Accumulate AᵀA directly (9x9), two rows per correspondence.
  const m = new Array<number>(81).fill(0)
  const row = new Array<number>(9)
  const addRow = () => {
    for (let i = 0; i < 9; i++) {
      const ri = row[i]
      if (ri === 0) continue
      for (let j = 0; j < 9; j++) m[i * 9 + j] += ri * row[j]
    }
  }
  for (let i = 0; i < src.length; i++) {
    const x = ts[0] * src[i][0] + ts[2]
    const y = ts[4] * src[i][1] + ts[5]
    const u = td[0] * dst[i][0] + td[2]
    const w = td[4] * dst[i][1] + td[5]
    row[0] = -x; row[1] = -y; row[2] = -1; row[3] = 0; row[4] = 0; row[5] = 0
    row[6] = u * x; row[7] = u * y; row[8] = u
    addRow()
    row[0] = 0; row[1] = 0; row[2] = 0; row[3] = -x; row[4] = -y; row[5] = -1
    row[6] = w * x; row[7] = w * y; row[8] = w
    addRow()
  }
  const { values, v } = jacobiEigen(m, 9)
  const order = values.map((_, i) => i).sort((a, b) => values[a] - values[b])
  const largest = Math.max(values[order[8]], 1e-300)
  // A unique solution needs a one-dimensional null space: the second smallest eigenvalue
  // must be clearly above zero (3 collinear points out of 4, all points on a line, ...).
  if (values[order[1]] <= 1e-10 * largest)
    throw new HomographyError('degenerate', 'degenerate input: collinear or repeated points')
  const k = order[0]
  const hn: Mat3 = Array.from({ length: 9 }, (_, i) => v[i * 9 + k])
  // hn has unit norm; a near-zero determinant means the map squashes the plane to a line.
  if (Math.abs(det(hn)) < 1e-9) throw new HomographyError('degenerate', 'degenerate input: singular mapping')
  const tdInv: Mat3 = [1 / td[0], 0, -td[2] / td[0], 0, 1 / td[4], -td[5] / td[4], 0, 0, 1]
  const h = mul(mul(tdInv, hn), ts)
  return scaleNice(h)
}

/** Scale so h8 = 1 when possible (else unit Frobenius norm): easier to read and store. */
function scaleNice(h: Mat3): Mat3 {
  let k = h[8]
  if (Math.abs(k) < 1e-12) k = Math.hypot(...h)
  return h.map((x) => x / k)
}

/** Maps p through h; null when it lands on (or numerically near) the line at infinity. */
export function applyHomography(h: Mat3, p: Pt): Pt | null {
  const w = h[6] * p[0] + h[7] * p[1] + h[8]
  if (!Number.isFinite(w) || Math.abs(w) < 1e-12) return null
  return [(h[0] * p[0] + h[1] * p[1] + h[2]) / w, (h[3] * p[0] + h[4] * p[1] + h[5]) / w]
}

export function invertHomography(h: Mat3): Mat3 {
  const d = det(h)
  const scale = Math.hypot(...h) ** 3
  if (!Number.isFinite(d) || Math.abs(d) <= 1e-12 * scale) throw new HomographyError('singular', 'matrix is singular')
  const inv: Mat3 = [
    h[4] * h[8] - h[5] * h[7],
    h[2] * h[7] - h[1] * h[8],
    h[1] * h[5] - h[2] * h[4],
    h[5] * h[6] - h[3] * h[8],
    h[0] * h[8] - h[2] * h[6],
    h[2] * h[3] - h[0] * h[5],
    h[3] * h[7] - h[4] * h[6],
    h[1] * h[6] - h[0] * h[7],
    h[0] * h[4] - h[1] * h[3],
  ].map((x) => x / d)
  return scaleNice(inv)
}

/** Distances in destination units between H·src[i] and dst[i]. */
export function reprojectionError(h: Mat3, src: Pt[], dst: Pt[]): ReprojectionError {
  const perPoint = src.map((p, i) => {
    const q = applyHomography(h, p)
    return q ? Math.hypot(q[0] - dst[i][0], q[1] - dst[i][1]) : Infinity
  })
  const n = perPoint.length || 1
  return {
    rms: Math.sqrt(perPoint.reduce((a, d) => a + d * d, 0) / n),
    max: perPoint.reduce((a, d) => Math.max(a, d), 0),
    perPoint,
  }
}
