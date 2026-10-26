// Per-frame car tracking: motion (background model) ∧ colour (per-car signature lookup)
// → connected blobs → biggest blob per car → homography → nearest `s` on the layout path
// → outlier rejection. Work buffers are reused between frames.

import type { Pt } from '../geometry'
import { createBackground, updateForeground, type BackgroundModel } from './background'
import { BlobExtractor, largestPerLabel } from './blobs'
import type { Frame } from './frame'
import type { Mat3 } from './homography'
import { DEFAULT_FILTER, judgeMeasurement, projectToPath, type FilterOptions, type PathModel, type TrackPoint } from './projection'
import { buildLabelLut } from './signature'

export interface TrackerCar {
  address: number
  signature: readonly number[]
}

export interface TrackerOptions {
  motionThreshold: number
  backgroundAlpha: number
  /** Minimum blob area as a fraction of the frame area. */
  minAreaFraction: number
  /** Pixels must be moving (a parked car disappears into the background). */
  requireMotion: boolean
  filter: FilterOptions
}

export const DEFAULT_TRACKER: TrackerOptions = {
  motionThreshold: 28,
  backgroundAlpha: 0.05,
  minAreaFraction: 0.00012,
  requireMotion: true,
  filter: DEFAULT_FILTER,
}

export interface CarDetection {
  address: number
  /** Blob box and centroid in frame fractions (0..1). */
  box: [number, number, number, number]
  center: Pt
  area: number
  /** Null without a calibration or when the point cannot be projected. */
  s: number | null
  offPath: boolean
  accepted: boolean
  reason: 'far' | 'backwards' | 'jump' | 'uncalibrated' | null
}

export interface CarStats {
  /** Accepted detections over the last `STATS_WINDOW` frames (0..1). */
  rate: number
  lastSeen: number | null
  s: number | null
  offPath: boolean
}

export const STATS_WINDOW = 30

interface CarRuntime {
  address: number
  track: TrackPoint | null
  offPath: boolean
  hits: Uint8Array
  frames: number
  lastSeen: number | null
}

export class Tracker {
  private opts: TrackerOptions
  private bg: BackgroundModel = createBackground(0, 0)
  private mask = new Uint8Array(0)
  private labels = new Uint8Array(0)
  private blobs = new BlobExtractor()
  private lut: Uint8Array = new Uint8Array(32768)
  private cars: CarRuntime[] = []
  private h: Mat3 | null = null
  private path: PathModel | null = null

  constructor(opts: Partial<TrackerOptions> = {}) {
    this.opts = { ...DEFAULT_TRACKER, ...opts }
  }

  setCars(cars: readonly TrackerCar[]) {
    const old = new Map(this.cars.map((c) => [c.address, c]))
    this.cars = cars.slice(0, 254).map(
      (c) =>
        old.get(c.address) ?? {
          address: c.address,
          track: null,
          offPath: false,
          hits: new Uint8Array(STATS_WINDOW),
          frames: 0,
          lastSeen: null,
        },
    )
    this.lut = buildLabelLut(cars.slice(0, 254).map((c) => c.signature))
  }

  /** `h` maps frame fractions to the display space of `path`. */
  setCalibration(h: Mat3 | null, path: PathModel | null) {
    this.h = h
    this.path = path
    for (const c of this.cars) c.track = null
  }

  /** Forget the background and every track (new source or scene). */
  reset() {
    this.bg = createBackground(0, 0)
    for (const c of this.cars) {
      c.track = null
      c.hits.fill(0)
      c.frames = 0
      c.lastSeen = null
    }
  }

  stats(address: number): CarStats | null {
    const c = this.cars.find((x) => x.address === address)
    if (!c) return null
    const n = Math.min(c.frames, STATS_WINDOW)
    let hits = 0
    for (let i = 0; i < n; i++) hits += c.hits[i]
    return { rate: n ? hits / n : 0, lastSeen: c.lastSeen, s: c.track?.s ?? null, offPath: c.offPath }
  }

  process(frame: Frame, now: number): CarDetection[] {
    const { width, height, data } = frame
    const n = width * height
    if (this.mask.length !== n) {
      this.mask = new Uint8Array(n)
      this.labels = new Uint8Array(n)
    }
    const moving = updateForeground(this.bg, frame, this.mask, {
      threshold: this.opts.motionThreshold,
      alpha: this.opts.backgroundAlpha,
    })
    const out: CarDetection[] = []
    if (this.cars.length === 0) return out
    const labels = this.labels
    const lut = this.lut
    const mask = this.mask
    const any = !this.opts.requireMotion
    if (moving > 0 || any) {
      for (let i = 0, j = 0; i < n; i++, j += 4) {
        labels[i] = mask[i] || any ? lut[((data[j] >> 3) << 10) | ((data[j + 1] >> 3) << 5) | (data[j + 2] >> 3)] : 0
      }
    } else labels.fill(0)
    const minArea = Math.max(4, Math.round(n * this.opts.minAreaFraction))
    const best = largestPerLabel(moving > 0 || any ? this.blobs.extract(labels, width, height, minArea) : [])
    this.cars.forEach((car, k) => {
      const slot = car.frames % STATS_WINDOW
      car.frames++
      car.hits[slot] = 0
      const blob = best.get(k + 1)
      if (!blob) return
      const center: Pt = [(blob.cx + 0.5) / width, (blob.cy + 0.5) / height]
      const det: CarDetection = {
        address: car.address,
        box: [blob.minX / width, blob.minY / height, (blob.maxX + 1) / width, (blob.maxY + 1) / height],
        center,
        area: blob.area,
        s: null,
        offPath: false,
        accepted: false,
        reason: 'uncalibrated',
      }
      out.push(det)
      if (!this.h || !this.path) return
      const p = projectToPath(this.h, center, this.path)
      if (!p) return
      det.s = p.s
      const verdict = judgeMeasurement(car.track, { s: p.s, dist: p.dist, at: now }, this.opts.filter)
      if (!verdict.accept) {
        det.reason = verdict.reason
        if (car.track) car.track.rejected++
        return
      }
      det.accepted = true
      det.reason = null
      det.offPath = verdict.offPath
      car.track = { s: p.s, at: now, rejected: 0 }
      car.offPath = verdict.offPath
      car.lastSeen = now
      car.hits[slot] = 1
    })
    return out
  }
}
