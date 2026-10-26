import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { estimateS, pointAt, shortestDelta, type Pt } from '../geometry'
import { useStore } from '../store'
import type { TrackLayout, TrackPosition } from '../types'
import { car, raceState } from '../../test/fixtures'
import { solveCalibration } from './calibration'
import { CameraEngine } from './engine'
import { applyHomography } from './homography'
import { createSimScene } from './simCamera'

const layout: TrackLayout = {
  name: 'Oval',
  points: Array.from({ length: 48 }, (_, i) => {
    const a = (i / 48) * Math.PI * 2
    return [0.5 + 0.45 * Math.cos(a), 0.5 + 0.4 * Math.sin(a)] as Pt
  }),
  aspect: 1.5,
  sensors: [],
  pit_s: null,
  source: 'drawn',
  updated_at: '2026-01-01T00:00:00Z',
}

// Cars lapping in ~8 s and ~10 s: one stretch per lap, anchored at race time 0.
const tp = (expected: number, s: number): TrackPosition => ({
  from_sensor: 1,
  to_sensor: 1,
  s_from: s,
  s_to: s,
  anchor_race_ms: 0,
  expected_ms: expected,
  in_pit: false,
  confidence: 'estimated',
})

/** The user's clicks: path points in the (simulated) image, in normalised layout coords. */
function pairsFor() {
  const scene = createSimScene(layout)
  return [0, 0.15, 0.3, 0.45, 0.6, 0.8].map((s) => {
    const q = pointAt(scene.path.points, s, scene.path.cum)
    return { image: applyHomography(scene.toImage, q)!, layout: [q[0] / layout.aspect, q[1]] as Pt }
  })
}

describe('CameraEngine with the simulated camera', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    localStorage.clear()
    useStore.setState({
      camera: {},
      race: raceState({
        layout: 'Oval',
        phase: 'running',
        race_time_ms: 0,
        cars: [
          car({ address: 0, color: '#e53935', track_pos: tp(8000, 0.1) }),
          car({ address: 4, color: '#1e88e5', track_pos: tp(10000, 0.55) }),
        ],
      }),
    })
  })
  afterEach(() => vi.useRealTimers())

  it('tracks the live race into the camera store slice', async () => {
    const engine = new CameraEngine()
    engine.setLayout(layout)
    const solved = solveCalibration(pairsFor(), layout.aspect)
    if (!solved.ok) throw new Error(solved.code)
    engine.setCalibration(solved.h)
    await engine.start('sim')
    const t0 = performance.now()
    engine.tick(t0)
    // Signatures: click on each car in the frame.
    const scene = createSimScene(layout)
    const race = useStore.getState().race
    for (const c of race.cars) {
      const s = estimateS(c.track_pos!, 0, null)
      const [x, y] = applyHomography(scene.toImage, pointAt(scene.path.points, s, scene.path.cum))!
      expect(engine.captureSignature(c.address, x, y)).toBe(true)
    }
    expect(Object.keys(engine.getSnapshot().signatures)).toEqual(['0', '4'])
    for (let i = 1; i <= 30; i++) engine.tick(t0 + i * 66.7)
    const now = t0 + 30 * 66.7
    const cam = useStore.getState().camera
    for (const c of race.cars) {
      const truth = estimateS(c.track_pos!, now - t0, null)
      expect(cam[c.address]).toBeDefined()
      expect(cam[c.address].seen_at).toBe(now)
      expect(Math.abs(shortestDelta(truth, cam[c.address].s))).toBeLessThan(0.015)
    }
    const snap = engine.getSnapshot()
    expect(snap.running).toBe(true)
    expect(snap.fps).toBeGreaterThan(10)
    expect(snap.stats[0].rate).toBeGreaterThan(0.8)
    engine.stop()
    expect(useStore.getState().camera).toEqual({})
    expect(engine.getSnapshot().running).toBe(false)
  })

  it('publishes nothing without a calibration or for another layout', async () => {
    const engine = new CameraEngine()
    engine.setLayout({ ...layout, name: 'Other' })
    await engine.start('sim')
    for (let i = 0; i < 5; i++) engine.tick(1000 + i * 66)
    expect(useStore.getState().camera).toEqual({})
    engine.stop()
  })

  it('reports a missing webcam API', async () => {
    const engine = new CameraEngine()
    vi.stubGlobal('navigator', { mediaDevices: undefined })
    await engine.start('webcam')
    expect(engine.getSnapshot()).toMatchObject({ running: false, error: 'unsupported' })
    vi.unstubAllGlobals()
  })

  it('reports a denied permission', async () => {
    const engine = new CameraEngine()
    const err = Object.assign(new Error('no'), { name: 'NotAllowedError' })
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn().mockRejectedValue(err) } })
    await engine.start('webcam')
    expect(engine.getSnapshot()).toMatchObject({ running: false, error: 'denied' })
    vi.unstubAllGlobals()
  })

  it('remembers the background choice', () => {
    const engine = new CameraEngine()
    engine.setBackground(true)
    expect(new CameraEngine().getSnapshot().background).toBe(true)
  })
})
