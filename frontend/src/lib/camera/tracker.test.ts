import { describe, expect, it } from 'vitest'
import { pointAt, shortestDelta, smooth, type Pt } from '../geometry'
import { createFrame } from './frame'
import { applyHomography, computeHomography } from './homography'
import { sampleSignature } from './signature'
import { createSimScene, renderSimFrame, type SimCar } from './simCamera'
import { Tracker } from './tracker'
import { fillDisc, solidFrame } from './testImages'

// A rounded, slightly irregular circuit (normalised 0..1), aspect 1.6.
const LAYOUT = {
  points: smooth(
    [
      [0.05, 0.1],
      [0.7, 0.05],
      [0.95, 0.3],
      [0.8, 0.55],
      [0.95, 0.9],
      [0.3, 0.95],
      [0.05, 0.6],
    ] as Pt[],
    3,
  ),
  aspect: 1.6,
}
const RED = '#e53935'
const BLUE = '#1e88e5'

/** What a user does in the wizard: click path points in the image, ±1 px of click error. */
function calibrate(scene: ReturnType<typeof createSimScene>) {
  const ss = [0, 0.12, 0.27, 0.41, 0.55, 0.7, 0.84]
  const layoutPts = ss.map((s) => pointAt(scene.path.points, s, scene.path.cum))
  const imagePts = layoutPts.map((q, i) => {
    const [x, y] = applyHomography(scene.toImage, q)!
    const jitter = (i % 2 ? 1 : -1) / scene.width
    return [x + jitter, y - jitter] as Pt
  })
  return computeHomography(imagePts, layoutPts)
}

function signatureAt(scene: ReturnType<typeof createSimScene>, cars: SimCar[], k: number) {
  const f = createFrame(scene.width, scene.height)
  renderSimFrame(scene, cars, f)
  const [x, y] = applyHomography(scene.toImage, pointAt(scene.path.points, cars[k].s, scene.path.cum))!
  return sampleSignature(f, x * scene.width, y * scene.height, 6)!
}

describe('Tracker on the simulated camera', () => {
  it('recovers the s of every car within a tolerance', () => {
    const scene = createSimScene(LAYOUT)
    const start: SimCar[] = [
      { address: 0, color: RED, s: 0.05 },
      { address: 3, color: BLUE, s: 0.55 },
    ]
    const tracker = new Tracker()
    tracker.setCars([
      { address: 0, signature: signatureAt(scene, start, 0) },
      { address: 3, signature: signatureAt(scene, start, 1) },
    ])
    tracker.setCalibration(calibrate(scene), scene.path)
    const frame = createFrame(scene.width, scene.height)
    const errors: number[] = []
    let accepted = 0
    const FRAMES = 60
    for (let i = 0; i < FRAMES; i++) {
      // ~ 6.7 s and 9 s laps at 15 fps; the blue car is slower.
      const cars = start.map((c, k) => ({ ...c, s: (c.s + i * (k ? 0.0075 : 0.01)) % 1 }))
      renderSimFrame(scene, cars, frame)
      const dets = tracker.process(frame, i * 66.7)
      for (const d of dets) {
        if (!d.accepted) continue
        accepted++
        const truth = cars.find((c) => c.address === d.address)!.s
        errors.push(Math.abs(shortestDelta(truth, d.s!)))
        expect(d.offPath).toBe(false)
      }
    }
    expect(accepted).toBeGreaterThan((FRAMES - 2) * 2 * 0.9)
    expect(Math.max(...errors)).toBeLessThan(0.012)
    expect(tracker.stats(0)!.rate).toBeGreaterThan(0.9)
    expect(tracker.stats(3)!.lastSeen).toBeCloseTo((FRAMES - 1) * 66.7)
  })

  it('flags a deslotted car as off the path', () => {
    const scene = createSimScene(LAYOUT)
    const car: SimCar = { address: 1, color: RED, s: 0.3 }
    const tracker = new Tracker()
    tracker.setCars([{ address: 1, signature: signatureAt(scene, [car], 0) }])
    tracker.setCalibration(calibrate(scene), scene.path)
    const frame = createFrame(scene.width, scene.height)
    let last = null
    for (let i = 0; i < 10; i++) {
      renderSimFrame(scene, [{ ...car, s: 0.3 + i * 0.01, offTrack: i >= 5 }], frame)
      last = tracker.process(frame, i * 66.7).find((d) => d.address === 1)
    }
    expect(last?.accepted).toBe(true)
    expect(last?.offPath).toBe(true)
    expect(tracker.stats(1)!.offPath).toBe(true)
  })

  it('reports blobs without a calibration but gives no s', () => {
    const tracker = new Tracker()
    const sigFrame = solidFrame(60, 40, [60, 60, 60])
    fillDisc(sigFrame, 30, 20, 4, [229, 57, 53])
    tracker.setCars([{ address: 2, signature: sampleSignature(sigFrame, 30, 20, 6)! }])
    tracker.process(solidFrame(60, 40, [60, 60, 60]), 0)
    const f = solidFrame(60, 40, [60, 60, 60])
    fillDisc(f, 10, 10, 4, [229, 57, 53])
    const [d] = tracker.process(f, 66)
    expect(d).toMatchObject({ address: 2, s: null, accepted: false, reason: 'uncalibrated' })
    expect(d.center[0]).toBeCloseTo(10.5 / 60, 1)
  })

  it('ignores a coloured object that does not move', () => {
    const tracker = new Tracker()
    const f = solidFrame(60, 40, [60, 60, 60])
    fillDisc(f, 30, 20, 4, [229, 57, 53])
    tracker.setCars([{ address: 0, signature: sampleSignature(f, 30, 20, 6)! }])
    tracker.process(f, 0)
    expect(tracker.process(f, 66)).toEqual([])
  })
})
