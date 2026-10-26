// Connected components (8-connected) of a label image (0 = nothing, 1..255 = car label).
// The extractor keeps its work buffers between frames: no per-pixel allocation.

export interface Blob {
  label: number
  area: number
  /** Centroid in pixels. */
  cx: number
  cy: number
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export class BlobExtractor {
  private seen = new Uint8Array(0)
  private stack = new Int32Array(0)

  /** Regions of at least `minArea` pixels, in scan order. */
  extract(labels: Uint8Array, width: number, height: number, minArea: number): Blob[] {
    const n = width * height
    if (this.seen.length < n) {
      this.seen = new Uint8Array(n)
      this.stack = new Int32Array(n)
    } else this.seen.fill(0, 0, n)
    const seen = this.seen
    const stack = this.stack
    const out: Blob[] = []
    for (let start = 0; start < n; start++) {
      const label = labels[start]
      if (label === 0 || seen[start]) continue
      let top = 0
      stack[top++] = start
      seen[start] = 1
      let area = 0
      let sx = 0
      let sy = 0
      let minX = width
      let minY = height
      let maxX = 0
      let maxY = 0
      while (top > 0) {
        const p = stack[--top]
        const x = p % width
        const y = (p - x) / width
        area++
        sx += x
        sy += y
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy
          if (yy < 0 || yy >= height) continue
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx
            if ((dx === 0 && dy === 0) || xx < 0 || xx >= width) continue
            const q = yy * width + xx
            if (seen[q] || labels[q] !== label) continue
            seen[q] = 1
            stack[top++] = q
          }
        }
      }
      if (area >= minArea) out.push({ label, area, cx: sx / area, cy: sy / area, minX, minY, maxX, maxY })
    }
    return out
  }
}

/** The biggest blob of each label. */
export function largestPerLabel(blobs: Blob[]): Map<number, Blob> {
  const best = new Map<number, Blob>()
  for (const b of blobs) {
    const cur = best.get(b.label)
    if (!cur || b.area > cur.area) best.set(b.label, b)
  }
  return best
}
