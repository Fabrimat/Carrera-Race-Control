import { describe, expect, it } from 'vitest'
import { createBackground, updateForeground } from './background'
import { fillDisc, solidFrame } from './testImages'

const count = (m: Uint8Array) => m.reduce((a, b) => a + b, 0)

describe('background model', () => {
  it('learns the first frame and reports no motion on a static scene', () => {
    const bg = createBackground(30, 20)
    const mask = new Uint8Array(600)
    const f = solidFrame(30, 20, [60, 60, 60])
    expect(updateForeground(bg, f, mask)).toBe(0)
    expect(updateForeground(bg, f, mask)).toBe(0)
    expect(count(mask)).toBe(0)
  })

  it('marks a new object as foreground, even when it has the same brightness', () => {
    const bg = createBackground(30, 20)
    const mask = new Uint8Array(600)
    updateForeground(bg, solidFrame(30, 20, [100, 100, 100]), mask)
    const f = solidFrame(30, 20, [100, 100, 100])
    fillDisc(f, 15, 10, 3, [160, 80, 70]) // roughly the same luma, different colour
    const n = updateForeground(bg, f, mask)
    expect(n).toBeGreaterThan(20)
    expect(n).toBeLessThan(40)
    expect(mask[10 * 30 + 15]).toBe(1)
    expect(mask[0]).toBe(0)
  })

  it('ignores small noise below the threshold', () => {
    const bg = createBackground(30, 20)
    const mask = new Uint8Array(600)
    updateForeground(bg, solidFrame(30, 20, [100, 100, 100]), mask)
    expect(updateForeground(bg, solidFrame(30, 20, [110, 92, 108]), mask, { threshold: 24 })).toBe(0)
  })

  it('slowly absorbs an object that stops moving', () => {
    const bg = createBackground(30, 20)
    const mask = new Uint8Array(600)
    updateForeground(bg, solidFrame(30, 20, [60, 60, 60]), mask)
    const f = solidFrame(30, 20, [60, 60, 60])
    fillDisc(f, 15, 10, 3, [220, 40, 40])
    let n = updateForeground(bg, f, mask, { alpha: 0.2 })
    expect(n).toBeGreaterThan(0)
    for (let i = 0; i < 200; i++) n = updateForeground(bg, f, mask, { alpha: 0.2 })
    expect(n).toBe(0)
  })

  it('restarts when the frame size changes', () => {
    const bg = createBackground(30, 20)
    const mask = new Uint8Array(40 * 10)
    expect(updateForeground(bg, solidFrame(40, 10, [9, 9, 9]), mask)).toBe(0)
    expect(bg.width).toBe(40)
  })
})
