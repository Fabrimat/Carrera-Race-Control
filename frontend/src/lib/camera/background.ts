// Running-average background model for motion detection. A pixel is foreground when any
// RGB channel differs from the background by more than `threshold` (so a car with the
// same brightness as the track still shows). The model follows slow lighting changes;
// foreground pixels are learned 4x slower so a passing car barely leaves a trace.

import type { Frame } from './frame'

export interface BackgroundModel {
  width: number
  height: number
  /** RGB per pixel; null until the first frame. */
  mean: Float32Array | null
}

export interface ForegroundOptions {
  threshold?: number
  alpha?: number
}

export function createBackground(width: number, height: number): BackgroundModel {
  return { width, height, mean: null }
}

/**
 * Compares `frame` with the model, writes 1 (moving) / 0 into `mask` (length w*h), updates
 * the model and returns the number of foreground pixels. The first frame (or a frame of
 * another size) initialises the model and reports no motion.
 */
export function updateForeground(
  bg: BackgroundModel,
  frame: Frame,
  mask: Uint8Array,
  { threshold = 28, alpha = 0.05 }: ForegroundOptions = {},
): number {
  const { width, height, data } = frame
  const n = width * height
  if (!bg.mean || bg.width !== width || bg.height !== height) {
    bg.width = width
    bg.height = height
    bg.mean = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) {
      bg.mean[i * 3] = data[i * 4]
      bg.mean[i * 3 + 1] = data[i * 4 + 1]
      bg.mean[i * 3 + 2] = data[i * 4 + 2]
    }
    mask.fill(0, 0, n)
    return 0
  }
  const m = bg.mean
  const slow = alpha / 4
  let count = 0
  for (let i = 0, j = 0, k = 0; i < n; i++, j += 4, k += 3) {
    const r = data[j]
    const g = data[j + 1]
    const b = data[j + 2]
    const dr = r - m[k]
    const dg = g - m[k + 1]
    const db = b - m[k + 2]
    const d = Math.max(dr < 0 ? -dr : dr, dg < 0 ? -dg : dg, db < 0 ? -db : db)
    const fg = d > threshold
    mask[i] = fg ? 1 : 0
    if (fg) count++
    const a = fg ? slow : alpha
    m[k] += a * dr
    m[k + 1] += a * dg
    m[k + 2] += a * db
  }
  return count
}
