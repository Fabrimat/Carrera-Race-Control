import { describe, expect, it } from 'vitest'
import { BlobExtractor, largestPerLabel } from './blobs'

function grid(w: number, h: number) {
  const labels = new Uint8Array(w * h)
  const set = (x: number, y: number, l: number) => (labels[y * w + x] = l)
  const rect = (x0: number, y0: number, rw: number, rh: number, l: number) => {
    for (let y = y0; y < y0 + rh; y++) for (let x = x0; x < x0 + rw; x++) set(x, y, l)
  }
  return { labels, set, rect }
}

describe('blob extraction', () => {
  it('finds connected regions per label with area, centroid and box', () => {
    const g = grid(40, 30)
    g.rect(2, 3, 4, 4, 1) // 16 px, centre (3.5, 4.5)
    g.rect(20, 10, 6, 5, 1) // 30 px
    g.rect(30, 20, 3, 3, 2) // 9 px
    g.set(10, 25, 2) // noise
    const blobs = new BlobExtractor().extract(g.labels, 40, 30, 4)
    expect(blobs).toHaveLength(3)
    const a = blobs.find((b) => b.minX === 2)!
    expect(a).toMatchObject({ label: 1, area: 16, minX: 2, minY: 3, maxX: 5, maxY: 6 })
    expect(a.cx).toBeCloseTo(3.5)
    expect(a.cy).toBeCloseTo(4.5)
    const best = largestPerLabel(blobs)
    expect(best.get(1)?.area).toBe(30)
    expect(best.get(2)?.area).toBe(9)
  })

  it('joins diagonal neighbours (8-connectivity) and keeps different labels apart', () => {
    const g = grid(10, 10)
    for (let i = 0; i < 5; i++) g.set(i, i, 1)
    g.rect(5, 0, 2, 2, 2)
    g.rect(7, 0, 2, 2, 1) // touches label 2 but is another car
    const blobs = new BlobExtractor().extract(g.labels, 10, 10, 1)
    expect(blobs.filter((b) => b.label === 1).map((b) => b.area).sort()).toEqual([4, 5])
    expect(blobs.filter((b) => b.label === 2)).toHaveLength(1)
  })

  it('handles a region touching every border and an empty image', () => {
    const g = grid(8, 6)
    g.rect(0, 0, 8, 6, 3)
    const ex = new BlobExtractor()
    expect(ex.extract(g.labels, 8, 6, 1)).toEqual([
      { label: 3, area: 48, cx: 3.5, cy: 2.5, minX: 0, minY: 0, maxX: 7, maxY: 5 },
    ])
    expect(ex.extract(new Uint8Array(48), 8, 6, 1)).toEqual([])
  })
})
