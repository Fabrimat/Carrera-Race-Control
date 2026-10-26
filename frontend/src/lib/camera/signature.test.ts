import { describe, expect, it } from 'vitest'
import { BINS, NO_BIN, binOf, buildLabelLut, dominantColor, lutIndex, rgbToHsv, sampleSignature, similarity } from './signature'
import { fillDisc, solidFrame } from './testImages'

const GREY: [number, number, number] = [60, 62, 64]
const RED: [number, number, number] = [229, 57, 53]
const BLUE: [number, number, number] = [30, 136, 229]
const dim = (c: [number, number, number], k: number) => c.map((x) => Math.round(x * k)) as [number, number, number]

function discSig(rgb: [number, number, number]) {
  const f = solidFrame(40, 40, GREY)
  fillDisc(f, 20, 20, 6, rgb)
  return sampleSignature(f, 20, 20, 9)
}

describe('rgbToHsv / binOf', () => {
  it('converts known colours', () => {
    expect(rgbToHsv(255, 0, 0)).toEqual([0, 1, 1])
    const [h, s, v] = rgbToHsv(0, 128, 255)
    expect(h).toBeCloseTo(210, 0)
    expect(s).toBe(1)
    expect(v).toBe(1)
    expect(rgbToHsv(100, 100, 100)).toEqual([0, 0, 100 / 255])
  })

  it('ignores grey and dark pixels, keeps brightness out of the bin', () => {
    expect(binOf(...GREY)).toBe(NO_BIN)
    expect(binOf(10, 3, 3)).toBe(NO_BIN)
    expect(binOf(...RED)).not.toBe(NO_BIN)
    expect(binOf(...dim(RED, 0.6))).toBe(binOf(...RED))
    expect(binOf(...BLUE)).not.toBe(binOf(...RED))
  })
})

describe('signatures', () => {
  it('samples a normalised histogram dominated by the car colour', () => {
    const sig = discSig(RED)!
    expect(sig).toHaveLength(BINS)
    expect(sig.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6)
    expect(sig[binOf(...RED)]).toBeGreaterThan(0.8)
    const [r, g, b] = dominantColor(sig)
    expect(r).toBeGreaterThan(g)
    expect(r).toBeGreaterThan(b)
  })

  it('returns null when there is no colour to sample', () => {
    expect(sampleSignature(solidFrame(20, 20, GREY), 10, 10, 5)).toBeNull()
  })

  it('matches the same car under different lighting and tells cars apart', () => {
    const red = discSig(RED)!
    const redDim = discSig(dim(RED, 0.55))!
    const blue = discSig(BLUE)!
    expect(similarity(red, red)).toBeCloseTo(1, 6)
    expect(similarity(red, redDim)).toBeGreaterThan(0.9)
    expect(similarity(red, blue)).toBeLessThan(0.1)
  })

  it('builds a colour lookup table that labels pixels per car', () => {
    const lut = buildLabelLut([discSig(RED)!, discSig(BLUE)!])
    expect(lut[lutIndex(...RED)]).toBe(1)
    expect(lut[lutIndex(...dim(RED, 0.6))]).toBe(1)
    expect(lut[lutIndex(...BLUE)]).toBe(2)
    expect(lut[lutIndex(...GREY)]).toBe(0)
    expect(lut[lutIndex(40, 200, 40)]).toBe(0) // green: no car
  })
})
