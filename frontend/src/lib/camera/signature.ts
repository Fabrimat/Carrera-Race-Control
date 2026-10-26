// Colour signatures of the cars: a hue/saturation histogram (brightness is left out, so a
// car looks the same in the bright and the dim part of the room). Grey and dark pixels
// carry no reliable hue and are ignored.

import type { Frame } from './frame'

export const HUE_BINS = 16
export const SAT_BINS = 3
export const BINS = HUE_BINS * SAT_BINS
/** Bin of a pixel without a usable colour (grey, white, black, dark). */
export const NO_BIN = 255

const MIN_SAT = 0.25
const MIN_VAL = 0.15
const HUE_STEP = 360 / HUE_BINS

/** h in 0..360, s and v in 0..1. */
export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  const v = max / 255
  const s = max === 0 ? 0 : d / max
  if (d === 0) return [0, s, v]
  let h: number
  if (max === r) h = ((g - b) / d) % 6
  else if (max === g) h = (b - r) / d + 2
  else h = (r - g) / d + 4
  h *= 60
  if (h < 0) h += 360
  return [h, s, v]
}

/** Histogram bin of a colour; hue bins are centred so pure red is not split at 0/360. */
export function binOf(r: number, g: number, b: number): number {
  const [h, s, v] = rgbToHsv(r, g, b)
  if (s < MIN_SAT || v < MIN_VAL) return NO_BIN
  const hb = Math.floor(((h + HUE_STEP / 2) % 360) / HUE_STEP) % HUE_BINS
  const sb = Math.min(SAT_BINS - 1, Math.floor(((s - MIN_SAT) / (1 - MIN_SAT)) * SAT_BINS))
  return sb * HUE_BINS + hb
}

/** Index into the 32x32x32 RGB cube used by the per-pixel lookup tables. */
export function lutIndex(r: number, g: number, b: number): number {
  return ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)
}

let binCube: Uint8Array | null = null

/** RGB cube (5 bits per channel) → bin, built once: per-pixel binning is one lookup. */
export function binLut(): Uint8Array {
  if (binCube) return binCube
  const cube = new Uint8Array(32768)
  for (let r = 0; r < 32; r++)
    for (let g = 0; g < 32; g++)
      for (let b = 0; b < 32; b++) cube[(r << 10) | (g << 5) | b] = binOf(r * 8 + 4, g * 8 + 4, b * 8 + 4)
  binCube = cube
  return cube
}

/**
 * Signature of the colours in a disc around (cx, cy) (pixels): pixels near the centre weigh
 * more, faint bins (< 5 % of the strongest, i.e. background bleeding in) are dropped, and
 * the result sums to 1. Null if the disc has (almost) no coloured pixel.
 */
export function sampleSignature(frame: Frame, cx: number, cy: number, radius: number): number[] | null {
  const cube = binLut()
  const hist = new Array<number>(BINS).fill(0)
  const sigma2 = 2 * (radius / 2) ** 2
  let count = 0
  const { width, height, data } = frame
  for (let y = Math.max(0, Math.floor(cy - radius)); y <= Math.min(height - 1, Math.ceil(cy + radius)); y++) {
    for (let x = Math.max(0, Math.floor(cx - radius)); x <= Math.min(width - 1, Math.ceil(cx + radius)); x++) {
      const d2 = (x - cx) ** 2 + (y - cy) ** 2
      if (d2 > radius * radius) continue
      const i = (y * width + x) * 4
      const bin = cube[lutIndex(data[i], data[i + 1], data[i + 2])]
      if (bin === NO_BIN) continue
      hist[bin] += Math.exp(-d2 / sigma2)
      count++
    }
  }
  if (count < 4) return null
  const peak = Math.max(...hist)
  for (let i = 0; i < BINS; i++) if (hist[i] < peak * 0.05) hist[i] = 0
  const total = hist.reduce((a, b) => a + b, 0)
  return hist.map((x) => x / total)
}

/** Bhattacharyya coefficient of two normalised histograms: 1 identical, 0 disjoint. */
export function similarity(a: readonly number[], b: readonly number[]): number {
  let s = 0
  for (let i = 0; i < Math.min(a.length, b.length); i++) s += Math.sqrt(Math.max(0, a[i]) * Math.max(0, b[i]))
  return Math.min(1, s)
}

/** Neighbour-smoothed match score of a bin for a signature, relative to its peak (0..1). */
function scores(sig: readonly number[]): Float32Array {
  const peak = Math.max(...sig, 1e-9)
  const out = new Float32Array(BINS)
  for (let sb = 0; sb < SAT_BINS; sb++) {
    for (let hb = 0; hb < HUE_BINS; hb++) {
      const at = (h: number, s: number) =>
        s < 0 || s >= SAT_BINS ? 0 : sig[s * HUE_BINS + ((h + HUE_BINS) % HUE_BINS)]
      // Neighbouring bins count half: noise easily moves a pixel across a bin edge.
      const v = Math.max(at(hb, sb), 0.5 * Math.max(at(hb - 1, sb), at(hb + 1, sb), at(hb, sb - 1), at(hb, sb + 1)))
      out[sb * HUE_BINS + hb] = v / peak
    }
  }
  return out
}

/**
 * RGB cube → label (1 + index of the best matching signature, 0 = no car). A pixel belongs
 * to a car when its bin scores at least `minScore` of that car's strongest bin.
 */
export function buildLabelLut(signatures: readonly (readonly number[])[], minScore = 0.25): Uint8Array {
  const cube = binLut()
  const perSig = signatures.map(scores)
  const binLabel = new Uint8Array(BINS)
  for (let b = 0; b < BINS; b++) {
    let best = 0
    let bestScore = minScore
    perSig.forEach((s, k) => {
      if (s[b] >= bestScore) {
        bestScore = s[b]
        best = k + 1
      }
    })
    binLabel[b] = best
  }
  const lut = new Uint8Array(32768)
  for (let i = 0; i < 32768; i++) lut[i] = cube[i] === NO_BIN ? 0 : binLabel[cube[i]]
  return lut
}

/** A representative RGB colour of a signature (centre of its strongest bin), for swatches. */
export function dominantColor(sig: readonly number[]): [number, number, number] {
  let k = 0
  for (let i = 1; i < sig.length; i++) if (sig[i] > sig[k]) k = i
  const h = (k % HUE_BINS) * HUE_STEP
  const s = MIN_SAT + ((Math.floor(k / HUE_BINS) + 0.5) / SAT_BINS) * (1 - MIN_SAT)
  const v = 0.9
  const f = (n: number) => {
    const kk = (n + h / 60) % 6
    return Math.round(255 * (v - v * s * Math.max(0, Math.min(kk, 4 - kk, 1))))
  }
  return [f(5), f(3), f(1)]
}
