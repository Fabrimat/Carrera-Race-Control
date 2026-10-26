// Camera calibration: image ↔ layout point pairs, stored per layout in localStorage
// (`carrera.camera.<layout>`, docs/PROTOCOL.md "Webcam tracking"), exportable as JSON.
// Image points are fractions of the frame (resolution independent); layout points are in
// the layout's normalised 0..1 coordinates (the same as TrackLayout.points).

import type { Pt } from '../geometry'
import { computeHomography, HomographyError, reprojectionError, type Mat3, type ReprojectionError } from './homography'
import { BINS } from './signature'

export interface CalibrationPair {
  image: Pt
  layout: Pt
}

export interface CameraCalibration {
  version: 1
  layout: string
  pairs: CalibrationPair[]
  saved_at: string
}

export const MAX_PAIRS = 100
const SIGNATURES_KEY = 'carrera.camera-signatures'
export const BACKGROUND_KEY = 'carrera.camera-background'

export const calibrationKey = (layout: string) => `carrera.camera.${layout}`

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

const isPt = (v: unknown): v is Pt =>
  Array.isArray(v) &&
  v.length === 2 &&
  v.every((x) => typeof x === 'number' && Number.isFinite(x) && x >= -1 && x <= 2)

/** Validates untrusted data (an imported file, stored JSON); null if not a calibration. */
export function parseCalibration(data: unknown): CameraCalibration | null {
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  if (d.version !== 1) return null
  if (typeof d.layout !== 'string' || d.layout.length < 1 || d.layout.length > 40) return null
  if (!Array.isArray(d.pairs) || d.pairs.length > MAX_PAIRS) return null
  const pairs: CalibrationPair[] = []
  for (const p of d.pairs) {
    if (!p || typeof p !== 'object') return null
    const { image, layout } = p as Record<string, unknown>
    if (!isPt(image) || !isPt(layout)) return null
    pairs.push({ image: [image[0], image[1]], layout: [layout[0], layout[1]] })
  }
  const saved_at = typeof d.saved_at === 'string' ? d.saved_at.slice(0, 40) : ''
  return { version: 1, layout: d.layout, pairs, saved_at }
}

export function saveCalibration(c: CameraCalibration): void {
  storage()?.setItem(calibrationKey(c.layout), JSON.stringify(c))
}

export function deleteCalibration(layout: string): void {
  storage()?.removeItem(calibrationKey(layout))
}

export function loadCalibration(layout: string): CameraCalibration | null {
  const raw = storage()?.getItem(calibrationKey(layout))
  if (!raw) return null
  try {
    const c = parseCalibration(JSON.parse(raw))
    return c && c.layout === layout ? c : null
  } catch {
    return null
  }
}

export function exportCalibration(c: CameraCalibration): string {
  return JSON.stringify(c, null, 2)
}

export type Solved = { ok: true; h: Mat3; error: ReprojectionError } | { ok: false; code: 'too_few' | 'degenerate' }

/** Homography from frame fractions to layout display space (x * aspect, y). */
export function solveCalibration(pairs: readonly CalibrationPair[], aspect: number): Solved {
  if (pairs.length < 4) return { ok: false, code: 'too_few' }
  const img = pairs.map((p) => p.image)
  const lay = pairs.map((p) => [p.layout[0] * aspect, p.layout[1]] as Pt)
  try {
    const h = computeHomography(img, lay)
    return { ok: true, h, error: reprojectionError(h, img, lay) }
  } catch (e) {
    if (e instanceof HomographyError) return { ok: false, code: e.code === 'too_few' ? 'too_few' : 'degenerate' }
    throw e
  }
}

/** Car colour signatures by controller address (0..5). */
export type Signatures = Record<number, number[]>

const isSignature = (v: unknown): v is number[] =>
  Array.isArray(v) && v.length === BINS && v.every((x) => typeof x === 'number' && Number.isFinite(x) && x >= 0)

export function loadSignatures(): Signatures {
  const raw = storage()?.getItem(SIGNATURES_KEY)
  if (!raw) return {}
  try {
    const d = JSON.parse(raw) as unknown
    if (!d || typeof d !== 'object') return {}
    const out: Signatures = {}
    for (const [k, v] of Object.entries(d)) {
      const a = Number(k)
      if (Number.isInteger(a) && a >= 0 && a <= 5 && isSignature(v)) out[a] = v
    }
    return out
  } catch {
    return {}
  }
}

export function saveSignatures(s: Signatures): void {
  storage()?.setItem(SIGNATURES_KEY, JSON.stringify(s))
}
