import { beforeEach, describe, expect, it } from 'vitest'
import type { Pt } from '../geometry'
import { applyHomography } from './homography'
import {
  calibrationKey,
  exportCalibration,
  loadCalibration,
  loadSignatures,
  parseCalibration,
  saveCalibration,
  saveSignatures,
  solveCalibration,
  type CameraCalibration,
} from './calibration'
import { BINS } from './signature'

const pairs = (): CameraCalibration['pairs'] => [
  { image: [0.2, 0.2], layout: [0, 0] },
  { image: [0.8, 0.25], layout: [1, 0] },
  { image: [0.9, 0.9], layout: [1, 1] },
  { image: [0.1, 0.85], layout: [0, 1] },
  { image: [0.5, 0.55], layout: [0.5, 0.5] },
]
const calib = (over: Partial<CameraCalibration> = {}): CameraCalibration => ({
  version: 1,
  layout: 'Kitchen',
  pairs: pairs(),
  saved_at: '2026-10-26T10:00:00Z',
  ...over,
})

describe('calibration storage', () => {
  beforeEach(() => localStorage.clear())

  it('saves and loads per layout under carrera.camera.<layout>', () => {
    saveCalibration(calib())
    expect(calibrationKey('Kitchen')).toBe('carrera.camera.Kitchen')
    expect(localStorage.getItem('carrera.camera.Kitchen')).toContain('"pairs"')
    expect(loadCalibration('Kitchen')).toEqual(calib())
    expect(loadCalibration('Other')).toBeNull()
  })

  it('ignores corrupt stored data', () => {
    localStorage.setItem('carrera.camera.Kitchen', '{not json')
    expect(loadCalibration('Kitchen')).toBeNull()
  })

  it('exports JSON that imports back', () => {
    const json = exportCalibration(calib())
    expect(parseCalibration(JSON.parse(json))).toEqual(calib())
  })

  it('validates imported data', () => {
    expect(parseCalibration(null)).toBeNull()
    expect(parseCalibration({ ...calib(), version: 2 })).toBeNull()
    expect(parseCalibration({ ...calib(), layout: '' })).toBeNull()
    expect(parseCalibration({ ...calib(), pairs: 'x' })).toBeNull()
    expect(parseCalibration({ ...calib(), pairs: [{ image: [0, 'a'], layout: [0, 0] }] })).toBeNull()
    expect(parseCalibration({ ...calib(), pairs: [{ image: [0, 9], layout: [0, 0] }] })).toBeNull()
    expect(parseCalibration({ ...calib(), pairs: Array(101).fill(pairs()[0]) })).toBeNull()
    // Unknown extra fields are dropped.
    expect(parseCalibration({ ...calib(), extra: 1 })).toEqual(calib())
  })

  it('stores signatures with validation', () => {
    const sig = Array.from({ length: BINS }, (_, i) => (i === 3 ? 1 : 0))
    saveSignatures({ 2: sig })
    expect(loadSignatures()).toEqual({ 2: sig })
    localStorage.setItem('carrera.camera-signatures', JSON.stringify({ 9: sig, 1: [1, 2], 0: sig }))
    expect(loadSignatures()).toEqual({ 0: sig })
  })
})

describe('solveCalibration', () => {
  it('maps image points to layout display space (x * aspect)', () => {
    const r = solveCalibration(calib().pairs, 2)
    if (!r.ok) throw new Error(r.code)
    const p = applyHomography(r.h, [0.8, 0.25]) as Pt
    expect(p[0]).toBeCloseTo(2, 1)
    expect(p[1]).toBeCloseTo(0, 1)
    expect(r.error.rms).toBeLessThan(0.1)
  })

  it('needs 4 pairs and rejects degenerate ones', () => {
    expect(solveCalibration(calib().pairs.slice(0, 3), 1)).toEqual({ ok: false, code: 'too_few' })
    const line = [0, 1, 2, 3].map((i) => ({ image: [i / 4, i / 4] as Pt, layout: [i / 4, 0.5] as Pt }))
    expect(solveCalibration(line, 1)).toEqual({ ok: false, code: 'degenerate' })
  })
})
