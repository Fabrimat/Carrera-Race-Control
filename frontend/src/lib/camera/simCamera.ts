// Simulated camera: renders the layout and the car dots as a tilted camera would see them
// (perspective warp, uneven lighting, sensor noise) straight into an RGBA buffer, so the
// whole tracking pipeline can be exercised on the simulator, in the browser and in tests.

import { pointAt, tangentAt, type Pt } from '../geometry'
import type { Frame } from './frame'
import { applyHomography, computeHomography, type Mat3 } from './homography'
import { pathModel, type PathModel } from './projection'

export const SIM_WIDTH = 320
export const SIM_HEIGHT = 240
export const SIM_FPS = 15

/** Half width of the drawn track and car radius, display units (TrackMap uses similar). */
const TRACK_HALF = 0.032
const CAR_RADIUS = 0.026
const OFF_TRACK_SHIFT = 0.085
const PAD = 0.12

export interface SimCar {
  address: number
  color: string
  s: number
  /** Deslotted: drawn beside the track. */
  offTrack?: boolean
}

export interface SimScene {
  width: number
  height: number
  path: PathModel
  /** Display space → image fractions (the "true" camera; the user calibrates its inverse). */
  toImage: Mat3
  base: Uint8ClampedArray
  light: Float32Array
  seed: number
}

export function parseHex(color: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(color.trim())
  if (!m) return [200, 200, 200]
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function stamp(buf: Uint8ClampedArray, w: number, h: number, cx: number, cy: number, r: number, rgb: [number, number, number]) {
  const x0 = Math.max(0, Math.floor(cx - r))
  const x1 = Math.min(w - 1, Math.ceil(cx + r))
  const y0 = Math.max(0, Math.floor(cy - r))
  const y1 = Math.min(h - 1, Math.ceil(cy + r))
  const r2 = r * r
  for (let y = y0; y <= y1; y++) {
    const dy = y + 0.5 - cy
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx
      if (dx * dx + dy * dy > r2) continue
      const i = (y * w + x) * 4
      buf[i] = rgb[0]
      buf[i + 1] = rgb[1]
      buf[i + 2] = rgb[2]
    }
  }
}

/** Image pixel centre and pixel radius of a display-space disc of radius `r` at `q`. */
function project(scene: Pick<SimScene, 'toImage' | 'width' | 'height'>, q: Pt, r: number): [number, number, number] | null {
  const c = applyHomography(scene.toImage, q)
  const e = applyHomography(scene.toImage, [q[0] + r, q[1]])
  const f = applyHomography(scene.toImage, [q[0], q[1] + r])
  if (!c || !e || !f) return null
  const px = c[0] * scene.width
  const py = c[1] * scene.height
  const rx = Math.hypot(e[0] * scene.width - px, e[1] * scene.height - py)
  const ry = Math.hypot(f[0] * scene.width - px, f[1] * scene.height - py)
  return [px, py, (rx + ry) / 2]
}

export function createSimScene(
  layout: { points: readonly (readonly [number, number])[]; aspect: number },
  width = SIM_WIDTH,
  height = SIM_HEIGHT,
): SimScene {
  const path = pathModel(layout)
  const a = layout.aspect
  // The camera looks at the table from the near long side: the far edge appears narrower.
  const toImage = computeHomography(
    [
      [-PAD, -PAD],
      [a + PAD, -PAD],
      [a + PAD, 1 + PAD],
      [-PAD, 1 + PAD],
    ],
    [
      [0.2, 0.08],
      [0.84, 0.12],
      [0.97, 0.94],
      [0.03, 0.9],
    ],
  )
  const scene: SimScene = {
    width,
    height,
    path,
    toImage,
    base: new Uint8ClampedArray(width * height * 4),
    light: new Float32Array(width * height),
    seed: 0x9e3779b9,
  }
  const toTable = computeHomography(
    [
      [0.2, 0.08],
      [0.84, 0.12],
      [0.97, 0.94],
      [0.03, 0.9],
    ],
    [
      [-PAD, -PAD],
      [a + PAD, -PAD],
      [a + PAD, 1 + PAD],
      [-PAD, 1 + PAD],
    ],
  )
  const base = scene.base
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const fx = (x + 0.5) / width
      const fy = (y + 0.5) / height
      const q = applyHomography(toTable, [fx, fy])
      const onTable = q !== null && q[0] >= -PAD && q[0] <= a + PAD && q[1] >= -PAD && q[1] <= 1 + PAD
      const c = onTable ? [44, 47, 50] : [14, 15, 17]
      base[i] = c[0]
      base[i + 1] = c[1]
      base[i + 2] = c[2]
      base[i + 3] = 255
      // A lamp on the right: brighter towards it, darker in the far left corner.
      scene.light[y * width + x] = 0.55 + 0.6 * fx + 0.12 * fy
    }
  }
  // Track: discs stamped along the path; then a dashed centre line and the start line.
  const n = 1600
  for (let k = 0; k < n; k++) {
    const q = pointAt(path.points, k / n, path.cum)
    const p = project(scene, q, TRACK_HALF)
    if (p) stamp(base, width, height, p[0], p[1], p[2], [74, 79, 85])
  }
  for (let k = 0; k < n; k++) {
    if (Math.floor(k / 12) % 2) continue
    const p = project(scene, pointAt(path.points, k / n, path.cum), 0)
    if (p) stamp(base, width, height, p[0], p[1], 0.6, [150, 152, 150])
  }
  const s0 = pointAt(path.points, 0, path.cum)
  const [tx, ty] = tangentAt(path.points, 0, path.cum)
  for (let k = -10; k <= 10; k++) {
    const d = (k / 10) * TRACK_HALF
    const p = project(scene, [s0[0] - ty * d, s0[1] + tx * d], 0)
    if (p) stamp(base, width, height, p[0], p[1], 1.2, [235, 235, 235])
  }
  return scene
}

/** Renders one frame with the cars at their `s` (writes into `out`, no allocation). */
export function renderSimFrame(scene: SimScene, cars: readonly SimCar[], out: Frame, noise = 9): void {
  const { width, height } = scene
  const d = out.data
  d.set(scene.base)
  for (const car of cars) {
    let q = pointAt(scene.path.points, car.s, scene.path.cum)
    if (car.offTrack) {
      const [tx, ty] = tangentAt(scene.path.points, car.s, scene.path.cum)
      q = [q[0] - ty * OFF_TRACK_SHIFT, q[1] + tx * OFF_TRACK_SHIFT]
    }
    const p = project(scene, q, CAR_RADIUS)
    if (p) stamp(d, width, height, p[0], p[1], p[2], parseHex(car.color))
  }
  // Lighting and per-channel noise (xorshift32: cheap and deterministic).
  let x = scene.seed
  const light = scene.light
  const amp = noise * 2 + 1
  for (let i = 0, j = 0; i < width * height; i++, j += 4) {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    const l = light[i]
    d[j] = d[j] * l + ((x & 255) % amp) - noise
    d[j + 1] = d[j + 1] * l + (((x >>> 8) & 255) % amp) - noise
    d[j + 2] = d[j + 2] * l + (((x >>> 16) & 255) % amp) - noise
  }
  scene.seed = x
}
